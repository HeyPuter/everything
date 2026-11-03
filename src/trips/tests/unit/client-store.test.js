import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { openSpaceStore, registerDomainAdapter } from '../../src/lib/store/space.js';
import { createSelectors } from '../../src/lib/store/query.js';
import { createHistory, inverseOps } from '../../src/lib/store/history.js';
import { feedEntry, unreadCount } from '../../src/lib/store/feed.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { createMemberRegion } from '../../src/lib/sync/presence.js';
import { DomainError } from '../../src/shared/errors.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { validateCommit } from '../../src/shared/operations.js';
import { schemas } from '../../src/shared/schema/index.js';

const uid = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
let seq = 0;
const makeId = () => `4${String(++seq).padStart(15, '0')}`;
const clock = createClock({ node: '0000000000000007', now: () => 1_000_000 });
const server = (t, id, fields, rev = 1, extra = {}) => ({ t, id, ...fields, v: clock.tick(), rev, upd: 1000 + rev, by: other, cr: 1000, ...extra });
const databases = [];
async function database() { const db = await openDatabase(uid, { indexedDB: new IDBFactory() }); databases.push(db); return db; }
async function seeded(ents, options = {}) {
  const store = await openSpaceStore({ ref, db: await database(), makeId, ...options });
  await store.replace({ rev: 1, ents });
  return store;
}
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });

describe('optimistic view and change sets', () => {
  it('reports only the changed entity and keeps untouched objects identical', async () => {
    const a = makeId(); const b = makeId();
    const store = await seeded([server('place', a, { name: 'A' }), server('place', b, { name: 'B' }), server('day', makeId(), { order: 'a1', date: null })]);
    const before = { a: store.get('place', a), b: store.get('place', b), days: store.entities('day') };
    const events = [];
    store.subscribe((event) => events.push(event));
    await store.apply([{ opId: makeId(), t: 'place', id: a, set: { name: 'A2' } }]);
    expect([...events.at(-1).changed]).toEqual([`place:${a}`]);
    expect([...events.at(-1).types]).toEqual(['place']);
    expect(store.get('place', b)).toBe(before.b);
    expect(store.get('place', a)).not.toBe(before.a);
    expect(store.entities('day')).toBe(before.days);
    expect(Object.isFrozen(store.get('place', a))).toBe(true);
    expect(store.overlay('place', a)).toEqual({ pending: true, local: false, conflict: null });
  });
  it('a stale pending patch on a remotely deleted entity does not block unrelated edits', async () => {
    const a = makeId(); const b = makeId();
    const store = await seeded([server('place', a, { name: 'A' }), server('place', b, { name: 'B' })]);
    await store.apply([{ opId: makeId(), t: 'place', id: a, set: { name: 'A2' } }]);
    await store.receive([{ rev: 2, ents: [], del: [{ t: 'place', id: a, v: clock.tick() }] }]);
    expect(store.get('place', a)).toBeUndefined();
    await store.apply([{ opId: makeId(), t: 'place', id: b, set: { name: 'B2' } }]);
    await expect(store.apply([{ opId: makeId(), t: 'place', id: a, set: { name: 'A3' } }])).rejects.toThrow('gone');
    expect(store.get('place', b).name).toBe('B2');
  });
  it('shows domain ops through registered adapters and queues them either way', async () => {
    const day = makeId(); const other = makeId(); const visit = makeId();
    const store = await seeded([server('day', day, { order: 'a1', date: null }), server('day', other, { order: 'a1', date: null }), server('visit', visit, { dayId: day, placeId: null, title: 'Walk', order: 'a1' })]);
    registerDomainAdapter('visit.move', (args) => [{ t: 'visit', id: args.visit, set: { dayId: args.day, order: args.order } }]);
    await store.apply([{ opId: makeId(), do: 'visit.move', args: { visit, day: other, order: 'a5' } }]);
    expect(store.get('visit', visit)).toMatchObject({ dayId: other, order: 'a5' });
    await store.apply([{ opId: makeId(), do: 'trip.redate', args: { start: '2026-01-01' } }]);
    expect(store.pending.map((op) => op.do)).toEqual(['visit.move', 'trip.redate']);
    registerDomainAdapter('day.remove', () => [{ t: 'day', id: day, set: { order: '' } }]);
    await expect(store.apply([{ opId: makeId(), do: 'day.remove', args: { day } }])).rejects.toThrow();
  });
});

