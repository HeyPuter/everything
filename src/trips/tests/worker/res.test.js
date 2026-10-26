// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { K } from '../../worker/keys.js';
import { USERS, createHarness, expectError, id } from './harness.js';

const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields, extra = {}) => ({ opId: id('o'), t, id: eid, set: fields, ...extra });
const owner = (h) => h.world.counters().byUser[USERS.alice.uuid]?.calls ?? {};

const leg = (from, to, date) => ({ from: { code: from, tz: 'Europe/Lisbon' }, to: { code: to, tz: 'Europe/Madrid' }, dep: { date, time: '08:00' }, arr: { date, time: '10:15' }, carrier: 'TAP', seat: '12A' });
const FLIGHT = { type: 'flight', title: 'LIS → MAD', status: 'confirmed', code: 'ABC123', legs: [leg('LIS', 'MAD', '2027-05-02'), leg('MAD', 'BCN', '2027-05-02')], start: { date: '2027-05-02', time: '08:00', tz: 'Europe/Lisbon' } };
const HOTEL = { type: 'lodging', title: 'Hotel', status: 'pending', start: { date: '2027-05-02' }, end: { date: '2027-05-04' }, stay: { checkInFrom: '15:00', checkOut: '11:00', fromDayId: '0000000000000001', toDayId: '0000000000000003' } };

async function setup(options = {}) {
  const h = await createHarness(options);
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => h.client(name)));
  const as = (client) => (ops) => client.in(space).call('commit', { ops });
  return { h, space, alice: as(alice), bob: as(bob), carol: as(carol) };
}

describe('res type rules', () => {
  it('lets editors write multi-leg transports and stays, and refuses viewers', async () => {
    const { bob, carol } = await setup();
    await expectError(carol([put('res', FLIGHT)]), 403, 'forbidden');
    const flight = await bob([put('res', FLIGHT)]);
    expect(flight.ents[0]).toMatchObject({ t: 'res', type: 'flight', legs: [{ seat: '12A' }, { to: { code: 'BCN' } }] });
    const hotel = await bob([put('res', HOTEL)]);
    expect(hotel.ents[0].stay).toEqual(HOTEL.stay);
    await expectError(carol([set('res', hotel.ents[0].id, { status: 'confirmed' })]), 403, 'forbidden');
  });

  it('follows the trip permission override for res.edit', async () => {
    const { h, alice, bob } = await setup();
    await alice([set('meta', 'meta', { perms: { 'res.edit': 'owner' } })]);
    h.advance(6000);
    await expectError(bob([put('res', FLIGHT)]), 403, 'forbidden');
    expect((await alice([put('res', FLIGHT)])).ents).toHaveLength(1);
  });

  it('rejects legs outside transports, stays outside lodging and self stay links', async () => {
    const { bob } = await setup();
    const op = put('res', { ...HOTEL, legs: FLIGHT.legs });
    const error = await expectError(bob([op]), 400, 'invalid_reservation');
    expect(error.op).toBe(op.opId);
    await expectError(bob([put('res', { ...FLIGHT, stay: { checkOut: '11:00' } })]), 400, 'invalid_reservation');
    await expectError(bob([put('res', { ...HOTEL, stay: { toDayId: '0000000000000003' } })]), 400, 'invalid_reservation');
    await expectError(bob([put('res', { ...HOTEL, stayId: id('r') })]), 400, 'invalid_reservation');
    const self = id('r');
    await expectError(bob([put('res', { type: 'restaurant', title: 'Dinner', status: 'pending', stayId: self }, self)]), 400, 'invalid_reservation');
  });

  it('checks the patched result, so a type change must drop the other type’s fields', async () => {
    const { bob } = await setup();
    const hotel = id('r');
    await bob([put('res', HOTEL, hotel)]);
    await expectError(bob([set('res', hotel, { type: 'flight' })]), 400, 'invalid_reservation');
    const result = await bob([{ opId: id('o'), t: 'res', id: hotel, set: { type: 'flight', legs: FLIGHT.legs }, unset: ['stay'] }]);
    expect(result.ents[0]).toMatchObject({ type: 'flight' });
    expect(result.ents[0]).not.toHaveProperty('stay');
  });

  it('acknowledges a retried create once', async () => {
    const { h, space, bob } = await setup();
    const op = put('res', FLIGHT);
    const first = await bob([op]);
    const again = await bob([op]);
    expect(again.done[op.opId]).toBe(first.rev);
    expect(again.rev).toBe(first.rev);
    expect(h.kv()[K.entity(space, 'res', op.id)]).toMatchObject({ title: FLIGHT.title, rev: first.rev });
  });

  it('adds no KV reads to a commit', async () => {
    const { h, bob } = await setup({ onlyIfAbsent: true });
    await bob([put('guest', { name: 'warm' })]);
    h.world.resetCounters();
    await bob([put('res', FLIGHT)]);
    const res = owner(h);
    h.world.resetCounters();
    await bob([put('guest', { name: 'G' })]);
    expect(res).toEqual(owner(h));
    expect(res['kv.get']).toBe(1);
  });
});
