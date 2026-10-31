import { DAY, MINUTE, attribution, point } from './core.js';
import { t } from '../lib/i18n/index.js';
import { lngLatMeters } from '../shared/geo.js';

const fixMap = () => ({ text: t('services.fixMap'), url: 'https://www.openstreetmap.org/fixthemap' });
const credits = source => [source, fixMap()];
// km/h used for straight-line estimates; transit has no routing provider.
export const SPEEDS = Object.freeze({ drive: 60, bike: 15, walk: 4.5, transit: 25 });
export const AVOID = Object.freeze(['toll', 'ferry', 'motorway']);
const ROUTED = new Set(['drive', 'bike', 'walk']);
export const MAX_ROUTE_POINTS = 25;
export const MAX_MATRIX_POINTS = 10;
// Estimates are cached briefly so a recovered provider or a new key takes over soon; offline still reads them stale.
const ESTIMATE_TTL = 10 * MINUTE;

export const distance = lngLatMeters;
const estimate = (a, b, mode) => { const meters = distance(a, b) * 1.25; return { distance: meters, duration: meters / (SPEEDS[mode] / 3.6) }; };
/** Great-circle distance × 1.25 at the mode's speed, flagged `estimated`. */
export function straightRoute(points, mode) {
  if (!SPEEDS[mode]) throw new RangeError('Invalid mode');
  const legs = points.slice(1).map((next, i) => estimate(points[i], next, mode));
  return { geometry: { type: 'LineString', coordinates: points.map(p => [...p]) }, distance: legs.reduce((sum, leg) => sum + leg.distance, 0), duration: legs.reduce((sum, leg) => sum + leg.duration, 0), legs, estimated: true };
}
function validatePoints(points, mode, max) {
  if (!SPEEDS[mode] || !Array.isArray(points) || points.length < 2 || points.length > max) throw new RangeError('Invalid route');
  return points.map(p => point(p).map(n => Number(n.toFixed(5))));
}
const metric = value => Number.isFinite(value) && value >= 0;
function lineString(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 100_000) throw new Error('Invalid route geometry');
  return { type: 'LineString', coordinates: coordinates.map(point) };
}
function checkedLegs(legs, count) {
  if (!Array.isArray(legs) || legs.length !== count - 1 || legs.some(leg => !metric(leg.distance) || !metric(leg.duration))) return undefined;
  return legs.map(leg => ({ distance: leg.distance, duration: leg.duration }));
}
function osrmRoute(data, count) {
  const route = data?.routes?.[0] ?? data;
  if (!metric(route?.distance) || !metric(route?.duration) || (typeof route.geometry !== 'string' && route.geometry?.type !== 'LineString')) throw new Error('Invalid route response');
  const coordinates = typeof route.geometry === 'string' ? decodePolyline(route.geometry, 6) : route.geometry.coordinates;
  return { distance: route.distance, duration: route.duration, geometry: lineString(coordinates), legs: checkedLegs(route.legs, count), estimated: false };
}
/** Decodes an encoded polyline (precision 6 for Valhalla) into [lng, lat] pairs. */
export function decodePolyline(value, precision = 6) {
  if (typeof value !== 'string' || value.length > 2_000_000) throw new Error('Invalid polyline');
  const factor = 10 ** precision; const coordinates = []; let index = 0, lat = 0, lng = 0;
  const next = () => {
    let result = 0, shift = 0, byte;
    do {
      if (index >= value.length || shift > 30) throw new Error('Invalid polyline');
      byte = value.charCodeAt(index++) - 63; if (byte < 0 || byte > 63) throw new Error('Invalid polyline');
      result |= (byte & 0x1f) << shift; shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < value.length) { lat += next(); lng += next(); coordinates.push([lng / factor, lat / factor]); }
  return coordinates;
}
function valhallaRoute(data, count) {
  const trip = data?.trip;
  if (trip?.status !== 0 || !Array.isArray(trip.legs) || !trip.legs.length || !metric(trip.summary?.length) || !metric(trip.summary?.time)) throw new Error('Invalid Valhalla response');
  const coordinates = trip.legs.flatMap((leg, i) => { const line = decodePolyline(leg.shape); return i ? line.slice(1) : line; });
  const legs = trip.legs.map(leg => ({ distance: leg.summary?.length * 1000, duration: leg.summary?.time }));
  return { distance: trip.summary.length * 1000, duration: trip.summary.time, geometry: lineString(coordinates), legs: checkedLegs(legs, count), estimated: false };
}
function orsRoute(data, count) {
  const feature = data?.features?.[0]; const summary = feature?.properties?.summary;
  if (feature?.geometry?.type !== 'LineString' || !summary) throw new Error('Invalid openrouteservice response');
  const total = { distance: summary.distance ?? 0, duration: summary.duration ?? 0 };
  if (!metric(total.distance) || !metric(total.duration)) throw new Error('Invalid openrouteservice response');
  return { ...total, geometry: lineString(feature.geometry.coordinates), legs: checkedLegs(feature.properties.segments, count), estimated: false };
}
function matrixRows(rows, size, nullable = true) {
  if (!Array.isArray(rows) || rows.length !== size || rows.some(row => !Array.isArray(row) || row.length !== size || row.some(n => (n === null ? !nullable : !metric(n))))) throw new Error('Invalid matrix');
  return rows.map(row => [...row]);
}
const orsProfile = { drive: 'driving-car', bike: 'cycling-regular', walk: 'foot-walking' };
const valhallaCosting = { drive: 'auto', bike: 'bicycle', walk: 'pedestrian' };

export function createRoute(ctx) {
  const ors = async (path, body, request) => {
    const key = await ctx.key('ors'); if (!key) return null;
    const { data } = await ctx.json(`https://api.openrouteservice.org/v2/${path}`, { method: 'POST', body, headers: { Authorization: key }, provider: 'ors', interval: 1500, ...request });
    return data;
  };
  return {
    /** `points` are [lng, lat]; the result carries per-leg distance/duration when the provider returns them. */
    route(points, mode = 'drive', opts = {}) {
      points = validatePoints(points, mode, MAX_ROUTE_POINTS); const avoid = opts.avoid ?? [];
      if (!Array.isArray(avoid) || avoid.some(x => !AVOID.includes(x))) throw new RangeError('Invalid avoid option');
      const avoids = [...new Set(avoid)].sort(); const routed = ROUTED.has(mode);
      return ctx.run('route', { points, mode, avoid: avoids }, {
        'geo-osrm': async (cfg, request = {}) => {
          if (!cfg.geoWorker || avoids.length || !routed) return null;
          const { data } = await ctx.json(new URL('/route', cfg.geoWorker).href, { method: 'POST', body: { points, mode }, provider: 'geo-osrm', retries: 0, ...request });
          return { data: { ...osrmRoute(data, points.length), avoidsApplied: true }, attribution: credits(attribution.route) };
        },
        'geo-valhalla': async (cfg, request = {}) => {
          if (!cfg.geoWorker || !avoids.length || !routed) return null;
          const { data } = await ctx.json(new URL('/valhalla', cfg.geoWorker).href, { method: 'POST', body: { points, mode, avoid: avoids }, provider: 'geo-valhalla', retries: 0, ...request });
          return { data: { ...valhallaRoute(data, points.length), avoidsApplied: true }, attribution: credits(attribution.valhalla) };
        },
        ors: async (_cfg, request = {}) => {
          if (!routed) return null;
          const features = avoids.flatMap(value => value === 'ferry' ? ['ferries'] : mode !== 'drive' ? [] : [value === 'toll' ? 'tollways' : 'highways']);
          const data = await ors(`directions/${orsProfile[mode]}/geojson`, { coordinates: points, instructions: false, ...(features.length ? { options: { avoid_features: features } } : {}) }, request);
          return data && { data: { ...orsRoute(data, points.length), avoidsApplied: true }, attribution: credits(attribution.ors) };
        },
        straight: async () => ({ data: { ...straightRoute(points, mode), avoidsApplied: avoids.length === 0 }, attribution: [], ttl: ESTIMATE_TTL, estimate: true }),
      }, { ttl: 7 * DAY, signal: opts.signal, cacheVariant: cfg => cfg.geoWorker });
    },
    /** Duration (s) and distance (m) matrices; `null` cells mean unreachable. */
    matrix(points, mode = 'drive', opts = {}) {
      points = validatePoints(points, mode, MAX_MATRIX_POINTS); const routed = ROUTED.has(mode);
      return ctx.run('route', { matrix: true, points, mode }, {
        'geo-osrm': async (cfg, request = {}) => {
          if (!cfg.geoWorker || !routed) return null;
          const { data } = await ctx.json(new URL('/matrix', cfg.geoWorker).href, { method: 'POST', body: { points, mode }, provider: 'geo-osrm', retries: 0, ...request });
          return { data: { durations: matrixRows(data?.durations, points.length), distances: data?.distances == null ? null : matrixRows(data.distances, points.length), estimated: false }, attribution: credits(attribution.route) };
        },
        ors: async (_cfg, request = {}) => {
          if (!routed) return null;
          const data = await ors(`matrix/${orsProfile[mode]}`, { locations: points, metrics: ['duration', 'distance'] }, request);
          return data && { data: { durations: matrixRows(data.durations, points.length), distances: data.distances == null ? null : matrixRows(data.distances, points.length), estimated: false }, attribution: credits(attribution.ors) };
        },
        straight: async () => {
          const cells = points.map(a => points.map(b => estimate(a, b, mode)));
          return { data: { durations: cells.map(row => row.map(cell => cell.duration)), distances: cells.map(row => row.map(cell => cell.distance)), estimated: true }, attribution: [], ttl: ESTIMATE_TTL, estimate: true };
        },
      }, { ttl: 7 * DAY, signal: opts.signal, cacheVariant: cfg => cfg.geoWorker });
    },
  };
}
