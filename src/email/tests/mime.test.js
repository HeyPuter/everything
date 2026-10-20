import { describe, it, expect } from 'vitest';
import {
  subjectFromFilename, decodeWords, decodeQuotedPrintable, splitMessage,
  parseHeaders, parseContentType, parseAddress, parseAddressList, decodeBody,
  extractText, extractHtml, extractBodyText, previewText, listAttachments, parseListUnsubscribe, unflow,
} from '../src/lib/mime.js';

const CRLF = '\r\n';
const b64utf8 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe('subjectFromFilename', () => {
  it('decodes the base64url part after the -- separator', () => {
    const name = `0198f1c0-0000-7000-8000-000000000000--${b64utf8('Hello world').replace(/=+$/, '')}`;
    expect(subjectFromFilename(name)).toBe('Hello world');
  });

  it('handles base64url alphabet (- and _)', () => {
    const b64 = b64utf8('a?b>c').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(subjectFromFilename(`id--${b64}`)).toBe('a?b>c');
  });

  it('returns empty string without a separator or on bad base64', () => {
    expect(subjectFromFilename('justanid')).toBe('');
    expect(subjectFromFilename('id--%%%%')).toBe('');
  });
});

describe('decodeWords (RFC 2047)', () => {
  it('decodes B-encoded utf-8 words', () => {
    expect(decodeWords(`=?utf-8?B?${b64utf8('Überweisung bestätigt')}?=`)).toBe('Überweisung bestätigt');
  });

  it('decodes Q-encoded words, mapping _ to space', () => {
    expect(decodeWords('=?utf-8?Q?R=C3=A9servation_confirm=C3=A9e?=')).toBe('Réservation confirmée');
  });

  it('drops whitespace between adjacent encoded words but keeps it around them', () => {
    const value = `Re: =?utf-8?B?${b64utf8('foo')}?= =?utf-8?B?${b64utf8('bar')}?= end`;
    expect(decodeWords(value)).toBe('Re: foobar end');
  });

  it('leaves plain values and malformed words untouched', () => {
    expect(decodeWords('Plain subject')).toBe('Plain subject');
    expect(decodeWords('=?utf-8?X?bogus?=')).toBe('=?utf-8?X?bogus?=');
  });

  it('falls back to utf-8 for unknown charsets', () => {
    expect(decodeWords(`=?not-a-charset?B?${b64utf8('ok')}?=`)).toBe('ok');
  });
});

describe('decodeQuotedPrintable', () => {
  it('decodes hex escapes as charset bytes', () => {
    expect(decodeQuotedPrintable('caf=C3=A9')).toBe('café');
  });

  it('passes through stray = that is not an escape', () => {
    expect(decodeQuotedPrintable('a=zb')).toBe('a=zb');
  });
});

describe('splitMessage / parseHeaders', () => {
  it('splits head and body on the first blank line, CRLF or LF', () => {
    expect(splitMessage(`A: 1${CRLF}${CRLF}body`)).toEqual({ head: 'A: 1', body: 'body', complete: true });
    expect(splitMessage('A: 1\n\nbody')).toEqual({ head: 'A: 1', body: 'body', complete: true });
  });

  it('treats a message without a blank line as all head, and says the line was not found', () => {
    // For a range read that is how a head longer than the range looks, and
    // the caller has to be able to tell that apart from a headers-only file.
    expect(splitMessage('A: 1')).toEqual({ head: 'A: 1', body: '', complete: false });
  });

  it('unfolds continuation lines and lowercases keys', () => {
    const headers = parseHeaders(`Subject: part one,${CRLF}  part two${CRLF}FROM: x@y.z`);
    expect(headers.get('subject')).toBe('part one, part two');
    expect(headers.get('from')).toBe('x@y.z');
  });

  it('keeps the first value of a duplicated header', () => {
    const headers = parseHeaders(`Received: first${CRLF}Received: second`);
    expect(headers.get('received')).toBe('first');
  });
});

describe('parseContentType', () => {
  it('lowercases the type and reads quoted parameters', () => {
    const { type, attrs } = parseContentType('Multipart/Mixed; boundary="B 1"; charset=utf-8');
    expect(type).toBe('multipart/mixed');
    expect(attrs.boundary).toBe('B 1');
    expect(attrs.charset).toBe('utf-8');
  });
});

