import { HOUR, MINUTE, attribution, coordinate, plainText } from './core.js';
import { decodePolyline, distance } from './route.js';
import { isTimeZone } from '../shared/dates.js';

// Transitous (MOTIS) public transit routing. Off unless config.json lists `transit: ["transitous"]`, which needs
// the Transitous operators to confirm that Trips may use it.
export const TRANSIT_ATTRIBUTION = Object.freeze([{ text: 'Transitous', url: 'https://transitous.org/sources/' }, attribution.osm]);
const MODES = Object.freeze({
  WALK: 'walk', BIKE: 'bike', RENTAL: 'bike', CAR: 'car', CAR_PARKING: 'car', ODM: 'car', FLEX: 'bus', BUS: 'bus', COACH: 'coach',
  TRAM: 'tram', SUBWAY: 'subway', METRO: 'subway', RAIL: 'rail', HIGHSPEED_RAIL: 'rail', LONG_DISTANCE: 'rail', NIGHT_RAIL: 'rail',
  REGIONAL_FAST_RAIL: 'rail', REGIONAL_RAIL: 'rail', SUBURBAN: 'rail', FERRY: 'ferry', FUNICULAR: 'cable', AERIAL_LIFT: 'cable',
  CABLE_CAR: 'cable', AIRPLANE: 'air',
});
export const SHAPE_LIMIT = 8192;
const MAX_ITINERARIES = 8;
const MAX_LEGS = 30;

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const short = (value, max) => (typeof value === 'string' || typeof value === 'number' ? plainText(String(value), max) || null : null);
const instant = (value) => { const at = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
export const transitMode = (value) => MODES[String(value ?? '').toUpperCase()] ?? 'other';
/** A GTFS route color (six hex digits, with or without a leading hash) as `#rrggbb`, or null. */
export function routeColor(value) {
  const hex = typeof value === 'string' ? value.trim().replace(/^#/, '') : '';
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}

/** Encodes `[lng, lat]` pairs as a Google encoded polyline. */
export function encodePolyline(coordinates, precision = 5) {
  const factor = 10 ** precision;
  let out = ''; let lastLat = 0; let lastLng = 0;
  const push = (delta) => {
    let value = delta < 0 ? ~(delta * 2) : delta * 2;
    while (value >= 0x20) { out += String.fromCharCode((0x20 | (value & 0x1f)) + 63); value = Math.floor(value / 32); }
    out += String.fromCharCode(value + 63);
  };
  for (const [lng, lat] of coordinates) {
    const y = Math.round(lat * factor); const x = Math.round(lng * factor);
    push(y - lastLat); push(x - lastLng); lastLat = y; lastLng = x;
  }
  return out;
}
/** A precision-5 polyline of at most `limit` characters, thinning interior points as needed; null when it cannot fit. */
export function fitShape(coordinates, limit = SHAPE_LIMIT) {
  let points = coordinates;
  while (points.length >= 2) {
    const encoded = encodePolyline(points, 5);
    if (encoded.length <= limit) return encoded;
    if (points.length === 2) return null;
    points = points.filter((_, index) => index === 0 || index === points.length - 1 || index % 2 === 0);
  }
  return null;
}

// MOTIS reports the precision; without it, take the one that starts next to the departure.
function legShape(geometry, from) {
  if (!plain(geometry) || typeof geometry.points !== 'string' || geometry.points.length > 500_000) return null;
  const precisions = Number.isInteger(geometry.precision) && geometry.precision >= 5 && geometry.precision <= 7 ? [geometry.precision] : [7, 6, 5];
  for (const precision of precisions) {
    try {
      const line = decodePolyline(geometry.points, precision);
      if (line.length >= 2 && line.every(([lng, lat]) => Math.abs(lng) <= 180 && Math.abs(lat) <= 90) && distance(line[0], [from.lng, from.lat]) < 2000) return fitShape(line);
    } catch { /* Try the next precision. */ }
  }
  return null;
}

function place(raw) {
  if (!plain(raw)) return null;
  const lat = finite(raw.lat); const lng = finite(raw.lon ?? raw.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { name: short(raw.name, 200), lat, lng, tz: isTimeZone(raw.tz) ? raw.tz : null, track: short(raw.track ?? raw.scheduledTrack, 20) };
}

function mapLeg(raw) {
  if (!plain(raw)) return null;
  const from = place(raw.from); const to = place(raw.to);
  const start = instant(raw.startTime); const end = instant(raw.endTime);
  if (!from || !to || start === null || end === null || end < start) return null;
  return {
    mode: transitMode(raw.mode), from, to, start, end,
    scheduledStart: instant(raw.scheduledStartTime) ?? start, scheduledEnd: instant(raw.scheduledEndTime) ?? end,
    realTime: raw.realTime === true, cancelled: raw.cancelled === true,
    duration: finite(raw.duration) ?? Math.round((end - start) / 1000), distance: finite(raw.distance),
    route: short(raw.routeShortName ?? raw.displayName, 40), routeName: short(raw.routeLongName, 120),
    headsign: short(raw.headsign, 120), agency: short(raw.agencyName, 120),
    color: routeColor(raw.routeColor), textColor: routeColor(raw.routeTextColor),
    stops: Array.isArray(raw.intermediateStops) ? Math.min(raw.intermediateStops.length, 500) : 0,
    shape: legShape(raw.legGeometry, from),
  };
}

function mapItinerary(raw) {
  if (!plain(raw) || !Array.isArray(raw.legs)) return null;
  const legs = raw.legs.slice(0, MAX_LEGS).map(mapLeg);
  if (!legs.length || legs.some((leg) => leg === null)) return null;
  const start = instant(raw.startTime) ?? legs[0].start; const end = instant(raw.endTime) ?? legs.at(-1).end;
  const transit = legs.filter((leg) => !['walk', 'bike', 'car'].includes(leg.mode));
  return {
    start, end, duration: finite(raw.duration) ?? Math.round((end - start) / 1000),
    transfers: Number.isInteger(raw.transfers) && raw.transfers >= 0 ? raw.transfers : Math.max(0, transit.length - 1),
    walk: legs.filter((leg) => leg.mode === 'walk').reduce((sum, leg) => sum + leg.duration, 0),
    legs,
  };
}

/** A MOTIS plan response as `{itineraries, direct}`; `direct` is the walking alternative's duration in seconds, if any. */
export function mapPlan(data) {
  if (!plain(data) || !Array.isArray(data.itineraries)) throw new Error('Invalid transit plan');
  const itineraries = data.itineraries.slice(0, MAX_ITINERARIES * 2).map(mapItinerary)
    .filter((item) => item && item.legs.some((leg) => !['walk', 'bike', 'car'].includes(leg.mode))).slice(0, MAX_ITINERARIES);
  const walk = Array.isArray(data.direct) ? data.direct.map(mapItinerary).find((item) => item?.legs.every((leg) => leg.mode === 'walk')) : null;
  return { itineraries, direct: walk ? { duration: walk.duration } : null };
}

/** Plans transit between two points at `at` (epoch ms), leaving then or arriving by then with `arriveBy`. */
export function createTransit(ctx) {
  return {
    async available() {
      const cfg = await ctx.loadConfig();
      return (cfg.providers.transit ?? []).some((provider) => provider === 'transitous' && !cfg.disabled.includes(provider));
    },
    plan({ from, to, at, arriveBy = false } = {}, opts = {}) {
      coordinate(from?.lat, from?.lng); coordinate(to?.lat, to?.lng);
      if (!Number.isFinite(at)) throw new RangeError('Invalid time');
      const round = (value) => Number(value.toFixed(5));
      const args = { from: [round(from.lat), round(from.lng)], to: [round(to.lat), round(to.lng)], at: Math.round(at / MINUTE) * MINUTE, arriveBy: arriveBy === true };
      return ctx.run('transit', args, {
        transitous: async (_cfg, request = {}) => {
          const url = new URL('https://api.transitous.org/api/v1/plan');
          url.search = new URLSearchParams({
            fromPlace: args.from.join(','), toPlace: args.to.join(','), time: new Date(args.at).toISOString(),
            arriveBy: String(args.arriveBy), numItineraries: '5', detailedTransfers: 'false',
          });
          const { data } = await ctx.json(url.href, { provider: 'transitous', ...request });
          const plan = { ...mapPlan(data), at: args.at, arriveBy: args.arriveBy };
          // Realtime data changes near the travel time; timetables far ahead rarely do.
          const ttl = Math.abs(args.at - ctx.now()) < 6 * HOUR ? 10 * MINUTE : 12 * HOUR;
          return { data: plan, attribution: [...TRANSIT_ATTRIBUTION], ttl: plan.itineraries.length ? ttl : HOUR, ...(plan.itineraries.length ? {} : { empty: true }) };
        },
      }, { ttl: HOUR, signal: opts.signal });
    },
  };
}
