import { isDate } from '../../shared/dates.js';

// Weekly tables come from `parseOpeningHours` (services/hours.js): `{su: ['09:00-17:00'], mo: [...], ...}`.
const DAY_KEYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const RANGE = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

function spans(week, index) {
  const list = week[DAY_KEYS[(index + 7) % 7]];
  if (!Array.isArray(list)) return [];
  return list.flatMap((range) => {
    const match = RANGE.exec(range);
    if (!match) return [];
    const from = Number(match[1]) * 60 + Number(match[2]);
    const to = Number(match[3]) * 60 + Number(match[4]);
    return from < 1440 && to <= 1440 ? [[from, to <= from ? to + 1440 : to]] : [];
  });
}

/** Open ranges in minutes from local midnight of `date`: last night's tail, the day's own and the next day's. */
export function openRanges(week, date) {
  if (!week || !isDate(date)) return null;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const ranges = [
    ...spans(week, day - 1).map(([from, to]) => [from - 1440, to - 1440]).filter(([, to]) => to > 0),
    ...spans(week, day),
    ...spans(week, day + 1).map(([from, to]) => [from + 1440, to + 1440]),
  ].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [from, to] of ranges) {
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/**
 * Whether a place is open for a whole visit from `start` to `end` (minutes from local midnight of `date`; `end` may
 * pass 1440). `{open: true|false|null, opens}`: null without a table or date; `opens` is the first later opening
 * that day long enough for the visit, or null.
 */
export function openDuring(week, date, start, end) {
  const ranges = openRanges(week, date);
  if (!ranges) return { open: null, opens: null };
  const length = Math.max(0, end - start);
  const open = ranges.some(([from, to]) => from <= start && start < to && start + length <= to);
  if (open) return { open: true, opens: null };
  const later = ranges.find(([from, to]) => from > start && from < 1440 && from + length <= to);
  return { open: false, opens: later ? later[0] : null };
}
