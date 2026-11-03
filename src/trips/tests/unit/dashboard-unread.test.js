// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { ApiError } from '../../src/lib/api.js';
import { feedKey, noteSeen, readSeen, seenKey } from '../../src/lib/store/feed.js';
import { loadTrips, refreshHeads, tripUnread } from '../../src/views/dashboard/data.js';

const me = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
const other = { w: 'trips-012345abcd', s: '0000000000000002', k: 'trip' };

function memoryDb(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async get(key) { return structuredClone(map.get(key)); },
    async update(key, change) { const next = change(structuredClone(map.get(key))); map.set(key, next); return next; },
  };
}
const entry = (rev, by) => ({ rev, at: 1, by, items: [{ t: 'place', id: '0000000000000009', name: 'x', fields: [], op: 'add' }] });

describe('local read marker', () => {
  it('only moves forward and ignores bad values', async () => {
    const db = memoryDb();
    expect(await readSeen(db, ref)).toBeNull();
    await noteSeen(db, ref, 0);
    expect(await readSeen(db, ref)).toBe(0);
    await noteSeen(db, ref, 5);
    await noteSeen(db, ref, 3);
    await noteSeen(db, ref, -1);
    await noteSeen(db, ref, 1.5);
    expect(await readSeen(db, ref)).toBe(5);
    expect(db.map.get(seenKey(ref))).toBe(5);
  });

  it('is written when an open trip is marked seen or counts its unread activity', async () => {
    const world = createFakePuter({ users: [{ uuid: me, username: 'me' }] });
    const puter = world.client(me);
    const db = await openDatabase(me, { indexedDB: new IDBFactory() });
    const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 0, changes: [] })), snapshot: vi.fn() };
    const space = await openSpace({ ref, db, api, puter, personal: createPersonalStore({ puter, db }), role: 'editor', setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
    try {
      await space.unread();
      await vi.waitFor(async () => expect(await readSeen(db, ref)).toBe(0));
      await space.markSeen(7);
      await vi.waitFor(async () => expect(await readSeen(db, ref)).toBe(7));
    } finally { space.close(); db.close(); }
  });
});

describe('dashboard unread counts', () => {
  it('counts entries by others after the local marker, and is unknown without one', async () => {
    const db = memoryDb({ [feedKey(ref)]: [entry(1, bob), entry(2, me), entry(3, bob), entry(4, bob)], [seenKey(ref)]: 3, [feedKey(other)]: [entry(1, bob)] });
    expect(await tripUnread(db, ref, me)).toBe(1);
    expect(await tripUnread(db, other, me)).toBeNull();
    const personal = { spaces: { list: async () => [{ ref, role: 'editor', title: 'Lisbon' }, { ref: other, role: 'editor', title: 'Porto' }] } };
    const trips = await loadTrips({ personal, db, account: { uuid: me } });
    expect(trips.map((trip) => [trip.title, trip.unread, trip.ahead])).toEqual([['Lisbon', 1, false], ['Porto', null, false]]);
  });

  it('flags trips whose worker is ahead of this device', async () => {
    const db = memoryDb({ [`space:${ref.w}:${ref.s}`]: { rev: 4, confirmed: { 'meta:meta': { id: 'meta', title: 'Lisbon' } }, pending: [] }, [seenKey(ref)]: 4 });
    const personal = { spaces: { list: async () => [{ ref, role: 'editor', title: 'Lisbon' }, { ref: other, role: 'editor', title: 'Porto' }], upsert: async () => {} } };
    const trips = await loadTrips({ personal, db, account: { uuid: me } });
    const heads = (revs) => ({ request: async () => ({ ok: true, heads: Object.fromEntries(Object.entries(revs).map(([id, rev]) => [id, { rev, title: id === ref.s ? 'Lisbon' : 'Porto', role: 'editor' }])) }) });
    const same = await refreshHeads(trips, { api: heads({ [ref.s]: 4, [other.s]: 9 }), personal });
    expect(same.map((trip) => trip.ahead)).toEqual([false, false]);
    const newer = await refreshHeads(trips, { api: heads({ [ref.s]: 6, [other.s]: 9 }), personal });
    // Only a trip with a local replica can be ahead; Porto was never opened here.
    expect(newer.map((trip) => trip.ahead)).toEqual([true, false]);
  });

  it('marks trips unavailable when their worker is gone and stale when it is unreachable', async () => {
    const personal = { spaces: { list: async () => [{ ref, role: 'editor', title: 'Lisbon' }], upsert: async () => {} } };
    const trips = await loadTrips({ personal, db: memoryDb(), account: { uuid: me } });
    const failing = (error) => ({ request: async () => { throw error; } });
    expect((await refreshHeads(trips, { api: failing(new ApiError(404, 'http_404')), personal }))[0]).toMatchObject({ unavailable: true, stale: false });
    expect((await refreshHeads(trips, { api: failing(Object.assign(new Error('gone'), { status: 404, code: 'worker_not_found' })), personal }))[0]).toMatchObject({ unavailable: true });
    expect((await refreshHeads(trips, { api: failing(new ApiError(0, 'network')), personal }))[0]).toMatchObject({ unavailable: false, stale: true });
    expect((await refreshHeads(trips, { api: failing(new ApiError(404, 'space_not_found')), personal }))[0]).toMatchObject({ unavailable: false, stale: true });
  });
});