describe('parseAddress', () => {
  it('reads the address off the header as sent, not out of an encoded word', () => {
    const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
    // Every other parser (the receiving server's included) sees
    // attacker@evil.example: the brackets and parentheses are inside words.
    const from = `=?utf-8?B?${b64('Boss <boss@bank.example> (')}?= <attacker@evil.example> =?utf-8?B?${b64(')')}?=`;
    expect(parseAddress(from).email).toBe('attacker@evil.example');
    expect(parseAddressList(from).map((a) => a.email)).toEqual(['attacker@evil.example']);
    expect(parseAddress(`=?utf-8?B?${b64('boss@bank.example')}?=`).email).toBe('');
    expect(parseAddress('jane@example.com (Jane)')).toEqual({ name: 'jane@example.com', email: 'jane@example.com' });
  });

  it('splits display name and address', () => {
    expect(parseAddress('Jane Doe <jane@example.com>'))
      .toEqual({ name: 'Jane Doe', email: 'jane@example.com' });
  });

  it('strips quotes and decodes encoded names', () => {
    expect(parseAddress('"Doe, Jane" <jane@example.com>').name).toBe('Doe, Jane');
    expect(parseAddress('=?utf-8?Q?Caf=C3=A9?= <c@l.example>').name).toBe('Café');
  });

  it('uses the address as the name for bare addresses', () => {
    expect(parseAddress('jane@example.com')).toEqual({ name: 'jane@example.com', email: 'jane@example.com' });
    // The old way of writing a display name, and a comment after a full
    // address: neither is part of the address, and the parenthesised text
    // must not end up inside what is taken for one.
    expect(parseAddress('jane@example.com (Jane Doe)'))
      .toEqual({ name: 'jane@example.com', email: 'jane@example.com' });
    expect(parseAddress('Jane Doe <jane@example.com> (via list)'))
      .toEqual({ name: 'Jane Doe', email: 'jane@example.com' });
    expect(parseAddress('"Smith (Bob)" <b@x.co>').name).toBe('Smith (Bob)');
    expect(parseAddress('<jane@example.com>')).toEqual({ name: 'jane@example.com', email: 'jane@example.com' });
  });
});

describe('decodeBody', () => {
  it('decodes base64 bodies with line wrapping', () => {
    const headers = parseHeaders(`Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: base64`);
    const wrapped = b64utf8('héllo from base64').replace(/(.{8})/g, `$1${CRLF}`);
    expect(decodeBody(wrapped, headers)).toBe('héllo from base64');
  });

  it('decodes quoted-printable bodies, removing soft line breaks', () => {
    const headers = parseHeaders('Content-Transfer-Encoding: quoted-printable');
    expect(decodeBody(`long li=${CRLF}ne caf=C3=A9`, headers)).toBe('long line café');
  });

  it('returns 7bit bodies unchanged', () => {
    expect(decodeBody('plain', new Map())).toBe('plain');
  });
});

const multipartAlternative = (boundary = 'xyz') => ({
  headers: parseHeaders(`Content-Type: multipart/alternative; boundary="${boundary}"`),
  body: [
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>html <b>version</b></p>',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'plain version',
    `--${boundary}--`,
  ].join(CRLF),
});

describe('extractText', () => {
  it('returns plain text bodies as-is', () => {
    expect(extractText('hello', new Map())).toBe('hello');
  });

  it('prefers the text/plain part of multipart/alternative', () => {
    const { headers, body } = multipartAlternative();
    expect(extractText(body, headers)).toBe('plain version');
  });

  it('flattens html-only messages to text instead of rendering them', () => {
    const headers = parseHeaders('Content-Type: text/html; charset=utf-8');
    const text = extractText('<p>Hi <script>alert(1)</script><b>there</b></p>', headers);
    expect(text).toContain('Hi');
    expect(text).toContain('there');
    expect(text).not.toContain('<b>');
  });

  it('recurses into nested multiparts', () => {
    const inner = multipartAlternative('inner');
    const body = [
      '--outer',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      inner.body,
      '--outer--',
    ].join(CRLF);
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="outer"');
    expect(extractText(body, headers)).toBe('plain version');
  });

  it('returns empty string for non-text parts', () => {
    const headers = parseHeaders('Content-Type: image/png');
    expect(extractText('binarybytes', headers)).toBe('');
  });

  it('reads the html part when the text/plain part is empty', () => {
    const headers = parseHeaders('Content-Type: multipart/alternative; boundary="xyz"');
    const body = [
      '--xyz',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '',
      '--xyz',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>the actual message</p>',
      '--xyz--',
    ].join(CRLF);
    expect(extractText(body, headers)).toBe('the actual message');
  });
});

