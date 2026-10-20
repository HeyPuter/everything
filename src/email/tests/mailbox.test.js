import { describe, it, expect, vi } from 'vitest';
import {
  createMailbox, enrichMessage, uuidv7, mailFilename, dayFolder, fileSentCopy,
  moveMessage, boxPath, BOX_DIRS,
} from '../src/lib/mailbox.js';
import { subjectFromFilename } from '../src/lib/mime.js';

const OBJECTS = '/user/.mail/objects';

/**
 * Minimal fs over `{ day: { filename: rawMessage } }`, mirroring the shape
 * puter.fs.readdir/read return for the emailrx mailbox layout.
 */
const makeFs = (tree, { failDays = [] } = {}) => ({
  async readdir(path) {
    if (path === OBJECTS) {
      return Object.keys(tree).map((day) => ({ name: day, path: `${OBJECTS}/${day}`, is_dir: true }));
    }
    const day = path.split('/').pop();
    if (failDays.includes(day)) throw new Error('forbidden');
    if (!tree[day]) throw new Error('not found');
    return Object.keys(tree[day]).map((name) => ({
      name, path: `${path}/${name}`, is_dir: false, size: tree[day][name].length, modified: 0,
    }));
  },
  async read(path, opts = {}) {
    const [, day, name] = path.match(/objects\/([^/]+)\/(.+)$/) || [];
    const raw = tree[day]?.[name];
    if (raw === undefined) throw new Error('not found');
    return new Blob([opts.byte_count ? raw.slice(0, opts.byte_count) : raw]);
  },
});

const rawMessage = (over = {}) => [
  `From: ${over.from ?? 'Jane Doe <jane@example.com>'}`,
  'To: you@puter.com',
  ...(over.subject === undefined ? ['Subject: Hello'] : over.subject ? [`Subject: ${over.subject}`] : []),
  `Date: ${over.date ?? 'Mon, 17 Aug 2026 10:30:00 GMT'}`,
  `Content-Type: ${over.contentType ?? 'text/plain; charset=utf-8'}`,
  '',
  over.body ?? 'The body of the message.',
].join('\r\n');

describe('createMailbox', () => {
  it('lists messages newest-first across days and within a day', async () => {
    const fs = makeFs({
      '2026-08-10': { '01aa--x': rawMessage(), '01ab--y': rawMessage() },
      '2026-08-12': { '01ba--z': rawMessage() },
    });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    expect(mailbox.messages.map((m) => m.name)).toEqual(['01ba--z', '01ab--y', '01aa--x']);
    expect(mailbox.hasMore).toBe(false);
  });

  it('pages newest first across day folders', async () => {
    const fs = makeFs({
      '2026-08-01': { 'a--1': rawMessage() },
      '2026-08-02': { 'b--1': rawMessage(), 'b--2': rawMessage() },
      '2026-08-03': { 'c--1': rawMessage(), 'c--2': rawMessage() },
    });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS, pageSize: 2 });
    await mailbox.open();
    expect(mailbox.messages).toHaveLength(2);
    expect(mailbox.messages[0].day).toBe('2026-08-03');
    expect(mailbox.hasMore).toBe(true);

    const added = await mailbox.loadMore();
    expect(added).toHaveLength(2);
    expect(mailbox.messages).toHaveLength(4);
    expect(mailbox.hasMore).toBe(true);

    await mailbox.loadMore();
    expect(mailbox.messages).toHaveLength(5);
    expect(mailbox.hasMore).toBe(false);
  });

  it('skips day folders that fail to list', async () => {
    const fs = makeFs({
      '2026-08-01': { 'a--1': rawMessage() },
      '2026-08-02': { 'b--1': rawMessage() },
    }, { failDays: ['2026-08-02'] });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    expect(mailbox.messages.map((m) => m.day)).toEqual(['2026-08-01']);
  });

  it('retries failed days in order while still allowing readable days to load', async () => {
    const failed = ['2026-08-03'];
    const mailbox = createMailbox({ fs: makeFs({
      '2026-08-01': { 'a--1': rawMessage() },
      '2026-08-02': { 'b--1': rawMessage() },
      '2026-08-03': { 'c--1': rawMessage() },
    }, { failDays: failed }), objectsPath: OBJECTS, pageSize: 1 });
    await mailbox.open();
    expect(mailbox.messages.map((m) => m.name)).toEqual(['b--1']);
    expect(mailbox.listError?.message).toBe('forbidden');
    failed.length = 0;
    await mailbox.loadMore();
    expect(mailbox.messages.map((m) => m.name)).toEqual(['c--1', 'b--1']);
    expect(mailbox.listError).toBeNull();
    expect(mailbox.hasMore).toBe(true);
    await mailbox.loadMore();
    expect(mailbox.messages.map((m) => m.name)).toEqual(['c--1', 'b--1', 'a--1']);
    expect(mailbox.hasMore).toBe(false);
  });

  it('keeps the final failed day available for retry without reloading earlier pages', async () => {
    const failed = [];
    const mailbox = createMailbox({ fs: makeFs({
      '2026-08-01': { 'a--1': rawMessage() },
      '2026-08-02': { 'b--1': rawMessage() },
    }, { failDays: failed }), objectsPath: OBJECTS, pageSize: 1 });
    await mailbox.open();
    const before = mailbox.messages[0];
    failed.push('2026-08-01');
    expect(await mailbox.loadMore()).toEqual([]);
    expect(mailbox.hasMore).toBe(true);
    failed.length = 0;
    expect((await mailbox.loadMore()).map((m) => m.name)).toEqual(['a--1']);
    expect(mailbox.messages[0]).toBe(before);
    expect(mailbox.hasMore).toBe(false);
  });

  it('does not duplicate a retried day that a new-mail check has already recovered', async () => {
    const failed = ['2026-08-02'];
    const mailbox = createMailbox({ fs: makeFs({
      '2026-08-01': { 'a--1': rawMessage() },
      '2026-08-02': { 'b--1': rawMessage() },
    }, { failDays: failed }), objectsPath: OBJECTS });
    await mailbox.open();
    failed.length = 0;
    await mailbox.sync();
    expect(await mailbox.loadMore()).toEqual([]);
    expect(mailbox.messages.map((m) => m.name)).toEqual(['b--1', 'a--1']);
    expect(mailbox.hasMore).toBe(false);
  });

  it('deduplicates a restored message after filling a newer gap in the same retry', async () => {
    const failed = ['2026-08-03', '2026-08-02'];
    const mailbox = createMailbox({ fs: makeFs({
      '2026-08-01': { 'a--1': rawMessage() },
      '2026-08-02': { 'b--1': rawMessage() },
      '2026-08-03': { 'c--1': rawMessage() },
    }, { failDays: failed }), objectsPath: OBJECTS });
    await mailbox.open();
    failed.length = 0;
    const catalog = await mailbox.listAll();
    mailbox.insert(catalog.find((m) => m.name === 'b--1'));
    expect((await mailbox.loadMore()).map((m) => m.name)).toEqual(['c--1']);
    expect(mailbox.messages.map((m) => m.name)).toEqual(['c--1', 'b--1', 'a--1']);
  });

  it('treats a missing objects folder as an empty inbox', async () => {
    const fs = { async readdir() { throw new Error('not found'); } };
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    expect(mailbox.messages).toHaveLength(0);
    expect(mailbox.hasMore).toBe(false);
  });

  it('decodes the subject embedded in the filename', async () => {
    const b64 = btoa('From the filename').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fs = makeFs({ '2026-08-01': { [`a--${b64}`]: rawMessage() } });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    expect(mailbox.messages[0].subject).toBe('From the filename');
  });

  it('re-opening resets the list instead of appending', async () => {
    const fs = makeFs({ '2026-08-01': { 'a--1': rawMessage() } });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    await mailbox.open();
    expect(mailbox.messages).toHaveLength(1);
  });

  it('reports why it could not list, and clears that on the next success', async () => {
    let broken = true;
    const good = makeFs({ '2026-08-01': { 'a--1': rawMessage() } });
    const fs = {
      readdir: (path) => (broken ? Promise.reject(new Error('offline')) : good.readdir(path)),
      read: (...args) => good.read(...args),
    };
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });

    await mailbox.open();
    expect(mailbox.listError?.message).toBe('offline');
    expect(mailbox.messages).toHaveLength(0);

    broken = false;
    await mailbox.open();
    expect(mailbox.listError).toBeNull();
    expect(mailbox.messages).toHaveLength(1);
  });

  it('keeps the messages it already listed when a re-open cannot list', async () => {
    let broken = false;
    const good = makeFs({ '2026-08-01': { 'a--1': rawMessage() } });
    const fs = {
      readdir: (path) => (broken ? Promise.reject(new Error('offline')) : good.readdir(path)),
      read: (...args) => good.read(...args),
    };
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    const listed = mailbox.messages.slice();

    broken = true;
    await mailbox.open();
    // A failed read must not read as "the mail is gone".
    expect(mailbox.messages).toEqual(listed);
    expect(mailbox.listError?.message).toBe('offline');
  });

  it('has no listError before anything has gone wrong', async () => {
    const fs = makeFs({ '2026-08-01': { 'a--1': rawMessage() } });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    expect(mailbox.listError).toBeNull();
    await mailbox.open();
    expect(mailbox.listError).toBeNull();
  });
});

