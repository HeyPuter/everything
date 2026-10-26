// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { K } from '../../worker/keys.js';
import { ORIGIN, USERS, createHarness, expectError, id } from './harness.js';

const fetchFeed = async (h, path, headers = {}) => (await h.client('dave')).puter.workers.exec(ORIGIN + path, { headers: { 'x-puter-no-auth': '1', ...headers } });
const OWNER = USERS.alice.uuid;

async function setup() {
  const h = await createHarness({ ownerVerified: false });
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const bob = (await h.client('bob')).in(space);
  const [day, place, visit, flight, stay, mine, theirs] = ['d', 'p', 'v', 'r', 'r', 't', 't'].map((prefix) => id(prefix));
  await bob.call('commit', { ops: [
    { opId: id('o'), t: 'day', id: day, put: { date: '2027-05-01', order: 'a', title: 'Arrive' } },
    { opId: id('o'), t: 'place', id: place, put: { name: 'Belém Tower', address: 'Av. Brasília', tz: 'Europe/Lisbon' } },
    { opId: id('o'), t: 'visit', id: visit, put: { dayId: day, placeId: place, order: 'a', start: '10:00', end: '11:00' } },
    { opId: id('o'), t: 'res', id: flight, put: { type: 'flight', title: 'Outbound', status: 'confirmed', code: 'ABC123', legs: [{ from: { code: 'JFK', tz: 'America/New_York' }, to: { code: 'LIS', tz: 'Europe/Lisbon' }, dep: { date: '2027-04-30', time: '22:00' }, arr: { date: '2027-05-01', time: '10:00' }, seat: '12A', code: 'SEAT9' }] } },
    { opId: id('o'), t: 'res', id: stay, put: { type: 'lodging', title: 'Hotel', status: 'pending', start: { date: '2027-05-01' }, end: { date: '2027-05-04' } } },
    { opId: id('o'), t: 'todo', id: mine, put: { name: 'Carol task', list: 'Prep', order: 'a', due: '2027-04-20', who: USERS.carol.uuid } },
    { opId: id('o'), t: 'todo', id: theirs, put: { name: 'Bob task', list: 'Prep', order: 'b', due: '2027-04-21', who: USERS.bob.uuid } },
  ] });
  const carol = (await h.client('carol')).in(space);
  return { h, space, carol, ids: { day, place, visit, flight, stay, mine, theirs } };
}

describe('trip ICS feed', () => {
  it('serves the plan, bookings, stays and the member’s own to-dos', async () => {
    const { h, space, carol, ids } = await setup();
    const feed = await carol.call('feed.set');
    const response = await fetchFeed(h, feed.path);
    expect(response.status).toBe(200);
    const text = (await response.text()).replace(/\r\n /g, '');
    expect(text).toContain(`UID:${space}-trip@trips.puter.com`);
    expect(text).toContain('DTSTART;TZID=Europe/Lisbon:20270501T100000');
    expect(text).toContain('DTSTART;TZID=America/New_York:20270430T220000\r\nDTEND;TZID=Europe/Lisbon:20270501T100000');
    expect(text).toContain(`UID:${space}-res-${ids.stay}@trips.puter.com`);
    expect(text).toContain('SUMMARY:Day 1: Arrive');
    expect(text).toContain('SUMMARY:To-do: Carol task');
    expect(text).not.toContain('Bob task');
    expect(text).toContain('BEGIN:VALARM');
    expect(text).toContain('BEGIN:VTIMEZONE\r\nTZID:America/New_York');
    expect(text).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    expect(text).toContain('SUMMARY:Outbound\r\nLOCATION:JFK\r\nDESCRIPTION:JFK → LIS');
    expect(text).not.toMatch(/ABC123|SEAT9|12A/);
    for (const user of Object.values(USERS)) expect(text).not.toContain(user.uuid);
  });

  it('honours the day-event and alarm options', async () => {
    const { h, carol } = await setup();
    const feed = await carol.call('feed.set');
    const text = await (await fetchFeed(h, `${feed.path}?days=0&alarms=0`)).text();
    expect(text).not.toContain('Day 1');
    expect(text).not.toContain('VALARM');
    expect(text).toContain('Belém Tower');
  });

  it('answers 304 for a matching ETag and changes the ETag with the data', async () => {
    const { h, space, carol } = await setup();
    const feed = await carol.call('feed.set');
    const first = await fetchFeed(h, feed.path);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get('cache-control')).toBe('max-age=900');
    const again = await fetchFeed(h, feed.path, { 'If-None-Match': `W/${etag}, "other"` });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
    expect(await again.text()).toBe('');
    // A different option set is a different representation.
    expect((await fetchFeed(h, `${feed.path}?days=0`, { 'If-None-Match': etag })).status).toBe(200);
    const alice = (await h.client('alice')).in(space);
    await alice.call('commit', { ops: [{ opId: id('o'), t: 'meta', id: 'meta', set: { title: 'Renamed' } }] });
    h.advance(11 * 60_000);
    await fetchFeed(h, feed.path);
    await h.settle();
    const changed = await fetchFeed(h, feed.path, { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toContain('X-WR-CALNAME:Renamed');
  });

  it('serves a cached feed without owner reads', async () => {
    const { h, carol } = await setup();
    const feed = await carol.call('feed.set');
    expect((await fetchFeed(h, feed.path)).status).toBe(200);
    h.world.resetCounters();
    expect((await fetchFeed(h, feed.path)).status).toBe(200);
    const owner = h.world.counters().byUser[OWNER] ?? {};
    expect(owner.kvReadUnits ?? 0).toBeLessThanOrEqual(1);
    expect(owner.calls?.['fs.read'] ?? 0).toBe(0);
    expect(owner.calls?.['kv.set'] ?? 0).toBe(0);
  });

  it('lets every member manage only their own feed; others get nothing', async () => {
    const { h, space, carol } = await setup();
    await expectError((await h.client('dave')).in(space).call('feed.set'), 403, 'not_member');
    const feed = await carol.call('feed.set');
    expect(h.kv()[K.feed(space, USERS.carol.uuid)].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(h.kv())).not.toContain(feed.token);
    expect(await carol.call('feed.set', { revoke: true })).toEqual({ ok: true, revoked: true });
    expect(h.kv()[K.feed(space, USERS.carol.uuid)]).toBeUndefined();
    expect((await fetchFeed(h, feed.path)).status).toBe(404);
    const fresh = await carol.call('feed.set');
    expect(fresh.token).not.toBe(feed.token);
    expect((await fetchFeed(h, fresh.path)).status).toBe(200);
  });

  it('rejects malformed feed paths', async () => {
    const { h, space } = await setup();
    expect((await fetchFeed(h, `/ics/${space}/${USERS.carol.uuid}/not-a-token.ics`)).status).toBe(404);
    expect((await fetchFeed(h, `/ics/${space}/${USERS.carol.uuid}/${'0'.repeat(32)}.txt`)).status).toBe(404);
  });
});
