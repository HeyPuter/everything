import { planDay, routeDay } from '../../services/dayRoute.js';
import { straightRoute } from '../../services/route.js';
import { geodesicArc } from '../../map/arcs.js';
import { stopRef } from './model.js';

const ARC_TYPES = new Set(['flight', 'cruise', 'ferry']);
const ROAD_TYPES = { car: 'drive', taxi: 'drive', bus: 'drive', bike: 'bike' };

function roadLegs(segment, data) {
  const legs = data.legs ?? straightRoute(segment.points, segment.mode).legs;
  return legs.map((leg, i) => ({ from: segment.ids[i], to: segment.ids[i + 1], mode: segment.mode, distance: leg.distance, duration: leg.duration, estimated: Boolean(data.estimated || leg.estimated) }));
}

/** Straight-line version of `routeDay`, computed synchronously so a route can draw before routing answers. */
export function estimateDay(plan) {
  const features = []; const legs = []; const transports = [];
  let distance = 0, duration = 0;
  for (const segment of plan.segments) {
    if (segment.kind === 'road') {
      const data = straightRoute(segment.points, segment.mode);
      distance += data.distance; duration += data.duration;
      legs.push(...roadLegs(segment, data));
      features.push({ type: 'Feature', properties: { kind: 'road', mode: segment.mode, estimated: true }, geometry: data.geometry });
      continue;
    }
    const entry = { id: segment.id, type: segment.type, status: segment.status, from: segment.from, to: segment.to };
    transports.push(entry);
    if (!segment.from || !segment.to) continue;
    const properties = { kind: 'transport', id: segment.id, type: segment.type, status: segment.status };
    if (ARC_TYPES.has(segment.type)) features.push(geodesicArc(segment.from, segment.to, { properties: { ...properties, estimated: false } }));
    else {
      if (ROAD_TYPES[segment.type]) {
        const line = straightRoute([segment.from, segment.to], ROAD_TYPES[segment.type]);
        Object.assign(entry, { distance: line.distance, duration: line.duration, estimated: true });
      }
      features.push({ type: 'Feature', properties: { ...properties, estimated: true }, geometry: { type: 'LineString', coordinates: [segment.from, segment.to] } });
    }
  }
  return { legs, transports, distance, duration, estimated: true, attribution: [], features: { type: 'FeatureCollection', features } };
}

/**
 * Day route result: `legs[]` are `{from: {t, id}, to: {t, id}, mode, distance (m), duration (s), estimated}`, where
 * `{t: 'res', stay: true}` is the day's lodging, and a `res` transport is its departure (before) or arrival (after).
 */
export function dayResult(stops, raw, routed) {
  const ref = (value) => stopRef(value) ?? { t: 'unknown', id: String(value ?? '') };
  return {
    dayId: stops.dayId,
    mode: stops.mode,
    routed,
    legs: raw.legs.map((leg) => ({ ...leg, from: ref(leg.from), to: ref(leg.to) })),
    transports: raw.transports.map((entry) => ({ ...entry, id: stopRef(entry.id)?.id ?? entry.id })),
    distance: raw.distance,
    duration: raw.duration,
    estimated: raw.estimated,
    attribution: raw.attribution ?? [],
    features: raw.features,
  };
}

export function estimateStops(stops) { return dayResult(stops, estimateDay(planDay(stops.input)), false); }

/** Routes a day through `route` (the services route adapter); offline or failed providers fall back to straight lines. */
export async function routeStops(route, stops, { signal, avoid } = {}) {
  const raw = await routeDay(route, planDay(stops.input), { signal, avoid });
  return dayResult(stops, raw, true);
}
