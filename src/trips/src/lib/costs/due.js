// Partial payments: an expense with a due date whose payers add up to less than the amount (data-model §3.1 `exp`).
import { invariant } from '../../shared/errors.js';
import { daysBetween, isDate } from '../../shared/dates.js';
import { validatePayers } from '../../shared/money.js';
import { add } from './ledger.js';

const paidOf = (exp) => exp.payers.reduce((sum, payer) => add(sum, payer.amount), 0);

/**
 * Expenses with a due date and something left to pay, soonest first: `{exp, paid, left, due, days, overdue}`
 * (amounts in the expense currency; `days` until the due date, negative once it passed).
 */
export function duePayments(expenses, { today }) {
  const out = [];
  for (const exp of expenses) {
    if (!exp || exp.deleted || !isDate(exp.due)) continue;
    try { validatePayers(exp.amount, exp.payers, { partial: true }); } catch { continue; }
    const paid = paidOf(exp);
    const left = exp.amount - paid;
    if (!left) continue;
    const days = isDate(today) ? daysBetween(today, exp.due) : 0;
    out.push({ exp, paid, left, due: exp.due, days, overdue: days < 0 });
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.exp.id < b.exp.id ? -1 : 1));
}

/** True when the expense still has an unpaid part with a due date. */
export const isPartial = (exp) => isDate(exp?.due) && exp.payers.length > 0 && paidOf(exp) !== exp.amount;

/**
 * The patch that records `amount` more paid by `who` (minor units, in the expense currency). Once everything is paid
 * the due date goes. Throws `payer_total` when the payment is more than what is left.
 */
export function paymentPatch(exp, { who, amount }) {
  invariant(typeof who === 'string' && who && Number.isSafeInteger(amount) && amount !== 0 && (amount < 0) === (exp.amount < 0), 'invalid_amount');
  const payers = exp.payers.map((payer) => ({ ...payer }));
  const existing = payers.find((payer) => payer.who === who);
  if (existing) existing.amount = add(existing.amount, amount); else payers.push({ who, amount });
  validatePayers(exp.amount, payers, { partial: true });
  const done = paidOf({ payers }) === exp.amount;
  return { set: { payers }, unset: done && exp.due !== undefined ? ['due'] : [] };
}

/**
 * The patch that sets a payment plan: `payers` paid so far (may be empty) and the date the rest is due. Paying in
 * full clears the due date instead.
 */
export function planPatch(exp, { payers, due }) {
  invariant(isDate(due), 'invalid_date');
  validatePayers(exp.amount, payers, { partial: true });
  const clean = payers.filter((payer) => payer.amount !== 0).map(({ who, amount }) => ({ who, amount }));
  if (paidOf({ payers: clean }) === exp.amount) return { set: { payers: clean }, unset: exp.due !== undefined ? ['due'] : [] };
  return { set: { payers: clean, due }, unset: [] };
}
