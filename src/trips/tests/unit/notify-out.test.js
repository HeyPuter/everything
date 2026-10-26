// @vitest-environment node
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { urlProblem, safeUrl, isBlockedIp } from '../../src/lib/notify-out/guard.js';
import { signatureHeader, verifySignature } from '../../src/lib/notify-out/sign.js';
import { classify, retryAfterMs, nextAttempt, PERSIST_DELAYS } from '../../src/lib/notify-out/retry.js';
import { KEYS, cleanNotifyPrefs, cleanSecret, channelsFor, readyChannels, newSecret, newTopic, validTopic } from '../../src/lib/notify-out/model.js';
import { changeItems, changeNote, webhookBody, ntfyBody, digestEmail, describe as describeNote, readNote, storedNote, tripUrl } from '../../src/lib/notify-out/payload.js';
import { claim, runHandler, translator, hourBucket, PUSH_PER_HOUR } from '../../src/lib/notify-out/handler.js';
import { tripReminders, todoReminders, scheduleChanges, forwardedReminders, withoutCovered } from '../../src/lib/notify-out/schedule.js';
import { desiredSubscriptions, reconcileSubscriptions, tripsToWatch } from '../../src/lib/notify-out/subscriptions.js';
import { notifyKeys, saveSecret, syncNotifyOut } from '../../src/lib/notify-out/index.js';
import { personalKeys } from '../../src/lib/io/data-export.js';

const t = translator();
const SPACE = 'a1b2c3d4e5f6g7h8';
const WORKER = 'trips-abcdefghij';
const BOB = '0f0e0d0c-0b0a-4000-8000-000000000b0b';
const START = Date.UTC(2027, 4, 10, 12, 0, 0);

describe('webhook URL guard', () => {
  it.each([
    ['https://hooks.example.org/x', null],
    ['https://hooks.slack.com/services/T/B/C', null],
    ['https://ntfy.sh', null],
    ['https://example.org:8443/hook', null],
    ['http://example.org/hook', 'url_https'],
    ['https://user:pw@example.org/', 'url_credentials'],
    ['https://example.org:8080/', 'url_port'],
    ['https://127.0.0.1/', 'url_private'],
    ['https://10.1.2.3/', 'url_private'],
    ['https://169.254.169.254/latest/meta-data', 'url_private'],
    ['https://[::1]/', 'url_private'],
    ['https://[::ffff:7f00:1]/', 'url_private'],
    ['https://[fd00::1]/', 'url_private'],
    ['https://0x7f.0.0.1/', 'url_private'],
    ['https://2130706433/', 'url_private'],
    ['https://localhost/', 'url_private'],
    ['https://printer.local/', 'url_private'],
    ['https://intranet/', 'url_private'],
    ['https://10.0.0.1.nip.io/', 'url_private'],
    ['https://app-192-168-1-1.example.com/', 'url_private'],
    ['https://metadata.google.internal/', 'url_private'],
    ['javascript:alert(1)', 'url_https'],
    ['not a url', 'url_invalid'],
    [`https://example.org/${'a'.repeat(2100)}`, 'url_invalid'],
  ])('%s → %s', (url, problem) => {
    expect(urlProblem(url)).toBe(problem);
  });
  it('allows public IP literals and strips fragments', () => {
    expect(isBlockedIp('93.184.216.34')).toBe(false);
    expect(isBlockedIp('100.64.0.1')).toBe(true);
    expect(safeUrl('https://example.org/a#frag')).toBe('https://example.org/a');
    expect(() => safeUrl('https://192.168.0.1/')).toThrow(expect.objectContaining({ code: 'url_private' }));
  });
});

describe('signing', () => {
  it('signs "t.body" with HMAC-SHA256 and verifies within the tolerance', async () => {
    const secret = 'k'.repeat(43);
    const body = JSON.stringify({ hello: 'wörld' });
    const header = await signatureHeader(secret, body, START);
    const seconds = Math.floor(START / 1000);
    expect(header).toBe(`t=${seconds},v1=${createHmac('sha256', secret).update(`${seconds}.${body}`).digest('hex')}`);
    expect(await verifySignature(secret, body, header, { now: START + 60_000 })).toBe(true);
    expect(await verifySignature(secret, `${body} `, header, { now: START })).toBe(false);
    expect(await verifySignature('other'.repeat(9), body, header, { now: START })).toBe(false);
    expect(await verifySignature(secret, body, header, { now: START + 301_000 })).toBe(false);
    expect(await verifySignature(secret, body, 'v1=abc', { now: START })).toBe(false);
  });
  it('makes url-safe secrets and long random topics', () => {
    const secret = newSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cleanSecret({ webhookSecret: secret }).webhookSecret).toBe(secret);
    const topic = newTopic();
    expect(validTopic(topic)).toBe(true);
    expect(topic.length).toBeGreaterThanOrEqual(30);
  });
});