describe('typed selectors', () => {
  it('builds a selector for every schema type and sorts by order keys or creation', async () => {
    const day1 = makeId(); const day2 = makeId(); const v1 = makeId(); const v2 = makeId(); const v3 = makeId();
    const store = await seeded([
      server('day', day1, { order: 'b1', date: null }), server('day', day2, { order: 'a1', date: null }),
      server('visit', v1, { dayId: day1, placeId: null, title: 'One', order: 'a2' }), server('visit', v2, { dayId: day1, placeId: null, title: 'Two', order: 'a1' }),
      server('visit', v3, { dayId: day2, placeId: null, title: 'Three', order: 'a1' }),
      server('link', makeId(), { title: 'Late', url: 'https://example.com/b' }, 1, { cr: 3000 }), server('link', makeId(), { title: 'Early', url: 'https://example.com/a' }, 1, { cr: 2000 }),
    ]);
    const select = createSelectors({ kind: 'trip', source: (type) => store.entities(type), get: (type, id) => store.get(type, id), subscribe: () => () => {} });
    expect(Object.keys(select).sort()).toEqual(Object.keys(schemas.trip).sort());
    expect(select.day.all().map((day) => day.id)).toEqual([day2, day1]);
    expect(select.visit.groupBy('dayId').get(day1).map((visit) => visit.title)).toEqual(['Two', 'One']);
    expect(select.visit.by('dayId', day2)).toHaveLength(1);
    expect(select.link.all().map((link) => link.title)).toEqual(['Early', 'Late']);
    expect(select.day.all()).toBe(select.day.all());
    expect(select.visit.ordered).toBe(true);
    expect(select.link.ordered).toBe(false);
  });
});

