import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError, createWorkerClient } from '../../src/lib/api.js';
import { openSpaceStore } from '../../src/lib/store/space.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createSyncEngine } from '../../src/lib/sync/index.js';
import { createPathA } from '../../src/lib/sync/path-a.js';
import { createPathC } from '../../src/lib/sync/path-c.js';
import { createClock } from '../../src/shared/hlc.js';

// Client behaviour the worker protocol relies on (data-model §6, handoffs F5 notes).
const uid = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
let seq = 100;
const makeId = () => String(++seq).padStart(16, '0');
const clock = createClock({ node: '0000000000000009', now: () => 1000 });
const place = (name, rev) => ({ t: 'place', id: `p${String(rev).padStart(15, '0')}`, name, rev, v: clock.tick(), by: other, cr: 1000, upd: 1000 });
const record = (rev) => ({ rev, at: 1000, by: other, ents: [place(`Place ${rev}`, rev)], del: [], sum: [] });
const databases = [];
async function database() { const db = await openDatabase(uid, { indexedDB: new IDBFactory() }); databases.push(db); return db; }
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });

describe('path C', () => {
  it('pulls again at once while the worker answers `more`', async () => {
    const store = await openSpaceStore({ ref, db: await database(), makeId, api: { commit: vi.fn() } });
    const api = { call: vi.fn(async (_, op, { since }) => {
      expect(op).toBe('sync');
      return since === 0 ? { rev: 3, changes: [record(1), record(2)], more: true } : { rev: 3, changes: [record(3)] };
    }) };
    const result = await createPathC({ store, api, uid }).pull(() => true);
    expect(api.call.mock.calls.map(([, , input]) => input)).toEqual([{ since: 0 }, { since: 2 }]);
    expect(result).toEqual({ applied: true, remote: true, behind: false });
    expect(store.rev).toBe(3);
  });

  it('stops after 10 capped answers in one pull and reports the rest as behind', async () => {
    const store = await openSpaceStore({ ref, db: await database(), makeId, api: { commit: vi.fn() } });
    const api = { call: vi.fn(async (_, op, { since }) => ({ rev: 50, changes: [record(since + 1)], more: true })) };
    expect(await createPathC({ store, api, uid }).pull(() => true)).toMatchObject({ applied: true, behind: true });
    expect(api.call).toHaveBeenCalledTimes(10);
    expect(store.rev).toBe(10);
  });
});

describe('path A polls', () => {
  it('reads the next record with the signal, so a signal written out of order cannot hide it', async () => {
    const store = await openSpaceStore({ ref, db: await database(), makeId, api: { commit: vi.fn() } });
    await store.receive([record(1), record(2)]);
    // Commits 3 and 4 raced: the signal still says 3 but record 4 is readable.
    const kv = new Map([['sig', record(3)], ['ch:3:0', { ...record(3), parts: 1 }], ['ch:4:0', { ...record(4), parts: 1 }]]);
    const scope = { get: vi.fn(async (key) => kv.get(key) ?? null), getMany: vi.fn(async (keys) => keys.map((key) => kv.get(key) ?? null)) };
    const path = createPathA({ store, puter: {}, scope, uid });
    expect(await path.pull(() => true)).toMatchObject({ applied: true });
    expect(store.rev).toBe(3);
    expect(scope.getMany).toHaveBeenLastCalledWith(['sig', 'ch:3:0']);
    expect(await path.pull(() => true)).toMatchObject({ applied: true, behind: false });
    expect(store.rev).toBe(4);
    expect(scope.getMany).toHaveBeenLastCalledWith(['sig', 'ch:4:0']);
    expect(await path.pull(() => true)).toEqual({ applied: false, remote: false, behind: false });
    expect(scope.getMany).toHaveBeenCalledTimes(3);
    expect(scope.get).not.toHaveBeenCalled();
  });

  it('reuses the polled chunk 0 of a multi-part record instead of reading it again', async () => {
    const store = await openSpaceStore({ ref, db: await database(), makeId, api: { commit: vi.fn() } });
    await store.receive([record(1)]);
    const second = record(2);
    const kv = new Map([['sig', { rev: 3 }], ['ch:2:0', { ...second, ents: [], parts: 2 }], ['ch:2:1', { rev: 2, ents: second.ents, del: [] }], ['ch:3:0', { ...record(3), parts: 1 }]]);
    const scope = { get: vi.fn(), getMany: vi.fn(async (keys) => keys.map((key) => kv.get(key) ?? null)) };
    expect(await createPathA({ store, puter: {}, scope, uid }).pull(() => true)).toMatchObject({ applied: true, behind: false });
    expect(store.rev).toBe(3);
    expect(store.get('place', second.ents[0].id).name).toBe('Place 2');
    expect(scope.getMany.mock.calls.map(([keys]) => keys)).toEqual([['sig', 'ch:2:0'], ['ch:3:0'], ['ch:2:1']]);
  });
});

