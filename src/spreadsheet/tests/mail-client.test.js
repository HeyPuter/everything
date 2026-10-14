import { describe, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { Doc } from '../src/lib/doc.js';
import { workbookToXlsx } from '../src/core/io.js';
import { recordStep } from '../src/core/change-history.js';
import {
  parseRecipients, recipientProblem, normalizeEmail, buildAttachment, blobToBase64, createMailer, describeResult, failureMessage,
  attachmentProblem, MAX_ATTACHMENT_BYTES, EMAIL_WORKER_URL,
} from '../src/lib/mail.js';
import { loadEmailWorker } from './helpers/email-worker-harness.js';

describe('recipient addresses', () => {
  it('reads addresses separated by commas, semicolons, spaces and lines, with or without names', () => {
    const { people, invalid, duplicates } = parseRecipients('ana@example.com; "Diaz, Ben" <BEN@example.com>\nKim Lee <kim@example.org>, ana@example.com  zed@x.io');
    expect(people).toEqual([
      { email: 'ana@example.com', name: '' },
      { email: 'ben@example.com', name: 'Diaz, Ben' },
      { email: 'kim@example.org', name: 'Kim Lee' },
      { email: 'zed@x.io', name: '' },
    ]);
    expect(invalid).toEqual([]);
    expect(duplicates).toBe(1);
  });

  it('says which entries are not addresses, and when there are too many or none', () => {
    expect(recipientProblem(parseRecipients('ana@example, bob'))).toBe('These are not email addresses: "ana@example", "bob"');
    expect(recipientProblem(parseRecipients('a@b'))).toBe('"a@b" is not an email address');
    expect(recipientProblem(parseRecipients(''))).toBe('Enter at least one email address');
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@example.com`).join(',');
    expect(recipientProblem(parseRecipients(many))).toBe('You can send to at most 20 people at a time');
    expect(recipientProblem(parseRecipients('ana@example.com'))).toBeNull();
  });

  it('normalizes one address', () => {
    expect(normalizeEmail('  Ana@Example.COM ')).toBe('ana@example.com');
    expect(normalizeEmail('ana@@example.com')).toBe('');
    expect(normalizeEmail('ana@example.com\r\nBcc: x@y.z')).toBe('');
  });
});

function docWithHistory() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Revenue');
  wb.setInput(id, 0, 1, '100');
  const doc = new Doc({ wb, name: 'Q3 plan' });
  // An edit recorded for Show Changes: a sent copy must not carry it.
  wb.setInput(id, 0, 1, '120');
  recordStep(wb, 'cells', 'Typing');
  return { doc, wb, id };
}

describe('the attachment', () => {
  it('is the workbook as .xlsx without the record of changes', async () => {
    const { doc } = docWithHistory();
    const att = await buildAttachment(doc, { format: 'xlsx' });
    expect(att.filename).toBe('Q3 plan.xlsx');
    const everything = async (blob) => {
      const zip = X.CFB.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
      return zip.FileIndex.map((f) => (f.content ? new TextDecoder().decode(f.content) : '')).join('\n');
    };
    // The file the app saves for itself keeps the record; the copy sent does not.
    expect(await everything(await workbookToXlsx(doc.wb))).toContain('changeHistory');
    const sent = await everything(att.blob);
    expect(sent).toContain('Revenue');
    expect(sent).not.toContain('changeHistory');
  });

  it('is a PDF of the workbook, the sheet or the selection', async () => {
    const { doc, id } = docWithHistory();
    const whole = await buildAttachment(doc, { format: 'pdf', scope: 'workbook' });
    expect(whole.filename).toBe('Q3 plan.pdf');
    const head = new TextDecoder().decode((await whole.blob.arrayBuffer()).slice(0, 5));
    expect(head).toBe('%PDF-');
    const sel = await buildAttachment(doc, { format: 'pdf', scope: 'selection', sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } });
    expect(sel.filename).toBe('Q3 plan (selection).pdf');
    const text = new TextDecoder('latin1').decode(await sel.blob.arrayBuffer());
    expect(text).toContain('(Revenue) Tj');
    expect(text).not.toContain('(120) Tj');
  });

  it('is the sheet as .csv', async () => {
    const { doc } = docWithHistory();
    const att = await buildAttachment(doc, { format: 'csv' });
    expect(att.filename).toBe('Q3 plan.csv');
    expect(await att.blob.text()).toContain('Revenue,120');
  });

  it('is refused over the size limit', () => {
    expect(attachmentProblem(MAX_ATTACHMENT_BYTES + 1)).toMatch(/at most 7\.0 MB/);
    expect(attachmentProblem(1000)).toBeNull();
  });

  it('is encoded as base64', async () => {
    expect(await blobToBase64(new Blob(['PK\x03\x04']))).toBe(btoa('PK\x03\x04'));
  });
});

/** A puter whose workers.exec runs the real worker, as the app reaches it. */
function bridged(world) {
  const exec = vi.fn(async (url, init) => {
    const route = url.replace(EMAIL_WORKER_URL, '');
    const { status, data } = await world.call(init.method, route, { json: JSON.parse(init.body) });
    return new Response(JSON.stringify(data), { status });
  });
  return { workers: { exec } };
}

describe('the mailer', () => {
  it('posts a copy to the worker, with no credential in the request', async () => {
    const world = loadEmailWorker();
    const puter = bridged(world);
    const mailer = createMailer({ getPuter: () => puter });
    const { doc } = docWithHistory();
    const attachment = await buildAttachment(doc, { format: 'xlsx' });
    const out = await mailer.sendCopy({ workbookName: doc.name, recipients: [{ email: 'ana@example.com' }], subject: 'Plan', message: 'See attached', attachment });
    expect(out.sent).toBe(1);
    const [url, init] = puter.workers.exec.mock.calls[0];
    expect(url).toBe(`${EMAIL_WORKER_URL}/copies`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(['attachment', 'message', 'recipients', 'subject', 'workbook']);
    expect(body.attachment).toMatchObject({ filename: 'Q3 plan.xlsx' });
    expect(init.body).not.toMatch(/token|password|auth/i);
    expect(world.sent[0].attachments[0].filename).toBe('Q3 plan.xlsx');
  });

  it('posts a link and a mention in the worker’s shape', async () => {
    const world = loadEmailWorker();
    const puter = bridged(world);
    const mailer = createMailer({ getPuter: () => puter });
    await mailer.sendLink({ workbookName: 'B', recipients: ['ana@example.com'], link: 'https://spreadsheet.puter.com/#/file/u1', access: 'edit', message: 'hi' });
    expect(JSON.parse(puter.workers.exec.mock.calls[0][1].body)).toEqual({
      workbook: { name: 'B' }, recipients: [{ email: 'ana@example.com' }], link: 'https://spreadsheet.puter.com/#/file/u1', access: 'edit', message: 'hi',
    });
    await mailer.sendMentions({ workbookName: 'B', recipients: [{ email: 'ana@puter.email', name: 'ana' }], link: 'https://spreadsheet.puter.com/#/file/u1?range=A1',
      comment: { id: '{11111111-2222-3333-4444-555555555555}', text: '@ana hi', cell: 'Sheet1!A1', extra: 'dropped' } });
    expect(JSON.parse(puter.workers.exec.mock.calls[1][1].body).comment).toEqual({ id: '{11111111-2222-3333-4444-555555555555}', text: '@ana hi', cell: 'Sheet1!A1' });
    expect(world.sent.map((m) => m.to)).toEqual(['ana@example.com', 'ana@puter.email']);
  });

  it('turns a refusal into words and says when email is not available', async () => {
    const mailer = createMailer({ getPuter: () => ({ workers: { exec: async () => new Response(JSON.stringify({ error: 'daily_limit' }), { status: 429 }) } }) });
    await expect(mailer.sendLink({ workbookName: 'B', recipients: ['a@example.com'], link: 'https://puter.com/' })).rejects.toThrow("today's email limit");
    expect(createMailer({ getPuter: () => ({}) }).available()).toBe(false);
    await expect(createMailer({ getPuter: () => ({}) }).sendLink({ workbookName: 'B', recipients: ['a@example.com'], link: 'x' })).rejects.toThrow(/not available/);
    expect(failureMessage(401, null)).toMatch(/Sign in/);
  });

  it('describes the outcome', () => {
    expect(describeResult({ sent: 1, results: [{ email: 'ana@example.com', status: 'sent' }] }, { noun: 'copy' }).message).toBe('Copy sent to ana@example.com');
    expect(describeResult({ sent: 3, results: [] }, { noun: 'link' }).message).toBe('Link sent to 3 people');
    expect(describeResult({ sent: 1, failed: 1, results: [] }).variant).toBe('danger');
    expect(describeResult({ sent: 0, results: [{ status: 'skipped', reason: 'daily_limit' }] }).message).toMatch(/limit/);
  });
});