describe('extractBodyText', () => {
  it('keeps the text after a photo placed mid-message, in text and in HTML', () => {
    const part = (type, content, extra = []) => ['--b', `Content-Type: ${type}`, ...extra, '', content];
    const photo = part('image/jpeg; name="IMG_1.jpeg"', '/9j/4AAQ',
      ['Content-Disposition: inline; filename="IMG_1.jpeg"', 'Content-Transfer-Encoding: base64']);
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="b"');
    const text = [...part('text/plain; charset=us-ascii', 'Here is the photo:'), ...photo,
      ...part('text/plain; charset=us-ascii', 'And the address is 12 Main St.'), '--b--', ''].join(CRLF);
    expect(extractText(text, headers)).toBe('Here is the photo:\n\nAnd the address is 12 Main St.');
    const html = [...part('text/html; charset=utf-8', '<p>Here is the photo:</p>'), ...photo,
      ...part('text/html; charset=utf-8', '<p>And the address is 12 Main St.</p>'), '--b--', ''].join(CRLF);
    expect(extractHtml(html, headers)).toContain('12 Main St.');
    // An alternative is still one choice among its parts, not all of them.
    expect(extractText(multipartAlternative().body, multipartAlternative().headers)).toBe('plain version');
  });

  it('does not call text the sender wrote as text flattened html', () => {
    const { headers, body } = multipartAlternative();
    expect(extractBodyText(body, headers)).toEqual({ text: 'plain version', flattened: false });
  });

  it('reports text left over from an html-only message as flattened', () => {
    const headers = parseHeaders('Content-Type: text/html; charset=utf-8');
    expect(extractBodyText('<p>html <b>version</b></p>', headers))
      .toEqual({ text: 'html version', flattened: true });
  });

  it('carries the answer up out of a nested multipart', () => {
    const inner = multipartAlternative('inner');
    const body = [
      '--outer',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      inner.body,
      '--outer--',
    ].join(CRLF);
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="outer"');
    expect(extractBodyText(body, headers).flattened).toBe(false);
  });

  it('is flattened when the only text there is came out of the html part', () => {
    const headers = parseHeaders('Content-Type: multipart/alternative; boundary="xyz"');
    const body = [
      '--xyz',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>html only</p>',
      '--xyz--',
    ].join(CRLF);
    expect(extractBodyText(body, headers)).toEqual({ text: 'html only', flattened: true });
  });
});

describe('previewText (truncated chunks)', () => {
  it('decodes as much of a mid-group-truncated base64 body as possible', () => {
    const headers = parseHeaders(`Content-Type: text/plain${CRLF}Content-Transfer-Encoding: base64`);
    const full = b64utf8('The quick brown fox jumps over the lazy dog');
    const text = previewText(full.slice(0, full.length - 3), headers);
    expect(text.startsWith('The quick brown fox')).toBe(true);
    expect(text).not.toContain('=');
  });

  it('drops a half-transmitted quoted-printable escape', () => {
    const headers = parseHeaders('Content-Transfer-Encoding: quoted-printable');
    expect(previewText('caf=C3=A9 ok =C', headers)).toBe('café ok ');
  });

  it('never throws on a multipart cut before the closing boundary', () => {
    const { headers, body } = multipartAlternative();
    const cut = body.slice(0, body.indexOf('plain'));
    expect(() => previewText(cut, headers)).not.toThrow();
  });

  it('reads the first part of a multipart the read stopped inside', () => {
    // The normal shape of a long message read a few KB at a time: one opening
    // boundary and no closing one, so there is no *complete* part to find.
    const headers = parseHeaders('Content-Type: multipart/alternative; boundary="b"');
    const body = [
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      '',
      `Dear reader, ${'the quick brown fox '.repeat(20)}`,
    ].join(CRLF);
    expect(previewText(body, headers).startsWith('Dear reader, the quick brown fox')).toBe(true);
  });

  it('reads through a nested multipart the read stopped inside', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="mix"');
    const body = [
      '--mix',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Nested body text that ran on and on',
    ].join(CRLF);
    expect(previewText(body, headers)).toBe('Nested body text that ran on and on');
  });

  it('prefers a whole part to a truncated one', () => {
    const { headers, body } = multipartAlternative();
    expect(previewText(body, headers)).toBe('plain version');
  });

  it('has nothing to say when the read stopped before the first boundary', () => {
    const headers = parseHeaders('Content-Type: multipart/alternative; boundary="b"');
    expect(previewText('This is a MIME message.', headers)).toBe('');
  });
});

