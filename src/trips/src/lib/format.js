import { prefs, displayLocale, localeRegion } from './prefs.js';
import { formatMoney as moneyString } from '../shared/money.js';
import { isDate, isTime, zonedParts } from '../shared/dates.js';

/**
 * Display formatting per the user's preferences. Every helper takes optional `{prefs, locale}` overrides;
 * by default it reads `prefs()` and the browser locale. Inputs are canonical: meters, °C, grams, minor units,
 * ISO dates (`YYYY-MM-DD`) and 24-hour times (`HH:mm`).
 */
const METERS_PER_MILE = 1609.344;
const GRAMS_PER_POUND = 453.59237;
const GRAMS_PER_OUNCE = 28.349523125;
const SUNDAY_FIRST = new Set(['US', 'CA', 'MX', 'BR', 'JP', 'KR', 'TW', 'HK', 'IL', 'PH', 'ZA', 'SA', 'IN', 'ID', 'TH', 'AR', 'CO', 'PE', 'VE', 'GT', 'PA', 'DO', 'PR']);
const cache = new Map();

function cached(kind, locale, options) {
  const key = `${kind}|${locale}|${JSON.stringify(options)}`;
  let value = cache.get(key);
  if (!value) {
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    value = kind === 'n' ? new Intl.NumberFormat(locale, options) : new Intl.DateTimeFormat(locale, options);
    cache.set(key, value);
  }
  return value;
}
function context(options = {}) { return { p: options.prefs ?? prefs(), locale: options.locale ?? displayLocale() }; }
const zero = (value) => (Object.is(value, -0) ? 0 : value);
function round(value, digits) { const factor = 10 ** digits; return zero(Math.round(value * factor) / factor); }
function unit(locale, name, value, digits) {
  return cached('n', locale, { style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: digits }).format(round(value, digits));
}

export function formatNumber(value, options = {}) {
  const { locale } = context(options);
  return Number.isFinite(value) ? cached('n', locale, { maximumFractionDigits: options.digits ?? 2 }).format(zero(value)) : '';
}

/** Meters as km/m or mi/ft. */
export function formatDistance(meters, options = {}) {
  if (!Number.isFinite(meters)) return '';
  const { p, locale } = context(options);
  if ((options.unit ?? p.distanceUnit) === 'mi') {
    const miles = Math.abs(meters) / METERS_PER_MILE;
    if (miles < 0.1) return unit(locale, 'foot', Math.sign(meters) * Math.round(Math.abs(meters) * 3.28084 / 10) * 10, 0);
    return unit(locale, 'mile', meters / METERS_PER_MILE, miles < 10 ? 1 : 0);
  }
  if (Math.abs(meters) < 1000) return unit(locale, 'meter', Math.abs(meters) < 100 ? meters : Math.round(meters / 10) * 10, 0);
  return unit(locale, 'kilometer', meters / 1000, Math.abs(meters) < 10_000 ? 1 : 0);
}

export const toFahrenheit = (celsius) => celsius * 9 / 5 + 32;
/** °C in, °C or °F out. */
export function formatTemperature(celsius, options = {}) {
  if (!Number.isFinite(celsius)) return '';
  const { p, locale } = context(options);
  const fahrenheit = (options.unit ?? p.tempUnit) === 'f';
  return unit(locale, fahrenheit ? 'fahrenheit' : 'celsius', fahrenheit ? toFahrenheit(celsius) : celsius, options.digits ?? 0);
}

