/**
 * RFC 822 / MIME parsing for the mail files written by the `emailrx` backend
 * extension. Each file is a raw RFC 822 message; everything here is a pure
 * function over bytes or text so the module is testable without Puter.
 *
 * HTML bodies are flattened to plain text rather than rendered: this app
 * holds the Puter auth token, and mail bodies are attacker-supplied.
 */

import { parseCalendar } from './calendar.js';

const MAX_MULTIPART_DEPTH = 8;

// -- bytes and charsets -------------------------------------------------------

export const base64ToBytes = (b64) => {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

export const decodeBytes = (bytes, charset) => {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
};

// One character per byte, used only to inspect ASCII MIME syntax. A charset
// decoder cannot do this: even a Latin-1 TextDecoder remaps some byte values.
const wireText = (value) => {
  if (typeof value === 'string') return value;
  const chunks = [];
  for (let i = 0; i < value.length; i += 8192) {
    chunks.push(String.fromCharCode(...value.subarray(i, i + 8192)));
  }
  return chunks.join('');
};

// -- filename to subject ------------------------------------------------------

// Mailbox files are named `<uuidv7>--<base64url subject>`, so the list can
// show subjects without reading a single message body.
export const subjectFromFilename = (name) => {
  const sep = name.indexOf('--');
  if (sep === -1) return '';
  try {
    return decodeBytes(base64ToBytes(name.slice(sep + 2)));
  } catch {
    return '';
  }
};

// -- RFC 2047 encoded words (=?utf-8?B?...?=) ---------------------------------

// The bytes a quoted-printable run stands for.
const quotedPrintableBytes = (text) => {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '=' && /^[0-9a-f]{2}$/i.test(text.substr(i + 1, 2))) {
      bytes.push(parseInt(text.substr(i + 1, 2), 16));
      i += 2;
    } else {
      // A raw non-ASCII byte here is already mis-decoded upstream; the
      // charCode is the best remaining guess.
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return bytes;
};

export const decodeQuotedPrintable = (text, charset) =>
  decodeBytes(Uint8Array.from(quotedPrintableBytes(text)), charset);

const ENCODED_WORD = /=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g;

export const decodeWords = (value) => {
  if (!value.includes('=?')) return value;
  // Whitespace *between* two encoded words is separator, not content.
  const joined = value.replace(/\?=\s+=\?/g, '?==?');
  // Adjacent words in one charset are decoded as one run of bytes: a sender
  // that splits a multi-byte character across two words is read as that
  // character, not as two replacement characters.
  let out = '';
  let at = 0;
  let run = null;
  const flush = () => {
    if (run) out += decodeBytes(Uint8Array.from(run.bytes), run.charset);
    run = null;
  };
  for (const match of joined.matchAll(ENCODED_WORD)) {
    const [whole, label, encoding, text] = match;
    // RFC 2231 section 5 lets a word name its language: `charset*language`.
    const charset = label.split('*')[0];
    let bytes = null;
    try {
      bytes = encoding.toUpperCase() === 'B'
        ? [...base64ToBytes(text)]
        : quotedPrintableBytes(text.replace(/_/g, ' '));
    } catch {
      bytes = null;
    }
    if (match.index > at || !bytes || (run && run.charset.toLowerCase() !== charset.toLowerCase())) flush();
    out += joined.slice(at, match.index);
    if (!bytes) out += whole;
    // A loop, not push(...bytes): one hostile word can be megabytes long.
    else if (run) for (const byte of bytes) run.bytes.push(byte);
    else run = { charset, bytes };
    at = match.index + whole.length;
  }
  flush();
  return out + joined.slice(at);
};

// -- RFC 822 structure --------------------------------------------------------

/**
 * The header block and the body, either side of the first blank line.
 * `complete` says that line was found: without it the whole input was
 * headers, which for a range read of a message means the head was longer
 * than the range and the headers after the cut are missing, not absent.
 */
export const splitMessage = (raw) => {
  let headEnd = raw.length;
  let bodyStart = raw.length;
  let complete = false;
  if (typeof raw === 'string') {
    const separator = /^\r?\n/.exec(raw) || /\r?\n\r?\n/.exec(raw);
    if (separator) {
      headEnd = separator.index;
      bodyStart = headEnd + separator[0].length;
      complete = true;
    }
  } else {
    // Inspect only the header bytes. Converting the whole wire message to a
    // string here copied every attachment, once per MIME traversal.
    for (let lf = raw.indexOf(10); lf !== -1; lf = raw.indexOf(10, lf + 1)) {
      const next = raw[lf + 1] === 13 ? lf + 2 : lf + 1;
      if (lf === 0 || (lf === 1 && raw[0] === 13) || raw[next] === 10) {
        const leading = lf === 0 || (lf === 1 && raw[0] === 13);
        headEnd = leading ? 0 : raw[lf - 1] === 13 ? lf - 1 : lf;
        bodyStart = leading ? lf + 1 : next + 1;
        complete = true;
        break;
      }
    }
  }
  const head = typeof raw === 'string' ? raw.slice(0, headEnd) : raw.subarray(0, headEnd);
  return {
    head: typeof head === 'string' ? head : decodeBytes(head),
    body: typeof raw === 'string' ? raw.slice(bodyStart) : raw.subarray(bodyStart),
    complete,
  };
};

export const parseHeaders = (head) => {
  const headers = new Map();
  // Unfold continuation lines before splitting on newlines.
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(colon + 1).trim());
  }
  return headers;
};

