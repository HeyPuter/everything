// Coordinate helpers for tracks: cleaning, length and simplification. Positions are GeoJSON `[lng, lat, ele?]`.

import { EARTH_RADIUS_M, lngLatMeters as meters } from '../../shared/geo.js';

export { meters };

const round = (value, digits) => { const scale = 10 ** digits; return Math.round(value * scale) / scale; };

/** A valid position rounded to 6 decimals (elevation to 1), or null. */
export function cleanPosition(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [lng, lat, ele] = value;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const point = [round(lng, 6), round(lat, 6)];
  if (Number.isFinite(ele) && Math.abs(ele) < 100_000) point.push(round(ele, 1));
  return point;
}

/** Line segments of a LineString or MultiLineString geometry. */
export const segmentsOf = (geometry) => (geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : []);

/** Length in kilometres of every segment together. */
export function lengthKm(segments) {
  let total = 0;
  for (const segment of segments) for (let i = 1; i < segment.length; i++) total += meters(segment[i - 1], segment[i]);
  return total / 1000;
}

// Perpendicular distance in metres on a local equirectangular projection; good enough for track thinning.
function offset(point, start, end) {
  const k = Math.cos((start[1] + end[1]) / 2 * Math.PI / 180);
  const x = (point[0] - start[0]) * k; const y = point[1] - start[1];
  const dx = (end[0] - start[0]) * k; const dy = end[1] - start[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, (x * dx + y * dy) / length)) : 0;
  return Math.hypot(x - t * dx, y - t * dy) * (Math.PI / 180) * EARTH_RADIUS_M;
}

/** Ramer–Douglas–Peucker with a tolerance in metres; keeps both ends. */
export function simplifySegment(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let index = -1; let max = tolerance;
    for (let i = first + 1; i < last; i++) {
      const d = offset(points[i], points[first], points[last]);
      if (d > max) { max = d; index = i; }
    }
    if (index !== -1) { keep[index] = 1; stack.push([first, index], [index, last]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Thins segments until they hold at most `maxPoints` positions together, raising the tolerance from 2 m. */
export function simplifySegments(segments, maxPoints) {
  const count = (list) => list.reduce((sum, segment) => sum + segment.length, 0);
  if (count(segments) <= maxPoints) return segments;
  let result = segments;
  for (let tolerance = 2; tolerance <= 2048 && count(result) > maxPoints; tolerance *= 2) result = segments.map((segment) => simplifySegment(segment, tolerance));
  const total = count(result);
  if (total <= maxPoints) return result;
  // Still too dense (a very long track): keep every n-th point and the ends.
  const step = Math.ceil(total / maxPoints);
  return result.map((segment) => segment.filter((_, i) => i % step === 0 || i === segment.length - 1));
}
