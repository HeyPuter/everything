// The pre-trip budget planner: planned amounts per cost category (and for the whole trip) against actual spend.
import { daysBetween, isDate } from '../../shared/dates.js';
import { add } from './ledger.js';

const byAge = (a, b) => (a.cr ?? 0) - (b.cr ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The budget entity per category (`cat` or '' for the trip), oldest first when several exist. */
export function budgetEntries(budgets = []) {
  const out = new Map();
  for (const budget of [...budgets].filter((item) => item && !item.deleted).sort(byAge)) {
    const key = typeof budget.cat === 'string' && budget.cat ? budget.cat : '';
    if (!out.has(key)) out.set(key, budget);
  }
  return out;
}

/** Duplicates that lost to an older entry for the same category (safe to delete). */
export function budgetDuplicates(budgets = []) {
  const winners = new Set([...budgetEntries(budgets).values()].map((budget) => budget.id));
  return budgets.filter((budget) => budget && !budget.deleted && !winners.has(budget.id));
}

/**
 * Where the trip is relative to `today`: `{phase: before|during|after|undated, days, left}`, `days` being the trip's
 * length and `left` the days still to spend (today included while travelling).
 */
export function tripTimeline(meta = {}, today) {
  if (!isDate(meta.start) || !isDate(today)) return { phase: 'undated', days: null, left: null };
  const end = isDate(meta.end) && meta.end >= meta.start ? meta.end : meta.start;
  const days = daysBetween(meta.start, end) + 1;
  if (today < meta.start) return { phase: 'before', days, left: days };
  if (today > end) return { phase: 'after', days, left: 0 };
  return { phase: 'during', days, left: daysBetween(today, end) + 1 };
}

/**
 * Planned against actual, in trip-currency minor units. `byCategory` and `spend` come from the balances (shared
 * expenses only, so every member sees the same plan). The trip total is its own budget when set, otherwise the sum
 * of the category budgets. Returns `{planned, spent, left, over, ratio, unallocated, categories, timeline, perDay}`;
 * `planned` is null when nothing is planned.
 */
export function budgetPlan({ budgets = [], byCategory = new Map(), spend = 0, categories = [], meta = {}, today } = {}) {
  const entries = budgetEntries(budgets);
  const total = entries.get('') ?? null;
  const planned = new Map([...entries].filter(([key]) => key));
  const catPlanned = [...planned.values()].reduce((sum, budget) => add(sum, budget.amount), 0);
  const plannedTotal = total ? total.amount : planned.size ? catPlanned : null;
  const order = [...new Set([...categories, ...planned.keys(), ...byCategory.keys()])];
  const rows = order.filter((cat) => planned.has(cat) || byCategory.get(cat)).map((cat) => {
    const amount = planned.get(cat)?.amount ?? null;
    const spent = byCategory.get(cat) ?? 0;
    return {
      cat, entity: planned.get(cat) ?? null, planned: amount, spent,
      left: amount === null ? null : amount - spent, over: amount !== null && spent > amount,
      ratio: amount ? spent / amount : null,
    };
  });
  const timeline = tripTimeline(meta, today);
  const left = plannedTotal === null ? null : plannedTotal - spend;
  return {
    total, planned: plannedTotal, spent: spend, left, over: left !== null && left < 0,
    ratio: plannedTotal ? spend / plannedTotal : null,
    unallocated: total && planned.size ? total.amount - catPlanned : null,
    categories: rows, timeline,
    perDay: left !== null && left > 0 && timeline.left ? Math.floor(left / timeline.left) : null,
  };
}
