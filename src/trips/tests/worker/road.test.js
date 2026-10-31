// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ROAD_PREFS_ID } from '../../src/shared/schema/trip.js';
import { USERS, createHarness, expectError, id } from './harness.js';

const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields) => ({ opId: id('o'), t, id: eid, set: fields });
const OWNER = USERS.alice.uuid;
const owner = (h) => h.world.counters().byUser[OWNER]?.calls ?? {};

async function setup() {
  const h = await createHarness();
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const clients = Object.fromEntries(await Promise.all(['alice', 'bob', 'carol'].map(async (name) => [name, await h.client(name)])));
  const as = (name) => (ops) => clients[name].in(space).call('commit', { ops });
  return { h, alice: as('alice'), bob: as('bob'), carol: as('carol') };
}

describe('road trip settings', () => {
  it('lets editors write the one settings entity and keeps viewers out', async () => {
    const { bob, carol } = await setup();
    const fields = { fuel: 'electric', battery: 77, use: 17.5, stint: 120, avoid: ['toll'], price: '0.45', currency: 'EUR' };
    await expectError(carol([put('rtPrefs', fields, ROAD_PREFS_ID)]), 403, 'forbidden');
    expect((await bob([put('rtPrefs', fields, ROAD_PREFS_ID)])).ents[0]).toMatchObject(fields);
    const patched = await bob([set('rtPrefs', ROAD_PREFS_ID, { [`dayAvoid.${id('d')}`]: ['motorway'], stint: 90 })]);
    expect(patched.ents[0].stint).toBe(90);
    await expectError(carol([set('rtPrefs', ROAD_PREFS_ID, { stint: 60 })]), 403, 'forbidden');
  });

  it('refuses other ids, bad values and a second create', async () => {
    const { alice } = await setup();
    await expectError(alice([put('rtPrefs', { fuel: 'petrol' })]), 400, 'invalid_road_prefs');
    await expectError(alice([put('rtPrefs', { fuel: 'diesel' }, ROAD_PREFS_ID)]), 400);
    await expectError(alice([put('rtPrefs', { avoid: ['tolls'] }, ROAD_PREFS_ID)]), 400);
    await expectError(alice([put('rtPrefs', { price: '1,79' }, ROAD_PREFS_ID)]), 400);
    await alice([put('rtPrefs', { fuel: 'petrol' }, ROAD_PREFS_ID)]);
    await expectError(alice([put('rtPrefs', { fuel: 'electric' }, ROAD_PREFS_ID)]), 409, 'already_exists');
  });

  it('is idempotent per op and costs one entity write', async () => {
    const { h, bob } = await setup();
    const op = put('rtPrefs', { stint: 100 }, ROAD_PREFS_ID);
    const first = await bob([op]);
    h.world.resetCounters();
    expect((await bob([op])).done[op.opId]).toBe(first.rev);
    expect(owner(h)['kv.update'] ?? 0).toBe(0);
    h.world.resetCounters();
    await bob([set('rtPrefs', ROAD_PREFS_ID, { stint: 110 })]);
    expect(owner(h)['kv.update']).toBe(1);
  });
});

describe('day ends and route points', () => {
  it('lets editors place them and refuses a leg from a stop to itself', async () => {
    const { bob, carol } = await setup();
    const [day, a, b] = [id('d'), id('v'), id('v')];
    await expectError(carol([put('dayEnd', { day, fromVisit: a, toVisit: b, fraction: 0.5 })]), 403, 'forbidden');
    const end = id('e');
    expect((await bob([put('dayEnd', { day, fromVisit: a, toVisit: b, fraction: 0.5 }, end)])).ents[0].fraction).toBe(0.5);
    await expectError(bob([put('dayEnd', { day, fromVisit: a, toVisit: a, fraction: 0.5 })]), 400, 'invalid_day_end');
    await expectError(bob([set('dayEnd', end, { toVisit: a })]), 400, 'invalid_day_end');
    await expectError(bob([set('dayEnd', end, { fraction: 1.5 })]), 400);
    expect((await bob([put('via', { dayId: day, after: a, order: 'a', lat: 45, lng: 7 })])).ents[0]).toMatchObject({ lat: 45, lng: 7 });
    await expectError(bob([put('via', { dayId: day, after: day, order: 'a', lat: 45, lng: 7 })]), 400, 'invalid_via');
  });
});
