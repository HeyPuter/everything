// Day arithmetic for Vacay: leave years, deductions, entitlement and carry-over. Dates are ISO `YYYY-MM-DD`.
import { addDays, isDate } from '../../shared/dates.js';

const pad = (value, size = 2) => String(value).padStart(size, '0');
const ymd = (year, month, day) => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
const monthLength = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
// Fractions are halves, so sums stay exact; rounding only guards against odd stored values.
const halves = (value) => Math.round(value * 2) / 2;
const EARLIEST_YEARS = 30;

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  return value.getUTCDay();
}

/** Month and day the leave year starts on. */
export function yearAnchor(plan) {
  if (plan?.yearType === 'fiscal' && Number.isInteger(plan.startMonth)) return { month: plan.startMonth, day: Number.isInteger(plan.startDay) ? plan.startDay : 1 };
  if (plan?.yearType === 'hire' && isDate(plan.hireDate)) { const [, month, day] = plan.hireDate.split('-').map(Number); return { month, day }; }
  return { month: 1, day: 1 };
}

// A 29 February or 31st anchor falls on the month's last day in shorter months.
const anchored = (year, { month, day }) => ymd(year, month, Math.min(day, monthLength(year, month)));

/** Leave year `year` (the calendar year it starts in): `{year, start, end}`. */
export function leaveYear(plan, year) {
  const anchor = yearAnchor(plan);
  return { year, start: anchored(year, anchor), end: addDays(anchored(year + 1, anchor), -1) };
}

/** The leave year containing `date`. */
export function leaveYearOf(plan, date) {
  const year = Number(date.slice(0, 4));
  return date >= leaveYear(plan, year).start ? year : year - 1;
}

/** Months a leave year touches, as `{year, month}` (1-based), in order. */
export function leaveMonths(plan, year) {
  const { start, end } = leaveYear(plan, year);
  const months = [];
  let y = Number(start.slice(0, 4)); let m = Number(start.slice(5, 7));
  const last = end.slice(0, 7);
  while (`${pad(y, 4)}-${pad(m)}` <= last) {
    months.push({ year: y, month: m });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

/** Every date of a month. */
export function monthDates(year, month) {
  return Array.from({ length: monthLength(year, month) }, (_, index) => ymd(year, month, index + 1));
}

/**
 * Why a date cannot hold a deducted vacation day: `weekend`, `holiday`, `company`, or null on a working day.
 * Weekends and public holidays are blocked; company days are bookable but not deducted.
 */
export function dayStatus(date, { weekendDays = [], holidays = new Set(), company = new Set() } = {}) {
  if (weekendDays.includes(weekday(date))) return 'weekend';
  if (holidays.has(date)) return 'holiday';
  if (company.has(date)) return 'company';
  return null;
}

/** True when a vacation or comp day may be placed on `date`. */
export const bookable = (date, context) => !['weekend', 'holiday'].includes(dayStatus(date, context));

/** Bookable dates from `from` to `to` in either order, at most `limit`. */
export function bookableRange(from, to, context, limit = 366) {
  const [start, end] = from <= to ? [from, to] : [to, from];
  const dates = [];
  for (let date = start; date <= end && dates.length < limit; date = addDays(date, 1)) if (bookable(date, context)) dates.push(date);
  return dates;
}

/**
 * Totals of `entries` (Map or object of date → {fraction, kind}) inside `[start, end]`:
 * `used` (deducted vacation), `comp` (comp days), `waived` (vacation on company days). Weekend and holiday entries count nowhere.
 */
export function usage(entries, { start, end, ...context }) {
  let used = 0; let comp = 0; let waived = 0;
  for (const [date, entry] of entries instanceof Map ? entries : Object.entries(entries ?? {})) {
    if (date < start || date > end || !entry) continue;
    const fraction = entry.fraction === 0.5 ? 0.5 : 1;
    const status = dayStatus(date, context);
    if (status === 'weekend' || status === 'holiday') continue;
    if (entry.kind === 'comp') comp += fraction;
    else if (status === 'company') waived += fraction;
    else used += fraction;
  }
  return { used: halves(used), comp: halves(comp), waived: halves(waived) };
}

/** Days granted for `year`: its own record, else the closest earlier year's, else 0. */
export function entitlement(allowances, year) {
  for (let y = year; y >= year - EARLIEST_YEARS; y--) {
    const days = allowances.get(y)?.days;
    if (Number.isFinite(days)) return days;
  }
  return 0;
}

/**
 * Balance of leave year `year`. `allowances` is a Map of year → {days, carried?}; `usedOf(y)` gives deducted days
 * in leave year y; `carryOver` caps days carried forward (0 = none). A stored `carried` overrides the computed one.
 * Computation starts at the earliest year with a record or with use (`firstYear`), so earlier years carry nothing.
 * Returns `{days, carried, total, used, remaining}`.
 */
export function balance(year, { allowances = new Map(), carryOver = 0, usedOf = () => 0, firstYear = year } = {}) {
  const records = [...allowances.keys()].filter((y) => y <= year);
  let from = Math.min(year, firstYear, ...records);
  from = Math.max(from, year - EARLIEST_YEARS);
  let carried = 0; let result = null;
  for (let y = from; y <= year; y++) {
    const stored = allowances.get(y)?.carried;
    const carriedIn = Number.isFinite(stored) ? stored : y === from ? 0 : carried;
    const days = entitlement(allowances, y);
    const used = usedOf(y);
    const total = halves(days + carriedIn);
    result = { days, carried: carriedIn, total, used, remaining: halves(total - used) };
    const cap = Number.isFinite(carryOver) && carryOver > 0 ? carryOver : 0;
    carried = halves(Math.min(cap, Math.max(0, result.remaining)));
  }
  return result;
}
