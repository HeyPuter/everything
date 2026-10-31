// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { K } from '../../worker/keys.js';
import { orderKeys } from '../../src/shared/order.js';
import { USERS, createHarness, expectError, id } from './harness.js';

const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields) => ({ opId: id('o'), t, id: eid, set: fields });
const unset = (t, eid, paths) => ({ opId: id('o'), t, id: eid, unset: paths });
const OWNER = USERS.alice.uuid;

async function setup(options) {
  const h = await createHarness(options);
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const clients = Object.fromEntries(await Promise.all(['alice', 'bob', 'carol'].map(async (name) => [name, await h.client(name)])));
  const as = (name) => (ops) => clients[name].in(space).call('commit', { ops });
  return { h, space, alice: as('alice'), bob: as('bob'), carol: as('carol'), clients };
}

describe('lists permissions', () => {
  it('lets editors manage lists, bags, items and to-dos and keeps viewers read-only', async () => {
    const { bob, carol } = await setup();
    const samples = {
      listMeta: { kind: 'pack', name: 'Clothes', order: 'a', color: 1, assignees: [USERS.bob.uuid] },
      bag: { name: 'Carry-on', order: 'a', limitGrams: 7000, people: [USERS.bob.uuid] },
      pack: { name: 'Socks', order: 'a', list: 'Clothes', qty: 3, grams: 50, owner: USERS.bob.uuid },
      todo: { name: 'Book train', order: 'a', due: '2027-04-20', prio: 1, who: USERS.carol.uuid, desc: '**soon**' },
    };
    for (const [t, fields] of Object.entries(samples)) {
      await expectError(carol([put(t, fields)]), 403, 'forbidden');
      const eid = id(t);
      const result = await bob([put(t, fields, eid)]);
      expect(result.ents[0]).toMatchObject({ t, ...fields });
      await expectError(carol([set(t, eid, { name: 'Renamed' })]), 403, 'forbidden');
      await expectError(carol([{ opId: id('o'), t, id: eid, del: true }]), 403, 'forbidden');
    }
  });

  it('lets any member check per person and pledge, only for themselves', async () => {
    const { bob, carol } = await setup();
    const item = id('pack');
    await bob([put('pack', { name: 'Tent', order: 'a' }, item)]);
    const checked = await carol([set('pack', item, { [`doneBy.${USERS.carol.uuid}`]: true, [`bring.${USERS.carol.uuid}`]: 'maybe' })]);
    expect(checked.ents[0]).toMatchObject({ doneBy: { [USERS.carol.uuid]: true }, bring: { [USERS.carol.uuid]: 'maybe' } });
    await expectError(carol([set('pack', item, { [`doneBy.${USERS.bob.uuid}`]: true })]), 403, 'forbidden');
    await expectError(carol([set('pack', item, { done: true })]), 403, 'forbidden');
    const cleared = await carol([unset('pack', item, [`doneBy.${USERS.carol.uuid}`, `bring.${USERS.carol.uuid}`])]);
    expect(cleared.ents[0].doneBy).toEqual({});
    await expectError(bob([put('pack', { name: 'Stove', order: 'b', doneBy: { [USERS.carol.uuid]: true } })]), 403, 'forbidden');
  });

  it('respects a stricter lists.edit set by the owner', async () => {
    const { h, alice, bob } = await setup();
    await alice([set('meta', 'meta', { perms: { 'lists.edit': 'owner' } })]);
    h.advance(6000);
    await expectError(bob([put('todo', { name: 'X', order: 'a' })]), 403, 'forbidden');
    expect((await alice([put('todo', { name: 'X', order: 'a' })])).ents).toHaveLength(1);
  });
});

