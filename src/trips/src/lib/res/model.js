import { isDate, isTime, isTimeZone } from '../../shared/dates.js';
import { DomainError } from '../../shared/errors.js';
import { isId } from '../../shared/ids.js';
import { validateEntity } from '../../shared/schema/index.js';
import { comparePoints, wallOf } from './time.js';
import { LEG_FIELDS, STATUSES, isLodging, isTransport } from './types.js';

const STAMPS = new Set(['id', 'v', 'rev', 'upd', 'by', 'cr', 't', 'deleted']);
const LEG_TEXT = ['carrier', 'number', 'seat', 'cls', 'code', 'platform', 'coach', 'mode'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

function point(value) {
  if (!value || !isDate(value.date)) return undefined;
  return compact({ date: value.date, time: isTime(value.time) ? value.time : undefined, tz: isTimeZone(value.tz) ? value.tz : undefined });
}
function endpoint(value = {}) {
  const lat = finite(value.lat);
  const lng = finite(value.lng);
  const located = lat !== undefined && lng !== undefined;
  return compact({
    name: text(value.name), code: text(value.code)?.toUpperCase(), lat: located ? lat : undefined, lng: located ? lng : undefined,
    tz: isTimeZone(value.tz) ? value.tz : undefined,
  });
}
function location(value) {
  if (!value) return undefined;
  const lat = finite(value.lat);
  const lng = finite(value.lng);
  const located = lat !== undefined && lng !== undefined;
  const result = compact({ name: text(value.name), address: text(value.address), lat: located ? lat : undefined, lng: located ? lng : undefined });
  return Object.keys(result).length ? result : undefined;
}
function leg(value, type) {
  const dep = point(value.dep);
  const arr = point({ date: value.arr?.date || dep?.date, time: value.arr?.time });
  const allowed = new Set([...(LEG_FIELDS[type] ?? []), 'color', 'shape']);
  const extra = Object.fromEntries(LEG_TEXT.filter((key) => allowed.has(key)).map((key) => [key, text(value[key])]));
  return compact({
    from: endpoint(value.from), to: endpoint(value.to),
    dep: dep ? { date: dep.date, ...(dep.time ? { time: dep.time } : {}) } : value.dep,
    arr: arr ? { date: arr.date, ...(arr.time ? { time: arr.time } : {}) } : value.arr,
    ...extra, color: value.color ?? undefined, shape: typeof value.shape === 'string' ? value.shape : undefined,
  });
}

/** A blank leg; a connecting leg starts where the previous one ended. */
export function emptyLeg(previous) {
  return {
    from: previous?.to ? { ...previous.to } : {}, to: {},
    dep: { date: previous?.arr?.date ?? '', time: '' }, arr: { date: previous?.arr?.date ?? '', time: '' },
  };
}

/**
 * The stored shape of a reservation from form state: trimmed text, empty optionals dropped, fields that do not
 * belong to the type removed. Transports keep `start`/`end` equal to the first departure and last arrival so
 * readers that ignore legs (dashboard, feeds) still see when they happen. Returns the fields for `put`.
 */
export function normalizeRes(draft) {
  const type = draft.type;
  const transport = isTransport(type);
  const legs = transport ? (draft.legs ?? []).map((item) => leg(item, type)) : undefined;
  const first = legs?.[0];
  const last = legs?.at(-1);
  const stay = isLodging(type) && draft.stay ? compact({
    checkInFrom: isTime(draft.stay.checkInFrom) ? draft.stay.checkInFrom : undefined,
    checkInUntil: isTime(draft.stay.checkInUntil) ? draft.stay.checkInUntil : undefined,
    checkOut: isTime(draft.stay.checkOut) ? draft.stay.checkOut : undefined,
    fromDayId: isId(draft.stay.fromDayId) ? draft.stay.fromDayId : undefined,
    toDayId: isId(draft.stay.fromDayId) && isId(draft.stay.toDayId) ? draft.stay.toDayId : undefined,
  }) : undefined;
  const people = [...new Set((draft.people ?? []).filter((who) => typeof who === 'string' && who))];
  const dayPos = draft.dayPos && Object.keys(draft.dayPos).length ? { ...draft.dayPos } : undefined;
  return compact({
    type, title: text(draft.title) ?? '', status: STATUSES.includes(draft.status) ? draft.status : 'pending', code: text(draft.code),
    start: transport ? point(first && { date: first.dep?.date, time: first.dep?.time, tz: first.from?.tz }) : point(draft.start),
    end: transport ? point(last && { date: last.arr?.date, time: last.arr?.time, tz: last.to?.tz }) : (point(draft.start) ? point(draft.end) : undefined),
    location: transport ? undefined : location(draft.location),
    placeId: isId(draft.placeId) ? draft.placeId : undefined,
    visitId: isId(draft.visitId) ? draft.visitId : undefined,
    stayId: !isLodging(type) && isId(draft.stayId) ? draft.stayId : undefined,
    url: text(draft.url), notes: text(draft.notes), people: people.length ? people : undefined,
    legs: legs?.length ? legs : undefined,
    stay: stay && Object.keys(stay).length ? stay : undefined,
    dayPos, review: draft.review === true ? true : undefined, src: draft.src ?? undefined,
  });
}

/** Schema issues for a normalized reservation (`[]` when valid), as `{path, rule}`. */
export function resIssues(fields) {
  try { validateEntity('trip', 'res', fields); return []; }
  catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return error.issues?.length ? error.issues : [{ path: [], rule: error.code }];
  }
}

