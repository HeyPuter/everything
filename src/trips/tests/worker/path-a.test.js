// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDatabase } from '../../src/lib/idb.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { USERS, WORKER, createHarness, id } from './harness.js';

const opened = [];
afterEach(() => { for (const { space, db } of opened.splice(0)) { space?.close(); db.close(); } });

/** Alice's trip with Bob joined by link; `open(options)` opens it for Bob with the real store and sync. */
async function setup({ role = 'editor', ...options } = {}) {
  const h = await createHarness({ shareHandles: true, ...options });
  const space = await h.trip();
  const ref = { w: WORKER, s: space, k: 'trip' };
  const alice = await h.client('alice');
  const bob = await h.client('bob');
  const { token } = await alice.in(space).call('invite.create', { role });
  const joined = await bob.in(space).call('join', { token });
  const db = await openDatabase(bob.uuid, { indexedDB: new IDBFactory() });
  const personal = createPersonalStore({ puter: bob.puter, db, now: h.now });
  await personal.spaces.upsert({ ref, role, title: 'Lisbon', handles: joined.handles, files: joined.files });
  const entry = { db };
  opened.push(entry);
  async function open(extra = {}) {
    entry.space?.close();
    entry.space = await openSpace({ ref, db, api: bob.api, puter: bob.puter, personal, handles: joined.handles, files: joined.files, role, now: h.now,
      setTimer: () => 0, clearTimer: () => {}, document: null, window: null, ...extra });
    return entry.space;
  }
  const addPlace = async (name) => {
    const placeId = id('p');
    await alice.in(space).call('commit', { ops: [{ opId: id('o'), t: 'place', id: placeId, put: { name } }] });
    return placeId;
  };
  return { h, space, ref, alice, bob, joined, personal, open, addPlace };
}

describe('path A recovery', () => {
  it('falls back to path C when the read handle is revoked, then re-shares it and returns to path A', async () => {
    const f = await setup();
    const space = await f.open();
    expect(space.state).toMatchObject({ path: 'A', handles: true });
    await f.bob.puter.kv.unshare(f.joined.handles.read);
    const place = await f.addPlace('Belém');
    await space.sync();
    expect(space.get('place', place).name).toBe('Belém');
    await vi.waitFor(() => expect(space.state.path).toBe('A'));
    const [entry] = await f.personal.spaces.list();
    expect(entry.handles.read).not.toBe(f.joined.handles.read);
    // Unsharing the read handle retired the narrower write handle too, so both were re-minted.
    expect(entry.handles.write).not.toBe(f.joined.handles.write);
    const later = await f.addPlace('Alfama');
    const reads = f.h.world.counters().byUser[USERS.bob.uuid].calls['kv.get'];
    await space.sync();
    expect(space.get('place', later).name).toBe('Alfama');
    expect(f.h.world.counters().byUser[USERS.bob.uuid].calls['kv.get']).toBe(reads + 1);
  });

  it('writes presence and read markers through the worker while the write handle is gone, then through the new one', async () => {
    const f = await setup();
    const space = await f.open({ view: 'plan' });
    await vi.waitFor(() => expect(f.h.kv()[`shared:${f.space}:u:${USERS.bob.uuid}:pres`]).toMatchObject({ view: 'plan' }));
    await f.bob.puter.kv.unshare(f.joined.handles.write);
    await space.markSeen(1);
    expect(f.h.world.inspectKv(USERS.bob.uuid)[`me:seen:${f.space}`]).toBe(1);
    await vi.waitFor(async () => expect((await f.personal.spaces.list())[0].handles.write).not.toBe(f.joined.handles.write));
    f.h.advance(16_000);
    space.setView('costs');
    await vi.waitFor(() => expect(f.h.kv()[`shared:${f.space}:u:${USERS.bob.uuid}:pres`]).toMatchObject({ view: 'costs' }));
  });

  it('stays on path C for the session when the platform turns handles off', async () => {
    const f = await setup();
    const space = await f.open();
    f.h.world.flags.shareHandles = false;
    const place = await f.addPlace('Sintra');
    await space.sync();
    expect(space.state.path).toBe('C');
    expect(space.get('place', place).name).toBe('Sintra');
    const calls = f.h.world.counters().byUser[USERS.bob.uuid].calls['workers.exec'];
    await space.refreshAccess();
    expect(space.state.path).toBe('C');
    expect(f.h.world.counters().byUser[USERS.bob.uuid].calls['workers.exec']).toBe(calls + 1);
  });

  it('never uses handles while the pathA flag is off, but still caches them', async () => {
    const f = await setup();
    const space = await f.open({ features: { pathA: false, directFiles: false }, view: 'lists' });
    expect(space.state).toMatchObject({ path: 'C', handles: false });
    await vi.waitFor(() => expect(f.h.kv()[`sp:${f.space}:pres`]).toHaveProperty(USERS.bob.uuid));
    await space.markSeen(1);
    expect(f.h.world.inspectKv(USERS.bob.uuid)[`me:seen:${f.space}`]).toBe(1);
    expect(f.h.world.counters().byUser[USERS.bob.uuid].calls['kv.list'] ?? 0).toBe(0);
    expect(await space.fileAccess()).toEqual({ mode: 'proxied' });
    expect((await f.personal.spaces.list())[0].handles).toEqual(f.joined.handles);
  });
});

