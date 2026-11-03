import { addDays, daysBetween, isDate, isTime } from '../../shared/dates.js';
import { continentOf, countryCode } from './countries.js';
import { isRegionCode } from './regions.js';

const TRANSPORT = new Set(['flight', 'train', 'bus', 'car', 'taxi', 'bike', 'cruise', 'ferry', 'transit', 'transport']);
// A connection shorter than this is a layover; a longer stop counts as a visit.
const LAYOVER_MINUTES = 24 * 60;
const NEAR_DEGREES = 0.5;

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const minDate = (a, b) => (a <= b ? a : b);

export { localDate as localToday } from '../../shared/dates.js';

/** `started` (start on or before today), `future`, or `undated`. */
export function tripPhase(trip, today) {
  if (!isDate(trip?.start)) return 'undated';
  return trip.start <= today ? 'started' : 'future';
}

/** The trip's dates actually travelled so far: start through the earlier of end and today. */
function travelledRange(trip, today) {
  const end = isDate(trip.end) && trip.end >= trip.start ? trip.end : trip.start;
  return [trip.start, minDate(end, today)];
}

// Minutes between a local arrival and the next local departure at the same stop (both in that stop's zone).
function gapMinutes(arrival, departure) {
  if (!isDate(arrival?.date) || !isDate(departure?.date)) return null;
  const minutes = (time) => (isTime(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : null);
  const a = minutes(arrival.time); const d = minutes(departure.time);
  const days = daysBetween(arrival.date, departure.date);
  if (a === null || d === null) return days * 1440;
  return days * 1440 + d - a;
}
function sameStop(a, b) {
  if (typeof a?.code === 'string' && typeof b?.code === 'string' && a.code && b.code) return a.code.toUpperCase() === b.code.toUpperCase();
  if (finite(a?.lat) && finite(a?.lng) && finite(b?.lat) && finite(b?.lng)) return Math.abs(a.lat - b.lat) < NEAR_DEGREES && Math.abs(a.lng - b.lng) < NEAR_DEGREES;
  return true;
}
function layover(previous, next) {
  if (!previous || !next || !sameStop(previous.to, next.from)) return false;
  const gap = gapMinutes(previous.arr, next.dep);
  return gap === null || gap < LAYOVER_MINUTES;
}

/**
 * Stops a reservation puts on the map: a booking's location, or a transport's endpoints without its layovers
 * (a connection at the same stop within 24 hours). Cancelled reservations have none.
 */
export function reservationStops(res) {
  if (!plain(res) || res.status === 'cancelled') return [];
  const legs = Array.isArray(res.legs) ? res.legs.filter(plain) : [];
  if (TRANSPORT.has(res.type) || legs.length) {
    const stops = [];
    legs.forEach((leg, index) => {
      if (plain(leg.from) && !layover(legs[index - 1], leg)) stops.push({ ...leg.from, date: leg.dep?.date ?? null });
      if (plain(leg.to) && !layover(leg, legs[index + 1])) stops.push({ ...leg.to, date: leg.arr?.date ?? leg.dep?.date ?? null });
    });
    return stops;
  }
  const location = res.location;
  if (!plain(location) || !finite(location.lat) || !finite(location.lng)) return [];
  return [{ name: location.name, lat: location.lat, lng: location.lng, date: res.start?.date ?? null }];
}

function placeKey(place, tripKey) {
  if (typeof place.ids?.osm === 'string' && place.ids.osm) return `osm:${place.ids.osm}`;
  if (typeof place.ids?.wikidata === 'string' && place.ids.wikidata) return `wd:${place.ids.wikidata}`;
  if (finite(place.lat) && finite(place.lng)) return `ll:${place.lat.toFixed(4)},${place.lng.toFixed(4)}`;
  return `id:${tripKey}:${place.id}`;
}

function travelDays(ranges) {
  const sorted = ranges.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let total = 0; let current = null;
  for (const [start, end] of sorted) {
    if (current && start <= addDays(current[1], 1)) { if (end > current[1]) current[1] = end; continue; }
    if (current) total += daysBetween(current[0], current[1]) + 1;
    current = [start, end];
  }
  if (current) total += daysBetween(current[0], current[1]) + 1;
  return total;
}

/** Consecutive calendar years with travel, ending this year (or last year while this one has none yet). */
function yearStreak(years, year) {
  let end = years.has(year) ? year : years.has(year - 1) ? year - 1 : null;
  let streak = 0;
  while (end !== null && years.has(end)) { streak += 1; end -= 1; }
  return streak;
}

/**
 * `trips`: `[{key, ref, title, start, end, cached, places: [place], res: [res]}]` (places and reservations only when
 * the replica is on this device). `marks`: the `me:atlas` value. `bucket`: bucket-list index entries.
 * `locate(lat, lng)` maps a point to a country code.
 *
 * A country is visited when a place or stop of a started trip is in it, when the user marked a place there visited
 * (any trip), when a bucket-list item there is visited, or when the user marked the country by hand. Hidden countries
 * drop out unless marked by hand or by the bucket list. Countries only future trips reach are planned. Undated trips
 * count only through the user's own place marks. Countries of open bucket-list items that are not visited are the
 * wishlist. Items carry `lat`, `lng` and `admin1` for region matching.
 */
export function aggregateAtlas({ trips = [], marks = null, bucket = [], uid = null, today, locate = () => null, airportCountry = () => null }) {
  if (!isDate(today)) throw new RangeError('today must be an ISO date');
  const manual = new Set(Object.entries(plain(marks?.visited) ? marks.visited : {}).filter(([, src]) => src != null && src !== false).map(([code]) => countryCode(code)).filter(Boolean));
  const hidden = new Set(Object.entries(plain(marks?.hidden) ? marks.hidden : {}).filter(([, value]) => value === true).map(([code]) => countryCode(code)).filter(Boolean));
  const found = new Map();
  const entry = (code) => {
    if (!found.has(code)) found.set(code, { code, visited: false, planned: false, last: null, next: null, trips: new Set(), items: [] });
    return found.get(code);
  };
  const resolve = (point) => countryCode(point.cc) ?? (finite(point.lat) && finite(point.lng) ? locate(point.lat, point.lng) : null) ?? (typeof point.code === 'string' && /^[A-Za-z]{3}$/.test(point.code) ? countryCode(airportCountry(point.code.toUpperCase())) : null);

  const ranges = [];
  const years = new Set();
  const visitedPlaces = new Set();
  const year = Number(today.slice(0, 4));
  let started = 0; let future = 0; let thisYear = 0; let undated = 0; let uncached = 0;

  for (const trip of trips) {
    const phase = tripPhase(trip, today);
    if (phase === 'started') {
      started += 1;
      const range = travelledRange(trip, today);
      ranges.push(range);
      for (let y = Number(range[0].slice(0, 4)); y <= Number(range[1].slice(0, 4)); y++) years.add(y);
      if (range[1] >= `${year}-01-01`) thisYear += 1;
    } else if (phase === 'future') future += 1;
    else undated += 1;
    if (!trip.cached) { uncached += 1; continue; }
    const last = phase === 'started' ? travelledRange(trip, today)[1] : null;
    const note = (code, kind, item, visited) => {
      const country = entry(code);
      country.trips.add(trip.key);
      country.items.push({ kind, tripKey: trip.key, id: item.id ?? null, name: item.name ?? '', planned: !visited, mine: kind === 'place' && item.visited?.[uid] === true,
        lat: finite(item.lat) ? item.lat : null, lng: finite(item.lng) ? item.lng : null, admin1: isRegionCode(item.admin1) ? item.admin1 : null });
      if (visited) {
        country.visited = true;
        if (last && (!country.last || last > country.last)) country.last = last;
      } else {
        country.planned = true;
        if (!country.next || trip.start < country.next) country.next = trip.start;
      }
    };
    for (const place of Array.isArray(trip.places) ? trip.places : []) {
      if (!plain(place)) continue;
      const mine = uid != null && place.visited?.[uid] === true;
      const visited = phase === 'started' || mine;
      if (!visited && phase !== 'future') continue;
      const code = resolve(place);
      if (visited) visitedPlaces.add(placeKey(place, trip.key));
      if (code) note(code, 'place', place, visited);
    }
    if (phase === 'undated') continue;
    for (const res of Array.isArray(trip.res) ? trip.res : []) {
      const seen = new Set();
      for (const stop of reservationStops(res)) {
        const code = resolve(stop);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        note(code, 'res', { id: res.id, name: (typeof res.title === 'string' && res.title) || stop.name || stop.code || '', lat: stop.lat, lng: stop.lng }, phase === 'started');
      }
    }
  }

  const wished = new Set();
  const fromBucket = new Map();
  for (const item of Array.isArray(bucket) ? bucket : []) {
    if (!plain(item)) continue;
    const code = countryCode(item.cc) ?? (finite(item.lat) && finite(item.lng) ? locate(item.lat, item.lng) : null);
    if (!code) continue;
    if (!isDate(item.visitedAt)) { wished.add(code); continue; }
    if (!fromBucket.has(code)) fromBucket.set(code, []);
    fromBucket.get(code).push({ kind: 'bucket', tripKey: null, id: item.id ?? null, name: item.name ?? '', planned: false, mine: false,
      lat: finite(item.lat) ? item.lat : null, lng: finite(item.lng) ? item.lng : null, admin1: null, date: item.visitedAt });
  }

  const countries = new Map();
  for (const code of new Set([...found.keys(), ...manual, ...fromBucket.keys()])) {
    const auto = found.get(code) ?? { code, visited: false, planned: false, last: null, next: null, trips: new Set(), items: [] };
    const isManual = manual.has(code);
    const bucketItems = fromBucket.get(code) ?? [];
    const asserted = isManual || bucketItems.length > 0;
    const isHidden = hidden.has(code) && !asserted;
    const status = asserted || (auto.visited && !isHidden) ? 'visited' : auto.planned && !auto.visited && !isHidden ? 'planned' : isHidden ? 'hidden' : null;
    if (!status) continue;
    const last = bucketItems.reduce((latest, item) => (!latest || item.date > latest ? item.date : latest), auto.last);
    countries.set(code, { code, status, manual: isManual, bucket: bucketItems.length > 0, auto: auto.visited, hidden: hidden.has(code), last, next: auto.next, continent: continentOf(code), trips: auto.trips, items: [...auto.items, ...bucketItems] });
  }
  const byRecent = (a, b) => (a.last && b.last ? (a.last < b.last ? 1 : a.last > b.last ? -1 : 0) : a.last ? -1 : b.last ? 1 : 0) || (a.code < b.code ? -1 : 1);
  const visited = [...countries.values()].filter((country) => country.status === 'visited').sort(byRecent);
  const planned = [...countries.values()].filter((country) => country.status === 'planned').sort((a, b) => (a.next < b.next ? -1 : a.next > b.next ? 1 : 0) || (a.code < b.code ? -1 : 1));
  const continents = [...new Set(visited.map((country) => country.continent).filter(Boolean))];
  return {
    countries,
    visited: visited.map((country) => country.code),
    planned: planned.map((country) => country.code),
    hidden: [...countries.values()].filter((country) => country.status === 'hidden').map((country) => country.code).sort(),
    wishlist: [...wished].filter((code) => countries.get(code)?.status !== 'visited').sort(),
    stats: {
      countries: visited.length, planned: planned.length, continents: continents.length, continentList: continents,
      trips: started, plannedTrips: future, undatedTrips: undated, places: visitedPlaces.size,
      travelDays: travelDays(ranges), streak: yearStreak(years, year), tripsThisYear: thisYear,
    },
    uncached,
  };
}
