import { point } from '../services/core.js';
const radians = value => value * Math.PI / 180;
const degrees = value => value * 180 / Math.PI;
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = vector => { const length = Math.hypot(...vector); return vector.map(value => value / length); };
const vector = ([lng, lat]) => [Math.cos(radians(lat)) * Math.cos(radians(lng)), Math.cos(radians(lat)) * Math.sin(radians(lng)), Math.sin(radians(lat))];
const coordinate = value => [degrees(Math.atan2(value[1], value[0])), degrees(Math.atan2(value[2], Math.hypot(value[0], value[1])))];
const equal = (a, b) => Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;

/** Shortest spherical arc; exact antipodes use a deterministic perpendicular. */
export function geodesicArc(from, to, { segments = 128, properties = {}, id } = {}) {
  from = point(from); to = point(to);
  if (!Number.isInteger(segments) || segments < 2 || segments > 2048) throw new RangeError('Arc segments must be between 2 and 2048');
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw new RangeError('Invalid arc properties');
  if (id !== undefined && !(typeof id === 'string' && id.length <= 200) && !(typeof id === 'number' && Number.isFinite(id))) throw new RangeError('Invalid arc id');
  const start = vector(from), end = vector(to);
  const cosine = Math.max(-1, Math.min(1, dot(start, end)));
  const sine = Math.hypot(...cross(start, end));
  let angle = Math.atan2(sine, cosine);
  let tangent;
  if (sine < 1e-12) {
    if (cosine > 0) angle = 0;
    const axis = [0, 0, 0];
    const minimum = Math.min(...start.map(Math.abs));
    axis[start.findIndex(value => Math.abs(value) <= minimum + 1e-12)] = 1;
    tangent = unit(axis.map((value, i) => value - start[i] * dot(start, axis)));
  } else tangent = unit(end.map((value, i) => value - start[i] * cosine));
  const normal = unit(cross(start, tangent));
  let intersection = unit([-normal[2], 0, normal[0]]);
  if (intersection[0] > 0) intersection = intersection.map(value => -value);
  const crossingLatitude = coordinate(intersection)[1];
  const points = angle === 0 ? [from, [...from]] : Array.from({ length: segments + 1 }, (_, i) => {
    if (i === 0) return from;
    if (i === segments) return to;
    const distance = angle * i / segments;
    return coordinate(start.map((value, n) => value * Math.cos(distance) + tangent[n] * Math.sin(distance)));
  });
  const lines = []; let line = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1], next = points[i];
    if (Math.abs(next[0] - previous[0]) > 180 + 1e-10) {
      const boundary = previous[0] >= 0 ? 180 : -180;
      const lat = Number.isFinite(crossingLatitude) ? crossingLatitude : (previous[1] + next[1]) / 2;
      const edge = [boundary, lat];
      if (!equal(line.at(-1), edge)) line.push(edge);
      if (line.length > 1 && line.some(value => !equal(value, line[0]))) lines.push(line);
      line = [[-boundary, lat]];
      if (!equal(line[0], next)) line.push(next);
    } else if (!equal(line.at(-1), next)) line.push(next);
  }
  if (line.length === 1) line.push([...line[0]]);
  lines.push(line);
  return { type: 'Feature', ...(id === undefined ? {} : { id }), properties: structuredClone(properties), geometry: lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines } };
}
export function arcGeoJSON(from, to, options) { return { type: 'FeatureCollection', features: [geodesicArc(from, to, options)] }; }
