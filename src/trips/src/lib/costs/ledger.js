import { invariant } from '../../shared/errors.js';
import { allocate, convertMinor, roundRatio, splitAmount, validatePayers } from '../../shared/money.js';

const abs = (value) => (value < 0 ? -value : value);
const byWho = (a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : 0);

/** Integer addition that refuses to leave the safe range. */
export function add(a, b) {
  const sum = a + b;
  invariant(Number.isSafeInteger(sum), 'money_overflow');
  return sum;
}

/** `same` in the trip currency, `frozen` with a stored rate, otherwise `pending` (waiting for a rate). */
export function rateState(entity, tripCurrency) {
  if (entity.currency === tripCurrency) return 'same';
  return typeof entity.rate === 'string' ? 'frozen' : 'pending';
}

/** Minor units of the trip currency through the frozen rate, or null while the rate is pending. */
export function toTrip(amount, entity, tripCurrency) {
  const state = rateState(entity, tripCurrency);
  if (state === 'same') return amount;
  if (state === 'pending') return null;
  return convertMinor(amount, entity.rate, entity.currency, tripCurrency);
}

/** Splits `total` in proportion to `weights` (signs ignored); the parts always add up to `total`. */
export function spread(total, weights, seed = '') {
  if (!weights.length) return [];
  if (total === 0 || weights.every((weight) => weight === 0)) return weights.map(() => 0);
  return allocate(total, weights.map(abs), { seed });
}

/**
 * Shares, payments and paid-back amounts of one expense scaled to `total` minor units. With `total` equal to the
 * expense amount the values are the expense's own; with a converted total they are the trip-currency values.
 * A participant's `paid` goes to the other payers in proportion to what they paid.
 */
function distribute(exp, shares, total) {
  const shareValues = spread(total, shares.map((share) => share.amount), exp.id);
  const payerValues = spread(total, exp.payers.map((payer) => payer.amount), exp.id);
  const repaid = [];
  exp.split.parts.forEach((part, index) => {
    const share = shares[index].amount;
    if (!part.paid || !share) return;
    const others = exp.payers.map((payer, at) => ({ who: payer.who, weight: payerValues[at] }))
      .filter((payer) => payer.who !== part.who && payer.weight !== 0);
    if (!others.length) return;
    const amount = abs(part.paid) >= abs(share) ? shareValues[index]
      : Number(roundRatio(BigInt(shareValues[index]) * BigInt(abs(part.paid)), BigInt(abs(share))));
    spread(amount, others.map((payer) => payer.weight), `${exp.id}:${part.who}`)
      .forEach((value, at) => { if (value) repaid.push({ from: part.who, to: others[at].who, amount: value }); });
  });
  return {
    shares: shares.map((share, index) => ({ who: share.who, amount: shareValues[index] })),
    payers: exp.payers.map((payer, index) => ({ who: payer.who, amount: payerValues[index] })),
    repaid,
  };
}

/**
 * One expense in its own currency (`own`) and in the trip currency (`trip`, null while the rate is pending).
 * `balance` is what counts toward balances: `trip`, or for a partial payment (payers below the amount, with a due
 * date) only the paid part, with the rest in `due` and `dueShares`. Throws for an expense whose payers or split do
 * not add up.
 */
export function expenseView(exp, tripCurrency) {
  validatePayers(exp.amount, exp.payers, { partial: Boolean(exp.due) });
  const shares = splitAmount(exp.amount, exp.split, { expenseId: exp.id });
  const total = toTrip(exp.amount, exp, tripCurrency);
  const paidOwn = exp.payers.reduce((sum, payer) => add(sum, payer.amount), 0);
  const partial = exp.payers.length > 0 && paidOwn !== exp.amount;
  const trip = total === null ? null : distribute(exp, shares, total);
  let balance = trip; let paid = total; let due = 0; let dueShares = [];
  if (partial && total !== null) {
    [paid, due] = spread(total, [paidOwn, exp.amount - paidOwn], exp.id);
    balance = distribute(exp, shares, paid);
    dueShares = spread(due, shares.map((share) => share.amount), exp.id).map((amount, index) => ({ who: shares[index].who, amount }));
  }
  return {
    exp,
    total,
    own: distribute(exp, shares, exp.amount),
    trip,
    balance,
    pending: total === null,
    unpaid: exp.payers.length === 0,
    partial,
    paid,
    due,
    dueShares,
  };
}

