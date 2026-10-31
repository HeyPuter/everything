import { distance, project } from './geo.js';

// How far (km) from the route a hazard matters, by GDACS event type and alert level.
export const HAZARD_RADIUS = Object.freeze({
  EQ: { green: 50, orange: 150, red: 300 }, TC: { green: 150, orange: 300, red: 400 }, FL: { green: 50, orange: 100, red: 150 },
  VO: { green: 30, orange: 80, red: 150 }, WF: { green: 25, orange: 50, red: 100 }, DR: { green: 100, orange: 200, red: 300 },
});
const DEFAULT_RADIUS = 50;
const LEVELS = ['green', 'orange', 'red'];

export const hazardRadius = (event) => HAZARD_RADIUS[event.type]?.[event.level] ?? DEFAULT_RADIUS;
export const levelRank = (level) => Math.max(0, LEVELS.indexOf(level));

/** Ray casting on one ring of [lng, lat]. */
export function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
/** Polygons are arrays of rings (outer first, holes after). */
export function inPolygons(point, polygons) {
  return polygons.some((rings) => rings.length && inRing(point, rings[0]) && !rings.slice(1).some((hole) => inRing(point, hole)));
}
const inBox = (point, box) => point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3];

/**
 * Hazards near the route. `events` are `{id, point?, polygons?, bbox?, type, level}`; `lines` is `[{leg, line}]`.
 * Point events count within their radius; area events when a route vertex lies inside. Returns
 * `[{event, leg, fraction, distance}]`, worst level first, then nearest.
 */
export function hazardsNearRoute(events, lines, { radius = hazardRadius } = {}) {
  const found = [];
  for (const event of events ?? []) {
    let best = null;
    for (const { leg, line } of lines) {
      if (!line?.length) continue;
      if (event.polygons?.length || event.bbox) {
        const index = line.findIndex((point) => (!event.bbox || inBox(point, event.bbox)) && (!event.polygons?.length || inPolygons(point, event.polygons)));
        if (index !== -1) { best = { leg, fraction: line.length > 1 ? index / (line.length - 1) : 0, distance: 0 }; break; }
        continue;
      }
      if (!event.point) continue;
      const near = line.length > 1 ? project(line, event.point) : { fraction: 0, distance: distance(line[0], event.point) };
      if (near.distance <= radius(event) * 1000 && (!best || near.distance < best.distance)) best = { leg, fraction: near.fraction, distance: near.distance };
    }
    if (best) found.push({ event, ...best });
  }
  return found.sort((a, b) => levelRank(b.event.level) - levelRank(a.event.level) || a.distance - b.distance);
}