/**
 * `{set, unset}` turning `before` into `after`. Top-level fields are replaced whole, except `dayPos`, which is
 * patched per day so positions set elsewhere for other days survive.
 */
export function resPatch(before, after) {
  const set = {};
  const unset = [];
  const fields = new Set([...Object.keys(before), ...Object.keys(after)].filter((field) => !STAMPS.has(field)));
  for (const field of fields) {
    if (field === 'dayPos') {
      const a = before.dayPos ?? {};
      const b = after.dayPos ?? {};
      for (const day of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!Object.hasOwn(b, day)) unset.push(`dayPos.${day}`);
        else if (a[day] !== b[day]) set[`dayPos.${day}`] = b[day];
      }
    } else if (!Object.hasOwn(after, field)) unset.push(field);
    else if (!same(before[field], after[field])) set[field] = structuredClone(after[field]);
  }
  return { set, unset };
}

/** A draft of the way back: legs reversed with swapped endpoints, carrier kept, dates and per-seat details cleared. */
export function returnDraft(res) {
  const legs = [...(res.legs ?? [])].reverse().map((item) => ({
    from: { ...item.to }, to: { ...item.from }, carrier: item.carrier, cls: item.cls, mode: item.mode,
    dep: { date: '', time: '' }, arr: { date: '', time: '' },
  }));
  return {
    type: res.type, title: '', status: 'pending', people: [...(res.people ?? [])], legs: legs.length ? legs : [emptyLeg()],
    ...(res.stayId ? { stayId: res.stayId } : {}),
  };
}

/** A draft copy: everything but identity, day positions and import state. */
export function duplicateDraft(res) {
  const copy = structuredClone(Object.fromEntries(Object.entries(res).filter(([key]) => !STAMPS.has(key))));
  delete copy.dayPos; delete copy.review; delete copy.src;
  return copy;
}

/** A title from the data when the user leaves it empty: "LIS → JFK", the place name, or carrier and number. */
export function suggestTitle(draft) {
  if (isTransport(draft.type)) {
    const legs = draft.legs ?? [];
    const stops = [legs[0]?.from, ...legs.map((item) => item.to)].map((end) => text(end?.code) ?? text(end?.name)).filter(Boolean);
    if (stops.length >= 2) return [stops[0], stops.at(-1)].join(' → ');
    const first = legs[0];
    return [text(first?.carrier), text(first?.number)].filter(Boolean).join(' ');
  }
  return text(draft.location?.name) ?? '';
}

/** Sort key: the first local point's wall clock, undated last. */
export function resWhen(res) {
  return wallOf(res.legs?.[0] ? { date: res.legs[0].dep?.date, time: res.legs[0].dep?.time } : res.start) ?? Infinity;
}
export function compareRes(a, b) {
  const order = comparePoints(a.start, b.start);
  if (order) return order;
  const wall = resWhen(a) - resWhen(b);
  if (wall) return wall;
  return (a.title ?? '').localeCompare(b.title ?? '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Filters for the bookings list. `group`: all|transport|booking; `type`; `traveler` (member uuid or guest id); `status`. */
export function filterRes(list, { group = 'all', type = '', traveler = '', status = '' } = {}) {
  return list.filter((res) => (group === 'all' || (group === 'transport') === isTransport(res.type))
    && (!type || res.type === type) && (!status || res.status === status)
    && (!traveler || (res.people ?? []).includes(traveler)));
}

/** `{pending, confirmed, cancelled}`, each sorted by start. */
export function groupByStatus(list) {
  const groups = { pending: [], confirmed: [], cancelled: [] };
  for (const res of list) (groups[res.status] ?? groups.pending).push(res);
  for (const items of Object.values(groups)) items.sort(compareRes);
  return groups;
}
