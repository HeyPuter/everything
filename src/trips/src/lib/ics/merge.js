// Merges per-trip calendars into the "all my trips" feed. Events are copied as written (folded lines included); the
// calendar header and the time zones of IANA zones are new. Pure, shared by the worker and tests.
import { isTimeZone } from '../../shared/dates.js';
import { escapeText, foldLine, durationValue } from './text.js';
import { vtimezone } from './zones.js';

const MAX_LINES = 200_000;
const MAX_COMPONENT_LINES = 400;
const DAY = 86_400_000;
// Components each top-level one may contain.
const NESTED = Object.freeze({ VEVENT: ['VALARM'], VTIMEZONE: ['STANDARD', 'DAYLIGHT'], VALARM: [], STANDARD: [], DAYLIGHT: [] });

/**
 * The top-level components of one calendar: `{events: [lines], zones: Map<tzid, lines>}`. Lines stay folded and
 * nested components (alarms, standard/daylight rules) stay inside their parent. Anything outside VEVENT and VTIMEZONE
 * is dropped, as is a component that never ends, runs past the line cap, or nests or ends anything it should not.
 */
export function calendarComponents(text) {
  const events = [];
  const zones = new Map();
  if (typeof text !== 'string' || !/^BEGIN:VCALENDAR\r?\n/i.test(text)) return { events, zones };
  const lines = text.split(/\r?\n/).slice(0, MAX_LINES);
  let current = null;
  let stack = [];
  for (const line of lines) {
    if (!current) {
      const begin = /^BEGIN:(VEVENT|VTIMEZONE)$/i.exec(line);
      if (begin) { current = { kind: begin[1].toUpperCase(), lines: [line] }; stack = [current.kind]; }
      continue;
    }
    current.lines.push(line);
    const begin = /^BEGIN:([A-Z-]+)$/i.exec(line);
    const end = /^END:([A-Z-]+)$/i.exec(line);
    if (begin) {
      const name = begin[1].toUpperCase();
      if (!NESTED[stack.at(-1)]?.includes(name)) { current = null; continue; }
      stack.push(name);
    } else if (end) {
      if (end[1].toUpperCase() !== stack.at(-1)) { current = null; continue; }
      stack.pop();
    }
    if (current.lines.length > MAX_COMPONENT_LINES) { current = null; continue; }
    if (!stack.length) {
      if (current.kind === 'VEVENT') events.push(current.lines);
      else {
        const tzid = current.lines.find((item) => /^TZID:/i.test(item))?.slice(5);
        if (tzid && !zones.has(tzid)) zones.set(tzid, current.lines);
      }
      current = null;
    }
  }
  return { events, zones };
}

const uidOf = (lines) => lines.find((line) => /^UID:/i.test(line))?.slice(4) ?? null;
const ZONED = /^(?:DTSTART|DTEND|RECURRENCE-ID|EXDATE|RDATE)(?:;[^:]*)?;TZID=("?)([^";:]+)\1[^:]*:(\d{4})(\d{2})(\d{2})/i;

/** `{tzid: [first, last]}` epochs of the zoned dates in `events`. */
function zoneRanges(events) {
  const ranges = new Map();
  for (const lines of events) {
    for (const line of lines) {
      const match = ZONED.exec(line);
      if (!match) continue;
      const at = Date.UTC(Number(match[3]), Number(match[4]) - 1, Number(match[5]));
      if (!Number.isFinite(at)) continue;
      const range = ranges.get(match[2]);
      if (!range) ranges.set(match[2], [at, at]); else { range[0] = Math.min(range[0], at); range[1] = Math.max(range[1], at); }
    }
  }
  return ranges;
}

/**
 * One calendar from several: events in input order (a UID already seen is skipped). IANA zones are written here from
 * the dates that use them, so a feed can't redefine a zone other trips' events use; other TZIDs keep the first
 * definition met. `name` titles the calendar; `refresh` is the suggested poll interval in minutes.
 */
export function mergeCalendars(texts, { name = '', refresh = 0 } = {}) {
  const custom = new Map();
  const seen = new Set();
  const events = [];
  for (const text of texts) {
    const parts = calendarComponents(text);
    for (const [tzid, lines] of parts.zones) if (!isTimeZone(tzid) && !custom.has(tzid)) custom.set(tzid, lines);
    for (const lines of parts.events) {
      const uid = uidOf(lines);
      if (uid && seen.has(uid)) continue;
      if (uid) seen.add(uid);
      events.push(lines);
    }
  }
  const zones = new Map(custom);
  for (const [tzid, [first, last]] of zoneRanges(events)) if (isTimeZone(tzid)) zones.set(tzid, vtimezone(tzid, first - DAY, last + 2 * DAY).map(foldLine));
  const head = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Puter//Trips//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', foldLine(`X-WR-CALNAME:${escapeText(name, 200)}`)];
  if (refresh > 0) head.push(`REFRESH-INTERVAL;VALUE=DURATION:${durationValue(refresh)}`, `X-PUBLISHED-TTL:${durationValue(refresh)}`);
  const body = [...[...zones.keys()].sort().flatMap((tzid) => zones.get(tzid)), ...events.flat()];
  return { text: `${[...head, ...body, 'END:VCALENDAR'].join('\r\n')}\r\n`, events: events.length };
}