describe('format=flowed', () => {
  const flowed = (params = '') => parseHeaders(`Content-Type: text/plain; charset=utf-8; format=flowed${params}`);

  it('joins the lines of a wrapped paragraph and leaves the paragraph breaks', () => {
    const body = 'The quick brown fox jumps over \r\nthe lazy dog and keeps \r\nrunning.\r\n\r\nSecond paragraph.\r\n';
    expect(extractText(body, flowed()))
      .toBe('The quick brown fox jumps over the lazy dog and keeps running.\n\nSecond paragraph.\n');
  });

  it('takes the added space off each break where the sender said delsp', () => {
    // With delsp the sender added a space to mark the break, so the one
    // that was already there stays and the marker goes.
    const body = 'jumps over  \r\nthe lazy dog\r\n';
    expect(extractText(body, flowed('; delsp=yes'))).toBe('jumps over the lazy dog\n');
    // Which is what lets a language without spaces be wrapped at all.
    expect(extractText('\u65e5\u672c \r\n\u8a9e\r\n', flowed('; DelSp=Yes'))).toBe('\u65e5\u672c\u8a9e\n');
  });

  it('keeps a quoted paragraph quoted, at its own depth', () => {
    const body = 'On Monday Ana wrote:\r\n> We could meet on \r\n> Thursday if that \r\n> suits.\r\n>> An older \r\n>> line.\r\n\r\nSounds good.';
    expect(extractText(body, flowed()))
      .toBe('On Monday Ana wrote:\n> We could meet on Thursday if that suits.\n> > An older line.\n\nSounds good.');
  });

  it('unstuffs a protected line and leaves the signature separator fixed', () => {
    const body = 'A line that \r\n From would otherwise start a header.\r\n-- \r\nAna\r\n';
    expect(extractText(body, flowed())).toBe('A line that From would otherwise start a header.\n-- \nAna\n');
  });

  it('ends a paragraph where the quote depth changes, even mid-flow', () => {
    expect(unflow('> quoted \r\nnot quoted \r\nstill not.')).toBe('> quoted\nnot quoted still not.');
    expect(unflow('>\r\n> a\r\n')).toBe('>\n> a\n');
  });

  it('leaves text that was not flowed exactly as it came', () => {
    const body = 'wrapped here \r\nby hand';
    expect(extractText(body, parseHeaders('Content-Type: text/plain; charset=utf-8'))).toBe(body);
    expect(extractText(body, parseHeaders('Content-Type: text/plain; format=fixed'))).toBe(body);
  });
});

describe('listAttachments', () => {
  const csv = 'a,b\n1,2\n';
  const message = () => ({
    headers: parseHeaders('Content-Type: multipart/mixed; boundary="mix"'),
    body: [
      '--mix',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'see attached',
      '--mix',
      'Content-Type: text/csv; name="data.csv"',
      'Content-Disposition: attachment; filename="data.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      b64utf8(csv),
      '--mix--',
    ].join(CRLF),
  });

  it('finds attachment parts and skips the message text', () => {
    const { headers, body } = message();
    const attachments = listAttachments(body, headers);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('data.csv');
    expect(attachments[0].type).toBe('text/csv');
  });

  it('decodes base64 attachment bytes back to the original content', () => {
    const { headers, body } = message();
    const [attachment] = listAttachments(body, headers);
    expect(new TextDecoder().decode(attachment.bytes())).toBe(csv);
    expect(attachment.size).toBe(new TextEncoder().encode(csv).length);
  });

  it('returns nothing for non-multipart messages', () => {
    expect(listAttachments('hello', new Map())).toEqual([]);
  });

  /**
   * The size is counted where the encoded part lies rather than off a
   * whitespace-stripped copy of it, so every shape a sender wraps and pads
   * base64 in has to give the same answer -- and it has to be the same answer
   * over raw bytes, which is what a message read from the mailbox is.
   */
  it('measures a base64 part however it is wrapped and padded', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 600]) {
      const content = 'x'.repeat(length);
      const encoded = b64utf8(content);
      for (const wrapped of [encoded, (encoded.match(/.{1,4}/g) ?? []).join(CRLF), encoded.split('').join(' ')]) {
        const body = [
          '--mix', 'Content-Type: application/octet-stream; name="f.bin"',
          'Content-Transfer-Encoding: base64', '', wrapped, '--mix--',
        ].join(CRLF);
        const headers = parseHeaders('Content-Type: multipart/mixed; boundary="mix"');
        const asBytes = new TextEncoder().encode(body);
        expect(listAttachments(body, headers)[0].size).toBe(length);
        expect(listAttachments(asBytes, headers)[0].size).toBe(length);
      }
    }
  });

  it('reads an RFC 2231 filename, which is what other clients send', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="mix"');
    const body = [
      '--mix',
      'Content-Type: application/pdf',
      "Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
      '',
      'AAAA',
      '--mix--',
    ].join(CRLF);
    expect(listAttachments(body, headers)[0].filename).toBe('résumé.pdf');
  });

  it('joins the numbered segments of a long RFC 2231 filename', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="mix"');
    const body = [
      '--mix',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment;',
      " filename*0*=UTF-8''r%C3%A9sum;",
      ' filename*1*=%C3%A9-2026.pdf',
      '',
      'AAAA',
      '--mix--',
    ].join(CRLF);
    expect(listAttachments(body, headers)[0].filename).toBe('résumé-2026.pdf');
  });

  it('still reads the encoded word this app writes beside it', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="mix"');
    const body = [
      '--mix',
      'Content-Type: application/pdf; name="=?UTF-8?B?csOpc3Vtw6kucGRm?="',
      'Content-Disposition: attachment; filename="=?UTF-8?B?csOpc3Vtw6kucGRm?="',
      '',
      'AAAA',
      '--mix--',
    ].join(CRLF);
    expect(listAttachments(body, headers)[0].filename).toBe('résumé.pdf');
  });

  it('falls back to the Content-Type name when there is no disposition filename', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="mix"');
    const body = [
      '--mix',
      "Content-Type: application/pdf; name*=UTF-8''r%C3%A9sum%C3%A9.pdf",
      '',
      'AAAA',
      '--mix--',
    ].join(CRLF);
    expect(listAttachments(body, headers)[0].filename).toBe('résumé.pdf');
  });

  it('finds attachments inside nested multiparts', () => {
    const inner = message();
    const body = [
      '--outer',
      'Content-Type: multipart/mixed; boundary="mix"',
      '',
      inner.body,
      '--outer--',
    ].join(CRLF);
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="outer"');
    expect(listAttachments(body, headers)).toHaveLength(1);
  });
});


