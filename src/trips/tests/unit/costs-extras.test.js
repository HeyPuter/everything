import { describe, expect, it } from 'vitest';
import { computeBalances, expenseView, pairwise } from '../../src/lib/costs/ledger.js';
import { duePayments, isPartial, paymentPatch, planPatch } from '../../src/lib/costs/due.js';
import { balancesByCurrency, hasSeveralCurrencies } from '../../src/lib/costs/currencies.js';
import { budgetDuplicates, budgetEntries, budgetPlan, tripTimeline } from '../../src/lib/costs/budget.js';
import { acrossCopy, acrossDrift, allocateAcross, planAcross, scaleExpense, tripDays } from '../../src/lib/costs/across.js';
import { splitAmount } from '../../src/shared/money.js';
import { validateEntity } from '../../src/shared/schema/index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const G = 'gggggggggggggggg';
const exp = (fields = {}) => ({ id: 'eeeeeeeeeeeeeee1', name: 'Hotel', amount: 90000, currency: 'EUR', payers: [{ who: A, amount: 90000 }],
  split: { mode: 'equal', parts: [{ who: A }, { who: B }, { who: C }] }, ...fields });
const netSum = (balances) => [...balances.people.values()].reduce((sum, entry) => sum + entry.net, 0);

describe('partial payments in the ledger', () => {
  it('counts only the paid part toward balances and the rest as due', () => {
    const partial = exp({ payers: [{ who: A, amount: 30000 }], due: '2026-12-01' });
    const view = expenseView(partial, 'EUR');
    expect(view.partial).toBe(true);
    expect(view.paid).toBe(30000);
    expect(view.due).toBe(60000);
    expect(view.dueShares.map((share) => share.amount)).toEqual([20000, 20000, 20000]);
    const balances = computeBalances({ expenses: [partial], tripCurrency: 'EUR' });
    expect(balances.spend).toBe(90000);
    expect(balances.due).toBe(60000);
    expect(balances.people.get(A).net).toBe(20000);
    expect(balances.people.get(B).net).toBe(-10000);
    expect(balances.people.get(B).unpaidShare).toBe(20000);
    expect(netSum(balances)).toBe(0);
  });

  it('keeps nets at zero across rates, refunds and paid-back shares', () => {
    const foreign = exp({ id: 'eeeeeeeeeeeeeee2', currency: 'USD', rate: '0.91', amount: 10001, payers: [{ who: A, amount: 3333 }, { who: B, amount: 1 }], due: '2026-11-11',
      split: { mode: 'equal', parts: [{ who: A }, { who: B, paid: 3000 }, { who: C }] } });
    const refund = exp({ id: 'eeeeeeeeeeeeeee3', amount: -5000, payers: [{ who: C, amount: -2000 }], due: '2026-11-12' });
    const balances = computeBalances({ expenses: [foreign, refund], tripCurrency: 'EUR' });
    expect(balances.invalid).toEqual([]);
    expect(netSum(balances)).toBe(0);
    const view = balances.views.get(foreign.id);
    expect(view.paid + view.due).toBe(view.total);
    const transfers = pairwise(balances, [], 'EUR');
    const moved = new Map();
    for (const item of transfers) { moved.set(item.from, (moved.get(item.from) ?? 0) - item.amount); moved.set(item.to, (moved.get(item.to) ?? 0) + item.amount); }
    for (const entry of balances.people.values()) expect(moved.get(entry.who) ?? 0).toBe(entry.net);
  });

  it('treats a fully paid expense with a due date as a normal one', () => {
    const view = expenseView(exp({ due: '2026-12-01' }), 'EUR');
    expect(view.partial).toBe(false);
    expect(view.balance).toBe(view.trip);
  });
});

describe('payments due', () => {
  const today = '2026-11-20';
  it('lists what is left, soonest first, with overdue flags', () => {
    const list = duePayments([
      exp({ id: 'a1', payers: [{ who: A, amount: 30000 }], due: '2026-12-01' }),
      exp({ id: 'a2', payers: [], due: '2026-11-10' }),
      exp({ id: 'a3', due: '2026-11-01' }),
      exp({ id: 'a4' }),
    ], { today });
    expect(list.map((item) => item.exp.id)).toEqual(['a2', 'a1']);
    expect(list[0]).toMatchObject({ left: 90000, overdue: true, days: -10 });
    expect(list[1]).toMatchObject({ paid: 30000, left: 60000, overdue: false, days: 11 });
    expect(isPartial(list[1].exp)).toBe(true);
    expect(isPartial(list[0].exp)).toBe(false);
  });

  it('records a payment and drops the due date once everything is paid', () => {
    const partial = exp({ payers: [{ who: A, amount: 30000 }], due: '2026-12-01' });
    expect(paymentPatch(partial, { who: B, amount: 20000 })).toEqual({ set: { payers: [{ who: A, amount: 30000 }, { who: B, amount: 20000 }] }, unset: [] });
    expect(paymentPatch(partial, { who: A, amount: 60000 })).toEqual({ set: { payers: [{ who: A, amount: 90000 }] }, unset: ['due'] });
    expect(() => paymentPatch(partial, { who: A, amount: 60001 })).toThrow('payer_total');
    expect(() => paymentPatch(partial, { who: A, amount: -1 })).toThrow('invalid_amount');
  });

  it('sets a payment plan and validates the result', () => {
    const full = exp();
    const patch = planPatch(full, { payers: [{ who: A, amount: 10000 }, { who: B, amount: 0 }], due: '2027-01-05' });
    expect(patch).toEqual({ set: { payers: [{ who: A, amount: 10000 }], due: '2027-01-05' }, unset: [] });
    const { id: _id, ...fields } = full;
    expect(validateEntity('trip', 'exp', { ...fields, ...patch.set })).toBeTruthy();
    expect(planPatch(exp({ due: '2026-01-01' }), { payers: [{ who: A, amount: 90000 }], due: '2027-01-05' })).toEqual({ set: { payers: [{ who: A, amount: 90000 }] }, unset: ['due'] });
    expect(() => planPatch(full, { payers: [], due: 'soon' })).toThrow('invalid_date');
  });
});

