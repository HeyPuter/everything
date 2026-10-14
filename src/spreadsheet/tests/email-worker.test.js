import { describe, expect, it } from 'vitest';
import { loadEmailWorker } from './helpers/email-worker-harness.js';

const XLSX_B64 = btoa('PK\x03\x04 a zip of a workbook');
const PDF_B64 = btoa('%PDF-1.4\n%%EOF');
const LINK = 'https://spreadsheet.puter.com/#/file/uid-123?range=Sheet1!B4';

const copy = (over = {}) => ({
  workbook: { name: 'Budget' },
  recipients: [{ email: 'ana@example.com' }, { email: 'ben@example.com' }],
  subject: 'Q3 numbers',
  message: 'Here it is.\n<b>Thanks</b>',
  attachment: { filename: 'Budget.xlsx', contentType: 'x', content: XLSX_B64 },
  ...over,
});

describe('email worker: access and health', () => {
  it('answers /health without a session', async () => {
    const w = loadEmailWorker();
    const res = await w.call('GET', '/health', { asUser: null });
    expect(res.data).toMatchObject({ ok: true, version: '1' });
  });

  it('refuses to send for a caller without a Puter session', async () => {
    const w = loadEmailWorker();
    const res = await w.call('POST', '/copies', { json: copy(), asUser: null });
    expect(res.status).toBe(401);
    expect(w.sent).toHaveLength(0);
  });

  it('reports presence, never values, from /whoami', async () => {
    const w = loadEmailWorker();
    const res = await w.call('GET', '/whoami');
    expect(res.data.has).toEqual({ puter: true, authToken: true, email: true });
    expect(JSON.stringify(res.data)).not.toContain('caller-token');
    expect(JSON.stringify(res.data)).not.toContain('owner-token');
  });
});

describe('email worker: /copies', () => {
  it('sends one private message per recipient with the workbook attached, billed to the caller', async () => {
    const w = loadEmailWorker();
    const res = await w.call('POST', '/copies', { json: copy() });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ ok: true, sent: 2, failed: 0 });
    expect(w.sent.map((m) => m.to)).toEqual(['ana@example.com', 'ben@example.com']);
    const [m] = w.sent;
    expect(m.via).toBe('me');
    expect(m.requesterToken).toBe('caller-token');
    expect(m.replyTo).toBe('demo@example.com');
    expect(m.subject).toBe('Q3 numbers');
    expect(m.attachments).toEqual([{ filename: 'Budget.xlsx', content: XLSX_B64, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]);
    // The sender is named from their session; their words are escaped.
    expect(m.html).toContain('<strong>demo</strong>');
    expect(m.html).toContain('&lt;b&gt;Thanks&lt;/b&gt;');
    expect(m.html).not.toContain('<b>Thanks</b>');
    expect(m.text).toContain('demo sent you a copy of “Budget”');
  });

  it('accepts a PDF and a CSV, each recognized by its content', async () => {
    const w = loadEmailWorker();
    expect((await w.call('POST', '/copies', { json: copy({ attachment: { filename: 'B.pdf', content: PDF_B64 } }) })).status).toBe(200);
    expect(w.sent.at(-1).attachments[0].contentType).toBe('application/pdf');
    expect((await w.call('POST', '/copies', { json: copy({ attachment: { filename: 'B.csv', content: btoa('a,b\n1,2\n') } }) })).status).toBe(200);
    expect(w.sent.at(-1).attachments[0].contentType).toMatch(/^text\/csv/);
  });

  it('refuses an attachment that is not what its name says, or not a workbook at all', async () => {
    const w = loadEmailWorker();
    const bad = async (attachment) => (await w.call('POST', '/copies', { json: copy({ attachment }) })).data.error;
    expect(await bad({ filename: 'B.xlsx', content: PDF_B64 })).toBe('invalid_attachment');
    expect(await bad({ filename: 'run.exe', content: XLSX_B64 })).toBe('invalid_attachment');
    expect(await bad({ filename: 'B.csv', content: btoa('a\u0000b') })).toBe('invalid_attachment');
    expect(await bad({ filename: 'B.xlsx', content: 'not base64!' })).toBe('invalid_attachment');
    expect(await bad(null)).toBe('attachment_required');
    expect(w.sent).toHaveLength(0);
  });

  it('refuses an attachment over the size limit', async () => {
    const w = loadEmailWorker();
    const big = 'UEsDBA' + 'A'.repeat(Math.ceil((7 * 1024 * 1024 + 10) / 3) * 4 - 6);
    const res = await w.call('POST', '/copies', { json: copy({ attachment: { filename: 'B.xlsx', content: big } }) });
    expect(res.status).toBe(413);
    expect(res.data.error).toBe('attachment_too_large');
  });

  it('checks every address and caps the recipients', async () => {
    const w = loadEmailWorker();
    expect((await w.call('POST', '/copies', { json: copy({ recipients: [{ email: 'ana@example.com' }, { email: 'nope' }] }) })).data.error).toBe('invalid_recipient');
    expect((await w.call('POST', '/copies', { json: copy({ recipients: [] }) })).data.error).toBe('recipients_required');
    const many = Array.from({ length: 21 }, (_, i) => ({ email: `p${i}@example.com` }));
    expect((await w.call('POST', '/copies', { json: copy({ recipients: many }) })).data.error).toBe('too_many_recipients');
    // The same address twice gets one message.
    await w.call('POST', '/copies', { json: copy({ recipients: [{ email: 'Ana@Example.com' }, { email: 'ana@example.com' }] }) });
    expect(w.sent).toHaveLength(1);
  });

  it('folds a subject to one line so nothing can be added to the headers', async () => {
    const w = loadEmailWorker();
    await w.call('POST', '/copies', { json: copy({ subject: 'Hi\r\nBcc: victim@example.com' }) });
    expect(w.sent[0].subject).toBe('Hi Bcc: victim@example.com');
  });

  it('reports delivery failures and opted-out recipients per address', async () => {
    const w = loadEmailWorker({ outcome: (m) => (m.to === 'ben@example.com' ? { failed: ['ben@example.com'] } : null) });
    const res = await w.call('POST', '/copies', { json: copy() });
    expect(res.data).toMatchObject({ sent: 1, failed: 1 });
    expect(res.data.results.find((r) => r.email === 'ben@example.com')).toMatchObject({ status: 'failed' });
  });

  it('falls back to the caller-side arrangement when the owner side rejects the request', async () => {
    const w = loadEmailWorker({ outcome: (m, via) => { if (via === 'me') throw new Error('unknown parameter requesterToken'); return null; } });
    const res = await w.call('POST', '/copies', { json: copy({ recipients: [{ email: 'ana@example.com' }] }) });
    expect(res.data.sent).toBe(1);
    const delivered = w.sent.find((m) => m.via === 'user');
    expect(delivered.emailAccessToken).toBe('owner-token');
  });

  it('stops at the daily limit', async () => {
    const w = loadEmailWorker();
    const twenty = Array.from({ length: 20 }, (_, i) => ({ email: `p${i}@example.com` }));
    for (let i = 0; i < 5; i++) await w.call('POST', '/copies', { json: copy({ recipients: twenty }) });
    expect(w.sent).toHaveLength(100);
    const res = await w.call('POST', '/copies', { json: copy({ recipients: [{ email: 'late@example.com' }] }) });
    expect(res.status).toBe(429);
    // Its counter is keyed by a hash, never by who the user is.
    expect([...w.kv.map.keys()].join(' ')).not.toMatch(/demo|u-1/);
  });
});