describe('op builders and history through openSpace', () => {
  async function local() {
    const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
    const puter = world.client(uid);
    const db = await database();
    const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 0, changes: [] })), snapshot: vi.fn() };
    const personal = createPersonalStore({ puter, db });
    const space = await openSpace({ ref, db, api, puter, personal, makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
    return { world, puter, db, api, personal, space };
  }
  it('builds valid create, patch, delete and domain ops; base uses the server version', async () => {
    const { space } = await local();
    const place = makeId();
    const create = space.ops.create('place', { name: 'Museum' }, { id: place });
    const domain = space.ops.domain('day.remove', { day: makeId() }, ['note']);
    const counted = space.ops.domain('trip.redate', { start: '2027-05-01' }, { items: 3 });
    expect(() => validateCommit([create, domain, counted], { kind: 'trip' })).not.toThrow();
    expect(domain.args.newIds.note).toMatch(/^[0-9a-z]{16}$/);
    expect(counted.args.newIds.items).toHaveLength(3);
    await space.apply([create]);
    expect(space.ops.patch('place', place, { set: { name: 'X' } }, { base: true })).not.toHaveProperty('base');
    await space.store.receive([{ rev: 1, ents: [server('place', place, { name: 'Museum' })], del: [] }]);
    const version = space.store.serverVersion('place', place);
    await space.apply([space.ops.patch('place', place, { set: { name: 'Local' } })]);
    const patch = space.ops.patch('place', place, { set: { notes: 'n' }, unset: ['desc'] }, { base: true });
    expect(patch.base).toBe(version);
    expect(space.ops.remove('place', place, { base: true })).toMatchObject({ del: true, base: version });
    expect(() => validateCommit([patch], { kind: 'trip' })).not.toThrow();
    space.close();
  });
  it('follows the caller\'s role from their member entity, and listeners see it', async () => {
    const { space, personal } = await local();
    expect(space.role).toBeNull();
    await space.store.receive([{ rev: 1, ents: [server('member', uid, { name: 'Me', role: 'viewer' })], del: [] }]);
    expect(space.role).toBe('viewer');
    expect(space.can('plan.edit')).toBe(false);
    const seen = [];
    space.subscribe('member', () => seen.push(space.can('plan.edit')));
    space.onState(() => seen.push(space.role));
    const upsert = vi.spyOn(personal.spaces, 'upsert').mockResolvedValue({});
    await space.store.receive([{ rev: 2, ents: [server('member', uid, { name: 'Me', role: 'editor' }, 2)], del: [] }]);
    expect(space.role).toBe('editor');
    expect(seen.slice(0, 2)).toEqual([true, 'editor']);
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ role: 'editor' })));
    // Someone else's role change leaves ours alone.
    await space.store.receive([{ rev: 3, ents: [server('member', other, { name: 'Bob', role: 'owner' }, 3)], del: [] }]);
    expect(space.role).toBe('editor');
    space.close();
  });
  it('takes the role from a member entity already in the replica when it opens', async () => {
    const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
    const puter = world.client(uid);
    const db = await database();
    const store = await openSpaceStore({ ref, db, makeId });
    await store.replace({ rev: 4, ents: [server('member', uid, { name: 'Me', role: 'editor' }, 4)] });
    store.close();
    const api = { commit: vi.fn(), call: vi.fn(async () => ({ rev: 4, changes: [] })), snapshot: vi.fn() };
    const space = await openSpace({ ref, db, api, puter, personal: createPersonalStore({ puter, db }), role: 'viewer', makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false, autoStart: false });
    expect(space.role).toBe('editor');
    space.close();
  });
  it('undoes and redoes edits and creates, remapping redone ids', async () => {
    const { space } = await local();
    const place = makeId(); const day = makeId(); const visit = makeId();
    await space.apply([space.ops.create('place', { name: 'Before' }, { id: place }), space.ops.create('day', { order: 'a1', date: null }, { id: day })]);
    await space.apply([space.ops.patch('place', place, { set: { name: 'After', notes: 'new' } })], { history: 'rename' });
    expect(space.history.label).toBe('rename');
    await space.history.undo();
    expect(space.get('place', place)).toMatchObject({ name: 'Before' });
    expect(space.get('place', place).notes).toBeUndefined();
    await space.history.redo();
    expect(space.get('place', place)).toMatchObject({ name: 'After', notes: 'new' });
    await space.apply([space.ops.create('visit', { dayId: day, placeId: place, order: 'a1' }, { id: visit })], { history: 'import' });
    await space.history.undo();
    expect(space.get('visit', visit)).toBeUndefined();
    await space.history.redo();
    const [redone] = space.select.visit.all();
    expect(redone.id).not.toBe(visit);
    expect(redone.placeId).toBe(place);
    await space.history.undo();
    expect(space.select.visit.all()).toEqual([]);
    await space.history.redo();
    expect(space.history.canRedo).toBe(false);
    await space.history.undo();
    expect(space.history.canRedo).toBe(true);
    await space.apply([space.ops.remove('day', day)], { history: 'delete' });
    expect(space.history.label).toBe('rename');
    expect(space.history.canRedo).toBe(false);
    space.close();
  });
  it('computes inverses and refuses deletes and domain ops', () => {
    const get = () => ({ id: 'x', name: 'Old', rating: { [uid]: 3 } });
    expect(inverseOps([{ t: 'place', id: 'x', set: { name: 'New', 'rating.u': 1 } }], get)).toEqual([{ t: 'place', id: 'x', set: { name: 'Old' }, unset: ['rating.u'] }]);
    expect(inverseOps([{ t: 'place', id: 'x', del: true }], get)).toBeNull();
    expect(inverseOps([{ do: 'day.remove', args: {} }], get)).toBeNull();
    const history = createHistory({ apply: async () => {}, get });
    expect(history.record('x', [{ t: 'place', id: 'x', del: true }])).toBe(false);
    expect(history.canUndo).toBe(false);
  });
  it('undoes and redoes a domain op with the inverse its owner supplies', async () => {
    const applied = [];
    const history = createHistory({ apply: async (ops) => { applied.push(ops); }, get: () => undefined, makeId });
    const move = { opId: makeId(), do: 'visit.move', args: { visit: 'v', day: 'b', order: 'a5' } };
    expect(history.record('move', [move], { inverse: [{ opId: makeId(), do: 'visit.move', args: { visit: 'v', day: 'a', order: 'a1' } }] })).toBe(true);
    await history.undo();
    await history.redo();
    expect(applied.map(([op]) => op.args.day)).toEqual(['a', 'b']);
    expect(applied.every(([op]) => op.do === 'visit.move' && op.opId !== move.opId)).toBe(true);
  });
});