describe('retry schedule', () => {
  it.each([[200, 'ok'], [204, 'ok'], [0, 'retry'], [408, 'retry'], [429, 'retry'], [500, 'retry'], [503, 'retry'], [302, 'fail'], [400, 'fail'], [401, 'fail'], [404, 'fail'], [410, 'fail']])('%i is %s', (status, verdict) => {
    expect(classify(status)).toBe(verdict);
  });
  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('120', START)).toBe(120_000);
    expect(retryAfterMs(new Date(START + 30_000).toUTCString(), START)).toBe(30_000);
    expect(retryAfterMs('soon', START)).toBeNull();
    expect(retryAfterMs(null, START)).toBeNull();
  });
  it('backs off 1 min, 5 min, 30 min, 2 h, 6 h, then drops; never past a day', () => {
    const first = START;
    let now = first;
    const gaps = [];
    for (let attempt = 0; ; attempt++) {
      const at = nextAttempt(attempt, { first, now });
      if (at == null) break;
      gaps.push(at - now);
      now = at;
    }
    expect(gaps).toEqual([...PERSIST_DELAYS]);
    expect(nextAttempt(0, { first, now: first, retryAfter: 600_000 })).toBe(first + 600_000);
    expect(nextAttempt(1, { first, now: first + 86_200_000 })).toBeNull();
  });
});

describe('settings model', () => {
  it('reads defaults for anything invalid', () => {
    const prefs = cleanNotifyPrefs({ on: 'yes', channels: { webhook: { on: true, format: 'xml' }, ntfy: { server: 'http://10.0.0.1', priority: 9 } }, events: { chat: ['ntfy', 'pager'] }, trips: { [SPACE]: 'off', bad: 'off', b1b2c3d4e5f6g7h8: 'loud' }, lead: [7, 1, 1, 2] });
    expect(prefs.on).toBe(false);
    expect(prefs.channels.webhook).toEqual({ on: true, format: 'json' });
    expect(prefs.channels.ntfy).toEqual({ on: false, server: 'https://ntfy.sh', priority: 3 });
    expect(prefs.events.chat).toEqual(['ntfy']);
    expect(prefs.events.bookings).toEqual(['webhook', 'ntfy', 'email']);
    expect(prefs.trips).toEqual({ [SPACE]: 'off' });
    expect(prefs.lead).toEqual([1, 7]);
  });
  it('drops secrets that fail their checks', () => {
    expect(cleanSecret({ webhookUrl: 'https://192.168.1.10/hook', webhookSecret: 'short', ntfyTopic: 'a b', ntfyToken: 'tk_ ok', email: 'nope' })).toEqual({});
  });
  it('routes categories by trip mode and never emails reminders', () => {
    const prefs = cleanNotifyPrefs({ on: true, channels: { webhook: { on: true }, ntfy: { on: true }, email: { on: true } }, trips: { [SPACE]: 'reminders' } });
    const ready = readyChannels(prefs, { webhookUrl: 'https://example.org/h', webhookSecret: 'x'.repeat(40), ntfyTopic: 'topic', email: 'me@example.org' });
    expect(ready).toEqual(['webhook', 'ntfy', 'email']);
    expect(channelsFor(prefs, ready, 'bookings', 'b1b2c3d4e5f6g7h8')).toEqual(['webhook', 'ntfy', 'email']);
    expect(channelsFor(prefs, ready, 'bookings', SPACE)).toEqual([]);
    expect(channelsFor(prefs, ready, 'reminders', SPACE)).toEqual(['webhook', 'ntfy']);
    expect(readyChannels({ ...prefs, on: false }, {})).toEqual([]);
  });
  it('keeps the secret out of the data export and lists every key for deletion', () => {
    expect(personalKeys()).toContain('me:notify');
    expect(personalKeys()).not.toContain('me:notify:secret');
    const keys = notifyKeys(START);
    expect(keys).toEqual(expect.arrayContaining([KEYS.prefs, KEYS.secret, KEYS.sched, KEYS.retry, KEYS.digest, KEYS.status, KEYS.bucket(hourBucket(START)), KEYS.bucket(hourBucket(START - 48 * 3_600_000))]));
  });
  it('saves secrets with disableSharing after the reach check', async () => {
    const calls = [];
    const puter = { kv: { get: async () => null, set: async (...args) => { calls.push(args); } } };
    await expect(saveSecret(puter, { webhookUrl: 'https://localhost/x' })).rejects.toMatchObject({ code: 'url_private' });
    await saveSecret(puter, { webhookUrl: 'https://example.org/x#y', ntfyTopic: 'trips-abc' });
    expect(calls).toEqual([[KEYS.secret, { v: 1, webhookUrl: 'https://example.org/x', ntfyTopic: 'trips-abc' }, { disableSharing: true }]]);
  });
});

