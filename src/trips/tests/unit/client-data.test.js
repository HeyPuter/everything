import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { openDatabase } from '../../src/lib/idb.js';
import { openSpaceStore } from '../../src/lib/store/space.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { createCredentialManager, sha256 } from '../../src/lib/cred.js';
import { createWorkerClient, ApiError } from '../../src/lib/api.js';
import { createSyncEngine } from '../../src/lib/sync/index.js';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { createClock } from '../../src/shared/hlc.js';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const id = '0000000000000001';
const ref = { w: 'trips-012345abcd', s: id, k: 'trip' };
let sequence = 10;
const makeId = () => `0000000000${String(++sequence).padStart(6, '0')}`;
const clock = createClock({ node: id, now: () => 1_000_000 });
const entity = (name = 'Museum') => ({ t: 'place', id, name, v: clock.tick(), rev: 1, upd: 1000, by: alice, cr: 1000 });
const create = (opId = makeId()) => ({ opId, t: 'place', id, put: { name: 'Museum' } });
const databases = [];
async function database(account = alice, factory = new IDBFactory()) {
  const db = await openDatabase(account, { indexedDB: factory });
  databases.push(db);
  return db;
}
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.useRealTimers(); });

describe('account-scoped durable storage', () => {
  it('isolates accounts and aborts invalid synchronous updates atomically', async () => {
    const factory = new IDBFactory();
    const a = await database(alice, factory);
    const b = await database(bob, factory);
    await a.put('key', { value: 1 });
    expect(await b.get('key')).toBeUndefined();
    await expect(a.update('key', () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(await a.get('key')).toEqual({ value: 1 });
    await expect(a.update('key', async () => 2)).rejects.toThrow('async_storage_change');
  });
  it('serializes concurrent appends from two connections', async () => {
    const factory = new IDBFactory();
    const a = await database(alice, factory);
    const b = await database(alice, factory);
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).update('items', (items = []) => [...items, i])));
    expect(await a.get('items')).toHaveLength(10);
  });
});

