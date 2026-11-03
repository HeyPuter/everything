// Distance flown: great-circle length of the flight legs the user has taken.
import { isDate } from '../../shared/dates.js';
import { EARTH_RADIUS_M, distanceMeters } from '../../shared/geo.js';
import { tripPhase } from './aggregate.js';

export { EARTH_RADIUS_M };
export const EARTH_CIRCUMFERENCE_M = 40_075_017; // at the equator, for "times around the Earth"

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPoint = (point) => finite(point?.lat) && finite(point?.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
const iata = (value) => (typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : null);

/** Great-circle (haversine) distance in metres between two `{lat, lng}` points; NaN when either is invalid. */
export function greatCircleMeters(a, b) {
  return validPoint(a) && validPoint(b) ? distanceMeters(a, b) : Number.NaN;
}

function endpoint(stop, airport) {
  const code = iata(stop?.code);
  if (validPoint(stop)) return { code, name: typeof stop.name === 'string' ? stop.name : '', lat: stop.lat, lng: stop.lng };
  const row = code ? airport(code) : null;
  if (!validPoint(row)) return null;
  return { code, name: (typeof stop?.name === 'string' && stop.name) || row.name || code, lat: row.lat, lng: row.lng };
}
const stopKey = (point) => point.code ?? `${point.lat.toFixed(2)},${point.lng.toFixed(2)}`;
const flightNumber = (leg) => `${leg.carrier ?? ''}${leg.number ?? ''}`.replace(/\s+/g, '').toUpperCase();

/**
 * Flight legs the user has flown: legs of `flight` reservations in started trips that departed on or before `today`,
 * skipping cancelled bookings and bookings whose `people` list leaves the user out. Endpoints use the leg's
 * coordinates, else `airport(iata)` (`{lat, lng, name}`). The same flight in two trips counts once.
 * Returns `{legs: [{tripKey, resId, date, from, to, number, meters}], unresolved}` sorted by date.
 */
export function flightLegs(trips, { today, uid = null, airport = () => null }) {
  if (!isDate(today)) throw new RangeError('today must be an ISO date');
  const legs = []; const seen = new Set();
  let unresolved = 0;
  for (const trip of trips) {
    if (!trip?.cached || tripPhase(trip, today) !== 'started') continue;
    for (const res of Array.isArray(trip.res) ? trip.res : []) {
      if (!plain(res) || res.type !== 'flight' || res.status === 'cancelled') continue;
      if (uid && Array.isArray(res.people) && res.people.length && !res.people.includes(uid)) continue;
      for (const leg of Array.isArray(res.legs) ? res.legs : []) {
        if (!plain(leg) || !isDate(leg.dep?.date) || leg.dep.date > today) continue;
        const from = endpoint(leg.from, airport); const to = endpoint(leg.to, airport);
        if (!from || !to) { unresolved += 1; continue; }
        const number = flightNumber(leg);
        const key = [leg.dep.date, stopKey(from), stopKey(to), number].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        legs.push({ tripKey: trip.key, resId: res.id ?? null, date: leg.dep.date, from, to, number, meters: greatCircleMeters(from, to) });
      }
    }
  }
  legs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { legs, unresolved };
}

/**
 * Totals for `flightLegs` output: `{flights, meters, longest, shortest, airports, aroundEarth, byYear, unresolved}`.
 * `byYear` is `[{year, flights, meters}]`, newest first.
 */
export function flightStats({ legs = [], unresolved = 0 } = {}) {
  let meters = 0; let longest = null; let shortest = null;
  const airports = new Set(); const years = new Map();
  for (const leg of legs) {
    meters += leg.meters;
    if (!longest || leg.meters > longest.meters) longest = leg;
    if (!shortest || leg.meters < shortest.meters) shortest = leg;
    airports.add(stopKey(leg.from)); airports.add(stopKey(leg.to));
    const year = Number(leg.date.slice(0, 4));
    const entry = years.get(year) ?? { year, flights: 0, meters: 0 };
    entry.flights += 1; entry.meters += leg.meters;
    years.set(year, entry);
  }
  return {
    flights: legs.length, meters, longest, shortest, airports: airports.size,
    aroundEarth: meters / EARTH_CIRCUMFERENCE_M,
    byYear: [...years.values()].sort((a, b) => b.year - a.year),
    unresolved,
  };
}
