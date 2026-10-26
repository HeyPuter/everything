import { describe, expect, it } from 'vitest';
import { computeBalances, expenseView, netsOf, pairwise, positionOf, rateState, simplify, spendOf, spread, summary, toTrip } from '../../src/lib/costs/ledger.js';

const [A, B, C, D] = ['a', 'b', 'c', 'd'];
let next = 0;
const eid = () => String(++next).padStart(16, '0');
const exp = (fields) => ({
  id: eid(), name: 'x', currency: 'EUR', payers: [], split: { mode: 'equal', parts: [{ who: A }] }, ...fields,
});
const equal = (...people) => ({ mode: 'equal', parts: people.map((who) => ({ who })) });
const sum = (values) => values.reduce((total, value) => total + value, 0);
const net = (balances, who) => balances.people.get(who)?.net ?? 0;

/** Applies transfers to nets and returns what is left (all zero when they settle everything). */
function settleWith(nets, transfers) {
  const left = new Map(nets);
  for (const { from, to, amount } of transfers) {
    expect(amount).toBeGreaterThan(0);
    left.set(from, (left.get(from) ?? 0) + amount);
    left.set(to, (left.get(to) ?? 0) - amount);
  }
  return [...left.values()].filter((value) => value !== 0);
}

describe('rates and conversion', () => {
  it.each([
    [{ currency: 'EUR' }, 'same'],
    [{ currency: 'EUR', rate: '1.2' }, 'same'],
    [{ currency: 'USD', rate: '0.9' }, 'frozen'],
    [{ currency: 'USD', rate: null }, 'pending'],
    [{ currency: 'USD' }, 'pending'],
  ])('%o is %s', (entity, state) => expect(rateState(entity, 'EUR')).toBe(state));

  it.each([
    [10_000, { currency: 'USD', rate: '0.9' }, 'EUR', 9000],
    [1000, { currency: 'JPY', rate: '0.0062' }, 'EUR', 620],
    [1001, { currency: 'EUR', rate: '161.2345' }, 'JPY', 1614],
    [1234, { currency: 'KWD', rate: '3.25' }, 'EUR', 401],
    [-10_000, { currency: 'USD', rate: '0.9' }, 'EUR', -9000],
    [1, { currency: 'USD', rate: '0.5' }, 'EUR', 1],
    [5000, { currency: 'EUR' }, 'EUR', 5000],
    [5000, { currency: 'USD', rate: null }, 'EUR', null],
  ])('converts %i through the frozen rate', (amount, entity, trip, expected) => expect(toTrip(amount, entity, trip)).toBe(expected));

  it('spreads a converted total so the parts always add up', () => {
    for (const total of [1, 2, 99, 100, 101, 333, -7, 0]) {
      const parts = spread(total, [3334, 3333, 3333], 'seed');
      expect(sum(parts)).toBe(total);
    }
    expect(spread(100, [0, 0])).toEqual([0, 0]);
    expect(spread(100, [])).toEqual([]);
    expect(spread(-100, [-50, -50])).toEqual([-50, -50]);
  });
});

