import { isDate, isTime, isTimeZone } from '../../shared/dates.js';
import { zonedEpoch } from '../res/time.js';
import { dateValue, durationValue, escapeText, foldLine, localValue, utcValue } from './text.js';
import { vtimezone } from './zones.js';

/*
 * Events are `{uid, summary, start, end?, location?, description?, status?, transparent?, modified?, alarms?}`.
 * `start`/`end` are `{date}` for all-day (exclusive end date) or `{date, time, tz?}`; without `tz` a time is floating.
 * Alarms are `{before}` in minutes before the start (negative fires after it).
 */

const LIMITS = Object.freeze({ summary: 200, location: 300, description: 1000 });

function pointLine(name, point, { zones, track, valid }) {
  if (!isTime(point.time)) return `${name};VALUE=DATE:${dateValue(point.date)}`;
  if (point.tz && valid(point.tz)) {
    const epoch = zonedEpoch(point.date, point.time, point.tz);
    if (zones === 'utc') return `${name}:${utcValue(epoch)}`;
    track(point.tz, epoch);
    return `${name};TZID=${point.tz}:${localValue(point.date, point.time)}`;
  }
  return `${name}:${localValue(point.date, point.time)}`;
}

function eventLines(event, context) {
  const lines = ['BEGIN:VEVENT', `UID:${escapeText(event.uid)}`, `DTSTAMP:${utcValue(context.stamp)}`];
  if (Number.isSafeInteger(event.modified) && event.modified > 0) lines.push(`LAST-MODIFIED:${utcValue(event.modified)}`);
  lines.push(pointLine('DTSTART', event.start, context));
  if (event.end && isDate(event.end.date)) lines.push(pointLine('DTEND', event.end, context));
  const summary = escapeText(event.summary, LIMITS.summary);
  lines.push(`SUMMARY:${summary}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location, LIMITS.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description, LIMITS.description)}`);
  if (event.status) lines.push(`STATUS:${event.status}`);
  if (event.transparent) lines.push('TRANSP:TRANSPARENT');
  for (const alarm of event.alarms ?? []) {
    if (!Number.isFinite(alarm?.before)) continue;
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${summary}`, `TRIGGER:${durationValue(-alarm.before)}`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

/**
 * An RFC 5545 calendar. `zones: 'tzid'` writes zoned times with TZID and a VTIMEZONE per zone; `'utc'` converts them
 * to UTC. `stamp` is the DTSTAMP of every event (pass a data timestamp to keep the output stable). `refresh` is a
 * suggested poll interval in minutes for subscribed feeds.
 */
export function serializeCalendar({ name = '', events = [], stamp = Date.now(), zones = 'tzid', refresh = 0 } = {}) {
  const ranges = new Map();
  const checked = new Map();
  const context = {
    zones,
    stamp: Number.isSafeInteger(stamp) && stamp >= 0 ? stamp : Date.now(),
    valid: (zone) => { if (!checked.has(zone)) checked.set(zone, isTimeZone(zone)); return checked.get(zone); },
    track: (zone, epoch) => {
      const range = ranges.get(zone);
      if (!range) ranges.set(zone, [epoch, epoch]);
      else { range[0] = Math.min(range[0], epoch); range[1] = Math.max(range[1], epoch); }
    },
  };
  const body = events.filter((event) => event && isDate(event.start?.date)).flatMap((event) => eventLines(event, context));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Puter//Trips//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(name, LIMITS.summary)}`];
  if (refresh > 0) lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${durationValue(refresh)}`, `X-PUBLISHED-TTL:${durationValue(refresh)}`);
  for (const zone of [...ranges.keys()].sort()) lines.push(...vtimezone(zone, ...ranges.get(zone)));
  lines.push(...body, 'END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