describe('parseAddressList', () => {
  it('splits a plain list', () => {
    expect(parseAddressList('a@x.co, b@y.co')).toEqual([
      { name: 'a@x.co', email: 'a@x.co' },
      { name: 'b@y.co', email: 'b@y.co' },
    ]);
  });

  it('keeps a comma that is inside a quoted display name', () => {
    expect(parseAddressList('"Doe, Jane" <jane@x.co>, bob@y.co')).toEqual([
      { name: 'Doe, Jane', email: 'jane@x.co' },
      { name: 'bob@y.co', email: 'bob@y.co' },
    ]);
  });

  it('handles angle-addressed, bare, and mixed entries', () => {
    expect(parseAddressList('Ana Petrova <ana@x.co>, <bob@y.co>, carol@z.co')).toEqual([
      { name: 'Ana Petrova', email: 'ana@x.co' },
      { name: 'bob@y.co', email: 'bob@y.co' },
      { name: 'carol@z.co', email: 'carol@z.co' },
    ]);
  });

  it('decodes encoded-word display names, including one holding a comma', () => {
    const encoded = `=?utf-8?B?${b64utf8('Café, Lumière')}?=`;
    expect(parseAddressList(`${encoded} <hi@l.co>, x@y.co`)).toEqual([
      { name: 'Café, Lumière', email: 'hi@l.co' },
      { name: 'x@y.co', email: 'x@y.co' },
    ]);
  });

  it('drops RFC 5322 comments rather than leaving them in the address', () => {
    expect(parseAddressList('a@x.co (Anna, admin), b@y.co')).toEqual([
      { name: 'a@x.co', email: 'a@x.co' },
      { name: 'b@y.co', email: 'b@y.co' },
    ]);
  });

  it('keeps parentheses that are part of a quoted name', () => {
    expect(parseAddressList('"Smith (Bob)" <b@x.co>')).toEqual([
      { name: 'Smith (Bob)', email: 'b@x.co' },
    ]);
  });

  it('reads the members of a group and not its label', () => {
    expect(parseAddressList('Team: a@x.co, b@y.co;')).toEqual([
      { name: 'a@x.co', email: 'a@x.co' },
      { name: 'b@y.co', email: 'b@y.co' },
    ]);
  });

  it('reads an empty group as its label, without the colon', () => {
    // How a message to a hidden list names its recipients.
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([
      { name: 'undisclosed-recipients', email: '' },
    ]);
    expect(parseAddressList('Undisclosed recipients: ;')).toEqual([
      { name: 'Undisclosed recipients', email: '' },
    ]);
  });

  it('is empty for an empty or whitespace header', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('   ')).toEqual([]);
    expect(parseAddressList(',,')).toEqual([]);
  });

  it('does not lose an address to an escaped quote in a name', () => {
    expect(parseAddressList('"Jane \\"JD\\"" <jane@x.co>, bob@y.co').map((a) => a.email))
      .toEqual(['jane@x.co', 'bob@y.co']);
  });
});


