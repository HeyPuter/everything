import { daysBetween, isDate, isTime, isTimeZone, timeMinutes, zonedInstant, zonedParts } from '../../shared/dates.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const wall = (date, time) => {
  const [y, m, d] = date.split('-').map(Number);
  const result = new Date(0);
  result.setUTCFullYear(y, m - 1, d);
  return result.getTime() + timeMinutes(time) * MINUTE;
};
const offsetAt = (zone, epoch) => {
  const parts = zonedParts(epoch, zone);
  return wall(parts.date, parts.time) + parts.second * 1000 - epoch;
};

/** True for `{date}` with a valid ISO date; `time` and `tz` are optional. */
export const isPoint = (point) => Boolean(point) && isDate(point.date);
export const hasTime = (point) => isPoint(point) && isTime(point.time);
export const hasZone = (point) => Boolean(point) && isTimeZone(point.tz);

/**
 * Epoch ms of a local date and time in an IANA zone. A repeated time (DST fall-back) takes the earlier instant;
 * a time inside a DST gap moves forward by the gap, so 02:30 on a spring-forward night reads as 03:30.
 */
export function zonedEpoch(date, time, zone) {
  try { return zonedInstant(date, time, zone, { disambiguation: 'earlier' }); }
  catch (error) {
    if (error?.code !== 'nonexistent_local_time') throw error;
    const local = wall(date, time);
    // 26 h back is before any transition that can create this gap and after the previous one.
    return local - offsetAt(zone, local - 26 * HOUR);
  }
}

/** Instant of `{date, time, tz}`, or null without a valid date, time and zone. */
export function instantOf(point) {
  if (!hasTime(point) || !hasZone(point)) return null;
  return zonedEpoch(point.date, point.time, point.tz);
}

/** Wall-clock ms (local date and time read as UTC); untimed points read as midnight. Null without a date. */
export function wallOf(point) {
  if (!isPoint(point)) return null;
  return wall(point.date, isTime(point.time) ? point.time : '00:00');
}

/**
 * Orders two local points. Both zoned: by instant. Neither zoned (floating): by wall clock. Mixed zoned and floating
 * points, or a missing time on either side when the dates match, are not comparable (null).
 */
export function comparePoints(a, b) {
  if (!isPoint(a) || !isPoint(b)) return null;
  const zoned = hasZone(a) && hasZone(b);
  const floating = !hasZone(a) && !hasZone(b);
  if (hasTime(a) && hasTime(b)) {
    if (zoned) return Math.sign(instantOf(a) - instantOf(b));
    if (floating) return Math.sign(wallOf(a) - wallOf(b));
  }
  const days = daysBetween(b.date, a.date);
  // Across different or unknown zones, dates alone decide only beyond the widest offset gap (26 h).
  if (days !== 0 && (floating || (zoned && a.tz === b.tz) || Math.abs(days) >= 3)) return Math.sign(days);
  return null;
}

/** Minutes from `a` to `b`, or null when they are not comparable at minute precision. */
export function minutesBetween(a, b) {
  if (!hasTime(a) || !hasTime(b)) return null;
  if (hasZone(a) && hasZone(b)) return Math.round((instantOf(b) - instantOf(a)) / MINUTE);
  if (!hasZone(a) && !hasZone(b)) return Math.round((wallOf(b) - wallOf(a)) / MINUTE);
  return null;
}

/** Departure and arrival of a leg as local points in each endpoint's zone. */
export function legPoints(leg) {
  return {
    dep: { date: leg?.dep?.date, time: leg?.dep?.time, tz: leg?.from?.tz },
    arr: { date: leg?.arr?.date, time: leg?.arr?.time, tz: leg?.to?.tz },
  };
}

/** Travel time of a leg in minutes across its two zones, or null when unknown. */
export function legDuration(leg) {
  const { dep, arr } = legPoints(leg);
  return minutesBetween(dep, arr);
}

/** Calendar days between the local departure date and the local arrival date (the "+1" on arrivals). */
export function legDayOffset(leg) {
  const { dep, arr } = legPoints(leg);
  return isPoint(dep) && isPoint(arr) ? daysBetween(dep.date, arr.date) : 0;
}

/**
 * Ordering problems in a list of legs, each `{leg, code}`:
 * `arrival_before_departure` (within a leg) and `departure_before_previous_arrival` (between legs).
 * Compares in absolute time, so an east-to-west flight landing at an earlier local time is fine.
 */
export function legIssues(legs = []) {
  const issues = [];
  legs.forEach((leg, index) => {
    const { dep, arr } = legPoints(leg);
    if (comparePoints(arr, dep) < 0) issues.push({ leg: index, code: 'arrival_before_departure' });
    if (index > 0) {
      const previous = legPoints(legs[index - 1]).arr;
      if (comparePoints(dep, previous) < 0) issues.push({ leg: index, code: 'departure_before_previous_arrival' });
    }
  });
  return issues;
}

/** `end_before_start` when a booking's end is before its start, else null. */
export function rangeIssue(start, end) {
  return comparePoints(end, start) < 0 ? 'end_before_start' : null;
}

/** Short offset name of a zone at an instant, such as `GMT+9`; the zone id when Intl cannot name it. */
export function zoneLabel(zone, epoch = Date.now(), locale = 'en') {
  if (!isTimeZone(zone)) return '';
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(epoch).find((item) => item.type === 'timeZoneName');
    return part?.value ?? zone;
  } catch { return zone; }
}

/** Offset label for a local point in its own zone (`''` when the point has no zone). */
export function pointZoneLabel(point, locale) {
  if (!hasZone(point) || !isPoint(point)) return '';
  return zoneLabel(point.tz, zonedEpoch(point.date, hasTime(point) ? point.time : '12:00', point.tz), locale);
}
