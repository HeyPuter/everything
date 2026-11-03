// One payment split across several trips (data-model §3.1 `exp.across`): each trip keeps an expense for its part.
import { invariant } from '../../shared/errors.js';
import { daysBetween, isDate } from '../../shared/dates.js';
import { roundRatio, splitAmount, validatePayers } from '../../shared/money.js';
import { validateEntity } from '../../shared/schema/index.js';
import { isBuiltinCategory } from './categories.js';
import { add, spread } from './ledger.js';

export const ACROSS_MAX = 20;
const abs = (value) => (value < 0 ? -value : value);
const sum = (list) => list.reduce((total, value) => add(total, value), 0);

/** Days in a trip from its cached dates, else 1, for splitting by length. */
export function tripDays(entry) {
  if (!isDate(entry?.start)) return 1;
  const end = isDate(entry.end) && entry.end >= entry.start ? entry.end : entry.start;
  return Math.min(999, daysBetween(entry.start, end) + 1);
}

/** Splits `total` over trips: `equal`, `days` (by trip length) or `amounts` (`values`, which must add up). */
export function allocateAcross(total, trips, { mode = 'equal', values = [], seed = '' } = {}) {
  invariant(Number.isSafeInteger(total) && total !== 0 && trips.length >= 2 && trips.length <= ACROSS_MAX, 'invalid_across');
  if (mode === 'amounts') {
    invariant(values.length === trips.length && values.every((value) => Number.isSafeInteger(value) && (value < 0) === (total < 0) && value !== 0) && sum(values) === total, 'across_total');
    return [...values];
  }
  const weights = mode === 'days' ? trips.map(tripDays) : trips.map(() => 1);
  return spread(total, weights, seed);
}

/** Paid-back markers kept within the new shares: scaled with the share and never beyond it. */
function refit(parts, oldShares, newShares) {
  return parts.map((part, index) => {
    if (!part.paid) return part;
    const { paid, ...rest } = part;
    const before = oldShares[index]?.amount ?? 0; const after = newShares[index]?.amount ?? 0;
    if (!before || !after || (after < 0) !== (paid < 0)) return rest;
    const scaled = abs(paid) >= abs(before) ? after : Number(roundRatio(BigInt(after) * BigInt(paid), BigInt(before)));
    return scaled ? { ...rest, paid: abs(scaled) > abs(after) ? after : scaled } : rest;
  });
}

/**
 * Payers and split of `exp` for a new `amount`, keeping everyone's proportions: payers (and the paid part of a partial
 * payment) are scaled, equal/percent/shares splits stay, amount and item splits are scaled to add up.
 */
export function scaleExpense(exp, amount) {
  invariant(Number.isSafeInteger(amount) && amount !== 0 && (amount < 0) === (exp.amount < 0), 'invalid_amount');
  const paid = sum(exp.payers.map((payer) => payer.amount));
  const partial = exp.payers.length > 0 && paid !== exp.amount;
  const newPaid = !exp.payers.length ? 0 : partial ? spread(amount, [paid, exp.amount - paid], exp.id)[0] : amount;
  const payers = exp.payers.length ? spread(newPaid, exp.payers.map((payer) => payer.amount), exp.id).map((value, index) => ({ who: exp.payers[index].who, amount: value })) : [];
  const split = structuredClone(exp.split);
  if (split.mode === 'amounts') {
    spread(amount, split.parts.map((part) => part.value), exp.id).forEach((value, index) => { split.parts[index].value = value; });
  } else if (split.mode === 'items') {
    spread(amount, split.items.map((item) => item.amount), exp.id).forEach((value, index) => { split.items[index].amount = value; });
  }
  const oldShares = splitAmount(exp.amount, exp.split, { expenseId: exp.id });
  const plain = { ...split, parts: split.parts.map(({ paid: _paid, ...rest }) => rest) };
  const newShares = splitAmount(amount, plain, { expenseId: exp.id });
  split.parts = refit(split.parts, oldShares, newShares);
  validatePayers(amount, payers, { partial: Boolean(exp.due) && partial });
  return { payers, split };
}