describe('flattening HTML without losing the links', () => {
  it('stays linear on a long run of spaces that no line break follows', () => {
    const headers = parseHeaders('Content-Type: text/html; charset=utf-8');
    const start = performance.now();
    expect(extractText(`<pre>a   \n${' '.repeat(16000)}x</pre>`, headers)).toBe(`a\n${' '.repeat(16000)}x`);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  const flatten = (html) => {
    const raw = `Content-Type: text/html; charset=utf-8${CRLF}${CRLF}${html}`;
    const { head, body } = splitMessage(raw);
    return extractText(body, parseHeaders(head));
  };

  it('keeps the target of a link whose text is not the URL', () => {
    expect(flatten('<p><a href="https://shop.example/verify?token=abc">Verify your email</a></p>'))
      .toBe('Verify your email <https://shop.example/verify?token=abc>');
  });

  it('does not repeat a URL the text already shows', () => {
    expect(flatten('<a href="https://shop.example/x">https://shop.example/x</a>'))
      .toBe('https://shop.example/x');
    expect(flatten('<a href="https://shop.example/x/">shop.example/x</a>'))
      .toBe('shop.example/x');
  });

  it('keeps a mailto target but not a javascript one', () => {
    expect(flatten('<a href="mailto:help@shop.example">our team</a>'))
      .toBe('our team <mailto:help@shop.example>');
    expect(flatten('<a href="javascript:alert(1)">unsubscribe</a>')).toBe('unsubscribe');
    expect(flatten('<a href="/relative">relative</a>')).toBe('relative');
  });

  it('breaks lines on block elements, so the kept URLs are readable', () => {
    expect(flatten('<h1>Order</h1><p>Thanks</p><ul><li>One</li><li>Two</li></ul>'))
      .toBe('Order\n\nThanks\n\nOne\nTwo');
    expect(flatten('a<br>b')).toBe('a\nb');
  });

  it('drops script and style content rather than reading it as text', () => {
    expect(flatten('<style>.a{color:red}</style><script>alert(1)</script><p>body</p>')).toBe('body');
  });

  it('collapses the runs of blank lines that block elements leave behind', () => {
    expect(flatten('<div><div><div><p>one</p></div></div></div><p>two</p>')).toBe('one\n\ntwo');
  });

  it('collapses the whitespace of the markup, the way rendering it would', () => {
    // Indented source: the newlines belong to the HTML, not to the sentence.
    expect(flatten('<p>\n    The best tools stay out of the way.\n    This week we look\n    at three products.\n  </p>'))
      .toBe('The best tools stay out of the way. This week we look at three products.');
    expect(flatten('<div>\n  <span>one</span>\n  <span>two</span>\n</div>')).toBe('one two');
  });

  it('keeps the whitespace inside a pre block, which is what it is for', () => {
    expect(flatten('<pre>line one\n  indented\nline three</pre>'))
      .toBe('line one\n  indented\nline three');
  });
});

describe('parseListUnsubscribe', () => {
  it('reads a mailto and a URL out of one header', () => {
    const ways = parseListUnsubscribe(
      '<mailto:leave@list.example?subject=unsubscribe%20me&body=token%3D1>, <https://list.example/u?x=1>');
    expect(ways.mailto).toEqual({ to: 'leave@list.example', subject: 'unsubscribe me', body: 'token=1' });
    expect(ways.url).toBe('https://list.example/u?x=1');
  });

  it('is nothing for a message that names no way out', () => {
    expect(parseListUnsubscribe('')).toEqual({ mailto: null, url: null });
    expect(parseListUnsubscribe(undefined)).toEqual({ mailto: null, url: null });
    expect(parseListUnsubscribe('nothing in brackets')).toEqual({ mailto: null, url: null });
  });

  it('refuses anything that is not mail or the web', () => {
    expect(parseListUnsubscribe('<javascript:alert(1)>, <data:text/html,hi>, <ftp://x.example/>'))
      .toEqual({ mailto: null, url: null });
  });

  it('refuses a mailto that names no address', () => {
    expect(parseListUnsubscribe('<mailto:?subject=hi>').mailto).toBe(null);
    expect(parseListUnsubscribe('<mailto:not-an-address>').mailto).toBe(null);
  });

  it('keeps the first of each kind, and a plain http URL', () => {
    const ways = parseListUnsubscribe(
      '<http://a.example/1>, <mailto:one@a.example>, <https://b.example/2>, <mailto:two@a.example>');
    expect(ways.url).toBe('http://a.example/1');
    expect(ways.mailto.to).toBe('one@a.example');
  });

  it('reads several addresses in one mailto', () => {
    expect(parseListUnsubscribe('<mailto:a@x.example,b@x.example>').mailto.to)
      .toBe('a@x.example, b@x.example');
  });

  it('survives a mailto whose encoding is broken', () => {
    expect(parseListUnsubscribe('<mailto:%E0%A4%A@x.example>').mailto).toBe(null);
  });
});


describe('body selection excludes attached files', () => {
  it.each([
    'Content-Disposition: attachment; filename=notes.txt',
    'Content-Type: text/plain; name=notes.txt',
  ])('keeps the HTML message ahead of a text file: %s', (fileHeader) => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary=b');
    const body = [
      '--b', 'Content-Type: text/html', '', '<p>Actual message</p>',
      '--b', fileHeader, '', 'ATTACHED NOTES', '--b--',
    ].join(CRLF);
    expect(extractText(body, headers)).toBe('Actual message');
    expect(previewText(body, headers)).toBe('Actual message');
    expect(extractHtml(body, headers)).toBe('<p>Actual message</p>');
  });

  it('skips an attached multipart subtree in both body views', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary=b');
    const body = [
      '--b', 'Content-Type: multipart/alternative; boundary=file',
      'Content-Disposition: attachment', '',
      '--file', 'Content-Type: text/html', '', '<p>Attached HTML</p>',
      '--file', 'Content-Type: text/plain', '', 'Attached text', '--file--',
      '--b', 'Content-Type: text/html', '', '<p>Actual message</p>', '--b--',
    ].join(CRLF);
    expect(extractText(body, headers)).toBe('Actual message');
    expect(extractHtml(body, headers)).toBe('<p>Actual message</p>');
  });
});