const record = (rev, sum, by = BOB, at = START) => ({ rev, at, by, ents: [], del: [], sum });

describe('payloads', () => {
  it('collapses changes, leaves out own changes and noise', () => {
    const items = changeItems([
      record(2, [{ t: 'place', id: 'p1', op: 'set', name: 'Museum', fields: ['notes'] }]),
      record(1, [{ t: 'place', id: 'p1', op: 'put', name: 'Museum', fields: [] }, { t: 'visit', id: 'v1', op: 'set', name: '', fields: ['order'] }]),
      record(3, [{ t: 'res', id: 'r1', op: 'put', name: 'Hotel', fields: [] }], 'me'),
      record(4, [{ t: 'todo', id: 'd1', op: 'put', name: 'Visa', fields: [] }, { t: 'msg', id: 'm1', op: 'set', name: 'hi', fields: ['react'] }, { t: 'secret', id: 'x', op: 'put' }]),
      record(5, [{ t: 'todo', id: 'd1', op: 'del', name: 'Visa', fields: [] }, { t: 'exp', id: 'e1', op: 'set', name: 'Taxi', fields: ['amount', 'order'] }]),
    ], 'me');
    expect(items).toEqual([
      { t: 'place', id: 'p1', op: 'add', cat: 'plan', by: BOB, name: 'Museum', fields: ['notes'] },
      { t: 'exp', id: 'e1', op: 'change', cat: 'costs', by: BOB, name: 'Taxi', fields: ['amount'] },
    ]);
  });
  const note = () => ({ ...changeNote({ space: SPACE, worker: WORKER, title: 'Lisbon <2027>', origin: 'https://trips.puter.com', rev: 9, at: START,
    items: [{ t: 'res', id: 'r1', op: 'add', cat: 'bookings', by: BOB, who: 'Bob', name: 'Hotel *Sol* @everyone', fields: [] }, { t: 'msg', id: 'm1', op: 'add', cat: 'chat', by: BOB, who: 'Bob', name: 'See you <b>soon</b>', fields: [] }] }) });
  it('builds the JSON webhook body', () => {
    const body = webhookBody(note(), 'json', t);
    expect(body).toMatchObject({ v: 1, type: 'trip.change', id: `c-${SPACE}-9`, at: new Date(START).toISOString(),
      trip: { id: SPACE, title: 'Lisbon <2027>', url: `https://trips.puter.com/#/t/${WORKER}/${SPACE}` }, title: 'Lisbon <2027>' });
    expect(body.text).toBe('Bob added booking “Hotel *Sol* @everyone”\nBob: See you <b>soon</b>');
    expect(body.changes[0]).toEqual({ type: 'res', id: 'r1', action: 'add', name: 'Hotel *Sol* @everyone', fields: [], by: 'Bob' });
  });
  it('escapes Slack and Discord markup and blocks mentions', () => {
    expect(webhookBody(note(), 'slack', t).text).toContain('*Lisbon &lt;2027&gt;*\nBob added booking “Hotel *Sol* @everyone”\nBob: See you &lt;b&gt;soon&lt;/b&gt;\n<https://trips.puter.com');
    const discord = webhookBody(note(), 'discord', t);
    expect(discord.allowed_mentions).toEqual({ parse: [] });
    expect(discord.content).toContain('Hotel \\*Sol\\* @​everyone');
    expect(discord.content.length).toBeLessThanOrEqual(2000);
  });
  it('builds ntfy and email bodies', () => {
    expect(ntfyBody(note(), { topic: 'trips-x', priority: 4 }, t)).toEqual({ topic: 'trips-x', title: 'Lisbon <2027>', message: 'Bob added booking “Hotel *Sol* @everyone”\nBob: See you <b>soon</b>', priority: 4, tags: ['luggage'], click: `https://trips.puter.com/#/t/${WORKER}/${SPACE}` });
    const mail = digestEmail([note(), note()], t);
    expect(mail.subject).toBe('Trips: 2 updates');
    expect(mail.html).toContain('<h3>Lisbon &lt;2027&gt;</h3>');
    expect(mail.html).toContain('See you &lt;b&gt;soon&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>');
    expect(mail.text).toContain('- Bob: See you <b>soon</b>');
  });
  it('words reminders and refuses unsafe links', () => {
    const reminder = (days, kind = 'trip') => describeNote({ kind: 'reminder', trip: { title: 'Rome' }, reminder: { kind, days, date: '2027-05-10', name: 'Visa' }, items: [], more: 0 }, t).lines[0];
    expect(reminder(0)).toBe('Rome starts today');
    expect(reminder(1)).toBe('Rome starts tomorrow');
    expect(reminder(7)).toBe('Rome starts in 7 days (May 10, 2027)');
    expect(reminder(null, 'todo')).toBe('To-do due May 10, 2027: Visa');
    expect(tripUrl('http://trips.puter.com', WORKER, SPACE)).toBeNull();
    expect(tripUrl('https://trips.puter.com', 'evil', SPACE)).toBeNull();
  });
  it('round-trips stored notes and rejects junk', () => {
    expect(readNote(storedNote(note()))).toEqual(note());
    expect(readNote({ id: 1 })).toBeNull();
    expect(readNote({ id: 'r-x', kind: 'reminder', at: 1 })).toBeNull();
  });
});

