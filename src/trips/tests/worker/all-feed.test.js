// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { K } from '../../worker/keys.js';
import { endedLongAgo } from '../../worker/engine/public.js';
import { resetAllFeedCache } from '../../worker/ops/feed/all.js';
import { ORIGIN, USERS, WORKER, createHarness, expectError, id } from './harness.js';

const ALICE = USERS.alice.uuid;
const REMOTE = 'trips-zzzzzzzzzz';
const fetchPath = async (h, path, headers = {}) => (await h.client('dave')).puter.workers.exec(ORIGIN + path, { headers: { 'x-puter-no-auth': '1', ...headers } });
const remoteCalendar = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Asia/Tokyo\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:remote-trip@trips.puter.com\r\nSUMMARY:Kyoto with Bob\r\nDTSTART;TZID=Asia/Tokyo:20270901T090000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
let fetcher;

beforeEach(() => {
  resetAllFeedCache();
  fetcher = vi.fn(async (url) => (String(url).startsWith(`https://${REMOTE}.puter.work/ics/`) ? new Response(remoteCalendar, { status: 200, headers: { etag: '"r1"' } }) : new Response('', { status: 404 })));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const h = await createHarness();
  const space = await h.team({ bob: 'editor' });
  const alice = await h.client('alice');
  await alice.in(space).call('commit', { ops: [{ opId: id('o'), t: 'day', id: id('d'), put: { date: '2027-05-01', order: 'a', title: 'Arrive' } }] });
  return { h, space, alice, bob: await h.client('bob') };
}

describe('all-trips feed tokens', () => {
  it('keeps a separate token per member that the trip feed also accepts', async () => {
    const { h, space, alice } = await setup();
    const own = await alice.in(space).call('feed.set');
    const all = await alice.in(space).call('feed.set', { scope: 'all' });
    expect(all.scope).toBe('all');
    expect(all.token).not.toBe(own.token);
    expect(await alice.in(space).call('feed.set', { scope: 'all' })).toEqual({ ok: true, exists: true, scope: 'all' });
    expect((await fetchPath(h, own.path)).status).toBe(200);
    expect((await fetchPath(h, all.path)).status).toBe(200);
    await alice.in(space).call('feed.set', { scope: 'all', revoke: true });
    h.advance(61_000);
    expect((await fetchPath(h, all.path)).status).toBe(404);
    expect((await fetchPath(h, own.path)).status).toBe(200);
    await expectError(alice.in(space).call('feed.set', { scope: 'everything' }), 400, 'invalid_scope');
  });

  it('empties the calendar of an archived or long-ended trip with recent', async () => {
    const { h, space, alice } = await setup();
    const all = await alice.in(space).call('feed.set', { scope: 'all' });
    expect(await (await fetchPath(h, `${all.path}?recent=90`)).text()).toContain('Day 1: Arrive');
    await alice.in(space).call('commit', { ops: [{ opId: id('o'), t: 'meta', id: 'meta', set: { archived: true } }] });
    h.advance(11 * 60_000);
    await fetchPath(h, all.path);
    await h.settle();
    const text = await (await fetchPath(h, `${all.path}?recent=90`)).text();
    expect(text).not.toContain('BEGIN:VEVENT');
    expect(await (await fetchPath(h, all.path)).text()).toContain('BEGIN:VEVENT');
  });

  it('decides what ended long ago from the dates', () => {
    const now = Date.parse('2027-09-01T12:00:00Z');
    expect(endedLongAgo({ start: '2027-05-01', end: '2027-06-01' }, now, 90)).toBe(true);
    expect(endedLongAgo({ start: '2027-05-01', end: '2027-06-10' }, now, 90)).toBe(false);
    expect(endedLongAgo({ start: '2027-05-01', dayCount: 60 }, now, 90)).toBe(false);
    expect(endedLongAgo({}, now, 90)).toBe(false);
    expect(endedLongAgo({ archived: true }, now, 90)).toBe(true);
  });
});

describe('feed.all', () => {
  it('is for the worker owner only and validates every feed', async () => {
    const { space, alice, bob } = await setup();
    await expectError(bob.call('feed.all', { add: [] }), 403, 'forbidden');
    const token = 'a'.repeat(32);
    await expectError(alice.call('feed.all', { add: [{ w: 'evil.example', s: space, uuid: ALICE, token }] }), 400, 'invalid_feed');
    await expectError(alice.call('feed.all', { add: [{ w: WORKER, s: space, uuid: USERS.bob.uuid, token }] }), 400, 'invalid_feed');
    await expectError(alice.call('feed.all', { add: [{ w: WORKER, s: space, uuid: ALICE, token: 'short' }] }), 400, 'invalid_feed');
    expect(await alice.call('feed.all', {})).toEqual({ ok: true, exists: false, feeds: [] });
  });

  it('merges trips here and on other workers, with ETags and a cached body', async () => {
    const { h, space, alice } = await setup();
    const local = await alice.in(space).call('feed.set', { scope: 'all' });
    const remoteSpace = id('s');
    const created = await alice.call('feed.all', { add: [
      { w: WORKER, s: space, uuid: ALICE, token: local.token, title: 'Lisbon' },
      { w: REMOTE, s: remoteSpace, uuid: ALICE, token: 'b'.repeat(32), title: 'Kyoto' },
    ] });
    expect(created.path).toMatch(/^\/feed\/[0-9a-f]{32}\.ics$/);
    expect(created.feeds).toEqual([{ w: WORKER, s: space, title: 'Lisbon' }, { w: REMOTE, s: remoteSpace, title: 'Kyoto' }]);
    expect(JSON.stringify(h.kv()[K.allFeed])).not.toContain(created.token);
    const again = await alice.call('feed.all', { add: [{ w: REMOTE, s: remoteSpace, uuid: ALICE, token: 'c'.repeat(32), title: 'Kyoto' }] });
    expect(again.token).toBeUndefined();
    expect(again.feeds).toHaveLength(2);

    const response = await fetchPath(h, created.path);
    expect(response.status).toBe(200);
    const text = (await response.text()).replace(/\r\n /g, '');
    expect(text).toContain('X-WR-CALNAME:All my trips');
    expect(text).toContain('Day 1: Arrive');
    expect(text).toContain('SUMMARY:Kyoto with Bob');
    expect(text.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
    expect(fetcher.mock.calls[0][0]).toBe(`https://${REMOTE}.puter.work/ics/${remoteSpace}/${ALICE}/${'c'.repeat(32)}.ics?recent=90`);
    const etag = response.headers.get('etag');
    expect((await fetchPath(h, created.path, { 'If-None-Match': etag })).status).toBe(304);

    h.world.resetCounters();
    expect((await fetchPath(h, created.path)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const owner = h.world.counters().byUser[ALICE] ?? {};
    expect(owner.kvReadUnits ?? 0).toBe(0);
    expect(owner.calls?.['kv.set'] ?? 0).toBe(0);
  });

  it('refuses wrong tokens, rotates and revokes', async () => {
    const { h, space, alice } = await setup();
    const local = await alice.in(space).call('feed.set', { scope: 'all' });
    const created = await alice.call('feed.all', { add: [{ w: WORKER, s: space, uuid: ALICE, token: local.token }] });
    expect((await fetchPath(h, `/feed/${'0'.repeat(32)}.ics`)).status).toBe(404);
    expect((await fetchPath(h, '/feed/nope.ics')).status).toBe(404);
    const rotated = await alice.call('feed.all', { rotate: true });
    expect(rotated.token).not.toBe(created.token);
    expect((await fetchPath(h, created.path)).status).toBe(404);
    expect((await fetchPath(h, rotated.path)).status).toBe(200);
    const removed = await alice.call('feed.all', { remove: [{ w: WORKER, s: space }] });
    expect(removed.feeds).toEqual([]);
    expect(await alice.call('feed.all', { revoke: true })).toMatchObject({ revoked: true, exists: false });
    expect(h.kv()[K.allFeed]).toBeUndefined();
    expect((await fetchPath(h, rotated.path)).status).toBe(404);
  });
});
