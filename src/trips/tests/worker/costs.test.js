// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDatabase } from '../../src/lib/idb.js';
import { openSpaceStore } from '../../src/lib/store/space.js';
import '../../src/lib/costs/adapters.js';
import { computeBalances, netsOf, simplify } from '../../src/lib/costs/ledger.js';
import { USERS, WORKER, createHarness, expectError, id } from './harness.js';

const databases = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });

const [ALICE, BOB, CAROL] = [USERS.alice.uuid, USERS.bob.uuid, USERS.carol.uuid];
const OWNER = ALICE;
const owner = (h) => h.world.counters().byUser[OWNER]?.calls ?? {};
const kvCalls = (calls) => Object.entries(calls).filter(([method]) => method.startsWith('kv.') && method !== 'kv.share').reduce((n, [, count]) => n + count, 0);

async function setup(options) {
  const h = await createHarness(options);
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => h.client(name)));
  const as = (client) => (ops) => client.in(space).call('commit', { ops });
  return { h, space, alice: as(alice), bob: as(bob), carol: as(carol), clients: { bob } };
}

const lunch = (fields = {}) => ({
  name: 'Lunch', amount: 3000, currency: 'EUR', payers: [{ who: ALICE, amount: 3000 }],
  split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }, { who: CAROL }] }, ...fields,
});
const put = (fields, eid = id('e')) => ({ opId: id('o'), t: 'exp', id: eid, put: fields });
const settleAll = (transfers, ids = transfers.map(() => id('s'))) => ({ opId: id('o'), do: 'costs.settleAll', args: { transfers, newIds: { settle: ids } } });

describe('expense validation', () => {
  it('accepts payers and splits that add up, and refuses viewers', async () => {
    const { bob, carol } = await setup();
    const result = await bob([put(lunch())]);
    expect(result.ents[0]).toMatchObject({ t: 'exp', amount: 3000, by: BOB });
    await expectError(carol([put(lunch())]), 403, 'forbidden');
  });

  it.each([
    ['payers that miss the total', { payers: [{ who: ALICE, amount: 2000 }] }],
    ['amounts that miss the total', { split: { mode: 'amounts', parts: [{ who: ALICE, value: 1000 }, { who: BOB, value: 1000 }] } }],
    ['percentages that miss 100', { split: { mode: 'percent', parts: [{ who: ALICE, value: '50' }, { who: BOB, value: '49.99' }] } }],
    ['items that miss the total', { split: { mode: 'items', parts: [{ who: ALICE }], items: [{ label: 'Soup', amount: 100, who: [ALICE] }] } }],
    ['item people outside the split', { split: { mode: 'items', parts: [{ who: ALICE }], items: [{ label: 'Soup', amount: 3000, who: [BOB] }] } }],
    ['a duplicate participant', { split: { mode: 'equal', parts: [{ who: ALICE }, { who: ALICE }] } }],
    ['zero share weights', { split: { mode: 'shares', parts: [{ who: ALICE, value: 0 }] } }],
  ])('rejects %s', async (_name, fields) => {
    const { bob } = await setup();
    await expectError(bob([put(lunch(fields))]), 400);
  });

  it.each([
    ['items on a non-item split', { split: { mode: 'equal', parts: [{ who: ALICE }], items: [{ label: 'x', amount: 3000, who: [ALICE] }] } }, 'invalid_split'],
    ['a paid share above the share', { split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB, paid: 1501 }] } }, 'invalid_paid'],
    ['a paid share with the wrong sign', { split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB, paid: -1 }] } }, 'invalid_paid'],
    ['a paid share with no one to repay', { payers: [{ who: BOB, amount: 3000 }], split: { mode: 'equal', parts: [{ who: BOB, paid: 3000 }] } }, 'invalid_paid'],
    ['a paid share on an unpaid expense', { payers: [], split: { mode: 'equal', parts: [{ who: BOB, paid: 100 }] } }, 'invalid_paid'],
  ])('rejects %s in the type hook', async (_name, fields, code) => {
    const { bob } = await setup();
    await expectError(bob([put(lunch(fields))]), 400, code);
  });

  it('accepts refunds and paid-back shares, and checks patches the same way', async () => {
    const { bob } = await setup();
    await bob([put(lunch({ amount: -1000, payers: [{ who: ALICE, amount: -1000 }], split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB, paid: -500 }] } }))]);
    const eid = id('e');
    await bob([put(lunch(), eid)]);
    const split = { mode: 'equal', parts: [{ who: ALICE }, { who: BOB, paid: 1000 }, { who: CAROL }] };
    const result = await bob([{ opId: id('o'), t: 'exp', id: eid, set: { split } }]);
    expect(result.ents[0].split.parts[1].paid).toBe(1000);
    await expectError(bob([{ opId: id('o'), t: 'exp', id: eid, set: { amount: 2000 } }]), 400);
    await expectError(bob([{ opId: id('o'), t: 'exp', id: eid, set: { 'split.parts': [{ who: ALICE }, { who: BOB, paid: 2000 }] } }]), 400, 'invalid_paid');
  });

  it('requires people the op adds to be members or guests, and keeps former members on older expenses', async () => {
    const { h, space, alice, bob } = await setup();
    const stranger = '00000000-0000-4000-8000-00000000abcd';
    const guest = id('g');
    await expectError(bob([put(lunch({ split: { mode: 'equal', parts: [{ who: ALICE }, { who: stranger }] } }))]), 400, 'unknown_person');
    await expectError(bob([put(lunch({ payers: [{ who: guest, amount: 3000 }] }))]), 400, 'unknown_person');
    // A guest created earlier in the same commit counts.
    await bob([{ opId: id('o'), t: 'guest', id: guest, put: { name: 'Dana' } }, put(lunch({ payers: [{ who: guest, amount: 3000 }] }))]);
    const eid = id('e');
    await bob([put(lunch(), eid)]);
    await expectError(bob([{ opId: id('o'), t: 'exp', id: eid, set: { 'split.parts': [{ who: ALICE }, { who: stranger }] } }]), 400, 'unknown_person');
    await (await h.client('alice')).in(space).call('member.remove', { uuid: CAROL });
    h.advance(6000);
    // Carol left, but the expense keeps her when only the amount and payer change.
    await alice([{ opId: id('o'), t: 'exp', id: eid, set: { amount: 3300, payers: [{ who: ALICE, amount: 3300 }] } }]);
    await expectError(alice([put(lunch())]), 400, 'unknown_person');
    h.world.resetCounters();
    await alice([put(lunch({ split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }] } }))]);
    expect(owner(h)['kv.get'] ?? 0).toBeLessThanOrEqual(1);
  });

  it('keeps an expense create idempotent per op id', async () => {
    const { bob } = await setup();
    const op = put(lunch());
    const first = await bob([op]);
    const again = await bob([op]);
    expect(again.done[op.opId]).toBe(first.rev);
    expect(again.rev).toBe(first.rev);
  });
});