describe('reminder schedule', () => {
  it('schedules trip starts at 09:00 local, lead days before', () => {
    const entries = [{ ref: { w: WORKER, s: SPACE, k: 'trip' }, title: 'Rome', start: '2027-05-20' }, { ref: { w: WORKER, s: 'b1b2c3d4e5f6g7h8', k: 'collection' }, start: '2027-05-20' }];
    const items = tripReminders(entries, { lead: [0, 7, 30], now: START, zone: 'Europe/Rome' });
    expect(Object.keys(items)).toEqual([`trip-${SPACE}-2027-05-20-0`, `trip-${SPACE}-2027-05-20-7`]);
    expect(items[`trip-${SPACE}-2027-05-20-7`]).toEqual({ at: Date.UTC(2027, 4, 13, 7), kind: 'trip', space: SPACE, w: WORKER, trip: 'Rome', date: '2027-05-20', days: 7 });
  });
  it('schedules open to-dos for me or nobody', () => {
    const todos = [
      { id: '1111111111111111', name: 'Visa', due: '2027-05-12' },
      { id: '2222222222222222', name: 'Theirs', due: '2027-05-12', who: BOB },
      { id: '3333333333333333', name: 'Done', due: '2027-05-12', done: true },
      { id: '4444444444444444', name: 'Mine', due: '2027-05-11', who: 'me' },
    ];
    const items = todoReminders({ ref: { w: WORKER, s: SPACE }, title: 'Rome', todos, uid: 'me', now: START, zone: 'UTC' });
    expect(Object.values(items).map((item) => [item.name, item.at])).toEqual([['Visa', Date.UTC(2027, 4, 12, 9)], ['Mine', Date.UTC(2027, 4, 11, 9)]]);
  });
  it('forwards in-app reminders and drops own trip items they cover', () => {
    const ref = { w: WORKER, s: SPACE, k: 'trip' };
    const forwarded = forwardedReminders([
      { key: `${WORKER}/${SPACE}|t-trip@x|2027-05-20T|900`, kind: 'trip', ref, trip: 'Rome', title: 'Rome', start: { date: '2027-05-20' }, fireAt: Date.UTC(2027, 4, 13, 7), until: Date.UTC(2027, 4, 21) },
      { key: `${WORKER}/${SPACE}|t-res-r1@x|2027-05-20T10:00|180`, kind: 'booking', ref, trip: 'Rome', title: 'Flight LIS → FCO', start: { date: '2027-05-20', time: '10:00' }, fireAt: START + 1000, until: START + 5000 },
      { key: `${WORKER}/${SPACE}|overdue|2027-05-10`, kind: 'overdue', ref, trip: 'Rome', title: 'Rome', start: { date: '2027-05-10' }, fireAt: START - 1000, until: START + 1000, count: 2 },
      { key: 'gone', kind: 'booking', ref, fireAt: START - 5000, until: START - 1 },
      { key: 'odd', kind: 'weather', ref, fireAt: START },
    ], { now: START });
    const items = Object.values(forwarded);
    expect(Object.keys(forwarded).every((id) => /^q-[0-9a-f]{16}$/.test(id))).toBe(true);
    expect(items.map((item) => item.kind)).toEqual(['trip', 'booking', 'overdue']);
    expect(items[1]).toMatchObject({ text: 'Flight LIS → FCO', date: '2027-05-20', space: SPACE });
    expect(items[2]).toMatchObject({ count: 2 });
    const own = tripReminders([{ ref, title: 'Rome', start: '2027-05-20' }], { lead: [1, 7], now: START, zone: 'Europe/Rome' });
    expect(Object.keys(withoutCovered(own, forwarded))).toEqual([`trip-${SPACE}-2027-05-20-1`]);
    const t2 = translator();
    expect(describeNote({ kind: 'reminder', trip: { title: 'Rome' }, reminder: { kind: 'overdue', count: 2 }, items: [], more: 0 }, t2).lines).toEqual(['2 overdue to-dos']);
    expect(describeNote({ kind: 'reminder', trip: { title: 'Rome' }, reminder: { kind: 'booking', text: 'Flight LIS → FCO' }, items: [], more: 0 }, t2).lines).toEqual(['Flight LIS → FCO']);
  });
  it('writes only what changed and removes what it owns', () => {
    const stored = { items: { 'trip-a-1': { at: START + 1 }, 'todo-b-1': { at: START + 2 }, 'trip-old': { at: START - 3 * 86_400_000 } } };
    const changes = scheduleChanges(stored, { 'trip-a-2': { at: START + 5 } }, (id) => id.startsWith('trip-'), START);
    expect(changes).toEqual({ set: { 'items.trip-a-2': { at: START + 5 } }, remove: ['items.trip-a-1', 'items.trip-old'] });
    expect(scheduleChanges({ items: { 'trip-a-2': { at: START + 5 } } }, { 'trip-a-2': { at: START + 5 } }, () => true, START)).toBeNull();
  });
});

