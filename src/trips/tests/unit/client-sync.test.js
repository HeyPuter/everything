import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { createCredentialManager } from '../../src/lib/cred.js';
import { createWorkerClient } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createInvites, inviteFrom } from '../../src/lib/invites.js';
import { regionValue } from '../../src/lib/sync/presence.js';
import { createClock } from '../../src/shared/hlc.js';
import { stubWorker } from './helpers/stub-worker.js';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const carol = '00000000-0000-4000-8000-000000000003';
const users = [{ uuid: alice, username: 'alice' }, { uuid: bob, username: 'bob' }, { uuid: carol, username: 'carol' }];
const WORKER = 'trips-stubworker';
let ids = 0;
const makeId = () => `1${String(++ids).padStart(15, '0')}`;
const opened = [];
afterEach(() => { for (const item of opened.splice(0)) { item.space?.close(); item.db.close(); } });

async function setup({ mintHandles = true, ...options } = {}) {
  let time = 1_700_000_000_000;
  const now = () => time;
  const world = createFakePuter({ users, shareHandles: true, now, ...options });
  // The owner allowed `kvShare` on `shared:` before inviting, so the worker can mint.
  world.grantShareConsent(alice, 'shared:', 'write');
  await world.registerWorker(WORKER, { owner: alice, setup: stubWorker({ name: WORKER, mintHandles, now }) });
  async function account(uid) {
    const puter = world.client(uid);
    const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
    const credentials = await createCredentialManager({ puter, db, crypto: webcrypto, now });
    const api = createWorkerClient({ puter, credentials });
    const personal = createPersonalStore({ puter, db, now });
    const entry = { uid, puter, db, api, personal };
    opened.push(entry);
    entry.open = async (ref, options = {}) => {
      entry.space = await openSpace({ ref, db, api, puter, personal, uid, makeId, now, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, ownWorker: uid === alice ? WORKER : null, ...options });
      return entry.space;
    };
    return entry;
  }
  const a = await account(alice);
  const { space } = await a.api.request(WORKER, JSON.stringify({ op: 'space.create', title: 'Lisbon' }));
  const ref = { w: WORKER, s: space, k: 'trip' };
  return { world, a, ref, account, advance: (ms) => { time += ms; world.advance(0); }, now };
}

async function invite(f, member, uid) {
  await f.a.api.call(f.ref, 'invite.create', { named: uid, role: 'editor' });
  const inbox = createInvites({ puter: member.puter, api: member.api, spaces: member.personal.spaces, now: f.now });
  const [found] = await inbox.list();
  return { inbox, found, joined: await inbox.accept(found) };
}

describe('named invites', () => {
  it('lists invite stubs through their handles, accepts with join and caches the handles', async () => {
    const f = await setup();
    const b = await f.account(bob);
    await f.a.api.call(f.ref, 'invite.create', { named: bob, role: 'editor' });
    const inbox = createInvites({ puter: b.puter, api: b.api, spaces: b.personal.spaces, now: f.now });
    const list = await inbox.list();
    expect(list).toEqual([expect.objectContaining({ ref: f.ref, title: 'Lisbon', ownerName: 'alice', role: 'editor' })]);
    const joined = await inbox.accept(list[0]);
    expect(joined).toMatchObject({ ref: f.ref, role: 'editor', handles: { read: expect.any(String), write: expect.any(String) } });
    expect(await b.personal.spaces.list()).toEqual([expect.objectContaining({ ref: f.ref, role: 'editor', title: 'Lisbon', handles: joined.handles })]);
    // The stub share is gone and member handles cached in me:spaces are not probed.
    const reads = f.world.counters().byUser[bob].calls['kv.get'] ?? 0;
    expect(await createInvites({ puter: b.puter, api: b.api, spaces: b.personal.spaces, now: f.now }).list()).toEqual([]);
    expect((f.world.counters().byUser[bob].calls['kv.get'] ?? 0) - reads).toBe(0);
  });
  it('returns the membership even when the space index cannot be written', async () => {
    const f = await setup();
    const b = await f.account(bob);
    await f.a.api.call(f.ref, 'invite.create', { named: bob, role: 'editor' });
    const spaces = { list: async () => [], upsert: vi.fn(async () => { throw Object.assign(new Error('credit'), { status: 402 }); }) };
    const inbox = createInvites({ puter: b.puter, api: b.api, spaces, now: f.now });
    const joined = await inbox.accept((await inbox.list())[0]);
    expect(joined).toMatchObject({ role: 'editor', indexed: false, entry: { ref: f.ref, title: 'Lisbon', handles: joined.handles } });
  });
  it('declines through the worker, and drops the share itself when the worker cannot answer', async () => {
    const f = await setup();
    const c = await f.account(carol);
    await f.a.api.call(f.ref, 'invite.create', { named: carol, role: 'viewer' });
    const inbox = createInvites({ puter: c.puter, api: c.api, now: f.now });
    const [first] = await inbox.list();
    expect(await inbox.decline(first)).toEqual({ declined: true });
    expect(await inbox.list()).toEqual([]);
    await f.a.api.call(f.ref, 'invite.create', { named: carol, role: 'viewer' });
    const [second] = await inbox.list();
    f.world.setOffline(alice, false);
    const failing = { call: vi.fn(async () => { throw Object.assign(new Error('down'), { status: 503 }); }) };
    expect(await createInvites({ puter: c.puter, api: failing, now: f.now }).decline(second)).toEqual({ declined: true, local: true });
    expect(await inbox.list()).toEqual([]);
  });
  it('hides expired, malformed and foreign stubs', () => {
    const info = { invite: '0123456789abcdef0123456789abcdef', worker: WORKER, space: '0000000000000002', kind: 'trip', title: 'Trip', ownerName: 'alice', role: 'editor', exp: 2000 };
    expect(inviteFrom('h', info, 1000)).toMatchObject({ title: 'Trip' });
    expect(inviteFrom('h', info, 3000)).toBeNull();
    expect(inviteFrom('h', { ...info, worker: 'evil.example' }, 1000)).toBeNull();
    expect(inviteFrom('h', { ...info, invite: '0000000000000001' }, 1000)).toBeNull();
    expect(inviteFrom('h', { ...info, role: 'owner' }, 1000)).toBeNull();
    expect(inviteFrom('h', { ...info, title: '   ' }, 1000)).toBeNull();
    expect(inviteFrom('h', { ...info, title: 'x'.repeat(500) }, 1000).title).toHaveLength(200);
  });
});