describe('costs.settleAll', () => {
  const transfers = [
    { from: BOB, to: ALICE, amount: 1000, currency: 'EUR' },
    { from: CAROL, to: ALICE, amount: 900, currency: 'USD', rate: '1.1', date: '2027-05-03', note: 'Cash' },
  ];

  it('records every transfer in one change', async () => {
    const { bob } = await setup();
    const ids = [id('s'), id('s')];
    const result = await bob([settleAll(transfers, ids)]);
    expect(result.ents.map((entity) => [entity.t, entity.id, entity.from, entity.amount])).toEqual([['settle', ids[0], BOB, 1000], ['settle', ids[1], CAROL, 900]]);
    expect(new Set(result.ents.map((entity) => entity.rev))).toEqual(new Set([result.rev]));
  });

  it('refuses viewers and malformed arguments', async () => {
    const { bob, carol } = await setup();
    await expectError(carol([settleAll(transfers)]), 403, 'forbidden');
    await expectError(bob([settleAll(transfers, [id('s')])]), 400, 'invalid_args');
    await expectError(bob([settleAll([])]), 400, 'invalid_args');
    const dup = id('s');
    await expectError(bob([settleAll(transfers, [dup, dup])]), 400, 'invalid_args');
    await expectError(bob([settleAll([{ ...transfers[0], extra: 1 }])]), 400, 'invalid_args');
    await expectError(bob([settleAll([{ ...transfers[0], to: BOB }])]), 400, 'invalid');
    await expectError(bob([settleAll([{ ...transfers[0], amount: 0 }])]), 400, 'invalid');
    await expectError(bob([settleAll(Array.from({ length: 101 }, () => transfers[0]))]), 400, 'invalid_args');
    await expectError(bob([{ opId: id('o'), do: 'costs.settleAll', args: { transfers, newIds: { settle: [id('s'), id('s')], other: [] } } }]), 400, 'invalid_args');
  });

  it('is idempotent per op id and never overwrites a taken id', async () => {
    const { bob, alice } = await setup();
    const op = settleAll(transfers);
    const first = await bob([op]);
    const again = await bob([op]);
    expect(again.done[op.opId]).toBe(first.rev);
    const taken = op.args.newIds.settle;
    await expectError(alice([settleAll(transfers, taken)]), 409, 'already_exists');
  });

  it('costs one batched read and the writes of n creates', async () => {
    const { h, bob } = await setup({ onlyIfAbsent: true });
    await bob([put(lunch())]);
    h.world.resetCounters();
    const n = 5;
    await bob([settleAll(Array.from({ length: n }, (_, index) => ({ from: index % 2 ? BOB : CAROL, to: ALICE, amount: 100 + index, currency: 'EUR' })))]);
    const calls = owner(h);
    expect(calls['kv.get']).toBe(1);
    expect(kvCalls(calls)).toBeLessThanOrEqual(4 + n + 1);
  });
});

describe('costs through the real store', () => {
  it('shows settle-all locally through the adapter and clears the balances once acknowledged', async () => {
    const { h, space, clients } = await setup();
    const db = await openDatabase(clients.bob.uuid, { indexedDB: new IDBFactory() });
    databases.push(db);
    const store = await openSpaceStore({ ref: { w: WORKER, s: space, k: 'trip' }, db, api: clients.bob.api, now: h.now });
    await store.apply([{ opId: id('o'), t: 'exp', id: id('e'), put: lunch() }]);
    const before = computeBalances({ expenses: store.entities('exp'), settlements: store.entities('settle'), tripCurrency: 'EUR' });
    const transfers = simplify(netsOf(before)).map((transfer) => ({ ...transfer, currency: 'EUR' }));
    expect(transfers).toHaveLength(2);
    const ids = transfers.map(() => id('s'));
    await store.apply([{ opId: id('o'), do: 'costs.settleAll', args: { transfers, newIds: { settle: ids } } }]);
    expect(store.entities('settle').map((entity) => entity.id).sort()).toEqual([...ids].sort());
    expect((await store.flush()).status).toBe('sent');
    const after = computeBalances({ expenses: store.entities('exp'), settlements: store.entities('settle'), tripCurrency: 'EUR' });
    expect([...netsOf(after).values()].every((value) => value === 0)).toBe(true);
  });
});
