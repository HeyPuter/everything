import { assertActive, coordinate } from './core.js';
import { MAX_ROUTE_POINTS, SPEEDS, straightRoute } from './route.js';
import { geodesicArc } from '../map/arcs.js';

const ARC_TYPES = new Set(['flight', 'cruise', 'ferry']);
const ROAD_TYPES = { car: 'drive', taxi: 'drive', bus: 'drive', bike: 'bike' };
const MODES = new Set(Object.keys(SPEEDS));
const text = value => typeof value === 'string' ? value.slice(0, 200) : undefined;
const position = value => {
  if (!value || value.lat == null || value.lng == null) return null;
  coordinate(value.lat, value.lng); return [Number(value.lng.toFixed(6)), Number(value.lat.toFixed(6))];
};
const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/**
 * Splits a day into road chunks and transport legs.
 * `start`/`end` are the night's stays `{id, lat, lng}`; each stop is `{id, lat, lng, mode?}` where `mode` is the
 * mode of the leg arriving at it, or a booking `{id, transport: {type, status, from: {lat, lng}, to: {lat, lng}}}`.
 * Road chunks reset at every booking and whenever the leg mode changes.
 */
export function planDay({ start = null, stops = [], end = null, mode = 'walk' } = {}) {
  if (!MODES.has(mode) || !Array.isArray(stops) || stops.length > 1000) throw new RangeError('Invalid day plan');
  const segments = []; let chunk = null; let last = null;
  const finish = () => { if (chunk?.points.length >= 2) segments.push({ kind: 'road', mode: chunk.mode, points: chunk.points, ids: chunk.ids }); chunk = null; };
  const visit = (id, coords, legMode) => {
    if (!coords) return;
    if (chunk && chunk.mode !== legMode) { finish(); }
    if (!chunk) chunk = { mode: legMode, points: last ? [last.coords] : [], ids: last ? [last.id] : [] };
    if (!chunk.points.length || !same(chunk.points.at(-1), coords)) { chunk.points.push(coords); chunk.ids.push(id); }
    else chunk.ids[chunk.ids.length - 1] = id;
    last = { id, coords };
  };
  const firstMode = stops[0] && !stops[0].transport ? stops[0].mode : undefined;
  if (start) visit(text(start.id) ?? 'start', position(start), MODES.has(firstMode) ? firstMode : mode);
  for (const stop of stops) {
    if (!stop || typeof stop !== 'object') throw new RangeError('Invalid stop');
    const id = text(stop.id);
    if (stop.transport) {
      const from = position(stop.transport.from), to = position(stop.transport.to);
      if (from) visit(id, from, chunk?.mode ?? mode);
      finish();
      segments.push({ kind: 'transport', id, type: text(stop.transport.type) ?? 'other', status: text(stop.transport.status) ?? 'confirmed', from, to });
      last = to ? { id, coords: to } : null;
      continue;
    }
    const legMode = MODES.has(stop.mode) ? stop.mode : mode;
    visit(id, position(stop), legMode);
  }
  if (end) visit(text(end.id) ?? 'end', position(end), mode);
  finish();
  return { segments };
}

const windows = points => {
  const pieces = [];
  for (let i = 0; i < points.length - 1; i += MAX_ROUTE_POINTS - 1) pieces.push([i, Math.min(points.length, i + MAX_ROUTE_POINTS)]);
  return pieces;
};
const credit = (list, items) => { for (const item of items ?? []) if (!list.some(other => other.url === item.url && other.text === item.text)) list.push(item); };

/**
 * Routes a planned day. Road chunks go through `route.route` (falling back to a local straight estimate when
 * nothing is cached offline); bookings become arcs, routed road lines or straight lines.
 */
export async function routeDay(route, plan, { avoid, signal } = {}) {
  const features = []; const legs = []; const transports = []; const attribution = [];
  let total = 0, time = 0, estimated = false;
  const routeLine = async (points, mode) => {
    const result = await route.route(points, mode, { avoid, signal }); assertActive(signal);
    if (result) credit(attribution, result.attribution);
    return result?.data ?? { ...straightRoute(points, mode), avoidsApplied: !avoid?.length };
  };
  for (const segment of plan.segments) {
    assertActive(signal);
    if (segment.kind === 'road') {
      for (const [from, to] of windows(segment.points)) {
        const points = segment.points.slice(from, to); const data = await routeLine(points, segment.mode);
        estimated ||= data.estimated; total += data.distance; time += data.duration;
        const pieceLegs = data.legs ?? straightRoute(points, segment.mode).legs.map(leg => ({ ...leg, estimated: true }));
        pieceLegs.forEach((leg, i) => legs.push({ from: segment.ids[from + i], to: segment.ids[from + i + 1], mode: segment.mode, distance: leg.distance, duration: leg.duration, estimated: data.estimated || Boolean(leg.estimated) }));
        features.push({ type: 'Feature', properties: { kind: 'road', mode: segment.mode, estimated: data.estimated, avoidsApplied: data.avoidsApplied !== false }, geometry: data.geometry });
      }
      continue;
    }
    const entry = { id: segment.id, type: segment.type, status: segment.status, from: segment.from, to: segment.to };
    transports.push(entry);
    if (!segment.from || !segment.to) continue;
    const properties = { kind: 'transport', id: segment.id, type: segment.type, status: segment.status };
    if (ARC_TYPES.has(segment.type)) features.push(geodesicArc(segment.from, segment.to, { properties: { ...properties, estimated: false } }));
    else if (ROAD_TYPES[segment.type]) {
      const data = await routeLine([segment.from, segment.to], ROAD_TYPES[segment.type]);
      Object.assign(entry, { distance: data.distance, duration: data.duration, estimated: data.estimated });
      features.push({ type: 'Feature', properties: { ...properties, estimated: data.estimated }, geometry: data.geometry });
    } else features.push({ type: 'Feature', properties: { ...properties, estimated: true }, geometry: { type: 'LineString', coordinates: [segment.from, segment.to] } });
  }
  return { legs, transports, distance: total, duration: time, estimated, attribution, features: { type: 'FeatureCollection', features } };
}
