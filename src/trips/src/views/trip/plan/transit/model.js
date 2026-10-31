// Transit search between two planned stops: search defaults and turning a chosen connection into a booking.
import { DAY_START } from '../../../../lib/timeline/index.js';
import { isDate, isTime, isTimeZone, minutesTime, timeMinutes, zonedParts } from '../../../../shared/dates.js';
import { isOrder, orderBetween } from '../../../../shared/order.js';
import { zonedEpoch } from '../../../../lib/res/time.js';
import { normalizeRes } from '../../../../lib/res/index.js';

const ON_FOOT = new Set(['walk', 'bike', 'car']);
export const isRide = (leg) => !ON_FOOT.has(leg?.mode);
const zoneOr = (zone, fallback = 'UTC') => (isTimeZone(zone) ? zone : isTimeZone(fallback) ? fallback : 'UTC');

/**
 * Search defaults `{date, time, arriveBy}` for the way from visit `from` to visit `to`, as local times in the
 * departure's zone: leave at `from`'s end (set, or as scheduled), else arrive by `to`'s start, else leave after
 * `from`'s start plus its dwell (an hour without one), else at the day start. Undated days search today.
 */
export function defaultSearch({ from, to, day, info, now, zone }) {
  const date = isDate(day?.date) ? day.date : zonedParts(now, zoneOr(zone)).date;
  if (isTime(from?.end)) return { date, time: from.end, arriveBy: false };
  const planned = info?.get?.(`visit:${from?.id}`)?.endWall;
  if (planned && isTime(planned.time) && !planned.offset) return { date, time: planned.time, arriveBy: false };
  if (isTime(to?.start)) return { date, time: to.start, arriveBy: true };
  if (isTime(from?.start)) {
    const end = timeMinutes(from.start) + (Number.isInteger(from.dwell) ? from.dwell : 60);
    if (end < 1440) return { date, time: minutesTime(end), arriveBy: false };
  }
  return { date, time: minutesTime(DAY_START), arriveBy: false };
}

/** The instant of a search's local date and time in `zone`. */
export function searchInstant({ date, time }, zone) {
  if (!isDate(date) || !isTime(time)) return null;
  return zonedEpoch(date, time, zoneOr(zone));
}

/** Local `{date, time}` of an instant, plus `offset` days from `baseDate`. */
export function localTime(epoch, zone, baseDate) {
  const parts = zonedParts(epoch, zoneOr(zone));
  const offset = isDate(baseDate) ? Math.round((Date.parse(`${parts.date}T00:00:00Z`) - Date.parse(`${baseDate}T00:00:00Z`)) / 86_400_000) : 0;
  return { date: parts.date, time: parts.time, offset };
}

const stopKey = (stop) => `${stop.lat.toFixed(5)},${stop.lng.toFixed(5)}`;
/** Stops of a connection's rides that need a zone looked up (those the provider gave none for). */
export function stopsNeedingZones(itinerary) {
  const stops = new Map();
  for (const leg of itinerary?.legs ?? []) {
    if (!isRide(leg)) continue;
    for (const stop of [leg.from, leg.to]) if (!isTimeZone(stop.tz)) stops.set(stopKey(stop), stop);
  }
  return [...stops.values()];
}

/**
 * Booking fields (`normalizeRes`) for a chosen connection: a confirmed `transit` reservation with one leg per ride
 * (walks are left to the day route), times local to each stop's zone. `zones` maps `lat,lng` (5 decimals) to a zone
 * for stops without one; `zone` is the fallback. On `dayId`, the booking sits between the two visits' positions.
 */
export function connectionDraft(itinerary, { title, zones = new Map(), zone, dayId, fromOrder, toOrder } = {}) {
  const zoneOf = (stop) => zoneOr(stop.tz, zones.get(stopKey(stop)) ?? zone);
  const legs = (itinerary?.legs ?? []).filter(isRide).map((leg) => {
    const fromZone = zoneOf(leg.from); const toZone = zoneOf(leg.to);
    const dep = zonedParts(leg.start, fromZone); const arr = zonedParts(leg.end, toZone);
    return {
      from: { name: leg.from.name ?? undefined, lat: leg.from.lat, lng: leg.from.lng, tz: fromZone },
      to: { name: leg.to.name ?? undefined, lat: leg.to.lat, lng: leg.to.lng, tz: toZone },
      dep: { date: dep.date, time: dep.time }, arr: { date: arr.date, time: arr.time },
      carrier: leg.agency ?? undefined, number: leg.route ?? undefined, mode: leg.mode, platform: leg.from.track ?? undefined,
      color: leg.color ?? undefined, shape: leg.shape ?? undefined,
    };
  });
  const dayPos = dayId && isOrder(fromOrder) && (toOrder == null || (isOrder(toOrder) && fromOrder < toOrder))
    ? { [dayId]: orderBetween(fromOrder, toOrder ?? null) } : undefined;
  return normalizeRes({ type: 'transit', title, status: 'confirmed', legs, dayPos });
}