describe('lists validation', () => {
  it('keeps the packing owner to its creator and assigned items to named people', async () => {
    const { bob, alice } = await setup();
    await expectError(bob([put('pack', { name: 'Socks', order: 'a', owner: USERS.alice.uuid })]), 403, 'forbidden');
    const item = id('pack');
    await bob([put('pack', { name: 'Socks', order: 'a', owner: USERS.bob.uuid }, item)]);
    await expectError(alice([set('pack', item, { owner: USERS.alice.uuid })]), 403, 'forbidden');
    await expectError(alice([unset('pack', item, ['owner'])]), 403, 'forbidden');
    await expectError(bob([set('pack', item, { vis: 'people' })]), 400, 'invalid_visibility');
    await expectError(bob([set('pack', item, { vis: 'people', for: [USERS.bob.uuid, USERS.bob.uuid] })]), 400, 'invalid_people');
    expect((await bob([set('pack', item, { vis: 'people', for: [USERS.carol.uuid] })])).ents[0]).toMatchObject({ vis: 'people', for: [USERS.carol.uuid] });
    await expectError(bob([set('pack', item, { qty: 1.5 })]), 400, 'invalid_qty');
    await expectError(bob([set('pack', item, { name: '   ' })]), 400);
  });

  it('keeps a list kind and rejects blank names and repeated people', async () => {
    const { bob } = await setup();
    const list = id('list');
    await bob([put('listMeta', { kind: 'todo', name: 'Before', order: 'a' }, list)]);
    await expectError(bob([set('listMeta', list, { kind: 'pack' })]), 400, 'invalid_kind');
    await expectError(bob([set('listMeta', list, { assignees: [USERS.bob.uuid, USERS.bob.uuid] })]), 400, 'invalid_people');
    await expectError(bob([put('bag', { name: 'Duffel', order: 'a', people: [USERS.bob.uuid, USERS.bob.uuid] })]), 400, 'invalid_people');
    await expectError(bob([put('todo', { name: 'x', order: 'a', prio: 4 })]), 400);
    await expectError(bob([put('pack', { name: 'x', order: 'a', vis: 'private' })]), 400);
  });

  it('checks only the fields a patch touches, so older entities stay editable', async () => {
    const { h, space, bob, carol, clients } = await setup();
    const item = id('pack');
    await bob([put('pack', { name: 'Rope', order: 'a' }, item)]);
    const key = K.entity(space, 'pack', item);
    // Written before the integer-quantity rule.
    await clients.alice.puter.kv.set(key, { ...h.kv()[key], qty: 2.5 });
    expect((await carol([set('pack', item, { [`bring.${USERS.carol.uuid}`]: 'yes' })])).ents[0].bring).toEqual({ [USERS.carol.uuid]: 'yes' });
  });
});

describe('lists idempotency and cost', () => {
  it('answers a retried commit from the op ids without writing twice', async () => {
    const { h, space, clients } = await setup();
    const ops = [put('listMeta', { kind: 'pack', name: 'Tech', order: 'a' }), put('pack', { name: 'Charger', order: 'a', list: 'Tech' })];
    const bob = clients.bob.in(space);
    const first = await bob.call('commit', { ops });
    h.world.resetCounters();
    const again = await bob.call('commit', { ops });
    expect(again.rev).toBe(first.rev);
    expect(again.done).toEqual(first.done);
    expect(h.world.counters().byUser[OWNER].calls['kv.incr'] ?? 0).toBe(0);
  });

  it('checks a whole list in one commit: one batched read and one write per item', async () => {
    const { h, space, clients } = await setup({ onlyIfAbsent: true });
    const bob = clients.bob.in(space);
    const ids = Array.from({ length: 12 }, () => id('pack'));
    const orders = orderKeys(ids.length);
    await bob.call('commit', { ops: ids.map((eid, index) => put('pack', { name: `Item ${index}`, order: orders[index] }, eid)) });
    h.advance(10_000);
    await bob.call('sync', { since: 0 });
    h.world.resetCounters();
    await bob.call('commit', { ops: ids.map((eid) => set('pack', eid, { done: true })) });
    const calls = h.world.counters().byUser[OWNER].calls;
    expect(calls['kv.get']).toBe(1);
    expect(calls['kv.incr']).toBe(1);
    expect(calls['kv.update']).toBe(ids.length);
  });
});
