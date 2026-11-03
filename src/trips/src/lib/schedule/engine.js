import { daysBetween, isDate, isTime, isTimeZone, minutesTime, timeMinutes } from '../../shared/dates.js';
import { DAY_START, familyOf } from '../timeline/index.js';
import { createClock, MINUTE, minutesFrom, roundUp } from './clock.js';
import { ARRIVAL_BUFFER, DEPARTURE_BUFFER, bookingDwell, visitDwell } from './dwell.js';
import { openDuring, openRanges } from './opening.js';

/** Minutes late (or short on travel time) before a warning shows; travel times are rough. */
export const LATE_TOLERANCE = 5;
const DEFAULT_BOOKING = 60;

const zoneOr = (zone, fallback) => (isTimeZone(zone) ? zone : fallback);
const timeOr = (value) => (isTime(value) ? value : null);
const stayZone = (res, place) => zoneOr(res?.start?.tz, zoneOr(res?.placeId ? place(res.placeId)?.tz : null, null));

/** Day route legs (`createRoutePlanner`) by the stop they arrive at: `visit:<id>`, `res:<id>` or `stay:<id>`. */
export function legsByStop(legs) {
  const map = new Map();
  for (const leg of Array.isArray(legs) ? legs : []) {
    if (!leg?.to?.id || !Number.isFinite(leg.duration)) continue;
    const key = leg.to.stay ? `stay:${leg.to.id}` : `${leg.to.t}:${leg.to.id}`;
    if (!map.has(key)) map.set(key, leg);
  }
  return map;
}

// Bookings for a visit on the same day (by visit or place) are that visit's stop, not one of their own.
function linkedBookings(entry) {
  const visits = entry.rows.filter((row) => row.kind === 'visit' && row.primary && row.phase === null);
  const links = new Map();
  const merged = new Set();
  for (const row of entry.rows) {
    const res = row.entity;
    if (row.kind !== 'res' || res.status === 'cancelled' || !['other', 'parking'].includes(familyOf(res.type))) continue;
    const target = visits.find((visit) => visit.id === res.visitId) ?? (res.placeId ? visits.find((visit) => visit.entity.placeId === res.placeId) : null);
    if (!target) continue;
    merged.add(row.key);
    if (familyOf(res.type) === 'other' && row.phase === null && isTime(row.time) && !links.has(target.id)) links.set(target.id, row);
  }
  return { links, merged };
}

function visitItem(row, booking, { place, hours, auto }) {
  const visit = row.entity;
  const spot = visit.placeId ? place(visit.placeId) : null;
  const { minutes, source } = visitDwell(visit, spot);
  const item = {
    key: row.key, kind: 'visit', id: visit.id, row, entity: visit, place: spot, ref: `visit:${visit.id}`,
    zone: zoneOr(spot?.tz, null), dwell: minutes, dwellSource: source, hours: spot ? hours(spot) : null, pinned: visit.pinned === true,
  };
  if (row.phase === 'middle') return null;
  if (row.phase === 'end') return isTime(visit.end) ? { ...item, fixed: true, openStart: true, endTime: visit.end } : null;
  if (row.phase === 'start') return { ...item, fixed: isTime(visit.start), startTime: timeOr(visit.start), openEnd: true };
  const keep = item.pinned || !auto;
  if (keep && isTime(visit.start)) return { ...item, fixed: true, startTime: visit.start, endTime: timeOr(visit.end) };
  if (keep && isTime(visit.end)) return { ...item, fixed: true, startTime: null, endTime: visit.end };
  if (booking) {
    return { ...item, fixed: true, startTime: booking.time, endTime: timeOr(booking.end), zone: zoneOr(item.zone, zoneOr(booking.entity.start?.tz, null)), booking: booking.entity };
  }
  return { ...item, fixed: false };
}

