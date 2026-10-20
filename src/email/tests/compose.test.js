import { describe, it, expect } from 'vitest';
import {
  buildMessage, encodeWords, foldHeader, parseAddresses, draftProblem,
  draftProblemField, rfc2822Date, bytesToBase64, safeFilename,
  replyRecipients, replySubject, forwardSubject, forwardBlock, MAX_ATTACHMENT_BYTES, PUTER_DOMAINS,
} from '../src/lib/compose.js';
import {
  splitMessage, parseHeaders, parseAddress, decodeWords, extractText,
  extractHtml, listAttachments,
} from '../src/lib/mime.js';

const headersOf = (lines) => parseHeaders(lines.join('\r\n'));
const ME = ['me@puter.email', 'me@puterstaging.email'];

const CRLF = '\r\n';

const build = (over = {}) => buildMessage({
  from: 'alice@puter.email',
  to: ['bob@example.com'],
  cc: [],
  subject: 'Hello',
  body: 'Hi Bob,\n\nJust checking in.\n',
  messageId: '<test-id@puter.email>',
  date: new Date(Date.UTC(2026, 7, 22, 9, 30, 5)),
  ...over,
});

// Parse a built message with the same code the app reads mail with, so
// composition and parsing are held to a single standard.
const roundTrip = (message) => {
  const { head, body } = splitMessage(message);
  const headers = parseHeaders(head);
  return {
    headers,
    text: extractText(body, headers),
    html: extractHtml(body, headers),
    attachments: listAttachments(body, headers),
  };
};

const bytesOf = (text) => new TextEncoder().encode(text);

describe('buildMessage', () => {
  it('round-trips headers and body through the app parser', () => {
    const { headers, text } = roundTrip(build());
    expect(parseAddress(headers.get('from'))).toEqual({ name: 'alice@puter.email', email: 'alice@puter.email' });
    expect(headers.get('to')).toBe('bob@example.com');
    expect(headers.get('subject')).toBe('Hello');
    expect(headers.get('message-id')).toBe('<test-id@puter.email>');
    expect(headers.get('mime-version')).toBe('1.0');
    expect(text).toBe('Hi Bob,\n\nJust checking in.\n');
  });

  it('uses CRLF for every line ending and ends with one', () => {
    const message = build();
    expect(message.endsWith(CRLF)).toBe(true);
    expect(message.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('round-trips a non-ASCII body, including emoji', () => {
    const body = 'Überweisung bestätigt — 領収書を添付します 🎉';
    expect(roundTrip(build({ body })).text).toBe(body);
  });

  it('encodes a non-ASCII subject as RFC 2047 words that decode back', () => {
    const subject = 'Réservation confirmée — 会議の議事録 🚀';
    const { headers } = roundTrip(build({ subject }));
    expect(headers.get('subject')).toContain('=?UTF-8?B?');
    expect(decodeWords(headers.get('subject'))).toBe(subject);
  });

  it('folds a many-recipient To header without losing addresses', () => {
    const to = Array.from({ length: 12 }, (unused, i) => `recipient-${i}@example.com`);
    const message = build({ to });
    expect(message.split(CRLF).every((line) => line.length <= 78)).toBe(true);
    const { headers } = roundTrip(message);
    for (const address of to) expect(headers.get('to')).toContain(address);
  });

  it('includes Cc only when there are cc recipients', () => {
    expect(roundTrip(build()).headers.has('cc')).toBe(false);
    const { headers } = roundTrip(build({ cc: ['carol@example.com'] }));
    expect(headers.get('cc')).toBe('carol@example.com');
  });

  it('leaves out an empty To rather than writing a malformed header', () => {
    const message = build({ to: [], cc: ['carol@example.com'] });
    expect(message).not.toMatch(/^To:/m);
    expect(roundTrip(message).headers.get('cc')).toBe('carol@example.com');
  });

  it('wraps the base64 body at 76 characters', () => {
    const message = build({ body: 'x'.repeat(10_000) });
    const { body } = splitMessage(message);
    expect(body.split(CRLF).filter(Boolean).every((line) => line.length <= 76)).toBe(true);
    expect(roundTrip(message).text).toBe('x'.repeat(10_000));
  });

  it('writes an RFC 2822 date in UTC', () => {
    const { headers } = roundTrip(build());
    expect(headers.get('date')).toBe('Sat, 22 Aug 2026 09:30:05 +0000');
    expect(new Date(headers.get('date')).toISOString()).toBe('2026-08-22T09:30:05.000Z');
  });
});

describe('rfc2822Date', () => {
  it('zero-pads time fields', () => {
    expect(rfc2822Date(new Date(Date.UTC(2026, 0, 5, 1, 2, 3)))).toBe('Mon, 5 Jan 2026 01:02:03 +0000');
  });
});

describe('encodeWords', () => {
  it('keeps every encoded word within the 75-char RFC 2047 limit', () => {
    const words = encodeWords('日本語のとても長い件名です。'.repeat(10));
    expect(words.length).toBeGreaterThan(1);
    expect(words.every((word) => word.length <= 75)).toBe(true);
  });

  it('splits on code point boundaries so no character is cut in half', () => {
    const text = '🎉'.repeat(40); // 4 bytes each; 42-byte chunks would split pairs mid-char
    expect(decodeWords(encodeWords(text).join(' '))).toBe(text);
  });
});

describe('foldHeader', () => {
  it('keeps a short header on one line', () => {
    expect(foldHeader('To', ['a@b.co', 'c@d.co'], ', ')).toBe('To: a@b.co, c@d.co');
  });

  it('starts continuation lines with a space', () => {
    const folded = foldHeader('To', Array.from({ length: 12 }, (unused, i) => `recipient-${i}@example.com`), ', ');
    const lines = folded.split(CRLF);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((line) => line.startsWith(' '))).toBe(true);
  });
});

describe('bytesToBase64', () => {
  it('handles input past the fromCharCode chunk size', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7).fill(65);
    expect(atob(bytesToBase64(bytes)).length).toBe(bytes.length);
  });
});

