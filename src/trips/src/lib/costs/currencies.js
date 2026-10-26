// Balances kept apart per currency: each currency's expenses and payments settle among themselves, with no rates.
import { isCurrency } from '../../shared/money.js';
import { computeBalances, netsOf, simplify } from './ledger.js';

/**
 * One entry per currency in use: `{currency, balances, nets, transfers}`, where amounts are in that currency and
 * `transfers` is the greedy settle-up. The trip currency comes first, then the others by spend.
 */
export function balancesByCurrency({ expenses = [], settlements = [], tripCurrency } = {}) {
  const groups = new Map();
  const group = (currency) => {
    if (!groups.has(currency)) groups.set(currency, { expenses: [], settlements: [] });
    return groups.get(currency);
  };
  for (const exp of expenses) if (exp && !exp.deleted && isCurrency(exp.currency)) group(exp.currency).expenses.push(exp);
  for (const settle of settlements) if (settle && !settle.deleted && isCurrency(settle.currency)) group(settle.currency).settlements.push(settle);
  const out = [...groups].map(([currency, items]) => {
    // In its own currency every amount is "same", so no rate is ever read.
    const balances = computeBalances({ ...items, tripCurrency: currency });
    const nets = netsOf(balances);
    return { currency, balances, nets, transfers: simplify(nets) };
  });
  const spend = (entry) => Math.abs(entry.balances.spend);
  return out.sort((a, b) => (a.currency === tripCurrency ? -1 : b.currency === tripCurrency ? 1
    : spend(b) - spend(a) || (a.currency < b.currency ? -1 : 1)));
}

/** True when more than one currency has someone who owes or is owed. */
export const hasSeveralCurrencies = (entries) => entries.filter((entry) => [...entry.nets.values()].some((net) => net !== 0)).length > 1;