/** What one person gains (positive) or owes (negative) on one distributed expense. */
export function positionOf(values, who) {
  let net = 0;
  for (const payer of values.payers) if (payer.who === who) net = add(net, payer.amount);
  for (const share of values.shares) if (share.who === who) net = add(net, -share.amount);
  for (const item of values.repaid) {
    if (item.from === who) net = add(net, item.amount);
    if (item.to === who) net = add(net, -item.amount);
  }
  return net;
}

const blank = (who) => ({ who, paid: 0, share: 0, unpaidShare: 0, repaid: 0, repaidTo: 0, sent: 0, received: 0, net: 0 });

/**
 * Balances in the trip currency. `net = paid − share + repaid − repaidTo + sent − received`; the nets always sum to
 * zero. Unpaid expenses, and the unpaid rest of partial payments (`due`), count toward spend and `unpaidShare` only.
 * Pending rates and invalid entries are listed and left out.
 */
export function computeBalances({ expenses = [], settlements = [], tripCurrency }) {
  const people = new Map();
  const person = (who) => {
    if (!people.has(who)) people.set(who, blank(who));
    return people.get(who);
  };
  const views = new Map();
  const byCategory = new Map();
  const pending = { expenses: [], settlements: [] };
  const invalid = [];
  let spend = 0;
  let unpaid = 0;
  let due = 0;
  for (const exp of expenses) {
    let view;
    try { view = expenseView(exp, tripCurrency); } catch { invalid.push(exp.id); continue; }
    views.set(exp.id, view);
    if (view.pending) { pending.expenses.push(exp.id); continue; }
    spend = add(spend, view.total);
    const cat = exp.cat || 'other';
    byCategory.set(cat, add(byCategory.get(cat) ?? 0, view.total));
    if (view.unpaid) {
      unpaid = add(unpaid, view.total);
      for (const share of view.trip.shares) person(share.who).unpaidShare = add(person(share.who).unpaidShare, share.amount);
      continue;
    }
    for (const payer of view.balance.payers) person(payer.who).paid = add(person(payer.who).paid, payer.amount);
    for (const share of view.balance.shares) person(share.who).share = add(person(share.who).share, share.amount);
    for (const item of view.balance.repaid) {
      person(item.from).repaid = add(person(item.from).repaid, item.amount);
      person(item.to).repaidTo = add(person(item.to).repaidTo, item.amount);
    }
    due = add(due, view.due);
    for (const share of view.dueShares) person(share.who).unpaidShare = add(person(share.who).unpaidShare, share.amount);
  }
  for (const settle of settlements) {
    let amount;
    try { amount = toTrip(settle.amount, settle, tripCurrency); } catch { invalid.push(settle.id); continue; }
    if (amount === null) { pending.settlements.push(settle.id); continue; }
    person(settle.from).sent = add(person(settle.from).sent, amount);
    person(settle.to).received = add(person(settle.to).received, amount);
  }
  for (const entry of people.values()) {
    entry.net = [entry.paid, -entry.share, entry.repaid, -entry.repaidTo, entry.sent, -entry.received].reduce(add, 0);
  }
  return { people, views, byCategory, pending, invalid, spend, unpaid, due };
}

/** Card totals for one viewer: what they owe, are owed, the group's outstanding total and spend. */
export function summary(balances, who) {
  const net = balances.people.get(who)?.net ?? 0;
  let outstanding = 0;
  for (const entry of balances.people.values()) if (entry.net > 0) outstanding = add(outstanding, entry.net);
  return { owe: net < 0 ? -net : 0, owed: net > 0 ? net : 0, outstanding, spend: balances.spend };
}