describe('parseAddresses', () => {
  it('splits on commas and semicolons, trimming and dropping empties', () => {
    expect(parseAddresses(' a@b.co, c@d.co ;; e@f.co,')).toEqual(['a@b.co', 'c@d.co', 'e@f.co']);
    expect(parseAddresses('')).toEqual([]);
  });

  it('reads a recipient pasted in the form every mail client shows', () => {
    expect(parseAddresses('Jane Doe <jane@example.com>')).toEqual(['jane@example.com']);
    expect(parseAddresses('"Doe, Jane" <jane@example.com>, leo@example.com'))
      .toEqual(['jane@example.com', 'leo@example.com']);
    expect(parseAddresses('<jane@example.com>')).toEqual(['jane@example.com']);
    expect(parseAddresses('mailto:jane@example.com')).toEqual(['jane@example.com']);
  });

  it('passes something that names no address through as typed', () => {
    // So the dialog can name the part of the field it could not read.
    expect(parseAddresses('jane, leo@example.com')).toEqual(['jane', 'leo@example.com']);
  });
});

describe('draftProblem', () => {
  const valid = { to: ['a@b.co'], cc: [], subject: 'Hi' };

  it('accepts a valid draft', () => {
    expect(draftProblem(valid)).toBeNull();
  });

  it('requires at least one recipient, in To or Cc', () => {
    expect(draftProblem({ ...valid, to: [] })).toBe('Add at least one recipient.');
    expect(draftProblem({ ...valid, to: [], cc: ['c@d.co'] })).toBeNull();
  });

  it('names the first malformed address, wherever it is', () => {
    expect(draftProblem({ ...valid, to: ['not-an-address'] })).toBe('not-an-address is not an email address.');
    expect(draftProblem({ ...valid, cc: ['x@nodot'] })).toBe('x@nodot is not an email address.');
  });

  it('requires a subject', () => {
    expect(draftProblem({ ...valid, subject: '  ' })).toBe('Add a subject.');
  });
});

describe('draftProblemField', () => {
  const valid = { to: ['a@b.co'], cc: [], subject: 'Hi' };

  it('is null for a sendable draft', () => {
    expect(draftProblemField(valid)).toBeNull();
  });

  it('blames To for a missing recipient', () => {
    expect(draftProblemField({ ...valid, to: [] })).toBe('to');
  });

  it('blames the field the malformed address is in', () => {
    expect(draftProblemField({ ...valid, to: ['nope'] })).toBe('to');
    expect(draftProblemField({ ...valid, cc: ['x@nodot'] })).toBe('cc');
  });

  it('blames To when both lists are malformed, matching the reported address', () => {
    const draft = { ...valid, to: ['bad-to'], cc: ['bad-cc'] };
    expect(draftProblemField(draft)).toBe('to');
    expect(draftProblem(draft)).toBe('bad-to is not an email address.');
  });

  it('blames Subject last', () => {
    expect(draftProblemField({ ...valid, subject: '  ' })).toBe('subject');
  });
});

