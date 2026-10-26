import { addDays, daysBetween, isDate, isTime, isTimeZone, zonedParts } from '../../shared/dates.js';
import { zonedEpoch } from '../res/time.js';

export const MINUTE = 60_000;
// Undated days run on a fixed date in UTC, so every zone reads the same and no DST applies.
const FLOATING_DATE = '2001-01-01';

/**
 * Local wall times on one day ↔ instants (epoch ms). On a dated day each time reads in its zone, so travel across
 * zones and DST changes is real elapsed time; a time inside a DST gap moves forward and a repeated time takes the
 * earlier instant. Unknown zones read as UTC, and undated days float (zones are ignored).
 */
export function createClock(date) {
  const dated = isDate(date);
  const base = dated ? date : FLOATING_DATE;
  const zoneOf = (zone) => (dated && isTimeZone(zone) ? zone : 'UTC');
  return {
    dated,
    date: dated ? date : null,
    zoneOf,
    /** Instant of `time` in `zone` on the day, `offset` days later, or on `on` (an ISO date) when dated. */
    at(time, zone, { offset = 0, on = null } = {}) {
      if (!isTime(time)) return null;
      const day = dated && isDate(on) ? on : base;
      return zonedEpoch(offset ? addDays(day, offset) : day, time, zoneOf(zone));
    },
    /** `{date, time, offset}` of an instant in `zone`; `offset` counts days from this day (1 = after midnight). */
    wall(instant, zone) {
      const parts = zonedParts(Math.round(instant / MINUTE) * MINUTE, zoneOf(zone));
      return { date: dated ? parts.date : null, time: parts.time, offset: daysBetween(base, parts.date) };
    },
    /** Local midnight starting the day (`offset` 0) or the next one (1) in `zone`. */
    midnight(zone, offset = 0) { return zonedEpoch(addDays(base, offset), '00:00', zoneOf(zone)); },
  };
}

/** Rounds an instant up to a whole `step` of minutes (every real zone offset is a multiple of 15 minutes). */
export const roundUp = (instant, step) => (step > 0 ? Math.ceil(instant / (step * MINUTE)) * step * MINUTE : instant);
export const minutesFrom = (from, to) => Math.round((to - from) / MINUTE);