describe('wake-ups', () => {
  const settle = async (f) => { await f.h.settle(); await f.h.world.flushEvents(); await new Promise((resolve) => setTimeout(resolve, 0)); };

  it('applies a commit from the signal event on the read handle without polling', async () => {
    const f = await setup();
    const space = await f.open();
    await settle(f);
    const reads = f.h.world.counters().byUser[USERS.bob.uuid].calls['kv.get'];
    const place = await f.addPlace('Event');
    await settle(f);
    await vi.waitFor(() => expect(space.get('place', place)?.name).toBe('Event'));
    expect(f.h.world.counters().byUser[USERS.bob.uuid].calls['kv.get']).toBe(reads);
  });

  it('polls at once when the signal carries only the revision', async () => {
    const f = await setup();
    const space = await f.open();
    await settle(f);
    const placeId = id('p');
    await f.alice.in(f.space).call('commit', { ops: [{ opId: id('o'), t: 'place', id: placeId, put: { name: 'Big', notes: 'x'.repeat(20_000) } }] });
    expect(f.h.kv()[`shared:${f.space}:sig`]).toEqual({ rev: expect.any(Number) });
    await settle(f);
    await vi.waitFor(() => expect(space.get('place', placeId)?.notes).toHaveLength(20_000));
  });

  it('wakes the owner on member commits through its own KV subject, and member regions through u:*', async () => {
    const f = await setup();
    const db = await openDatabase(USERS.alice.uuid, { indexedDB: new IDBFactory() });
    const owner = await openSpace({ ref: f.ref, db, api: f.alice.api, puter: f.alice.puter, ownWorker: WORKER, now: f.h.now, setTimer: () => 0, clearTimer: () => {}, document: null, window: null });
    opened.push({ space: owner, db });
    await settle(f);
    const placeId = id('p');
    await f.bob.in(f.space).call('commit', { ops: [{ opId: id('o'), t: 'place', id: placeId, put: { name: 'From Bob' } }] });
    await settle(f);
    await vi.waitFor(() => expect(owner.get('place', placeId)?.name).toBe('From Bob'));
    await f.open({ view: 'costs' });
    await settle(f);
    await vi.waitFor(() => expect(owner.members().find((member) => member.uid === USERS.bob.uuid)).toMatchObject({ active: true, view: 'costs' }));
  });
});

describe('file access block', () => {
  it('comes from the cached entry, then from one open when the cache has none', async () => {
    const f = await setup();
    const space = await f.open({ files: null });
    expect(await space.fileAccess()).toEqual(f.joined.files);
    const fresh = await f.open({ files: null, personal: null });
    const calls = f.h.world.counters().byUser[USERS.bob.uuid].calls['workers.exec'];
    expect(await Promise.all([fresh.fileAccess(), fresh.fileAccess()])).toEqual([f.joined.files, f.joined.files]);
    expect(f.h.world.counters().byUser[USERS.bob.uuid].calls['workers.exec']).toBe(calls + 1);
    expect(await fresh.fileAccess()).toEqual(f.joined.files);
    expect(f.h.world.counters().byUser[USERS.bob.uuid].calls['workers.exec']).toBe(calls + 1);
  });

  it('is direct with relative paths for the owner, and proxied when the owner cannot share', async () => {
    const f = await setup({ ownerVerified: false });
    expect(f.joined.files).toEqual({ mode: 'proxied' });
    expect(await (await f.open()).fileAccess()).toEqual({ mode: 'proxied' });
    const db = await openDatabase(USERS.alice.uuid, { indexedDB: new IDBFactory() });
    const owner = await openSpace({ ref: f.ref, db, api: f.alice.api, puter: f.alice.puter, ownWorker: WORKER, now: f.h.now, setTimer: () => 0, clearTimer: () => {}, document: null, window: null });
    opened.push({ space: owner, db });
    expect(await owner.fileAccess()).toEqual({ mode: 'direct', owner: true, account: USERS.alice.uuid });
  });
});