describe('app sync', () => {
  it('schedules own and forwarded reminders and keeps forwarded ones when the provider fails', async () => {
    const runtime = createFakePuter({ now: () => START });
    const puter = runtime.client('alice');
    await puter.kv.set(KEYS.prefs, { on: true, lead: [7] });
    const ref = { w: WORKER, s: SPACE, k: 'trip' };
    const personal = { spaces: { list: async () => [{ ref, role: 'owner', title: 'Rome', start: '2027-05-20' }] } };
    const booking = { key: 'k1', kind: 'booking', ref, trip: 'Rome', title: 'Flight', start: { date: '2027-05-20' }, fireAt: START + 60_000, until: START + 120_000 };
    const result = await syncNotifyOut({ puter, personal, account: { uuid: 'alice' }, origin: 'https://trips.puter.com', now: START, reminders: async () => [booking], storage: null });
    expect(result.state).toBe('unavailable');
    const ids = () => runtime.client('alice').kv.get(KEYS.sched).then((value) => Object.keys(value.items).sort());
    const first = await ids();
    expect(first).toHaveLength(2);
    expect(first[1]).toBe(`trip-${SPACE}-2027-05-20-7`);
    await syncNotifyOut({ puter, personal, account: { uuid: 'alice' }, now: START, reminders: async () => { throw new Error('replica'); }, storage: null });
    expect(await ids()).toEqual(first);
    await syncNotifyOut({ puter, personal, account: { uuid: 'alice' }, now: START, reminders: async () => [], storage: null });
    expect(await ids()).toEqual([`trip-${SPACE}-2027-05-20-7`]);
  });
});

