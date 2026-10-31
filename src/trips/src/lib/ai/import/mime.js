// Local MIME decoding for .eml files and plain-text conversion of HTML bodies. Nothing here renders markup.

const MAX_DEPTH = 8;
const MAX_PARTS = 200;

/** A string with one char per byte (0–255), so byte-level decoders can run on it. */
export function binaryString(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}
const stringBytes = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

export function decodeCharset(bytes, charset = 'utf-8') {
  const label = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'utf-8' : label).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

export function decodeBase64(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/]/g, '');
  const usable = clean.slice(0, clean.length - (clean.length % 4 === 1 ? 1 : 0));
  try { return stringBytes(atob(usable + '='.repeat((4 - (usable.length % 4)) % 4))); }
  catch { return new Uint8Array(0); }
}

export function decodeQuotedPrintable(text, { header = false } = {}) {
  const source = header ? String(text).replace(/_/g, ' ') : String(text).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(source.slice(i + 1, i + 3))) { bytes.push(parseInt(source.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(source.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(bytes);
}

/** Decodes RFC 2047 encoded words; adjacent encoded words join without the space between them. */
export function decodeWords(value) {
  let text = String(value ?? '');
  // Raw 8-bit header bytes arrive one char per byte; read them as UTF-8 when they form valid UTF-8.
  if (/[\u0080-ÿ]/.test(text) && !/[Ā-￿]/.test(text)) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(stringBytes(text)); } catch { /* Keep the Latin-1 reading. */ }
  }
  return text.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (match, charset, encoding, payload) => {
    const bytes = encoding.toUpperCase() === 'B' ? decodeBase64(payload) : decodeQuotedPrintable(payload, { header: true });
    return decodeCharset(bytes, charset.split('*')[0]);
  });
}

function splitHead(text) {
  const match = /\r?\n\r?\n/.exec(text);
  return match ? [text.slice(0, match.index), text.slice(match.index + match[0].length)] : [text, ''];
}

export function parseHeaders(head) {
  const headers = new Map();
  const lines = head.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) { current.value += ` ${line.trim()}`; continue; }
    const colon = line.indexOf(':');
    if (colon <= 0) { current = null; continue; }
    current = { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
    if (!headers.has(current.name)) headers.set(current.name, []);
    headers.get(current.name).push(current);
  }
  const map = new Map();
  for (const [name, entries] of headers) map.set(name, entries.map((entry) => entry.value));
  return map;
}
const header = (headers, name) => headers.get(name)?.[0] ?? '';

/** `{value, params}` for a structured header such as Content-Type; handles quoted and RFC 2231 parameters. */
export function parseParams(value) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (const char of String(value ?? '')) {
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) { parts.push(current); current = ''; } else current += char;
  }
  parts.push(current);
  const params = {};
  const extended = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let raw = part.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).replace(/\\(.)/g, '$1');
    const star = /^([^*]+)\*(?:(\d+)\*?)?$/.exec(key);
    if (star) (extended[star[1]] ??= []).push({ index: Number(star[2] ?? 0), raw, encoded: key.endsWith('*') });
    else params[key] = raw;
  }
  for (const [key, pieces] of Object.entries(extended)) {
    pieces.sort((a, b) => a.index - b.index);
    let charset = 'utf-8';
    const bytes = [];
    pieces.forEach((piece, index) => {
      let raw = piece.raw;
      if (index === 0 && piece.encoded && /^[^']*'[^']*'/.test(raw)) {
        const [set, , ...rest] = raw.split("'");
        charset = set || charset;
        raw = rest.join("'");
      }
      const decoded = piece.encoded ? raw.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))) : raw;
      bytes.push(...stringBytes(decoded));
    });
    params[key] = decodeCharset(Uint8Array.from(bytes), charset);
  }
  return { value: parts[0].trim().toLowerCase(), params };
}

function bodyBytes(body, encoding) {
  const kind = String(encoding ?? '').trim().toLowerCase();
  if (kind === 'base64') return decodeBase64(body);
  if (kind === 'quoted-printable') return decodeQuotedPrintable(body);
  return stringBytes(body);
}