describe('expense views', () => {
  it('rotates the leftover cent of equal splits by expense id', () => {
    const receivers = new Set();
    for (let i = 0; i < 12; i++) {
      const view = expenseView(exp({ amount: 10_000, payers: [{ who: A, amount: 10_000 }], split: equal(A, B, C) }), 'EUR');
      expect(view.own.shares.map((share) => share.who)).toEqual([A, B, C]);
      expect(sum(view.own.shares.map((share) => share.amount))).toBe(10_000);
      receivers.add(view.own.shares.find((share) => share.amount === 3334).who);
    }
    expect(receivers.size).toBeGreaterThan(1);
  });

  it('keeps own-currency values exact and converts the total once', () => {
    const view = expenseView(exp({ amount: 1000, currency: 'USD', rate: '0.333333', payers: [{ who: A, amount: 600 }, { who: B, amount: 400 }], split: equal(A, B, C) }), 'EUR');
    expect(view.total).toBe(333);
    expect(view.own.payers).toEqual([{ who: A, amount: 600 }, { who: B, amount: 400 }]);
    expect(sum(view.trip.shares.map((share) => share.amount))).toBe(333);
    expect(sum(view.trip.payers.map((payer) => payer.amount))).toBe(333);
    expect(view.trip.payers.map((payer) => payer.amount)).toEqual([200, 133]);
  });

  it('marks pending and unpaid expenses', () => {
    expect(expenseView(exp({ amount: 500, currency: 'USD', rate: null, payers: [{ who: A, amount: 500 }] }), 'EUR')).toMatchObject({ pending: true, total: null, trip: null });
    expect(expenseView(exp({ amount: 500 }), 'EUR')).toMatchObject({ unpaid: true, pending: false, total: 500 });
  });

  it('throws for a split that does not add up', () => {
    expect(() => expenseView(exp({ amount: 500, split: { mode: 'amounts', parts: [{ who: A, value: 200 }, { who: B, value: 200 }] } }), 'EUR')).toThrow('split_total');
  });

  it.each([
    ['items', { mode: 'items', parts: [{ who: A }, { who: B }], items: [{ label: 'Pizza', amount: 2000, who: [A, B] }, { label: 'Wine', amount: 1000, who: [B] }] }, [1000, 2000]],
    ['percent', { mode: 'percent', parts: [{ who: A, value: '33.33' }, { who: B, value: '33.33' }, { who: C, value: '33.34' }] }, [1000, 1000, 1000]],
    ['shares', { mode: 'shares', parts: [{ who: A, value: 2 }, { who: B, value: 1 }, { who: C, value: '1' }] }, [1500, 750, 750]],
    ['amounts', { mode: 'amounts', parts: [{ who: A, value: 100 }, { who: B, value: 2900 }] }, [100, 2900]],
  ])('splits by %s', (_mode, split, expected) => {
    const view = expenseView(exp({ amount: 3000, payers: [{ who: A, amount: 3000 }], split }), 'EUR');
    expect(view.own.shares.map((share) => share.amount)).toEqual(expected);
  });

  it('pays a marked share back to the other payers in proportion', () => {
    const view = expenseView(exp({ amount: 9000, payers: [{ who: A, amount: 6000 }, { who: C, amount: 3000 }], split: { mode: 'equal', parts: [{ who: A }, { who: B, paid: 3000 }, { who: C }] } }), 'EUR');
    expect(view.own.repaid).toEqual([{ from: B, to: A, amount: 2000 }, { from: B, to: C, amount: 1000 }]);
    expect(positionOf(view.own, B)).toBe(0);
    expect(positionOf(view.own, A) + positionOf(view.own, C)).toBe(0);
  });

  it('caps a paid share at the share and ignores it without other payers', () => {
    const over = expenseView(exp({ amount: 1000, payers: [{ who: A, amount: 1000 }], split: { mode: 'equal', parts: [{ who: A }, { who: B, paid: 9999 }] } }), 'EUR');
    expect(over.own.repaid).toEqual([{ from: B, to: A, amount: 500 }]);
    const self = expenseView(exp({ amount: 1000, payers: [{ who: A, amount: 1000 }], split: { mode: 'equal', parts: [{ who: A, paid: 500 }, { who: B }] } }), 'EUR');
    expect(self.own.repaid).toEqual([]);
  });

  it('scales a partial paid share into the trip currency', () => {
    const view = expenseView(exp({ amount: 1000, currency: 'USD', rate: '0.9', payers: [{ who: A, amount: 1000 }], split: { mode: 'equal', parts: [{ who: A }, { who: B, paid: 250 }] } }), 'EUR');
    expect(view.trip.shares).toEqual([{ who: A, amount: 450 }, { who: B, amount: 450 }]);
    expect(view.trip.repaid).toEqual([{ from: B, to: A, amount: 225 }]);
  });
});