function resItem(row, { entry }) {
  const res = row.entity;
  if (res.status === 'cancelled' || res.type === 'lodging' || row.phase === 'middle') return null;
  const family = familyOf(res.type);
  const leg = row.leg !== null && row.leg !== undefined ? res.legs?.[row.leg] : null;
  const startZone = zoneOr(leg ? leg.from?.tz : res.start?.tz, null);
  const endZone = zoneOr(leg ? leg.to?.tz : res.end?.tz, startZone);
  const startDate = leg ? leg.dep?.date : res.start?.date;
  const endDate = leg ? leg.arr?.date : res.end?.date;
  // An arrival a day before its departure (date line) or after midnight; never more than a day either way.
  const endOffset = isDate(startDate) && isDate(endDate) ? Math.max(-1, Math.min(1, daysBetween(startDate, endDate))) : 0;
  const item = { key: row.key, kind: 'res', id: res.id, row, entity: res, family, ref: `res:${res.id}`, zone: startZone, endZone, dwell: 0, dwellSource: 'booking' };
  const time = timeOr(row.time);
  if (family === 'travel') {
    if (row.phase === 'end') return time ? { ...item, fixed: true, openStart: true, endTime: time, zone: endZone, post: ARRIVAL_BUFFER[res.type] ?? 0 } : { ...item, pass: true };
    if (!time) return { ...item, pass: true };
    return {
      ...item, fixed: true, startTime: time, endTime: row.phase === null ? timeOr(row.end) : null, endOffset, openEnd: row.phase === 'start',
      pre: DEPARTURE_BUFFER[res.type] ?? 0, post: ARRIVAL_BUFFER[res.type] ?? 0,
    };
  }
  if (family === 'rental' || family === 'parking') {
    if (!time) return null;
    const zone = row.phase === 'end' ? endZone : startZone;
    return { ...item, fixed: true, startTime: time, endTime: null, zone, endZone: zone, dwell: bookingDwell(res.type) };
  }
  const dwell = bookingDwell(res.type) || DEFAULT_BOOKING;
  if (row.phase === 'end') return time ? { ...item, fixed: true, openStart: true, endTime: time, zone: endZone, dwell } : null;
  if (!time) return { ...item, fixed: false, dwell, dwellSource: 'default' };
  const sameDay = !isDate(entry.date) || !isDate(endDate) || endOffset === 0;
  return { ...item, fixed: true, startTime: time, endTime: row.phase === null && sameDay ? timeOr(row.end) : null, openEnd: row.phase === 'start', dwell };
}

function itemsOf(entry, options) {
  const { links, merged } = linkedBookings(entry);
  const items = [];
  for (const row of entry.rows) {
    if (row.kind === 'note' || merged.has(row.key)) continue;
    const item = row.kind === 'visit' ? visitItem(row, links.get(row.id) ?? null, options) : row.kind === 'res' ? resItem(row, { entry }) : null;
    if (item) items.push(item);
  }
  return items;
}

const warning = (code, data = {}) => ({ code, ...data });

/**
 * Schedules one day of the timeline (`buildTimeline().byDay.get(dayId)`), in row order.
 * - `entry`: the timeline day; `place(id)` → place or null; `hours(place)` → `{week, timeZone?}` or null.
 * - `legs`: the day route's legs (`createRoutePlanner`), or null for no travel times.
 * - `stays`: `{wake, sleep}` lodging (`dayStays`): the day leaves from `wake` and ends at `sleep`.
 * - `start` (HH:mm, default `DAY_START`): when the first flexible item leaves; `end` (HH:mm, default midnight): the
 *   latest the day may end; `round`: flexible starts round up to this many minutes (default 5).
 * - `auto`: re-time every visit that is not pinned. Otherwise visits with a time keep it and only untimed ones flow.
 *
 * Bookings, pinned visits and (without `auto`) timed visits are fixed. Flexible items follow the previous item plus
 * travel, waiting for opening time when the place's hours are known. Times are instants (epoch ms); `startWall` and
 * `endWall` are local `{date, time, offset}` in the item's zone (`offset` 1 = after midnight).
 *
 * Warnings per item: `overlap` (starts before the previous fixed item ends), `endBeforeStart`, `closed`, `travel`
 * (the gap between two fixed items is shorter than the trip between them), `late` (flexible items before a fixed one
 * run past its start), `overrun` (ends after the day's end). Per day: `overrun` and `checkin` (reaches the night's
 * stay after its latest check-in).
 */
