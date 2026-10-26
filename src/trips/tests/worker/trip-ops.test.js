// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { K } from '../../worker/keys.js';
import { USERS, createHarness, expectError, id } from './harness.js';

const OWNER = USERS.alice.uuid;
const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields) => ({ opId: id('o'), t, id: eid, set: fields });

/** A four-day trip (1–4 May) with Bob as editor and Carol as viewer, one visit and note on the last day and a stay. */
async function setup() {
  const h = await createHarness();
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => h.client(name)));
  const as = (client) => (ops) => client.in(space).call('commit', { ops });
  const days = ['a', 'b', 'c', 'd'].map((order, i) => ({ id: id('d'), order, date: `2027-05-0${i + 1}` }));
  await as(alice)(days.map((day) => put('day', { order: day.order, date: day.date }, day.id)));
  const visit = id('v'); const note = id('n'); const stay = id('r');
  await as(alice)([
    put('visit', { dayId: days[3].id, placeId: null, order: 'a', title: 'Walk' }, visit),
    put('dayNote', { dayId: days[3].id, order: 'a', title: 'Pack' }, note),
    put('res', { type: 'lodging', title: 'Inn', status: 'confirmed', stay: { fromDayId: days[2].id, toDayId: days[3].id } }, stay),
  ]);
  const redate = (target, extra = {}) => ({ opId: id('o'), do: 'trip.redate', args: { ...target, days: days.map((day) => day.id), visits: [visit], notes: [note], res: [stay], ...extra } });
  return { h, space, days, visit, note, stay, alice: as(alice), bob: as(bob), carol: as(carol), redate };
}
const entity = (h, space, t, eid) => h.kv()[K.entity(space, t, eid)];

describe('trip meta hook', () => {
  it('refuses blank titles and duplicate tags or reminders', async () => {
    const { alice } = await setup();
    await expectError(alice([set('meta', 'meta', { title: '   ' })]), 400);
    await expectError(alice([set('meta', 'meta', { tags: ['Beach', ' beach'] })]), 400, 'invalid_tags');
    await expectError(alice([set('meta', 'meta', { reminderDays: [1, 1] })]), 400, 'invalid_reminders');
    const result = await alice([set('meta', 'meta', { tags: ['Beach', 'Family'], reminderDays: [1, 7], archived: true })]);
    expect(result.ents[0]).toMatchObject({ t: 'meta', tags: ['Beach', 'Family'], archived: true });
  });

  it('runs at space creation', async () => {
    const h = await createHarness();
    const alice = await h.client('alice');
    await expectError(alice.call('space.create', { kind: 'trip', meta: { title: 'Trip', currency: 'EUR', tags: ['a', 'A'] } }), 400, 'invalid_tags');
  });
});

describe('trip.redate', () => {
  it('needs trip.edit (owner by default, editors when allowed) and refuses viewers', async () => {
    const { h, alice, bob, carol, redate } = await setup();
    await expectError(carol([redate({ start: '2027-05-02', end: '2027-05-05' })]), 403, 'forbidden');
    await expectError(bob([redate({ start: '2027-05-02', end: '2027-05-05' })]), 403, 'forbidden');
    await alice([set('meta', 'meta', { perms: { 'trip.edit': 'editor' } })]);
    h.advance(6000);
    const result = await bob([redate({ start: '2027-05-02', end: '2027-05-05' })]);
    expect(result.ents.find((item) => item.t === 'meta')).toMatchObject({ start: '2027-05-02', end: '2027-05-05' });
  });

  it('validates its arguments', async () => {
    const { alice, redate } = await setup();
    await expectError(alice([redate({ start: '2027-05-01', end: '2031-01-01' })]), 400, 'invalid_date_range');
    await expectError(alice([redate({ start: 'May', end: '2027-05-03' })]), 400, 'invalid_args');
    await expectError(alice([redate({ dayCount: 0 })]), 400, 'invalid_args');
    await expectError(alice([redate({ start: '2027-05-01', end: '2027-05-03' }, { bookings: 'later' })]), 400, 'invalid_args');
    await expectError(alice([redate({ start: '2027-05-01', end: '2027-05-03' }, { extra: true })]), 400, 'invalid_args');
    // Extending needs a new id per new day.
    await expectError(alice([redate({ start: '2027-05-01', end: '2027-05-06' })]), 400, 'invalid_args');
  });

  it('shrinks with its impact: drops days, their visits and notes, and cancels stays touching them', async () => {
    const { h, space, days, visit, note, stay, alice, redate } = await setup();
    const result = await alice([redate({ start: '2027-05-01', end: '2027-05-03' })]);
    expect(result.del.map((item) => item.id).sort()).toEqual([days[3].id, visit, note].sort());
    expect(entity(h, space, 'day', days[3].id)).toMatchObject({ deleted: true });
    expect(entity(h, space, 'res', stay)).toMatchObject({ status: 'cancelled', stay: { fromDayId: days[2].id } });
    expect(entity(h, space, 'meta', 'meta')).toMatchObject({ start: '2027-05-01', end: '2027-05-03' });
  });

  it('extends with client ids and is idempotent per op id', async () => {
    const { h, space, alice, redate } = await setup();
    const fresh = [id('d'), id('d')];
    const op = redate({ start: '2027-05-01', end: '2027-05-06' }, { newIds: { day: fresh } });
    const first = await alice([op]);
    const again = await alice([op]);
    expect(again.rev).toBe(first.rev);
    expect(entity(h, space, 'day', fresh[0])).toMatchObject({ date: '2027-05-05' });
    expect(entity(h, space, 'day', fresh[1])).toMatchObject({ date: '2027-05-06' });
    await expectError(alice([redate({ start: '2027-04-29', end: '2027-05-06' }, { newIds: { day: [fresh[0], id('d')] } })]), 409, 'already_exists');
  });

  it('costs one batched read and one change for the whole re-date', async () => {
    const { h, alice, redate } = await setup();
    await alice([redate({ start: '2027-05-02', end: '2027-05-05' })]);
    h.advance(10_000);
    h.world.resetCounters();
    await alice([redate({ start: '2027-05-03', end: '2027-05-06' }, { bookings: 'shift' })]);
    const calls = h.world.counters().byUser[OWNER]?.calls ?? {};
    expect(calls['kv.get']).toBeLessThanOrEqual(2);
    expect(calls['kv.incr']).toBe(1);
  });
});