describe('balances', () => {
  it('nets payers against shares', () => {
    const balances = computeBalances({ tripCurrency: 'EUR', expenses: [
      exp({ amount: 3000, payers: [{ who: A, amount: 3000 }], split: equal(A, B, C) }),
      exp({ amount: 2000, payers: [{ who: A, amount: 1200 }, { who: B, amount: 800 }], split: equal(A, B) }),
    ] });
    expect(net(balances, A)).toBe(3000 - 1000 + 1200 - 1000);
    expect(net(balances, B)).toBe(-1000 + 800 - 1000);
    expect(net(balances, C)).toBe(-1000);
    expect(balances.spend).toBe(5000);
    expect(sum([...netsOf(balances).values()])).toBe(0);
  });

  it('counts unpaid expenses toward spend only', () => {
    const balances = computeBalances({ tripCurrency: 'EUR', expenses: [exp({ amount: 1000, cat: 'food', split: equal(A, B) })] });
    expect(balances.spend).toBe(1000);
    expect(balances.unpaid).toBe(1000);
    expect(net(balances, A)).toBe(0);
    expect(balances.people.get(A).unpaidShare).toBe(500);
    expect(balances.byCategory.get('food')).toBe(1000);
  });

  it('leaves pending rates and invalid entries out and lists them', () => {
    const pendingExp = exp({ amount: 1000, currency: 'USD', rate: null, payers: [{ who: A, amount: 1000 }], split: equal(A, B) });
    const broken = exp({ amount: 1000, payers: [{ who: A, amount: 900 }], split: equal(A, B) });
    const pendingSettle = { id: 'p', from: B, to: A, amount: 100, currency: 'USD', rate: null };
    const balances = computeBalances({ tripCurrency: 'EUR', expenses: [pendingExp, broken], settlements: [pendingSettle] });
    expect(balances.pending).toEqual({ expenses: [pendingExp.id], settlements: ['p'] });
    expect(balances.invalid).toEqual([broken.id]);
    expect(balances.spend).toBe(0);
    const invalid = computeBalances({ tripCurrency: 'EUR', expenses: [exp({ amount: 1000, payers: [{ who: A, amount: 1000 }], split: { mode: 'percent', parts: [{ who: A, value: '50' }, { who: B, value: '49' }] } })] });
    expect(invalid.invalid).toHaveLength(1);
  });

  it('applies settlements in their own currency through their rate', () => {
    const balances = computeBalances({ tripCurrency: 'EUR', expenses: [exp({ amount: 2000, payers: [{ who: A, amount: 2000 }], split: equal(A, B) })],
      settlements: [{ id: 's', from: B, to: A, amount: 1000, currency: 'USD', rate: '0.5' }, { id: 't', from: B, to: A, amount: 500, currency: 'EUR' }] });
    expect(net(balances, B)).toBe(0);
    expect(balances.people.get(B)).toMatchObject({ sent: 1000, share: 1000 });
    expect(balances.people.get(A)).toMatchObject({ received: 1000, paid: 2000 });
  });

  it('handles refunds with the sign preserved', () => {
    const balances = computeBalances({ tripCurrency: 'EUR', expenses: [exp({ amount: -3000, payers: [{ who: A, amount: -3000 }], split: equal(A, B) })] });
    expect(net(balances, A)).toBe(-1500);
    expect(net(balances, B)).toBe(1500);
    expect(simplify(netsOf(balances))).toEqual([{ from: A, to: B, amount: 1500 }]);
    expect(pairwise(balances, [], 'EUR')).toEqual([{ from: A, to: B, amount: 1500 }]);
  });

  it('accounts for paid-back shares on both sides', () => {
    const balances = computeBalances({ tripCurrency: 'EUR', expenses: [exp({ amount: 1000, payers: [{ who: A, amount: 1000 }], split: { mode: 'equal', parts: [{ who: A }, { who: B, paid: 200 }] } })] });
    expect(net(balances, B)).toBe(-300);
    expect(balances.people.get(A)).toMatchObject({ net: 300, repaidTo: 200 });
  });

  it('summarises owe, owed, outstanding and spend for a viewer', () => {
    const balances = computeBalances({ tripCurrency: 'EUR', expenses: [exp({ amount: 3000, payers: [{ who: A, amount: 3000 }], split: equal(A, B, C) })] });
    expect(summary(balances, B)).toEqual({ owe: 1000, owed: 0, outstanding: 2000, spend: 3000 });
    expect(summary(balances, A)).toEqual({ owe: 0, owed: 2000, outstanding: 2000, spend: 3000 });
    expect(summary(balances, D)).toEqual({ owe: 0, owed: 0, outstanding: 2000, spend: 3000 });
  });

  it('sums private spend separately', () => {
    const result = spendOf([exp({ amount: 500, cat: 'tips' }), exp({ amount: 100, currency: 'USD', rate: '2' }), exp({ amount: 100, currency: 'USD', rate: null })], 'EUR');
    expect(result.total).toBe(700);
    expect(result.byCategory.get('tips')).toBe(500);
    expect(result.byCategory.get('other')).toBe(200);
    expect(result.pending).toHaveLength(1);
  });
});

