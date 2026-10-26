import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBDatabase } from 'fake-indexeddb';
import { openDatabase } from '../../src/lib/idb.js';
import { openSpaceStore } from '../../src/lib/store/space.js';
import { createSyncEngine } from '../../src/lib/sync/index.js';
import { createOutbox } from '../../src/lib/outbox.js';
import { createClock } from '../../src/shared/hlc.js';

const uid = '00000000-0000-4000-8000-000000000001';
const id = '0000000000000001';
const ref = { w: 'trips-012345abcd', s: id, k: 'trip' };
const stateKey = `space:${ref.w}:${ref.s}`;
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const databases = [];
let seq = 100;
const makeId = () => String(++seq).padStart(16, '0');
const clock = createClock({ node: id, now: () => 1000 });
const entity = (name = 'Place', rev = 1) => ({ t: 'place', id, name, rev, v: clock.tick(), by: uid, cr: 1000, upd: 1000 });
const put = () => ({ opId: makeId(), t: 'place', id, put: { name: 'Place' } });
const ack = (op, data = entity()) => ({ rev: data.rev, ents: [data], del: [], done: { [op.opId]: data.rev } });
async function database(factory = new IDBFactory()) { const db = await openDatabase(uid, { indexedDB: factory }); databases.push(db); return db; }
function syncSetup(overrides = {}) {
  const store = { ref, rev: 0, pending: [], receive: vi.fn(async () => {}), replace: vi.fn(async () => {}), flush: vi.fn(async () => ({ status: 'idle' })) };
  const api = { call: vi.fn(async () => ({ rev: 0, changes: [] })), snapshot: vi.fn(async () => ({ rev: 0, ents: [] })) };
  const onState = vi.fn(), onError = vi.fn(), setTimer = vi.fn(), clearTimer = vi.fn();
  const engine = createSyncEngine({ store, api, onState, onError, setTimer, clearTimer, ...overrides });
  return { store, api, onState, onError, setTimer, clearTimer, engine };
}
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.restoreAllMocks(); });

describe('sync run lifecycle', () => {
  it.each([false, true])('drops stopped initial pull results (reset=%s)', async (reset) => {
    const pending = defer(); const { engine, api, store, onState } = syncSetup(); api.call.mockReturnValueOnce(pending.promise);
    const start = engine.start(); engine.stop(); pending.resolve({ rev: 1, reset, changes: [{ rev: 1, ents: [], del: [] }] }); await start;
    expect(store.receive).not.toHaveBeenCalled(); expect(store.replace).not.toHaveBeenCalled(); expect(api.snapshot).not.toHaveBeenCalled(); expect(store.flush).not.toHaveBeenCalled(); expect(onState.mock.calls).toEqual([['syncing']]);
  });
  it('suppresses a stopped post-commit pull and final status', async () => {
    const pending = defer(); const { engine, api, store, onState } = syncSetup(); store.flush.mockResolvedValue({ status: 'sent' }); api.call.mockResolvedValueOnce({ rev: 0, changes: [] }).mockReturnValueOnce(pending.promise);
    const start = engine.start(); await vi.waitFor(() => expect(api.call).toHaveBeenCalledTimes(2)); engine.stop(); pending.resolve({ rev: 1, changes: [{ rev: 1, ents: [], del: [] }] }); await start;
    expect(store.receive).not.toHaveBeenCalled(); expect(onState.mock.calls).toEqual([['syncing']]);
  });
  it('discards a snapshot that finishes after stop', async () => {
    const pending = defer(); const { engine, api, store } = syncSetup(); api.call.mockResolvedValue({ rev: 1, reset: true }); api.snapshot.mockReturnValue(pending.promise);
    const start = engine.start(); await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledOnce()); engine.stop(); pending.resolve({ rev: 1, ents: [] }); await start; expect(store.replace).not.toHaveBeenCalled();
  });
  it('restarts independently of a stalled old run and ignores its late failure', async () => {
    const pending = defer(); const { engine, api, store, onError, onState } = syncSetup(); api.call.mockReturnValueOnce(pending.promise);
    const old = engine.start(); engine.stop(); await engine.start(); expect(api.call).toHaveBeenCalledTimes(2); expect(store.flush).toHaveBeenCalledOnce();
    const stateCount = onState.mock.calls.length; pending.reject(new Error('old failure')); await old; expect(onError).not.toHaveBeenCalled(); expect(onState).toHaveBeenCalledTimes(stateCount); engine.stop();
  });
  it('polls while subscription setup is pending and cleans each generation separately', async () => {
    const first = defer(), second = defer(); const offA = vi.fn(), offB = vi.fn(); const callbacks = [];
    const events = { subscribe: vi.fn((callback) => { callbacks.push(callback); return callbacks.length === 1 ? first.promise : second.promise; }) };
    const { engine, api } = syncSetup({ events }); await engine.start(); expect(api.call).toHaveBeenCalledOnce(); engine.stop(); await engine.start();
    second.resolve(offB); await tick(); first.resolve(offA); await tick(); expect(offA).toHaveBeenCalledOnce(); expect(offB).not.toHaveBeenCalled();
    const calls = api.call.mock.calls.length; callbacks[0]({ op: 'gap' }); await tick(); expect(api.call).toHaveBeenCalledTimes(calls);
    engine.stop(); expect(offB).toHaveBeenCalledOnce(); callbacks[1]({ op: 'gap' }); await tick(); expect(api.call).toHaveBeenCalledTimes(calls);
  });
  it('ignores a stopped subscription rejection and old timer callback', async () => {
    const pending = defer(); const callbacks = []; const { engine, api, onError } = syncSetup({ events: { subscribe: () => pending.promise }, setTimer: (callback) => { callbacks.push(callback); return callbacks.length; } });
    await engine.start(); engine.stop(); await engine.start(); const calls = api.call.mock.calls.length; callbacks[0](); pending.reject(new Error('subscription failed')); await tick();
    // The second run shares this test provider rejection and may report its own failure.
    expect(api.call).toHaveBeenCalledTimes(calls); expect(onError).toHaveBeenCalledTimes(1); engine.stop();
  });
});