/**
 * An expense for another trip's part. `mapPerson(who)` gives the person's id in that trip or null; people who are
 * not there drop out, and when nobody is left `me` (a member of both) pays and carries the share. Payers keep their
 * proportions, splits become shares by each person's old weight, paid-back markers are dropped, links stay behind.
 * The rate is kept only when both trips use the same currency; otherwise it is pending.
 */
export function acrossCopy(exp, { amount, across, mapPerson, me, sourceCurrency, targetCurrency }) {
  invariant(Number.isSafeInteger(amount) && amount !== 0, 'invalid_amount');
  const fields = { name: exp.name, amount, currency: exp.currency, across };
  if (exp.date !== undefined) fields.date = exp.date;
  if (exp.note) fields.note = exp.note;
  fields.cat = isBuiltinCategory(exp.cat) ? exp.cat : 'other';
  if (exp.currency !== targetCurrency) fields.rate = sourceCurrency === targetCurrency && typeof exp.rate === 'string' ? exp.rate : null;
  const paid = sum(exp.payers.map((payer) => payer.amount));
  const partial = exp.payers.length > 0 && paid !== exp.amount;
  if (!exp.payers.length) fields.payers = [];
  else {
    const newPaid = partial ? spread(amount, [paid, exp.amount - paid], exp.id)[0] : amount;
    const mapped = exp.payers.map((payer) => ({ who: mapPerson(payer.who), weight: payer.amount })).filter((payer) => payer.who);
    const merged = new Map();
    for (const payer of mapped) merged.set(payer.who, add(merged.get(payer.who) ?? 0, payer.weight));
    const list = merged.size ? [...merged] : [[me, 1]];
    fields.payers = spread(newPaid, list.map(([, weight]) => weight), exp.id).map((value, index) => ({ who: list[index][0], amount: value }));
    if (partial) fields.due = exp.due;
  }
  let shares;
  try { shares = splitAmount(exp.amount, exp.split, { expenseId: exp.id }); } catch { shares = []; }
  const weights = new Map();
  for (const share of shares) {
    const who = mapPerson(share.who);
    if (who) weights.set(who, add(weights.get(who) ?? 0, abs(share.amount)));
  }
  const kept = [...weights].filter(([, weight]) => weight > 0);
  fields.split = kept.length ? { mode: 'shares', parts: kept.map(([who, weight]) => ({ who, value: weight })) } : { mode: 'equal', parts: [{ who: me }] };
  if (exp.split.mode === 'equal' && kept.length) fields.split = { mode: 'equal', parts: kept.map(([who]) => ({ who })) };
  validateEntity('trip', 'exp', fields);
  return fields;
}

/**
 * The plan for splitting `exp` (in the trip `here`) across `trips` (`[{ref, title, currency, mapPerson}]`, `here`
 * first) by `parts` amounts. Returns `{across, source: {set}, copies: [{ref, id, opId, fields}]}`; ids come from `makeId`.
 */
export function planAcross(exp, { here, trips, parts, me, makeId }) {
  invariant(trips.length === parts.length && trips[0].ref.s === here.ref.s, 'invalid_across');
  const across = {
    group: makeId(), total: exp.amount,
    parts: trips.map((trip, index) => ({ w: trip.ref.w, s: trip.ref.s, ...(trip.title ? { title: String(trip.title).slice(0, 500) } : {}), amount: parts[index] })),
  };
  const scaled = scaleExpense(exp, parts[0]);
  const source = { set: { amount: parts[0], payers: scaled.payers, split: scaled.split, across } };
  const copies = trips.slice(1).map((trip, index) => ({
    ref: trip.ref, id: makeId(), opId: makeId(),
    fields: acrossCopy(exp, { amount: parts[index + 1], across, mapPerson: trip.mapPerson, me, sourceCurrency: here.currency, targetCurrency: trip.currency }),
  }));
  validateEntity('trip', 'exp', { ...stripStamps(exp), ...source.set });
  return { across, source, copies };
}

function stripStamps(entity) {
  const { id: _id, v: _v, rev: _rev, upd: _upd, by: _by, cr: _cr, t: _t, private: _private, ...fields } = entity;
  return fields;
}

/** Whether this trip's copy still matches its recorded part. */
export const acrossDrift = (exp, spaceId) => {
  const part = exp?.across?.parts?.find((item) => item.s === spaceId);
  return part ? part.amount !== exp.amount : false;
};