describe('multipart boundary lines', () => {
  it.each(['\r\n', '\n'])('preserves boundary-like text with %j newlines', (newline) => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="a.+(b)"');
    const content = ['Before --a.+(b) after', '--a.+(b)suffix', '--aZZb', 'last line'].join(newline);
    const body = ['preamble', '--a.+(b) \t', 'Content-Type: text/plain', '',
      content, '--a.+(b)--\t', 'epilogue', '--a.+(b)', '', 'ignored'].join(newline);
    expect(extractText(body, headers)).toBe(content);
    expect(previewText(body, headers)).toBe(content);
  });

  it('recovers the final part without a closing delimiter', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary=b');
    const body = ['--b', 'Content-Type: text/plain', '', 'Actual message', ''].join(CRLF);
    expect(extractText(body, headers)).toBe(`Actual message${CRLF}`);
    expect(previewText(body, headers)).toBe(`Actual message${CRLF}`);
  });

  it('uses partial decoding for a truncated encoded multipart preview', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary=b');
    const encoded = b64utf8('The quick brown fox jumps over the lazy dog');
    const body = ['--b', 'Content-Type: text/plain', 'Content-Transfer-Encoding: base64', '',
      encoded.slice(0, 25)].join(CRLF);
    expect(previewText(body, headers)).toBe('The quick brown fo');
  });

  it('handles a part with no headers', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary=b');
    expect(extractText('--b\r\n\r\nHello\r\n--b--', headers)).toBe('Hello');
  });

  it('does not split attachment bytes on a boundary token inside a line', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary=b');
    const content = 'Before --b after';
    const body = ['--b', 'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename=data.bin', '', content, '--b--'].join(CRLF);
    expect(new TextDecoder().decode(listAttachments(body, headers)[0].bytes())).toBe(content);
  });
});

describe('quoted MIME parameters', () => {
  it('keeps semicolons, equals signs, escaped quotes and backslashes inside a value', () => {
    const parsed = parseContentType(String.raw`attachment; filename="report; \"final\"=1\\2.pdf"; size=42`);
    expect(parsed.attrs).toEqual({ filename: 'report; "final"=1\\2.pdf', size: '42' });
  });

  it('uses a quoted boundary containing a semicolon to read both body and filename', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="a;b"');
    const body = ['--a;b', 'Content-Type: text/plain', '', 'Message',
      '--a;b', 'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="report;final.pdf"', '', 'data', '--a;b--'].join(CRLF);
    expect(extractText(body, headers)).toBe('Message');
    expect(listAttachments(body, headers)[0].filename).toBe('report;final.pdf');
  });

  it('handles folded quoted filenames', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary=b');
    const body = ['--b', 'Content-Type: application/pdf',
      'Content-Disposition: attachment;', ' filename="report;final.pdf"', '', 'data', '--b--'].join(CRLF);
    expect(listAttachments(body, headers)[0].filename).toBe('report;final.pdf');
  });
});