describe('subscriptions', () => {
  const prefs = cleanNotifyPrefs({ on: true, channels: { webhook: { on: true } }, trips: { c1c2c3d4e5f6g7h8: 'off' } });
  const entries = [
    { ref: { w: WORKER, s: SPACE, k: 'trip' }, role: 'owner', start: '2027-06-01' },
    { ref: { w: 'trips-zzzzzzzzzz', s: 'b1b2c3d4e5f6g7h8', k: 'trip' }, role: 'editor', start: '2027-05-20', handles: { read: 'hR', write: 'hW' } },
    { ref: { w: WORKER, s: 'c1c2c3d4e5f6g7h8', k: 'trip' }, role: 'owner' },
    { ref: { w: WORKER, s: 'd1d2d3d4e5f6g7h8', k: 'trip' }, role: 'viewer' },
    { ref: { w: WORKER, s: 'e1e2e3e4e5f6g7h8', k: 'trip' }, role: 'owner', start: '2027-01-01', end: '2027-01-05' },
  ];
  it('watches owned trips on their own KV and joined ones through the read handle', () => {
    const { list, reasons } = desiredSubscriptions({ entries, prefs, uid: 'me', origin: 'https://trips.puter.com', today: '2027-05-10', appUid: 'app-1' });
    expect(list.map((item) => item.subject)).toEqual(['kv:app-1:me:notify:sched', 'kv:hR:sig', `kv:app-1:shared:${SPACE}:sig`]);
    expect(list[1].context).toEqual({ v: 1, k: 'trip', u: 'me', o: 'https://trips.puter.com', s: 'b1b2c3d4e5f6g7h8', w: 'trips-zzzzzzzzzz', h: 'hR' });
    expect(Object.fromEntries(reasons)).toEqual({ c1c2c3d4e5f6g7h8: 'off', d1d2d3d4e5f6g7h8: 'noAccess', e1e2e3e4e5f6g7h8: 'ended' });
    expect(desiredSubscriptions({ entries, prefs: { ...prefs, on: false }, uid: 'me', appUid: 'app-1', today: '2027-05-10' }).list).toEqual([]);
  });
  it('caps watched trips', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({ ref: { w: WORKER, s: `${String(index).padStart(2, '0')}aaaaaaaaaaaaaa`, k: 'trip' }, role: 'owner', start: `2027-06-${String(index + 1).padStart(2, '0')}` }));
    const { watch, reasons } = tripsToWatch(many, prefs, '2027-05-10');
    expect(watch).toHaveLength(20);
    expect([...reasons.values()]).toEqual(Array(5).fill('limit'));
  });
  it('reconciles: keeps one per subject, drops extras and revoked ones, creates the rest', async () => {
    const subs = [
      { subId: 's1', subject: 'kv:app-1:me:notify:sched', handlerName: 'tripsNotify' },
      { subId: 's2', subject: 'kv:app-1:me:notify:sched', handlerName: 'tripsNotify' },
      { subId: 's3', subject: 'kv:hR:sig', handlerName: 'tripsNotify', suspendedReason: 'permission_revoked' },
      { subId: 's4', subject: 'kv:old:sig', handlerName: 'tripsNotify' },
      { subId: 's5', subject: 'kv:app-1:other', handlerName: 'someoneElse' },
    ];
    const events = { list: vi.fn(async () => subs), unsubscribe: vi.fn(async () => {}), onPersistent: vi.fn(async (options) => ({ subId: `n-${options.subject}` })) };
    const { list } = desiredSubscriptions({ entries, prefs, uid: 'me', origin: 'https://trips.puter.com', today: '2027-05-10', appUid: 'app-1' });
    const result = await reconcileSubscriptions({ events }, list);
    expect(events.unsubscribe.mock.calls.map(([id]) => id)).toEqual(['s2', 's3', 's4']);
    expect(events.onPersistent.mock.calls.map(([options]) => options.subject)).toEqual(['kv:hR:sig', `kv:app-1:shared:${SPACE}:sig`]);
    expect(events.onPersistent.mock.calls[0][0]).toMatchObject({ handlerName: 'tripsNotify', targets: ['worker'], includeValue: true });
    expect([...result.watched].sort()).toEqual([SPACE, 'b1b2c3d4e5f6g7h8', 'sched'].sort());
    events.onPersistent.mockRejectedValueOnce(Object.assign(new Error('limit'), { code: 'events_subscription_limit' }));
    subs.length = 0;
    expect((await reconcileSubscriptions({ events }, list)).limit).toBe(true);
  });
});

// The handler against the fake runtime: alice owns the trip and runs her own handler.
function setup({ prefs = {}, secret = {}, fetchStatus = () => 200 } = {}) {
  let clock = START;
  // Email goes only to the account's confirmed address.
  const runtime = createFakePuter({ now: () => clock, users: [{ uuid: 'alice', username: 'alice', email: 'alice@example.org', email_confirmed: true }, 'bob', 'carol'] });
  const user = runtime.client('alice');
  const requests = [];
  const fetch = vi.fn(async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    const status = fetchStatus(requests.length);
    return new Response(status === 204 ? null : 'ok', { status: status === 0 ? 200 : status });
  });
  const ctx = { v: 1, k: 'trip', u: 'alice', o: 'https://trips.puter.com', s: SPACE, w: WORKER };
  const fullPrefs = { on: true, channels: { webhook: { on: true }, ntfy: { on: false } }, ...prefs };
  const fullSecret = { webhookUrl: 'https://hooks.example.org/in', webhookSecret: 's'.repeat(43), ...secret };
  const sleep = vi.fn(async (ms) => { clock += ms; });
  const run = (event, extra = {}) => runHandler({ event, ctx: extra.ctx ?? ctx, user: extra.user ?? user, fetch, now: () => clock, sleep });
  return {
    runtime, user, requests, fetch, ctx, sleep, run,
    advance: (ms) => { clock += ms; },
    now: () => clock,
    async init() {
      await user.kv.set(KEYS.prefs, fullPrefs);
      await user.kv.set(KEYS.secret, fullSecret, { disableSharing: true });
      await user.kv.set(`shared:${SPACE}:e:meta:meta`, { title: 'Lisbon' });
      await user.kv.set(`shared:${SPACE}:e:member:${BOB}`, { name: 'Bob', role: 'editor' });
    },
  };
}
const sigEvent = (value) => ({ id: 'ev', subject: `kv:trips:shared:${SPACE}:sig`, op: 'set', key: `shared:${SPACE}:sig`, value, self: true, viaWorker: true, ts: START });
const booking = (rev, by = BOB) => record(rev, [{ t: 'res', id: `r${rev}`, op: 'put', name: `Hotel ${rev}`, fields: [] }], by);

