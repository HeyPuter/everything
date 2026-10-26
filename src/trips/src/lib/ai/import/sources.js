// Import inputs: what each file is, and what part of it goes to the model. EML and PKPass are decoded locally.
import { htmlToText, parseEml } from './mime.js';
import { parsePkpass } from './pkpass.js';

export const LIMITS = Object.freeze({ files: 5, fileBytes: 10 * 1024 * 1024, mails: 5, textChars: 60_000, attachments: 4, attachmentBytes: 20 * 1024 * 1024 });

const KINDS = {
  pdf: { exts: ['pdf'], mimes: ['application/pdf'] },
  image: { exts: ['jpg', 'jpeg', 'png', 'gif', 'webp'], mimes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] },
  eml: { exts: ['eml'], mimes: ['message/rfc822'] },
  html: { exts: ['html', 'htm'], mimes: ['text/html'] },
  text: { exts: ['txt', 'text'], mimes: ['text/plain'] },
  pkpass: { exts: ['pkpass'], mimes: ['application/vnd.apple.pkpass'] },
  calendar: { exts: ['ics'], mimes: ['text/calendar', 'application/ics'] },
};
const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
export const ACCEPT = Object.values(KINDS).flatMap((kind) => kind.exts.map((ext) => `.${ext}`)).concat(['message/rfc822', 'application/vnd.apple.pkpass']).join(',');

export class SourceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const extensionOf = (name) => /\.([a-z0-9]{1,10})$/i.exec(String(name ?? ''))?.[1].toLowerCase() ?? '';

/** The import kind of a file by extension, then MIME type: pdf|image|eml|html|text|pkpass|calendar, or null. */
export function kindOf(name, mime = '') {
  const ext = extensionOf(name);
  const type = String(mime ?? '').toLowerCase().split(';')[0].trim();
  for (const [kind, spec] of Object.entries(KINDS)) if (spec.exts.includes(ext)) return kind;
  for (const [kind, spec] of Object.entries(KINDS)) if (spec.mimes.includes(type)) return kind;
  return null;
}

/** Why a file cannot be imported (`type`, `size`, `heic`), or null. */
export function fileProblem(file) {
  if (/\.(heic|heif)$/i.test(file?.name ?? '') || /^image\/hei[cf]$/i.test(file?.type ?? '')) return 'heic';
  if (!kindOf(file?.name, file?.type)) return 'type';
  if (!(file.size > 0) || file.size > LIMITS.fileBytes) return 'size';
  return null;
}

const typed = (blob, name, kind) => {
  if (kind === 'pdf') return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
  if (kind === 'image') { const mime = IMAGE_MIME[extensionOf(name)] ?? blob.type; return blob.type === mime ? blob : new Blob([blob], { type: mime }); }
  return blob;
};
const trimText = (text) => {
  const value = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  return value.length > LIMITS.textChars ? `${value.slice(0, LIMITS.textChars)}\n[…]` : value;
};
const blobText = async (blob) => (typeof blob.text === 'function' ? blob.text() : new TextDecoder().decode(await blob.arrayBuffer()));

/**
 * What one parsed message contributes: its headers and body as text, PDF and image attachments as files, and
 * wallet passes and calendar parts read locally. `mail` is `{subject, from, date, text, html, attachments}` with
 * attachment `content` as bytes or an ArrayBuffer (the shape of `parseEml` and `puter.email.get`).
 */
export async function fromMail(mail) {
  const body = mail.text?.trim() ? mail.text : htmlToText(mail.html ?? '');
  const parts = [];
  const head = [mail.subject && `Subject: ${mail.subject}`, mail.from && `From: ${typeof mail.from === 'string' ? mail.from : [mail.from.name, mail.from.address].filter(Boolean).join(' ')}`, mail.date && `Date: ${mail.date}`].filter(Boolean);
  if (head.length) parts.push(head.join('\n'));
  if (body.trim()) parts.push(body);
  for (const forwarded of mail.forwarded ?? []) if (forwarded.subject) parts.push(`Forwarded message: ${forwarded.subject}`);
  const files = [];
  const items = [];
  const failures = [];
  let attachmentBytes = 0;
  for (const attachment of mail.attachments ?? []) {
    const name = attachment.filename || 'attachment';
    const kind = kindOf(name, attachment.mimeType);
    const bytes = attachment.content instanceof Uint8Array ? attachment.content : new Uint8Array(attachment.content ?? new ArrayBuffer(0));
    if (!kind || !bytes.length || attachment.related) continue;
    if (kind === 'pkpass') {
      try { items.push(await parsePkpass(bytes)); } catch (error) { failures.push({ name, code: error.code ?? 'pkpass_invalid' }); }
    } else if (kind === 'calendar' || kind === 'text' || kind === 'html') {
      const text = new TextDecoder().decode(bytes);
      parts.push(`Attachment ${name}:\n${kind === 'html' ? htmlToText(text) : text}`);
    } else if ((kind === 'pdf' || kind === 'image') && files.length < LIMITS.attachments && attachmentBytes + bytes.length <= LIMITS.attachmentBytes) {
      attachmentBytes += bytes.length;
      files.push({ name, blob: typed(new Blob([bytes]), name, kind), kind });
    }
  }
  return { text: trimText(parts.join('\n\n')), files, items, failures };
}

/**
 * Reads one input into `{text, files, items, failures, attach}`: `text` and `files` go to the model, `items` are
 * extraction items read locally (wallet passes), and `attach` lists files to keep on the created bookings.
 * `input` is `{type: 'file', file}` (a File or `{name, blob}`), `{type: 'paste', text}` or `{type: 'mail', message}`.
 */
export async function readInput(input) {
  if (input.type === 'paste') {
    const text = trimText(input.text);
    if (!text) throw new SourceError('empty');
    return { text, files: [], items: [], failures: [], attach: [] };
  }
  if (input.type === 'mail') {
    const result = await fromMail(input.message);
    if (!result.text && !result.files.length && !result.items.length) throw new SourceError('empty');
    return { ...result, attach: result.files.filter((file) => file.kind === 'pdf') };
  }
  const blob = input.file?.blob ?? input.file;
  const name = input.file?.name ?? 'file';
  const kind = kindOf(name, blob?.type);
  if (!blob || !kind) throw new SourceError('type');
  if (blob.size > LIMITS.fileBytes) throw new SourceError('size');
  const own = { name, blob: typed(blob, name, kind), kind };
  if (kind === 'pkpass') return { text: '', files: [], items: [await parsePkpass(blob)], failures: [], attach: [own] };
  if (kind === 'pdf' || kind === 'image') return { text: '', files: [own], items: [], failures: [], attach: [own] };
  if (kind === 'eml') {
    const result = await fromMail(await parseEml(blob));
    if (!result.text && !result.files.length && !result.items.length) throw new SourceError('empty');
    return { ...result, attach: result.files.filter((file) => file.kind === 'pdf') };
  }
  const raw = await blobText(blob);
  const text = trimText(kind === 'html' ? htmlToText(raw) : raw);
  if (!text) throw new SourceError('empty');
  return { text, files: [], items: [], failures: [], attach: kind === 'text' ? [own] : [] };
}

/** SHA-256 hex of a source's bytes or text, for `src.hash`. */
export async function sourceHash(input) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  let data;
  if (input.type === 'paste') data = new TextEncoder().encode(input.text);
  else if (input.type === 'mail') data = new TextEncoder().encode(`mail:${input.message?.id ?? ''}:${input.message?.subject ?? ''}`);
  else data = new Uint8Array(await (input.file?.blob ?? input.file).arrayBuffer());
  const digest = await subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