describe('per-currency balances', () => {
  it('settles each currency on its own, trip currency first', () => {
    const entries = balancesByCurrency({ tripCurrency: 'EUR', expenses: [
      exp({ id: 'c1', amount: 3000, payers: [{ who: A, amount: 3000 }] }),
      exp({ id: 'c2', currency: 'JPY', amount: 9000, rate: '0.0061', payers: [{ who: B, amount: 9000 }] }),
      exp({ id: 'c3', currency: 'USD', amount: 600, payers: [{ who: C, amount: 600 }], split: { mode: 'equal', parts: [{ who: A }, { who: C }] } }),
    ], settlements: [{ id: 's1', from: A, to: B, amount: 3000, currency: 'JPY' }] });
    expect(entries.map((entry) => entry.currency)).toEqual(['EUR', 'JPY', 'USD']);
    const jpy = entries[1];
    expect(jpy.nets.get(B)).toBe(6000 - 3000);
    expect(jpy.nets.get(A)).toBe(-3000 + 3000);
    expect(jpy.transfers).toEqual([{ from: C, to: B, amount: 3000 }]);
    expect(entries[2].transfers).toEqual([{ from: A, to: C, amount: 300 }]);
    for (const entry of entries) expect([...entry.nets.values()].reduce((a, b) => a + b, 0)).toBe(0);
    expect(hasSeveralCurrencies(entries)).toBe(true);
    expect(hasSeveralCurrencies(entries.slice(0, 1))).toBe(false);
  });
});

describe('budget planner', () => {
  const byCategory = new Map([['food', 42000], ['transport', 10000], ['shopping', 5000]]);
  it('compares planned and spent per category and for the trip', () => {
    const budgets = [
      { id: 'b2', cr: 2, cat: 'food', amount: 40000 },
      { id: 'b1', cr: 1, cat: 'food', amount: 30000 },
      { id: 'b3', cr: 3, cat: 'transport', amount: 20000 },
      { id: 'b4', cr: 4, amount: 100000 },
    ];
    expect(budgetEntries(budgets).get('food').id).toBe('b1');
    expect(budgetDuplicates(budgets).map((item) => item.id)).toEqual(['b2']);
    const plan = budgetPlan({ budgets, byCategory, spend: 57000, categories: ['transport', 'food'], meta: { start: '2026-12-01', end: '2026-12-10' }, today: '2026-12-04' });
    expect(plan.planned).toBe(100000);
    expect(plan.left).toBe(43000);
    expect(plan.unallocated).toBe(50000);
    expect(plan.categories.map((row) => [row.cat, row.planned, row.spent, row.over])).toEqual([
      ['transport', 20000, 10000, false], ['food', 30000, 42000, true], ['shopping', null, 5000, false],
    ]);
    expect(plan.timeline).toEqual({ phase: 'during', days: 10, left: 7 });
    expect(plan.perDay).toBe(Math.floor(43000 / 7));
  });

  it('adds up category budgets without a trip total and handles empty plans', () => {
    const plan = budgetPlan({ budgets: [{ id: 'x', cat: 'food', amount: 1000 }], byCategory, spend: 57000, meta: {}, today: '2026-12-04' });
    expect(plan.planned).toBe(1000);
    expect(plan.over).toBe(true);
    expect(plan.perDay).toBeNull();
    expect(budgetPlan({ byCategory, spend: 1 }).planned).toBeNull();
  });

  it('places today before, during and after the trip', () => {
    const meta = { start: '2026-12-01', end: '2026-12-03' };
    expect(tripTimeline(meta, '2026-11-01')).toEqual({ phase: 'before', days: 3, left: 3 });
    expect(tripTimeline(meta, '2026-12-03')).toEqual({ phase: 'during', days: 3, left: 1 });
    expect(tripTimeline(meta, '2026-12-04')).toEqual({ phase: 'after', days: 3, left: 0 });
    expect(tripTimeline({}, '2026-12-04').phase).toBe('undated');
  });
});