describe('settling up', () => {
  it('suggests the largest debtor pays the largest creditor', () => {
    expect(simplify(new Map([[A, 100], [B, -60], [C, -40]]))).toEqual([{ from: B, to: A, amount: 60 }, { from: C, to: A, amount: 40 }]);
    expect(simplify(new Map([[A, 50], [B, 30], [C, -20], [D, -60]]))).toEqual([
      { from: D, to: A, amount: 50 }, { from: C, to: B, amount: 20 }, { from: D, to: B, amount: 10 },
    ]);
  });

  it('breaks ties by id and ignores settled people', () => {
    expect(simplify(new Map([[C, 10], [B, 10], [D, -10], [A, -10]]))).toEqual([{ from: A, to: B, amount: 10 }, { from: D, to: C, amount: 10 }]);
    expect(simplify(new Map([[A, 0], [B, 0]]))).toEqual([]);
  });

  it('nets pairwise debts without simplifying', () => {
    const expenses = [
      exp({ amount: 2000, payers: [{ who: A, amount: 2000 }], split: equal(A, B) }),
      exp({ amount: 1000, payers: [{ who: B, amount: 1000 }], split: equal(A, B) }),
      exp({ amount: 3000, payers: [{ who: C, amount: 3000 }], split: equal(A, B, C) }),
    ];
    const settlements = [{ id: 's', from: B, to: C, amount: 400, currency: 'EUR' }];
    const balances = computeBalances({ tripCurrency: 'EUR', expenses, settlements });
    expect(pairwise(balances, settlements, 'EUR')).toEqual([{ from: A, to: C, amount: 1000 }, { from: B, to: C, amount: 600 }, { from: B, to: A, amount: 500 }]);
    expect(settleWith(netsOf(balances), pairwise(balances, settlements, 'EUR'))).toEqual([]);
  });

  it('matches a payer’s own share first with several payers', () => {
    const balances = computeBalances({ tripCurrency: 'EUR', expenses: [exp({ amount: 10_000, payers: [{ who: A, amount: 6000 }, { who: B, amount: 4000 }], split: equal(A, B) })] });
    expect(pairwise(balances, [], 'EUR')).toEqual([{ from: B, to: A, amount: 1000 }]);
  });

  it('settles random ledgers exactly with both methods', () => {
    let seed = 7;
    const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    const pick = (list) => list[Math.floor(random() * list.length)];
    const people = [A, B, C, D, 'e'];
    for (let round = 0; round < 40; round++) {
      const expenses = [];
      const settlements = [];
      for (let i = 0; i < 12; i++) {
        const amount = Math.floor(random() * 50_000) + 1;
        const currency = pick(['EUR', 'USD', 'JPY']);
        const participants = people.filter(() => random() < 0.7);
        if (!participants.length) participants.push(A);
        const payerList = people.filter(() => random() < 0.3);
        if (!payerList.length) payerList.push(pick(people));
        const payerAmounts = spread(amount, payerList.map(() => Math.floor(random() * 9) + 1));
        const mode = pick(['equal', 'shares', 'amounts']);
        const parts = mode === 'equal' ? participants.map((who) => ({ who }))
          : mode === 'shares' ? participants.map((who) => ({ who, value: Math.floor(random() * 4) + 1 }))
            : spread(amount, participants.map(() => Math.floor(random() * 5) + 1)).map((value, index) => ({ who: participants[index], value }));
        if (random() < 0.3) parts[0].paid = 1;
        expenses.push(exp({ amount, currency, rate: currency === 'EUR' ? undefined : pick(['0.9', '1.0832', '0.0062', '0.333333']),
          payers: payerList.map((who, index) => ({ who, amount: payerAmounts[index] })), split: { mode, parts } }));
      }
      for (let i = 0; i < 3; i++) {
        const from = pick(people); const to = pick(people.filter((who) => who !== from));
        settlements.push({ id: `s${i}`, from, to, amount: Math.floor(random() * 5000) + 1, currency: pick(['EUR', 'USD']), rate: '1.1' });
      }
      const balances = computeBalances({ expenses, settlements, tripCurrency: 'EUR' });
      expect(balances.invalid).toEqual([]);
      const nets = netsOf(balances);
      expect(sum([...nets.values()])).toBe(0);
      const greedy = simplify(nets);
      expect(greedy.length).toBeLessThanOrEqual(Math.max(0, [...nets.values()].filter(Boolean).length - 1));
      expect(settleWith(nets, greedy)).toEqual([]);
      expect(settleWith(nets, pairwise(balances, settlements, 'EUR'))).toEqual([]);
    }
  });
});