describe('commit acknowledgements and rate limits', () => {
  it('keeps a rate-limited batch queued, holds sends for `retryAfter` and never moves the cursor on an ack', async () => {
    let now = 1_000_000;
    const op = { opId: makeId(), t: 'place', id: makeId(), put: { name: 'Queued' } };
    const commit = vi.fn()
      .mockRejectedValueOnce(new ApiError(429, 'rate_limited', { retryAfter: 30 }))
      .mockResolvedValueOnce({ rev: 7, ents: [{ ...place('Queued', 7), id: op.id, by: uid }], del: [], done: { [op.opId]: 7 } });
    const store = await openSpaceStore({ ref, db: await database(), makeId, api: { commit }, now: () => now });
    await store.apply([op]);
    const failed = await store.flush();
    expect(failed).toMatchObject({ status: 'queued', error: { status: 429 } });
    expect(store.conflicts).toEqual([]);
    expect(store.pending.map((item) => item.opId)).toEqual([op.opId]);
    const frozen = store.batch.body;
    expect(await store.flush()).toEqual({ status: 'queued', held: true });
    expect(commit).toHaveBeenCalledTimes(1);
    now += 30_001;
    expect(await store.flush()).toMatchObject({ status: 'sent', rev: 7 });
    expect(commit.mock.calls.map(([, body]) => body)).toEqual([frozen, frozen]);
    expect(store.rev).toBe(0);
  });

  it('reports a commit 429 as queued and keeps polling; a pull 429 waits out `retryAfter`', async () => {
    const limited = new ApiError(429, 'rate_limited', { retryAfter: 3600 });
    const store = { ref, rev: 0, pending: [{}], conflicts: [], receive: vi.fn(), flush: vi.fn(async () => ({ status: 'queued', error: limited })) };
    const api = { call: vi.fn(async () => ({ rev: 0, changes: [] })) };
    const setTimer = vi.fn(); const states = [];
    const engine = createSyncEngine({ store, api, now: () => 0, setTimer, clearTimer: vi.fn(), onState: (state) => states.push(state), document: null, window: null });
    await engine.start();
    expect(states.at(-1)).toBe('queued');
    // The store holds sends; the engine still pulls on its normal backoff.
    expect(setTimer.mock.calls.at(-1)[1]).toBe(2000);
    api.call.mockRejectedValueOnce(new ApiError(429, 'rate_limited', { retryAfter: 45 }));
    await engine.sync(); engine.stop();
    expect(setTimer.mock.calls.at(-1)[1]).toBe(45_000);
  });

  it('holds the frozen batch for other tabs too', async () => {
    let now = 1_000_000;
    const db = await database();
    const op = { opId: makeId(), t: 'place', id: makeId(), put: { name: 'Queued' } };
    const commit = vi.fn().mockRejectedValueOnce(new ApiError(429, 'rate_limited', { retryAfter: 30 }));
    const first = await openSpaceStore({ ref, db, makeId, api: { commit }, now: () => now });
    const second = await openSpaceStore({ ref, db, makeId, api: { commit }, now: () => now });
    await first.apply([op]);
    expect((await first.flush()).status).toBe('queued');
    await second.refresh();
    expect(await second.flush()).toEqual({ status: 'queued', held: true });
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe('a space missing on the worker', () => {
  it('retries a brief `space_not_found` and reports the space gone only when it lasts', async () => {
    let now = 1_000_000;
    let missing = true;
    const api = { call: vi.fn(async (_, op) => {
      if (op === 'pres') return { active: {} };
      if (missing) throw new ApiError(404, 'space_not_found');
      return { rev: 0, changes: [] };
    }) };
    const space = await openSpace({ ref, db: await database(), api, puter: {}, personal: null, uid, open: false, makeId, now: () => now,
      setTimer: () => 0, clearTimer: () => {}, document: null, window: null });
    expect(space.state).toMatchObject({ sync: 'offline', issue: null });
    now += 60_000; await space.sync();
    expect(space.state.issue).toBeNull();
    now += 60_001; await space.sync();
    expect(space.state.issue).toBe('gone');
    missing = false;
    await space.sync();
    expect(space.state).toMatchObject({ sync: 'synced', issue: null });
    space.close();
  });

  it('restarts the grace period after any other failure', async () => {
    let now = 1_000_000;
    let failure = new ApiError(404, 'space_not_found');
    const api = { call: vi.fn(async (_, op) => { if (op === 'pres') return { active: {} }; throw failure; }) };
    const space = await openSpace({ ref, db: await database(), api, puter: {}, personal: null, uid, open: false, makeId, now: () => now,
      setTimer: () => 0, clearTimer: () => {}, document: null, window: null });
    failure = new ApiError(0, 'network');
    now += 3_600_000; await space.sync();
    failure = new ApiError(404, 'space_not_found');
    await space.sync();
    expect(space.state.issue).toBeNull();
    now += 120_000; await space.sync();
    expect(space.state.issue).toBe('gone');
    space.close();
  });
});

describe('worker client signing', () => {
  const worker = 'trips-012345abcd';
  function client(responses) {
    const credentials = { headers: vi.fn(async () => ({ 'puter-auth': 'restricted', 'x-trips-proof': '{}' })) };
    const puter = { authToken: 'session', workers: { exec: vi.fn(async () => responses.shift()) } };
    return { credentials, puter, api: createWorkerClient({ puter, credentials }) };
  }
  const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

  it('re-signs once on `proof_expired`, refreshes once on other 401s, and never loops', async () => {
    const expired = () => reply(401, { code: 'proof_expired', message: 'x', now: 1234 });
    let c = client([expired(), reply(200, { ok: true })]);
    await c.api.request(worker, JSON.stringify({ op: 'hello' }));
    expect(c.credentials.headers.mock.calls.map(([, , options]) => options)).toEqual([{}, { serverNow: 1234 }]);
    c = client([expired(), expired()]);
    await expect(c.api.request(worker, JSON.stringify({ op: 'hello' }))).rejects.toMatchObject({ status: 401, code: 'proof_expired' });
    expect(c.puter.workers.exec).toHaveBeenCalledTimes(2);
    c = client([reply(401, { code: 'credential_rejected' }), expired()]);
    await expect(c.api.request(worker, JSON.stringify({ op: 'hello' }))).rejects.toMatchObject({ status: 401 });
    expect(c.credentials.headers.mock.calls.map(([, , options]) => options)).toEqual([{}, { refresh: true }]);
  });

  it('takes `retryAfter` from the body, else from the Retry-After header', async () => {
    let c = client([reply(429, { code: 'rate_limited', retryAfter: 12 }, { 'retry-after': '5' })]);
    await expect(c.api.request(worker, JSON.stringify({ op: 'hello' }))).rejects.toMatchObject({ status: 429, retryAfter: 12 });
    c = client([reply(503, { code: 'busy' }, { 'retry-after': '5' })]);
    await expect(c.api.request(worker, JSON.stringify({ op: 'hello' }))).rejects.toMatchObject({ status: 503, retryAfter: 5 });
  });
});