export function scheduleDay({ entry, place = () => null, hours = () => null, legs = null, stays = {}, start = null, end = null, auto = false, round = 5 } = {}) {
  const clock = createClock(entry.date);
  const items = itemsOf(entry, { place, hours, auto });
  const travel = legsByStop(legs);
  const wake = stays.wake ?? null;
  const sleep = stays.sleep ?? null;
  const firstZone = stayZone(wake, place) ?? items.find((item) => isTimeZone(item.zone))?.zone ?? stayZone(sleep, place) ?? null;
  let carry = firstZone;
  const dayStart = clock.at(isTime(start) ? start : minutesTime(DAY_START), carry);
  const limitIn = (zone) => (isTime(end) ? clock.at(end, zone) : clock.midnight(zone, 1));
  const out = [];
  let cursor = null;
  let previous = null;
  let flowed = false;
  let leave = null;

  for (const item of items) {
    const zone = zoneOr(item.zone, carry);
    const endZone = zoneOr(item.endZone, zone);
    const leg = travel.get(item.ref) ?? null;
    const minutes = leg ? Math.ceil(leg.duration / 60) : 0;
    const needed = minutes + (item.pre ?? 0);
    const result = {
      key: item.key, kind: item.kind, id: item.id, row: item.row, entity: item.entity, place: item.place ?? null,
      fixed: Boolean(item.fixed), flexible: !item.fixed && !item.pass, pinned: Boolean(item.pinned), booking: item.booking ?? null,
      zone, dwell: item.dwell, dwellSource: item.dwellSource, pre: item.pre ?? 0, post: item.post ?? 0,
      travel: leg ? { minutes, distance: leg.distance, mode: leg.mode, estimated: Boolean(leg.estimated), from: leg.from } : null,
      openStart: Boolean(item.openStart), openEnd: Boolean(item.openEnd),
      start: null, end: null, arrive: null, wait: 0, startWall: null, endWall: null, warnings: [],
    };
    out.push(result);
    if (item.pass) { carry = endZone; continue; }

    let startAt; let endAt;
    if (item.fixed) {
      startAt = item.openStart ? clock.midnight(zone) : item.startTime ? clock.at(item.startTime, zone) : null;
      endAt = item.openEnd ? clock.midnight(endZone, 1) : item.endTime ? clock.at(item.endTime, endZone, { offset: item.endOffset ?? 0 }) : null;
      if (startAt === null) startAt = endAt - item.dwell * MINUTE;
      if (endAt !== null && endAt < startAt) { result.warnings.push(warning('endBeforeStart')); endAt = null; }
      endAt ??= startAt + item.dwell * MINUTE;
      if (cursor !== null) {
        const arrive = cursor + needed * MINUTE;
        result.arrive = item.openStart ? null : arrive;
        if (previous?.fixed && previous.end > startAt) result.warnings.push(warning('overlap', { with: previous.key }));
        else if (!item.openStart && arrive - startAt > LATE_TOLERANCE * MINUTE) {
          result.warnings.push(flowed ? warning('late', { minutes: minutesFrom(startAt, arrive) })
            : warning('travel', { needed, available: Math.max(0, minutesFrom(cursor, startAt)), estimated: Boolean(leg?.estimated) }));
        }
        result.wait = item.openStart ? 0 : Math.max(0, minutesFrom(arrive, startAt));
      } else if (wake && !item.openStart) leave = { at: startAt - needed * MINUTE, travel: result.travel };
      cursor = endAt + result.post * MINUTE;
      flowed = false;
    } else {
      const from = cursor ?? dayStart;
      let arrive = from + needed * MINUTE;
      startAt = roundUp(arrive, round);
      const opening = openingFor(item, clock, zone, startAt, startAt + item.dwell * MINUTE);
      const opens = opening.open === false && opening.opensAt !== null;
      if (opens) startAt = opening.opensAt;
      if (cursor === null && wake) {
        // Rather than wait for the first stop to open, leave the stay later.
        if (opens) arrive = startAt;
        leave = { at: arrive - needed * MINUTE, travel: result.travel };
      }
      endAt = item.openEnd ? clock.midnight(endZone, 1) : startAt + item.dwell * MINUTE;
      result.arrive = arrive;
      result.wait = Math.max(0, minutesFrom(arrive, startAt));
      cursor = endAt;
      flowed = true;
    }
    result.start = startAt;
    result.end = endAt;
    result.startWall = item.openStart ? null : clock.wall(startAt, zone);
    result.endWall = item.openEnd ? null : clock.wall(endAt, endZone);
    if (!item.openStart) {
      const opening = openingFor(item, clock, zone, startAt, item.openEnd ? startAt : endAt);
      if (opening.open === false) result.warnings.push(warning('closed', { allDay: opening.allDay }));
    }
    if (!item.openEnd && endAt > limitIn(endZone)) result.warnings.push(warning('overrun'));
    previous = result;
    carry = endZone;
  }

  const warnings = [];
  const open = previous?.openEnd === true;
  let back = null;
  if (sleep && cursor !== null && !open) {
    const leg = travel.get(`stay:${sleep.id}`) ?? null;
    const minutes = leg ? Math.ceil(leg.duration / 60) : 0;
    const zone = stayZone(sleep, place) ?? carry;
    const at = cursor + minutes * MINUTE;
    back = { at, wall: clock.wall(at, zone), res: sleep, travel: leg ? { minutes, distance: leg.distance, mode: leg.mode, estimated: Boolean(leg.estimated), from: leg.from } : null };
    const checkIn = entry.stays?.some((stay) => stay.res?.id === sleep.id && stay.phase === 'checkin');
    const latest = checkIn ? clock.at(timeOr(sleep.stay?.checkInUntil), zone) : null;
    if (latest !== null && at > latest) warnings.push(warning('checkin', { res: sleep, until: sleep.stay.checkInUntil }));
  }
  if (leave) leave = { ...leave, wall: clock.wall(leave.at, stayZone(wake, place) ?? firstZone), res: wake };
  const finish = open ? null : back?.at ?? cursor;
  if (finish !== null && finish > limitIn(carry)) warnings.push(warning('overrun', { until: isTime(end) ? end : null }));
  return {
    dayId: entry.day.id, date: clock.date, dated: clock.dated, zone: firstZone, auto, start: dayStart,
    items: out, byKey: new Map(out.map((item) => [item.key, item])), leave, back, end: finish, warnings,
    estimated: travel.size > 0 && [...travel.values()].some((leg) => leg.estimated),
  };
}