describe('enrichMessage', () => {
  const messageFor = (name) => ({ path: `${OBJECTS}/2026-08-17/${name}`, name, subject: '' });

  it('parses sender, date, and a body snippet from the header chunk', async () => {
    const fs = makeFs({ '2026-08-17': { 'a--x': rawMessage() } });
    const patch = await enrichMessage(fs, messageFor('a--x'));
    expect(patch.from).toEqual({ name: 'Jane Doe', email: 'jane@example.com' });
    expect(patch.date.getUTCFullYear()).toBe(2026);
    expect(patch.snippet).toBe('The body of the message.');
    expect(patch.hasAttachments).toBe(false);
  });

  it('leaves the quoted copy of the previous message out of the preview line', async () => {
    const fs = makeFs({
      '2026-08-17': {
        'aa--x': rawMessage({
          body: [
            'Two o\'clock is perfect.', '', 'Priya', '',
            'On Wednesday, Tom Beckett wrote:',
            '> Thursday works. Shall we say two?',
            '> I\'ll have the numbers ready.',
          ].join('\r\n'),
        }),
      },
    });
    const patch = await enrichMessage(fs, { path: `${OBJECTS}/2026-08-17/aa--x`, name: 'aa--x' });
    expect(patch.snippet).toBe("Two o'clock is perfect. Priya");
  });

  it('shows a message that is nothing but a quote rather than an empty line', async () => {
    const fs = makeFs({
      '2026-08-17': {
        'aa--x': rawMessage({ body: '> Thursday works.\r\n> I\'ll have the numbers ready.' }),
      },
    });
    const patch = await enrichMessage(fs, { path: `${OBJECTS}/2026-08-17/aa--x`, name: 'aa--x' });
    expect(patch.snippet).toBe("> Thursday works. > I'll have the numbers ready.");
  });

  it('reads a sender written the old way, with the name in a comment', async () => {
    const fs = makeFs({
      '2026-08-17': { 'aa--x': rawMessage({ from: 'cron@host.example (Cron Daemon)' }) },
    });
    const patch = await enrichMessage(fs, { path: `${OBJECTS}/2026-08-17/aa--x`, name: 'aa--x' });
    expect(patch.from.email).toBe('cron@host.example');
  });

  it('falls back to the Subject header when the filename had none', async () => {
    const fs = makeFs({ '2026-08-17': { 'a--x': rawMessage({ subject: 'Header subject' }) } });
    const patch = await enrichMessage(fs, messageFor('a--x'));
    expect(patch.subject).toBe('Header subject');
  });

  it('flags multipart/mixed messages as carrying attachments', async () => {
    const raw = rawMessage({ contentType: 'multipart/mixed; boundary="b"', body: '--b\r\n\r\nx\r\n--b--' });
    const fs = makeFs({ '2026-08-17': { 'a--x': raw } });
    const patch = await enrichMessage(fs, messageFor('a--x'));
    expect(patch.hasAttachments).toBe(true);
  });

  it('carries the headers the conversation view groups on', async () => {
    const raw = [
      'From: Jane Doe <jane@example.com>',
      'To: you@puter.com',
      'Subject: Re: Hello',
      'Date: Mon, 17 Aug 2026 10:30:00 GMT',
      'Message-ID: <two@example.com>',
      'In-Reply-To: <one@example.com>',
      'References: <one@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Answering the first one.',
    ].join('\r\n');
    const fs = makeFs({ '2026-08-17': { 'a--x': raw } });
    const patch = await enrichMessage(fs, messageFor('a--x'));
    // The same 8 KB head read the sender and the preview line come from, so
    // grouping a folder costs no reads of its own.
    expect(patch.messageId).toBe('<two@example.com>');
    expect(patch.references).toEqual(['<one@example.com>']);
  });

  it('records a message with no Message-ID as having none', async () => {
    // An empty id is an answer, so the head is not read again looking for one.
    const fs = makeFs({ '2026-08-17': { 'a--x': rawMessage() } });
    const patch = await enrichMessage(fs, messageFor('a--x'));
    expect(patch.messageId).toBe('');
    expect(patch.references).toEqual([]);
  });

  it('reads only the requested head bytes of large messages', async () => {
    const raw = rawMessage({ body: 'start of body. ' + 'x'.repeat(50_000) });
    const fs = makeFs({ '2026-08-17': { 'a--x': raw } });
    let requested = null;
    const spyFs = { read: (path, opts) => { requested = opts.byte_count; return fs.read(path, opts); } };
    const patch = await enrichMessage(spyFs, messageFor('a--x'));
    expect(requested).toBeGreaterThan(0);
    expect(requested).toBeLessThan(50_000);
    expect(patch.snippet.startsWith('start of body.')).toBe(true);
  });

  it.each([false, true])('bounds preview parsing when the server ignores byte limits (long headers: %s)', async (longHeaders) => {
    const raw = (longHeaders ? `X-Relay: ${'x'.repeat(9000)}\r\n` : '')
      + rawMessage({ body: 'Visible preview. ' + 'x'.repeat(2 * 1024 * 1024) });
    const blob = new Blob([raw]);
    // Converting the oversized response itself would allocate the entire
    // attachment in JS; only bounded slices may be converted.
    blob.arrayBuffer = () => { throw new Error('Unbounded response conversion'); };
    const fs = { read: vi.fn(async () => blob) };
    const patch = await enrichMessage(fs, messageFor('a--x'));
    expect(patch.unreadable).toBe(false);
    expect(patch.from.email).toBe('jane@example.com');
    expect(patch.snippet).toMatch(/^Visible preview\./);
    expect(fs.read).toHaveBeenCalledTimes(longHeaders ? 2 : 1);
  });

  it('reads further when the header block runs past the first read', async () => {
    // A dozen relay and authentication headers of most of a kilobyte each,
    // with everything the row shows after them -- the shape of mail that has
    // been through a few hops.
    const filler = Array.from({ length: 12 }, (unused, i) => `ARC-Seal-${i}: ${'x'.repeat(900)}`);
    const raw = [
      'Received: from relay.example by mx.puter.email',
      ...filler,
      'From: Ana Petrova <ana@example.com>',
      'To: you@puter.com',
      'Subject: Big headers',
      'Message-ID: <big@example.com>',
      'Date: Mon, 17 Aug 2026 10:30:00 GMT',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hello from behind the headers.',
    ].join('\r\n');
    expect(raw.indexOf('\r\n\r\n')).toBeGreaterThan(8192);
    const fs = makeFs({ '2026-08-17': { 'a--x': raw } });
    const requested = [];
    const spyFs = { read: (path, opts) => { requested.push(opts.byte_count); return fs.read(path, opts); } };
    const patch = await enrichMessage(spyFs, messageFor('a--x'));
    // Two reads: the ordinary head, then one long enough for this message.
    expect(requested).toHaveLength(2);
    expect(requested[1]).toBeGreaterThan(raw.indexOf('\r\n\r\n'));
    expect(patch.from).toEqual({ name: 'Ana Petrova', email: 'ana@example.com' });
    expect(patch.snippet).toBe('Hello from behind the headers.');
    expect(patch.messageId).toBe('<big@example.com>');
  });

  it('does not read twice for a message whose head fits, or whose file ends inside it', async () => {
    const fs = makeFs({ '2026-08-17': { 'a--x': rawMessage(), 'b--x': 'From: a@b.co\r\nSubject: cut' } });
    const requested = [];
    const spyFs = { read: (path, opts) => { requested.push(opts.byte_count); return fs.read(path, opts); } };
    await enrichMessage(spyFs, messageFor('a--x'));
    // A file that is all headers and shorter than the read has nothing more
    // to give: reading it again would find the same bytes.
    const patch = await enrichMessage(spyFs, messageFor('b--x'));
    expect(requested).toHaveLength(2);
    expect(patch.from.email).toBe('a@b.co');
  });

  it('names a sender for a message with no From header', async () => {
    const raw = ['To: you@puter.com', 'Subject: Hello', '', 'body'].join('\r\n');
    const fs = makeFs({ '2026-08-17': { 'a--x': raw } });
    const patch = await enrichMessage(fs, messageFor('a--x'));
    expect(patch.from).toEqual({ name: '(unknown sender)', email: '' });
  });

  it('parses the recipient list, for folders that show who a message went to', async () => {
    const raw = [
      'From: alice@puter.email',
      'To: "Doe, Jane" <jane@x.co>, bob@y.co',
      'Subject: Hello',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
    ].join('\r\n');
    const fs = makeFs({ '2026-08-17': { 'a--x': raw } });
    const patch = await enrichMessage(fs, messageFor('a--x'));
    expect(patch.to).toEqual([
      { name: 'Doe, Jane', email: 'jane@x.co' },
      { name: 'bob@y.co', email: 'bob@y.co' },
    ]);
  });

  it('marks unreadable messages instead of throwing', async () => {
    const fs = { async read() { throw new Error('denied'); } };
    const patch = await enrichMessage(fs, messageFor('a--x'));
    expect(patch.from.name).toBe('(unreadable)');
    // The caller keys "do not cache this" off the flag, so it has to be there
    // on the failure and gone on a later success.
    expect(patch.unreadable).toBe(true);
  });

  it('says a message that did read is not unreadable', async () => {
    const fs = makeFs({ '2026-08-17': { 'a--x': rawMessage() } });
    expect((await enrichMessage(fs, messageFor('a--x'))).unreadable).toBe(false);
  });
});