/**
 * Greedy debt simplification: the largest debtor pays the largest creditor until everyone is even. Ties break by
 * person id so every client suggests the same transfers. At most n − 1 transfers.
 */
export function simplify(nets) {
  const credit = [];
  const debt = [];
  for (const [who, net] of nets) {
    if (net > 0) credit.push({ who, amount: net });
    else if (net < 0) debt.push({ who, amount: -net });
  }
  const order = (a, b) => b.amount - a.amount || byWho(a, b);
  const transfers = [];
  while (credit.length && debt.length) {
    credit.sort(order); debt.sort(order);
    const [to] = credit; const [from] = debt;
    const amount = Math.min(to.amount, from.amount);
    transfers.push({ from: from.who, to: to.who, amount });
    to.amount -= amount; from.amount -= amount;
    if (!to.amount) credit.shift();
    if (!from.amount) debt.shift();
  }
  return transfers;
}

/** Map of person id to net balance. */
export const netsOf = (balances) => new Map([...balances.people.values()].map((entry) => [entry.who, entry.net]));

/**
 * Who owes whom without simplification: each participant owes the payers of each expense (their own payment
 * first, then in id order), paid-back shares and settlements offset those debts, and each pair is netted.
 * Each person's transfers still add up to their net balance.
 */
export function pairwise(balances, settlements = [], tripCurrency) {
  const owed = new Map();
  const note = (from, to, amount) => {
    if (from === to || !amount) return;
    const key = `${from}\n${to}`;
    owed.set(key, add(owed.get(key) ?? 0, amount));
  };
  for (const view of balances.views.values()) {
    if (view.pending || view.unpaid) continue;
    const refund = view.total < 0;
    const need = view.balance.shares.map((share) => ({ who: share.who, left: abs(share.amount) })).sort(byWho);
    const have = view.balance.payers.map((payer) => ({ who: payer.who, left: abs(payer.amount) })).sort(byWho);
    for (const item of need) {
      const self = have.find((payer) => payer.who === item.who);
      if (!self) continue;
      const amount = Math.min(item.left, self.left);
      item.left -= amount; self.left -= amount;
    }
    for (let i = 0, j = 0; i < need.length && j < have.length;) {
      if (!need[i].left) { i++; continue; }
      if (!have[j].left) { j++; continue; }
      const amount = Math.min(need[i].left, have[j].left);
      if (refund) note(have[j].who, need[i].who, amount); else note(need[i].who, have[j].who, amount);
      need[i].left -= amount; have[j].left -= amount;
    }
    for (const item of view.balance.repaid) {
      if (item.amount > 0) note(item.to, item.from, item.amount); else note(item.from, item.to, -item.amount);
    }
  }
  for (const settle of settlements) {
    let amount;
    try { amount = toTrip(settle.amount, settle, tripCurrency); } catch { continue; }
    if (amount !== null) note(settle.to, settle.from, amount);
  }
  const transfers = [];
  const seen = new Set();
  for (const key of owed.keys()) {
    const [a, b] = key.split('\n');
    const pair = a < b ? `${a}\n${b}` : `${b}\n${a}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const net = add(owed.get(`${a}\n${b}`) ?? 0, -(owed.get(`${b}\n${a}`) ?? 0));
    if (net > 0) transfers.push({ from: a, to: b, amount: net });
    else if (net < 0) transfers.push({ from: b, to: a, amount: -net });
  }
  return transfers.sort((x, y) => y.amount - x.amount || (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : 1));
}

/** Spend of expenses outside the balances (private ones), in the trip currency, with pending ones listed. */
export function spendOf(expenses, tripCurrency) {
  let total = 0;
  const byCategory = new Map();
  const pending = [];
  for (const exp of expenses) {
    let amount;
    try { amount = toTrip(exp.amount, exp, tripCurrency); } catch { continue; }
    if (amount === null) { pending.push(exp.id); continue; }
    total = add(total, amount);
    const cat = exp.cat || 'other';
    byCategory.set(cat, add(byCategory.get(cat) ?? 0, amount));
  }
  return { total, byCategory, pending };
}