describe('events handler', () => {
  it('delivers a signed webhook once per change and skips own changes', async () => {
    const world = setup();
    await world.init();
    expect(await world.run(sigEvent(booking(1)))).toMatchObject({ notes: [`c-${SPACE}-1`] });
    expect(world.requests).toHaveLength(1);
    const [{ url, init, body }] = world.requests;
    expect(url).toBe('https://hooks.example.org/in');
    expect(init.redirect).toBe('manual');
    expect(init.headers['Trips-Delivery']).toBe(`c-${SPACE}-1`);
    expect(await verifySignature('s'.repeat(43), init.body, init.headers['Trips-Signature'], { now: START })).toBe(true);
    expect(body).toMatchObject({ type: 'trip.change', trip: { title: 'Lisbon' }, text: 'Bob added booking “Hotel 1”' });
    await world.run(sigEvent(booking(1)));
    expect(world.requests).toHaveLength(1);
    await world.run(sigEvent(booking(2, 'alice')));
    expect(world.requests).toHaveLength(1);
    expect((await world.user.kv.get(KEYS.status)).webhook).toMatchObject({ ok: true, status: 200 });
  });
  it('fills revs the coalesced events skipped from the change log', async () => {
    const world = setup();
    await world.init();
    await world.run(sigEvent(booking(1)));
    await world.user.kv.set(`shared:${SPACE}:ch:2:0`, booking(2));
    await world.user.kv.set(`shared:${SPACE}:ch:3:0`, booking(3));
    await world.user.kv.set(`shared:${SPACE}:sig`, { rev: 4 });
    await world.user.kv.set(`shared:${SPACE}:ch:4:0`, booking(4));
    await world.run({ op: 'gap', reason: 'reconnect' });
    expect(world.requests.at(-1).body.changes.map((change) => change.name)).toEqual(['Hotel 2', 'Hotel 3', 'Hotel 4']);
  });
  it('claims each rev once when two runs race', async () => {
    const world = setup();
    await world.init();
    await Promise.all([world.run(sigEvent(booking(1))), world.run(sigEvent(booking(1)))]);
    expect(world.requests).toHaveLength(1);
    const won = await claim(world.user.kv, [{ at: START, path: 'x.1' }, { at: START, path: 'x.2' }]);
    expect([...won]).toEqual(['x.1', 'x.2']);
    expect([...await claim(world.user.kv, [{ at: START, path: 'x.1' }])]).toEqual([]);
  });
  it('retries inline, then keeps the delivery and retries on a later run', async () => {
    const world = setup({ fetchStatus: (n) => (n <= 3 ? 503 : 200) });
    await world.init();
    await world.run(sigEvent(booking(1)));
    expect(world.requests).toHaveLength(3);
    expect(world.sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 3000]);
    const retry = await world.user.kv.get(KEYS.retry);
    const [id] = Object.keys(retry);
    expect(retry[id]).toMatchObject({ ch: 'webhook', n: 0 });
    await world.run(sigEvent(booking(1)));
    expect(world.requests).toHaveLength(3);
    world.advance(61_000);
    await world.run({ op: 'gap' }, { ctx: { ...world.ctx, k: 'sched' } });
    expect(world.requests).toHaveLength(4);
    expect(world.requests[3].init.headers['Trips-Delivery']).toBe(`c-${SPACE}-1`);
    expect(await world.user.kv.get(KEYS.retry)).toEqual({});
  });
  it('does not retry permanent failures', async () => {
    const world = setup({ fetchStatus: () => 404 });
    await world.init();
    await world.run(sigEvent(booking(1)));
    expect(world.requests).toHaveLength(1);
    expect(await world.user.kv.get(KEYS.retry)).toBeNull();
    expect((await world.user.kv.get(KEYS.status)).webhook).toMatchObject({ ok: false, status: 404 });
  });
  it('holds each push channel to the hourly limit', async () => {
    const world = setup();
    await world.init();
    for (let rev = 1; rev <= PUSH_PER_HOUR + 2; rev++) await world.run(sigEvent(booking(rev)));
    expect(world.requests).toHaveLength(PUSH_PER_HOUR);
    expect((await world.user.kv.get(KEYS.status)).webhook.dropped).toBe(1);
    world.advance(3_600_000);
    await world.run(sigEvent(booking(PUSH_PER_HOUR + 3)));
    expect(world.requests).toHaveLength(PUSH_PER_HOUR + 1);
  });
  it('sends due reminders once, and tests to every ready channel', async () => {
    const world = setup({ prefs: { channels: { webhook: { on: true }, ntfy: { on: true, server: 'https://ntfy.example.org' } } }, secret: { ntfyTopic: 'trips-topic', ntfyToken: 'tk_123' } });
    await world.init();
    await world.user.kv.set(KEYS.sched, { v: 1, items: {
      [`trip-${SPACE}-2027-05-11-1`]: { at: START - 60_000, kind: 'trip', space: SPACE, w: WORKER, trip: 'Rome', date: '2027-05-11', days: 1 },
      [`trip-${SPACE}-2027-05-11-7`]: { at: START + 86_400_000, kind: 'trip', space: SPACE, w: WORKER, trip: 'Rome', date: '2027-05-11', days: 7 },
    }, test: { id: 'test1', at: START } });
    const sched = { ...world.ctx, k: 'sched' };
    await world.run({ op: 'set' }, { ctx: sched });
    const sent = world.requests.map((request) => [request.url, request.body.type ?? request.body.title]);
    expect(sent).toEqual([['https://hooks.example.org/in', 'reminder'], ['https://ntfy.example.org/', 'Rome'], ['https://hooks.example.org/in', 'test'], ['https://ntfy.example.org/', 'Trips test notification']]);
    expect(world.requests[1].body).toMatchObject({ topic: 'trips-topic', message: 'Rome starts tomorrow', tags: ['alarm_clock'] });
    expect(world.requests[1].init.headers.Authorization).toBe('Bearer tk_123');
    expect((await world.user.kv.get(KEYS.status)).test).toEqual({ id: 'test1', at: START, results: { webhook: 'ok', ntfy: 'ok' } });
    await world.run({ op: 'set' }, { ctx: sched });
    expect(world.requests).toHaveLength(4);
  });
  it('collects email digests and sends one when the window has passed', async () => {
    const world = setup({ prefs: { channels: { webhook: { on: false }, email: { on: true, every: 'hour' } } }, secret: { email: 'alice@example.org' } });
    const sendTransactional = vi.fn(async () => ({ messageId: 'm1' }));
    world.user.email = { sendTransactional };
    await world.init();
    await world.run(sigEvent(booking(1)));
    expect(sendTransactional).not.toHaveBeenCalled();
    expect(Object.keys(await world.user.kv.get(KEYS.digest))).toEqual([`c-${SPACE}-1`]);
    world.advance(3_600_001);
    await world.run(sigEvent(booking(2)));
    expect(sendTransactional).toHaveBeenCalledTimes(1);
    expect(sendTransactional.mock.calls[0][0]).toMatchObject({ to: 'alice@example.org', subject: 'Trips: 2 updates' });
    expect(await world.user.kv.get(KEYS.digest)).toEqual({});
  });
  it('reports a missing paid plan and drops the digest', async () => {
    const world = setup({ prefs: { channels: { webhook: { on: false }, email: { on: true, every: 'hour' } } }, secret: { email: 'alice@example.org' } });
    world.user.email = { sendTransactional: vi.fn(async () => { throw Object.assign(new Error('plan'), { status: 402, code: 'subscription_required' }); }) };
    await world.init();
    await world.run(sigEvent(booking(1)));
    world.advance(3_600_001);
    await world.run(sigEvent(booking(2)));
    expect((await world.user.kv.get(KEYS.status)).email).toMatchObject({ ok: false, code: 'plan' });
    expect(await world.user.kv.get(KEYS.digest)).toEqual({});
  });
  it('refuses a private webhook URL written outside the app', async () => {
    const world = setup({ secret: { webhookUrl: 'https://169.254.169.254/latest' } });
    await world.init();
    expect(await world.run(sigEvent(booking(1)))).toEqual({ reason: 'off' });
    expect(world.fetch).not.toHaveBeenCalled();
  });
  it('ignores bad contexts and its own schedule writes', async () => {
    const world = setup();
    await world.init();
    expect(await world.run(sigEvent(booking(1)), { ctx: { v: 2 } })).toEqual({ reason: 'context' });
    expect(await world.run({ op: 'set', self: true, viaWorker: true }, { ctx: { ...world.ctx, k: 'sched' } })).toEqual({ reason: 'self' });
    expect(await world.run({ op: 'del' })).toEqual({ reason: 'op' });
  });
});
