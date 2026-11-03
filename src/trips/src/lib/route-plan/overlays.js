import { geodesicArc } from '../../map/arcs.js';
import { decodePolyline, distance, straightRoute } from '../../services/route.js';
import { coords, isTransport } from './model.js';

const ARC_TYPES = new Set(['flight', 'cruise', 'ferry']);
const ROAD_TYPES = { car: 'drive', taxi: 'drive', bus: 'drive', bike: 'bike' };
const MAX_ROUTED_POINTS = 25;
const same = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Transit leg shapes are encoded polylines; the precision that lands next to the departure wins. */
function shapeLine(leg, from) {
  if (!leg.shape || !from) return null;
  for (const precision of [5, 6]) {
    try {
      const line = decodePolyline(leg.shape, precision);
      if (line.length >= 2 && line.every(([lng, lat]) => Math.abs(lng) <= 180 && Math.abs(lat) <= 90) && distance(line[0], from) < 2000) return line;
    } catch { /* Try the next precision. */ }
  }
  return null;
}

/**
 * Map overlays for reservations: geodesic `arcs` (flights, cruises, ferries), `lines` to draw straight, from a
 * transit shape or to route (`mode` set: car, taxi, bus, bike), `endpoints` labelled with the leg's code or name,
 * lodging `stays` and located `bookings` that have no place on the map.
 */
export function bookingOverlays(model) {
  const arcs = []; const lines = []; const endpoints = new Map(); const stays = []; const bookings = [];
  for (const res of model.reservations) {
    const properties = { id: res.id, type: res.type, status: res.status };
    if (res.type === 'lodging') {
      const point = model.resPoint(res);
      if (point) stays.push({ res, point, place: res.placeId ? model.place(res.placeId) : null });
      continue;
    }
    if (!isTransport(res)) {
      const point = coords(res.location);
      if (point && !(res.placeId && model.placePoint(res.placeId))) bookings.push({ res, point });
      continue;
    }
    const legs = (res.legs ?? []).map((leg) => ({ leg, from: coords(leg.from), to: coords(leg.to) })).filter((entry) => entry.from && entry.to);
    if (!legs.length) {
      const point = coords(res.location);
      if (point) bookings.push({ res, point });
      continue;
    }
    for (const { leg, from, to } of legs) {
      for (const [point, end] of [[from, leg.from], [to, leg.to]]) {
        const label = text(end.code, 16) || text(end.name, 40);
        const key = `${point[0].toFixed(5)},${point[1].toFixed(5)}:${label}`;
        if (label && !endpoints.has(key)) endpoints.set(key, { type: 'Feature', properties: { ...properties, label }, geometry: { type: 'Point', coordinates: point } });
      }
    }
    if (ARC_TYPES.has(res.type)) {
      legs.forEach(({ from, to }, i) => arcs.push(geodesicArc(from, to, { properties: { ...properties, leg: i } })));
      continue;
    }
    // Consecutive legs join into one multi-stop line.
    let current = null;
    legs.forEach(({ leg, from, to }, i) => {
      const shape = ROAD_TYPES[res.type] ? null : shapeLine(leg, from);
      if (shape) { current = null; lines.push({ key: `${res.id}:${i}`, ...properties, points: shape, shape: true }); return; }
      if (current && same(current.points.at(-1), from) && current.points.length < MAX_ROUTED_POINTS) current.points.push(to);
      else lines.push(current = { key: `${res.id}:${i}`, ...properties, ...(ROAD_TYPES[res.type] ? { mode: ROAD_TYPES[res.type] } : {}), points: [from, to] });
    });
  }
  return { arcs, lines, endpoints: [...endpoints.values()], stays, bookings };
}

const lineFeature = (line, geometry, estimated) => ({ type: 'Feature', properties: { id: line.id, type: line.type, status: line.status, estimated }, geometry });

/** Straight (or shaped) booking lines, drawn before routing answers. */
export function estimateLines(lines) {
  return lines.map((line) => lineFeature(line, { type: 'LineString', coordinates: line.points }, Boolean(line.mode)));
}

/** Routes the `mode` lines through the services route adapter; others stay straight. */
export async function routeLines(route, lines, { signal } = {}) {
  const features = [];
  for (const line of lines) {
    if (!line.mode || !route) { features.push(...estimateLines([line])); continue; }
    let data = null;
    try { data = (await route.route(line.points, line.mode, { signal }))?.data ?? null; }
    catch (cause) { if (cause?.name === 'AbortError') throw cause; }
    data ??= straightRoute(line.points, line.mode);
    features.push(lineFeature(line, data.geometry, Boolean(data.estimated)));
  }
  return features;
}
