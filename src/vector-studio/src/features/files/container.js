/**
 * The .ai file container: a PDF-compatible file. Every artboard is a PDF
 * page, so any program that reads .ai or PDF files shows the artwork, and
 * the editable document (the data format.js describes) travels in a private
 * stream named by the catalog's page-piece dictionary, the PDF mechanism for
 * an application's own data:
 *
 *   /PieceInfo << /VectorStudio << /LastModified (D:...) /Private N 0 R >> >>
 *   N 0 obj << /Type /VectorStudioDocument /Version 1 /DocID <hex> /Length n >> stream ... endstream
 *
 * /DocID repeats the file identifier in the trailer. A program that changes
 * the pages and writes the file back gives the file a new identifier; the
 * embedded document is then out of date, and the pages are imported instead.
 *
 * This module finds and reads the private stream without a PDF parser (the
 * home screen reads thumbnails with it), and writes the plain container used
 * when the pages cannot be drawn. The full writer is writePDF (io/pdf.js).
 */

const APP_KEY = 'VectorStudio';
const STREAM_TYPE = 'VectorStudioDocument';
export const CONTAINER_VERSION = 1;

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const text = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
};
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const MARK = ascii(`/Type /${STREAM_TYPE}`);
const STREAM = ascii('stream');
const ENDSTREAM = ascii('endstream');
const STARTXREF = ascii('startxref');
const TRAILER = ascii('trailer');

function matchesAt(bytes, pat, at) {
  if (at < 0 || at + pat.length > bytes.length) return false;
  for (let i = 0; i < pat.length; i++) if (bytes[at + i] !== pat[i]) return false;
  return true;
}

function indexOf(bytes, pat, from = 0, to = bytes.length) {
  const first = pat[0];
  for (let i = Math.max(0, from), end = Math.min(to, bytes.length) - pat.length; i <= end; i++) {
    if (bytes[i] === first && matchesAt(bytes, pat, i)) return i;
  }
  return -1;
}

function lastIndexOf(bytes, pat, from = bytes.length - pat.length) {
  const first = pat[0];
  for (let i = Math.min(from, bytes.length - pat.length); i >= 0; i--) {
    if (bytes[i] === first && matchesAt(bytes, pat, i)) return i;
  }
  return -1;
}

/** Whether the bytes are a PDF file: %PDF within the first KB (some writers put a header before it). */
export function isPDF(bytes) {
  if (!bytes) return false;
  for (let i = 0, end = Math.min(bytes.length, 1024) - 4; i < end; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) return true;
  }
  return false;
}

