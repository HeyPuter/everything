/**
 * Email from the spreadsheet: the app's side of src/workers/email-worker.js. Send a Copy (the workbook as an
 * attachment), Send a Link (a link that opens it) and comment @mentions (a note to the person mentioned) all go
 * through the app's one shared email worker at EMAIL_WORKER_URL. The call goes through puter.workers.exec(),
 * which forwards the signed-in user's Puter session: that is what lets the worker send at all, and what bills
 * the send to the person sending, never the app owner. No token or credential of the user's is ever put in a
 * request body here; the worker names the sender from the session it receives.
 *
 * The arrangement is the Calendar app's (src/calendar/src/js/invites.js), copied and adapted.
 */
import { sheetsToPdf } from '../core/sheet-pdf.js';
import { rangeToCsv } from '../core/io.js';
import * as P from './puter.js';

/** The one shared, app-owned worker (see src/workers/email-worker.js). */
export const EMAIL_WORKER_URL = 'https://spreadsheet-email.puter.work';

/** The worker's own limits, so the dialog can refuse before anything is sent. */
export const MAX_RECIPIENTS = 20;
export const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;
export const MAX_MESSAGE = 2000;

const EMAIL = /^[^\s@<>()",;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** A well-formed address in lower case, or ''. */
export function normalizeEmail(value) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return s.length <= 254 && EMAIL.test(s) ? s : '';
}

/**
 * The addresses typed into a To field: separated by commas, semicolons, spaces or new lines, each bare
 * (ana@example.com) or with a name (Ana Diaz <ana@example.com>). Returns { people: [{ email, name }],
 * invalid: [what was typed], duplicates: count }.
 */
export function parseRecipients(input) {
  const people = [], invalid = [];
  const seen = new Set();
  let duplicates = 0;
  const src = String(input || '');
  // Named addresses first: their names may hold spaces and commas, which would split them.
  const rest = src.replace(/(?:"([^"]*)"|([^,;<>\n]*?))\s*<([^<>\s]+)>/g, (_, quoted, plain, address) => `\u0000${JSON.stringify([(quoted ?? plain ?? '').trim(), address])}\u0000`);
  // Between the markers stand the named addresses; everything else splits at the separators.
  const tokens = rest.split('\u0000').flatMap((part, i) => (i % 2 ? [part] : part.split(/[,;\s]+/))).map((t) => t.trim()).filter(Boolean);
  for (const token of tokens) {
    let name = '', raw = token;
    if (token.startsWith('[')) {
      try { [name, raw] = JSON.parse(token); } catch { /* left as typed */ }
    }
    const email = normalizeEmail(raw);
    if (!email) { invalid.push(name ? `${name} <${raw}>` : raw); continue; }
    if (seen.has(email)) { duplicates++; continue; }
    seen.add(email);
    people.push({ email, name: name.slice(0, 120) });
  }
  return { people, invalid, duplicates };
}

/** What is wrong with a recipient list, in words for the dialog, or null when it can be sent to. */
export function recipientProblem({ people, invalid }, { max = MAX_RECIPIENTS } = {}) {
  if (invalid.length) {
    return invalid.length === 1
      ? `"${invalid[0]}" is not an email address`
      : `These are not email addresses: ${invalid.slice(0, 3).map((t) => `"${t}"`).join(', ')}${invalid.length > 3 ? '…' : ''}`;
  }
  if (!people.length) return 'Enter at least one email address';
  if (people.length > max) return `You can send to at most ${max} people at a time`;
  return null;
}

/** A size in words: "3.4 MB". */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Why an attachment of `bytes` cannot be sent, or null. */
export function attachmentProblem(bytes) {
  return bytes > MAX_ATTACHMENT_BYTES
    ? `The copy is ${formatSize(bytes)}; an email can carry at most ${formatSize(MAX_ATTACHMENT_BYTES)}. Send a link instead, or send one sheet.`
    : null;
}

/* ---------- The attachment ---------- */

export const COPY_FORMATS = [
  ['xlsx', 'Workbook (.xlsx)'],
  ['pdf', 'PDF (.pdf)'],
  ['csv', 'Sheet as .csv'],
];

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * The file Send a Copy attaches: { filename, contentType, blob }. `format` is 'xlsx', 'pdf' or 'csv'; a PDF
 * covers `scope` 'workbook' (every visible sheet), 'sheet' (sheetId) or 'selection' (range on sheetId); a
 * CSV is always one sheet (or the selection). The .xlsx leaves out Show Changes' record of earlier cell
 * values, as every downloaded copy does (Doc.toXlsxBlob).
 */
export async function buildAttachment(doc, { format = 'xlsx', scope = 'workbook', sheetId = doc.wb.activeSheetId, range = null } = {}) {
  const wb = doc.wb;
  const base = P.sanitizeName(doc.name) || 'Spreadsheet';
  const sheet = wb.sheet(sheetId);
  const suffix = scope === 'selection' ? ' (selection)' : scope === 'sheet' && wb.sheets.length > 1 && sheet ? ` - ${P.sanitizeName(sheet.name)}` : '';
  if (format === 'pdf') {
    const parts = scope === 'workbook'
      ? wb.sheets.filter((s) => !s.hidden && !s.veryHidden).map((s) => ({ sheetId: s.id }))
      : [{ sheetId, range: scope === 'selection' ? range : null }];
    const bytes = sheetsToPdf(wb, parts, { title: doc.name });
    return { filename: `${base}${suffix}.pdf`, contentType: 'application/pdf', blob: new Blob([bytes], { type: 'application/pdf' }) };
  }
  if (format === 'csv') {
    const blob = scope === 'selection' && range
      ? new Blob([rangeToCsv(wb, sheetId, range)], { type: 'text/csv;charset=utf-8' })
      : doc.toCsvBlob(sheetId);
    const csvSuffix = scope === 'selection' ? ' (selection)' : wb.sheets.length > 1 && sheet ? ` - ${P.sanitizeName(sheet.name)}` : '';
    return { filename: `${base}${csvSuffix}.csv`, contentType: 'text/csv', blob };
  }
  const blob = await doc.toXlsxBlob();
  return { filename: `${base}.xlsx`, contentType: XLSX_MIME, blob };
}