describe('conflict parking and resolution', () => {
  async function conflicted({ code = 'stale', status = 409, serverFields = { name: 'Theirs', notes: 'Remote' } } = {}) {
    const place = makeId(); const other = makeId();
    const base = server('place', place, { name: 'Base' });
    const failing = { op: null };
    const api = { commit: vi.fn(async () => { throw new ApiError(status, code, { op: failing.op, server: code === 'gone' ? { t: 'place', id: place, deleted: true, rev: 3, v: clock.tick() } : { ...base, ...serverFields, v: clock.tick(), rev: 3 } }); }) };
    const store = await seeded([base, server('place', other, { name: 'Other' })], { api });
    const mine = { opId: makeId(), t: 'place', id: place, set: { name: 'Mine' }, base: base.v };
    const unrelated = { opId: makeId(), t: 'place', id: other, set: { name: 'Other2' } };
    failing.op = mine.opId;
    await store.apply([mine, unrelated]);
    const result = await store.flush();
    return { store, place, other, mine, unrelated, result, api };
  }
  it('parks only the op the worker names and keeps the rest queued', async () => {
    const { store, place, mine, unrelated, result } = await conflicted();
    expect(result).toMatchObject({ status: 'conflict', opIds: [mine.opId] });
    expect(store.pending.map((op) => op.opId)).toEqual([unrelated.opId]);
    const [conflict] = store.conflicts;
    expect(conflict).toMatchObject({ code: 'stale', local: { name: 'Mine' }, server: { name: 'Theirs' } });
    expect(store.get('place', place).name).toBe('Theirs');
    expect(store.overlay('place', place).conflict).toBe('stale');
  });
  it('resolves with theirs, mine against the server version, or merged fields', async () => {
    const theirs = await conflicted();
    expect(await theirs.store.resolveConflict(theirs.mine.opId, { keep: 'theirs' })).toBeNull();
    expect(theirs.store.conflicts).toEqual([]);
    const mine = await conflicted();
    const resent = await mine.store.resolveConflict(mine.mine.opId, { keep: 'mine' });
    expect(resent).toMatchObject({ t: 'place', id: mine.place, set: { name: 'Mine' }, base: mine.store.serverVersion('place', mine.place) });
    expect(resent.opId).not.toBe(mine.mine.opId);
    expect(mine.store.get('place', mine.place).name).toBe('Mine');
    const merged = await conflicted();
    const op = await merged.store.resolveConflict(merged.mine.opId, { keep: 'merge', set: { name: 'Mine' }, unset: [] });
    expect(op).toMatchObject({ set: { name: 'Mine' }, base: merged.store.serverVersion('place', merged.place) });
    expect(merged.store.get('place', merged.place)).toMatchObject({ name: 'Mine', notes: 'Remote' });
  });
  it('restores a deleted entity as a copy, and drops a delete of a deleted entity', async () => {
    const gone = await conflicted({ code: 'gone' });
    expect(gone.store.get('place', gone.place)).toBeUndefined();
    const copy = await gone.store.resolveConflict(gone.mine.opId, { keep: 'mine' });
    expect(copy.id).not.toBe(gone.place);
    expect(copy.put).toMatchObject({ name: 'Mine' });
    await expect(gone.store.resolveConflict('0000000000000999', { keep: 'mine' })).rejects.toThrow('conflict_not_found');
  });
  it('restores a copy when a pull removed the entity before the patch was refused', async () => {
    const place = makeId();
    const base = server('place', place, { name: 'Base', lat: 1, lng: 2 });
    const api = { commit: vi.fn(async () => { throw new ApiError(409, 'gone', { op: mine.opId, server: { t: 'place', id: place, deleted: true, rev: 3, v: clock.tick() } }); }) };
    const store = await seeded([base], { api });
    const mine = { opId: makeId(), t: 'place', id: place, set: { name: 'Mine' } };
    await store.apply([mine]);
    await store.receive([{ rev: 2, ents: [], del: [{ t: 'place', id: place, v: clock.tick() }] }]);
    expect(store.get('place', place)).toBeUndefined();
    expect((await store.flush()).status).toBe('conflict');
    const copy = await store.resolveConflict(mine.opId, { keep: 'mine' });
    expect(copy.put).toEqual({ name: 'Mine', lat: 1, lng: 2 });
    expect(store.get('place', copy.id)).toMatchObject({ name: 'Mine' });
  });
  it('rolls back only the named op on 403', async () => {
    const { store, unrelated, result, place } = await conflicted({ code: 'forbidden', status: 403 });
    expect(result.status).toBe('rejected');
    expect(store.conflicts).toEqual([]);
    expect(store.pending.map((op) => op.opId)).toEqual([unrelated.opId]);
    expect(store.get('place', place).name).toBe('Base');
  });
  it('rebases queued edits on the version our own acknowledged write produced', async () => {
    const place = makeId();
    const base = server('place', place, { name: 'Base' });
    const sent = [];
    const api = { commit: vi.fn(async (_, body) => {
      const { ops } = JSON.parse(body); sent.push(ops);
      return { rev: 2, ents: [{ ...base, name: 'One', v: clock.tick(), rev: 2 }], del: [], done: Object.fromEntries(ops.map((op) => [op.opId, 2])) };
    }) };
    const store = await seeded([base], { api });
    const first = { opId: makeId(), t: 'place', id: place, set: { name: 'One' }, base: base.v };
    await store.apply([first]);
    const flushing = store.flush();
    await store.apply([{ opId: makeId(), t: 'place', id: place, set: { notes: 'Two' }, base: base.v }]);
    await flushing;
    expect(store.pending[0].base).toBe(store.serverVersion('place', place));
    expect(store.pending[0].base).not.toBe(base.v);
  });
});