describe('space replica and frozen outbox', () => {
  it('persists optimistic creates across restart with stable local versions', async () => {
    const db = await database();
    const first = await openSpaceStore({ ref, db, makeId });
    await first.apply([create()]);
    const version = first.get('place', id).v;
    expect(first.get('place', id).v).toBe(version);
    first.close();
    const second = await openSpaceStore({ ref, db, makeId });
    expect(second.entities('place')[0].name).toBe('Museum');
    expect(second.get('place', id).v).toBe(version);
    expect(second.pending).toHaveLength(1);
  });
  it('does not expose an optimistic change after storage fails', async () => {
    const db = await database();
    const store = await openSpaceStore({ ref, db, makeId });
    const notify = vi.fn(); store.subscribe(notify);
    vi.spyOn(db, 'update').mockRejectedValue(new DOMException('Full', 'QuotaExceededError'));
    await expect(store.apply([create()])).rejects.toThrow('Full');
    expect(store.entities('place')).toEqual([]); expect(notify).not.toHaveBeenCalled();
  });
  it('retries the identical frozen bytes after a network failure despite later edits', async () => {
    const db = await database();
    const sent = [];
    const api = { commit: vi.fn(async (_, body) => { sent.push(body); throw new ApiError(0, 'network'); }) };
    const store = await openSpaceStore({ ref, db, api, makeId });
    await store.apply([create()]);
    expect((await store.flush()).status).toBe('queued');
    await store.apply([{ opId: makeId(), t: 'place', id, set: { name: 'Renamed' } }]);
    expect((await store.flush()).status).toBe('queued');
    expect(sent[1]).toBe(sent[0]);
    expect(store.pending).toHaveLength(2);
    expect(store.entities('place')[0].name).toBe('Renamed');
  });
  it('keeps accepted entities but does not advance the contiguous read cursor on commit', async () => {
    const db = await database();
    const op = create();
    const server = entity();
    const api = { commit: vi.fn(async () => ({ rev: 5, ents: [{ ...server, rev: 5 }], del: [], done: { [op.opId]: 5 } })) };
    const store = await openSpaceStore({ ref, db, api, makeId });
    await store.apply([op]);
    expect((await store.flush()).status).toBe('sent');
    expect(store.pending).toEqual([]); expect(store.rev).toBe(0);
    expect(store.get('place', id).rev).toBe(5);
    await store.replace({ rev: 2, ents: [{ ...entity('Stale snapshot'), rev: 2 }] });
    expect(store.rev).toBe(2);
    expect(store.get('place', id).name).toBe('Museum');
    expect(store.get('place', id).rev).toBe(5);
  });
  it.each([[403, 'rejected', 0], [409, 'conflict', 1], [402, 'queued', 0], [503, 'queued', 0]])('handles %s without losing queued or conflicted work', async (status, result, conflicts) => {
    const db = await database();
    const store = await openSpaceStore({ ref, db, makeId, api: { commit: async () => { throw new ApiError(status, 'failed'); } } });
    await store.apply([create()]);
    expect((await store.flush()).status).toBe(result);
    expect(store.conflicts).toHaveLength(conflicts);
    expect(store.pending).toHaveLength(result === 'queued' ? 1 : 0);
    if (result === 'rejected') expect(store.entities('place')).toEqual([]);
  });
  it('serializes sends within a tab and leases one batch across connections', async () => {
    const db = await database();
    let release;
    const api = { commit: vi.fn(() => new Promise((resolve) => { release = resolve; })) };
    const a = await openSpaceStore({ ref, db, api, makeId });
    const b = await openSpaceStore({ ref, db, api, makeId });
    const op = create(); await a.apply([op]);
    const first = a.flush(); expect(a.flush()).toBe(first);
    await vi.waitFor(() => expect(api.commit).toHaveBeenCalledOnce());
    expect((await b.flush()).status).toBe('busy');
    release({ rev: 1, ents: [entity()], del: [], done: { [op.opId]: 1 } });
    await first;
  });
  it('requires contiguous sync and preserves pending edits across snapshot reset', async () => {
    const db = await database();
    const store = await openSpaceStore({ ref, db, makeId });
    await expect(store.receive([{ rev: 2, ents: [entity()], del: [] }])).rejects.toThrow('sync_gap');
    expect(store.rev).toBe(0);
    await store.replace({ rev: 1, ents: [entity()] });
    await store.apply([{ opId: makeId(), t: 'place', id, set: { name: 'Offline change' } }]);
    await store.replace({ rev: 2, ents: [{ ...entity('Remote change'), rev: 2 }] });
    expect(store.get('place', id).name).toBe('Offline change');
    expect(store.pending).toHaveLength(1);
    await expect(store.replace({ rev: 1, ents: [] })).rejects.toThrow('stale_snapshot');
  });
  it('caps frozen batch bytes without parking valid queued edits', async () => {
    const db = await database();
    const bodies = [];
    const store = await openSpaceStore({ ref, db, makeId, api: { commit: async (_, body) => { bodies.push(body); throw new ApiError(0, 'network'); } } });
    for (let i = 0; i < 11; i++) await store.apply([{ opId: makeId(), t: 'note', id: makeId(), put: { title: 'Note', body: 'x'.repeat(100000) } }]);
    expect((await store.flush()).status).toBe('queued');
    expect(new TextEncoder().encode(bodies[0]).length).toBeLessThanOrEqual(1_000_000);
    expect(JSON.parse(bodies[0]).ops.length).toBeLessThan(11);
    expect(store.pending).toHaveLength(11); expect(store.conflicts).toHaveLength(0);
  });
  it('rejects malformed records and incomplete acknowledgements without dropping work', async () => {
    const db = await database();
    const store = await openSpaceStore({ ref, db, makeId, api: { commit: async () => ({ rev: 1, done: {} }) } });
    await expect(store.receive([{ rev: 1 }])).rejects.toThrow('invalid_change_record');
    expect(store.rev).toBe(0);
    await store.apply([create()]);
    expect((await store.flush()).status).toBe('queued'); expect(store.pending).toHaveLength(1);
  });
  it('treats malformed acknowledgement entities as a server failure and retains frozen work', async () => {
    const db = await database(); const pending = create();
    const store = await openSpaceStore({ ref, db, makeId, api: { commit: async () => ({ rev: 1, done: { [pending.opId]: 1 }, ents: [{ t: 'place', id, name: 42 }], del: [] }) } });
    await store.apply([pending]);
    expect((await store.flush()).status).toBe('queued'); expect(store.pending).toHaveLength(1); expect(store.conflicts).toHaveLength(0);
  });
});