/** A blob's bytes as base64, in chunks (spreading a large buffer into fromCharCode overflows the stack). */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ---------- Results in words ---------- */

/** What to tell the sender, for the toast: { variant, message }. `noun` names one message ("copy", "link"). */
export function describeResult(out, { noun = 'email' } = {}) {
  const sent = out?.sent || 0, failed = out?.failed || 0, optedOut = out?.suppressed || 0;
  const capped = (out?.results || []).filter((r) => r.status === 'skipped' && r.reason === 'daily_limit').length;
  const already = (out?.results || []).filter((r) => r.status === 'skipped' && r.reason === 'already_sent').length;
  const to = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
  if (capped) {
    return { variant: 'danger', message: sent ? `Sent to ${to(sent)}, but ${capped} could not be sent: today's email limit was reached.` : "Today's email limit was reached. Try again tomorrow." };
  }
  if (failed) {
    return { variant: 'danger', message: sent ? `Sent to ${to(sent)}, but ${failed} could not be delivered.` : `The ${noun} could not be delivered.` };
  }
  if (optedOut) {
    return { variant: 'default', message: `${sent ? `Sent to ${to(sent)}. ` : ''}${optedOut === 1 ? 'One person has' : `${optedOut} people have`} opted out of these emails.` };
  }
  if (sent) {
    const only = out.results?.find((r) => r.status === 'sent')?.email;
    return { variant: 'success', message: sent === 1 && only ? `${noun[0].toUpperCase()}${noun.slice(1)} sent to ${only}` : `${noun[0].toUpperCase()}${noun.slice(1)} sent to ${to(sent)}` };
  }
  if (already) return { variant: 'default', message: 'They were already told.' };
  return { variant: 'default', message: 'Nothing was sent.' };
}

/** A refused request in words. */
export function failureMessage(status, data) {
  const code = data?.error || '';
  if (status === 401 || code === 'sign_in_required') return 'Sign in to Puter again to send email.';
  if (status === 429 || code === 'daily_limit') return "You've reached today's email limit. Try again tomorrow.";
  if (status === 413 || code === 'attachment_too_large') return `The attachment is too large to email (at most ${formatSize(MAX_ATTACHMENT_BYTES)}).`;
  if (code === 'too_many_recipients') return `You can send to at most ${MAX_RECIPIENTS} people at a time.`;
  if (code === 'invalid_recipient') return 'One of the addresses is not a valid email address.';
  if (code === 'invalid_attachment') return 'The email service could not accept this file.';
  if (code === 'invalid_link') return 'The email service could not accept the link to this workbook.';
  if (status === 404) return 'The email service is unavailable right now.';
  return 'Could not send the email. Please try again.';
}

/* ---------- Sending ---------- */

/**
 * The mailer: { available(), sendCopy, sendLink, sendMentions }. Each send resolves the worker's summary
 * ({ sent, failed, suppressed, skipped, results }) or throws an Error whose message is for the sender.
 * `getPuter` and `workerUrl` are for tests and the dev mock.
 */
export function createMailer({ getPuter = () => globalThis.puter, workerUrl = EMAIL_WORKER_URL } = {}) {
  function available() {
    const p = getPuter();
    return Boolean(p && p.workers && typeof p.workers.exec === 'function');
  }

  async function post(route, body) {
    if (!available()) throw new Error('Email is not available here. Open the spreadsheet in Puter to send email.');
    let res;
    try {
      res = await getPuter().workers.exec(`${workerUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error(e);
      throw new Error('Could not reach the email service. Check your connection and try again.');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) throw Object.assign(new Error(failureMessage(res.status, data)), { status: res.status, code: data?.error || null });
    return data;
  }

  const recipientsOf = (people) => people.map((p) => (typeof p === 'string' ? { email: p } : { email: p.email, ...(p.name ? { name: p.name } : {}) }));

  return {
    available,
    /** A copy as an attachment: `attachment` from buildAttachment. */
    async sendCopy({ workbookName, recipients, subject = '', message = '', attachment }) {
      const problem = attachmentProblem(attachment.blob.size);
      if (problem) throw new Error(problem);
      return post('/copies', {
        workbook: { name: workbookName },
        recipients: recipientsOf(recipients),
        subject: String(subject).slice(0, 200),
        message: String(message).slice(0, MAX_MESSAGE),
        attachment: { filename: attachment.filename, contentType: attachment.contentType, content: await blobToBase64(attachment.blob) },
      });
    },
    /** A link that opens the workbook; `access` ('view' or 'edit') is what the mail says it lets them do. */
    sendLink({ workbookName, recipients, link, access = 'view', message = '' }) {
      return post('/links', { workbook: { name: workbookName }, recipients: recipientsOf(recipients), link, access, message: String(message).slice(0, MAX_MESSAGE) });
    },
    /**
     * People mentioned in a comment: { id, text, cell } and a link that opens the workbook at the cell.
     * `assigned`: the thread was assigned to them as well.
     */
    sendMentions({ workbookName, recipients, comment, link, assigned = false }) {
      return post('/mentions', {
        workbook: { name: workbookName }, recipients: recipientsOf(recipients), comment: { id: comment.id, text: comment.text, cell: comment.cell }, link,
        ...(assigned ? { assigned: true } : {}),
      });
    },
  };
}
