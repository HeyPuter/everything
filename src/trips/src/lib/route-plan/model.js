import { distance } from '../../services/route.js';

// Turns trip entities into per-day stop sequences for routing, optimizing and travel times.
// Visits carry `order` keys; a reservation placed on a day uses `dayPos[dayId]` in the same key space.

export const TRANSPORT_TYPES = Object.freeze(['flight', 'train', 'bus', 'car', 'taxi', 'bike', 'cruise', 'ferry', 'transit', 'transport']);
export const MODES = Object.freeze(['walk', 'drive', 'bike', 'transit']);
const TRANSPORTS = new Set(TRANSPORT_TYPES);
const DEFAULT_MODE = 'walk';

export const isTransport = (res) => TRANSPORTS.has(res?.type);
export const mode = (value, fallback = DEFAULT_MODE) => (MODES.includes(value) ? value : fallback);

/** `{lat, lng}` → `[lng, lat]`, or null when missing or out of range. */
export function coords(value) {
  if (!value || !Number.isFinite(value.lat) || !Number.isFinite(value.lng)) return null;
  if (Math.abs(value.lat) > 90 || Math.abs(value.lng) > 180) return null;
  return [value.lng, value.lat];
}
const latLng = (point) => (point ? { lat: point[1], lng: point[0] } : null);
// Connections land within a couple of kilometres of the next departure (airport and station coordinates vary).
const near = (a, b) => Boolean(a && b) && distance(a, b) < 2000;

/** Orders transports without a time so each one leaves from where the previous one arrived. */
function chained(items) {
  const left = [...items]; const result = [];
  while (left.length) {
    const first = left.findIndex((item) => !left.some((other) => other !== item && near(other.to, item.from)));
    let current = left.splice(first === -1 ? 0 : first, 1)[0];
    result.push(current);
    for (let next = left.findIndex((item) => near(current.to, item.from)); next !== -1; next = left.findIndex((item) => near(current.to, item.from))) {
      current = left.splice(next, 1)[0];
      result.push(current);
    }
  }
  return result;
}
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Start of a reservation: `start`, else the first leg's departure. */
export function resStart(res) { return res.start ?? res.legs?.[0]?.dep ?? null; }
/** End of a reservation: `end`, else the last leg's arrival. */
export function resEnd(res) { return res.end ?? res.legs?.at(-1)?.arr ?? null; }

/**
 * Indexes days, places, visits and reservations. Arrays are the store's selector results (`space.select.*.all()`).
 * `timeline(dayId)` may return the canonical merged order `[{t: 'visit'|'res', id}]`; otherwise visits and
 * reservations are merged by position key, then by time.
 */
