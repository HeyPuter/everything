// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDatabase } from '../../src/lib/idb.js';
import { openSpaceStore } from '../../src/lib/store/space.js';
import { createSyncEngine } from '../../src/lib/sync/index.js';
import { createInvites } from '../../src/lib/invites.js';
import { USERS, WORKER, createHarness, id } from './harness.js';

const databases = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });

async function storeFor(h, client, space) {
  const db = await openDatabase(client.uuid, { indexedDB: new IDBFactory() });
  databases.push(db);
  const store = await openSpaceStore({ ref: { w: WORKER, s: space, k: 'trip' }, db, api: client.api, now: h.now });
  const engine = createSyncEngine({ store, api: client.api, document: undefined, window: undefined, now: h.now, setTimer: () => 0, clearTimer: () => {} });
  return { store, engine };
}

/** Path A as documented in architecture §6: read `sig`, list `e:*` through the read handle, then apply records after it. */
async function loadThroughHandle(puter, handle) {
  const sig = await puter.kv.get('sig', { handle });
  const ents = [];
  let cursor;
  do {
    const page = await puter.kv.list({ pattern: 'e:*', returnValues: true, limit: 1000, ...(cursor ? { cursor } : {}), optConfig: { handle } });
    for (const { key, value } of page.items) {
      const [, t] = key.split(':');
      if (!value.deleted) ents.push({ t, ...value });
    }
    cursor = page.cursor;
  } while (cursor);
  return { rev: sig.rev, ents, tombstones: [] };
}