// Opening check for an item with known hours, in the place's zone.
function openingFor(item, clock, zone, startAt, endAt) {
  const table = item.hours;
  if (!table?.week || !clock.dated) return { open: null, opensAt: null };
  const local = zoneOr(item.place?.tz, zoneOr(table.timeZone, zone));
  const from = clock.wall(startAt, local);
  const to = clock.wall(endAt, local);
  const startMinute = timeMinutes(from.time);
  const endMinute = daysBetween(from.date, to.date) * 1440 + timeMinutes(to.time);
  const result = openDuring(table.week, from.date, startMinute, endMinute);
  const allDay = result.open === false && !openRanges(table.week, from.date).some(([open, close]) => open < 1440 && close > 0);
  return {
    open: result.open, allDay,
    opensAt: result.opens !== null ? clock.at(minutesTime(result.opens), local, { on: from.date }) : null,
  };
}

/**
 * Patches that apply an auto schedule: `[{t: 'visit', id, set, unset?}]` for flexible visits whose times change.
 * A visit ending after midnight gets only its start; one starting after midnight is left as it is.
 */
export function schedulePatches(day) {
  const patches = [];
  for (const item of day.items) {
    if (item.kind !== 'visit' || !item.flexible || item.row.phase !== null || item.startWall?.offset !== 0) continue;
    const set = {};
    const unset = [];
    if (item.entity.start !== item.startWall.time) set.start = item.startWall.time;
    if (item.endWall?.offset === 0) { if (item.entity.end !== item.endWall.time) set.end = item.endWall.time; }
    else if (item.entity.end !== undefined) unset.push('end');
    if (Object.keys(set).length || unset.length) patches.push({ t: 'visit', id: item.id, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) });
  }
  return patches;
}

/** Visits of a day whose times auto schedule can clear (not pinned, with a start or end). */
export function clearablePatches(entry) {
  return entry.rows
    .filter((row) => row.kind === 'visit' && row.primary && row.phase === null && row.entity.pinned !== true && (row.entity.start || row.entity.end))
    .map((row) => ({ t: 'visit', id: row.id, unset: ['start', 'end'].filter((key) => row.entity[key] !== undefined) }));
}