describe('createMailbox over a second folder', () => {
  it('tags every message with the box it came from', async () => {
    const fs = makeFs({ '2026-08-17': { 'a--x': rawMessage() } });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS, box: 'sent' });
    await mailbox.open();
    expect(mailbox.box).toBe('sent');
    expect(mailbox.messages.map((m) => m.box)).toEqual(['sent']);
  });

  it('defaults the tag to inbox', async () => {
    const fs = makeFs({ '2026-08-17': { 'a--x': rawMessage() } });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    expect(mailbox.messages[0].box).toBe('inbox');
  });
});

describe('uuidv7', () => {
  const zeros = new Uint8Array(10);

  it('is a valid v7 uuid', () => {
    expect(uuidv7(1_755_900_000_000, zeros))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('sorts as text in the order the messages happened', () => {
    const times = [1, 1000, 60_000, 86_400_000, 1_755_900_000_000, 1_755_900_000_001];
    const ids = times.map((ms) => uuidv7(ms, zeros));
    expect([...ids].sort()).toEqual(ids);
  });

  it('leaves the timestamp in the first 48 bits', () => {
    const ms = 1_755_900_000_000;
    const id = uuidv7(ms, zeros);
    expect(parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(ms);
  });

  it('differs between calls at the same millisecond', () => {
    expect(uuidv7(1000)).not.toBe(uuidv7(1000));
  });
});

describe('mailFilename', () => {
  const date = new Date('2026-08-22T09:30:00Z');

  it('is <uuidv7>--<base64url subject>, which subjectFromFilename reads back', () => {
    const name = mailFilename('Réservation — 会議 🎉', date);
    expect(name).toMatch(/^[0-9a-f-]{36}--/);
    expect(subjectFromFilename(name)).toBe('Réservation — 会議 🎉');
  });

  it('uses a url-safe alphabet with no padding', () => {
    const name = mailFilename('subject ÿÿÿ?', date);
    expect(name.slice(name.indexOf('--') + 2)).toMatch(/^[A-Za-z0-9_-]*$/);
  });

  it('reads back an empty subject', () => {
    expect(subjectFromFilename(mailFilename('', date))).toBe('');
  });
});

describe('dayFolder', () => {
  it('is the UTC date, so it agrees with the uuid timestamp', () => {
    expect(dayFolder(new Date('2026-08-22T23:30:00Z'))).toBe('2026-08-22');
    expect(dayFolder(new Date('2026-08-23T00:30:00Z'))).toBe('2026-08-23');
  });
});

describe('fileSentCopy', () => {
  const date = new Date('2026-08-22T09:30:00Z');
  const raw = 'From: alice@puter.email\r\nSubject: Hi\r\n\r\nbody\r\n';

  const spyFs = (over = {}) => {
    const writes = [];
    return {
      writes,
      async write(path, data, opts) {
        writes.push({ path, data, opts });
        if (over.fail) throw new Error('denied');
        return { path };
      },
    };
  };

  it('writes the exact bytes into .mail/sent/<day>/<uuidv7>--<subject>', async () => {
    const fs = spyFs();
    const path = await fileSentCopy({ fs, mailPath: '/alice/.mail', raw, subject: 'Hi', date });
    expect(path).toBe(fs.writes[0].path);
    expect(path.startsWith('/alice/.mail/sent/2026-08-22/')).toBe(true);
    expect(subjectFromFilename(path.split('/').pop())).toBe('Hi');
    expect(await fs.writes[0].data.text()).toBe(raw);
    expect(fs.writes[0].opts.createMissingParents).toBe(true);
  });

  it('is a sibling of objects/, so a sent copy is never in the inbox listing', async () => {
    const fs = spyFs();
    const path = await fileSentCopy({ fs, mailPath: '/alice/.mail', raw, subject: 'Hi', date });
    expect(path).not.toContain('/objects/');
  });

  it('files two messages in the same millisecond under different names', async () => {
    const fs = spyFs();
    const a = await fileSentCopy({ fs, mailPath: '/alice/.mail', raw, subject: 'Hi', date });
    const b = await fileSentCopy({ fs, mailPath: '/alice/.mail', raw, subject: 'Hi', date });
    expect(a).not.toBe(b);
  });

  it('lets a failed write through to the caller', async () => {
    await expect(fileSentCopy({ fs: spyFs({ fail: true }), mailPath: '/alice/.mail', raw, subject: 'Hi', date }))
      .rejects.toThrow('denied');
  });
});


describe('remove and insert', () => {
  const tree = {
    '2026-08-18': { 'b2--x': rawMessage(), 'b1--x': rawMessage() },
    '2026-08-17': { 'a2--x': rawMessage(), 'a1--x': rawMessage() },
  };
  const names = (mailbox) => mailbox.messages.map((m) => m.name);

  it('takes a message out without touching the paging cursor', async () => {
    const fs = makeFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS, pageSize: 2 });
    await mailbox.open();
    expect(names(mailbox)).toEqual(['b2--x', 'b1--x']);
    expect(mailbox.hasMore).toBe(true);

    mailbox.remove(mailbox.messages[0]);
    expect(names(mailbox)).toEqual(['b1--x']);
    expect(mailbox.hasMore).toBe(true);

    // The next batch still starts where the listing left off.
    await mailbox.loadMore();
    expect(names(mailbox)).toEqual(['b1--x', 'a2--x', 'a1--x']);
  });

  it('reports the index it removed from, and ignores a message it does not hold', async () => {
    const fs = makeFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    const [, second] = mailbox.messages;
    expect(mailbox.remove(second)).toBe(1);
    expect(mailbox.remove(second)).toBe(-1);
    expect(mailbox.messages).toHaveLength(3);
  });

  it('puts a message back in its chronological place, not at the end', async () => {
    const fs = makeFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    const message = mailbox.messages[1];
    mailbox.remove(message);
    expect(mailbox.insert(message)).toBe(1);
    expect(names(mailbox)).toEqual(['b2--x', 'b1--x', 'a2--x', 'a1--x']);
  });

  it('places a restored message after mail that arrived while it was away', async () => {
    const fs = makeFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    const oldest = mailbox.messages[3];
    mailbox.remove(oldest);
    mailbox.messages.unshift({ name: 'c9--x', day: '2026-08-19' });
    expect(mailbox.insert(oldest)).toBe(4);
    expect(names(mailbox)).toEqual(['c9--x', 'b2--x', 'b1--x', 'a2--x', 'a1--x']);
  });
});

describe('boxPath', () => {
  it('puts every folder beside objects/ under .mail', () => {
    expect(boxPath('/alice/.mail', 'inbox')).toBe('/alice/.mail/objects');
    expect(boxPath('/alice/.mail', 'sent')).toBe('/alice/.mail/sent');
    expect(boxPath('/alice/.mail', 'archive')).toBe('/alice/.mail/archive');
    expect(boxPath('/alice/.mail', 'trash')).toBe('/alice/.mail/trash');
  });

  it('covers exactly the four folders the app knows about', () => {
    expect(Object.keys(BOX_DIRS)).toEqual(['inbox', 'sent', 'archive', 'trash']);
  });
});

describe('moveMessage', () => {
  const MAIL = '/user/.mail';
  const message = { name: 'a1--x', day: '2026-08-17', path: `${OBJECTS}/2026-08-17/a1--x` };

  /**
   * Stands in for puter.fs, which will not move a file into a folder that is
   * not there: `move` refuses a destination it cannot stat, and `mkdir` is
   * what makes one -- and refuses a folder that already exists.
   */
  const spyFs = ({ folders = [OBJECTS, `${OBJECTS}/2026-08-17`] } = {}) => {
    const made = new Set(folders);
    const calls = { mkdirs: [], moves: [] };
    return {
      calls,
      folders: made,
      async mkdir(path, opts) {
        calls.mkdirs.push({ path, opts });
        if (made.has(path)) throw new Error('item_with_same_name_exists');
        if (!opts?.createMissingParents && !made.has(path.slice(0, path.lastIndexOf('/')))) {
          throw new Error('parent not found');
        }
        made.add(path);
        return { path };
      },
      async move(from, to, opts) {
        calls.moves.push({ from, to, opts });
        if (!made.has(to)) throw new Error('subject_does_not_exist');
        return { path: `${to}/${opts.newName}` };
      },
    };
  };

  it('keeps the day folder and the filename, so flags and ordering survive', async () => {
    const fs = spyFs();
    const path = await moveMessage({ fs, mailPath: MAIL, message, to: 'trash' });
    expect(fs.calls.moves[0].from).toBe(message.path);
    expect(fs.calls.moves[0].to).toBe(`${MAIL}/trash/2026-08-17`);
    // Naming the file says the destination is a folder rather than the name
    // the file is to take.
    expect(fs.calls.moves[0].opts.newName).toBe('a1--x');
    expect(path).toBe(`${MAIL}/trash/2026-08-17/a1--x`);
  });

  it('makes the folder it is moving into, parents and all', async () => {
    const fs = spyFs();
    await moveMessage({ fs, mailPath: MAIL, message, to: 'archive' });
    // Nothing has ever created archive/ or the day folder under it: move does
    // not, and the whole thing came back 404 because of it.
    expect(fs.calls.mkdirs[0].path).toBe(`${MAIL}/archive/2026-08-17`);
    expect(fs.calls.mkdirs[0].opts.createMissingParents).toBe(true);
    expect(fs.folders.has(`${MAIL}/archive/2026-08-17`)).toBe(true);
  });

  it('files a second message on the same day into the folder it made', async () => {
    const fs = spyFs();
    await moveMessage({ fs, mailPath: MAIL, message, to: 'archive' });
    const second = { ...message, name: 'a2--x', path: `${OBJECTS}/2026-08-17/a2--x` };
    const path = await moveMessage({ fs, mailPath: MAIL, message: second, to: 'archive' });
    // The folder is already there, which mkdir says so by refusing; the move
    // is the operation that has to succeed.
    expect(path).toBe(`${MAIL}/archive/2026-08-17/a2--x`);
    expect(fs.calls.moves).toHaveLength(2);
  });

  it('reports a move that failed rather than the folder it could not make', async () => {
    const fs = spyFs();
    fs.mkdir = async () => { throw new Error('permission denied'); };
    await expect(moveMessage({ fs, mailPath: MAIL, message, to: 'archive' }))
      .rejects.toThrow('subject_does_not_exist');
  });

  it('asks for a day folder once across a bulk move', async () => {
    const fs = spyFs();
    const dirs = new Map();
    await Promise.all(Array.from({ length: 50 }, (unused, i) => moveMessage({
      fs, mailPath: MAIL, to: 'archive', dirs,
      message: { ...message, name: `a${i}--x`, path: `${OBJECTS}/2026-08-17/a${i}--x` },
    })));
    expect(fs.calls.mkdirs).toHaveLength(1);
    expect(fs.calls.moves).toHaveLength(50);
  });

  it('makes a remembered folder again when it has gone, or could not be made', async () => {
    const fs = spyFs();
    const dirs = new Map();
    await moveMessage({ fs, mailPath: MAIL, message, to: 'archive', dirs });
    fs.folders.delete(`${MAIL}/archive/2026-08-17`);
    const second = { ...message, name: 'a2--x', path: `${OBJECTS}/2026-08-17/a2--x` };
    expect(await moveMessage({ fs, mailPath: MAIL, message: second, to: 'archive', dirs }))
      .toBe(`${MAIL}/archive/2026-08-17/a2--x`);
    expect(fs.calls.mkdirs).toHaveLength(2);
    // A folder refused once (no write permission yet) is asked for again on
    // the retry that follows the grant.
    const refused = spyFs();
    const mkdir = refused.mkdir;
    refused.mkdir = async () => { throw new Error('permission denied'); };
    const later = new Map();
    await expect(moveMessage({ fs: refused, mailPath: MAIL, message, to: 'trash', dirs: later })).rejects.toThrow();
    refused.mkdir = mkdir;
    expect(await moveMessage({ fs: refused, mailPath: MAIL, message, to: 'trash', dirs: later }))
      .toBe(`${MAIL}/trash/2026-08-17/a1--x`);
  });

  it('is exactly reversible, which is what undo relies on', async () => {
    const fs = spyFs();
    const moved = { ...message, path: await moveMessage({ fs, mailPath: MAIL, message, to: 'archive' }) };
    const back = await moveMessage({ fs, mailPath: MAIL, message: moved, to: 'inbox' });
    expect(back).toBe(message.path);
  });
});


describe('sync', () => {
  const names = (mailbox) => mailbox.messages.map((m) => m.name);

  it('recovers every arrival when one day fails during a check across midnight', async () => {
    const tree = { '2026-08-17': { 'a1--x': rawMessage() } };
    const failed = [];
    const mailbox = createMailbox({ fs: makeFs(tree, { failDays: failed }), objectsPath: OBJECTS });
    await mailbox.open();
    const before = mailbox.messages[0];
    await mailbox.listAll();
    tree['2026-08-17']['a2--x'] = rawMessage();
    tree['2026-08-18'] = { 'b1--x': rawMessage() };
    failed.push('2026-08-17');
    await mailbox.sync();
    failed.length = 0;
    await mailbox.sync();
    expect(names(mailbox)).toEqual(['b1--x', 'a2--x', 'a1--x']);
    expect(mailbox.messages[2]).toBe(before);
    expect((await mailbox.listAll()).map((m) => m.name)).toEqual(names(mailbox));
    expect(await mailbox.sync()).toEqual([]);
  });

  it('does not record an arrival as handled until every relevant day was read', async () => {
    const tree = { '2026-08-17': { 'a1--x': rawMessage() } };
    const failed = [];
    const mailbox = createMailbox({ fs: makeFs(tree, { failDays: failed }), objectsPath: OBJECTS });
    await mailbox.open();
    tree['2026-08-18'] = { 'b1--x': rawMessage() };
    failed.push('2026-08-17');
    expect(await mailbox.sync()).toEqual([]);
    expect(mailbox.find('b1--x')).toBeNull();
    expect(names(mailbox)).toEqual(['a1--x']);
    expect(mailbox.listError?.message).toBe('forbidden');
    failed.length = 0;
    expect((await mailbox.sync()).map((m) => m.name)).toEqual(['b1--x']);
    expect(mailbox.listError).toBeNull();
  });

  it('lists nothing when nothing has arrived', async () => {
    const tree = { '2026-08-17': { 'a2--x': rawMessage(), 'a1--x': rawMessage() } };
    const fs = makeFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    expect(await mailbox.sync()).toEqual([]);
    expect(names(mailbox)).toEqual(['a2--x', 'a1--x']);
  });

  it('prepends only what is newer, keeping the message objects it already had', async () => {
    const tree = { '2026-08-17': { 'a1--x': rawMessage() } };
    const fs = makeFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    const before = mailbox.messages[0];
    before.from = { name: 'already read', email: 'a@b.co' };

    tree['2026-08-17']['a2--x'] = rawMessage();
    tree['2026-08-18'] = { 'b1--x': rawMessage() };
    const added = await mailbox.sync();

    expect(added.map((m) => m.name)).toEqual(['b1--x', 'a2--x']);
    expect(names(mailbox)).toEqual(['b1--x', 'a2--x', 'a1--x']);
    // The header read that the row already did is not thrown away.
    expect(mailbox.messages[2]).toBe(before);
    expect(mailbox.messages[2].from.name).toBe('already read');
  });

  it('does not read day folders older than the newest message it holds', async () => {
    const tree = {
      '2026-08-18': { 'b1--x': rawMessage() },
      '2026-08-17': { 'a1--x': rawMessage() },
      '2026-08-16': { 'z1--x': rawMessage() },
    };
    const read = [];
    const fs = makeFs(tree);
    const spy = { ...fs, readdir: (path) => { read.push(path); return fs.readdir(path); } };
    const mailbox = createMailbox({ fs: spy, objectsPath: OBJECTS });
    await mailbox.open();
    read.length = 0;

    await mailbox.sync();
    expect(read).toEqual([OBJECTS, `${OBJECTS}/2026-08-18`]);
  });

  it('falls back to a full listing when nothing has been listed yet', async () => {
    const fs = makeFs({ '2026-08-17': { 'a1--x': rawMessage() } });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    expect((await mailbox.sync()).map((m) => m.name)).toEqual(['a1--x']);
  });

  it('does not hand back the older page as arrivals once the loaded page has been emptied', async () => {
    const tree = {
      '2026-08-18': { 'b1--x': rawMessage() },
      '2026-08-17': { 'a1--x': rawMessage() },
    };
    const fs = makeFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS, pageSize: 1 });
    await mailbox.open();
    expect(names(mailbox)).toEqual(['b1--x']);

    // Archive everything on the page: the page is empty, the folder is not.
    mailbox.remove(mailbox.messages[0]);
    expect(await mailbox.sync()).toEqual([]);
    expect(names(mailbox)).toEqual([]);
    expect(mailbox.hasMore).toBe(true);

    // What does land is still found, and only that; the older page is still
    // where "Load older messages" left it.
    tree['2026-08-18']['b2--x'] = rawMessage();
    expect((await mailbox.sync()).map((m) => m.name)).toEqual(['b2--x']);
    await mailbox.loadMore();
    expect(names(mailbox)).toEqual(['b2--x', 'a1--x']);
  });

  it('checks above a message put back by undo, not only above what was listed', async () => {
    const tree = { '2026-08-17': { 'a1--x': rawMessage() } };
    const fs = makeFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    const [first] = mailbox.messages;
    mailbox.remove(first);
    mailbox.insert(first);
    tree['2026-08-17']['a2--x'] = rawMessage();
    expect((await mailbox.sync()).map((m) => m.name)).toEqual(['a2--x']);
    expect(names(mailbox)).toEqual(['a2--x', 'a1--x']);
  });

  it('reports a failed listing without dropping the messages on screen', async () => {
    const fs = makeFs({ '2026-08-17': { 'a1--x': rawMessage() } });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    const broken = { ...fs, readdir: async () => { throw new Error('offline'); } };
    const offline = createMailbox({ fs: broken, objectsPath: OBJECTS });
    offline.messages.push(...mailbox.messages);
    expect(await offline.sync()).toEqual([]);
    expect(offline.listError).toBeTruthy();
    expect(names(offline)).toEqual(['a1--x']);
  });

  it('leaves the paging cursor alone, so "load older" still works after a sync', async () => {
    const tree = {
      '2026-08-18': { 'b1--x': rawMessage() },
      '2026-08-17': { 'a1--x': rawMessage() },
    };
    const fs = makeFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS, pageSize: 1 });
    await mailbox.open();
    expect(names(mailbox)).toEqual(['b1--x']);

    tree['2026-08-18']['b2--x'] = rawMessage();
    await mailbox.sync();
    expect(names(mailbox)).toEqual(['b2--x', 'b1--x']);
    expect(mailbox.hasMore).toBe(true);
    await mailbox.loadMore();
    expect(names(mailbox)).toEqual(['b2--x', 'b1--x', 'a1--x']);
  });
});


