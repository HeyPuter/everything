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
import { t } from '../i18n/index.js';

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
  const rest = src.replace(/(?:"([^"]*)"|([^,;<>\n]*?))\s*<([^<>\s]+)>/g, (_, quoted, plain, address) => {
    // Addresses typed ahead of the name with spaces alone between them ("bob@example.com Ana <ana@…>") are
    // recipients of their own, split off as everywhere else, not the start of the name. Only words shaped like an
    // address are: an @ in a name otherwise ("Ana (@ana_d)", "Sales @ HQ") stays part of it.
    const words = (quoted ?? plain ?? '').trim().split(/\s+/);
    const ahead = quoted == null ? words.findLastIndex((w) => /^[^\s@<>()"]+@[^\s@<>()"]+$/.test(w)) + 1 : 0;
    return `${words.slice(0, ahead).join(' ')}\u0000${JSON.stringify([words.slice(ahead).join(' '), address])}\u0000`;
  });
  // Between the markers stand the named addresses; everything else splits at the separators.
  const tokens = rest.split('\u0000').flatMap((part, i) => (i % 2 ? [part] : part.split(/[,;\s]+/))).map((token) => token.trim()).filter(Boolean);
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
    const [a, b, c] = invalid;
    if (invalid.length === 1) return t('mail.recipients.notAnAddress', { a });
    if (invalid.length === 2) return t('mail.recipients.notAddresses2', { a, b });
    return invalid.length === 3 ? t('mail.recipients.notAddresses3', { a, b, c }) : t('mail.recipients.notAddressesMore', { a, b, c });
  }
  if (!people.length) return t('mail.recipients.none');
  if (people.length > max) return t('mail.recipients.tooMany', { max });
  return null;
}

/** A size in words: "3.4 MB". */
export function formatSize(bytes) {
  if (bytes < 1024) return t('mail.size.bytes', { bytes });
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Why an attachment of `bytes` cannot be sent, or null. */
export function attachmentProblem(bytes) {
  return bytes > MAX_ATTACHMENT_BYTES
    ? t('mail.attachmentTooLarge', { size: formatSize(bytes), max: formatSize(MAX_ATTACHMENT_BYTES) })
    : null;
}

/* ---------- The attachment ---------- */

/** [value, label] for one format, its label read in the interface language each time it is drawn (not as this loads). */
const format = (value, key) => Object.defineProperty([value], 1, { enumerable: true, get: () => t(key) });

/** Send a Copy's formats, [value, label]. */
export const COPY_FORMATS = [
  format('xlsx', 'mail.format.xlsx'),
  format('pdf', 'mail.format.pdf'),
  format('csv', 'mail.format.csv'),
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
  if (capped) {
    return { variant: 'danger', message: sent ? t('mail.result.someCapped', { sent, capped }) : t('mail.result.capped') };
  }
  if (failed) {
    return { variant: 'danger', message: sent ? t('mail.result.someFailed', { sent, failed }) : t('mail.result.failed', { noun }) };
  }
  if (optedOut) {
    return { variant: 'default', message: sent ? t('mail.result.sentSomeOptedOut', { sent, optedOut }) : t('mail.result.optedOut', { optedOut }) };
  }
  if (sent) {
    const only = out.results?.find((r) => r.status === 'sent')?.email;
    return { variant: 'success', message: sent === 1 && only ? t('mail.result.sentTo', { noun, email: only }) : t('mail.result.sentToCount', { noun, sent }) };
  }
  if (already) return { variant: 'default', message: t('mail.result.alreadyTold') };
  return { variant: 'default', message: t('mail.result.nothingSent') };
}

/** A refused request in words. */
export function failureMessage(status, data) {
  const code = data?.error || '';
  if (status === 401 || code === 'sign_in_required') return t('mail.failure.signIn');
  if (status === 429 || code === 'daily_limit') return t('mail.failure.dailyLimit');
  if (status === 413 || code === 'attachment_too_large') return t('mail.failure.attachmentTooLarge', { max: formatSize(MAX_ATTACHMENT_BYTES) });
  if (code === 'too_many_recipients') return t('mail.failure.tooManyRecipients', { max: MAX_RECIPIENTS });
  if (code === 'invalid_recipient') return t('mail.failure.invalidRecipient');
  if (code === 'invalid_attachment') return t('mail.failure.invalidAttachment');
  if (code === 'invalid_link') return t('mail.failure.invalidLink');
  if (status === 404) return t('mail.failure.unavailable');
  return t('mail.failure.other');
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
    if (!available()) throw new Error(t('mail.notAvailable'));
    let res;
    try {
      res = await getPuter().workers.exec(`${workerUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error(e);
      throw new Error(t('mail.unreachable'));
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