describe('restricted worker requests', () => {
  it('settles deadlines even when the transport or body ignores cancellation', async () => {
    const credentials = { headers: async () => ({ 'puter-auth': 'restricted' }) };
    const puter = { authToken: 'session', workers: { exec: () => new Promise(() => {}) } };
    const api = createWorkerClient({ puter, credentials, timeout: 5 });
    await expect(api.call(ref, 'open')).rejects.toMatchObject({ code: 'timeout', status: 0 });
    puter.workers.exec = async () => new Response(new ReadableStream({ start() {} }));
    await expect(api.call(ref, 'open')).rejects.toMatchObject({ code: 'timeout', status: 0 });
  });
  it('refreshes a refused credential at most once with the same body', async () => {
    const credentials = { headers: vi.fn(async (_, __, options) => ({ 'puter-auth': options.refresh ? 'new-restricted' : 'old-restricted' })) };
    const bodies = [];
    const puter = { authToken: 'session', workers: { exec: vi.fn(async (_, init) => {
      bodies.push(init.body);
      return init.headers['puter-auth'] === 'old-restricted' ? new Response('', { status: 401 }) : Response.json({ ok: true });
    }) } };
    await createWorkerClient({ puter, credentials }).call(ref, 'open');
    expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
    expect(credentials.headers.mock.calls[1][2]).toEqual({ refresh: true });
    puter.workers.exec.mockImplementation(async () => new Response('', { status: 401 }));
    await expect(createWorkerClient({ puter, credentials }).call(ref, 'open')).rejects.toMatchObject({ status: 401 });
    expect(puter.workers.exec).toHaveBeenCalledTimes(4);
  });
  async function setup() {
    const now = () => 1_000_000;
    const world = createFakePuter({ users: [{ uuid: alice, username: 'alice' }], now });
    const puter = world.client(alice);
    const db = await database();
    const credentials = await createCredentialManager({ puter, db, crypto: webcrypto, now });
    return { world, puter, db, credentials };
  }
  it('retries an expired credential on the next call after a failed re-mint', async () => {
    let time = 1_000_000; const now = () => time;
    const world = createFakePuter({ users: [{ uuid: alice, username: 'alice' }], now });
    const puter = world.client(alice); const db = await database();
    const credentials = await createCredentialManager({ puter, db, crypto: webcrypto, now });
    const origin = 'https://trips-012345abcd.puter.work';
    const first = await credentials.headers(origin, '{}');
    time += 24 * 60 * 60_000; world.failNext({ method: 'fs.getReadURL', status: 402 });
    await expect(credentials.headers(origin, '{}')).rejects.toMatchObject({ status: 402 });
    const [a, b] = await Promise.all([credentials.headers(origin, '{}'), credentials.headers(origin, '{}')]);
    expect(a['puter-auth']).not.toBe(first['puter-auth']); expect(b['puter-auth']).toBe(a['puter-auth']);
  });
  it('stores only a non-extractable private key locally and binds signatures to origin/body', async () => {
    const { world, puter, db, credentials } = await setup();
    const origin = 'https://trips-012345abcd.puter.work';
    const body = JSON.stringify({ op: 'open', space: id });
    const headers = await credentials.headers(origin, body);
    expect(headers['puter-auth']).not.toBe(puter.authToken);
    const device = await db.get('device:key');
    expect(device.privateKey.extractable).toBe(false);
    expect(JSON.stringify(world.inspectKv(alice))).not.toContain('privateKey');
    const proof = JSON.parse(headers['x-trips-proof']);
    const key = await webcrypto.subtle.importKey('jwk', device.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const signature = Uint8Array.from(atob(proof.signature), (char) => char.charCodeAt(0));
    const valid = async (target, content, at = proof.at) => webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode(JSON.stringify([target, proof.path, await sha256(content, webcrypto), at])));
    expect(proof).toMatchObject({ version: 2, at: expect.any(Number) });
    expect(await valid(origin, body)).toBe(true);
    expect(await valid('https://trips-0000000000.puter.work', body)).toBe(false);
    expect(await valid(origin, body + ' ')).toBe(false);
    expect(await valid(origin, body, proof.at + 1)).toBe(false);
    await credentials.headers(origin, body);
    expect(world.counters().calls['fs.getReadURL']).toBe(1);
  });
  it('never sends a session token and rejects untrusted targets before network', async () => {
    const { world, puter, credentials } = await setup();
    const received = [];
    await world.registerWorker(ref.w, { owner: alice, fetch: (request) => {
      received.push(request.headers.get('puter-auth'));
      return Response.json({ ok: true, rev: 0, changes: [] });
    } });
    const api = createWorkerClient({ puter, credentials });
    expect((await api.call(ref, 'sync', { since: 0 })).rev).toBe(0);
    expect(received[0]).not.toBe(puter.authToken);
    await expect(api.request('evil.example', JSON.stringify({ op: 'hello' }))).rejects.toThrow('untrusted_worker');
    expect(received).toHaveLength(1);
  });
  it('refuses account changes and caches private values by account', async () => {
    const { puter, db, credentials } = await setup();
    const personal = createPersonalStore({ puter, db });
    await personal.set('me:prefs', { theme: 'dark' });
    puter.authToken = 'other-account-session';
    await expect(credentials.headers('https://trips-012345abcd.puter.work', '{}')).rejects.toThrow('account_changed');
    await expect(personal.get('me:prefs')).rejects.toThrow('account_changed');
  });
  it('rejects a personal store opened with another account’s database before reading cloud data', async () => {
    const { world, puter } = await setup();
    const wrong = await database(bob);
    const personal = createPersonalStore({ puter, db: wrong });
    const before = world.counters().calls['kv.get'] ?? 0;
    await expect(personal.get('me:prefs')).rejects.toThrow('account_changed');
    expect(world.counters().calls['kv.get'] ?? 0).toBe(before);
  });
  it('refuses account changes during identity lookup or key generation before any proof write', async () => {
    const first = await setup();
    const getUser = first.puter.auth.getUser;
    first.puter.auth.getUser = async () => { const user = await getUser(); first.puter.authToken = 'changed'; return user; };
    await expect(createCredentialManager({ puter: first.puter, db: first.db, crypto: webcrypto })).rejects.toThrow('account_changed');
    const second = await setup();
    const subtle = new Proxy(webcrypto.subtle, { get(target, key) {
      if (key === 'generateKey') return async (...args) => { const keys = await target.generateKey(...args); second.puter.authToken = 'changed'; return keys; };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const credentials = await createCredentialManager({ puter: second.puter, db: second.db, crypto: { subtle } });
    await expect(credentials.headers('https://trips-012345abcd.puter.work', '{}')).rejects.toThrow('account_changed');
    expect(second.world.counters().calls['fs.write']).toBeUndefined();
  });
  it('checks the session again before returning cached personal data', async () => {
    const { puter, db } = await setup();
    const personal = createPersonalStore({ puter, db }); await personal.set('me:prefs', { theme: 'dark' });
    const read = db.get;
    vi.spyOn(db, 'get').mockImplementation(async (...args) => { const value = await read(...args); puter.authToken = 'changed'; return value; });
    await expect(personal.get('me:prefs')).rejects.toThrow('account_changed');
  });
});

describe('sync cadence and repair', () => {
  it('does not start an outbox send when stopped during a pending pull', async () => {
    let resolve;
    const store = { ref, rev: 0, pending: [], flush: vi.fn() };
    const api = { call: () => new Promise((done) => { resolve = done; }) };
    const engine = createSyncEngine({ store, api, setTimer: vi.fn(), clearTimer: vi.fn() });
    const starting = engine.start(); engine.stop(); resolve({ rev: 0, changes: [] }); await starting;
    expect(store.flush).not.toHaveBeenCalled();
  });
  it('repairs a persistent revision gap and retries the contiguous cursor', async () => {
    const db = await database();
    const store = await openSpaceStore({ ref, db, makeId, api: { commit: vi.fn() } });
    let now = 0;
    const api = { call: vi.fn(async (_, op) => op === 'sync' ? { rev: 2, changes: [] } : { snap: { rev: 2 } }), snapshot: vi.fn(async () => ({ rev: 2, ents: [entity()] })) };
    const engine = createSyncEngine({ store, api, now: () => now, setTimer: vi.fn(), clearTimer: vi.fn() });
    await engine.start(); now = 15_001; await engine.sync(); engine.stop();
    expect(api.call).toHaveBeenCalledWith(ref, 'repair', { since: 0 });
    expect(store.rev).toBe(2);
  });
  it('loads a snapshot on the first path C pull after an earlier session skipped a record', async () => {
    const db = await database();
    const earlier = await openSpaceStore({ ref, db, makeId, api: { commit: vi.fn() } });
    await earlier.receive([{ rev: 1, ents: [{ ...entity(), name: 42 }], del: [] }, { rev: 2, ents: [], del: [] }]);
    expect(earlier.skipped).toEqual([1]); expect(earlier.reread).toBe(false);
    const store = await openSpaceStore({ ref, db, makeId, api: { commit: vi.fn() } });
    expect(store.reread).toBe(true);
    // A snapshot behind the replica is ignored and normal sync continues.
    const api = { call: vi.fn(async () => ({ rev: 2, changes: [] })), snapshot: vi.fn(async () => ({ rev: 1, ents: [entity()] })) };
    let engine = createSyncEngine({ store, api, setTimer: vi.fn(), clearTimer: vi.fn() });
    await engine.start(); engine.stop();
    expect(api.snapshot).toHaveBeenCalledOnce(); expect(api.call).toHaveBeenCalledWith(ref, 'sync', { since: 2 });
    expect(store.reread).toBe(true); expect(store.get('place', id)).toBeUndefined();
    // A current snapshot replaces the replica; entities this build still cannot validate stay recorded.
    api.snapshot.mockResolvedValueOnce({ rev: 2, ents: [entity(), { ...entity(), id: makeId(), name: 42 }] });
    api.call.mockClear();
    engine = createSyncEngine({ store, api, setTimer: vi.fn(), clearTimer: vi.fn() });
    await engine.start();
    expect(api.call).not.toHaveBeenCalled(); expect(store.get('place', id).name).toBe('Museum');
    expect(store.skipped).toEqual([2]); expect(store.reread).toBe(false);
    await engine.sync(); engine.stop();
    expect(api.snapshot).toHaveBeenCalledTimes(2); expect(api.call).toHaveBeenCalledWith(ref, 'sync', { since: 2 });
  });
  it('polls without relying on events and backs off 402 failures', async () => {
    const db = await database();
    const store = await openSpaceStore({ ref, db, makeId, api: { commit: vi.fn() } });
    const schedule = vi.fn(); const states = [];
    const api = { call: vi.fn().mockResolvedValueOnce({ rev: 0, changes: [] }).mockRejectedValueOnce(new ApiError(402, 'insufficient_funds')) };
    const engine = createSyncEngine({ store, api, setTimer: schedule, clearTimer: vi.fn(), onState: (state) => states.push(state) });
    await engine.start(); expect(schedule.mock.calls.at(-1)[1]).toBe(20_000);
    await engine.sync(); expect(states.at(-1)).toBe('credit'); expect(schedule.mock.calls.at(-1)[1]).toBe(2000); engine.stop();
  });
});
