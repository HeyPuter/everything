import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeKv } from './helpers/worker-harness.js';

const RAW = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/workers/mail-handler.js'),
  'utf8',
);

// Same instantiation convention as mailbox.js's in-page rescan path: the
// published-handler source is a bare expression, wrapped in parens and
// evaluated via `new Function`.
function loadHandler() {
  return new Function('return (\n' + RAW + '\n)')();
}

function toArrayBuffer(str) {
  return new TextEncoder().encode(str).buffer;
}

function crlf(lines) {
  return lines.join('\r\n');
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/* ---- fixtures -------------------------------------------------------- */

// Deterministic, distinct uuidv7-shaped ids (only the format is checked).
let idSeq = 0;
function makeId() {
  idSeq += 1;
  return `018f47dc-0000-7000-8000-${String(idSeq).padStart(12, '0')}`;
}

function addEvent(id, { dir = '2026-09-11', subject = 'c3ViamVjdA', prefix = '/host' } = {}) {
  return { op: 'add', path: `${prefix}/.mail/objects/${dir}/${id}--${subject}`, uid: 'node-uid-1' };
}

function icalAttachment(text, overrides = {}) {
  return {
    filename: overrides.filename ?? null,
    mimeType: overrides.mimeType ?? 'text/calendar',
    disposition: overrides.disposition ?? null,
    size: text.length,
    content: toArrayBuffer(text),
  };
}

function makeMsg(overrides = {}) {
  return {
    subject: 'Team sync',
    date: '2026-08-10T19:00:00.000Z',
    from: { address: 'alice@example.com', name: 'Alice' },
    replyTo: [],
    headers: [],
    text: 'You are invited to the team sync.',
    html: '<html><body><b>You are invited</b> to the team sync.</body></html>',
    attachments: [],
    ...overrides,
  };
}

function makeUser({ kv = makeKv(), size = 1000, msg = makeMsg(), getErr = null, getImpl = null } = {}) {
  return {
    kv,
    fs: { stat: vi.fn(async () => ({ size })) },
    email: {
      get: vi.fn(getImpl || (async () => {
        if (getErr) throw getErr;
        return msg;
      })),
    },
  };
}

function run(handler, user, event) {
  return handler({ event, ctx: { v: 1, self: '', user: 'host' }, user, fetch: undefined, ack() {} });
}

function invRecords(kv) {
  return [...kv.map.entries()].filter(([k]) => k.startsWith('cal:mail:inv:')).map(([, v]) => v);
}

function googleIcal(uid) {
  return crlf([
    'BEGIN:VCALENDAR',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'DTSTART:20260901T170000Z',
    'DTEND:20260901T180000Z',
    'DTSTAMP:20260810T000000Z',
    `UID:${uid}`,
    'SEQUENCE:0',
    'ORGANIZER;CN=Alice:mailto:alice@example.com',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Bob:mailto:bob@example.com',
    'SUMMARY:Team sync',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
}

function simpleIcal({ uid, method, summary = 'Team sync', extra = [] }) {
  return crlf([
    'BEGIN:VCALENDAR', 'VERSION:2.0', `METHOD:${method}`, 'BEGIN:VEVENT',
    `UID:${uid}`, 'DTSTAMP:20260810T010000Z', 'ORGANIZER:mailto:host@example.com',
    ...extra, `SUMMARY:${summary}`, 'END:VEVENT', 'END:VCALENDAR',
  ]);
}

/* ---- tests ------------------------------------------------------------ */

describe('mail-handler: is a single bare expression, free of forbidden globals', () => {
  it('compiles with new Function(\'return (\\n\' + source + \'\\n)\')()', () => {
    expect(() => loadHandler()).not.toThrow();
    expect(typeof loadHandler()).toBe('function');
  });

  it('starts with async function and has nothing after the closing brace', () => {
    expect(RAW.trim()).not.toMatch(/^\s*\/\//); // no line comment as the very first thing (parens must wrap cleanly)
    const withoutLeadingComment = RAW.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
    expect(withoutLeadingComment.startsWith('async function calendarMailHandler')).toBe(true);
    expect(withoutLeadingComment.trim().endsWith('}')).toBe(true);
  });

  // Vendored from heyputer/packages/puter/src/puter-js/src/modules/events/lib/
  // freeVariables.js's HANDLER_GLOBALS — the allowlist the real publish-time
  // scanner checks free variables against. This is a best-effort local
  // stand-in (regex, not an AST); the proof-checker runs the real scanner.
  const FORBIDDEN = ['puter', 'me', 'my', 'myself', 'window', 'document', 'process', 'require', 'module', 'exports', 'Buffer', 'global'];

  function withoutLiterals(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*$/gm, ' ')
      .replace(/`(?:\\.|[^`\\])*`/g, '``')
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''");
  }

  it('never references puter/me/my/myself or a non-sandboxed host global', () => {
    const code = withoutLiterals(RAW);
    for (const name of FORBIDDEN) {
      const re = new RegExp(`\\b${name}\\b`);
      expect(re.test(code), `found forbidden identifier "${name}"`).toBe(false);
    }
  });

  it('never sets err.terminal (a malformed message must not count toward suspension)', () => {
    expect(RAW).not.toMatch(/\.terminal\s*=/);
  });

  it('the hand-written MIME layer is gone', () => {
    for (const name of ['splitMessage', 'parseHeaders', 'unfoldLines', 'parseParamList', 'splitMultipart', 'walkPart', 'decodeEncodedWords', 'transferDecode', 'b64ToByteString', 'qpToByteString', 'decodeRFC2231Value']) {
      expect(new RegExp(`\\b${name}\\b`).test(RAW), `found "${name}"`).toBe(false);
    }
  });
});

describe('mail-handler: Google/Outlook/Apple shaped invites', () => {
  it('Google-style alternative text/calendar attachment (disposition: null) → one record, REQUEST, no HTML anywhere', async () => {
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({
      attachments: [icalAttachment(googleIcal('google-uid-1@google.com'), { mimeType: 'text/calendar', disposition: null, filename: null })],
    });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const [record] = invRecords(kv);
    expect(record).toBeTruthy();
    expect(record.method).toBe('REQUEST');
    expect(record.uid).toBe('google-uid-1@google.com');
    expect(record.ical).toContain('DTSTART');
    const json = JSON.stringify(record);
    expect(json).not.toMatch(/<html>|<b>|<\/b>/i);
  });

  it('Outlook-style .ics matched by filename under application/octet-stream', async () => {
    const kv = makeKv();
    const id = makeId();
    const ical = simpleIcal({ uid: 'outlook-uid-1', method: 'REQUEST', summary: 'Quarterly review' });
    const msg = makeMsg({
      subject: 'Café Meeting',
      attachments: [icalAttachment(ical, { mimeType: 'application/octet-stream', filename: 'invite.ics', disposition: 'attachment' })],
    });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const [record] = invRecords(kv);
    expect(record).toBeTruthy();
    expect(record.uid).toBe('outlook-uid-1');
    expect(record.subject).toBe('Café Meeting');
    expect(record.ical).toContain('SUMMARY:Quarterly review');
  });

  it('Apple-style top-level text/calendar attachment, unicode preserved', async () => {
    const kv = makeKv();
    const id = makeId();
    const ical = simpleIcal({ uid: 'apple-uid-1', method: 'REQUEST', summary: 'Café review' });
    const msg = makeMsg({ attachments: [icalAttachment(ical, { mimeType: 'text/calendar' })] });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const [record] = invRecords(kv);
    expect(record).toBeTruthy();
    expect(record.ical).toContain('SUMMARY:Café review');
  });
});

describe('mail-handler: CANCEL / REPLY / COUNTER', () => {
  it('a CANCEL is recorded with method CANCEL', async () => {
    const kv = makeKv();
    const id = makeId();
    const ical = simpleIcal({ uid: 'cancel-uid-1', method: 'CANCEL', summary: 'Cancelled meeting', extra: ['STATUS:CANCELLED', 'SEQUENCE:1'] });
    const msg = makeMsg({ from: { address: 'host@example.com', name: 'Host' }, attachments: [icalAttachment(ical)] });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const [record] = invRecords(kv);
    expect(record.method).toBe('CANCEL');
    expect(record.uid).toBe('cancel-uid-1');
  });

  it('a REPLY with PARTSTAT=ACCEPTED is recorded with method REPLY', async () => {
    const kv = makeKv();
    const id = makeId();
    const ical = simpleIcal({ uid: 'reply-uid-1', method: 'REPLY', extra: ['ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com'] });
    const msg = makeMsg({ from: { address: 'bob@example.com', name: 'Bob' }, attachments: [icalAttachment(ical)] });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const [record] = invRecords(kv);
    expect(record.method).toBe('REPLY');
    expect(record.ical).toContain('PARTSTAT=ACCEPTED');
  });

  it('a COUNTER is recorded with method COUNTER', async () => {
    const kv = makeKv();
    const id = makeId();
    const ical = simpleIcal({ uid: 'counter-uid-1', method: 'COUNTER', summary: 'Team sync (proposed)', extra: ['DTSTART:20260902T150000Z', 'ATTENDEE;PARTSTAT=TENTATIVE:mailto:guest@example.com'] });
    const msg = makeMsg({ from: { address: 'guest@example.com', name: 'Guest' }, attachments: [icalAttachment(ical)] });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const [record] = invRecords(kv);
    expect(record.method).toBe('COUNTER');
  });
});

describe('mail-handler: non-calendar mail and daily/scan gaps', () => {
  it('a message with no calendar attachment writes nothing, but marks seen', async () => {
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({ attachments: [{ filename: 'photo.png', mimeType: 'image/png', disposition: 'attachment', size: 10, content: toArrayBuffer('x') }] });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    expect(invRecords(kv)).toHaveLength(0);
    expect([...kv.map.keys()].some((k) => k.startsWith('cal:mail:seen:'))).toBe(true);
  });

  it('an application/octet-stream attachment that does not start with BEGIN:VCALENDAR is ignored', async () => {
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({ attachments: [icalAttachment('just some binary junk, not a calendar', { mimeType: 'application/octet-stream', filename: 'blob.bin' })] });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    expect(invRecords(kv)).toHaveLength(0);
  });

  it('op:"gap" writes cal:mail:gap and no record', async () => {
    const kv = makeKv();
    const user = makeUser({ kv });
    await run(loadHandler(), user, { op: 'gap', reason: 'missed delivery' });
    const gap = kv.map.get('cal:mail:gap');
    expect(gap).toMatchObject({ reason: 'missed delivery' });
    expect(typeof gap.at).toBe('number');
    expect(invRecords(kv)).toHaveLength(0);
  });

  it('ignores an event whose path is not under .mail/objects', async () => {
    const kv = makeKv();
    const msg = makeMsg({ attachments: [icalAttachment(googleIcal('x'))] });
    await run(loadHandler(), makeUser({ kv, msg }), { op: 'add', path: '/host/other/place', uid: 'x' });
    expect(invRecords(kv)).toHaveLength(0);
  });

  it('ignores an event whose filename has no valid uuidv7 id prefix', async () => {
    const kv = makeKv();
    const msg = makeMsg({ attachments: [icalAttachment(googleIcal('x'))] });
    const user = makeUser({ kv, msg });
    await run(loadHandler(), user, { op: 'add', path: '/host/.mail/objects/2026-09-11/not-a-valid-id--c3ViamVjdA', uid: 'x' });
    expect(invRecords(kv)).toHaveLength(0);
    expect(user.email.get).not.toHaveBeenCalled();
  });

  it('a message larger than MAX_MESSAGE_BYTES is marked seen and `get` is never called', async () => {
    const kv = makeKv();
    const id = makeId();
    const user = makeUser({ kv, size: (3 << 20) + 1 });
    await run(loadHandler(), user, addEvent(id));
    expect(user.email.get).not.toHaveBeenCalled();
    expect(invRecords(kv)).toHaveLength(0);
    expect([...kv.map.keys()].some((k) => k.startsWith('cal:mail:seen:'))).toBe(true);
  });

  it('`get` rejecting not_found marks seen, writes no record, and never throws', async () => {
    const kv = makeKv();
    const id = makeId();
    const user = makeUser({ kv, getErr: Object.assign(new Error('gone'), { code: 'not_found' }) });
    await expect(run(loadHandler(), user, addEvent(id))).resolves.not.toThrow();
    expect(invRecords(kv)).toHaveLength(0);
    expect([...kv.map.keys()].some((k) => k.startsWith('cal:mail:seen:'))).toBe(true);
  });

  it('a transient `get` failure (5xx) is rethrown with retry: true, and nothing is marked seen', async () => {
    const kv = makeKv();
    const id = makeId();
    const user = makeUser({ kv, getErr: Object.assign(new Error('server exploded'), { code: 500 }) });
    await expect(run(loadHandler(), user, addEvent(id))).rejects.toMatchObject({ retry: true, message: 'server exploded' });
    expect([...kv.map.keys()].some((k) => k.startsWith('cal:mail:seen:'))).toBe(false);
  });

  it('a non-transient `get` failure is swallowed (never terminal) and marks seen', async () => {
    const kv = makeKv();
    const id = makeId();
    const user = makeUser({ kv, getErr: Object.assign(new Error('bad request'), { code: 'bad_request' }) });
    await expect(run(loadHandler(), user, addEvent(id))).resolves.not.toThrow();
    expect([...kv.map.keys()].some((k) => k.startsWith('cal:mail:seen:'))).toBe(true);
  });
});

describe('mail-handler: idempotency and the daily/scan counters', () => {
  it('the same message processed via a worker-style delivery and a rescan-style one writes exactly one record', async () => {
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({ attachments: [icalAttachment(googleIcal('dedupe-1'))] });
    const user = makeUser({ kv, msg });
    // Worker delivery names the path with a leading absolute user root...
    await run(loadHandler(), user, addEvent(id, { prefix: '/host' }));
    // ...the in-page rescan names the very same file with `~`.
    await run(loadHandler(), user, addEvent(id, { prefix: '~' }));
    expect(invRecords(kv)).toHaveLength(1);
    // and the file budget was only spent once
    expect(Number(kv.map.get('cal:mail:scan:' + todayKey()))).toBe(1);
  });

  it('every 20th record-written triggers a trim to MAX_RECORDS, keeping newest', async () => {
    const kv = makeKv();
    for (let i = 0; i < 160; i++) {
      kv.map.set(`cal:mail:inv:${String(i).padStart(9, '0')}-aaaaaaaa`, { v: 1 });
    }
    kv.map.set('cal:mail:day:' + todayKey(), 19); // this run's incr lands on 20
    const id = makeId();
    const msg = makeMsg({ attachments: [icalAttachment(googleIcal('zz-uid'))] });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const invKeys = [...kv.map.keys()].filter((k) => k.startsWith('cal:mail:inv:'));
    expect(invKeys.length).toBeLessThanOrEqual(150);
  });

  it('stops writing records once MAX_PER_DAY (60) records-written is reached', async () => {
    const kv = makeKv();
    kv.map.set('cal:mail:day:' + todayKey(), 60);
    const id = makeId();
    const msg = makeMsg({ attachments: [icalAttachment(googleIcal('over-uid'))] });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    expect(invRecords(kv)).toHaveLength(0);
  });

  it('counts scanned files and records separately: a non-calendar message only spends the scan budget', async () => {
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({ attachments: [] });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    expect(kv.map.get('cal:mail:scan:' + todayKey())).toBe(1);
    expect(kv.map.get('cal:mail:day:' + todayKey()) || 0).toBe(0);
  });

  it('stops scanning once MAX_SCANNED_PER_DAY (600) files-processed is reached', async () => {
    const kv = makeKv();
    kv.map.set('cal:mail:scan:' + todayKey(), 600);
    const id = makeId();
    const msg = makeMsg({ attachments: [icalAttachment(googleIcal('blocked-uid'))] });
    const user = makeUser({ kv, msg });
    await run(loadHandler(), user, addEvent(id));
    expect(invRecords(kv)).toHaveLength(0);
    // Not even marked seen, and `get` never called — the run bailed before that.
    expect([...kv.map.keys()].some((k) => k.startsWith('cal:mail:seen:'))).toBe(false);
    expect(user.email.get).not.toHaveBeenCalled();
  });
});

describe('mail-handler: at most 4 calendar attachments are considered', () => {
  it('a 5th, otherwise-usable calendar attachment past the cap is never reached', async () => {
    const kv = makeKv();
    const id = makeId();
    const empty = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'; // no VEVENT — unusable
    const good = simpleIcal({ uid: 'reachable', method: 'REQUEST' });
    const msg = makeMsg({
      attachments: [
        icalAttachment(empty), icalAttachment(empty), icalAttachment(empty), icalAttachment(empty),
        icalAttachment(good),
      ],
    });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    expect(invRecords(kv)).toHaveLength(0);
  });
});

describe('mail-handler: property and parameter filtering', () => {
  it('drops X-*, ATTACH, SENT-BY, a non-http(s) URL, VTIMEZONE and VALARM', async () => {
    const ical = crlf([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST',
      'BEGIN:VTIMEZONE', 'TZID:Custom/Zone', 'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:filter-uid-1', 'DTSTAMP:20260810T000000Z',
      'DTSTART:20260901T090000', 'DTEND:20260901T100000',
      'SUMMARY:Filtered', 'X-EVIL:payload', 'ATTACH:https://example.com/x.ics',
      'ATTENDEE;SENT-BY="mailto:evil@example.com":mailto:guest@example.com',
      'URL:javascript:alert(1)',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'DESCRIPTION:reminder', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ]);
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({ attachments: [icalAttachment(ical)] });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const [record] = invRecords(kv);
    expect(record).toBeTruthy();
    expect(record.ical).not.toContain('X-EVIL');
    expect(record.ical).not.toContain('ATTACH');
    expect(record.ical).not.toContain('SENT-BY');
    expect(record.ical).not.toContain('javascript:');
    expect(record.ical).not.toContain('VTIMEZONE');
    expect(record.ical).not.toContain('VALARM');
    expect(record.ical).not.toContain('reminder');
  });

  it('\\r-only iCalendar line endings are tolerated', async () => {
    const ical = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:cr-only', 'DTSTAMP:20260810T000000Z', 'SUMMARY:x', 'END:VEVENT', 'END:VCALENDAR'].join('\r');
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({ attachments: [icalAttachment(ical)] });
    await expect(run(loadHandler(), makeUser({ kv, msg }), addEvent(id))).resolves.not.toThrow();
    const [record] = invRecords(kv);
    expect(record.uid).toBe('cr-only');
  });

  it('a VEVENT with 5000 ATTENDEEs stays within the record caps', async () => {
    const attendees = Array.from({ length: 5000 }, (_, i) => `ATTENDEE:mailto:guest${i}@example.com`);
    const ical = crlf([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT',
      'UID:mega-uid', 'DTSTAMP:20260810T000000Z', 'DTSTART:20260901T090000', 'SUMMARY:Huge',
      ...attendees, 'END:VEVENT', 'END:VCALENDAR',
    ]);
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({ attachments: [icalAttachment(ical)] });
    await expect(run(loadHandler(), makeUser({ kv, msg }), addEvent(id))).resolves.not.toThrow();
    for (const record of invRecords(kv)) {
      expect(record.attendees.length).toBeLessThanOrEqual(20);
      expect(JSON.stringify(record).length).toBeLessThanOrEqual(20000);
    }
  });

  it('a malformed attachment (content not an ArrayBuffer) never throws', async () => {
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({ attachments: [{ filename: 'x.ics', mimeType: 'application/octet-stream', disposition: 'attachment', size: 0, content: null }] });
    await expect(run(loadHandler(), makeUser({ kv, msg }), addEvent(id))).resolves.not.toThrow();
    expect(invRecords(kv)).toHaveLength(0);
  });
});

describe('mail-handler: record size ceiling', () => {
  it('never writes a record whose JSON exceeds 20000 characters', async () => {
    const attendees = Array.from({ length: 20 }, (_, i) => `ATTENDEE;CN=Guest Number ${i}:mailto:guest-number-${i}-with-a-long-local-part@example-domain-name.example.com`);
    const bigDescription = 'DESCRIPTION:' + 'lorem ipsum dolor sit amet '.repeat(30);
    const events = [];
    for (let e = 0; e < 30; e++) {
      events.push(
        'BEGIN:VEVENT',
        `UID:big-uid-${e}`,
        'DTSTAMP:20260810T000000Z',
        `DTSTART:2026090${(e % 9) + 1}T090000`,
        'SUMMARY:' + 'S'.repeat(200),
        bigDescription,
        ...(e === 0 ? attendees : []),
        'END:VEVENT',
      );
    }
    const ical = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', ...events, 'END:VCALENDAR']);
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({ subject: 'S'.repeat(300), attachments: [icalAttachment(ical)] });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    for (const record of invRecords(kv)) {
      expect(JSON.stringify(record).length).toBeLessThanOrEqual(20000);
    }
  });
});

describe('authentication cannot be forged by appending headers', () => {
  function headers(list) {
    return list.map(([key, value]) => ({ key, value }));
  }

  it('a trailing Authentication-Results the sender wrote is ignored', async () => {
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({
      from: { address: 'mallory@evil.example', name: 'Mallory' },
      subject: 'Forged',
      headers: headers([
        ['received', 'from mx.puter.com'],
        ['authentication-results', 'mx.puter.com; dkim=none; spf=fail'],
        ['authentication-results', 'forged; dkim=pass header.d=evil.example'],
      ]),
      attachments: [icalAttachment(simpleIcal({ uid: 'forge-1', method: 'REQUEST', summary: 'Forged' }))],
    });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const [rec] = invRecords(kv);
    expect(rec).toBeTruthy();
    // Only the topmost header counts, so the forged pass never lands.
    expect(rec.auth.dkim).toBe('none');
    expect(rec.auth.dkimAligned).toBe(false);
    expect(rec.auth.internal).toBe(false);
  });

  it('a forged header cannot supply header.d for a real dkim=pass either', async () => {
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({
      from: { address: 'mallory@evil.example', name: 'Mallory' },
      headers: headers([
        ['received', 'from mx.puter.com'],
        ['authentication-results', 'mx.puter.com; dkim=pass header.d=evil.example'],
        ['authentication-results', 'forged; header.d=puter.email'],
      ]),
      attachments: [icalAttachment(simpleIcal({ uid: 'forge-2', method: 'REQUEST' }))],
    });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const [rec] = invRecords(kv);
    // dkim=pass, but for the domain that actually signed — not the one the
    // appended header names, and not aligned with the From domain either way.
    expect(rec.auth.dkim).toBe('pass');
    expect(rec.auth.dkimAligned).toBe(true); // evil.example signed for evil.example
    expect(rec.from.email).toBe('mallory@evil.example');
  });

  it('the topmost header still authenticates a genuinely aligned signature', async () => {
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({
      from: { address: 'alice@example.com', name: 'Alice' },
      subject: 'Real',
      headers: headers([
        ['received', 'from mx.puter.com'],
        ['authentication-results', 'mx.puter.com; dkim=pass header.d=example.com; spf=pass'],
      ]),
      attachments: [icalAttachment(simpleIcal({ uid: 'real-1', method: 'REQUEST', summary: 'Real' }))],
    });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const [rec] = invRecords(kv);
    expect(rec.auth.dkim).toBe('pass');
    expect(rec.auth.dkimAligned).toBe(true);
    expect(rec.auth.spf).toBe('pass');
  });

  it('the `sender` header supplies the record\'s sender address', async () => {
    const kv = makeKv();
    const id = makeId();
    const msg = makeMsg({
      headers: headers([['sender', '"Bulk Sender" <bulk@sender.example>']]),
      attachments: [icalAttachment(simpleIcal({ uid: 'sender-1', method: 'REQUEST' }))],
    });
    await run(loadHandler(), makeUser({ kv, msg }), addEvent(id));
    const [rec] = invRecords(kv);
    expect(rec.sender).toBe('bulk@sender.example');
  });
});