describe('two fake users end to end', () => {
  it('create, invite, join, commit and sync through path C with the real store and sync engine', async () => {
    const h = await createHarness();
    const alice = await h.client('alice');
    const bob = await h.client('bob');
    const { space } = await alice.call('space.create', { kind: 'trip', meta: { title: 'Kyoto', currency: 'JPY' } });
    const { token } = await alice.in(space).call('invite.create', { role: 'editor' });
    expect(await bob.in(space).call('join.preview', { token })).toMatchObject({ title: 'Kyoto', owner: 'alice' });
    await bob.in(space).call('join', { token });

    const a = await storeFor(h, alice, space);
    const b = await storeFor(h, bob, space);
    await a.engine.start();
    await b.engine.start();
    expect(a.store.rev).toBe(2);
    expect(b.store.entities('member').map((member) => member.name).sort()).toEqual(['alice', 'bob']);

    const place = id('p');
    await b.store.apply([{ opId: id('o'), t: 'place', id: place, put: { name: 'Fushimi Inari' } }]);
    expect((await b.store.flush()).status).toBe('sent');
    expect(b.store.pending).toEqual([]);
    h.advance(2000);
    await a.engine.sync();
    expect(a.store.get('place', place)).toMatchObject({ name: 'Fushimi Inari', by: USERS.bob.uuid });

    const v = a.store.get('place', place).v;
    await a.store.apply([{ opId: id('o'), t: 'place', id: place, set: { notes: 'Go early' }, base: v }]);
    await a.store.flush();
    await b.store.apply([{ opId: id('o'), t: 'place', id: place, set: { name: 'Inari' }, base: v }]);
    const conflict = await b.store.flush();
    expect(conflict.status).toBe('conflict');
    expect(b.store.conflicts[0]).toMatchObject({ code: 'stale', server: { notes: 'Go early' } });
    h.advance(2000);
    await b.engine.sync();
    expect(b.store.get('place', place).notes).toBe('Go early');

    await a.store.apply([{ opId: id('o'), t: 'place', id: place, del: true }]);
    await a.store.flush();
    h.advance(2000);
    await b.engine.sync();
    expect(b.store.entities('place')).toEqual([]);
    await a.engine.sync();
    expect(b.store.rev).toBe(5);
    expect(a.store.rev).toBe(5);

    const fresh = await storeFor(h, bob, space);
    await fresh.store.replace(await bob.api.snapshot({ w: WORKER, s: space, k: 'trip' }));
    expect(fresh.store.entities('member')).toHaveLength(2);
    expect(fresh.store.get('place', place)).toBeUndefined();
    expect(fresh.store.serverVersion('place', place)).toBeUndefined();
    expect(fresh.store.entities('place')).toEqual([]);
    a.engine.stop(); b.engine.stop();
  });

  it('parks only the op the worker names and sends the rest of the batch', async () => {
    const h = await createHarness();
    const space = await h.team({ bob: 'editor' });
    const alice = await h.client('alice');
    const bob = await h.client('bob');
    const place = id('p');
    await alice.in(space).call('commit', { ops: [{ opId: id('o'), t: 'place', id: place, put: { name: 'Taken' } }] });
    const b = await storeFor(h, bob, space);
    const clash = { opId: id('o'), t: 'place', id: place, put: { name: 'Mine' } };
    const other = { opId: id('o'), t: 'place', id: id('p'), put: { name: 'Other' } };
    await b.store.apply([clash, other]);
    expect((await b.store.flush()).status).toBe('conflict');
    expect(b.store.conflicts).toMatchObject([{ op: { opId: clash.opId }, code: 'already_exists', server: { name: 'Taken' } }]);
    expect(b.store.pending.map((op) => op.opId)).toEqual([other.opId]);
    expect((await b.store.flush()).status).toBe('sent');
    expect(b.store.pending).toEqual([]);
    // Keeping mine for a taken id saves a copy under a new id.
    const copy = await b.store.resolveConflict(clash.opId, { keep: 'mine' });
    expect(copy.id).not.toBe(place);
    expect((await b.store.flush()).status).toBe('sent');
  });

  // ~20 MB of entities through the real worker: seconds alone, several times that on a loaded machine.
  it('splits a batch the write-byte budget could never pass and waits out the 429 on the rest', async () => {
    const h = await createHarness({ timeout: 60_000 });
    const space = await h.team({ bob: 'editor' });
    const bob = await h.client('bob');
    const big = (name) => ({ name, desc: 'd'.repeat(100_000), notes: 'n'.repeat(100_000) });
    const places = [];
    for (let i = 0; i < 25; i++) {
      const ops = Array.from({ length: 4 }, () => { const place = id('p'); places.push(place); return { opId: id('o'), t: 'place', id: place, put: big(`P${places.length}`) }; });
      await bob.in(space).call('commit', { ops });
      if (i % 10 === 9) h.advance(61_000);
    }
    h.advance(61_000);
    const b = await storeFor(h, bob, space);
    // ~20 MB of records: path C pulls again on each capped (`more`) answer until it is current.
    const sync = vi.spyOn(bob.api, 'call');
    await b.engine.start(); b.engine.stop();
    expect(sync.mock.calls.filter(([, op]) => op === 'sync').length).toBeGreaterThan(2);
    expect(b.store.rev).toBe(h.kv()[`sp:${space}:rev`]);
    expect(b.store.entities('place')).toHaveLength(100);
    sync.mockRestore();
    await b.store.apply(places.map((place, i) => ({ opId: id('o'), t: 'place', id: place, set: { name: `Renamed ${i}` } })));
    // 100 patches bill ~40 MB, over the 32 MB minute budget on their own: the worker answers a batch-level 413.
    expect(await b.store.flush()).toMatchObject({ status: 'queued', retry: true });
    expect((await b.store.flush()).status).toBe('sent');
    expect(b.store.pending).toHaveLength(50);
    const limited = await b.store.flush();
    expect(limited).toMatchObject({ status: 'queued', error: { status: 429, code: 'rate_limited' } });
    expect(limited.error.retryAfter).toBeGreaterThan(0);
    expect(await b.store.flush()).toEqual({ status: 'queued', held: true });
    h.advance(limited.error.retryAfter * 1000 + 1);
    expect((await b.store.flush()).status).toBe('sent');
    expect(b.store.pending).toEqual([]);
    expect(b.store.conflicts).toEqual([]);
  }, 120_000);

  it('shows a named invite from the real worker in the client inbox and joins through it', async () => {
    const h = await createHarness({ shareHandles: true });
    const space = await h.trip({ title: 'Porto', currency: 'EUR' });
    const alice = await h.client('alice');
    const bob = await h.client('bob');
    await alice.in(space).call('invite.create', { role: 'editor', named: 'bob' });
    const inbox = createInvites({ puter: bob.puter, api: bob.api, now: h.now });
    const [invite] = await inbox.list();
    expect(invite).toMatchObject({ ref: { w: WORKER, s: space, k: 'trip' }, title: 'Porto', ownerName: 'alice', role: 'editor' });
    const joined = await inbox.accept(invite);
    expect(joined).toMatchObject({ role: 'editor', handles: { read: expect.any(String), write: expect.any(String) } });
    await h.settle();
    expect(await inbox.list()).toEqual([]);
  });

  it('reads the same state through path A handles as through path C', async () => {
    const h = await createHarness({ shareHandles: true });
    const alice = await h.client('alice');
    const bob = await h.client('bob');
    const space = await h.trip({ title: 'Oslo', currency: 'NOK' });
    const { token } = await alice.in(space).call('invite.create', { role: 'editor' });
    const { handles } = await bob.in(space).call('join', { token });
    await alice.in(space).call('commit', { ops: [{ opId: id('o'), t: 'place', id: id('p'), put: { name: 'Opera' } }, { opId: id('o'), t: 'day', id: id('d'), put: { order: 'a', date: '2027-06-01' } }] });

    const viaHandle = await loadThroughHandle(bob.puter, handles.read);
    const a = await storeFor(h, bob, space);
    await a.store.replace(viaHandle);
    const c = await storeFor(h, bob, space);
    await c.engine.start();
    const shape = (store) => ['meta', 'member', 'place', 'day'].map((t) => store.entities(t).map((entity) => JSON.stringify(entity)).sort());
    expect(shape(a.store)).toEqual(shape(c.store));
    expect(a.store.rev).toBe(c.store.rev);

    const later = id('p');
    await bob.in(space).call('commit', { ops: [{ opId: id('o'), t: 'place', id: later, put: { name: 'Vigeland' } }] });
    const sig = await bob.puter.kv.get('sig', { handle: handles.read });
    expect(sig.rev).toBe(a.store.rev + 1);
    const [record] = await bob.puter.kv.get([`ch:${sig.rev}:0`], { handle: handles.read });
    expect(record.parts).toBe(1);
    await a.store.receive([sig]);
    expect(a.store.get('place', later).name).toBe('Vigeland');
    expect(h.world.counters().byUser[USERS.bob.uuid].calls['kv.list']).toBeGreaterThan(0);
    c.engine.stop();
  });
});