describe('listAll', () => {
  it.each(['subject_does_not_exist', 'not_found'])('treats a missing root (%s) as empty without caching it', async (code) => {
    const good = makeFs({ '2026-08-18': { 'a--1': rawMessage() } });
    let missing = true;
    const fs = { ...good, readdir: (path) => {
      if (missing) return Promise.reject({ code });
      return good.readdir(path);
    } };
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    expect(await mailbox.listAll()).toEqual([]);
    expect(mailbox.total).toBeNull();
    missing = false;
    expect(await mailbox.listAll()).toHaveLength(1);
  });

  it('does not hide a missing day inside an existing folder', async () => {
    const good = makeFs({ '2026-08-18': { 'a--1': rawMessage() } });
    const fs = { ...good, readdir: (path) => path === OBJECTS
      ? good.readdir(path) : Promise.reject({ code: 'subject_does_not_exist' }) };
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await expect(mailbox.listAll()).rejects.toMatchObject({ code: 'subject_does_not_exist' });
    expect(mailbox.total).toBeNull();
  });

  const tree = {
    '2026-08-18': { 'b2--x': rawMessage(), 'b1--x': rawMessage() },
    '2026-08-17': { 'a2--x': rawMessage(), 'a1--x': rawMessage() },
    '2026-08-16': { 'z1--x': rawMessage() },
  };

  it('does not cache an incomplete catalog when one day fails to list', async () => {
    const failed = ['2026-08-17'];
    const mailbox = createMailbox({ fs: makeFs(tree, { failDays: failed }), objectsPath: OBJECTS, pageSize: 2 });
    await mailbox.open();
    const first = mailbox.messages[0];
    await expect(mailbox.listAll()).rejects.toThrow('forbidden');
    expect(mailbox.total).toBeNull();
    expect(mailbox.messages).toHaveLength(2);
    failed.length = 0;
    const all = await mailbox.listAll();
    expect(all.map((m) => m.name)).toEqual(['b2--x', 'b1--x', 'a2--x', 'a1--x', 'z1--x']);
    expect(all[0]).toBe(first);
    expect(mailbox.total).toBe(5);
  });

  it('lists every message, not just the loaded pages', async () => {
    const mailbox = createMailbox({ fs: makeFs(tree), objectsPath: OBJECTS, pageSize: 2 });
    await mailbox.open();
    expect(mailbox.messages).toHaveLength(2);
    const all = await mailbox.listAll();
    expect(all.map((m) => m.name)).toEqual(['b2--x', 'b1--x', 'a2--x', 'a1--x', 'z1--x']);
    expect(mailbox.total).toBe(5);
  });

  it('reuses the message objects already listed, so rows and reads are not duplicated', async () => {
    const mailbox = createMailbox({ fs: makeFs(tree), objectsPath: OBJECTS, pageSize: 2 });
    await mailbox.open();
    const [first] = mailbox.messages;
    first.from = { name: 'already read', email: 'a@b.co' };
    const all = await mailbox.listAll();
    expect(all[0]).toBe(first);
    expect(all[0].from.name).toBe('already read');
  });

  it('lists once and answers from the catalog after that', async () => {
    const reads = [];
    const fs = makeFs(tree);
    const spy = { ...fs, readdir: (path) => { reads.push(path); return fs.readdir(path); } };
    const mailbox = createMailbox({ fs: spy, objectsPath: OBJECTS });
    await mailbox.open();
    reads.length = 0;
    await mailbox.listAll();
    const first = reads.length;
    await mailbox.listAll();
    expect(reads).toHaveLength(first);
  });

  it('lists several day folders at once, and still newest first however they answer', async () => {
    const wide = {};
    for (let d = 1; d <= 12; d++) wide[`2026-08-${String(d).padStart(2, '0')}`] = { [`m${d}--x`]: rawMessage() };
    const fs = makeFs(wide);
    let inFlight = 0;
    let peak = 0;
    const pending = [];
    const slow = { ...fs, readdir: (path) => {
      if (path === OBJECTS) return fs.readdir(path);
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => pending.push(() => { inFlight--; resolve(fs.readdir(path)); }));
    } };
    const mailbox = createMailbox({ fs: slow, objectsPath: OBJECTS });
    let done = false;
    const listing = mailbox.listAll().then((all) => { done = true; return all; });
    // Answer the day asked for last first, so the days come back out of order.
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      while (pending.length) pending.pop()();
    }
    const all = await listing;
    expect(peak).toBe(6);
    expect(all.map((m) => m.name)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((d) => `m${d}--x`));
    expect(mailbox.total).toBe(12);
  });

  it('reports progress as it goes, so a big mailbox can say what it is doing', async () => {
    const mailbox = createMailbox({ fs: makeFs(tree), objectsPath: OBJECTS });
    const seen = [];
    await mailbox.listAll({ onProgress: (n) => seen.push(n) });
    expect(seen).toEqual([2, 4, 5]);
  });

  it('keeps the catalog in step with archiving, deleting, and undo', async () => {
    const mailbox = createMailbox({ fs: makeFs(tree), objectsPath: OBJECTS });
    await mailbox.open();
    const all = await mailbox.listAll();
    const message = all[2];
    mailbox.remove(message);
    expect(mailbox.total).toBe(4);
    expect((await mailbox.listAll()).includes(message)).toBe(false);
    mailbox.insert(message);
    expect((await mailbox.listAll()).map((m) => m.name))
      .toEqual(['b2--x', 'b1--x', 'a2--x', 'a1--x', 'z1--x']);
  });

  it('takes new mail into the catalog when sync finds it', async () => {
    const live = { ...tree };
    const mailbox = createMailbox({ fs: makeFs(live), objectsPath: OBJECTS });
    await mailbox.open();
    await mailbox.listAll();
    live['2026-08-19'] = { 'c1--x': rawMessage() };
    await mailbox.sync();
    expect((await mailbox.listAll()).map((m) => m.name)[0]).toBe('c1--x');
    expect(mailbox.total).toBe(6);
  });

  it('is rebuilt after a re-listing rather than kept from before', async () => {
    const live = { '2026-08-18': { 'b1--x': rawMessage() } };
    const mailbox = createMailbox({ fs: makeFs(live), objectsPath: OBJECTS });
    await mailbox.open();
    await mailbox.listAll();
    expect(mailbox.total).toBe(1);
    delete live['2026-08-18']['b1--x'];
    live['2026-08-18']['b2--x'] = rawMessage();
    await mailbox.open();
    expect(mailbox.total).toBeNull();
    expect((await mailbox.listAll()).map((m) => m.name)).toEqual(['b2--x']);
  });
});