describe('PUTER_DOMAINS', () => {
  it('lists the domains offered in the composer From field', () => {
    expect(PUTER_DOMAINS).toEqual(['puter.email']);
  });
});

describe('buildMessage with a formatted body', () => {
  const HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
    + '<body><div>Hi <b>Bob</b>,</div></body></html>';

  it('sends nothing but text/plain when there is no markup', () => {
    const { headers, html } = roundTrip(build({ html: '' }));
    expect(headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(html).toBe('');
  });

  it('becomes a multipart/alternative once there is', () => {
    const { headers } = roundTrip(build({ html: HTML }));
    expect(headers.get('content-type')).toMatch(/^multipart\/alternative; boundary="/);
  });

  it('recovers both parts through the app parser', () => {
    const { text, html } = roundTrip(build({ body: 'Hi Bob,', html: HTML }));
    expect(text).toBe('Hi Bob,');
    expect(html).toBe(HTML);
  });

  it('puts the text part first, which is what makes the html the one shown', () => {
    // The parts of an alternative run worst to best, and a client shows the
    // last one it understands.
    const message = build({ html: HTML });
    const { body } = splitMessage(message);
    expect(body.indexOf('text/plain')).toBeLessThan(body.indexOf('text/html'));
  });

  it('round-trips a non-ASCII html part, including emoji', () => {
    const html = `<!DOCTYPE html><html><body><div>Bestätigt — 領収書 🎉</div></body></html>`;
    expect(roundTrip(build({ html })).html).toBe(html);
  });

  it('wraps the html part at 76 characters like every other part', () => {
    const html = `<div>${'x'.repeat(4000)}</div>`;
    const { body } = splitMessage(build({ html }));
    expect(body.split(CRLF).every((line) => line.length <= 78)).toBe(true);
  });

  it('nests the alternative inside the mixed part when there are attachments', () => {
    const message = build({
      html: HTML,
      attachments: [{ filename: 'a.csv', type: 'text/csv', bytes: bytesOf('a,b\n') }],
    });
    const { headers, text, html, attachments } = roundTrip(message);

    expect(headers.get('content-type')).toMatch(/^multipart\/mixed; boundary="/);
    // Both bodies and the file, all recovered: a flat mixed part with two
    // bodies in it would be a message with two bodies.
    expect(text).toBe('Hi Bob,\n\nJust checking in.\n');
    expect(html).toBe(HTML);
    expect(attachments.map((a) => a.filename)).toEqual(['a.csv']);
  });

  it('uses a different boundary for the alternative than for the mixed part', () => {
    const message = build({
      html: HTML,
      attachments: [{ filename: 'a.csv', type: 'text/csv', bytes: bytesOf('a,b\n') }],
    });
    const { head } = splitMessage(message);
    const outer = /boundary="([^"]+)"/.exec(head)[1];
    const inner = /multipart\/alternative; boundary="([^"]+)"/.exec(message)[1];
    expect(inner).not.toBe(outer);
  });

  it('uses CRLF for every line ending and ends with one', () => {
    const message = build({ html: HTML });
    expect(message.endsWith(CRLF)).toBe(true);
    expect(message.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('buildMessage with attachments', () => {
  const csv = bytesOf('week,users\n2026-08-10,1533\n');
  const png = Uint8Array.from({ length: 300 }, (unused, i) => (i * 7) % 256);

  const withFiles = (attachments, over = {}) => build({ attachments, ...over });

  it('keeps a single text/plain part when there are no attachments', () => {
    const { headers } = roundTrip(build({ attachments: [] }));
    expect(headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('recovers every attachment byte-for-byte through the app parser', () => {
    const message = withFiles([
      { filename: 'q3-usage.csv', type: 'text/csv', bytes: csv },
      { filename: 'chart.png', type: 'image/png', bytes: png },
    ]);
    const { headers, text, attachments } = roundTrip(message);

    expect(headers.get('content-type')).toMatch(/^multipart\/mixed; boundary="/);
    expect(text).toBe('Hi Bob,\n\nJust checking in.\n');
    expect(attachments.map((a) => [a.filename, a.type, a.size]))
      .toEqual([['q3-usage.csv', 'text/csv', csv.length], ['chart.png', 'image/png', png.length]]);
    expect([...attachments[0].bytes()]).toEqual([...csv]);
    expect([...attachments[1].bytes()]).toEqual([...png]);
  });

  it('round-trips a non-ASCII filename', () => {
    const name = 'Überweisung — 領収書.pdf';
    const { attachments } = roundTrip(withFiles([
      { filename: name, type: 'application/pdf', bytes: csv },
    ]));
    expect(attachments[0].filename).toBe(name);
  });

  it("writes filename* with only the characters RFC 2231 allows unencoded", () => {
    const name = "Résumé (final) Bob's*.pdf";
    const message = withFiles([{ filename: name, type: 'application/pdf', bytes: csv }]);
    const extended = message.match(/filename\*=UTF-8''([^\r\n;]*)/)[1];
    expect(extended).toMatch(/^[A-Za-z0-9!#$&+.^_`|~%-]+$/);
    expect(roundTrip(message).attachments[0].filename).toBe(name);
  });

  it('cannot be used to inject a header through a filename', () => {
    const message = withFiles([
      { filename: 'ok.txt\r\nBcc: victim@example.com', type: 'text/plain', bytes: csv },
    ]);
    // The CR/LF is gone, so what was aiming to be a header is just part of
    // the quoted filename: no line of the message starts with it.
    expect(message.split(CRLF).some((line) => line.startsWith('Bcc:'))).toBe(false);
    const { attachments } = roundTrip(message);
    expect(attachments[0].filename).toBe('ok.txtBcc: victim@example.com');
  });

  it('drops directory parts and quotes from a filename', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Users\\me\\report "final".pdf')).toBe("report 'final'.pdf");
    expect(safeFilename('   ')).toBe('attachment');
    expect(safeFilename()).toBe('attachment');
  });

  it('strips the invisible characters that make a name lie about itself', () => {
    // A right-to-left override renders the rest of the name backwards, so
    // this one reads as "reportexe.pdf" on screen.
    expect(safeFilename('report\u202Efdp.exe')).toBe('reportfdp.exe');
    expect(safeFilename('in\u200bvoice.pdf')).toBe('invoice.pdf');
    expect(safeFilename('\u2066photo\u2069.png')).toBe('photo.png');
    expect(safeFilename('\u202e')).toBe('attachment');
    expect(safeFilename('résumé.pdf')).toBe('résumé.pdf');
  });

  it('wraps every base64 part at 76 characters and closes the multipart', () => {
    const message = withFiles([{ filename: 'big.bin', type: 'application/octet-stream', bytes: new Uint8Array(5000).fill(7) }]);
    const boundary = parseHeaders(splitMessage(message).head).get('content-type').match(/boundary="(.+)"/)[1];
    expect(message.endsWith(`--${boundary}--${CRLF}`)).toBe(true);
    const bodyLines = splitMessage(message).body.split(CRLF);
    expect(bodyLines.every((line) => line.length <= 76 || line.startsWith('--') || line.startsWith('Content-'))).toBe(true);
  });

  it('ignores attachments whose bytes never arrived', () => {
    const { headers } = roundTrip(withFiles([{ filename: 'pending.bin', type: '', bytes: null }]));
    expect(headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('refuses a content type that would smuggle in a second name parameter', () => {
    // The shape a forwarded attachment can carry over from the message it
    // came from: the outgoing header must not name a different file.
    const message = withFiles([{
      filename: 'doc.pdf',
      type: 'application/pdf" name="evil.exe',
      bytes: bytesOf('x'),
    }]);
    expect(message).not.toContain('evil.exe');
    const [attachment] = listAttachments(splitMessage(message).body, parseHeaders(splitMessage(message).head));
    expect(attachment.filename).toBe('doc.pdf');
    expect(attachment.type).toBe('application/octet-stream');
  });

  it('keeps the media types real attachments actually have', () => {
    const message = withFiles([
      { filename: 'a.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: bytesOf('x') },
      { filename: 'b.svg', type: 'image/svg+xml', bytes: bytesOf('x') },
    ]);
    const { head, body } = splitMessage(message);
    expect(listAttachments(body, parseHeaders(head)).map((a) => a.type)).toEqual([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/svg+xml',
    ]);
  });

  it('defaults a missing content type to application/octet-stream', () => {
    const { attachments } = roundTrip(withFiles([{ filename: 'blob', type: '', bytes: csv }]));
    expect(attachments[0].type).toBe('application/octet-stream');
  });
});

describe('draftProblem for attachments', () => {
  const valid = { to: ['a@b.co'], cc: [], subject: 'Hi' };
  const file = (over = {}) => ({ filename: 'a.bin', bytes: new Uint8Array(10), error: null, ...over });

  it('accepts attachments within the cap', () => {
    expect(draftProblem({ ...valid, attachments: [file()] })).toBeNull();
  });

  it('reports the file that could not be read, and names it', () => {
    const draft = { ...valid, attachments: [file(), file({ filename: 'broken.pdf', bytes: null, error: true })] };
    expect(draftProblem(draft)).toBe('broken.pdf could not be read. Remove it and try again.');
    expect(draftProblemField(draft)).toBe('attachments');
  });

  it('waits for a file that is still being read', () => {
    const draft = { ...valid, attachments: [file({ bytes: null })] };
    expect(draftProblem(draft)).toBe('Wait for the attachments to finish loading.');
    expect(draftProblemField(draft)).toBe('attachments');
  });

  it('reports the total against the cap before anything is posted', () => {
    const draft = {
      ...valid,
      attachments: [file({ bytes: new Uint8Array(MAX_ATTACHMENT_BYTES) }), file({ bytes: new Uint8Array(1) })],
    };
    expect(draftProblem(draft)).toBe('Attachments are 18.0 MB. The limit is 18.0 MB.');
    expect(draftProblemField(draft)).toBe('attachments');
  });

  it('is judged after the recipients and the subject', () => {
    const bad = { to: [], cc: [], subject: '', attachments: [file({ bytes: null, error: true })] };
    expect(draftProblemField(bad)).toBe('to');
  });
});


describe('threading headers', () => {
  it('carries In-Reply-To and References, folded like any other header', () => {
    const chain = Array.from({ length: 6 }, (unused, i) => `<msg-${i}@example.com>`);
    const message = build({ inReplyTo: '<msg-5@example.com>', references: chain });
    const { headers } = roundTrip(message);
    expect(headers.get('in-reply-to')).toBe('<msg-5@example.com>');
    expect(headers.get('references')).toBe(chain.join(' '));
    expect(message.split(CRLF).every((line) => line.length <= 78)).toBe(true);
  });

  it('leaves both out when there is nothing to thread with', () => {
    const { headers } = roundTrip(build());
    expect(headers.has('in-reply-to')).toBe(false);
    expect(headers.has('references')).toBe(false);
  });

  it('accepts references as a string as well as a list', () => {
    const { headers } = roundTrip(build({ references: '<a@x.co>  <b@x.co>' }));
    expect(headers.get('references')).toBe('<a@x.co> <b@x.co>');
  });

  it('keeps the most recent 20 references so a long thread cannot grow the header forever', () => {
    const chain = Array.from({ length: 40 }, (unused, i) => `<msg-${i}@example.com>`);
    const { headers } = roundTrip(build({ references: chain }));
    const kept = headers.get('references').split(' ');
    expect(kept).toHaveLength(20);
    expect(kept[19]).toBe('<msg-39@example.com>');
  });
});

describe('replyRecipients', () => {
  const headers = headersOf([
    'From: Ana Petrova <ana@example.com>',
    'To: me@puter.email, Bob <bob@example.com>',
    'Cc: "Doe, Jane" <jane@example.com>, ME@PUTER.EMAIL',
  ]);

  it('answers the sender alone by default', () => {
    expect(replyRecipients(headers, ME)).toEqual({ to: ['ana@example.com'], cc: [] });
  });

  it('answers everyone on the message, minus the user', () => {
    expect(replyRecipients(headers, ME, { all: true })).toEqual({
      to: ['ana@example.com'],
      cc: ['bob@example.com', 'jane@example.com'],
    });
  });

  it('removes the user case-insensitively, on either sending domain', () => {
    const both = headersOf([
      'From: Ana <ana@example.com>',
      'To: Me@Puter.Email, me@puterstaging.email, bob@example.com',
    ]);
    expect(replyRecipients(both, ME, { all: true }).cc).toEqual(['bob@example.com']);
  });

  it('collapses duplicates, wherever they appear', () => {
    const dupes = headersOf([
      'From: Ana <ana@example.com>',
      'To: bob@example.com, ANA@example.com',
      'Cc: Bob <bob@example.com>, carol@example.com',
    ]);
    expect(replyRecipients(dupes, ME, { all: true })).toEqual({
      to: ['ana@example.com'],
      cc: ['bob@example.com', 'carol@example.com'],
    });
  });

  it('prefers Reply-To over From', () => {
    const withReplyTo = headersOf([
      'From: notifications@example.com',
      'Reply-To: Ana Petrova <ana@example.com>',
      'To: me@puter.email',
    ]);
    expect(replyRecipients(withReplyTo, ME).to).toEqual(['ana@example.com']);
    // From is not silently added back as a copy.
    expect(replyRecipients(withReplyTo, ME, { all: true }).cc).toEqual([]);
  });

  it('answers the recipients when the message is one the user sent', () => {
    const sent = headersOf([
      'From: me@puter.email',
      'To: ana@example.com, bob@example.com',
      'Cc: carol@example.com',
    ]);
    expect(replyRecipients(sent, ME)).toEqual({
      to: ['ana@example.com', 'bob@example.com'],
      cc: [],
    });
    expect(replyRecipients(sent, ME, { all: true })).toEqual({
      to: ['ana@example.com', 'bob@example.com'],
      cc: ['carol@example.com'],
    });
  });

  it('keeps a comma inside a quoted display name out of the split', () => {
    const quoted = headersOf(['From: "Petrova, Ana" <ana@example.com>', 'To: me@puter.email']);
    expect(replyRecipients(quoted, ME).to).toEqual(['ana@example.com']);
  });

  it('is empty rather than wrong when there is nobody to answer', () => {
    expect(replyRecipients(headersOf(['From: me@puter.email']), ME, { all: true }))
      .toEqual({ to: [], cc: [] });
    expect(replyRecipients(headersOf(['Subject: no addresses at all']), ME))
      .toEqual({ to: [], cc: [] });
  });

  it('does not remove anything when the sender addresses are unknown', () => {
    expect(replyRecipients(headers, []).to).toEqual(['ana@example.com']);
    expect(replyRecipients(headers, [], { all: true }).cc)
      .toEqual(['me@puter.email', 'bob@example.com', 'jane@example.com']);
  });
});

describe('replySubject and forwardSubject', () => {
  it('put the prefix on once, however the last client spelled it', () => {
    expect(replySubject('Lunch')).toBe('Re: Lunch');
    expect(replySubject('Re: Lunch')).toBe('Re: Lunch');
    expect(replySubject('RE: Lunch')).toBe('RE: Lunch');
    expect(replySubject('Re[2]: Lunch')).toBe('Re[2]: Lunch');
    expect(forwardSubject('Lunch')).toBe('Fwd: Lunch');
    expect(forwardSubject('Fwd: Lunch')).toBe('Fwd: Lunch');
    // Outlook writes a forward as FW:, and a forward of one used to go out
    // as "Fwd: FW: Lunch".
    expect(forwardSubject('FW: Lunch')).toBe('FW: Lunch');
    expect(forwardSubject('Fw: Lunch')).toBe('Fw: Lunch');
  });

  it('only check for their own prefix: a forward of a reply says both', () => {
    expect(forwardSubject('Re: Lunch')).toBe('Fwd: Re: Lunch');
    expect(replySubject('Fwd: Lunch')).toBe('Re: Fwd: Lunch');
  });

  it('leave a message with no subject with none, for the writer to fill in', () => {
    expect(replySubject('')).toBe('');
    expect(forwardSubject('')).toBe('');
    expect(replySubject(undefined)).toBe('');
  });
});

describe('forwardBlock', () => {
  it('says who the original was from, when, about what, and to whom', () => {
    expect(forwardBlock({
      from: 'Ana Petrova <ana@example.com>',
      date: 'Thu, Aug 20, 2026, 4:30 PM',
      subject: 'Q3 usage report attached',
      to: 'me@puter.email',
      cc: 'team@example.com',
    }).split('\n')).toEqual([
      '---------- Forwarded message ----------',
      'From: Ana Petrova <ana@example.com>',
      'Date: Thu, Aug 20, 2026, 4:30 PM',
      'Subject: Q3 usage report attached',
      'To: me@puter.email',
      'Cc: team@example.com',
    ]);
  });

  it('leaves out the lines the original did not have', () => {
    expect(forwardBlock({ from: 'a@b.co', subject: 'Hi' }).split('\n')).toEqual([
      '---------- Forwarded message ----------',
      'From: a@b.co',
      'Subject: Hi',
    ]);
  });

  it('is not the reply quote format: a forward is not an answer', () => {
    expect(forwardBlock({ from: 'a@b.co', subject: 'Hi' })).not.toContain('>');
  });
});