/** The file identifier that changes whenever the file is rewritten (lower-case hex), or null. */
export function fileIdentifier(bytes) {
  const at = lastIndexOf(bytes, STARTXREF);
  if (at < 0) return null;
  const offset = Number(/^\s*(\d+)/.exec(text(bytes.subarray(at + STARTXREF.length, at + STARTXREF.length + 32)))?.[1]);
  if (!Number.isInteger(offset) || offset >= at) return null;
  // A cross-reference table is followed by the trailer dictionary; a cross-reference stream starts with it.
  const trailer = indexOf(bytes, TRAILER, offset, at);
  const from = trailer >= 0 ? trailer : offset;
  const m = /\/ID\s*\[\s*<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>/.exec(text(bytes.subarray(from, Math.min(at, from + 65536))));
  return m ? m[2].replace(/\s+/g, '').toLowerCase() : null;
}

/**
 * The editable document a PDF-compatible file carries (the bytes
 * format.js reads), or null: not a PDF, not saved by this app, or changed
 * by another program since.
 */
export function embeddedDocument(bytes) {
  if (!isPDF(bytes)) return null;
  // The stream object is near the end of a file written here. An earlier match can only be the same
  // words inside artwork or data, so each one is tried until one reads as the stream.
  for (let at = lastIndexOf(bytes, MARK); at >= 0; at = lastIndexOf(bytes, MARK, at - 1)) {
    const data = streamAt(bytes, at);
    if (data) return data;
  }
  return null;
}

/** The private stream whose dictionary names its type at `at`, or null. */
function streamAt(bytes, at) {
  const s = indexOf(bytes, STREAM, at, at + 512);
  if (s < 0) return null;
  const dict = text(bytes.subarray(at, s));
  // Only the stream as it was written: a filter or an indirect length means another program rewrote it.
  if (/\/Filter|\/DecodeParms/.test(dict)) return null;
  const length = Number(/\/Length\s+(\d+)\s*>>\s*$/.exec(dict)?.[1]);
  if (!Number.isInteger(length) || length <= 0) return null;
  let p = s + STREAM.length;
  if (bytes[p] === 0x0d) p++;
  if (bytes[p] !== 0x0a) return null;
  p++;
  const end = p + length;
  let q = end;
  while (bytes[q] === 0x0d || bytes[q] === 0x0a) q++;
  if (end > bytes.length || !matchesAt(bytes, ENDSTREAM, q)) return null;
  const id = /\/DocID\s*<([0-9a-fA-F]+)>/.exec(dict)?.[1].toLowerCase();
  if (id && fileIdentifier(bytes) !== id) return null;
  const data = bytes.subarray(p, end);
  // Document data is gzip or JSON text; anything else (an encrypted file) is not readable here.
  const ok = (data[0] === 0x1f && data[1] === 0x8b) || data[0] === 0x7b;
  return ok ? data : null;
}

/** A PDF date string (UTC, whole seconds). */
export function pdfDate(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}

/** The private stream's dictionary entries (without << >> and /Length) for a file whose identifier is `id` (bytes). */
export function privateStreamDict(id) {
  return `/Type /${STREAM_TYPE} /Version ${CONTAINER_VERSION} /DocID <${hex(id)}>`;
}

/** The catalog entry naming the private stream object `ref`. */
export function pieceInfoEntry(ref, date = pdfDate()) {
  return `/PieceInfo << /${APP_KEY} << /LastModified (${date}) /Private ${ref} 0 R >> >>`;
}

function randomId() {
  const id = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(id);
  else for (let i = 0; i < 16; i++) id[i] = Math.floor(Math.random() * 256);
  return id;
}

const NOTE = 'This file was saved without a preview. Open it in Vector Studio to see the artwork.';

/**
 * A container whose pages are blank except for a note: used when the
 * artwork cannot be drawn as PDF (the document itself is complete).
 * `artboards` are { w, h } rects; `payload` is the document data.
 */
export function plainContainer(artboards, payload, { date = new Date() } = {}) {
  const id = randomId();
  const stamp = pdfDate(date);
  const boards = artboards?.length ? artboards : [{ w: 612, h: 792 }];
  const objects = [null];
  const add = (body) => objects.push(body) - 1;
  const num = (v) => String(Math.round(Math.max(1, v) * 1000) / 1000);
  const catalog = add(null);
  const pages = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids = boards.map((a) => {
    const ops = ascii(`BT /F1 10 Tf 24 ${num(a.h - 34)} Td (${NOTE}) Tj ET`);
    const content = add({ dict: '', data: ops });
    return add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${num(a.w)} ${num(a.h)}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[pages] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const data = add({ dict: privateStreamDict(id), data: payload });
  objects[catalog] = `<< /Type /Catalog /Pages ${pages} 0 R ${pieceInfoEntry(data, stamp)} >>`;
  const info = add(`<< /Producer (Vector Studio) /Creator (Vector Studio) /CreationDate (${stamp}) /ModDate (${stamp}) >>`);

  const chunks = [];
  let offset = 0;
  const push = (b) => {
    const bytes = typeof b === 'string' ? ascii(b) : b;
    chunks.push(bytes);
    offset += bytes.length;
  };
  push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    const o = objects[i];
    offsets[i] = offset;
    if (typeof o === 'string') push(`${i} 0 obj\n${o}\nendobj\n`);
    else {
      push(`${i} 0 obj\n<<${o.dict ? ` ${o.dict}` : ''} /Length ${o.data.length} >>\nstream\n`);
      push(o.data);
      push('\nendstream\nendobj\n');
    }
  }
  const xref = offset;
  let table = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R /Info ${info} 0 R /ID [<${hex(id)}> <${hex(id)}>] >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