describe('path A', () => {
  it('loads through the read handle, then syncs both ways with attribution from records', async () => {
    const f = await setup();
    const b = await f.account(bob);
    const { joined } = await invite(f, b, bob);
    const before = f.world.counters().byUser[alice]?.kvReadUnits ?? 0;
    const bobSpace = await b.open(f.ref, { handles: joined.handles, role: 'editor' });
    expect(bobSpace.state).toMatchObject({ path: 'A', rev: 2 });
    expect(bobSpace.get('meta', 'meta').title).toBe('Lisbon');
    expect(bobSpace.select.member.all().map((member) => member.id).sort()).toEqual([alice, bob]);
    expect(f.world.counters().byUser[alice]?.kvReadUnits ?? 0).toBe(before);

    const aliceSpace = await f.a.open(f.ref, { role: 'owner' });
    expect(aliceSpace.state.path).toBe('A');
    const place = makeId();
    await aliceSpace.apply([aliceSpace.ops.create('place', { name: 'Belém Tower' }, { id: place })]);
    await aliceSpace.flush();
    await f.world.flushEvents();
    await vi.waitFor(() => expect(bobSpace.get('place', place)?.name).toBe('Belém Tower'));
    expect(bobSpace.get('place', place).by).toBe(alice);

    await bobSpace.apply([bobSpace.ops.patch('place', place, { set: { notes: 'Go early' } })]);
    await bobSpace.flush();
    await f.world.flushEvents();
    await vi.waitFor(() => expect(aliceSpace.get('place', place)?.notes).toBe('Go early'));
    expect(aliceSpace.get('place', place).by).toBe(bob);
    const feed = await aliceSpace.feed();
    expect(feed.at(-1)).toMatchObject({ by: bob, items: [expect.objectContaining({ t: 'place', id: place, op: 'change', fields: ['notes'] })] });
    expect(await aliceSpace.unread()).toBeGreaterThan(0);
  });
  it('polls with one KV read billed to the member and applies records from the signal', async () => {
    const f = await setup();
    const b = await f.account(bob);
    const { joined } = await invite(f, b, bob);
    const space = await b.open(f.ref, { handles: joined.handles });
    const reads = () => f.world.counters().byUser[bob].calls['kv.get'] ?? 0;
    const start = reads();
    const ownerReads = f.world.counters().byUser[alice].calls['kv.get'] ?? 0;
    await space.sync();
    expect(reads() - start).toBe(1);
    expect(f.world.counters().byUser[alice].calls['kv.get'] ?? 0).toBe(ownerReads);
    const aliceSpace = await f.a.open(f.ref);
    const place = makeId();
    const before = reads();
    await aliceSpace.apply([aliceSpace.ops.create('place', { name: 'From the signal' }, { id: place })]);
    await aliceSpace.flush();
    await f.world.flushEvents();
    await vi.waitFor(() => expect(space.get('place', place)?.name).toBe('From the signal'));
    expect(reads()).toBe(before);
  });
  it('pages the e:* listing, skips older entity versions in the overlap and loads recent chat', async () => {
    const f = await setup();
    const b = await f.account(bob);
    const { joined } = await invite(f, b, bob);
    const clock = createClock({ node: '0000000000000009', now: f.now });
    const items = Array.from({ length: 1100 }, (_, index) => {
      const id = `2${String(index).padStart(15, '0')}`;
      return { key: `shared:${f.ref.s}:e:place:${id}`, value: { name: `Place ${index}`, id, v: clock.tick(), rev: 1, upd: 1, by: alice, cr: 1 } };
    });
    await f.a.puter.kv.set(items.slice(0, 1000)); await f.a.puter.kv.set(items.slice(1000));
    const message = '3000000000000001';
    await f.a.puter.kv.set(`shared:${f.ref.s}:m:${message}`, { text: 'Hello', id: message, v: clock.tick(), rev: 1, upd: 1, by: alice, cr: 1 });
    await f.a.puter.kv.set(`shared:${f.ref.s}:e:place:bad`, { name: 42 });
    const space = await b.open(f.ref, { handles: joined.handles });
    expect(space.select.place.all()).toHaveLength(1100);
    expect(space.get('msg', message).text).toBe('Hello');
    expect(f.world.counters().byUser[bob].calls['kv.list']).toBeGreaterThanOrEqual(3);
  });
  it('fills in a commit below the signal whose entities were not listed yet', async () => {
    const f = await setup();
    const b = await f.account(bob);
    const { joined } = await invite(f, b, bob);
    const aliceSpace = await f.a.open(f.ref);
    const late = makeId();
    const clock = createClock({ node: '0000000000000009', now: f.now });
    const rev = aliceSpace.state.rev + 1;
    const entity = { name: 'Still writing', id: late, v: clock.tick(), rev, upd: 1, by: alice, cr: 1 };
    // A two-part record whose entity sits in the second chunk.
    await f.a.puter.kv.set(`shared:${f.ref.s}:ch:${rev}:0`, { rev, parts: 2, at: 1, by: alice, ents: [], del: [], sum: [] });
    await f.a.puter.kv.set(`shared:${f.ref.s}:ch:${rev}:1`, { rev, ents: [{ t: 'place', ...entity }], del: [] });
    // A record with an entity this client cannot validate is skipped on its own.
    const skipped = makeId();
    await f.a.puter.kv.set(`shared:${f.ref.s}:ch:${rev + 1}:0`, { rev: rev + 1, parts: 1, at: 1, by: alice, ents: [{ t: 'place', id: skipped, name: 42 }], del: [], sum: [] });
    await f.a.puter.kv.set(`shared:${f.ref.s}:sig`, { rev: rev + 1 });
    const space = await b.open(f.ref, { handles: joined.handles });
    expect(space.get('place', late).name).toBe('Still writing');
    expect(space.get('place', skipped)).toBeUndefined();
  });
  it('skips a polled record it cannot validate, flags the space outdated and applies later records in order', async () => {
    const f = await setup();
    const b = await f.account(bob);
    const { joined } = await invite(f, b, bob);
    const onError = vi.fn();
    const space = await b.open(f.ref, { handles: joined.handles, onError });
    const clock = createClock({ node: '0000000000000009', now: f.now });
    const put = (key, value) => f.a.puter.kv.set(`shared:${f.ref.s}:${key}`, value);
    const place = (id, rev, name) => ({ t: 'place', name, id, v: clock.tick(), rev, upd: 1, by: alice, cr: 1 });
    const rev = space.state.rev + 1;
    const [mixed, bad, later, last] = [makeId(), makeId(), makeId(), makeId()];
    // The full record in sig: one valid and one invalid entity, so the whole record is skipped.
    const direct = { rev, parts: 1, at: 1, by: alice, ents: [place(mixed, rev, 'Same record'), place(bad, rev, 42)], del: [], sum: [] };
    await put(`ch:${rev}:0`, direct); await put('sig', direct);
    await space.sync();
    expect(space.state).toMatchObject({ path: 'A', sync: 'synced', issue: 'outdated', skipped: 1, rev });
    expect(space.get('place', mixed)).toBeUndefined();
    // Catch-up across another invalid record keeps applying valid ones in order.
    await put(`ch:${rev + 1}:0`, { rev: rev + 1, parts: 1, at: 1, by: alice, ents: [place(later, rev + 1, 'Later')], del: [], sum: [] });
    await put(`ch:${rev + 2}:0`, { rev: rev + 2, parts: 1, at: 1, by: alice, ents: [{ ...place(bad, rev + 2, 'x'), t: 'futureType' }], del: [], sum: [] });
    await put(`ch:${rev + 3}:0`, { rev: rev + 3, parts: 1, at: 1, by: alice, ents: [place(last, rev + 3, 'Last')], del: [], sum: [] });
    await put('sig', { rev: rev + 3 });
    await f.world.flushEvents();
    await space.sync();
    await vi.waitFor(() => expect(space.state).toMatchObject({ sync: 'synced', issue: 'outdated', skipped: 2, rev: rev + 3 }));
    expect(space.get('place', later).name).toBe('Later');
    expect(space.get('place', last).name).toBe('Last');
    expect(space.store.skipped).toEqual([rev, rev + 2]);
    expect(onError).not.toHaveBeenCalled();
  });
  it('re-lists on the next open after a skip, so a build that can read the record recovers it', async () => {
    const f = await setup();
    const b = await f.account(bob);
    const { joined } = await invite(f, b, bob);
    let space = await b.open(f.ref, { handles: joined.handles });
    const clock = createClock({ node: '0000000000000009', now: f.now });
    const put = (key, value) => f.a.puter.kv.set(`shared:${f.ref.s}:${key}`, value);
    const rev = space.state.rev + 1;
    const id = makeId();
    const entity = (name) => ({ name, id, v: clock.tick(), rev, upd: 1, by: alice, cr: 1 });
    const write = async (name) => {
      const value = entity(name);
      await put(`e:place:${id}`, value);
      await put(`ch:${rev}:0`, { rev, parts: 1, at: 1, by: alice, ents: [{ t: 'place', ...value }], del: [], sum: [] });
      await put('sig', { rev });
    };
    await write(42);
    await space.sync();
    expect(space.state).toMatchObject({ issue: 'outdated', rev });
    const lists = () => f.world.counters().byUser[bob].calls['kv.list'] ?? 0;
    // Reopened by the same build: the listing and margin still cannot validate it.
    space.close();
    let before = lists();
    space = await b.open(f.ref, { handles: joined.handles });
    expect(lists()).toBeGreaterThan(before);
    expect(space.state).toMatchObject({ issue: 'outdated', rev });
    expect(space.get('place', id)).toBeUndefined();
    // Reopened by a build that can validate it (simulated by valid data).
    space.close();
    await write('Recovered');
    before = lists();
    space = await b.open(f.ref, { handles: joined.handles });
    expect(lists()).toBeGreaterThan(before);
    expect(space.state).toMatchObject({ issue: null, skipped: 0, rev });
    expect(space.get('place', id).name).toBe('Recovered');
    // Later opens poll again instead of listing.
    space.close();
    before = lists();
    space = await b.open(f.ref, { handles: joined.handles });
    expect(lists()).toBe(before);
  });
  it('waits on a missing change record, then repairs by re-listing after 15 s', async () => {
    const f = await setup();
    const b = await f.account(bob);
    const { joined } = await invite(f, b, bob);
    const space = await b.open(f.ref, { handles: joined.handles });
    // A record whose rev is claimed but whose change record is not readable yet.
    const place = makeId();
    const rev = space.state.rev + 1;
    const v = createClock({ node: '0000000000000009', now: f.now }).tick();
    await f.a.puter.kv.set(`shared:${f.ref.s}:e:place:${place}`, { name: 'Gap', id: place, v, rev, upd: 1, by: alice, cr: 1 });
    await f.a.puter.kv.set(`shared:${f.ref.s}:sig`, { rev });
    await f.world.flushEvents();
    await space.sync();
    expect(space.get('place', place)).toBeUndefined();
    expect(space.state.rev).toBe(rev - 1);
    f.advance(15_001);
    await space.sync();
    await space.sync();
    expect(space.get('place', place).name).toBe('Gap');
    expect(space.state.rev).toBe(rev);
  });
  it('falls back to path C on 402 and on a revoked handle, and keeps syncing', async () => {
    const f = await setup();
    const b = await f.account(bob);
    const { joined } = await invite(f, b, bob);
    const timers = [];
    const space = await b.open(f.ref, { handles: joined.handles, setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length; } });
    f.world.failNext({ method: 'kv.get', as: bob, status: 402, code: 'insufficient_funds' });
    await space.sync();
    expect(space.state).toMatchObject({ path: 'C', issue: 'credit' });
    const aliceSpace = await f.a.open(f.ref);
    const place = makeId();
    await aliceSpace.apply([aliceSpace.ops.create('place', { name: 'Via worker' }, { id: place })]);
    await aliceSpace.flush();
    // Path C after a credit fallback runs at most once a minute.
    const execs = f.world.counters().byUser[bob].calls['workers.exec'];
    await space.sync();
    expect(f.world.counters().byUser[bob].calls['workers.exec']).toBe(execs);
    f.advance(60_001);
    await space.sync();
    expect(space.get('place', place).name).toBe('Via worker');
    timers.find((timer) => timer.ms === 10 * 60_000).callback();
    await space.sync();
    expect(space.state).toMatchObject({ path: 'A', issue: null });

    const c = await f.account(carol);
    const carolJoin = await invite(f, c, carol);
    const carolSpace = await c.open(f.ref, { handles: carolJoin.joined.handles });
    await f.a.puter.kv.unshare(carolJoin.joined.handles.read);
    await carolSpace.sync();
    expect(carolSpace.state.path).toBe('C');
    expect(carolSpace.get('place', place).name).toBe('Via worker');
  });
  it('uses path C without handles', async () => {
    const f = await setup({ mintHandles: false });
    const b = await f.account(bob);
    await invite(f, b, bob);
    const space = await b.open(f.ref, { open: false });
    expect(space.state.path).toBe('C');
    expect(space.get('meta', 'meta').title).toBe('Lisbon');
  });
  it('switches from path C to A when open returns handles, and caches them', async () => {
    const f = await setup();
    const b = await f.account(bob);
    const { joined } = await invite(f, b, bob);
    await b.personal.spaces.remove(f.ref);
    const space = await b.open(f.ref);
    await vi.waitFor(() => expect(space.state.path).toBe('A'));
    expect((await b.personal.spaces.list())[0].handles).toEqual(joined.handles);
  });
});

