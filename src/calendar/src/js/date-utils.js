/**
 * Pure date helpers. Everything works in the browser's local time zone and is
 * dependency-free so it stays easy to reason about and to test.
 *
 * `weekStartsOn`: 0 = Sunday, 1 = Monday (matches Date.prototype.getDay()).
 */

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
export const MINUTES_PER_DAY = 1440;

export const WEEKDAYS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_NARROW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Coerce a Date | number | string into a Date. */
export function toDate(value) {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

/* ---- Arithmetic (DST-safe: preserves wall-clock time) ----------------- */

export function addDays(date, n) {
  const d = toDate(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function addWeeks(date, n) {
  return addDays(date, n * 7);
}

export function addYears(date, n) {
  const d = toDate(date);
  const targetDay = d.getDate();
  d.setDate(1);
  d.setFullYear(d.getFullYear() + n);
  // Clamp to the last valid day of the resulting month (Feb 29 -> Feb 28 in a
  // non-leap year), matching addMonths so a leap-day anchor doesn't roll into
  // March on year navigation.
  d.setDate(Math.min(targetDay, daysInMonth(d.getFullYear(), d.getMonth())));
  return d;
}

export function addMonths(date, n) {
  const d = toDate(date);
  const targetDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  // Clamp to the last valid day of the resulting month (e.g. Jan 31 -> Feb 28).
  d.setDate(Math.min(targetDay, daysInMonth(d.getFullYear(), d.getMonth())));
  return d;
}

export function addMinutes(date, n) {
  return new Date(toDate(date).getTime() + n * MS_PER_MINUTE);
}

export function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/* ---- Boundaries ------------------------------------------------------- */

export function startOfDay(date) {
  const d = toDate(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date) {
  const d = toDate(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function startOfWeek(date, weekStartsOn = 0) {
  const d = startOfDay(date);
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  return addDays(d, -diff);
}

export function endOfWeek(date, weekStartsOn = 0) {
  return endOfDay(addDays(startOfWeek(date, weekStartsOn), 6));
}

export function startOfMonth(date) {
  const d = toDate(date);
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

export function endOfMonth(date) {
  const d = toDate(date);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

/* ---- Comparisons ------------------------------------------------------ */

export function isSameDay(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function isSameMonth(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth();
}

export function isToday(date, now = new Date()) {
  return isSameDay(date, now);
}

export function isWeekend(date) {
  const day = toDate(date).getDay();
  return day === 0 || day === 6;
}

/** Whole calendar days between two dates (b - a), ignoring the time of day. */
export function diffCalendarDays(a, b) {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime();
  return Math.round(ms / MS_PER_DAY);
}

/* ---- Ranges ----------------------------------------------------------- */

/** Days that fill the month grid, snapped to whole weeks (35 or 42 cells). */
export function getMonthGrid(date, weekStartsOn = 0) {
  const gridStart = startOfWeek(startOfMonth(date), weekStartsOn);
  const gridEnd = endOfWeek(endOfMonth(date), weekStartsOn);
  const days = [];
  let cur = gridStart;
  while (cur.getTime() <= gridEnd.getTime()) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  // A 28-day February that begins exactly on the week-start day (e.g. Feb 2026,
  // Sunday-start) spans only four whole weeks. Pad to a fifth week so the grid
  // never collapses to four rows: that would drop the adjacent-month context
  // cells every other month shows and make the row height jump between months.
  while (days.length < 35) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

/** The seven days of the week containing `date`. */
export function getWeekDays(date, weekStartsOn = 0) {
  const start = startOfWeek(date, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * ISO 8601 week number of `date` (1–53). Week 1 is the week containing the
 * year's first Thursday; weeks run Monday–Sunday. The Thursday of the ISO
 * week decides the year, so 1 Jan can be week 52/53 of the previous year
 * and 31 Dec can be week 1 of the next.
 */
export function isoWeekNumber(date) {
  const d = startOfDay(date);
  const isoDow = d.getDay() === 0 ? 7 : d.getDay(); // Mon=1 … Sun=7
  const thursday = addDays(d, 4 - isoDow);
  const jan4 = startOfDay(new Date(thursday.getFullYear(), 0, 4));
  const jan4Iso = jan4.getDay() === 0 ? 7 : jan4.getDay();
  const week1Monday = addDays(jan4, 1 - jan4Iso);
  return 1 + Math.round(diffCalendarDays(week1Monday, thursday) / 7);
}

/**
 * ISO week number shown for a 7-day row that starts on `weekStart` (whatever
 * the user's week-start day is). Every such row contains exactly one Thursday;
 * that Thursday's ISO week is the number, matching Google Calendar.
 */
export function displayedWeekNumber(weekStart) {
  const start = startOfDay(weekStart);
  const offsetToThursday = (4 - start.getDay() + 7) % 7;
  return isoWeekNumber(addDays(start, offsetToThursday));
}

/** Ordered weekday indices given the week-start (e.g. Mon-first -> [1..6,0]). */
export function orderedWeekdays(weekStartsOn = 0) {
  // Coerce to a number: a stringy setting (e.g. "1" from malformed persisted
  // data) would otherwise concatenate — ("1" + 0) % 7 === 3 — silently rotating
  // the weekday header while startOfWeek (which subtracts) stays correct.
  const w = Number(weekStartsOn) || 0;
  return Array.from({ length: 7 }, (_, i) => (w + i) % 7);
}

/** Minutes elapsed since local midnight (0..1439). */
export function minutesSinceMidnight(date) {
  const d = toDate(date);
  return d.getHours() * 60 + d.getMinutes();
}

/* ---- Formatting (deterministic, en-US) -------------------------------- */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * The space before AM/PM is a NO-BREAK space, so a clock time is one atomic
 * word to the line breaker. An ordinary space is a break opportunity, and in
 * any box too narrow for the whole label — a packed week column, the List
 * view's fixed time column on a phone — the browser takes it, splitting "3 PM"
 * into "3" over "PM", or "10 AM – 10:30 AM" after the "10:30". A range may
 * still wrap at its dash, which reads fine; a single time may not wrap at all.
 * (ICU formats en-US times the same way, with U+202F.)
 */
const NBSP = '\u00a0';

export function formatTime(date, { hour12 = true } = {}) {
  const d = toDate(date);
  const h = d.getHours();
  const m = d.getMinutes();
  if (!hour12) return `${pad2(h)}:${pad2(m)}`;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${NBSP}${period}` : `${h12}:${pad2(m)}${NBSP}${period}`;
}

/** Hour-axis label, e.g. 0 -> "12 AM", 13 -> "1 PM". */
export function formatHourLabel(hour, { hour12 = true } = {}) {
  if (!hour12) return `${pad2(hour)}:00`;
  const period = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${NBSP}${period}`;
}

export function formatMonthYear(date) {
  const d = toDate(date);
  return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatMonthYearShort(date) {
  const d = toDate(date);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatDayTitle(date) {
  const d = toDate(date);
  return `${WEEKDAYS_LONG[d.getDay()]}, ${MONTHS_LONG[d.getMonth()]} ${d.getDate()}`;
}

export function formatFullDate(date) {
  const d = toDate(date);
  return `${WEEKDAYS_SHORT[d.getDay()]}, ${MONTHS_LONG[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Range title spanning two dates, collapsing a shared month and/or year, e.g.
 *  "Jul 12 – 18, 2026", "Jun 29 – Jul 2, 2026", "Dec 30, 2026 – Jan 2, 2027". */
export function formatDateRange(start, end) {
  const s = toDate(start);
  const e = toDate(end);
  const sM = MONTHS_SHORT[s.getMonth()];
  const eM = MONTHS_SHORT[e.getMonth()];
  const sY = s.getFullYear();
  const eY = e.getFullYear();
  if (sY !== eY) {
    return `${sM} ${s.getDate()}, ${sY} – ${eM} ${e.getDate()}, ${eY}`;
  }
  if (s.getMonth() !== e.getMonth()) {
    return `${sM} ${s.getDate()} – ${eM} ${e.getDate()}, ${sY}`;
  }
  return `${sM} ${s.getDate()} – ${e.getDate()}, ${sY}`;
}

/** Range title for the week view, collapsing shared month/year. */
export function formatWeekRange(date, weekStartsOn = 0) {
  const start = startOfWeek(date, weekStartsOn);
  return formatDateRange(start, addDays(start, 6));
}

/** Compact time range for a single event, e.g. "9 AM – 10:30 AM" (on-the-hour
 *  endpoints drop the minutes, matching formatTime). */
export function formatTimeRange(start, end, opts) {
  return `${formatTime(start, opts)} – ${formatTime(end, opts)}`;
}

/* ---- Time zones (display-only secondary zone) ------------------------- */

/** Fallback zones for the secondary-zone picker, used only when the browser
 *  cannot enumerate the full IANA set (no Intl.supportedValuesOf). */
export const COMMON_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Athens',
  'Europe/Moscow',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/** True when `tz` is an IANA zone this browser's Intl can use. */
export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The UTC instant (ms) for a wall-clock date-time interpreted in a given IANA
 * zone. Used when importing an iCal DATE-TIME that carries a `TZID`: its digits
 * are that zone's local time, so we recover the true instant by measuring the
 * zone's offset. Returns NaN for an invalid zone. A time inside a DST
 * transition resolves via a single offset pass (good enough for import).
 */
export function zonedTimeToUTC(year, month, day, hour, minute, second, tz) {
  if (!isValidTimeZone(tz)) return NaN;
  // Treat the wall-clock as if it were UTC, then correct by the zone's offset.
  // WHICH offset matters: the guess sits a whole offset away from the answer,
  // so within |offset| hours of a DST change the offset at the guess and the
  // offset at the answer differ and one pass lands an hour off (a New York
  // 09:00 on the spring-forward Sunday came back as 10:00). Re-resolve with
  // the offset the guess landed in — exact for every real wall clock.
  const guess = Date.UTC(year, month, day, hour, minute, second);
  const off1 = zoneOffsetAt(guess, tz);
  const ts = guess - off1;
  const off2 = zoneOffsetAt(ts, tz);
  if (off2 === off1) return ts;
  const ts2 = guess - off2;
  // A nonexistent spring-forward wall clock has no instant: neither offset
  // reproduces it, so keep the first pass's nearby (forward) instant.
  return zoneOffsetAt(ts2, tz) === off2 ? ts2 : ts;
}

/** How far `tz` runs ahead of UTC at the instant `ms`. */
function zoneOffsetAt(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  // Unlike zoneWallClock (which only needs the time-of-day and so clamps with
  // % 24), the DAY matters here. Some engines render midnight as hour "24" of
  // the prior day; % 24 would keep that earlier day and make the offset a full
  // day off. Passing "24" straight to Date.UTC correctly rolls it to the next
  // day's 00:00, so no clamping.
  const asZone = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asZone - ms;
}

/** The wall-clock { hour, minute } of an instant in a given IANA zone. */
function zoneWallClock(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(toDate(date));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  // Some engines render midnight as "24"; normalize to 0.
  return { hour: get('hour') % 24, minute: get('minute') };
}

/** Format an instant's time-of-day in `tz`, matching formatTime's style. Returns
 *  '' for an invalid zone so callers can no-op. */
export function formatTimeInZone(date, tz, { hour12 = true } = {}) {
  if (!isValidTimeZone(tz)) return '';
  const { hour, minute } = zoneWallClock(date, tz);
  if (!hour12) return `${pad2(hour)}:${pad2(minute)}`;
  const period = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${h12}${NBSP}${period}` : `${h12}:${pad2(minute)}${NBSP}${period}`;
}

/** A zone's short name for `date` (e.g. "EST", "GMT+5:30"), or '' if invalid. */
export function tzAbbreviation(tz, date) {
  if (!isValidTimeZone(tz)) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short',
    }).formatToParts(toDate(date));
    return parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}

/** A friendly label for a zone id, e.g. "America/New_York" -> "New York". */
export function tzLabel(tz) {
  if (tz === 'UTC') return 'UTC';
  return String(tz).split('/').pop().replace(/_/g, ' ');
}

/** Picker label with the city first (so the native select's type-to-jump
 *  matches what users type) and any sub-region after it for disambiguation,
 *  e.g. "America/North_Dakota/New_Salem" -> "New Salem, North Dakota". */
export function tzCityLabel(tz) {
  const segs = String(tz).split('/').slice(1).map((s) => s.replace(/_/g, ' '));
  return segs.reverse().join(', ') || String(tz);
}

/** A zone's UTC offset in minutes at `date` (so DST-correct), or NaN for an
 *  invalid zone. */
export function tzOffsetMinutes(tz, date = new Date()) {
  if (!isValidTimeZone(tz)) return NaN;
  const d = toDate(date);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  // Hour "24" (some engines' midnight) must roll into the next day, so no
  // % 24 clamp — same reasoning as zonedTimeToUTC above.
  const asZone = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  // Compare at minute precision on both sides; tz offsets are whole minutes.
  const asUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
  return Math.round((asZone - asUTC) / 60000);
}

/** Compact offset label, e.g. 330 -> "GMT+5:30", -420 -> "GMT-7", 0 -> "GMT+0"
 *  — the same style tzAbbreviation falls back to for zones with no short name. */
export function tzOffsetLabel(minutes) {
  if (!Number.isFinite(minutes)) return '';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `GMT${sign}${h}${m ? `:${pad2(m)}` : ''}`;
}

/* Continent/ocean group labels (tzselect's menu naming). Arctic/Longyearbyen
   (Svalbard, Norway) folds into Europe rather than getting a one-item group. */
const TZ_REGION_LABELS = {
  America: 'Americas',
  Arctic: 'Europe',
  Atlantic: 'Atlantic Ocean',
  Indian: 'Indian Ocean',
  Pacific: 'Pacific Ocean',
};

// The grouped picker list is rebuilt at most once per day (offsets shift with
// DST) — enumerating ~400 zones costs one Intl.DateTimeFormat each.
let tzGroupsCache = null;
let tzGroupsCacheKey = '';

/**
 * Option groups for the secondary-zone picker: every zone the browser can
 * enumerate (COMMON_TIMEZONES otherwise), grouped by continent/ocean, cities
 * sorted A–Z, each with its current UTC offset in minutes. UTC itself is left
 * out — the picker pins it above the groups. A valid `selected` zone missing
 * from the enumerated set (e.g. saved by a different browser) is merged in so
 * the picker never shows "None" while a secondary zone is active.
 * Returns [{ label, zones: [{ id, city, offset }] }].
 */
export function tzPickerGroups(selected = '') {
  const now = new Date();
  const key = now.toDateString();
  if (!tzGroupsCache || tzGroupsCacheKey !== key) {
    const ids = typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : COMMON_TIMEZONES;
    tzGroupsCache = buildTzGroups(ids, now);
    tzGroupsCacheKey = key;
  }
  const listed = !selected || selected === 'UTC'
    || tzGroupsCache.some((g) => g.zones.some((z) => z.id === selected));
  if (listed || !isValidTimeZone(selected)) return tzGroupsCache;
  // Rare path: rebuild (without touching the cache) with the orphan included.
  const ids = tzGroupsCache.flatMap((g) => g.zones.map((z) => z.id));
  return buildTzGroups(ids.concat(selected), now);
}

function buildTzGroups(ids, date) {
  const byLabel = new Map();
  for (const id of ids) {
    if (!id.includes('/')) continue; // "UTC" — pinned by the picker itself
    const offset = tzOffsetMinutes(id, date);
    if (!Number.isFinite(offset)) continue;
    const region = id.split('/')[0];
    const label = TZ_REGION_LABELS[region] || region;
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push({ id, city: tzCityLabel(id), offset });
  }
  return [...byLabel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, zones]) => ({
      label,
      zones: zones.sort((a, b) => a.city.localeCompare(b.city)),
    }));
}

/* ---- <input> value bridges -------------------------------------------- */

/** Date -> "YYYY-MM-DD" in local time (for <input type="date">). */
export function toDateInputValue(date) {
  const d = toDate(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Date -> "HH:MM" 24h in local time (for <input type="time">). */
export function toTimeInputValue(date) {
  const d = toDate(date);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Combine "YYYY-MM-DD" + "HH:MM" into a local Date. */
export function fromDateTimeInputs(dateStr, timeStr = '00:00') {
  const [y, mo, da] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  return new Date(y, mo - 1, da, h || 0, mi || 0, 0, 0);
}

/** Round a Date to the nearest `step` minutes, in local wall-clock time.
 *  (Rounding the raw epoch would misalign in zones whose UTC offset isn't a
 *  whole multiple of `step`, e.g. +5:45.) The result is clamped to stay within
 *  the input's own day: a time in the final `step/2` minutes (e.g. 23:50 with a
 *  30-min step) would otherwise round up to 24:00 and spill onto the next
 *  calendar day, so callers using this for a same-day default (the New event /
 *  New task start time) would land on tomorrow at 00:00. */
export function roundToNearestMinutes(date, step = 30) {
  const d = toDate(date);
  const raw = Math.round((d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60) / step) * step;
  return minutesIntoDay(d, Math.min(raw, MINUTES_PER_DAY - step));
}

/** The Date `mins` wall-clock minutes after this date's local midnight. THE
 *  way to build "minutes into a day" times: the hour field is set explicitly,
 *  not left to startOfDay — in zones whose DST spring-forward starts AT
 *  midnight (Santiago, Beirut), startOfDay can only land on 01:00, and a bare
 *  setMinutes on it returns a time one hour past the intended wall clock. */
export function minutesIntoDay(date, mins) {
  const out = startOfDay(date);
  out.setHours(0, mins, 0, 0);
  return out;
}
