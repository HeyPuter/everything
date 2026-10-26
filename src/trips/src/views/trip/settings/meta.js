// Trip meta helpers shared by the dashboard, the trip shell and the trip settings tab.
import { t } from '../../../lib/i18n/index.js';
import { formatDateRange } from '../../../lib/format.js';
import { displayLocale } from '../../../lib/prefs.js';
import { addDays, daysBetween, isDate, localDate as today } from '../../../shared/dates.js';

const plural = new Intl.PluralRules('en');
/** `key` for most counts, `${key}One` for one. */
export const countText = (key, count) => t(plural.select(count) === 'one' ? `${key}One` : key, { count });

/** A reminder choice: days before the start, 0 being the first day. */
export const reminderLabel = (days) => (days === 0 ? t('trip.reminderSameDay') : countText('trip.reminderDays', days));

export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 999;

export { today };

/** A trip is dated only when both ends are set; otherwise it has `dayCount` undated days. */
export const isDated = (meta) => Boolean(meta && isDate(meta.start) && isDate(meta.end));
export function dayTotal(meta) {
  return isDated(meta) ? daysBetween(meta.start, meta.end) + 1 : meta?.dayCount ?? DEFAULT_DAYS;
}

/** Trip subtitle: date range, a single date, or the number of undated days. */
export function tripDates(meta) {
  if (!meta) return '';
  if (isDated(meta)) return formatDateRange(meta.start, meta.end);
  const single = meta.start || meta.end;
  if (single) return `${formatDateRange(single, single)} · ${countText('trip.undatedDays', meta.dayCount ?? DEFAULT_DAYS)}`;
  return countText('trip.undatedDays', meta.dayCount ?? DEFAULT_DAYS);
}

/** `ongoing|upcoming|past|undated` relative to `day` (`YYYY-MM-DD`). */
export function tripStatus(meta, day = today()) {
  const start = isDate(meta?.start) ? meta.start : null;
  const end = isDate(meta?.end) ? meta.end : start ? addDays(start, Math.max(0, (meta.dayCount ?? DEFAULT_DAYS) - 1)) : null;
  if (!start && !end) return 'undated';
  if (start && day < start) return 'upcoming';
  if (end && day > end) return 'past';
  return start ? 'ongoing' : 'upcoming';
}

/** Sort key: ongoing, then upcoming by start, then undated, then past by most recent end. */
export function compareTrips(a, b, day = today()) {
  const rank = { ongoing: 0, upcoming: 1, undated: 2, past: 3 };
  const sa = tripStatus(a, day); const sb = tripStatus(b, day);
  if (sa !== sb) return rank[sa] - rank[sb];
  if (sa === 'past') return (b.end ?? b.start ?? '').localeCompare(a.end ?? a.start ?? '');
  if (sa === 'undated') return (a.title ?? '').localeCompare(b.title ?? '');
  return (a.start ?? a.end ?? '').localeCompare(b.start ?? b.end ?? '');
}

let currencyNames;
/** `EUR · Euro` in the display language. */
export function currencyName(code) {
  try { currencyNames ??= new Intl.DisplayNames([displayLocale()], { type: 'currency' }); return `${code} · ${currencyNames.of(code) ?? code}`; } catch { return code; }
}