describe('email worker: /links', () => {
  const body = (over = {}) => ({ workbook: { name: 'Budget' }, recipients: [{ email: 'ana@example.com' }], link: LINK, access: 'edit', message: 'Have a look', ...over });

  it('sends the link with what it lets them do', async () => {
    const w = loadEmailWorker();
    const res = await w.call('POST', '/links', { json: body() });
    expect(res.data.sent).toBe(1);
    expect(w.sent[0].html).toContain(`href="${LINK.replace(/&/g, '&amp;')}"`);
    expect(w.sent[0].text).toContain('you can edit it');
    expect(w.sent[0].attachments).toBeUndefined();
  });

  it('refuses links that are not the app’s own', async () => {
    const w = loadEmailWorker();
    for (const link of ['http://spreadsheet.puter.com/#/file/x', 'https://evil.example/#/file/x', 'https://puter.com.evil.example/', 'javascript:alert(1)',
      'https://spreadsheet.puter.com/#/settings', 'https://user:pw@spreadsheet.puter.com/']) {
      expect((await w.call('POST', '/links', { json: body({ link }) })).data.error).toBe('invalid_link');
    }
    expect((await w.call('POST', '/links', { json: body({ link: 'https://puter.com/app/spreadsheet?file=abc' }) })).data.sent).toBe(1);
    expect((await w.call('POST', '/links', { json: body({ link: "https://spreadsheet.puter.com/#/file/u1?range='Q3%20plan'!B4" }) })).data.sent).toBe(1);
    // Markup in a link arrives percent-encoded, never as markup.
    await w.call('POST', '/links', { json: body({ link: 'https://spreadsheet.puter.com/#/file/x"><script>' }) });
    expect(w.sent.at(-1).html).not.toContain('<script>');
  });
});

describe('email worker: /mentions', () => {
  const body = (over = {}) => ({
    workbook: { name: 'Budget' }, recipients: [{ email: 'ana@example.com', name: 'ana' }], link: LINK,
    comment: { id: '{11111111-2222-3333-4444-555555555555}', text: '@ana is B4 right?', cell: 'Sheet1!B4' }, ...over,
  });

  it('tells the person mentioned, once per comment', async () => {
    const w = loadEmailWorker();
    const first = await w.call('POST', '/mentions', { json: body() });
    expect(first.data.sent).toBe(1);
    expect(w.sent[0].subject).toBe('demo mentioned you in “Budget”');
    expect(w.sent[0].text).toContain('on Sheet1!B4');
    expect(w.sent[0].text).toContain('@ana is B4 right?');
    const again = await w.call('POST', '/mentions', { json: body() });
    expect(again.data).toMatchObject({ sent: 0, skipped: 1 });
    expect(w.sent).toHaveLength(1);
  });

  it('needs a comment', async () => {
    const w = loadEmailWorker();
    expect((await w.call('POST', '/mentions', { json: body({ comment: { id: 'x', text: 'hi' } }) })).data.error).toBe('comment_required');
    expect((await w.call('POST', '/mentions', { json: body({ comment: { id: '{11111111-2222-3333-4444-555555555555}', text: ' ' } }) })).data.error).toBe('comment_required');
  });
});