describe('outbox teardown', () => {
  it('rejects new applies after stop and retains an already-durable apply without scheduling a send', async () => {
    const persisted = defer(); const store = { apply: vi.fn(() => persisted.promise), flush: vi.fn() }; const setTimer = vi.fn();
    const outbox = createOutbox({ store, setTimer }); const applying = outbox.apply(['op']); outbox.stop(); persisted.resolve(); await applying;
    await expect(outbox.apply(['later'])).rejects.toThrow('outbox_stopped'); expect(store.apply).toHaveBeenCalledOnce(); expect(setTimer).not.toHaveBeenCalled(); await outbox.flush(); expect(store.flush).not.toHaveBeenCalled();
  });
  it('does not deliver errors from a flush that completes after stop', async () => {
    const pending = defer(); const onError = vi.fn(); const outbox = createOutbox({ store: { flush: () => pending.promise }, onError });
    const sending = outbox.flush(); outbox.stop(); pending.resolve({ error: new Error('late') }); await sending; expect(onError).not.toHaveBeenCalled();
  });
  it('does not deliver a rejected timer flush after stop', async () => {
    const pending = defer(); let timer; const onError = vi.fn();
    const outbox = createOutbox({ store: { apply: async () => {}, flush: () => pending.promise }, setTimer: (callback) => { timer = callback; }, clearTimer: () => {}, onError });
    await outbox.apply([]); timer(); outbox.stop(); pending.reject(new Error('late')); await tick(); expect(onError).not.toHaveBeenCalled();
  });
});

describe('durable storage failures', () => {
  it('observes both failures from an aborted read transaction', async () => {
    const db = await database(); const original = IDBDatabase.prototype.transaction; const unhandled = vi.fn();
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (...args) { const tx = original.apply(this, args); queueMicrotask(() => tx.abort()); return tx; });
    process.on('unhandledRejection', unhandled);
    try { await expect(db.get('key')).rejects.toThrow(); await tick(); await tick(); expect(unhandled).not.toHaveBeenCalled(); }
    finally { process.off('unhandledRejection', unhandled); }
  });
});