describe('batches, rebasing and status', () => {
  it('rebases a queued edit when our own change record arrives before the commit acknowledgement', async () => {
    const place = makeId();
    const base = server('place', place, { name: 'Base' });
    let release;
    const api = { commit: vi.fn(() => new Promise((resolve) => { release = resolve; })) };
    const store = await seeded([base], { api });
    const first = { opId: makeId(), t: 'place', id: place, set: { name: 'One' }, base: base.v };
    await store.apply([first]);
    const flushing = store.flush();
    await vi.waitFor(() => expect(api.commit).toHaveBeenCalled());
    await store.apply([{ opId: makeId(), t: 'place', id: place, set: { notes: 'Two' }, base: base.v }]);
    const ours = { ...base, name: 'One', v: clock.tick(), rev: 2 };
    await store.receive([{ rev: 2, ents: [ours], del: [] }]);
    release({ rev: 2, ents: [ours], del: [], done: { [first.opId]: 2 } });
    await flushing;
    expect(store.pending[0].base).toBe(ours.v);
  });
  it('never moves a queued base back when another member’s newer record arrived first', async () => {
    const place = makeId();
    const base = server('place', place, { name: 'Base' });
    let release;
    const api = { commit: vi.fn(() => new Promise((resolve) => { release = resolve; })) };
    const store = await seeded([base], { api });
    const first = { opId: makeId(), t: 'place', id: place, set: { name: 'One' }, base: base.v };
    await store.apply([first]);
    const flushing = store.flush();
    await vi.waitFor(() => expect(api.commit).toHaveBeenCalled());
    const ours = { ...base, name: 'One', v: clock.tick(), rev: 2 };
    const theirs = { ...ours, notes: 'Theirs', v: clock.tick(), rev: 3, by: other };
    await store.receive([{ rev: 2, ents: [ours], del: [] }, { rev: 3, ents: [theirs], del: [] }]);
    await store.apply([{ opId: makeId(), t: 'place', id: place, set: { notes: 'Mine' }, base: store.serverVersion('place', place) }]);
    release({ rev: 2, ents: [ours], del: [], done: { [first.opId]: 2 } });
    await flushing;
    expect(store.pending[0].base).toBe(theirs.v);
  });
  it('splits a batch the worker refuses as too large and sizes batches by entity writes', async () => {
    const bodies = [];
    const api = { commit: vi.fn(async (_, body) => {
      const { ops } = JSON.parse(body); bodies.push(ops);
      if (ops.length > 2) throw new ApiError(413, 'too_many_writes');
      return { rev: bodies.length, ents: [], del: [], done: Object.fromEntries(ops.map((op) => [op.opId, bodies.length])) };
    }) };
    const store = await seeded([], { api });
    await store.apply(Array.from({ length: 4 }, () => ({ opId: makeId(), t: 'note', id: makeId(), put: { title: 'N' } })));
    expect(await store.flush()).toEqual({ status: 'queued', retry: true });
    expect(store.conflicts).toEqual([]);
    expect((await store.flush()).status).toBe('sent');
    expect((await store.flush()).status).toBe('sent');
    expect(store.pending).toEqual([]);
    expect(bodies.map((ops) => ops.length)).toEqual([4, 2, 2]);
    const sized = await seeded([], { api: { commit: vi.fn(async (_, body) => { bodies.push(JSON.parse(body).ops); throw new ApiError(0, 'network'); }) } });
    await sized.apply([{ opId: makeId(), do: 'costs.settleAll', args: { newIds: { items: Array.from({ length: 150 }, () => makeId()) } } }]);
    for (let i = 0; i < 2; i++) await sized.apply(Array.from({ length: 50 }, () => ({ opId: makeId(), t: 'note', id: makeId(), put: { title: 'N' } })));
    await sized.flush();
    expect(bodies.at(-1)).toHaveLength(51);
  });
  it('reports conflicts and outdated workers in the space state after an outbox flush', async () => {
    const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
    const puter = world.client(uid);
    const db = await database();
    const failure = { error: null };
    const api = { commit: vi.fn(async (_, body) => { throw failure.error ?? new ApiError(409, 'stale', { op: JSON.parse(body).ops[0].opId }); }), call: vi.fn(async () => ({ rev: 0, changes: [] })) };
    const space = await openSpace({ ref, db, api, puter, personal: createPersonalStore({ puter, db }), makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
    const onState = vi.fn();
    space.onState(onState);
    await space.apply([space.ops.create('note', { title: 'N' })]);
    await space.flush();
    expect(space.state).toMatchObject({ sync: 'conflict', conflicts: 1 });
    await space.resolveConflict(space.conflicts()[0].op.opId, { keep: 'theirs' });
    failure.error = new DomainError('worker_outdated', 426);
    await space.apply([space.ops.create('note', { title: 'M' })]);
    await space.flush();
    expect(space.state).toMatchObject({ sync: 'forbidden', issue: 'outdated', pending: 1 });
    expect(onState).toHaveBeenCalled();
    failure.error = new ApiError(0, 'network');
    await space.apply([space.ops.create('note', { title: 'Parked' })]);
    api.commit.mockImplementationOnce(async (_, body) => { throw new ApiError(409, 'stale', { op: JSON.parse(body).ops[0].opId }); });
    await space.flush();
    expect(space.state.conflicts).toBe(1);
    await space.flush();
    expect(space.state).toMatchObject({ sync: 'offline', conflicts: 1 });
    api.commit.mockImplementation(async (_, body) => { const { ops } = JSON.parse(body); return { rev: 1, ents: [], del: [], done: Object.fromEntries(ops.map((op) => [op.opId, 1])) }; });
    await space.flush();
    expect(space.state.issue).toBeNull();
    space.close();
  });
  it('throttles presence writes from view and visibility changes', async () => {
    const writes = [];
    const timers = [];
    let time = 0;
    const region = createMemberRegion({ puter: { kv: { set: async (key, value) => { writes.push(value); } } }, api: {}, ref, uid, writeHandle: 'kvh-1', document: null,
      now: () => time, setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimer: () => {} });
    region.start('plan');
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    region.setView('costs'); region.setView('lists');
    expect(writes).toHaveLength(1);
    const soon = timers.find((timer) => timer.ms === 15_000);
    time = 15_000; soon.callback();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].view).toBe('lists');
    region.stop();
  });
});