describe('one entry per message', () => {
  /**
   * The paged list and the search catalog are two views of the same folder.
   * A second entry object for a file one of them had already listed carried
   * its own row, its own header read and its own flags -- so the two views
   * disagreed about what the folder held.
   */
  it('pages in the entries the catalog already made', async () => {
    const fs = makeFs({
      '2026-08-01': { 'a--1': rawMessage() },
      '2026-08-02': { 'b--1': rawMessage() },
      '2026-08-03': { 'c--1': rawMessage() },
    });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS, pageSize: 1 });
    await mailbox.open();
    const catalog = await mailbox.listAll();
    await mailbox.loadMore();

    expect(mailbox.messages.find((m) => m.name === 'b--1'))
      .toBe(catalog.find((m) => m.name === 'b--1'));
  });

  it('takes a message out of the catalog when it leaves the folder', async () => {
    const fs = makeFs({
      '2026-08-01': { 'a--1': rawMessage() },
      '2026-08-02': { 'b--1': rawMessage() },
    });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS, pageSize: 1 });
    await mailbox.open();
    await mailbox.listAll();
    await mailbox.loadMore();

    mailbox.remove(mailbox.messages.find((m) => m.name === 'a--1'));
    // Left behind, a search would have offered a row for a file that has
    // been archived or deleted.
    expect((await mailbox.listAll()).map((m) => m.name)).toEqual(['b--1']);
  });

  it('does not list new mail twice when a search saw it first', async () => {
    const tree = { '2026-08-01': { 'a--1': rawMessage() } };
    const mailbox = createMailbox({ fs: makeFs(tree), objectsPath: OBJECTS });
    await mailbox.open();

    tree['2026-08-01']['b--1'] = rawMessage();
    const catalog = await mailbox.listAll();
    expect(catalog.map((m) => m.name)).toEqual(['b--1', 'a--1']);

    const added = await mailbox.sync();
    expect(added.map((m) => m.name)).toEqual(['b--1']);
    expect(mailbox.messages.map((m) => m.name)).toEqual(['b--1', 'a--1']);
    expect(catalog.map((m) => m.name)).toEqual(['b--1', 'a--1']);
  });

  it('restores a message into the catalog when the move is undone', async () => {
    const fs = makeFs({ '2026-08-01': { 'a--1': rawMessage(), 'a--2': rawMessage() } });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    const catalog = await mailbox.listAll();

    const [message] = mailbox.messages;
    mailbox.remove(message);
    mailbox.insert(message);
    expect(catalog.map((m) => m.name)).toEqual(['a--2', 'a--1']);

    // And the folder still knows it, so a re-listing does not make a second
    // entry for the same file.
    const again = await mailbox.sync();
    expect(again).toEqual([]);
    expect(mailbox.messages).toHaveLength(2);
  });
});

