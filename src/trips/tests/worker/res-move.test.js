// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { K } from '../../worker/keys.js';
import { USERS, WORKER, createHarness, expectError, id, memoryDb } from './harness.js';
import { planMove } from '../../src/views/trip/bookings/move/plan.js';
import { moveEntry, moveJournal, runMove, undoMove } from '../../src/views/trip/bookings/move/run.js';

const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields) => ({ opId: id('o'), t, id: eid, set: fields });
const domain = (args) => ({ opId: id('o'), do: 'res.moveToTrip', args });
const ref = (space) => ({ w: WORKER, s: space, k: 'trip' });
const OWNER = USERS.alice.uuid;
const BOB = USERS.bob.uuid;
const owner = (h) => h.world.counters().byUser[OWNER]?.calls ?? {};
const PDF = new TextEncoder().encode('%PDF-1.7\n...');

async function setup() {
  const h = await createHarness();
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => h.client(name)));
  const as = (client, sid = space) => (ops) => client.in(sid).call('commit', { ops });
  const entity = (t, eid, sid = space) => h.kv()[K.entity(sid, t, eid)];
  const all = (sid, t) => Object.entries(h.kv()).filter(([key, value]) => key.startsWith(`shared:${sid}:e:${t}:`) && !value.deleted).map(([, value]) => value);
  async function file(client, sid, name = 'ticket.pdf') {
    const fileId = id('f');
    await client.api.upload(ref(sid), fileId, new Blob([PDF]));
    await client.in(sid).call('file.put', { fileId, name, mime: 'application/pdf', sha256: 'b'.repeat(64), kind: 'user' });
    return fileId;
  }
  return { h, space, alice, bob, carol, as, entity, all, file, aliceOps: as(alice), bobOps: as(bob), carolOps: as(carol) };
}

async function seeded() {
  const context = await setup();
  const { space, aliceOps, bob, file } = context;
  const ids = { place: id('p'), hotel: id('r'), dinner: id('r'), visit: id('v'), day: id('d'), sole: id('e'), shared: id('e') };
  await aliceOps([
    put('day', { order: 'a', date: '2027-05-01' }, ids.day),
    put('place', { name: 'Hotel Sol', lat: 38.7, lng: -9.1, ids: { osm: 'way/1' } }, ids.place),
    put('res', { type: 'lodging', title: 'Hotel Sol', status: 'confirmed', start: { date: '2027-05-01' }, end: { date: '2027-05-03' }, placeId: ids.place,
      stay: { checkInFrom: '15:00', fromDayId: ids.day }, people: [OWNER, BOB] }, ids.hotel),
    put('res', { type: 'restaurant', title: 'Dinner', status: 'pending', stayId: ids.hotel }, ids.dinner),
    put('visit', { dayId: ids.day, placeId: ids.place, order: 'a', stayId: ids.hotel }, ids.visit),
    put('exp', { name: 'Hotel', amount: 30000, currency: 'EUR', payers: [{ who: OWNER, amount: 30000 }], split: { mode: 'equal', parts: [{ who: OWNER }, { who: BOB }] }, links: [{ t: 'res', id: ids.hotel }] }, ids.sole),
    put('exp', { name: 'Taxi', amount: 2000, currency: 'EUR', payers: [], split: { mode: 'equal', parts: [{ who: OWNER }] }, links: [{ t: 'res', id: ids.hotel }, { t: 'place', id: ids.place }] }, ids.shared),
  ]);
  ids.file = await file(bob, space);
  await aliceOps([set('file', ids.file, { links: [{ t: 'res', id: ids.hotel }, { t: 'place', id: ids.place }] })]);
  const args = { res: ids.hotel, files: [ids.file], exps: [ids.sole, ids.shared], moved: [ids.sole], visits: [ids.visit], stays: [ids.dinner] };
  return { ...context, ids, args };
}

