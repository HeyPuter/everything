/**
 * RFC 5322 / MIME composition for outgoing mail. The `useremailtx` backend
 * extension takes a whole RFC 822 message (POST /email/send) and parses it
 * server-side, so the message is composed here: CRLF line endings, folded
 * headers, RFC 2047 encoded words for a non-ASCII subject, and a base64
 * text/plain body, wrapped in multipart/alternative once the writer has
 * formatted something and in multipart/mixed once there are attachments. Pure
 * functions over strings and bytes, like mime.js.
 */

import { parseAddressList } from './mime.js';
import { formatSize } from './format.js';

// The domains a sender may claim in `From:`. Recipients are unrestricted;
// these only decide what this user is allowed to send *as*.
export const PUTER_DOMAINS = ['puter.email'];

// Bare mailbox addresses only. Header punctuation and control characters must
// never reach the delivery loop as part of an address.
export const ADDRESS_RE = /^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/**
 * Total attachment bytes a message may carry. The whole message is posted as
 * one request body and base64 inflates it by 4/3, so 18 MB of files leave a
 * 24 MB message -- under the 25 MB that mail servers commonly cap at, with
 * room left for the text part and the headers.
 */
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

const CRLF = '\r\n';

// -- RFC 2822 date -------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

export const rfc2822Date = (date) =>
  `${DAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} `
  + `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  + `:${pad(date.getUTCSeconds())} +0000`;

// -- encoding --------------------------------------------------------------------

export const bytesToBase64 = (bytes) => {
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on a
  // body of any real size.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const isAscii = (text) => !/[^\x20-\x7e]/.test(text);

// A header value that isn't plain ASCII becomes one or more RFC 2047 encoded
// words. Each word stays under the 75-char limit, and the split happens on
// code point boundaries so no character is cut in half.
export const encodeWords = (text) => {
  const encoder = new TextEncoder();
  const words = [];
  let chunk = '';
  let bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > 42) {
      words.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${bytesToBase64(encoder.encode(word))}?=`);
};

// Join `parts` into a header, breaking onto continuation lines before the
// line would pass 78 characters. Continuations start with a space, which is
// what makes them continuations.
export const foldHeader = (name, parts, separator) => {
  let line = `${name}:`;
  const lines = [];
  parts.forEach((part, index) => {
    const piece = index < parts.length - 1 ? `${part}${separator.trim()}` : part;
    // A line of nothing but the fold's space is not one to end: RFC 5322
    // does not allow a header line that is only whitespace.
    if (line.length + 1 + piece.length > 78 && line !== `${name}:` && line.trim()) {
      lines.push(line);
      // The space added below is the fold's one whitespace character. A
      // second one here was content to a parser that unfolds the way RFC 5322
      // says, by removing the line break only.
      line = '';
    }
    line += ` ${piece}`;
  });
  lines.push(line);
  return lines.join(CRLF);
};

// -- replying ------------------------------------------------------------------

/**
 * Who a reply goes to, given the original headers and the addresses that are
 * the user's own.
 *
 * `all: false` answers the sender alone. `all: true` answers everyone the
 * message was addressed to, with the user removed and duplicates collapsed --
 * a reply-all that quietly drops two of the three people on a message is
 * worse than having no button, because the user believes they answered the
 * group.
 *
 * The sender is Reply-To when there is one, else From. Replying to your own
 * sent message removes every candidate in that first group, so the answer
 * falls through to the people the message went to rather than mailing
 * yourself.
 */
