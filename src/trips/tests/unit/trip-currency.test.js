import { describe, expect, it } from 'vitest';
import { currencyOps, errorKey } from '../../src/views/trip/settings/actions.js';
import { computeBalances, spendOf } from '../../src/lib/costs/ledger.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const exp = (id, amount, currency, rate) => ({ id, name: id, amount, currency, ...(rate !== undefined ? { rate } : {}), payers: [{ who: A, amount }], split: { mode: 'equal', parts: [{ who: A }, { who: B }] } });

function stubSpace({ exps = [], settles = [], own = [], can = () => true } = {}) {
  return {
    query: (type, { includePrivate } = {}) => (type === 'exp' ? [...exps, ...(includePrivate ? own.map((item) => ({ ...item, private: true })) : [])] : type === 'settle' ? settles : []),
    privateItems: () => ({}),
    can,
    ops: { patch: (t, id, change) => ({ t, id, ...change }) },
  };
}
// 1 EUR = 1.25 USD, 1 EUR = 0.85 GBP.
const services = { fx: { rates: async () => ({ data: { base: 'EUR', rates: { USD: 1.25, GBP: 0.85 } } }) } };

describe('trip currency change', () => {
  it('re-bases expenses and settlements with one pinned rate and leaves pending rates pending', async () => {
    const space = stubSpace({
      exps: [exp('e1', 1000, 'EUR'), exp('e2', 1000, 'USD', '0.8'), exp('e3', 1000, 'GBP', '1.2'), exp('e4', 1000, 'JPY', null)],
      settles: [{ id: 's1', from: B, to: A, amount: 500, currency: 'EUR' }, { id: 's2', from: B, to: A, amount: 200, currency: 'USD', rate: '0.8' }],
      own: [exp('p1', 300, 'EUR'), exp('p2', 300, 'USD', '0.8')],
    });
    const { ops, privatePatches } = await currencyOps(space, services, 'EUR', 'USD');
    expect(ops).toEqual([
      { t: 'exp', id: 'e1', set: { rate: '1.25' } },
      { t: 'exp', id: 'e2', unset: ['rate'] },
      { t: 'exp', id: 'e3', set: { rate: '1.5' } },
      { t: 'settle', id: 's1', set: { rate: '1.25' } },
      { t: 'settle', id: 's2', unset: ['rate'] },
    ]);
    expect(privatePatches).toEqual([{ id: 'p1', rate: '1.25' }, { id: 'p2', rate: undefined }]);
  });

  it('keeps totals in value: the new spend is the old one at the pinned rate', async () => {
    const before = [exp('e1', 1000, 'EUR'), exp('e3', 2000, 'GBP', '1.2')];
    const { ops } = await currencyOps(stubSpace({ exps: before }), services, 'EUR', 'USD');
    const after = before.map((item) => ({ ...item, ...ops.find((op) => op.id === item.id)?.set }));
    expect(spendOf(before, 'EUR').total).toBe(3400);
    expect(spendOf(after, 'USD')).toMatchObject({ total: 4250, pending: [] });
    const balances = computeBalances({ expenses: after, tripCurrency: 'USD' });
    expect(balances.people.get(B).net).toBe(-2125);
  });

  it('needs costs.edit when the trip has shared expenses or settlements', async () => {
    const space = stubSpace({ settles: [{ id: 's1', from: B, to: A, amount: 500, currency: 'EUR' }], can: (action) => action !== 'costs.edit' });
    await expect(currencyOps(space, services, 'EUR', 'USD')).rejects.toMatchObject({ code: 'currency_needs_costs' });
    expect(errorKey({ code: 'currency_needs_costs', status: 403 })).toBe('trip.errorCurrencyCosts');
    expect(await currencyOps(stubSpace({ can: () => false }), services, 'EUR', 'USD')).toEqual({ ops: [], privatePatches: [] });
  });
});