describe('res.moveToTrip', () => {
  it('deletes the booking, unlinks files and kept expenses, deletes moved ones and clears stays', async () => {
    const { bobOps, entity, ids, args } = await seeded();
    await bobOps([domain(args)]);
    expect(entity('res', ids.hotel)).toMatchObject({ deleted: true });
    expect(entity('file', ids.file).links).toEqual([{ t: 'place', id: ids.place }]);
    expect(entity('exp', ids.sole)).toMatchObject({ deleted: true });
    expect(entity('exp', ids.shared).links).toEqual([{ t: 'place', id: ids.place }]);
    expect(entity('visit', ids.visit)).not.toHaveProperty('stayId');
    expect(entity('res', ids.dinner)).not.toHaveProperty('stayId');
    expect(entity('place', ids.place)).toMatchObject({ name: 'Hotel Sol' });
  });

  it('needs res.edit, and costs.edit to delete moved expenses; links the caller may not edit stay', async () => {
    const { h, aliceOps, bobOps, carolOps, entity, ids, args } = await seeded();
    await expectError(carolOps([domain(args)]), 403, 'forbidden');
    await aliceOps([set('meta', 'meta', { perms: { 'costs.edit': 'owner', 'files.edit': 'owner' } })]);
    h.advance(6000);
    await expectError(bobOps([domain(args)]), 403, 'forbidden');
    await bobOps([domain({ ...args, moved: [] })]);
    expect(entity('res', ids.hotel)).toMatchObject({ deleted: true });
    expect(entity('exp', ids.sole).links).toEqual([{ t: 'res', id: ids.hotel }]);
    expect(entity('file', ids.file).links).toHaveLength(2);
  });

  it('answers stale for a newer booking, gone for a missing one, and replays a retried op', async () => {
    const { h, aliceOps, bobOps, entity, ids, args } = await seeded();
    const base = entity('res', ids.hotel).v;
    await aliceOps([set('res', ids.hotel, { title: 'Hotel Sol (renamed)' })]);
    const stale = await expectError(bobOps([domain({ ...args, base })]), 409, 'stale');
    expect(stale.server).toMatchObject({ t: 'res', id: ids.hotel, title: 'Hotel Sol (renamed)' });
    const op = domain({ ...args, base: entity('res', ids.hotel).v });
    const first = await bobOps([op]);
    h.world.resetCounters();
    expect((await bobOps([op])).done[op.opId]).toBe(first.rev);
    expect(owner(h)['kv.update'] ?? 0).toBe(0);
    await expectError(bobOps([domain({ res: ids.hotel })]), 409, 'gone');
  });

  it('validates its arguments', async () => {
    const { bobOps, ids, args } = await seeded();
    await expectError(bobOps([domain({ ...args, extra: 1 })]), 400, 'invalid_args');
    await expectError(bobOps([domain({ ...args, files: ['nope'] })]), 400, 'invalid_args');
    await expectError(bobOps([domain({ ...args, moved: [id('e')] })]), 400, 'invalid_args');
    await expectError(bobOps([domain({ ...args, stays: [ids.hotel] })]), 400, 'invalid_args');
    await expectError(bobOps([domain({ ...args, base: 'v1' })]), 400, 'invalid_args');
    await expectError(bobOps([domain({ res: ids.hotel, files: Array.from({ length: 200 }, () => id('f')) })]), 413, 'move_too_large');
  });

  it('costs one batched read', async () => {
    const { h, bobOps, args } = await seeded();
    h.world.resetCounters();
    await bobOps([domain(args)]);
    // Plus one batched read of the records that held the moved booking, which the delete scrubs.
    expect(owner(h)['kv.get']).toBe(2);
  });
});