describe('listings that overlap', () => {
  const raw = rawMessage();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  // Every readdir takes a moment, which is what lets a second call arrive
  // while the first is still listing.
  const slowFs = (tree) => ({
    async readdir(path) {
      await tick();
      if (path === OBJECTS) {
        return Object.keys(tree).map((day) => ({ name: day, path: `${OBJECTS}/${day}`, is_dir: true }));
      }
      const day = path.split('/').pop();
      return Object.keys(tree[day]).map((name) => ({ name, path: `${path}/${name}`, is_dir: false }));
    },
    async read() { return new Blob([raw]); },
  });

  it('two opens a moment apart list every file once', async () => {
    const fs = slowFs({
      '2026-08-10': { '01aa--x': raw, '01ab--y': raw },
      '2026-08-12': { '01ba--z': raw },
    });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    const [first, second] = await Promise.all([mailbox.open(), mailbox.open()]);
    expect(mailbox.messages.map((m) => m.name)).toEqual(['01ba--z', '01ab--y', '01aa--x']);
    // Both callers get the one listing that was made.
    expect(second).toBe(first);
  });

  it('a page requested during open shares the initial listing', async () => {
    const fs = slowFs({
      '2026-08-10': { '01aa--x': raw },
      '2026-08-12': { '01ba--z': raw },
    });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS, pageSize: 1 });
    const [opened, paged] = await Promise.all([mailbox.open(), mailbox.loadMore()]);
    expect(paged).toBe(opened);
    expect(mailbox.messages.map((m) => m.name)).toEqual(['01ba--z']);
    expect(mailbox.hasMore).toBe(true);
  });

  it('a sync that races a re-listing does not put a message on top twice', async () => {
    const tree = { '2026-08-10': { '01aa--x': raw } };
    const fs = slowFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    tree['2026-08-10']['01ab--y'] = raw;
    const [added] = await Promise.all([mailbox.sync(), mailbox.open()]);
    expect(mailbox.messages.map((m) => m.name)).toEqual(['01ab--y', '01aa--x']);
    // The re-listing holds the new message, so the sync has nothing to add.
    expect(added).toEqual([]);
  });

  it('a page of older mail abandoned by a re-listing is not appended to the new one', async () => {
    const tree = {
      '2026-08-01': { 'a--1': raw },
      '2026-08-02': { 'b--1': raw },
      '2026-08-03': { 'c--1': raw },
    };
    const fs = slowFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS, pageSize: 1 });
    await mailbox.open();
    expect(mailbox.messages.map((m) => m.name)).toEqual(['c--1']);
    const [older] = await Promise.all([mailbox.loadMore(), mailbox.open()]);
    expect(older).toEqual([]);
    expect(mailbox.messages.map((m) => m.name)).toEqual(['c--1']);
    // The re-listing's own paging cursor is intact.
    expect(mailbox.hasMore).toBe(true);
    await mailbox.loadMore();
    expect(mailbox.messages.map((m) => m.name)).toEqual(['c--1', 'b--1']);
  });

  it('a search listing waits for a re-listing rather than mixing with it', async () => {
    const tree = { '2026-08-10': { '01aa--x': raw }, '2026-08-11': { '01b0--y': raw } };
    const fs = slowFs(tree);
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS, pageSize: 1 });
    await mailbox.open();
    const [all] = await Promise.all([mailbox.listAll(), mailbox.open()]);
    expect(all.map((m) => m.name)).toEqual(['01b0--y', '01aa--x']);
    // The catalog and the paged list are views of the same objects.
    expect(all[0]).toBe(mailbox.messages[0]);
  });
});

