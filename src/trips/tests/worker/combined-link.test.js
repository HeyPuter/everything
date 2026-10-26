// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ROAD_PREFS_ID } from '../../src/shared/schema/trip.js';
import { K } from '../../worker/keys.js';
import { ORIGIN, USERS, createHarness, expectError, id } from './harness.js';

const anonymous = async (h, path) => (await h.client('dave')).puter.workers.exec(ORIGIN + path, { headers: { 'x-puter-no-auth': '1' } });
const JOURNEY = { w: 'trips-bcdefghijk', s: '0000000000000001', token: 'd'.repeat(32) };

async function setup() {
  const h = await createHarness({ ownerVerified: false });
  const space = await h.team({ bob: 'editor' });
  const alice = (await h.client('alice')).in(space);
  const [day, visit, next, place, via, end, track] = ['d', 'v', 'v', 'p', 'w', 'n', 't'].map((prefix) => id(prefix));
  await alice.call('commit', { ops: [
    { opId: id('o'), t: 'meta', id: 'meta', set: { 'settings.addons.roadtrip': true } },
    { opId: id('o'), t: 'day', id: day, put: { date: '2027-05-01', order: 'a' } },
    { opId: id('o'), t: 'place', id: place, put: { name: 'Sintra', lat: 38.8, lng: -9.39 } },
    { opId: id('o'), t: 'visit', id: visit, put: { dayId: day, placeId: place, order: 'a' } },
    { opId: id('o'), t: 'visit', id: next, put: { dayId: day, placeId: place, order: 'b' } },
    { opId: id('o'), t: 'rtPrefs', id: ROAD_PREFS_ID, put: { fuel: 'electric', range: 400, start: '08:00', end: '19:00' } },
    { opId: id('o'), t: 'via', id: via, put: { dayId: day, after: visit, order: 'a', lat: 38.9, lng: -9.2 } },
    { opId: id('o'), t: 'dayEnd', id: end, put: { day, fromVisit: visit, toVisit: next, fraction: 0.5 } },
    { opId: id('o'), t: 'dayTrack', id: track, put: { dayId: day, placeId: place, strayKm: 1 } },
  ] });
  return { h, space, alice, bob: (await h.client('bob')).in(space) };
}
const types = (view) => [...new Set(view.ents.map((entity) => entity.t))].sort();

describe('road trip in the public link', () => {
  it('adds the road trip with the plan, and drops route points without the map', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('share.set', { on: true, plan: true, map: true, road: true });
    h.advance(121_000);
    const view = await (await anonymous(h, `/pub/${space}/${token}`)).json();
    expect(view.share.road).toBe(true);
    expect(types(view)).toEqual(['dayEnd', 'place', 'rtPrefs', 'via', 'visit', 'day'].sort());
    expect(view.meta.settings).toEqual({ addons: { roadtrip: true } });
    await alice.call('share.set', { map: false });
    h.advance(31_000);
    const plain = await (await anonymous(h, `/pub/${space}/${token}`)).json();
    expect(types(plain)).not.toContain('via');
    expect(types(plain)).toContain('rtPrefs');
    expect(JSON.stringify(plain)).not.toContain('dayTrack');
  });

  it('needs the plan and its own toggle', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('share.set', { on: true, plan: false, bookings: true, road: true });
    h.advance(121_000);
    const view = await (await anonymous(h, `/pub/${space}/${token}`)).json();
    expect(view.share.road).toBe(false);
    expect(types(view)).not.toContain('rtPrefs');
    expect(view.meta.settings).toBeUndefined();
  });
});

describe('journey in the public link', () => {
  it('keeps the journey link secret from members and hands it to visitors', async () => {
    const { h, space, alice } = await setup();
    const { token, share } = await alice.call('share.set', { on: true, plan: true, journey: JOURNEY });
    expect(share.journey).toBe(true);
    expect(h.kv()[K.secrets(space)].journeyLink).toEqual(JOURNEY);
    expect(JSON.stringify(h.kv()[K.entity(space, 'meta', 'meta')])).not.toContain(JOURNEY.token);
    h.advance(121_000);
    const view = await (await anonymous(h, `/pub/${space}/${token}`)).json();
    expect(view.journey).toEqual(JOURNEY);
    const cleared = await alice.call('share.set', { journey: null });
    expect(cleared.share.journey).toBe(false);
    expect(h.kv()[K.secrets(space)].journeyLink).toBeNull();
    h.advance(31_000);
    expect((await (await anonymous(h, `/pub/${space}/${token}`)).json()).journey).toBeUndefined();
  });

  it('validates the link and needs share.manage', async () => {
    const { alice, bob } = await setup();
    await expectError(alice.call('share.set', { journey: { ...JOURNEY, w: 'evil.example' } }), 400, 'invalid_share');
    await expectError(alice.call('share.set', { journey: { ...JOURNEY, token: 'short' } }), 400, 'invalid_share');
    await expectError(bob.call('share.set', { journey: JOURNEY }), 403, 'forbidden');
  });

  it('writes the link with the other secrets in one update', async () => {
    const { h, alice } = await setup();
    await alice.call('share.set', { on: true, plan: true });
    h.world.resetCounters();
    await alice.call('share.set', { journey: JOURNEY });
    expect(h.world.counters().byUser[USERS.alice.uuid]?.calls?.['kv.update'] ?? 0).toBeLessThanOrEqual(2);
  });
});
