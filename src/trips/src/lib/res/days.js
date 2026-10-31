import { isDate, isTime, timeMinutes } from '../../shared/dates.js';
import { orderBetween } from '../../shared/order.js';
import { instantOf } from './time.js';
import { isLodging, isTransport, phaseName } from './types.js';

/*
 * Where a reservation shows in day timelines.
 * - Dated days: each entry's local date (in its own zone) picks the day with that date. Dates outside the trip
 *   place nothing; they are never clamped.
 * - Lodging: `stay.fromDayId` → `stay.toDayId` when both days exist (dated or not), otherwise its dates.
 * - Undated days: a `dayPos` key on an undated day assigns the whole reservation to it.
 * - `dayPos[dayId]` is the manual position within that day; on dated days it never changes placement.
 * Entries are `{key, resId, res, type, dayId, date, phase, name, leg, time, tz, endTime, endTz, minutes, instant, pos, explicit}`:
 * `phase` is `single|start|middle|end`, `name` its type-specific label id (`phaseName`), `leg` the leg index or null.
 */

const indexes = new WeakMap();
function indexOf(days) {
  let index = indexes.get(days);
  if (!index) {
    const byId = new Map();
    const byDate = new Map();
    days.forEach((day, position) => {
      byId.set(day.id, position);
      if (isDate(day.date) && !byDate.has(day.date)) byDate.set(day.date, position);
    });
    const dated = days.map((day, position) => [day.date, position]).filter(([date]) => isDate(date)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    index = { byId, byDate, dated };
    if (Object.isFrozen(days)) indexes.set(days, index);
  }
  return index;
}

const minutesOf = (time) => (isTime(time) ? timeMinutes(time) : null);
const phaseFor = (position, first, last) => (first === last ? 'single' : position === first ? 'start' : position === last ? 'end' : 'middle');

/** Positions of dated days from `start` to `end` (inclusive), in date order. */
function datedBetween(index, start, end) {
  if (!isDate(start)) return [];
  const last = isDate(end) && end > start ? end : start;
  return index.dated.filter(([date]) => date >= start && date <= last);
}

/** Every timeline entry of one reservation over the trip's days (sorted by `order`). */
export function resEntries(res, days) {
  if (!res || res.deleted || !Array.isArray(days)) return [];
  const index = indexOf(days);
  const entries = [];
  const add = (position, fields) => {
    const day = days[position];
    const entry = {
      resId: res.id, res, type: res.type, dayId: day.id, date: isDate(day.date) ? day.date : null,
      leg: null, time: null, tz: null, endTime: null, endTz: null, explicit: false, ...fields,
    };
    entry.name = phaseName(res.type, entry.phase);
    entry.minutes = minutesOf(entry.time);
    entry.instant = entry.at ? instantOf({ ...entry.at, time: entry.time, tz: entry.tz }) : null;
    delete entry.at;
    entry.pos = res.dayPos?.[day.id] ?? null;
    entry.key = `${res.id}:${day.id}:${entry.leg ?? '-'}:${entry.phase}`;
    entries.push(entry);
  };
  // `start`/`end` points spread over dated days, with the start time on the first day and the end time on the last.
  const spread = (start, end, extra = {}) => {
    if (!isDate(start?.date)) return;
    const last = isDate(end?.date) && end.date > start.date ? end.date : start.date;
    // Phases follow the real dates, so a stay that began before the trip shows as ongoing on its first trip day.
    for (const [date, position] of datedBetween(index, start.date, last)) {
      const phase = phaseFor(date, start.date, last);
      if (phase === 'middle') { add(position, { phase, ...extra }); continue; }
      const startish = phase !== 'end';
      add(position, {
        phase, ...extra, at: { date },
        time: startish ? start?.time ?? null : end?.time ?? null,
        tz: startish ? start?.tz ?? null : end?.tz ?? start?.tz ?? null,
        ...(phase === 'single' ? { endTime: end?.time ?? null, endTz: end?.tz ?? start?.tz ?? null } : {}),
      });
    }
  };

  let byDayId = false;
  if (isLodging(res.type)) {
    const checkIn = { ...res.start, time: res.stay?.checkInFrom ?? res.start?.time };
    const checkOut = { ...res.end, time: res.stay?.checkOut ?? res.end?.time };
    const from = index.byId.get(res.stay?.fromDayId);
    if (from !== undefined) {
      byDayId = true;
      let to = index.byId.get(res.stay?.toDayId);
      if (to === undefined || to < from) to = from;
      for (let position = from; position <= to; position++) {
        const phase = phaseFor(position, from, to);
        const date = days[position].date;
        if (phase === 'middle') add(position, { phase });
        else if (phase === 'end') add(position, { phase, at: { date }, time: checkOut.time ?? null, tz: checkOut.tz ?? checkIn.tz ?? null });
        else add(position, { phase, at: { date }, time: checkIn.time ?? null, tz: checkIn.tz ?? null, ...(phase === 'single' ? { endTime: checkOut.time ?? null, endTz: checkOut.tz ?? checkIn.tz ?? null } : {}) });
      }
    } else spread(checkIn, isDate(res.end?.date) ? checkOut : null);
  } else if (isTransport(res.type) && res.legs?.length) {
    res.legs.forEach((leg, number) => {
      const dep = leg.dep?.date;
      if (!isDate(dep)) return;
      const arr = isDate(leg.arr?.date) && leg.arr.date >= dep ? leg.arr.date : dep;
      spread({ date: dep, time: leg.dep.time, tz: leg.from?.tz }, { date: arr, time: leg.arr?.time, tz: leg.to?.tz }, { leg: number });
    });
    // Days between legs (a rental car kept for days, an overnight layover) still show the booking.
    const first = res.legs.map((leg) => leg.dep?.date).filter(isDate).sort()[0];
    const last = res.legs.flatMap((leg) => [leg.dep?.date, leg.arr?.date]).filter(isDate).sort().at(-1);
    const covered = new Set(entries.map((entry) => entry.dayId));
    for (const [, position] of datedBetween(index, first, last)) {
      if (!covered.has(days[position].id)) add(position, { phase: 'middle' });
    }
  } else spread(res.start, isDate(res.end?.date) ? res.end : null);

  if (!byDayId) {
    for (const dayId of Object.keys(res.dayPos ?? {})) {
      const position = index.byId.get(dayId);
      if (position === undefined || isDate(days[position].date)) continue;
      if (isTransport(res.type) && res.legs?.length) {
        res.legs.forEach((leg, number) => add(position, {
          phase: 'single', leg: number, explicit: true, at: leg.dep, time: leg.dep?.time ?? null, tz: leg.from?.tz ?? null,
          endTime: leg.arr?.time ?? null, endTz: leg.to?.tz ?? null,
        }));
      } else {
        add(position, {
          phase: 'single', explicit: true, at: res.start, time: (isLodging(res.type) ? res.stay?.checkInFrom : null) ?? res.start?.time ?? null,
          tz: res.start?.tz ?? null, endTime: res.end?.time ?? null, endTz: res.end?.tz ?? res.start?.tz ?? null,
        });
      }
    }
  }
  return entries;
}

/** All-day (untimed) entries first, then by local time, manual position, reservation and leg. */
export function compareEntries(a, b) {
  const am = a.minutes ?? -1;
  const bm = b.minutes ?? -1;
  if (am !== bm) return am - bm;
  if (a.pos !== b.pos) return a.pos === null ? 1 : b.pos === null ? -1 : a.pos < b.pos ? -1 : 1;
  if (a.resId !== b.resId) return a.resId < b.resId ? -1 : 1;
  return (a.leg ?? -1) - (b.leg ?? -1);
}

/** `Map<dayId, entries[]>` for every day (empty arrays included). Cancelled reservations are left out unless asked. */
export function entriesByDay(list, days, { includeCancelled = false } = {}) {
  const map = new Map(days.map((day) => [day.id, []]));
  for (const res of list) {
    if (!includeCancelled && res.status === 'cancelled') continue;
    for (const entry of resEntries(res, days)) map.get(entry.dayId)?.push(entry);
  }
  for (const entries of map.values()) entries.sort(compareEntries);
  return map;
}

/** Reservations that land on no day of the trip (no dates, dates outside the trip, or no assigned undated day). */
export function unplaced(list, days) {
  return list.filter((res) => resEntries(res, days).length === 0);
}

/** Day ids a lodging covers, from check-in day to check-out day. */
export function stayDays(res, days) {
  return [...new Set(resEntries(res, days).map((entry) => entry.dayId))];
}

/**
 * Lodging around one day, for route anchors and the scheduler: `wake` is where the day starts (the stay covering
 * the previous night), `sleep` where it ends (the stay covering the coming night). Cancelled stays are ignored.
 */
export function dayStays(list, days, dayId) {
  let wake = null;
  let sleep = null;
  for (const res of list) {
    if (!isLodging(res.type) || res.status === 'cancelled') continue;
    for (const entry of resEntries(res, days)) {
      if (entry.dayId !== dayId || entry.phase === 'single') continue;
      if (entry.phase !== 'start') wake ??= res;
      if (entry.phase !== 'end') sleep ??= res;
    }
  }
  return { wake, sleep };
}

/** Day id for a date in a dated trip, or null. */
export function dayForDate(days, date) {
  const position = indexOf(days).byDate.get(date);
  return position === undefined ? null : days[position].id;
}

/** An order key after every key given (visits and notes of a day), for placing a reservation at the end. */
export function orderAfter(keys) {
  const last = keys.filter((key) => typeof key === 'string').sort().at(-1) ?? null;
  return orderBetween(last, null);
}

/** `dayPos` keys a patch should drop: days that no longer exist. */
export function staleDayPos(res, days) {
  const { byId } = indexOf(days);
  return Object.keys(res.dayPos ?? {}).filter((dayId) => !byId.has(dayId));
}