describe('space commit teardown and leases', () => {
  async function world() {
    const factory = new IDBFactory(); const dbs = await Promise.all([1, 2, 3].map(() => database(factory))); let time = 1000; const requests = [];
    const api = { commit: vi.fn(() => { const request = defer(); requests.push(request); return request.promise; }) };
    const stores = await Promise.all(dbs.map((db) => openSpaceStore({ ref, db, api, now: () => time, makeId })));
    return { dbs, stores, api, requests, expire: () => { time += 35001; } };
  }
  it('does not start transport after close while a claim transaction is pending', async () => {
    const db = await database(); const api = { commit: vi.fn() }; const store = await openSpaceStore({ ref, db, api, makeId }); await store.apply([put()]);
    const entered = defer(), pending = defer(); const update = db.update; let first = true;
    vi.spyOn(db, 'update').mockImplementation(async (...args) => { const value = await update(...args); if (first) { first = false; entered.resolve(); await pending.promise; } return value; });
    const notified = vi.fn(); store.subscribe(notified); const sending = store.flush(); await entered.promise; store.close(); pending.resolve(); expect((await sending).status).toBe('queued');
    expect(api.commit).not.toHaveBeenCalled(); expect(notified).not.toHaveBeenCalled(); const saved = await db.get(stateKey); expect(saved.pending).toHaveLength(1); expect(saved.batch.lease).toBeNull();
  });
  it('drains a started valid acknowledgement after close without view callbacks', async () => {
    const db = await database(); const pending = defer(); const api = { commit: vi.fn(() => pending.promise) }; const store = await openSpaceStore({ ref, db, api, makeId }); const op = put(); await store.apply([op]);
    const sending = store.flush(); await vi.waitFor(() => expect(api.commit).toHaveBeenCalledOnce()); const notified = vi.fn(); store.subscribe(notified); store.close(); pending.resolve(ack(op)); expect((await sending).status).toBe('sent');
    const saved = await db.get(stateKey); expect(saved.pending).toEqual([]); expect(saved.batch).toBeNull(); expect(notified).not.toHaveBeenCalled(); expect(() => store.flush()).toThrow('store_closed');
  });
  it.each([0, 403])('does not let an expired owner failure %s mutate a replacement lease or pending ops', async (status) => {
    const { stores: [a, b, c], dbs, requests, api, expire } = await world(); const op = put(); await a.apply([op]); const first = a.flush(); await vi.waitFor(() => expect(api.commit).toHaveBeenCalledTimes(1)); expire();
    const second = b.flush(); await vi.waitFor(() => expect(api.commit).toHaveBeenCalledTimes(2)); const lease = (await dbs[1].get(stateKey)).batch.lease;
    requests[0].reject(Object.assign(new Error('old failure'), { status })); expect((await first).status).toBe('busy'); expect((await dbs[1].get(stateKey)).batch.lease).toEqual(lease);
    expect((await c.flush()).status).toBe('busy'); expect(api.commit).toHaveBeenCalledTimes(2); expect((await dbs[1].get(stateKey)).pending).toHaveLength(1);
    requests[1].resolve(ack(op)); await second;
  });
  it('clears an acknowledged same-id batch even when a replacement lease later fails', async () => {
    const { stores: [a, b, c], dbs, requests, api, expire } = await world(); const op = put(); await a.apply([op]); const first = a.flush(); await vi.waitFor(() => expect(api.commit).toHaveBeenCalledTimes(1)); expire();
    const second = b.flush(); await vi.waitFor(() => expect(api.commit).toHaveBeenCalledTimes(2)); requests[0].resolve(ack(op)); expect((await first).status).toBe('sent');
    requests[1].reject(Object.assign(new Error('gateway'), { status: 503 })); expect((await second).status).toBe('idle'); expect((await dbs[0].get(stateKey)).batch).toBeNull();
    expect((await c.flush()).status).toBe('idle'); expect(api.commit).toHaveBeenCalledTimes(2);
  });
  it('accepts a late valid success after replacement acknowledgement and preserves a different newer batch', async () => {
    const { stores: [a, b, c], dbs, requests, api, expire } = await world(); const op = put(); const original = entity(); await a.apply([op]); const first = a.flush(); await vi.waitFor(() => expect(api.commit).toHaveBeenCalledTimes(1)); expire();
    const second = b.flush(); await vi.waitFor(() => expect(api.commit).toHaveBeenCalledTimes(2)); requests[1].resolve(ack(op, original)); await second;
    const later = { opId: makeId(), t: 'place', id, set: { name: 'Renamed' } }; await c.apply([later]); const third = c.flush(); await vi.waitFor(() => expect(api.commit).toHaveBeenCalledTimes(3)); const batch = (await dbs[2].get(stateKey)).batch;
    requests[0].resolve(ack(op, original)); expect((await first).status).toBe('sent'); const saved = await dbs[0].get(stateKey); expect(saved.batch).toEqual(batch); expect(saved.pending.map(({ op }) => op.opId)).toEqual([later.opId]);
    requests[2].resolve(ack(later, entity('Renamed', 2))); await third;
  });
});