describe('moving a booking between two trips through the real worker', () => {
  async function twoTrips() {
    const context = await seeded();
    const { h, alice, bob } = context;
    const target = await h.trip({ title: 'Porto', currency: 'EUR', start: '2027-05-01', end: '2027-05-02' });
    const { token } = await alice.in(target).call('invite.create', { role: 'editor' });
    await bob.in(target).call('join', { token });
    const day = id('d');
    await context.as(alice, target)([put('day', { order: 'a', date: '2027-05-01' }, day)]);
    let failSource = 0;
    const commit = async (to, ops) => {
      if (to.s === context.space && failSource > 0) { failSource -= 1; throw Object.assign(new Error('network'), { status: 0, code: 'network' }); }
      return bob.api.commit(to, JSON.stringify({ op: 'commit', space: to.s, ops }));
    };
    const copyFile = async (file, entry) => {
      const blob = await bob.api.download(entry.from, file.id);
      const fileId = id('f');
      await bob.api.upload(entry.to, fileId, blob);
      await bob.in(entry.to.s).call('file.put', { fileId, name: file.name, mime: file.mime, sha256: 'b'.repeat(64), kind: 'user' });
      await commit(entry.to, [set('file', fileId, { links: [{ t: 'res', id: entry.resId }] })]);
      return { id: fileId, duplicate: false };
    };
    const journal = moveJournal(memoryDb(BOB), context.space);
    const plan = () => {
      const { all, space, entity, ids } = context;
      const res = { ...entity('res', ids.hotel) };
      return planMove({
        res,
        source: { currency: 'EUR', files: all(space, 'file'), exps: all(space, 'exp'), visits: all(space, 'visit'), reservations: all(space, 'res'), places: all(space, 'place'), guests: [], days: all(space, 'day'), can: () => true },
        target: { currency: 'EUR', members: [OWNER, BOB], guests: [], places: [], days: all(target, 'day'), can: () => true },
        options: { copyFiles: true, moveExpenses: true },
      });
    };
    return { ...context, target, day, commit, copyFile, journal, plan, failSource: (count) => { failSource = count; } };
  }

  it('copies the booking, its place, file and sole expense, then removes it from the source', async () => {
    const { space, target, day, ids, entity, all, commit, copyFile, journal, plan } = await twoTrips();
    const planned = plan();
    const entry = moveEntry({ plan: planned, from: ref(space), to: ref(target), toTitle: 'Porto', title: 'Hotel Sol' });
    await journal.put(entry);
    const stages = [];
    const result = await runMove(entry, { journal, commit, copyFile, onStage: (stage) => stages.push(stage) });
    expect(result.status).toBe('done');
    expect(stages).toEqual(['target', 'files', 'source']);
    expect(await journal.list()).toEqual([]);
    const copy = entity('res', planned.resId, target);
    expect(copy).toMatchObject({ title: 'Hotel Sol', placeId: planned.place.id, people: [OWNER, BOB], stay: { checkInFrom: '15:00', fromDayId: day } });
    expect(all(target, 'place')).toHaveLength(1);
    expect(all(target, 'exp')).toEqual([expect.objectContaining({ name: 'Hotel', links: [{ t: 'res', id: planned.resId }] })]);
    expect(all(target, 'file')[0].links).toEqual([{ t: 'res', id: planned.resId }]);
    expect(entity('res', ids.hotel)).toMatchObject({ deleted: true });
    expect(entity('exp', ids.sole)).toMatchObject({ deleted: true });
    expect(entity('exp', ids.shared).links).toEqual([{ t: 'place', id: ids.place }]);
    expect(entity('file', ids.file).links).toEqual([{ t: 'place', id: ids.place }]);
  });

  it('keeps the journal when the source step fails, finishes on retry without duplicating, or undoes', async () => {
    const { space, target, ids, entity, all, commit, copyFile, journal, plan, failSource } = await twoTrips();
    const entry = moveEntry({ plan: plan(), from: ref(space), to: ref(target), toTitle: 'Porto', title: 'Hotel Sol' });
    await journal.put(entry);
    failSource(1);
    await expect(runMove(entry, { journal, commit, copyFile })).rejects.toMatchObject({ code: 'source_pending' });
    const [pending] = await journal.list();
    expect(pending).toMatchObject({ stage: 'source', error: 'network' });
    expect(entity('res', ids.hotel).deleted).toBeUndefined();
    expect(all(target, 'res')).toHaveLength(1);

    // Retrying from the start re-sends the target commit with the same op ids: no second copy.
    await expect(runMove({ ...pending, stage: 'target' }, { journal, commit, copyFile: () => { throw new Error('not again'); } })).resolves.toMatchObject({ status: 'done' });
    expect(all(target, 'res')).toHaveLength(1);
    expect(entity('res', ids.hotel)).toMatchObject({ deleted: true });
  });

  it('undoes an unfinished move only while the source still has the booking', async () => {
    const { space, target, ids, entity, all, commit, copyFile, journal, plan, failSource } = await twoTrips();
    const entry = moveEntry({ plan: plan(), from: ref(space), to: ref(target), toTitle: 'Porto', title: 'Hotel Sol' });
    await journal.put(entry);
    failSource(1);
    await runMove(entry, { journal, commit, copyFile }).catch(() => {});
    const [pending] = await journal.list();
    const trashed = [];
    const sourceHas = async () => !entity('res', ids.hotel).deleted;
    expect(await undoMove(pending, { journal, commit, trash: async (fileId) => trashed.push(fileId), sourceHas })).toMatchObject({ status: 'undone' });
    expect(all(target, 'res')).toEqual([]);
    expect(all(target, 'exp')).toEqual([]);
    expect(trashed).toHaveLength(1);
    expect(entity('res', ids.hotel).deleted).toBeUndefined();
    expect(await journal.list()).toEqual([]);
  });

  it('refreshes the copy when the booking changed after it was made', async () => {
    const { space, target, ids, entity, aliceOps, commit, copyFile, journal, plan } = await twoTrips();
    const planned = plan();
    const entry = moveEntry({ plan: planned, from: ref(space), to: ref(target), toTitle: 'Porto', title: 'Hotel Sol' });
    await journal.put(entry);
    await aliceOps([set('res', ids.hotel, { status: 'pending', code: 'ABC123' })]);
    await expect(runMove(entry, { journal, commit, copyFile })).resolves.toMatchObject({ status: 'done' });
    expect(entity('res', planned.resId, target)).toMatchObject({ status: 'pending', code: 'ABC123', placeId: planned.place.id });
    expect(entity('res', ids.hotel)).toMatchObject({ deleted: true });
  });
});