function splitMultipart(body, boundary) {
  const marker = `--${boundary}`;
  const parts = [];
  const lines = body.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (line.startsWith(marker)) {
      if (current) parts.push(current.join('\r\n'));
      if (line.slice(marker.length).startsWith('--')) { current = null; break; }
      current = [];
    } else if (current) current.push(line);
  }
  if (current) parts.push(current.join('\r\n'));
  return parts;
}

function walk(raw, out, depth) {
  if (depth > MAX_DEPTH || out.count >= MAX_PARTS) return;
  out.count += 1;
  const [head, body] = splitHead(raw);
  const headers = parseHeaders(head);
  const type = parseParams(header(headers, 'content-type') || 'text/plain');
  const disposition = parseParams(header(headers, 'content-disposition'));
  const encoding = header(headers, 'content-transfer-encoding');
  if (type.value.startsWith('multipart/') && type.params.boundary) {
    for (const part of splitMultipart(body, type.params.boundary)) walk(part, out, depth + 1);
    return;
  }
  const filename = decodeWords(disposition.params.filename ?? type.params.name ?? '') || null;
  const attachment = disposition.value === 'attachment' || Boolean(filename);
  if (type.value === 'message/rfc822' && !attachment) {
    const inner = binaryString(bodyBytes(body, encoding));
    const [innerHead] = splitHead(inner);
    const innerHeaders = parseHeaders(innerHead);
    out.forwarded.push({ subject: decodeWords(header(innerHeaders, 'subject')), from: decodeWords(header(innerHeaders, 'from')), date: header(innerHeaders, 'date') });
    walk(inner, out, depth + 1);
    return;
  }
  const bytes = bodyBytes(body, encoding);
  if (!attachment && type.value === 'text/plain') out.text.push(decodeCharset(bytes, type.params.charset));
  else if (!attachment && type.value === 'text/html') out.html.push(decodeCharset(bytes, type.params.charset));
  else out.attachments.push({ filename, mimeType: type.value, disposition: disposition.value || null, size: bytes.length, content: bytes });
}

/**
 * Decodes an RFC 822 message. Returns `{subject, from, to, date, text, html, attachments, forwarded}` where
 * `attachments` are `{filename, mimeType, disposition, size, content: Uint8Array}`. Forwarded messages
 * (message/rfc822 parts) contribute their bodies and attachments.
 */
export async function parseEml(input) {
  let bytes;
  if (typeof input === 'string') bytes = new TextEncoder().encode(input);
  else if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else bytes = new Uint8Array(await input.arrayBuffer());
  const raw = binaryString(bytes);
  const [head] = splitHead(raw);
  const headers = parseHeaders(head);
  const out = { count: 0, text: [], html: [], attachments: [], forwarded: [] };
  walk(raw, out, 0);
  return {
    subject: decodeWords(header(headers, 'subject')),
    from: decodeWords(header(headers, 'from')),
    to: decodeWords(header(headers, 'to')),
    date: header(headers, 'date'),
    text: out.text.join('\n\n').trim(),
    html: out.html.join('\n'),
    attachments: out.attachments,
    forwarded: out.forwarded,
  };
}

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', euro: '€', pound: '£', yen: '¥',
  cent: '¢', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·',
  bull: '•', rarr: '→', larr: '←', harr: '↔', times: '×', deg: '°', shy: '', zwnj: '', zwj: '', thinsp: ' ', ensp: ' ', emsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', agrave: 'à', egrave: 'è', ograve: 'ò', acirc: 'â', ecirc: 'ê',
  ocirc: 'ô', atilde: 'ã', otilde: 'õ', ntilde: 'ñ', ccedil: 'ç', auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', szlig: 'ß',
  Aacute: 'Á', Eacute: 'É', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Ccedil: 'Ç', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', aring: 'å', oslash: 'ø', aelig: 'æ',
};
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : match;
  });
}

/** Readable text from an HTML document: scripts, styles and comments dropped, blocks on their own lines. */
export function htmlToText(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|header|footer|blockquote|ul|ol|dt|dd)\s*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' \t')
    .replace(/<[^>]*>/g, ' '))
    .replace(/ /g, ' ')
    .split('\n').map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
