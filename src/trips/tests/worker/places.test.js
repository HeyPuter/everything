// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CAT_ICONS as WORKER_ICONS } from '../../worker/ops/trip/cat.js';
import { CAT_ICONS } from '../../src/lib/categories.js';
import { USERS, createHarness, expectError, id } from './harness.js';

const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields) => ({ opId: id('o'), t, id: eid, set: fields });
const unset = (t, eid, paths) => ({ opId: id('o'), t, id: eid, unset: paths });
const OWNER = USERS.alice.uuid;
const kvCalls = (h) => Object.entries(h.world.counters().byUser[OWNER]?.calls ?? {}).filter(([method]) => method.startsWith('kv.') && method !== 'kv.share').reduce((n, [, count]) => n + count, 0);

async function setup() {
  const h = await createHarness();
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [bob, carol] = await Promise.all(['bob', 'carol'].map((name) => h.client(name)));
  const as = (client) => (ops) => client.in(space).call('commit', { ops });
  return { h, space, bob: as(bob), carol: as(carol) };
}

describe('place rules', () => {
  it('needs plan.edit to create, edit or delete, but lets any member write their own rating, tags and visited flag', async () => {
    const { bob, carol } = await setup();
    const place = id('p');
    await expectError(carol([put('place', { name: 'Belém Tower' })]), 403, 'forbidden');
    await bob([put('place', { name: 'Belém Tower', lat: 38.6916, lng: -9.216, cat: 'attraction' }, place)]);
    await expectError(carol([set('place', place, { notes: 'Go early' })]), 403, 'forbidden');
    await expectError(carol([{ opId: id('o'), t: 'place', id: place, del: true }]), 403, 'forbidden');
    const mine = await carol([set('place', place, { [`rating.${USERS.carol.uuid}`]: 5, [`tags.${USERS.carol.uuid}`]: ['Views'], [`visited.${USERS.carol.uuid}`]: true })]);
    expect(mine.ents[0]).toMatchObject({ rating: { [USERS.carol.uuid]: 5 }, tags: { [USERS.carol.uuid]: ['Views'] }, visited: { [USERS.carol.uuid]: true } });
    await expectError(carol([set('place', place, { [`tags.${USERS.bob.uuid}`]: ['Mine now'] })]), 403, 'forbidden');
    await expectError(bob([put('place', { name: 'Seeded', rating: { [USERS.carol.uuid]: 1 } })]), 403, 'forbidden');
  });

  it('rejects negative prices and duplicate or blank tags', async () => {
    const { bob } = await setup();
    const place = id('p');
    await expectError(bob([put('place', { name: 'Market', price: { amount: -100, currency: 'EUR' } })]), 400, 'invalid_price');
    await bob([put('place', { name: 'Market', price: { amount: 450, currency: 'EUR' } }, place)]);
    await expectError(bob([set('place', place, { [`tags.${USERS.bob.uuid}`]: ['Food', 'food '] })]), 400, 'duplicate_tag');
    await expectError(bob([set('place', place, { [`tags.${USERS.bob.uuid}`]: ['  '] })]), 400);
    await expectError(bob([set('place', place, { lat: 91, lng: 0 })]), 400);
    const ok = await bob([set('place', place, { [`tags.${USERS.bob.uuid}`]: ['Food', 'Cheap'], notes: 'Cash only' })]);
    expect(ok.ents[0]).toMatchObject({ notes: 'Cash only', tags: { [USERS.bob.uuid]: ['Food', 'Cheap'] } });
    expect((await bob([unset('place', place, ['price', `tags.${USERS.bob.uuid}`])])).ents[0]).not.toHaveProperty('price');
  });

  it('is idempotent per op id and costs one batched read plus the commit writes', async () => {
    const { h, bob } = await setup();
    const op = put('place', { name: 'Time Out Market', lat: 38.7069, lng: -9.1459 });
    await bob([put('place', { name: 'Warm-up' })]);
    h.world.resetCounters();
    const first = await bob([op]);
    // 1 batched get, the rev claim, the entity, the change record, the op id, the signal and the counter.
    expect(kvCalls(h)).toBeLessThanOrEqual(8);
    const writes = h.world.counters().calls['kv.set'];
    const again = await bob([op]);
    expect(again).toMatchObject({ rev: first.rev, done: first.done });
    expect(h.world.counters().calls['kv.set']).toBe(writes);
  });
});

describe('trip category rules', () => {
  it('needs plan.edit and keeps names short, colors in the day palette and icons drawable', async () => {
    const { bob, carol } = await setup();
    const cat = id('c');
    await expectError(carol([put('cat', { name: 'Street food', color: 3, icon: 'utensils' })]), 403, 'forbidden');
    await expectError(bob([put('cat', { name: 'x'.repeat(101), color: 3, icon: 'utensils' })]), 400, 'name_too_long');
    await expectError(bob([put('cat', { name: 'Street food', color: '#ff0000', icon: 'utensils' })]), 400, 'invalid_color');
    await expectError(bob([put('cat', { name: 'Street food', color: 9, icon: 'utensils' })]), 400);
    await expectError(bob([put('cat', { name: 'Street food', color: 3, icon: 'skull' })]), 400, 'invalid_icon');
    await bob([put('cat', { name: 'Street food', color: 3, icon: 'utensils' }, cat)]);
    await expectError(bob([set('cat', cat, { icon: 'rocket' })]), 400, 'invalid_icon');
    expect((await bob([set('cat', cat, { name: 'Snacks', color: 8 })])).ents[0]).toMatchObject({ name: 'Snacks', color: 8, icon: 'utensils' });
    await expectError(carol([{ opId: id('o'), t: 'cat', id: cat, del: true }]), 403, 'forbidden');
    expect((await bob([{ opId: id('o'), t: 'cat', id: cat, del: true }])).del).toEqual([expect.objectContaining({ t: 'cat', id: cat })]);
  });

  it('accepts exactly the icons the client offers', () => {
    expect([...WORKER_ICONS].sort()).toEqual([...CAT_ICONS].sort());
  });
});