/** Grams as g/kg or oz/lb. */
export function formatWeight(grams, options = {}) {
  if (!Number.isFinite(grams)) return '';
  const { p, locale } = context(options);
  if ((options.unit ?? p.weightUnit) === 'lb') {
    if (Math.abs(grams) < GRAMS_PER_POUND) { const ounces = grams / GRAMS_PER_OUNCE; return unit(locale, 'ounce', ounces, Math.abs(ounces) < 10 ? 1 : 0); }
    return unit(locale, 'pound', grams / GRAMS_PER_POUND, 1);
  }
  if (Math.abs(grams) < 1000) return unit(locale, 'gram', grams, 0);
  return unit(locale, 'kilogram', grams / 1000, Math.abs(grams) < 100_000 ? 1 : 0);
}
/** Grams as a number in kg or lb for an input field. */
export function weightValue(grams, options = {}) {
  const { p } = context(options);
  return round(grams / ((options.unit ?? p.weightUnit) === 'lb' ? GRAMS_PER_POUND : 1000), 2);
}
/** A kg or lb input back to whole grams, or null when it is not a nonnegative number. */
export function parseWeight(input, options = {}) {
  const { p } = context(options);
  const value = typeof input === 'number' ? input : Number(String(input ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(value) || value < 0 || String(input ?? '').trim() === '') return null;
  return Math.round(value * ((options.unit ?? p.weightUnit) === 'lb' ? GRAMS_PER_POUND : 1000));
}
/** The short unit symbol, such as `km`, `mi`, `kg`, `lb`, `°C` or `°F`. */
export function unitLabel(name, options = {}) {
  const { locale } = context(options);
  const intl = { km: 'kilometer', mi: 'mile', kg: 'kilogram', lb: 'pound', c: 'celsius', f: 'fahrenheit' }[name] ?? name;
  return cached('n', locale, { style: 'unit', unit: intl, unitDisplay: 'short' }).formatToParts(1).filter((part) => part.type === 'unit').map((part) => part.value).join('').trim();
}

/** Minor units in the given currency. */
export function formatMoney(amount, currency, options = {}) {
  const { locale } = context(options);
  const { prefs: _prefs, locale: _locale, ...intl } = options;
  return moneyString(amount, currency, locale, intl);
}
/** The display currency, falling back to the trip's own. */
export function displayCurrency(tripCurrency, options = {}) { return context(options).p.currency ?? tripCurrency; }

function utc(date) { const [y, m, d] = date.split('-').map(Number); const value = new Date(Date.UTC(2000, m - 1, d)); value.setUTCFullYear(y); return value; }
function dateParts(date, locale, options) {
  return Object.fromEntries(cached('d', locale, { timeZone: 'UTC', ...options }).formatToParts(utc(date)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}
/**
 * `style`: `numeric` (24/10/2026), `medium` (24 Oct 2026, the default) or `long` (24 October 2026).
 * `weekday: true` prefixes the weekday; `year: false` drops the year. ISO always prints numbers.
 */
export function formatDate(date, options = {}) {
  if (!isDate(date)) return '';
  const { p, locale } = context(options);
  const { style = 'medium', weekday = false, year = true } = options;
  const numeric = style === 'numeric' || p.dateFormat === 'iso';
  const weekdayName = weekday ? dateParts(date, locale, { weekday: style === 'long' ? 'long' : 'short' }).weekday : '';
  const prefix = (text) => (weekdayName ? `${weekdayName} ${text}` : text);
  if (p.dateFormat === 'auto') {
    const intl = numeric ? { day: '2-digit', month: '2-digit' } : { day: 'numeric', month: style === 'long' ? 'long' : 'short' };
    if (year) intl.year = 'numeric';
    if (weekday) intl.weekday = style === 'long' ? 'long' : 'short';
    return cached('d', locale, { timeZone: 'UTC', ...intl }).format(utc(date));
  }
  const [y, m, d] = date.split('-');
  if (numeric) {
    if (p.dateFormat === 'iso') return prefix(year ? date : `${m}-${d}`);
    const dm = p.dateFormat === 'dmy' ? `${d}/${m}` : `${m}/${d}`;
    return prefix(year ? `${dm}/${y}` : dm);
  }
  const month = dateParts(date, locale, { month: style === 'long' ? 'long' : 'short' }).month;
  const day = String(Number(d));
  const shown = String(Number(y));
  if (p.dateFormat === 'dmy') return prefix(year ? `${day} ${month} ${shown}` : `${day} ${month}`);
  return prefix(year ? `${month} ${day}, ${shown}` : `${month} ${day}`);
}

const cycles = new Map();
function hourCycle(p, locale) {
  if (p.timeFormat === '24') return 'h23';
  if (p.timeFormat === '12') return 'h12';
  if (!cycles.has(locale)) cycles.set(locale, cached('d', locale, { hour: 'numeric' }).resolvedOptions().hourCycle ?? 'h23');
  return cycles.get(locale);
}
/** True when times show AM/PM. */
export function uses12Hour(options = {}) { const { p, locale } = context(options); return ['h11', 'h12'].includes(hourCycle(p, locale)); }
/** `HH:mm` or minutes after midnight. */
export function formatTime(time, options = {}) {
  const minutes = typeof time === 'number' ? time : isTime(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : NaN;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) return '';
  const { p, locale } = context(options);
  const cycle = hourCycle(p, locale);
  const twelve = cycle === 'h11' || cycle === 'h12';
  return cached('d', locale, { timeZone: 'UTC', hour: twelve ? 'numeric' : '2-digit', minute: '2-digit', hourCycle: cycle })
    .format(Date.UTC(1970, 0, 1, Math.floor(minutes / 60), minutes % 60));
}
export function formatDateTime(date, time, options = {}) {
  return [formatDate(date, options), formatTime(time, options)].filter(Boolean).join(' ');
}
/** An instant shown in a time zone (for example a flight departure in the airport's zone). */
export function formatInstant(epoch, zone, options = {}) {
  const { date, time } = zonedParts(epoch, zone);
  if (options.time === false) return formatDate(date, options);
  if (options.date === false) return formatTime(time, options);
  return formatDateTime(date, time, options);
}
export function formatDateRange(start, end, options = {}) {
  if (!isDate(start)) return isDate(end) ? formatDate(end, options) : '';
  if (!isDate(end) || start === end) return formatDate(start, options);
  const { p, locale } = context(options);
  if (p.dateFormat === 'auto' && (options.style ?? 'medium') !== 'numeric' && !options.weekday) {
    const intl = { timeZone: 'UTC', day: 'numeric', month: options.style === 'long' ? 'long' : 'short', year: 'numeric' };
    return cached('d', locale, intl).formatRange(utc(start), utc(end));
  }
  const sameYear = start.slice(0, 4) === end.slice(0, 4) && p.dateFormat !== 'iso' && (options.style ?? 'medium') !== 'numeric';
  return `${formatDate(start, { ...options, year: !sameYear })} – ${formatDate(end, options)}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekStart(options = {}) {
  const { p, locale } = context(options);
  if (p.weekStart !== 'auto') return { sun: 0, mon: 1, sat: 6 }[p.weekStart];
  try {
    const intl = new Intl.Locale(locale);
    const info = typeof intl.getWeekInfo === 'function' ? intl.getWeekInfo() : intl.weekInfo;
    if (Number.isInteger(info?.firstDay)) return info.firstDay % 7;
  } catch { /* Fall back to the region list. */ }
  return SUNDAY_FIRST.has(localeRegion(locale)) ? 0 : 1;
}
/** Weekday names starting at the preferred first day: `[{day, label}]` with `day` 0 = Sunday. */
export function weekdays(options = {}) {
  const { locale } = context(options);
  const first = weekStart(options);
  const intl = cached('d', locale, { timeZone: 'UTC', weekday: options.style ?? 'short' });
  return Array.from({ length: 7 }, (_, index) => {
    const day = (first + index) % 7;
    return { day, label: intl.format(Date.UTC(2023, 0, 1 + day)) };
  });
}

/** Minutes as `1 hr 25 min`. */
export function formatDuration(minutes, options = {}) {
  if (!Number.isFinite(minutes) || minutes < 0) return '';
  const { locale } = context(options);
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60); const rest = total % 60;
  return [hours && unit(locale, 'hour', hours, 0), (rest || !hours) && unit(locale, 'minute', rest, 0)].filter(Boolean).join(' ');
}