describe('activity feed', () => {
  it('accumulates entries from change records in IndexedDB and counts unread', async () => {
    const store = await seeded([]);
    const place = makeId();
    const created = server('place', place, { name: 'Café' }, 2, { upd: 5000, cr: 5000 });
    const at = Date.now();
    await store.receive([{ rev: 2, at, by: other, ents: [created], del: [], sum: [{ t: 'place', id: place, name: 'Café', fields: ['name'] }] }]);
    await store.receive([{ rev: 3, at: at + 1, by: uid, ents: [{ ...created, notes: 'x', v: clock.tick(), rev: 3, upd: 6000 }], del: [], sum: [{ t: 'place', id: place, name: 'Café', fields: ['notes'] }] }]);
    await store.receive([{ rev: 4, at: at + 2, by: other, ents: [], del: [{ t: 'place', id: place, v: clock.tick() }], sum: [{ t: 'place', id: place, name: 'Café', fields: [] }] }]);
    const feed = await store.feed();
    expect(feed.map((entry) => [entry.rev, entry.items[0].op])).toEqual([[2, 'add'], [3, 'change'], [4, 'remove']]);
    expect(unreadCount(feed, { seen: 2, uid })).toBe(1);
    expect(unreadCount(feed, { seen: 0, uid })).toBe(2);
  });
  it('derives a summary when a record has none and clamps names', () => {
    const entry = feedEntry({ rev: 5, at: 1, by: other, ents: [{ t: 'note', id: makeId(), title: 'x'.repeat(300), cr: 1, upd: 2 }], del: [] });
    expect(entry.items[0]).toMatchObject({ t: 'note', op: 'add', fields: [] });
    expect(entry.items[0].name).toHaveLength(200);
    expect(feedEntry({ rev: 6, ents: [], del: [], sum: [{ t: '__proto__', id: 'x' }] })).toBeNull();
  });
});