describe('expenses across trips', () => {
  const here = { ref: { w: 'trips-abcdefghij', s: 'sssssssssssssss1', k: 'trip' }, title: 'Rome', currency: 'EUR' };
  const other = { ref: { w: 'trips-bcdefghijk', s: 'sssssssssssssss2', k: 'trip' }, title: 'Milan', currency: 'EUR' };
  let n = 0;
  const makeId = () => `abab${String(++n).padStart(12, '0')}`;

  it('allocates equally, by days and by amounts', () => {
    expect(allocateAcross(1001, [{}, {}])).toEqual(expect.arrayContaining([501, 500]));
    expect(allocateAcross(1000, [{ start: '2026-01-01', end: '2026-01-03' }, { start: '2026-01-04' }], { mode: 'days' })).toEqual([750, 250]);
    expect(allocateAcross(1000, [{}, {}], { mode: 'amounts', values: [900, 100] })).toEqual([900, 100]);
    expect(() => allocateAcross(1000, [{}, {}], { mode: 'amounts', values: [900, 99] })).toThrow('across_total');
    expect(() => allocateAcross(1000, [{}])).toThrow('invalid_across');
    expect(tripDays({ start: '2026-01-01', end: '2025-01-01' })).toBe(1);
  });

  it('scales payers, item splits and paid-back shares to a new amount', () => {
    const items = exp({ amount: 1000, payers: [{ who: A, amount: 600 }, { who: B, amount: 400 }],
      split: { mode: 'items', parts: [{ who: A }, { who: B, paid: 300 }], items: [{ label: 'x', amount: 700, who: [A] }, { label: 'y', amount: 300, who: [B] }] } });
    const scaled = scaleExpense(items, 500);
    expect(scaled.payers).toEqual([{ who: A, amount: 300 }, { who: B, amount: 200 }]);
    expect(scaled.split.items.map((item) => item.amount)).toEqual([350, 150]);
    expect(scaled.split.parts[1].paid).toBe(150);
    const shares = splitAmount(500, scaled.split, { expenseId: items.id });
    expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(500);
    const amounts = scaleExpense(exp({ amount: 900, payers: [{ who: A, amount: 900 }], split: { mode: 'amounts', parts: [{ who: A, value: 600 }, { who: B, value: 300 }] } }), 300);
    expect(amounts.split.parts.map((part) => part.value)).toEqual([200, 100]);
  });

  it('copies to another trip with only its people and a pending rate across currencies', () => {
    const mapPerson = (who) => (who === A ? A : null);
    const copy = acrossCopy(exp({ payers: [{ who: B, amount: 90000 }] }), { amount: 30000, across: { group: G, total: 90000, parts: [{ w: here.ref.w, s: here.ref.s, amount: 60000 }, { w: other.ref.w, s: other.ref.s, amount: 30000 }] },
      mapPerson, me: A, sourceCurrency: 'EUR', targetCurrency: 'CHF' });
    expect(copy.payers).toEqual([{ who: A, amount: 30000 }]);
    expect(copy.split).toEqual({ mode: 'equal', parts: [{ who: A }] });
    expect(copy.rate).toBeNull();
    expect(copy.links).toBeUndefined();
    const partial = acrossCopy(exp({ payers: [{ who: A, amount: 45000 }], due: '2026-12-01' }), { amount: 30000, across: { group: G, total: 90000, parts: [{ w: here.ref.w, s: here.ref.s, amount: 60000 }, { w: other.ref.w, s: other.ref.s, amount: 30000 }] },
      mapPerson: (who) => who, me: A, sourceCurrency: 'EUR', targetCurrency: 'EUR' });
    expect(partial.payers).toEqual([{ who: A, amount: 15000 }]);
    expect(partial.due).toBe('2026-12-01');
    expect(partial.rate).toBeUndefined();
  });

  it('plans the source patch and the copies with one group', () => {
    const plan = planAcross(exp(), { here, trips: [{ ...here }, { ...other, mapPerson: (who) => who }], parts: [60000, 30000], me: A, makeId });
    expect(plan.across.parts.map((part) => part.amount)).toEqual([60000, 30000]);
    expect(plan.source.set.amount).toBe(60000);
    expect(plan.source.set.payers).toEqual([{ who: A, amount: 60000 }]);
    expect(plan.copies).toHaveLength(1);
    expect(plan.copies[0].fields.across.group).toBe(plan.across.group);
    expect(plan.copies[0].fields.split.parts).toHaveLength(3);
    expect(acrossDrift({ amount: 60000, across: plan.across }, here.ref.s)).toBe(false);
    expect(acrossDrift({ amount: 61000, across: plan.across }, here.ref.s)).toBe(true);
  });
});
