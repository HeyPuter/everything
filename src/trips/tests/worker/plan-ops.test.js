// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { K } from '../../worker/keys.js';
import { USERS, WORKER, createHarness, expectError, id } from './harness.js';

const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields) => ({ opId: id('o'), t, id: eid, set: fields });
const domain = (name, args) => ({ opId: id('o'), do: name, args });
const OWNER = USERS.alice.uuid;
const owner = (h) => h.world.counters().byUser[OWNER]?.calls ?? {};

async function setup() {
  const h = await createHarness();
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => h.client(name)));
  const as = (client) => (ops) => client.in(space).call('commit', { ops });
  const days = ['2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04'].map((date, index) => ({ id: id('d'), date, order: `a${index + 1}` }));
  await as(alice)(days.map((day) => put('day', { order: day.order, date: day.date }, day.id)));
  const entity = (t, eid) => h.kv()[K.entity(space, t, eid)];
  return { h, space, days, entity, alice: as(alice), bob: as(bob), carol: as(carol) };
}

describe('visit hook', () => {
  it('refuses an end day equal to the start day and repeated participants', async () => {
    const { bob, days } = await setup();
    const visit = { dayId: days[0].id, placeId: null, order: 'a', title: 'Walk' };
    await expectError(bob([put('visit', { ...visit, endDayId: days[0].id })]), 400, 'invalid_end_day');
    await expectError(bob([put('visit', { ...visit, people: [USERS.bob.uuid, USERS.bob.uuid] })]), 400, 'duplicate_people');
    const ok = id('v');
    await bob([put('visit', { ...visit, endDayId: days[1].id }, ok)]);
    await expectError(bob([set('visit', ok, { dayId: days[1].id })]), 400, 'invalid_end_day');
  });
});

describe('visit.move', () => {
  it('moves a visit to a live day for editors only, and is idempotent per op', async () => {
    const { h, bob, carol, days, entity } = await setup();
    const visit = id('v');
    await bob([put('visit', { dayId: days[0].id, placeId: null, order: 'a', title: 'Walk', endDayId: days[2].id }, visit)]);
    await expectError(carol([domain('visit.move', { visit, day: days[1].id, order: 'b' })]), 403, 'forbidden');
    const op = domain('visit.move', { visit, day: days[2].id, order: 'b' });
    const first = await bob([op]);
    expect(entity('visit', visit)).toMatchObject({ dayId: days[2].id, order: 'b' });
    expect(entity('visit', visit)).not.toHaveProperty('endDayId');
    h.world.resetCounters();
    expect((await bob([op])).done[op.opId]).toBe(first.rev);
    expect(owner(h)['kv.update'] ?? 0).toBe(0);
  });

  it('rejects bad arguments, gone visits and gone days', async () => {
    const { bob, alice, days } = await setup();
    const visit = id('v');
    await bob([put('visit', { dayId: days[0].id, placeId: null, order: 'a', title: 'Walk' }, visit)]);
    await expectError(bob([domain('visit.move', { visit, day: days[1].id, order: '' })]), 400, 'invalid_args');
    await expectError(bob([domain('visit.move', { visit, day: days[1].id, order: 'b', extra: 1 })]), 400, 'invalid_args');
    await expectError(bob([domain('visit.move', { visit: id('v'), day: days[1].id, order: 'b' })]), 409, 'gone');
    await alice([{ opId: id('o'), t: 'day', id: days[3].id, del: true }]);
    await expectError(bob([domain('visit.move', { visit, day: days[3].id, order: 'b' })]), 409, 'gone');
  });

  it('costs one batched read and one entity write', async () => {
    const { h, bob, days } = await setup();
    const visit = id('v');
    await bob([put('visit', { dayId: days[0].id, placeId: null, order: 'a', title: 'Walk' }, visit)]);
    h.world.resetCounters();
    await bob([domain('visit.move', { visit, day: days[1].id, order: 'b' })]);
    expect(owner(h)['kv.get']).toBe(1);
    expect(owner(h)['kv.update']).toBe(1);
  });
});