describe('attachment-only messages', () => {
  it.each([
    'Content-Disposition: attachment; filename=report.pdf',
    "Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
    'Content-Type: application/pdf; name=report.pdf',
  ])('collects a root attachment with %s', (fileHeader) => {
    const headers = parseHeaders(`${fileHeader}\r\nContent-Transfer-Encoding: base64`);
    const attachments = listAttachments('AP+A', headers);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toMatch(/\.pdf$/);
    expect(attachments[0].size).toBe(3);
    expect([...attachments[0].bytes()]).toEqual([0, 255, 128]);
    expect(extractText('AP+A', headers)).toBe('');
  });

  it('provides a fallback filename for an unnamed root attachment', () => {
    const headers = parseHeaders('Content-Type: application/pdf\r\nContent-Disposition: attachment');
    expect(listAttachments('data', headers)[0].filename).toBe('attachment');
  });

  it('still excludes ordinary bodies', () => {
    expect(listAttachments('Hello', parseHeaders('Content-Type: text/plain'))).toEqual([]);
  });

  it('leaves an inline image out of the list only while the HTML shows it', () => {
    const shown = parseHeaders('Content-Type: multipart/related; boundary="rel"');
    const image = [
      '--rel',
      'Content-Type: image/png; name=logo.png',
      'Content-Disposition: inline; filename=logo.png',
      'Content-ID: <logo@x>',
      '',
      'AAAA',
      '--rel--',
    ];
    const withHtml = ['--rel', 'Content-Type: text/html', '', '<p><img src="cid:logo@x"></p>', ...image].join(CRLF);
    expect(listAttachments(withHtml, shown)).toEqual([]);
    // The same part under HTML that never refers to it is a file to hand over.
    const unshown = ['--rel', 'Content-Type: text/html', '', '<p>no logo here</p>', ...image].join(CRLF);
    expect(listAttachments(unshown, shown).map((a) => a.filename)).toEqual(['logo.png']);
    // And so is a message that is nothing but the image.
    const alone = parseHeaders('Content-Type: image/png; name=logo.png\r\n'
      + 'Content-Disposition: inline\r\nContent-ID: <logo>');
    expect(listAttachments('data', alone).map((a) => a.filename)).toEqual(['logo.png']);
  });

  it('lists the photo Apple Mail puts inline in a plain text message', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="mix"');
    const body = [
      '--mix',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Here is the photo.',
      '--mix',
      'Content-Type: image/jpeg; name=IMG_0001.jpeg',
      'Content-Disposition: inline; filename=IMG_0001.jpeg',
      'Content-Id: <ABC123@apple>',
      'Content-Transfer-Encoding: base64',
      '',
      '/9j/4AAQ',
      '--mix--',
    ].join(CRLF);
    expect(listAttachments(body, headers).map((a) => [a.filename, a.type])).toEqual([['IMG_0001.jpeg', 'image/jpeg']]);
    // Unnamed, it is still an image nothing else in the message shows.
    const unnamed = body.replace('; name=IMG_0001.jpeg', '').replace('; filename=IMG_0001.jpeg', '');
    expect(listAttachments(unnamed, headers).map((a) => a.filename)).toEqual(['image.jpeg']);
  });

  it('lists a message attached whole as an .eml named after its subject', () => {
    const headers = parseHeaders('Content-Type: multipart/mixed; boundary="mix"');
    const forwarded = (disposition) => [
      '--mix',
      'Content-Type: text/plain',
      '',
      'See attached.',
      '--mix',
      'Content-Type: message/rfc822',
      ...(disposition ? [disposition] : []),
      '',
      'From: c@d.co',
      'Subject: =?utf-8?Q?Re=3A_Q3=2FQ4_plan?=',
      'Content-Type: text/plain',
      '',
      'Original body',
      '--mix--',
    ].join(CRLF);
    // Outlook says nothing about its disposition; Apple Mail says inline.
    for (const disposition of [null, 'Content-Disposition: inline', 'Content-Disposition: attachment']) {
      const [attachment] = listAttachments(forwarded(disposition), headers);
      expect(attachment.filename).toBe('Re: Q3-Q4 plan.eml');
      expect(attachment.type).toBe('message/rfc822');
      expect(new TextDecoder().decode(attachment.bytes())).toContain('Original body');
    }
    // A name the sender gave is kept.
    const named = listAttachments(forwarded('Content-Disposition: attachment; filename="note.eml"'), headers);
    expect(named[0].filename).toBe('note.eml');
    // The attached message is not the text of the one carrying it.
    expect(extractText(forwarded(null), headers)).toBe('See attached.');
  });
});
