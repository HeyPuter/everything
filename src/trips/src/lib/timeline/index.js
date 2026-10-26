import { addDays, daysBetween, isDate, isTime, timeMinutes } from '../../shared/dates.js';
import { orderKeys } from '../../shared/order.js';

/**
 * Day timelines: visits, day notes and non-lodging bookings merged per day by manual position and time, with phase
 * rows for anything spanning days and the stays (lodging) per day. Pure.
 *
 * Row: `{key, kind: 'visit'|'note'|'res', id, entity, leg, phase: null|'start'|'middle'|'end', family, order, time, end, primary}`.
 * `order` is the row's manual position on that day (visit/note `order`, booking `dayPos[dayId]`), or null; rows without
 * one are placed by time. `primary` rows can be moved within the day; a multi-day visit's later days are not primary.
 */

export const RES_FAMILY = Object.freeze({
  flight: 'travel', train: 'travel', bus: 'travel', cruise: 'travel', ferry: 'travel', transit: 'travel', transport: 'travel', taxi: 'travel',
  car: 'rental', bike: 'rental', parking: 'parking', lodging: 'stay', restaurant: 'other', event: 'other', tour: 'other', other: 'other',
});
const RANK = { res: 0, visit: 1, note: 2 };
const MAX_SPAN = 1000;
/** Minutes after midnight that untimed rows at the top of a day are taken to start at; the scheduler's default start. */
export const DAY_START = 9 * 60;

export const familyOf = (type) => RES_FAMILY[type] ?? 'other';
/** i18n key for a phase row: `plan.phase.<family>.<start|middle|end>`, or `plan.phase.stay.<checkin|night|checkout>`. */
export const phaseLabelKey = (family, phase) => `plan.phase.${family}.${phase}`;
/** Day color slot 1–8: the day's own, else by position. */
export const dayColor = (day, index) => (Number.isInteger(day?.color) && day.color >= 1 && day.color <= 8 ? day.color : (index % 8) + 1);
const minutes = (time) => (isTime(time) ? timeMinutes(time) : null);