describe('records this build cannot validate', () => {
  it('skips the whole record, records it and keeps applying later records in order', async () => {
    const db = await database();
    const store = await openSpaceStore({ ref, db, makeId });
    await store.replace({ rev: 1, ents: [] });
    const [a, b, c] = [makeId(), makeId(), makeId()];
    await store.receive([
      { rev: 2, ents: [server('place', a, { name: 'A' }, 2)], del: [] },
      { rev: 3, ents: [server('place', b, { name: 'B' }, 3), server('place', c, { name: 42 }, 3)], del: [] },
      { rev: 4, ents: [], del: [{ t: 'futureType', id: makeId(), v: clock.tick() }] },
      { rev: 5, ents: [server('place', c, { name: 'C' }, 5)], del: [] },
      { rev: 6, ents: [null], del: [] },
    ]);
    expect(store.rev).toBe(6);
    expect(store.skipped).toEqual([3, 4, 6]);
    expect(store.get('place', a).name).toBe('A');
    expect(store.get('place', b)).toBeUndefined();
    expect(store.get('place', c).name).toBe('C');
    expect((await store.feed()).map((entry) => entry.rev)).toEqual([2, 5]);
    await expect(store.receive([{ rev: 8, ents: [], del: [] }])).rejects.toThrow('sync_gap');
    expect(store.reread).toBe(false);
    const reopened = await openSpaceStore({ ref, db, makeId });
    expect(reopened.skipped).toEqual([3, 4, 6]);
    expect(reopened.reread).toBe(true);
    await reopened.replace({ rev: 6, ents: [] }, { invalid: true });
    expect(reopened).toMatchObject({ skipped: [6], reread: false });
    await reopened.replace({ rev: 6, ents: [] });
    expect(reopened.skipped).toEqual([]);
  });
  it('keeps syncing past a skipped record and reports an outdated client in the space state', async () => {
    const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
    const puter = world.client(uid);
    const db = await database();
    const place = makeId();
    const changes = [{ rev: 1, ents: [server('place', makeId(), { name: 42 }, 1)], del: [] }, { rev: 2, ents: [server('place', place, { name: 'Kept' }, 2)], del: [] }];
    const api = { commit: vi.fn(), call: vi.fn(async (_, op, { since }) => ({ rev: 2, changes: changes.filter((record) => record.rev > since) })) };
    const onError = vi.fn();
    const space = await openSpace({ ref, db, api, puter, personal: createPersonalStore({ puter, db }), makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false, onError });
    expect(space.state).toMatchObject({ path: 'C', sync: 'synced', issue: 'outdated', skipped: 1, rev: 2 });
    expect(space.get('place', place).name).toBe('Kept');
    await space.sync();
    expect(space.state).toMatchObject({ sync: 'synced', issue: 'outdated', rev: 2 });
    expect(onError).not.toHaveBeenCalled();
    space.close();
  });
});