describe('bounded mailbox loading', () => {
  const busyDay = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) =>
    [`${String(i).padStart(5, '0')}--x`, rawMessage()]));

  it('returns at most sixty messages from a busy day and lists that day only once', async () => {
    const fs = makeFs({ '2026-08-17': busyDay(1000) });
    vi.spyOn(fs, 'readdir');
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    expect(await mailbox.open()).toHaveLength(60);
    expect(mailbox.messages[0].name).toBe('00999--x');
    expect(mailbox.hasMore).toBe(true);
    while (mailbox.hasMore) expect((await mailbox.loadMore()).length).toBeLessThanOrEqual(60);
    expect(mailbox.messages).toHaveLength(1000);
    expect(new Set(mailbox.messages.map((message) => message.name)).size).toBe(1000);
    expect(mailbox.messages.at(-1).name).toBe('00000--x');
    expect(fs.readdir).toHaveBeenCalledTimes(2);
  });

  it('lists sparse days concurrently without duplicating requests', async () => {
    const tree = Object.fromEntries(Array.from({ length: 20 }, (_, i) =>
      [`2026-08-${String(i + 1).padStart(2, '0')}`, { [`m${i}--x`]: rawMessage() }]));
    const base = makeFs(tree);
    let active = 0;
    let peak = 0;
    const fs = { ...base, readdir: vi.fn(async (path) => {
      if (path === OBJECTS) return base.readdir(path);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return base.readdir(path);
    }) };
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    await mailbox.open();
    expect(peak).toBe(6);
    expect(fs.readdir).toHaveBeenCalledTimes(21);
    expect(mailbox.messages).toHaveLength(20);
    expect(mailbox.messages[0].day).toBe('2026-08-20');
  });

  it('shares overlapping page loads even when the next page is already buffered', async () => {
    const mailbox = createMailbox({ fs: makeFs({ '2026-08-17': busyDay(200) }), objectsPath: OBJECTS });
    await mailbox.open();
    const [a, b] = await Promise.all([mailbox.loadMore(), mailbox.loadMore()]);
    expect(a).toBe(b);
    expect(a).toHaveLength(60);
    expect(mailbox.messages).toHaveLength(120);
  });

  it('does not resurrect buffered mail moved by a whole-folder action', async () => {
    const mailbox = createMailbox({ fs: makeFs({ '2026-08-17': busyDay(3) }), objectsPath: OBJECTS, pageSize: 1 });
    await mailbox.open();
    const all = await mailbox.listAll();
    const removed = all.find((message) => message.name === '00001--x');
    mailbox.remove(removed);
    expect((await mailbox.loadMore()).map((message) => message.name)).toEqual(['00000--x']);
    expect(mailbox.hasMore).toBe(false);
    mailbox.insert(removed);
    expect(mailbox.messages.map((message) => message.name)).toEqual(['00002--x', '00001--x', '00000--x']);
  });

  it('refreshes buffered days after an external folder change', async () => {
    const tree = { '2026-08-17': busyDay(3) };
    const mailbox = createMailbox({ fs: makeFs(tree), objectsPath: OBJECTS, pageSize: 1 });
    await mailbox.open();
    delete tree['2026-08-17']['00001--x'];
    mailbox.forget();
    expect((await mailbox.loadMore()).map((message) => message.name)).toEqual(['00000--x']);
    expect(mailbox.hasMore).toBe(false);
  });

  it('keeps buffered older mail reachable when new mail arrives', async () => {
    const tree = { '2026-08-17': busyDay(3) };
    const mailbox = createMailbox({ fs: makeFs(tree), objectsPath: OBJECTS, pageSize: 1 });
    await mailbox.open();
    tree['2026-08-17']['00003--x'] = rawMessage();
    expect((await mailbox.sync()).map((message) => message.name)).toEqual(['00003--x']);
    while (mailbox.hasMore) await mailbox.loadMore();
    expect(mailbox.messages.map((message) => message.name)).toEqual(['00003--x', '00002--x', '00001--x', '00000--x']);
  });

  it('shares catalog scans and progress between simultaneous callers', async () => {
    const fs = makeFs({ '2026-08-17': busyDay(3), '2026-08-16': { 'old--x': rawMessage() } });
    vi.spyOn(fs, 'readdir');
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    const first = vi.fn();
    const second = vi.fn();
    const [a, b] = await Promise.all([
      mailbox.listAll({ onProgress: first }), mailbox.listAll({ onProgress: second }),
    ]);
    expect(a).toBe(b);
    expect(a).toHaveLength(4);
    expect(fs.readdir).toHaveBeenCalledTimes(3);
    expect(first.mock.calls).toEqual(second.mock.calls);
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('restarts a catalog invalidated while its day listing was in flight', async () => {
    const tree = { '2026-08-17': busyDay(1) };
    const fs = makeFs(tree);
    const original = fs.readdir;
    let release;
    fs.readdir = vi.fn(async (path) => {
      const result = await original(path);
      if (path !== OBJECTS && !release) await new Promise((resolve) => { release = resolve; });
      return result;
    });
    const mailbox = createMailbox({ fs, objectsPath: OBJECTS });
    const listing = mailbox.listAll();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    tree['2026-08-17']['00001--x'] = rawMessage();
    mailbox.forget();
    release();
    expect((await listing).map((message) => message.name)).toEqual(['00001--x', '00000--x']);
    expect(mailbox.total).toBe(2);
  });
});

describe('attachment-only mailbox entries', () => {
  it.each([
    'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename=report.pdf',
    'Content-Type: application/pdf; name=report.pdf',
  ])('marks a root file as attached: %s', async (headers) => {
    const fs = { read: async () => new Blob([`${headers}\r\n\r\ndata`]) };
    const patch = await enrichMessage(fs, { path: '/attachment' });
    expect(patch.hasAttachments).toBe(true);
    expect(patch.snippet).toBe('');
  });
});
