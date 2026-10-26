import { invariant } from './errors.js';
import { LIMITS } from './limits.js';

const DAY = 86_400_000;
const formatters = new Map();
const leap = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return year > 0 && month >= 1 && month <= 12 && day >= 1
    && day <= [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export const isTime = (value) => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
// Building an Intl.DateTimeFormat is slow, so answers are kept (bounded).
const zoneChecks = new Map();
const remember = (map, key, value, max) => {
  if (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
  return value;
};
export function isTimeZone(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  const known = zoneChecks.get(value);
  if (known !== undefined) return known;
  let valid;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); valid = true; } catch { valid = false; }
  return remember(zoneChecks, value, valid, 512);
}

function utc(date, time = '00:00') {
  invariant(isDate(date) && isTime(time), 'invalid_date_time');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(hour, minute, 0, 0);
  return result.getTime();
}

export function addDays(date, days) {
  invariant(Number.isSafeInteger(days) && Math.abs(days) <= 3_652_058, 'invalid_days');
  const result = new Date(utc(date) + days * DAY).toISOString().slice(0, 10);
  invariant(isDate(result), 'date_out_of_range');
  return result;
}

export function daysBetween(start, end) {
  return (utc(end) - utc(start)) / DAY;
}

export function dateRange(start, end, limit = LIMITS.tripDays) {
  invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= LIMITS.days, 'invalid_limit');
  const count = daysBetween(start, end) + 1;
  invariant(count > 0 && count <= limit, 'invalid_date_range');
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}

export function timeMinutes(time) {
  invariant(isTime(time), 'invalid_time');
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

export function minutesTime(minutes) {
  invariant(Number.isSafeInteger(minutes) && minutes >= 0 && minutes < 1440, 'invalid_time');
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The local calendar date of `now` (a Date or epoch ms) on this device, as `YYYY-MM-DD`. */
export function localDate(now = Date.now()) {
  const date = new Date(now);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function browserTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(zone) ? zone : 'UTC';
  } catch { return 'UTC'; }
}

function formatter(zone) {
  const cached = formatters.get(zone);
  if (cached) return cached;
  invariant(isTimeZone(zone), 'invalid_time_zone');
  return remember(formatters, zone, new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }), 64);
}

export function zonedParts(epoch, zone) {
  invariant(Number.isSafeInteger(epoch) && Number.isFinite(new Date(epoch).getTime()), 'invalid_instant');
  const parts = Object.fromEntries(formatter(zone).formatToParts(epoch).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    second: Number(parts.second),
  };
}

/** Offset of `zone` from UTC in minutes at `epoch`, read at the start of that minute. */
export function zoneOffset(zone, epoch) {
  const at = Math.floor(epoch / 60_000) * 60_000;
  const { date, time } = zonedParts(at, zone);
  return Math.round((utc(date, time) - at) / 60_000);
}

// Planner views resolve the same local times many times per render.
const instants = new Map();
export function zonedInstant(date, time, zone, { disambiguation = 'reject' } = {}) {
  invariant(['reject', 'earlier', 'later'].includes(disambiguation), 'invalid_disambiguation');
  if (typeof date !== 'string' || typeof time !== 'string' || typeof zone !== 'string') return resolveInstant(date, time, zone, disambiguation);
  const key = `${date}|${time}|${zone}|${disambiguation}`;
  const known = instants.get(key);
  if (known !== undefined) return known;
  return remember(instants, key, resolveInstant(date, time, zone, disambiguation), 4096);
}

function resolveInstant(date, time, zone, disambiguation) {
  const wall = utc(date, time);
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 12) {
    const sample = wall + hours * 3_600_000;
    const parts = zonedParts(sample, zone);
    offsets.add(utc(parts.date, parts.time) + parts.second * 1000 - sample);
  }
  const matches = [...offsets].map((offset) => wall - offset).filter((instant) => {
    const parts = zonedParts(instant, zone);
    return parts.date === date && parts.time === time && parts.second === 0;
  }).sort((a, b) => a - b);
  invariant(matches.length > 0, 'nonexistent_local_time');
  invariant(matches.length === 1 || disambiguation !== 'reject', 'ambiguous_local_time');
  return disambiguation === 'later' ? matches.at(-1) : matches[0];
}

export function formatDate(date, locale = 'en', options = {}) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', ...options, timeZone: 'UTC' }).format(utc(date));
}