describe('member regions', () => {
  it('writes presence and the read marker through the write handle and reads others through u:*', async () => {
    const f = await setup();
    const b = await f.account(bob);
    const { joined } = await invite(f, b, bob);
    const aliceSpace = await f.a.open(f.ref, { view: 'plan' });
    const bobSpace = await b.open(f.ref, { handles: joined.handles, view: 'costs' });
    await f.world.flushEvents();
    expect(f.world.inspectKv(alice)[`shared:${f.ref.s}:u:${bob}:pres`]).toMatchObject({ view: 'costs' });
    await vi.waitFor(() => expect(aliceSpace.members().find((member) => member.uid === bob)).toMatchObject({ active: true, view: 'costs' }));
    await bobSpace.markSeen(2);
    expect(f.world.inspectKv(alice)[`shared:${f.ref.s}:u:${bob}:seen`]).toEqual({ rev: 2 });
    expect(f.world.counters().byUser[bob].calls['kv.set']).toBeGreaterThanOrEqual(2);
    expect(aliceSpace.members().find((member) => member.uid === alice)).toMatchObject({ active: true, view: 'plan' });
    aliceSpace.close();
    const reopened = await f.a.open(f.ref);
    await vi.waitFor(() => expect(reopened.members().find((member) => member.uid === bob)).toMatchObject({ active: true, view: 'costs', seen: 2 }));
  });
  it('uses the worker pres op and me:seen without handles', async () => {
    const f = await setup({ mintHandles: false });
    const b = await f.account(bob);
    await invite(f, b, bob);
    const space = await b.open(f.ref, { open: false, view: 'lists' });
    await vi.waitFor(() => expect(f.world.inspectKv(alice)[`sp:${f.ref.s}:pres`]).toHaveProperty(bob));
    await space.markSeen(2);
    expect(f.world.inspectKv(bob)[`me:seen:${f.ref.s}`]).toBe(2);
    expect(await space.unread()).toBe(0);
  });
  it('clamps values written by members', () => {
    expect(regionValue('pres', { at: 5, view: 'plan', extra: 'x' }, 10)).toEqual({ at: 5, view: 'plan' });
    expect(regionValue('pres', { at: 10_000_000, view: '<script>' }, 10)).toEqual({ at: 60_010, view: '' });
    expect(regionValue('pres', { at: 'now' }, 10)).toBeNull();
    expect(regionValue('seen', { rev: -1 }, 10)).toBeNull();
    expect(regionValue('seen', { rev: 3 }, 10)).toEqual({ rev: 3 });
  });
});