export const parseContentType = (value = '') => {
  const pieces = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted && ch === '\\') {
      i++; // An escaped quote cannot end the quoted parameter.
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ';' && !quoted) {
      pieces.push(value.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(value.slice(start));
  const [type, ...params] = pieces;
  const attrs = {};
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    const raw = param.slice(eq + 1).trim();
    attrs[param.slice(0, eq).trim().toLowerCase()] =
      raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replace(/\\([\s\S])/g, '$1')
        : raw;
  }
  return { type: type.trim().toLowerCase(), attrs };
};

/**
 * An RFC 5322 comment -- `(like this)`, nested or not -- taken out of a
 * single address, leaving a quoted name alone. `jane@x.co (Jane Doe)` is the
 * old way of writing a display name and still arrives from cron jobs and
 * older mailers; read without this it was an address with a space and two
 * brackets in it, which is not one. That non-address then keyed the avatar,
 * the image consent, and the address book, where choosing it made a chip the
 * dialog rightly refused to send to.
 */
const stripComments = (text) => {
  let out = '';
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) out += text[++i];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (depth) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === '"') quoted = true;
    out += ch;
  }
  return out;
};

// "Jane Doe <jane@example.com>" -> { name: 'Jane Doe', email: 'jane@example.com' }
export const parseAddress = (value = '') => {
  // The structure -- comments, the angle-address -- is read off the header as
  // it was sent, and only the display name is decoded. Decoded first, an
  // encoded word could open a comment around the real address, or supply an
  // address of its own, and this app would show a sender that no other
  // parser of the same header -- the receiving server's included -- sees.
  const raw = stripComments(String(value ?? '')).replace(/\s+/g, ' ').trim();
  // Text after the angle-address is neither name nor address.
  const match = raw.match(/^(.*?)\s*<([^<>]+)>[^<>]*$/);
  if (match) {
    const name = decodeWords(match[1].replace(/^"(.*)"$/, '$1')).trim();
    const email = match[2].trim();
    return { name: name || email, email };
  }
  // A bare address is only an address as written, never as decoded.
  const decoded = decodeWords(raw);
  return { name: decoded, email: decoded === raw && raw.includes('@') ? raw : '' };
};

/**
 * Split an address header into its addresses. A header can hold many, and a
 * comma inside a quoted display name ("Doe, Jane" <j@x.co>) is not a
 * separator -- neither is one inside an angle-address or an RFC 5322 comment.
 * The split happens on the raw value and each piece is decoded afterwards,
 * because a decoded encoded-word can itself contain a comma.
 */