function byOrder(a, b) {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  return RANK[a.kind] - RANK[b.kind] || (a.leg ?? -1) - (b.leg ?? -1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
// Unpositioned rows: ongoing ones first, then arrivals of trips from earlier days (nothing that day comes before
// them) and ends without a time, then by time, untimed starts last.
function looseTime(row) {
  if (row.phase === 'middle') return -2;
  const value = minutes(row.time);
  if (row.phase === 'end' && row.family === 'travel' && value !== null) return -2 + (value + 1) / 1441;
  if (row.phase === 'end') return value ?? -1;
  return value ?? Infinity;
}

const rowMinutes = (row) => (row.phase === 'middle' ? null : minutes(row.time));

/**
 * When each row (in display order) is taken to happen, in minutes: its own time, else the previous timed row's.
 * Untimed rows before any timed one read as `DAY_START`, or as the first timed row when that is earlier.
 */
export function rowTimes(rows) {
  const first = rows.map(rowMinutes).find((value) => value !== null) ?? DAY_START;
  let previous = Math.min(DAY_START, first);
  return rows.map((row) => { previous = rowMinutes(row) ?? previous; return previous; });
}

/** Orders one day's rows: positioned rows by key, others slotted in before the first positioned row timed later. */
export function sortRows(rows) {
  const positioned = rows.filter((row) => row.order != null).sort(byOrder);
  const loose = rows.filter((row) => row.order == null).map((row) => ({ row, at: looseTime(row) }))
    .sort((a, b) => a.at - b.at || RANK[a.row.kind] - RANK[b.row.kind] || (a.row.key < b.row.key ? -1 : 1));
  const times = rowTimes(positioned);
  const result = [];
  let next = 0;
  positioned.forEach((row, index) => {
    while (next < loose.length && (loose[next].at < 0 || loose[next].at < times[index])) result.push(loose[next++].row);
    result.push(row);
  });
  while (next < loose.length) result.push(loose[next++].row);
  return result;
}

function spansOf(res) {
  if (res.legs?.length) {
    return res.legs.map((leg, index) => ({ leg: index, from: leg.dep?.date, to: leg.arr?.date, start: leg.dep?.time, end: leg.arr?.time }));
  }
  return isDate(res.start?.date) ? [{ leg: null, from: res.start.date, to: res.end?.date, start: res.start.time, end: res.end?.time }] : [];
}

function eachDate(from, to, fn) {
  const last = isDate(to) && to >= from ? to : from;
  const length = Math.min(daysBetween(from, last), MAX_SPAN);
  for (let offset = 0; offset <= length; offset++) fn(addDays(from, offset), offset, length);
}

/** Where a booking shows: one row per leg on each date it covers, plus days it was placed on explicitly. */
export function resPlacements(res, { byDate, positions }) {
  const out = [];
  if (byDate.size) {
    for (const span of spansOf(res)) {
      if (!isDate(span.from)) continue;
      eachDate(span.from, span.to, (date, offset, length) => {
        const phase = length === 0 ? null : offset === 0 ? 'start' : offset === length ? 'end' : 'middle';
        const time = phase === 'end' ? span.end : phase === 'middle' ? null : span.start;
        for (const day of byDate.get(date) ?? []) out.push({ dayId: day.id, leg: span.leg, phase, time: time ?? null, end: phase === null ? span.end ?? null : null });
      });
    }
  }
  for (const dayId of Object.keys(res.dayPos ?? {})) {
    if (positions.has(dayId) && !out.some((item) => item.dayId === dayId)) out.push({ dayId, leg: null, phase: null, time: res.start?.time ?? null, end: res.end?.time ?? null });
  }
  return out;
}

/** Days a stay covers: `checkin`, `night` and `checkout` (a same-day stay is only `checkin`). */
export function stayPlacements(res, { byDate, positions, ordered }) {
  const out = [];
  if (byDate.size && isDate(res.start?.date)) {
    eachDate(res.start.date, res.end?.date, (date, offset, length) => {
      const phase = offset === 0 ? 'checkin' : offset === length ? 'checkout' : 'night';
      for (const day of byDate.get(date) ?? []) out.push({ dayId: day.id, phase });
    });
    return out;
  }
  const from = positions.get(res.stay?.fromDayId);
  const to = positions.get(res.stay?.toDayId) ?? from;
  if (from === undefined || to < from) return out;
  for (let index = from; index <= to; index++) out.push({ dayId: ordered[index].id, phase: index === from ? 'checkin' : index === to ? 'checkout' : 'night' });
  return out;
}

/**
 * `{days, visits, notes, reservations}` (days in plan order) → `{days: [{day, index, number, color, date, rows, stays}],
 * byDay: Map<dayId, entry>, orphans: {visits, notes}}`. Orphans point at a day that no longer exists. Visits that
 * belong to an alternative plan (`alt`) are not part of the timeline.
 */
export function buildTimeline({ days = [], visits = [], notes = [], reservations = [] }) {
  const positions = new Map(days.map((day, index) => [day.id, index]));
  const byDate = new Map();
  for (const day of days) if (isDate(day.date)) { if (!byDate.has(day.date)) byDate.set(day.date, []); byDate.get(day.date).push(day); }
  const rows = new Map(days.map((day) => [day.id, []]));
  const stays = new Map(days.map((day) => [day.id, []]));
  const orphans = { visits: [], notes: [] };
  for (const visit of visits) {
    if (visit.alt) continue;
    const start = positions.get(visit.dayId);
    if (start === undefined) { orphans.visits.push(visit); continue; }
    const end = positions.get(visit.endDayId);
    const spans = end !== undefined && end > start;
    rows.get(visit.dayId).push({ key: `visit:${visit.id}`, kind: 'visit', id: visit.id, entity: visit, leg: null, phase: spans ? 'start' : null, family: spans ? 'other' : null,
      order: visit.order, time: visit.start ?? null, end: spans ? null : visit.end ?? null, primary: true });
    if (spans) {
      for (let index = start + 1; index <= end; index++) {
        const phase = index === end ? 'end' : 'middle';
        rows.get(days[index].id).push({ key: `visit:${visit.id}:${index}`, kind: 'visit', id: visit.id, entity: visit, leg: null, phase, family: 'other',
          order: null, time: phase === 'end' ? visit.end ?? null : null, end: null, primary: false });
      }
    }
  }
  for (const note of notes) {
    if (!positions.has(note.dayId)) { orphans.notes.push(note); continue; }
    rows.get(note.dayId).push({ key: `note:${note.id}`, kind: 'note', id: note.id, entity: note, leg: null, phase: null, family: null, order: note.order, time: note.time ?? null, end: null, primary: true });
  }
  const context = { byDate, positions, ordered: days };
  for (const res of reservations) {
    if (res.type === 'lodging') {
      for (const { dayId, phase } of stayPlacements(res, context)) stays.get(dayId).push({ res, phase });
      continue;
    }
    const family = familyOf(res.type);
    for (const place of resPlacements(res, context)) {
      rows.get(place.dayId).push({ key: place.leg === null ? `res:${res.id}` : `res:${res.id}:${place.leg}`, kind: 'res', id: res.id, entity: res, leg: place.leg,
        phase: place.phase, family, order: res.dayPos?.[place.dayId] ?? null, time: place.time, end: place.end, primary: true });
    }
  }
  const entries = days.map((day, index) => ({ day, index, number: index + 1, color: dayColor(day, index), date: isDate(day.date) ? day.date : null, rows: sortRows(rows.get(day.id)), stays: stays.get(day.id) }));
  return { days: entries, byDay: new Map(entries.map((entry) => [entry.day.id, entry])), orphans };
}

/** Stop numbers for located visits in display order: `Map<visitId, n>`. */
export function stopNumbers(rows, located = (visit) => visit.placeId != null) {
  const numbers = new Map();
  for (const row of rows) if (row.kind === 'visit' && row.primary && located(row.entity)) numbers.set(row.id, numbers.size + 1);
  return numbers;
}

function writeFor(row, order, dayId) {
  if (row.kind === 'visit') return { t: 'visit', id: row.id, set: { order } };
  if (row.kind === 'note') return { t: 'dayNote', id: row.id, set: { order } };
  return { t: 'res', id: row.id, set: { [`dayPos.${dayId}`]: order } };
}

/**
 * The order key for an item dropped at `index` among a day's rows (counted without the moved row `skip`; out of range
 * means the end), plus patches (`{t, id, set}`) that give unpositioned bookings a key so the item lands exactly there.
 * `count` items get `orders` in sequence. Renumbers the day when neighbouring keys collide.
 */
export function placeAt(rows, index, dayId, { skip = null, count = 1 } = {}) {
  const list = rows.filter((row) => row.key !== skip);
  const slots = Array.from({ length: count }, () => ({ key: '', order: null, primary: true }));
  const isSlot = new Set(slots);
  const at = Number.isInteger(index) && index >= 0 ? Math.min(index, list.length) : list.length;
  const keyable = [...list.slice(0, at), ...slots, ...list.slice(at)].filter((row) => row.primary);
  const assigned = new Map();
  try {
    for (let start = 0; start < keyable.length;) {
      if (!isSlot.has(keyable[start]) && keyable[start].order != null) { start++; continue; }
      let stop = start;
      while (stop < keyable.length && (isSlot.has(keyable[stop]) || keyable[stop].order == null)) stop++;
      const keys = orderKeys(stop - start, start > 0 ? keyable[start - 1].order : null, stop < keyable.length ? keyable[stop].order : null);
      keys.forEach((key, offset) => assigned.set(keyable[start + offset], key));
      start = stop;
    }
  } catch {
    assigned.clear();
    orderKeys(keyable.length).forEach((key, position) => assigned.set(keyable[position], key));
  }
  const writes = [];
  const seen = new Set();
  for (const [row, order] of assigned) {
    if (isSlot.has(row)) continue;
    const target = `${row.kind}:${row.id}`;
    if (seen.has(target)) continue;
    seen.add(target);
    writes.push(writeFor(row, order, dayId));
  }
  const orders = slots.map((slot) => assigned.get(slot));
  return { order: orders[0], orders, writes };
}

/** Index (among rows without `skip`) where an item at `time` belongs: before the first row taken to be later (`rowTimes`). */
export function indexForTime(rows, time, { skip = null } = {}) {
  const list = rows.filter((row) => row.key !== skip);
  const at = minutes(time);
  if (at === null) return list.length;
  const times = rowTimes(list);
  const index = list.findIndex((row, position) => row.phase !== 'middle' && times[position] > at);
  return index === -1 ? list.length : index;
}

const pad = (value) => String(value).padStart(2, '0');
/** Local `YYYY-MM-DDTHH:mm` for a Date. */
export const localStamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** The next `limit` timed items on dated days at or after `now`: `[{at, date, time, row, entry}]`. */
export function upcoming(timeline, { now = new Date(), limit = 8 } = {}) {
  const stamp = typeof now === 'string' ? now : localStamp(now);
  const items = [];
  for (const entry of timeline.days) {
    if (!entry.date) continue;
    for (const row of entry.rows) {
      if (!row.primary || !isTime(row.time)) continue;
      const at = `${entry.date}T${row.time}`;
      if (at >= stamp) items.push({ at, date: entry.date, time: row.time, row, entry });
    }
  }
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, limit);
}