export const replyRecipients = (headers, own = [], { all = false } = {}) => {
  const mine = new Set(own.filter(Boolean).map((address) => address.toLowerCase()));
  const addresses = (name) => parseAddressList(headers.get?.(name) || '')
    .map((address) => address.email.trim())
    .filter(Boolean);

  const replyTo = addresses('reply-to');
  const groups = [replyTo.length ? replyTo : addresses('from'), addresses('to'), addresses('cc')]
    .map((group) => group.filter((address) => !mine.has(address.toLowerCase())));

  const seen = new Set();
  const fresh = (group) => group.filter((address) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let to = [];
  for (const group of groups) {
    to = fresh(group);
    if (to.length) break;
  }
  return { to, cc: all ? groups.flatMap(fresh) : [] };
};

/**
 * The subject of an answer, and of a forward: the prefix once, however the
 * last client wrote it. `RE:`, `Re[2]:` and `FW:` are the same prefixes as
 * `Re:` and `Fwd:` -- Outlook's spellings, mostly -- and a subject that
 * already carries one is not given a second, or a forward of an Outlook
 * forward went out as "Fwd: FW: ...". Only the prefix asked for is checked:
 * a forward of a reply is "Fwd: Re: ...", which is what every client writes.
 * A message with no subject gets an answer with none, left for the writer to
 * fill in, rather than one addressed to "(no subject)".
 */
const prefixed = (subject, prefix, own) => {
  const text = String(subject ?? '');
  if (!text) return '';
  return own.test(text) ? text : `${prefix} ${text}`;
};

export const replySubject = (subject) => prefixed(subject, 'Re:', /^\s*re(?:\s*[[(]\d+[\])])?\s*:/i);
export const forwardSubject = (subject) => prefixed(subject, 'Fwd:', /^\s*fwd?\s*:/i);

/**
 * The block that goes above a forwarded message. Deliberately not the reply
 * quote format: a forward is not an answer, and the recipient needs to see
 * who the original was from and who it went to.
 */
export const forwardBlock = ({ from, date, subject, to, cc }) => [
  '---------- Forwarded message ----------',
  `From: ${from}`,
  ...(date ? [`Date: ${date}`] : []),
  `Subject: ${subject}`,
  ...(to ? [`To: ${to}`] : []),
  ...(cc ? [`Cc: ${cc}`] : []),
].join('\n');

// -- attachments ------------------------------------------------------------------

/**
 * Characters that are invisible but change what a name reads as. A
 * right-to-left override turns `report\u202Efdp.exe` into `reportexe.pdf` on
 * screen, which is the oldest attachment trick there is; zero-width and
 * bidi-isolate characters hide differences between two names that look
 * identical. None of them belong in a filename, incoming or outgoing.
 */
const INVISIBLE = /[\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * A filename ends up inside a header parameter, so anything that could close
 * the parameter or start a new header has to go first: CR and LF above all,
 * plus the other control characters and the quote that delimits the value.
 * Directory parts are dropped too -- the name is a label, not a path. This is
 * also what the reader displays and downloads an attachment as, so a name that
 * lies about its own extension is defused here rather than at each use.
 */
export const safeFilename = (name = '') => {
  const base = String(name).split(/[\\/]/).pop() || '';
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(INVISIBLE, '')
    .replace(/"/g, "'")
    .trim();
  return cleaned || 'attachment';
};

/**
 * A media type is written into a header parameter list, so it has to be one
 * token and nothing else. A forwarded attachment carries whatever type the
 * incoming message declared, and `application/pdf" name="evil.exe` put a
 * second, *earlier* `name` parameter in front of the real one -- so the person
 * receiving the forward saw a filename the person sending it never did.
 * Anything that is not a plain type/subtype becomes octet-stream.
 */
export const safeMediaType = (type = '') => {
  const token = String(type).trim().split(';')[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(token)
    ? token
    : 'application/octet-stream';
};

// A name parameter for Content-Type/Content-Disposition. A non-ASCII name is
// written twice: as RFC 2047 encoded words, which is what this app's own
// parser reads, and as an RFC 2231 `name*` value, which is what the spec says
// and what other clients prefer. Both decode to the same string.
const nameParams = (key, filename) => {
  const safe = safeFilename(filename);
  if (isAscii(safe)) return [`${key}="${safe}"`];
  return [
    `${key}="${encodeWords(safe).join(' ')}"`,
    // encodeURIComponent leaves ' ( ) * as they are, and RFC 2231 does not
    // allow them unencoded: a strict parser reads "(" as the start of a
    // comment, and "Résumé (final).pdf" arrived as "résumé".
    `${key}*=UTF-8''${encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
  ];
};

// Boundaries must not occur in any part; a uuid contains no base64 character
// and no character the encoders emit, so it cannot collide with a body.
export const makeBoundary = () => `--=_puter_${crypto.randomUUID()}`;

const base64Lines = (bytes) => (bytesToBase64(bytes).match(/.{1,76}/g) ?? []).join(CRLF);

// -- the message -------------------------------------------------------------------

// References can grow with every reply in a long thread; keeping the most
// recent entries is what RFC 5322 allows a client to do, and it stops the
// header growing without bound.
const MAX_REFERENCES = 20;

const referenceList = (references) =>
  (Array.isArray(references) ? references : String(references ?? '').split(/\s+/))
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(-MAX_REFERENCES);

// The two lines that describe a text part, and the part itself: those lines,
// a blank line, then the content. base64 sidesteps every line-length and
// 8-bit question the content could otherwise raise, at the cost of being
// unreadable on the wire.
const textHeaders = (type) => [
  `Content-Type: ${type}; charset=utf-8`,
  'Content-Transfer-Encoding: base64',
];

const encodeText = (content) => base64Lines(new TextEncoder().encode(content));

const textPart = (type, content) =>
  [...textHeaders(type), '', encodeText(content)].join(CRLF);

// The body of a multipart: each section between delimiters, and the closing
// one. The CRLF that precedes a boundary belongs to the delimiter (RFC 2046),
// so it is written here rather than left on the end of a section -- which is
// also what lets a whole multipart be nested inside another as one section.
const multipartBody = (boundary, sections) =>
  sections.map((section) => `--${boundary}${CRLF}${section}${CRLF}`).join('')
  + `--${boundary}--`;

/**
 * The message, as bytes on the wire.
 *
 * `body` is the message as text and is always sent. `html` is the same message
 * as markup and is optional: when it is there the two travel as
 * `multipart/alternative`, text first, because the parts of an alternative are
 * ordered worst-to-best and a client shows the last one it understands. Every
 * recipient gets something they can read -- a terminal client, a screen
 * reader, or a mailing list that strips HTML gets the text part, not a note
 * saying they need a different client.
 *
 * With attachments as well, that alternative becomes the first part of a
 * `multipart/mixed`. Nesting rather than putting the html part beside the
 * attachments matters: a flat mixed part with two bodies in it is a message
 * with two bodies, and clients disagree about which to show.
 */
export const buildMessage = ({
  from, to = [], cc = [], subject, body, html = '', messageId, date,
  attachments = [], boundary = makeBoundary(), altBoundary = makeBoundary(),
  inReplyTo = '', references = [],
}) => {
  // Validate at the serialization boundary too: drafts and reply headers are
  // untrusted, and callers other than the dialog can build messages.
  for (const value of [from, ...to, ...cc, subject, messageId, inReplyTo, ...referenceList(references)]) {
    if (/[\r\n\x00]/.test(String(value ?? ''))) throw new Error('Message headers cannot contain line breaks or null characters.');
  }
  const parts = attachments.filter((a) => a.bytes);

  // The two shapes the message body can take: a text part on its own, or the
  // sections of an alternative holding the text and the markup. Which one it
  // is decides the Content-Type and the assembly below.
  const alternative = html && [textPart('text/plain', body), textPart('text/html', html)];

  const headers = [
    foldHeader('From', [from], ', '),
    // A Cc-only message is allowed, and an address-list header may not be
    // empty: `To:` with nothing after it is a malformed header that some
    // servers reject outright, so it is left out instead.
    ...(to.length ? [foldHeader('To', to, ', ')] : []),
    ...(cc.length ? [foldHeader('Cc', cc, ', ')] : []),
    // An ASCII subject folds between its words. One with a word too long to
    // fold at goes as encoded words, which fold anywhere, like one that is not
    // ASCII. Unfolded, a long subject was one header line of any length, past
    // the 998 characters RFC 5322 allows.
    foldHeader('Subject', isAscii(subject) && !/[^ ]{900}/.test(subject) ? subject.split(' ') : encodeWords(subject), ' '),
    `Date: ${rfc2822Date(date)}`,
    `Message-ID: ${messageId}`,
    // What makes a reply hold together as a conversation in Gmail, Apple
    // Mail, and everything else the recipient might be using.
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(referenceList(references).length
      ? [foldHeader('References', referenceList(references), ' ')]
      : []),
    'MIME-Version: 1.0',
    ...(parts.length
      ? [`Content-Type: multipart/mixed; boundary="${boundary}"`]
      : alternative
        ? [`Content-Type: multipart/alternative; boundary="${altBoundary}"`]
        : textHeaders('text/plain')),
  ];

  const head = `${headers.join(CRLF)}${CRLF}${CRLF}`;

  // One text body and nothing else -- the shape every message from this app
  // had before there was an editor. The headers above already say text/plain
  // and base64, so the encoded body follows them directly.
  if (!parts.length && !alternative) return `${head}${encodeText(body)}${CRLF}`;

  if (!parts.length) return `${head}${multipartBody(altBoundary, alternative)}${CRLF}`;

  // With attachments, the body becomes the first section of the mixed part:
  // the alternative headed by its own Content-Type, or the text part as it is.
  const bodySection = alternative
    ? [
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      multipartBody(altBoundary, alternative),
    ].join(CRLF)
    : textPart('text/plain', body);

  return head + multipartBody(boundary, [
    bodySection,
    ...parts.map((attachment) => [
      foldHeader('Content-Type',
        [safeMediaType(attachment.type), ...nameParams('name', attachment.filename)], '; '),
      foldHeader('Content-Disposition',
        ['attachment', ...nameParams('filename', attachment.filename)], '; '),
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(attachment.bytes),
    ].join(CRLF)),
  ]) + CRLF;
};

// -- draft validation ----------------------------------------------------------------

/**
 * The recipients in a To or Cc field.
 *
 * A recipient is very often pasted in the form every mail client shows it --
 * `Jane Doe <jane@example.com>`, the name sometimes quoted, sometimes with a
 * comma inside it -- and splitting the field on commas turned that into two
 * things, neither of which is an address, so the send was refused for a
 * recipient that was perfectly well spelled. The field is read with the same
 * address-list parser the incoming headers get, and each entry becomes the
 * address it names: that is what the message is addressed to. Anything that
 * names no address at all is passed through as typed, so the dialog can say
 * which part of the field it could not read.
 */
export const parseAddresses = (value) =>
  [...new Map(parseAddressList(value).map((address) => {
    const email = address.email || address.name;
    return [email.toLowerCase(), email];
  })).values()];

/** A conservative English reminder, considering only the newly written text. */
export const mentionsAttachment = (body = '') => {
  const own = String(body).split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n').split(/(?:^|\n)(?:-- ?\n|---------- Forwarded message ----------)/)[0];
  return /\b(?:see|find|please\s+see|please\s+find)\s+(?:the\s+)?attach(?:ed|ment)\b|\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+attached\b|\battached\s+(?:is|are|the|a|my|our)\b/i.test(own);
};

// The one place a draft is judged. Returns { field, message } so the dialog
// can put the message on the control that has to change, or null when the
// draft is sendable.
const firstProblem = ({ to, cc, subject, attachments = [] }) => {
  if (to.length === 0 && cc.length === 0) {
    return { field: 'to', message: 'Add at least one recipient.' };
  }
  // The server validates too, but inside its delivery loop: a bad address
  // partway down the list throws only after the addresses above it have
  // already been delivered. Validate the full list before posting; transport
  // failures can still cause partial delivery on the server.
  for (const [field, addresses] of [['to', to], ['cc', cc]]) {
    for (const address of addresses) {
      if (!ADDRESS_RE.test(address)) {
        return { field, message: `${address} is not an email address.` };
      }
    }
  }
  if (!subject.trim()) return { field: 'subject', message: 'Add a subject.' };
  // Attachments are judged here rather than at send time so a 25 MB photo is
  // reported in the dialog, next to the file it is about, instead of arriving
  // as a rejected POST after a long upload.
  const unreadable = attachments.find((a) => a.error);
  if (unreadable) {
    return {
      field: 'attachments',
      message: typeof unreadable.error === 'string'
        ? `${safeFilename(unreadable.filename)}: ${unreadable.error}. Remove it to continue.`
        : `${safeFilename(unreadable.filename)} could not be read. Remove it and try again.`,
    };
  }
  const pending = attachments.find((a) => !a.bytes);
  if (pending) {
    return { field: 'attachments', message: 'Wait for the attachments to finish loading.' };
  }
  const total = attachments.reduce((sum, a) => sum + a.bytes.length, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    return {
      field: 'attachments',
      message: `Attachments are ${formatSize(total)}. The limit is ${formatSize(MAX_ATTACHMENT_BYTES)}.`,
    };
  }
  return null;
};

/** Returns an error string, or null when the draft is sendable. */
export const draftProblem = (draft) => firstProblem(draft)?.message ?? null;

/** Which field it belongs to: 'to' | 'cc' | 'subject' | 'attachments', or null. */
export const draftProblemField = (draft) => firstProblem(draft)?.field ?? null;

// -- the signature -------------------------------------------------------------------

/**
 * The signature as it goes into a message: on its own lines, under the
 * standard `-- ` separator (RFC 3676), which is what lets a receiving client
 * tell where the message ends and the signature begins -- Thunderbird greys it
 * out, mutt and others trim it from a quote. An empty signature is no block
 * at all.
 */
export const signatureBlock = (signature = '') => {
  const text = String(signature ?? '').replace(/\r\n?/g, '\n').trim();
  return text ? `\n\n-- \n${text}` : '';
};

/**
 * A body with the signature in it, where a mail client puts one: at the end of
 * a new message, and between the writer's text and the quoted copy of the
 * message they are answering. A reply and a forward both arrive here as a
 * quoted block with two empty lines in front of it for the writer to type in,
 * so the signature slots in ahead of the quote and the caret still lands
 * above it. A draft is never passed through this: its signature, if it has
 * one, is already part of the text that was saved.
 */
export const withSignature = (body = '', signature = '') => {
  const block = signatureBlock(signature);
  if (!block) return body ?? '';
  const text = String(body ?? '');
  if (!text.trim()) return block;
  return `${block}${text.startsWith('\n') ? '' : '\n'}${text}`;
};

/**
 * Whether a body holds nothing but the signature it was started with. A new
 * message opens with the signature already in it, and a dialog that is then
 * closed untouched has written nothing -- so it must not leave a draft behind
 * that says only who the writer is. Compared with the trailing spaces off,
 * because a draft saved before the editor kept the separator's space holds
 * `--` where a fresh one holds `-- `.
 */
export const isSignatureOnly = (body = '', signature = '') => {
  const block = signatureBlock(signature);
  if (!block) return false;
  // Line by line and walked back: `/[ \t]+\n/g` is quadratic on a long run
  // of spaces with no line break after it.
  const squash = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => {
    let end = line.length;
    while (end && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
    return line.slice(0, end);
  }).join('\n').trim();
  return squash(body) === squash(block);
};