export const parseAddressList = (value = '') => {
  const pieces = [];
  let current = '';
  let quoted = false;
  let angled = false;
  let comment = 0;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      // A quoted display name may hold anything, escapes included.
      if (ch === '\\' && i + 1 < value.length) current += ch + value[++i];
      else {
        current += ch;
        if (ch === '"') quoted = false;
      }
      continue;
    }
    // Comment text is dropped rather than kept: it is not part of the name
    // and it would otherwise land in the address.
    if (comment) {
      if (ch === '(') comment++;
      else if (ch === ')') comment--;
      continue;
    }
    if (ch === '(') {
      comment++;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '<') angled = true;
    else if (ch === '>') angled = false;
    // A group ("Team: a@x.co, b@y.co;") has no separate meaning here -- its
    // members are the addresses -- so ';' separates just as ',' does.
    else if ((ch === ',' || ch === ';') && !angled) {
      pieces.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  pieces.push(current);

  return pieces
    .map((piece) => piece.trim())
    .filter(Boolean)
    // Drop a leading group label, which is not an address of its own. A group
    // with nobody in it -- `undisclosed-recipients:;`, which is how a message
    // sent to a hidden list names its recipients -- is kept as its label, and
    // read without the colon that introduced the empty list after it.
    .map((piece) => parseAddress(piece
      .replace(/^[^:<"]*:(?=[^:]*@)/, '')
      .replace(/^([^:<"@]+):$/, '$1')
      .trim()))
    .filter((address) => address.name || address.email);
};

// -- bodies -------------------------------------------------------------------

export const decodeBody = (body, headers) => {
  const { attrs } = parseContentType(headers.get('content-type'));
  const encoding = (headers.get('content-transfer-encoding') || '').toLowerCase();
  if (encoding === 'base64') {
    try {
      return decodeBytes(base64ToBytes(wireText(body).replace(/\s+/g, '')), attrs.charset);
    } catch {
      return typeof body === 'string' ? body : decodeBytes(body, attrs.charset);
    }
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(wireText(body).replace(/=\r?\n/g, ''), attrs.charset);
  }
  return typeof body === 'string' ? body : decodeBytes(body, attrs.charset);
};

/**
 * RFC 3676 `format=flowed`, read the way it was meant to be read. Thunderbird
 * and Apple Mail wrap plain text at 72 columns before sending, and mark each
 * line they broke with a trailing space: a line that ends in a space runs on
 * into the next line of the same quote depth. Shown as sent, every paragraph
 * arrived as a ladder of 72-column lines, and in a pane narrower than that
 * each of them broke again into one long line and one short one -- the
 * ragged right edge every client that ignores the format is known for.
 *
 * Quote marks (`>` runs) are read off the front of each line and put back on
 * the paragraph; a space stuffed in front of a line to protect it is taken
 * off; the signature separator `-- ` is fixed by definition. With `delsp`,
 * the space that marks a break was added by the sender and goes with it.
 */
export const unflow = (text, delsp = false) => {
  const out = [];
  let paragraph = null;
  const quoted = (depth, content) => (content ? `${'> '.repeat(depth)}${content}` : '>'.repeat(depth));
  const flush = () => {
    // A paragraph still flowing when it is ended -- by a change of quote
    // depth, or the end of the text -- carries a break marker that now
    // marks nothing.
    if (paragraph) out.push(quoted(paragraph.depth, paragraph.open ? paragraph.text.replace(/ $/, '') : paragraph.text));
    paragraph = null;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw;
    let depth = 0;
    while (line.startsWith('>')) {
      depth++;
      line = line.slice(1);
    }
    if (line.startsWith(' ')) line = line.slice(1);
    const flowed = line !== '-- ' && line.endsWith(' ');
    const content = flowed && delsp ? line.slice(0, -1) : line;
    if (paragraph && paragraph.depth === depth) paragraph.text += content;
    else {
      flush();
      paragraph = { depth, text: content };
    }
    paragraph.open = flowed;
    if (!flowed) flush();
  }
  flush();
  return out.join('\n');
};

// Elements that end a line when HTML is flattened. Without them a whole
// newsletter arrives as one paragraph, and the URLs kept below would smear
// into the sentences around them.
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);

// A row or a list item starts a line without also leaving a blank one after
// it: a five-item list is a list, not five paragraphs.
const LINE_TAGS = new Set(['dd', 'dt', 'figcaption', 'li', 'td', 'th', 'tr']);

const SKIP_TAGS = new Set(['head', 'noscript', 'script', 'style', 'template', 'title']);

// A link this app will keep the target of. Anything else was going nowhere
// useful anyway.
const KEPT_HREF = /^\s*(https?:\/\/|mailto:)/i;

const strip = (value) => value
  .replace(/^https?:\/\//i, '')
  .replace(/^mailto:/i, '')
  .replace(/\/$/, '')
  .trim()
  .toLowerCase();

/**
 * Whether a link's text already says where it goes, in which case repeating
 * the URL after it would just be noise.
 *
 * Exported because the same question comes up in both directions: flattening
 * an incoming HTML body to text, and building the text/plain part of an
 * outgoing one (richtext.js). A link should not turn into
 * `example.com <https://example.com>` either way round.
 */
export const showsTarget = (label, href) => {
  const target = strip(href);
  const text = strip(label);
  return !text || !target || text === target || text.includes(target);
};

/**
 * Flatten HTML to text without losing the links. `textContent` alone dropped
 * every href, so an HTML mail whose only call to action was a button reading
 * "Verify your email" became a dead end: no way to follow it, copy it, or even
 * see where it pointed. Where the text of a link is not the URL itself, the
 * URL is kept beside it in angle brackets.
 */
// Spaces and tabs off the end of every line, walked back rather than matched:
// `/[ \t]+\n/g` is quadratic on a run of spaces that no line break follows,
// and 16,000 of them inside a <pre> took seconds to flatten.
const trimLineEnds = (text) => text.split('\n').map((line) => {
  let end = line.length;
  while (end && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return end === line.length ? line : line.slice(0, end);
}).join('\n');

const htmlToText = (html) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const parts = [];

  // Whether the next thing written would start a line, so the collapsed
  // whitespace at the front of a text node can be dropped there. Source
  // indentation is not content: without this, every mail whose HTML was
  // written by a human arrived with a stray space in front of each of its
  // lines.
  const atLineStart = () => {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i]) return parts[i].endsWith('\n');
    }
    return true;
  };

  const walk = (node, preformatted = false) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const raw = child.nodeValue ?? '';
        if (preformatted) {
          if (raw) parts.push(raw);
          continue;
        }
        // HTML collapses a run of whitespace to one space when it renders, so
        // flattening it has to as well -- otherwise the line breaks of the
        // markup become line breaks of the message, mid-sentence.
        const text = raw.replace(/\s+/g, ' ');
        // Nothing empty is ever pushed, which keeps atLineStart() a one-step
        // look back rather than a walk over every blank node before it -- a
        // body full of whitespace-only nodes is cheap to craft.
        const emit = atLineStart() ? text.replace(/^ /, '') : text;
        if (emit) parts.push(emit);
        continue;
      }
      if (child.nodeType !== 1) continue;

      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === 'br') {
        parts.push('\n');
        continue;
      }

      const block = BLOCK_TAGS.has(tag);
      if (block || LINE_TAGS.has(tag)) parts.push('\n');

      // A `pre` block means its whitespace: that is the whole point of it.
      const keepSpace = preformatted || tag === 'pre';
      if (tag === 'a') {
        const href = child.getAttribute('href') ?? '';
        const label = child.textContent ?? '';
        walk(child, keepSpace);
        if (KEPT_HREF.test(href) && !showsTarget(label, href)) parts.push(` <${href.trim()}>`);
      } else {
        walk(child, keepSpace);
      }

      if (block) parts.push('\n');
    }
  };

  walk(doc.body ?? doc);
  return trimLineEnds(parts.join(''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

// Split a multipart body into its parts, each with its own parsed headers.
// The line break preceding a boundary belongs to the delimiter (RFC 2046),
// so it is stripped from the part body.
function* delimiters(body, boundary) {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const delimiter = new RegExp(`^--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, 'gm');
  if (typeof body === 'string') {
    for (const match of body.matchAll(delimiter)) {
      yield { index: match.index, end: match.index + match[0].length, closing: Boolean(match[1]) };
    }
    return;
  }
  const marker = `--${boundary}`;
  for (let i = body.indexOf(45); i !== -1; i = body.indexOf(45, i + 1)) {
    if (i && body[i - 1] !== 10 && body[i - 1] !== 13) continue;
    let j = 0;
    while (j < marker.length && body[i + j] === marker.charCodeAt(j)) j++;
    if (j !== marker.length) continue;
    let end = i + j;
    const closing = body[end] === 45 && body[end + 1] === 45;
    if (closing) end += 2;
    while (body[end] === 32 || body[end] === 9) end++;
    if (end < body.length) {
      if (body[end] === 13) end++;
      if (body[end] !== 10) continue;
      end++;
    }
    yield { index: i, end, closing };
    i = end - 1;
  }
}

const splitParts = (body, boundary) => {
  const parts = [];
  let start = null;
  const append = (end, complete) => {
    const raw = typeof body === 'string' ? body.slice(start, end) : body.subarray(start, end);
    const { head, body: partBody } = splitMessage(raw);
    parts.push({ headers: parseHeaders(head), body: partBody, complete });
  };
  const codeAt = (i) => typeof body === 'string' ? body.charCodeAt(i) : body[i];
  for (const match of delimiters(body, boundary)) {
    if (start !== null) {
      // Strip only the newline owned by this delimiter, never content at EOF.
      let end = match.index;
      if (codeAt(end - 1) === 10) end--;
      if (codeAt(end - 1) === 13) end--;
      append(Math.max(start, end), true);
    }
    if (match.closing) return parts; // Everything after the closing line is epilogue.
    start = match.end;
  }
  // A damaged file or a range read may end inside its last part.
  if (start !== null) append(body.length, false);
  return parts;
};

const NO_TEXT = { text: '', flattened: false };
const hasText = (part) => part.text.trim() !== '';

// A named file without a disposition is still an attachment. Explicitly
// inline text may be a body, but an attached multipart must be skipped whole.
const isNamed = (headers) => Boolean(
  paramValue(parseContentType(headers.get('content-disposition') || '').attrs, 'filename')
  || paramValue(parseContentType(headers.get('content-type') || '').attrs, 'name'));

const isBodyAttachment = (headers) => {
  const disposition = parseContentType(headers.get('content-disposition') || '');
  const contentType = parseContentType(headers.get('content-type') || '');
  return disposition.type === 'attachment' || (disposition.type !== 'inline'
    && Boolean(paramValue(disposition.attrs, 'filename') || paramValue(contentType.attrs, 'name')));
};

/**
 * Walk the MIME tree for the first text/plain part; fall back to flattened
 * HTML, never to rendered HTML.
 *
 * `flattened` says which of those two happened. Text the sender wrote as text
 * is the message as they meant it to read; text left over from stripping the
 * markup off an HTML part is a rendering of it, and often a poor one, which is
 * the only case where the reader has anything to gain from being told about
 * the HTML.
 *
 * A part that is empty is not the plain text of the message, whatever it says
 * it is: a `text/plain` part carrying nothing is a formality some senders put
 * in front of the HTML they actually wrote, and reading it leaves the reader
 * with a blank message.
 */
export const extractBodyText = (body, headers, depth = 0) => {
  if (isBodyAttachment(headers)) return NO_TEXT;
  const { type, attrs } = parseContentType(headers.get('content-type') || 'text/plain');

  if (type.startsWith('multipart/') && attrs.boundary && depth < MAX_MULTIPART_DEPTH) {
    const parts = splitParts(body, attrs.boundary);
    const decoded = parts.map((part) => extractBodyText(part.body, part.headers, depth + 1));
    // The parts of a mixed are all the message, in order: Apple Mail sends a
    // photo placed mid-message as text, the photo, then the rest of the text.
    // Reading only the first left everything after the photo unseen, and out
    // of the quote in a reply. A part with a file name is a file, even shown
    // inline -- a vCard, a log -- and is listed with the attachments instead.
    if (type === 'multipart/mixed') {
      const pieces = decoded.filter((p, i) => hasText(p) && !p.flattened && !isNamed(parts[i].headers));
      if (pieces.length > 1) return { text: pieces.map((p) => p.text.trimEnd()).join('\n\n'), flattened: false };
    }
    const written = decoded.find((p) => hasText(p) && !p.flattened);
    return written ?? decoded.find(hasText) ?? NO_TEXT;
  }

  const text = decodeBody(body, headers);
  if (type === 'text/html') return { text: htmlToText(text), flattened: true };
  if (type === 'text/calendar' || (type && !type.startsWith('text/'))) return NO_TEXT;
  if (type === 'text/plain' && /^flowed$/i.test(attrs.format || '')) {
    return { text: unflow(text, /^yes$/i.test(attrs.delsp || '')), flattened: false };
  }
  return { text, flattened: false };
};

export const extractText = (body, headers, depth = 0) =>
  extractBodyText(body, headers, depth).text;

/**
 * The `text/html` body of a message, decoded but not sanitized -- that
 * is sanitize.js's job, and it happens on the way into the sandboxed frame.
 * Parts marked as attachments are skipped: an attached .html file is a file,
 * not the body of the message.
 */
export const extractHtml = (body, headers, depth = 0) => {
  if (isBodyAttachment(headers)) return '';
  const { type, attrs } = parseContentType(headers.get('content-type') || 'text/plain');

  if (type.startsWith('multipart/') && attrs.boundary && depth < MAX_MULTIPART_DEPTH) {
    // In a mixed every HTML part is a piece of the body, in order -- a file
    // attached mid-message splits the HTML around it -- so all of them are
    // kept. The HTML parser reads the joined documents as one body.
    const mixed = type === 'multipart/mixed';
    const found = [];
    for (const part of splitParts(body, attrs.boundary)) {
      // After the first, a named part is a file shown inline, not more body.
      if (mixed && found.length && isNamed(part.headers)) continue;
      const html = extractHtml(part.body, part.headers, depth + 1);
      if (html) found.push(html);
      if (html && !mixed) break;
    }
    return found.join('\n');
  }

  return type === 'text/html' ? decodeBody(body, headers) : '';
};

// One part, decoded as far as it goes. Truncation can cut a base64 body
// mid-group or a quoted-printable escape in half, so each is trimmed to what
// decodes cleanly rather than allowed to throw or produce garbage.
const partialText = (body, headers) => {
  const { type, attrs } = parseContentType(headers.get('content-type') || 'text/plain');
  const encoding = (headers.get('content-transfer-encoding') || '').toLowerCase();
  let text;
  if (encoding === 'base64') {
    const b64 = wireText(body).replace(/\s+/g, '');
    text = decodeBytes(base64ToBytes(b64.slice(0, Math.floor(b64.length / 4) * 4)), attrs.charset);
  } else if (encoding === 'quoted-printable') {
    // Drop soft line breaks, then a possibly half-transmitted escape.
    text = decodeQuotedPrintable(wireText(body).replace(/=\r?\n/g, '').replace(/=[0-9a-f]?$/i, ''), attrs.charset);
  } else {
    text = typeof body === 'string' ? body : decodeBytes(body, attrs.charset);
  }

  if (type === 'text/html') return htmlToText(text);
  if (type === 'text/calendar' || (type && !type.startsWith('text/'))) return '';
  return text;
};

// Best-effort preview text from a possibly *truncated* message chunk (the
// list reads only the first few KB of each file). It returns '' rather than
// garbage when there is nothing it can decode.
export const previewText = (body, headers, depth = 0) => {
  try {
    if (isBodyAttachment(headers)) return '';
    const { type, attrs } = parseContentType(headers.get('content-type') || 'text/plain');

    if (type.startsWith('multipart/')) {
      if (!attrs.boundary || depth >= MAX_MULTIPART_DEPTH) return '';
      const parts = splitParts(body, attrs.boundary);
      const complete = parts.filter((part) => part.complete)
        .map((part) => extractBodyText(part.body, part.headers, depth + 1));
      const written = complete.find((part) => hasText(part) && !part.flattened);
      const best = written ?? complete.find(hasText);
      if (best) return best.text;
      for (const part of parts.filter((part) => !part.complete)) {
        const text = previewText(part.body, part.headers, depth + 1);
        if (text) return text;
      }
      return '';
    }

    return partialText(body, headers);
  } catch {
    return '';
  }
};

// -- attachments --------------------------------------------------------------

const asciiBytes = (text) => Uint8Array.from(String(text), (c) => c.charCodeAt(0) & 0xff);

const percentBytes = (text) => {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && /^[0-9a-f]{2}$/i.test(text.substr(i + 1, 2))) {
      bytes.push(parseInt(text.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
};

/**
 * An RFC 2231 parameter value: `charset'language'percent-encoded`, possibly
 * split across numbered segments, of which only the ones marked with a
 * trailing `*` are percent-encoded. The charset travels on the first segment.
 */
const decodeExtendedParam = (segments) => {
  let charset = '';
  const bytes = [];
  segments.forEach((segment, index) => {
    let text = segment.value;
    if (index === 0 && segment.extended) {
      const marks = /^([^']*)'[^']*'([\s\S]*)$/.exec(text);
      if (marks) {
        charset = marks[1];
        text = marks[2];
      }
    }
    bytes.push(...(segment.extended ? percentBytes(text) : asciiBytes(text)));
  });
  return decodeBytes(Uint8Array.from(bytes), charset);
};

/**
 * A header parameter, decoded whichever way the sending client wrote it.
 * RFC 2047 encoded words are what this app's own composer emits; RFC 2231
 * (`filename*`, or `filename*0*`/`filename*1*` continuations) is what Gmail,
 * Apple Mail and Thunderbird send for a name that is not ASCII -- and until it
 * was read here, every such attachment arrived called "attachment".
 */
export const paramValue = (attrs = {}, key) => {
  const segments = [];
  for (let i = 0; ; i++) {
    const extended = attrs[`${key}*${i}*`];
    const plain = attrs[`${key}*${i}`];
    if (extended === undefined && plain === undefined) break;
    segments.push(extended === undefined
      ? { value: plain, extended: false }
      : { value: extended, extended: true });
  }
  if (segments.length) return decodeExtendedParam(segments);
  if (attrs[`${key}*`] !== undefined) {
    return decodeExtendedParam([{ value: attrs[`${key}*`], extended: true }]);
  }
  return decodeWords(attrs[key] ?? '');
};

const qpToBytes = (text) => {
  const bytes = [];
  const stripped = text.replace(/=\r?\n/g, '');
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '=' && /^[0-9a-f]{2}$/i.test(stripped.substr(i + 1, 2))) {
      bytes.push(parseInt(stripped.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
};

// The characters `\s` matches, by code point, so a part can be measured by
// walking it instead of by stripping it.
const isSpaceCode = (code) => code === 0x20 || (code >= 0x09 && code <= 0x0d)
  || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
  || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f
  || code === 0x3000 || code === 0xfeff;

/**
 * How many bytes a base64 part decodes to, counted where it lies.
 *
 * Attachment bytes are decoded lazily, because a message can carry megabytes
 * the reader never downloads -- but the *size* beside the filename was not:
 * it was read off a whitespace-stripped copy of the encoded part, which for
 * an 8 MB attachment meant building 11 MB of UTF-16 string twice over,
 * synchronously, before the message could be drawn. The count is the same;
 * nothing is built to get it.
 */
const base64Size = (body) => {
  const text = typeof body === 'string' ? body : null;
  let characters = 0;
  let padding = 0;
  for (let i = 0; i < body.length; i++) {
    const code = text ? text.charCodeAt(i) : body[i];
    if (isSpaceCode(code)) continue;
    characters++;
    // Only a run of '=' that reaches the end of the value is padding.
    padding = code === 0x3d ? padding + 1 : 0;
  }
  return Math.max(0, Math.floor(characters * 3 / 4) - padding);
};

const partBytes = (body, headers) => {
  const encoding = (headers.get('content-transfer-encoding') || '').toLowerCase();
  if (encoding === 'base64') return base64ToBytes(wireText(body).replace(/\s+/g, ''));
  if (encoding === 'quoted-printable') return qpToBytes(wireText(body));
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
};

/**
 * Parts an HTML body can refer to by `cid:` -- inline images, usually. Keyed
 * by Content-ID with the angle brackets stripped, since that is the form the
 * `cid:` URL uses. Bytes are decoded lazily, like attachments.
 */
export const listInlineParts = (body, headers, depth = 0) => {
  const { type, attrs } = parseContentType(headers.get('content-type') || 'text/plain');
  if (!type.startsWith('multipart/') || !attrs.boundary || depth >= MAX_MULTIPART_DEPTH) return [];

  const found = [];
  for (const part of splitParts(body, attrs.boundary)) {
    const contentType = parseContentType(part.headers.get('content-type') || 'text/plain');
    if (contentType.type.startsWith('multipart/')) {
      found.push(...listInlineParts(part.body, part.headers, depth + 1));
      continue;
    }
    const id = (part.headers.get('content-id') || '').trim().replace(/^<|>$/g, '');
    if (!id) continue;
    found.push({
      cid: id,
      type: contentType.type || 'application/octet-stream',
      bytes: () => partBytes(part.body, part.headers),
    });
  }
  return found;
};

/**
 * The inline parts a message's HTML actually shows: the ids it refers to by
 * `cid:`, without their angle brackets, which is how `listInlineParts` keys
 * them and how the sanitizer looks them up.
 *
 * Exported so a caller that has already extracted the HTML -- the reader,
 * which shows it -- can hand the answer to `listAttachments` rather than
 * have it walk the message a second time to find the same part.
 */
export const referencedCids = (html) => {
  const ids = new Set();
  for (const match of String(html ?? '').matchAll(/cid:([^\s"'<>)]+)/gi)) {
    ids.add(match[1].replace(/^<|>$/g, ''));
  }
  return ids;
};

// A message attached whole is named after its own subject, since that is
// what it is; a slash in a subject is not a directory.
const attachedMessageName = (body) => {
  try {
    const { head } = splitMessage(body);
    const subject = decodeWords(parseHeaders(head).get('subject') || '').trim().replace(/[\\/]/g, '-');
    return `${subject || 'message'}.eml`;
  } catch {
    return 'message.eml';
  }
};

/**
 * Collect attachment parts: anything with a Content-Disposition of
 * `attachment`, or a filename, that is not the message text itself.
 * Returns { filename, type, size, bytes() } with lazy decoding, since a
 * message can carry megabytes that the reader may never download.
 *
 * An inline part the message's HTML refers to by `cid:` is part of the
 * layout and not listed. One it does not refer to is a file like any other
 * -- which is how Apple Mail sends every photo in a plain text message:
 * inline, with a Content-ID that nothing refers to. Taking the Content-ID
 * alone as the sign of an inline image left every one of those photos
 * invisible here, in the text and out of the attachment list.
 *
 * A forwarded message attached whole (`message/rfc822`) is a file whatever
 * its disposition says, and is named after its own subject when the part
 * carries no filename -- which is how Outlook and Apple Mail attach one, and
 * what left it either hidden or downloading as a file called "attachment".
 *
 * `shown` is the set of referenced ids, decided once at the root and carried
 * down the tree. A caller that has the message's HTML already passes
 * `referencedCids(html)` for it, which spares the walk that would find the
 * same part again.
 */
export const listAttachments = (body, headers, depth = 0, shown = null) => {
  const { type, attrs } = parseContentType(headers.get('content-type') || 'text/plain');
  const referenced = shown ?? referencedCids(extractHtml(body, headers));
  if (type.startsWith('multipart/')) {
    if (!attrs.boundary || depth >= MAX_MULTIPART_DEPTH) return [];
    return splitParts(body, attrs.boundary)
      .flatMap((part) => listAttachments(part.body, part.headers, depth + 1, referenced));
  }

  // Apply the same file detection to a root leaf and a multipart child.
  // An attachment-only message does not need a multipart wrapper.
  const disposition = parseContentType(headers.get('content-disposition') || '');
  const filename = paramValue(disposition.attrs, 'filename') || paramValue(attrs, 'name');
  const cid = (headers.get('content-id') || '').trim().replace(/^<|>$/g, '');
  const attachedMessage = type === 'message/rfc822';
  // An unnamed inline image is still an image the reader has no other way
  // to see, once nothing in the message shows it.
  const looseImage = Boolean(cid) && type.startsWith('image/');
  if (!attachedMessage && !looseImage && disposition.type !== 'attachment' && !filename) return [];
  if (disposition.type === 'inline' && cid && referenced.has(cid)) return [];

  const encoding = (headers.get('content-transfer-encoding') || '').toLowerCase();
  return [{
    filename: filename
      || (attachedMessage ? attachedMessageName(body)
        : looseImage ? `image.${type.slice('image/'.length)}`
          : 'attachment'),
    type: type || 'application/octet-stream',
    size: encoding === 'base64' ? base64Size(body) : body.length,
    bytes: () => partBytes(body, headers),
  }];
};

// -- leaving a list -------------------------------------------------------------

/** Inline calendar alternatives and .ics files both describe invitations.
 * Do not inspect forwarded messages or attached multipart messages as invites
 * to the current recipient. Keep the original file for calendar import.
 */
export const listCalendarInvites = (body, headers) => {
  const invites = [];
  const seen = new Set();
  const visit = (partBody, partHeaders, depth) => {
    const { type, attrs } = parseContentType(partHeaders.get('content-type') || '');
    if (type.startsWith('multipart/')) {
      if (!attrs.boundary || depth >= MAX_MULTIPART_DEPTH || isBodyAttachment(partHeaders)) return;
      for (const part of splitParts(partBody, attrs.boundary)) {
        if (part.complete) visit(part.body, part.headers, depth + 1);
      }
      return;
    }
    const disposition = parseContentType(partHeaders.get('content-disposition'));
    const filename = paramValue(disposition.attrs, 'filename') || paramValue(attrs, 'name');
    if (type === 'message/rfc822' || (type !== 'text/calendar' && !/\.ics$/i.test(filename))) return;
    // Bound decoding as well as parsing; unrelated attachments remain lazy.
    if (partBody.length > 2 * 1024 * 1024) return;
    const source = decodeBody(partBody, partHeaders);
    const file = { filename: filename || 'invite.ics', type: 'text/calendar;charset=utf-8',
      bytes: () => new TextEncoder().encode(source) };
    for (const event of parseCalendar(source, attrs.method)) {
      const key = JSON.stringify([event.uid, event.recurrenceId, event.title,
        event.start, event.end, event.cancelled, event.method]);
      if (seen.has(key)) continue;
      seen.add(key);
      invites.push({ ...event, file });
    }
  };
  visit(body, headers, 0);
  return invites;
};

/**
 * The ways out of a mailing list that a message offers, from its
 * `List-Unsubscribe` header (RFC 2369): a comma-separated list of angle-
 * bracketed URLs, each a `mailto:` or an `https:` link. The two are answered
 * separately because they are used differently -- a mailto is a message this
 * app can write, prefilled and shown to the user before it goes; a URL is a
 * page the sender runs, and is only ever opened. Anything that is neither is
 * not a way out this app will offer: a `javascript:` URL in a header is an
 * attack, not a subscription.
 *
 * `{ mailto: { to, subject, body } | null, url: string | null }`
 */
export const parseListUnsubscribe = (value = '') => {
  const out = { mailto: null, url: null };
  for (const match of String(value ?? '').matchAll(/<([^<>]+)>/g)) {
    const link = match[1].trim();
    if (/^mailto:/i.test(link) && !out.mailto) {
      let url;
      try {
        url = new URL(link);
      } catch {
        continue;
      }
      // The address is the URL's path; RFC 6068 percent-encodes it, and it
      // may name more than one recipient.
      let path;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        continue;
      }
      const to = parseAddressList(path).map((address) => address.email).filter((email) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email));
      if (!to.length) continue;
      out.mailto = {
        to: to.join(', '),
        // Headers in the query are what the list expects to see: usually a
        // subject reading "unsubscribe", sometimes a body carrying a token.
        subject: url.searchParams.get('subject') ?? '',
        body: url.searchParams.get('body') ?? '',
      };
    } else if (/^https?:\/\//i.test(link) && !out.url) {
      try {
        out.url = new URL(link).href;
      } catch {
        // Not a URL after all.
      }
    }
  }
  return out;
};
