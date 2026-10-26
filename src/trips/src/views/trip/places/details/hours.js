// Display logic for parsed OSM opening hours ({raw, week, holidays}) in the place's time zone.
import { openingStatus } from '../../../../services/hours.js';

export const DAY_KEYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const WEEK = 7 * 1440;
const minutes = (value) => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };

/** Weekday (0 = Sunday), minutes after midnight and ISO date at `now` in `timeZone`, or null. */
export function zonedClock(now, timeZone) {
  if (typeof timeZone !== 'string' || !Number.isFinite(now)) return null;
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
  } catch { return null; }
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (!Number.isInteger(day)) return null;
  return { day, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute), date };
}

/** `[start, end)` spans in minutes from the start of `today`, from yesterday through a week ahead, merged. */
function spans(week, today) {
  const out = [];
  for (let offset = -1; offset <= 7; offset++) {
    for (const range of week[DAY_KEYS[(today + offset + 7) % 7]] ?? []) {
      const [a, b] = range.split('-').map(minutes);
      // An end at or before the start runs past midnight; "-00:00" means until midnight.
      const end = b === 0 ? 1440 : b <= a ? b + 1440 : b;
      out.push([offset * 1440 + a, offset * 1440 + end]);
    }
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const span of out) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else merged.push([...span]);
  }
  return merged;
}

/**
 * Open or closed now, plus the next change as `{offset, minutes}` (days from today in the place's zone, minutes
 * after midnight), or null when none falls within a week. `always` marks places that never close.
 */
export function hoursStatus(hours, { timeZone, now = Date.now() } = {}) {
  const { open } = openingStatus(hours, { timeZone, now });
  const clock = open === null ? null : zonedClock(now, timeZone);
  if (!clock) return { open: null, next: null, always: false };
  const list = spans(hours.week, clock.day);
  const at = clock.minutes;
  const point = (value) => ({ offset: Math.floor(value / 1440), minutes: value % 1440 });
  if (open) {
    const current = list.find(([start, end]) => start <= at && at < end);
    if (!current) return { open, next: null, always: false };
    if (current[1] - at >= WEEK) return { open, next: null, always: true };
    return { open, next: point(current[1]), always: false };
  }
  const upcoming = list.find(([start]) => start > at);
  return { open, next: upcoming && upcoming[0] - at <= WEEK ? point(upcoming[0]) : null, always: false };
}

/** "09:00-17:30" through `formatTime` (minutes in, text out). */
export function formatRange(range, formatTime) {
  const [a, b] = range.split('-').map(minutes);
  return `${formatTime(a)}–${formatTime(b % 1440)}`;
}

/** One day's ranges as text: `closed` when empty, `allDay` for 00:00-24:00. */
export function rangesText(ranges, { formatTime, allDay, closed }) {
  if (!ranges?.length) return closed;
  if (ranges.length === 1 && ranges[0] === '00:00-24:00') return allDay;
  return ranges.map((range) => formatRange(range, formatTime)).join(', ');
}

/**
 * Seven rows starting at `first` (0 = Sunday): `{day, label, text, closed, today}`. `labels[day]` is the weekday
 * name and `today` the place's weekday or null.
 */
export function weekRows(week, { first = 1, today = null, labels, ...words }) {
  return Array.from({ length: 7 }, (_, index) => {
    const day = (first + index) % 7;
    const ranges = week?.[DAY_KEYS[day]] ?? [];
    return { day, label: labels[day], today: day === today, closed: !ranges.length, text: rangesText(ranges, words) };
  });
}

/** Translation key and values for the line next to the open/closed badge, or null. */
export function statusText(status, { weekdayLabel, formatTime }) {
  if (status.open === null) return null;
  if (status.always) return { key: 'placeDetails.hoursAlways' };
  if (!status.next) return status.open ? null : { key: 'placeDetails.hoursClosedWeek' };
  const time = formatTime(status.next.minutes);
  const { offset } = status.next;
  const prefix = status.open ? 'placeDetails.closes' : 'placeDetails.opens';
  if (offset === 0) return { key: `${prefix}Today`, values: { time } };
  if (offset === 1) return { key: `${prefix}Tomorrow`, values: { time } };
  return { key: `${prefix}On`, values: { time, day: weekdayLabel(offset) } };
}