describe('day.remove', () => {
  async function seeded() {
    const context = await setup();
    const { alice, days } = context;
    const [d1, d2, d3, d4] = days;
    const ids = { visit: id('v'), span: id('v'), note: id('n'), flight: id('r'), edge: id('r'), across: id('r'), exp: id('e'), other: id('e') };
    await alice([
      put('visit', { dayId: d2.id, placeId: null, order: 'a', title: 'Museum' }, ids.visit),
      put('visit', { dayId: d1.id, placeId: null, order: 'b', title: 'Hike', endDayId: d2.id }, ids.span),
      put('dayNote', { dayId: d2.id, order: 'c', title: 'Rest' }, ids.note),
      put('res', { type: 'flight', title: 'TP1', status: 'confirmed', start: { date: '2027-05-02', time: '09:00' }, dayPos: { [d2.id]: 'b' } }, ids.flight),
      put('res', { type: 'lodging', title: 'Inn', status: 'confirmed', start: { date: '2027-05-01' }, end: { date: '2027-05-02' } }, ids.edge),
      put('res', { type: 'lodging', title: 'Hotel', status: 'confirmed', start: { date: '2027-05-01' }, end: { date: '2027-05-04' } }, ids.across),
      put('exp', { name: 'Inn', amount: 100, currency: 'EUR', payers: [], split: { mode: 'equal', parts: [{ who: OWNER }] }, links: [{ t: 'res', id: ids.edge }] }, ids.exp),
      put('exp', { name: 'Taxi', amount: 100, currency: 'EUR', payers: [], split: { mode: 'equal', parts: [{ who: OWNER }] } }, ids.other),
    ]);
    const args = { day: d2.id, visits: [ids.visit, ids.span], notes: [ids.note], res: [ids.flight, ids.edge, ids.across], days: [d3.id, d4.id], exps: [ids.exp, ids.other] };
    return { ...context, ids, args, d1, d2, d3, d4 };
  }

  it('applies the impact rules and shifts later days and the trip end', async () => {
    const { alice, entity, ids, args, d2, d3, d4 } = await seeded();
    await alice([domain('day.remove', args)]);
    expect(entity('day', d2.id)).toMatchObject({ deleted: true });
    expect(entity('visit', ids.visit)).toMatchObject({ deleted: true });
    expect(entity('visit', ids.span)).not.toHaveProperty('endDayId');
    expect(entity('dayNote', ids.note)).toMatchObject({ deleted: true });
    expect(entity('res', ids.flight).dayPos).toEqual({});
    expect(entity('res', ids.edge)).toMatchObject({ status: 'cancelled' });
    expect(entity('res', ids.across)).toMatchObject({ status: 'confirmed', end: { date: '2027-05-03' } });
    expect(entity('exp', ids.exp)).toMatchObject({ deleted: true });
    expect(entity('exp', ids.other)).toMatchObject({ name: 'Taxi' });
    expect([entity('day', d3.id).date, entity('day', d4.id).date]).toEqual(['2027-05-02', '2027-05-03']);
    expect(entity('meta', 'meta')).toMatchObject({ start: '2027-05-01', end: '2027-05-03' });
  });

  it('needs plan.edit (also for the trip end it moves) and res.edit when bookings change', async () => {
    const { h, alice, bob, carol, entity, args, d3 } = await seeded();
    await expectError(carol([domain('day.remove', args)]), 403, 'forbidden');
    await bob([domain('day.remove', args)]);
    expect(entity('meta', 'meta').end).toBe('2027-05-03');
    expect(entity('day', d3.id).date).toBe('2027-05-02');
    const undated = id('d');
    await alice([put('day', { order: 'z', date: null }, undated), set('meta', 'meta', { perms: { 'res.edit': 'owner' } })]);
    h.advance(6000);
    const train = id('r');
    await alice([put('res', { type: 'train', title: 'IC', status: 'confirmed', dayPos: { [undated]: 'a' } }, train)]);
    await expectError(bob([domain('day.remove', { day: undated, res: [train] })]), 403, 'forbidden');
    await bob([domain('day.remove', { day: undated })]);
    expect(entity('day', undated)).toMatchObject({ deleted: true });
    expect(entity('meta', 'meta').end).toBe('2027-05-03');
  });

  it('drops file and expense links to the visits it deletes, as far as the caller may edit them', async () => {
    const { h, space, alice, entity, ids, args } = await seeded();
    const client = await h.client('alice');
    const file = id('f');
    await client.api.upload({ w: WORKER, s: space, k: 'trip' }, file, new Blob([new TextEncoder().encode('%PDF-1.7\n...')]));
    await client.in(space).call('file.put', { fileId: file, name: 'ticket.pdf', mime: 'application/pdf', sha256: 'b'.repeat(64), kind: 'user' });
    const lunch = id('e');
    await alice([
      set('file', file, { links: [{ t: 'visit', id: ids.visit }, { t: 'res', id: ids.flight }] }),
      put('exp', { name: 'Tickets', amount: 100, currency: 'EUR', payers: [], split: { mode: 'equal', parts: [{ who: OWNER }] }, links: [{ t: 'visit', id: ids.visit }] }, lunch),
      set('exp', ids.other, { links: [{ t: 'visit', id: ids.span }] }),
    ]);
    await alice([domain('day.remove', { ...args, exps: [], files: [file], unlink: [lunch, ids.other] })]);
    expect(entity('file', file).links).toEqual([{ t: 'res', id: ids.flight }]);
    expect(entity('exp', lunch)).not.toHaveProperty('links');
    // The spanning visit only loses its end day, so its links stay.
    expect(entity('exp', ids.other).links).toEqual([{ t: 'visit', id: ids.span }]);
  });

  it('keeps links an editor may not change and reads stay days from the listed days', async () => {
    const { h, alice, bob, entity, ids, args, d1, d3 } = await seeded();
    const tickets = id('e');
    const stay = id('r');
    await alice([
      put('exp', { name: 'Tickets', amount: 100, currency: 'EUR', payers: [], split: { mode: 'equal', parts: [{ who: OWNER }] }, links: [{ t: 'visit', id: ids.visit }] }, tickets),
      put('res', { type: 'lodging', title: 'Flat', status: 'confirmed', stay: { fromDayId: d1.id, toDayId: d3.id } }, stay),
      set('meta', 'meta', { perms: { 'costs.edit': 'owner' } }),
    ]);
    h.advance(6000);
    await bob([domain('day.remove', { day: args.day, visits: [ids.visit], res: [stay], days: [d1.id, d3.id], unlink: [tickets] })]);
    expect(entity('exp', tickets).links).toEqual([{ t: 'visit', id: ids.visit }]);
    // The removed day was a middle night of a stay placed by day ids: nothing to change.
    expect(entity('res', stay)).toMatchObject({ status: 'confirmed', stay: { fromDayId: d1.id, toDayId: d3.id } });
  });

  it('skips entities that no longer match the day and keeps unlisted expenses', async () => {
    const { alice, entity, ids, args, d1, d3 } = await seeded();
    await alice([set('visit', ids.visit, { dayId: d3.id })]);
    await alice([domain('day.remove', { ...args, exps: [] })]);
    expect(entity('visit', ids.visit)).toMatchObject({ dayId: d3.id, title: 'Museum' });
    expect(entity('exp', ids.exp)).toMatchObject({ name: 'Inn' });
    expect(entity('day', d1.id).date).toBe('2027-05-01');
  });

  it('validates arguments and caps reads, and replays a retried op', async () => {
    const { h, alice, args } = await seeded();
    await expectError(alice([domain('day.remove', { ...args, visits: ['nope'] })]), 400, 'invalid_args');
    await expectError(alice([domain('day.remove', { ...args, days: [args.day] })]), 400, 'invalid_args');
    await expectError(alice([domain('day.remove', { day: args.day, visits: Array.from({ length: 200 }, () => id('v')) })]), 413, 'day_too_large');
    const op = domain('day.remove', args);
    const first = await alice([op]);
    h.world.resetCounters();
    expect((await alice([op])).done[op.opId]).toBe(first.rev);
    expect(owner(h)['kv.update'] ?? 0).toBe(0);
  });

  it('costs one batched read for the whole impact', async () => {
    const { h, alice, args } = await seeded();
    h.world.resetCounters();
    await alice([domain('day.remove', args)]);
    // Plus one batched read of the records that held the deleted entities, which the delete scrubs.
    expect(owner(h)['kv.get']).toBe(2);
  });
});