describe('personal data', () => {
  async function devices() {
    const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
    let time = 1000;
    const now = () => time;
    const phone = createPersonalStore({ puter: world.client(uid), db: await database(), now, revalidateMs: 1000 });
    const laptop = createPersonalStore({ puter: world.client(uid), db: await database(), now, revalidateMs: 1000 });
    return { world, phone, laptop, advance: (ms) => { time += ms; } };
  }
  it('refreshes cached preferences from the cloud and notifies subscribers', async () => {
    const { phone, laptop, advance } = await devices();
    await phone.set('me:prefs', { theme: 'dark' });
    expect(await laptop.get('me:prefs')).toEqual({ theme: 'dark' });
    await phone.patchPreferences({ theme: 'light' });
    const seen = vi.fn();
    laptop.subscribe('me:prefs', seen);
    expect(await laptop.get('me:prefs')).toEqual({ theme: 'dark' });
    advance(1001);
    expect(await laptop.get('me:prefs')).toEqual({ theme: 'dark' });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith({ theme: 'light' }));
    expect(await laptop.get('me:prefs')).toEqual({ theme: 'light' });
    await phone.patchPreferences({ theme: 'system' });
    expect(await laptop.get('me:prefs', { fresh: true })).toEqual({ theme: 'system' });
  });
  it('receives other sessions’ writes for subscribed keys through events', async () => {
    const { world, phone, laptop } = await devices();
    const seen = vi.fn();
    laptop.subscribe('me:prefs', seen);
    const stop = await laptop.watch();
    await phone.patchPreferences({ units: 'mi' });
    await world.flushEvents();
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith({ units: 'mi' }));
    stop();
  });
  it('keeps private items per trip as one path per item and queues them offline', async () => {
    const { world, phone, laptop } = await devices();
    const pack = phone.privateItems(ref.s, 'pack');
    expect(await pack.list()).toEqual([]);
    world.setOffline(uid, true);
    const item = await pack.put({ name: 'Passport', order: 'a1' });
    expect((await pack.list()).map((entry) => entry.name)).toEqual(['Passport']);
    expect((await phone.flush()).sent).toBe(false);
    world.setOffline(uid, false);
    expect((await phone.flush()).sent).toBe(true);
    expect(world.inspectKv(uid)[pack.key][item.id]).toMatchObject({ name: 'Passport', id: item.id });
    await pack.patch(item.id, { qty: 2 });
    await phone.flush();
    expect((await laptop.privateItems(ref.s, 'pack').list())[0]).toMatchObject({ name: 'Passport', qty: 2 });
    await pack.remove(item.id);
    await phone.flush();
    expect(world.inspectKv(uid)[pack.key]).toEqual({});
    await expect(pack.put({ name: '' })).rejects.toThrow();
    expect(() => phone.privateItems(ref.s, 'todo')).toThrow('invalid_private_items');
  });
  it('parks a private write the cloud refuses, reverts the cache and reports it', async () => {
    const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
    const onError = vi.fn();
    const personal = createPersonalStore({ puter: world.client(uid), db: await database(), onError });
    const pack = personal.privateItems(ref.s, 'pack');
    expect(await pack.list()).toEqual([]);
    world.failNext({ method: 'kv.update', status: 400, code: 'value_too_large' });
    const item = await pack.put({ name: 'Tent', order: 'a1' });
    await personal.flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'private_write_refused', id: item.id }));
    expect(await pack.list()).toEqual([]);
    const [failed] = await personal.failedWrites();
    expect(failed).toMatchObject({ id: item.id, code: 'value_too_large' });
    await personal.dismissFailed(failed.qid);
    expect(await personal.failedWrites()).toEqual([]);
    world.failNext({ method: 'kv.update', status: 401, code: 'auth_required' });
    const kept = await pack.put({ name: 'Stove', order: 'a2' });
    expect((await personal.flush()).sent).toBe(false);
    expect((await pack.list()).map((entry) => entry.id)).toEqual([kept.id]);
    expect(await personal.failedWrites()).toEqual([]);
    expect((await personal.flush()).sent).toBe(true);
  });
  it('merges private items into a trip’s queries', async () => {
    const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
    const puter = world.client(uid);
    const db = await database();
    const personal = createPersonalStore({ puter, db });
    await personal.privateItems(ref.s, 'exp').put({ name: 'Gift', amount: 500, currency: 'EUR', payers: [], split: { mode: 'equal', parts: [{ who: uid }] } });
    await personal.flush();
    const api = { call: vi.fn(async () => ({ rev: 0, changes: [] })), commit: vi.fn() };
    const space = await openSpace({ ref, db, api, puter, personal, makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
    expect(space.query('exp')).toEqual([]);
    expect(space.query('exp', { includePrivate: true })).toEqual([expect.objectContaining({ name: 'Gift', private: true })]);
    const events = vi.fn();
    space.subscribe('pack', events);
    await space.privateItems('pack').put({ name: 'Charger', order: 'a1' });
    await vi.waitFor(() => expect(space.privateItems('pack').list()).toHaveLength(1));
    expect(events).toHaveBeenCalled();
    space.close();
  });
  it('maintains the joined-space index with handle ids', async () => {
    const { phone } = await devices();
    await phone.spaces.upsert({ ref, role: 'editor', title: 'Lisbon', handles: { read: 'kvh-1', write: 'kvh-2' } });
    await phone.spaces.upsert({ ref, role: 'viewer', title: 'Lisbon' });
    expect(await phone.spaces.list()).toEqual([{ ref, role: 'viewer', title: 'Lisbon', handles: { read: 'kvh-1', write: 'kvh-2' } }]);
    await expect(phone.spaces.upsert({ ref: { ...ref, w: 'evil' }, role: 'editor' })).rejects.toThrow();
    await phone.spaces.remove(ref);
    expect(await phone.spaces.list()).toEqual([]);
  });
});