export function createTripModel({ days = [], visits = [], places = [], reservations = [], timeline } = {}) {
  const placeById = new Map(places.map((place) => [place.id, place]));
  const resById = new Map(reservations.map((res) => [res.id, res]));
  const dayIndex = new Map(days.map((day, i) => [day.id, i]));
  const visitsByDay = new Map();
  for (const visit of visits) {
    if (!visitsByDay.has(visit.dayId)) visitsByDay.set(visit.dayId, []);
    visitsByDay.get(visit.dayId).push(visit);
  }
  for (const list of visitsByDay.values()) list.sort((a, b) => byKey(a.order, b.order) || byKey(a.id, b.id));
  const active = reservations.filter((res) => res.status !== 'cancelled');

  const placePoint = (id) => coords(placeById.get(id));
  const visitPoint = (visit) => (visit?.placeId ? placePoint(visit.placeId) : null);
  const resPoint = (res) => coords(res.location) ?? (res.placeId ? placePoint(res.placeId) : null);
  function transportEnds(res) {
    const legs = (res.legs ?? []).filter((leg) => coords(leg.from) || coords(leg.to));
    if (legs.length) return { from: coords(legs[0].from), to: coords(legs.at(-1).to) };
    return { from: resPoint(res), to: null };
  }

  // Day index for an ISO date; dates before the first or after the last dated day clamp outside the range.
  function indexOfDate(date) {
    if (!date) return undefined;
    const exact = days.findIndex((day) => day.date === date);
    if (exact !== -1) return exact;
    const dated = days.filter((day) => day.date);
    if (!dated.length) return undefined;
    if (date < dated[0].date) return -1;
    if (date > dated.at(-1).date) return days.length;
    return undefined;
  }
  const stays = active.flatMap((res) => {
    if (res.type !== 'lodging') return [];
    const point = resPoint(res);
    const from = dayIndex.get(res.stay?.fromDayId) ?? indexOfDate(res.start?.date);
    const to = dayIndex.get(res.stay?.toDayId) ?? indexOfDate(res.end?.date);
    if (!point || from === undefined || to === undefined || to < from) return [];
    return [{ res, point, from, to }];
  }).sort((a, b) => b.from - a.from || byKey(a.res.id, b.res.id));

  /** The stay you wake up at on day `index` and the one you sleep at that night. */
  function staysFor(index) {
    return {
      morning: stays.find((stay) => stay.from < index && index <= stay.to) ?? null,
      evening: stays.find((stay) => stay.from <= index && index < stay.to) ?? null,
    };
  }

  /**
   * Non-lodging reservations on a day, as timeline items: on their start date or any day in `dayPos` (which also
   * gives the position). A transport that started on an earlier date adds its arrival point on its end date.
   */
  function bookings(day) {
    const list = [];
    const visitIds = new Set((visitsByDay.get(day.id) ?? []).map((visit) => visit.id));
    const placeIds = new Set((visitsByDay.get(day.id) ?? []).map((visit) => visit.placeId).filter(Boolean));
    for (const res of active) {
      if (res.type === 'lodging') continue;
      const key = res.dayPos?.[day.id];
      const start = resStart(res); const end = resEnd(res);
      const onStart = Boolean(day.date) && start?.date === day.date;
      if (isTransport(res)) {
        const { from, to } = transportEnds(res);
        const arrives = !onStart && Boolean(day.date) && end?.date === day.date && Boolean(start?.date) && start.date < day.date && Boolean(to);
        if (arrives) list.push({ t: 'res', id: res.id, entity: res, kind: 'arrival', point: to, key, time: end?.time });
        else if (onStart || key !== undefined) list.push({ t: 'res', id: res.id, entity: res, kind: 'transport', from, to, key, time: start?.time });
        continue;
      }
      if (key === undefined && !onStart) continue;
      if (visitIds.has(res.visitId) || (res.placeId && placeIds.has(res.placeId))) continue;
      list.push({ t: 'res', id: res.id, entity: res, kind: 'booking', point: resPoint(res), key, time: start?.time });
    }
    return list;
  }

  function merged(day) {
    const visitItems = (visitsByDay.get(day.id) ?? []).map((visit) => ({ t: 'visit', id: visit.id, entity: visit, point: visitPoint(visit), key: visit.order, time: visit.start }));
    const resItems = bookings(day);
    const custom = typeof timeline === 'function' ? timeline(day.id) : null;
    if (Array.isArray(custom)) {
      const lookup = new Map([...visitItems, ...resItems].map((item) => [`${item.t}:${item.id}`, item]));
      return custom.flatMap((entry) => lookup.get(`${entry.t}:${entry.id}`) ?? []);
    }
    const keyed = [...visitItems, ...resItems.filter((item) => item.key !== undefined)]
      .sort((a, b) => byKey(a.key, b.key) || (a.t === b.t ? byKey(a.id, b.id) : a.t === 'visit' ? -1 : 1));
    const loose = resItems.filter((item) => item.key === undefined);
    const timed = loose.filter((item) => item.time).sort((a, b) => byKey(a.time, b.time) || byKey(a.id, b.id));
    // Timed bookings go before the first later timed item; arrivals also go before untimed ones.
    for (const item of timed) {
      const index = keyed.findIndex((other) => (other.time ? other.time > item.time : item.kind === 'arrival'));
      keyed.splice(index === -1 ? keyed.length : index, 0, item);
    }
    const untimed = loose.filter((item) => !item.time);
    return [...untimed.filter((item) => item.kind === 'arrival'), ...keyed, ...chained(untimed.filter((item) => item.kind !== 'arrival'))];
  }

  /**
   * One day as a stop sequence. `items` keep every visit and placed booking in order (with `point` null when
   * unlocated); `input` is the `planDay` input, with ids `visit:<id>`, `res:<id>` and `stay:<id>`.
   */
  function dayStops(dayId) {
    const index = dayIndex.get(dayId);
    if (index === undefined) return null;
    const day = days[index];
    const dayMode = mode(day.mode);
    const items = merged(day);
    let previous = null;
    for (const item of items) {
      if (item.t === 'visit') {
        item.mode = mode(item.entity.inMode, mode(previous?.entity.legMode, dayMode));
        previous = item;
      } else if (item.kind === 'transport') previous = null;
      else item.mode = mode(previous?.entity.legMode, dayMode);
    }
    const { morning, evening } = staysFor(index);
    const stops = [];
    for (const item of items) {
      if (item.kind === 'transport') {
        if (item.from || item.to) stops.push({ id: `res:${item.id}`, transport: { type: item.entity.type, status: item.entity.status, from: latLng(item.from), to: latLng(item.to) } });
      } else if (item.point) stops.push({ id: `${item.t}:${item.id}`, ...latLng(item.point), mode: item.mode });
    }
    if (evening) {
      const last = items.findLast((item) => item.t === 'visit' || item.kind === 'transport');
      stops.push({ id: `stay:${evening.res.id}`, ...latLng(evening.point), mode: mode(last?.t === 'visit' ? last.entity.legMode : undefined, dayMode) });
    }
    const input = { start: morning ? { id: `stay:${morning.res.id}`, ...latLng(morning.point) } : null, stops, end: null, mode: dayMode };
    return { dayId, day, index, mode: dayMode, items, start: morning, end: evening, input };
  }

  return {
    days, dayIndex, stays,
    place: (id) => placeById.get(id) ?? null,
    res: (id) => resById.get(id) ?? null,
    visits: (dayId) => visitsByDay.get(dayId) ?? [],
    reservations: active,
    placePoint, visitPoint, resPoint, transportEnds, staysFor, dayStops,
  };
}

/** Parses a planDay stop id (`visit:<id>`, `res:<id>`, `stay:<id>`) into `{t, id}`; `stay` refers to a lodging `res`. */
export function stopRef(value) {
  const [kind, id] = String(value ?? '').split(':');
  if (!id) return null;
  return kind === 'stay' ? { t: 'res', id, stay: true } : { t: kind, id };
}
