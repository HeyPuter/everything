// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { USERS, createHarness, expectError, id } from './harness.js';

const [ALICE, BOB, CAROL] = [USERS.alice.uuid, USERS.bob.uuid, USERS.carol.uuid];
const kvCalls = (h) => Object.entries(h.world.counters().byUser[ALICE]?.calls ?? {})
  .filter(([method]) => method.startsWith('kv.') && method !== 'kv.share').reduce((n, [, count]) => n + count, 0);

async function setup() {
  const h = await createHarness();
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [bob, carol] = await Promise.all(['bob', 'carol'].map((name) => h.client(name)));
  const as = (client) => (ops) => client.in(space).call('commit', { ops });
  return { h, bob: as(bob), carol: as(carol) };
}

const hotel = (fields = {}) => ({
  name: 'Hotel', amount: 90000, currency: 'EUR', payers: [{ who: ALICE, amount: 30000 }], due: '2026-12-01',
  split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }, { who: CAROL }] }, ...fields,
});
const put = (t, fields, eid = id('e')) => ({ opId: id('o'), t, id: eid, put: fields });

describe('partial payments', () => {
  it('accepts a part payment with a due date and refuses one without', async () => {
    const { bob } = await setup();
    const result = await bob([put('exp', hotel())]);
    expect(result.ents[0]).toMatchObject({ due: '2026-12-01', payers: [{ who: ALICE, amount: 30000 }] });
    await expectError(bob([put('exp', hotel({ due: undefined }))]), 400);
    await expectError(bob([put('exp', hotel({ payers: [{ who: ALICE, amount: 90001 }] }))]), 400);
  });

  it('refuses removing the due date while part of it is unpaid, and allows it once paid', async () => {
    const { bob } = await setup();
    const eid = id('e');
    await bob([put('exp', hotel(), eid)]);
    await expectError(bob([{ opId: id('o'), t: 'exp', id: eid, unset: ['due'] }]), 400);
    const paid = await bob([{ opId: id('o'), t: 'exp', id: eid, set: { payers: [{ who: ALICE, amount: 30000 }, { who: BOB, amount: 60000 }] }, unset: ['due'] }]);
    expect(paid.ents[0].due).toBeUndefined();
  });

  it('accepts an expense split across trips', async () => {
    const { bob } = await setup();
    const across = { group: id('g'), total: 150000, parts: [{ w: 'trips-abcdefghij', s: id('s'), amount: 90000 }, { w: 'trips-bcdefghijk', s: id('s'), title: 'Rome', amount: 60000 }] };
    const result = await bob([put('exp', hotel({ across }))]);
    expect(result.ents[0].across.total).toBe(150000);
    await expectError(bob([put('exp', hotel({ across: { ...across, total: 1 } }))]), 400);
  });
});

describe('budgets', () => {
  it('lets editors plan and refuses viewers', async () => {
    const { bob, carol } = await setup();
    const result = await bob([put('budget', { cat: 'food', amount: 50000 })]);
    expect(result.ents[0]).toMatchObject({ t: 'budget', cat: 'food', amount: 50000, by: BOB });
    await expectError(carol([put('budget', { amount: 1 })]), 403, 'forbidden');
    await expectError(bob([put('budget', { amount: -5 })]), 400);
  });

  it('is idempotent per op id', async () => {
    const { bob } = await setup();
    const op = put('budget', { amount: 100000 });
    const first = await bob([op]);
    const again = await bob([op]);
    expect(again.done[op.opId]).toBe(first.rev);
  });

  it('costs no more than any other entity create', async () => {
    const { h, bob } = await setup();
    await bob([put('costCat', { cat: 'food', order: 'V' })]);
    h.world.resetCounters();
    await bob([put('costCat', { cat: 'fuel', order: 'W' })]);
    const plain = kvCalls(h);
    h.world.resetCounters();
    await bob([put('budget', { cat: 'fuel', amount: 1000 })]);
    expect(kvCalls(h)).toBeLessThanOrEqual(plain);
  });
});
