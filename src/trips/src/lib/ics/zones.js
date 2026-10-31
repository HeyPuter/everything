import { isTimeZone, zoneOffset as offsetAt } from '../../shared/dates.js';
import { localValue, offsetValue } from './text.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const MAX_STEPS = 800;
export { offsetAt };

/**
 * Offset changes of `zone` between two instants: `{initial, transitions:[{at, from, to}]}`, `at` being the first
 * minute of the new offset. Scans day by day (coarser past ~2 years) and bisects each change to the minute.
 */
export function transitions(zone, from, to) {
  const start = Math.floor(from / MINUTE) * MINUTE;
  const end = Math.max(start, Math.ceil(to / MINUTE) * MINUTE);
  const step = Math.max(DAY, Math.ceil((end - start) / MAX_STEPS / MINUTE) * MINUTE);
  const initial = offsetAt(zone, start);
  const list = [];
  let before = initial;
  for (let at = start; at < end;) {
    const next = Math.min(at + step, end);
    const after = offsetAt(zone, next);
    if (after !== before) {
      let low = at;
      let high = next;
      while (high - low > MINUTE) {
        const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
        if (offsetAt(zone, middle) === before) low = middle; else high = middle;
      }
      list.push({ at: high, from: before, to: after });
      before = after;
    }
    at = next;
  }
  return { initial, transitions: list };
}

function standardOffset(zone, epoch) {
  const year = new Date(epoch).getUTCFullYear();
  const january = new Date(0); january.setUTCFullYear(year, 0, 1);
  const july = new Date(0); july.setUTCFullYear(year, 6, 1);
  return Math.min(offsetAt(zone, january.getTime()), offsetAt(zone, july.getTime()));
}

const wallText = (epoch) => {
  const iso = new Date(epoch).toISOString();
  return localValue(iso.slice(0, 10), iso.slice(11, 16));
};

/**
 * VTIMEZONE lines for an IANA zone, valid for instants in [from, to]: one observance from 1970 with the offset at
 * `from`, then one per change in the range. No RRULEs, so they cannot drift from what Intl reports.
 */
export function vtimezone(zone, from, to) {
  if (!isTimeZone(zone)) return [];
  const range = transitions(zone, from - DAY, to + DAY);
  const observance = (offset, at, dtstart, previous) => {
    const kind = offset > standardOffset(zone, at) ? 'DAYLIGHT' : 'STANDARD';
    return [`BEGIN:${kind}`, `DTSTART:${dtstart}`, `TZOFFSETFROM:${offsetValue(previous)}`, `TZOFFSETTO:${offsetValue(offset)}`, `END:${kind}`];
  };
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`, ...observance(range.initial, from, '19700101T000000', range.initial)];
  // An observance's DTSTART is the local time just before the change, in the offset it changes from.
  for (const change of range.transitions) lines.push(...observance(change.to, change.at, wallText(change.at + change.from * MINUTE), change.from));
  lines.push('END:VTIMEZONE');
  return lines;
}
