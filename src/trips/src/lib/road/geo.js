import { distance } from '../../services/route.js';

// Geometry along routes. Points and lines are [lng, lat]; distances are metres.

export { distance };
const KM_LAT = 110.574;
const kmPerLng = (lat) => Math.max(0.01, 111.320 * Math.cos(lat * Math.PI / 180));

/** Running distance at each vertex of a line. */
export function cumulative(line) {
  const sums = [0];
  for (let i = 1; i < line.length; i++) sums.push(sums[i - 1] + distance(line[i - 1], line[i]));
  return sums;
}
export const lineLength = (line) => (line.length < 2 ? 0 : cumulative(line).at(-1));

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** The point `fraction` (0–1) of the way along a line by distance. */
export function pointAt(line, fraction) {
  if (!line?.length) return null;
  if (line.length === 1) return [...line[0]];
  const sums = cumulative(line); const total = sums.at(-1);
  if (!(total > 0)) return [...line[0]];
  const target = Math.max(0, Math.min(1, fraction)) * total;
  const index = Math.max(1, sums.findIndex((value) => value >= target));
  const span = sums[index] - sums[index - 1];
  return lerp(line[index - 1], line[index], span > 0 ? (target - sums[index - 1]) / span : 0);
}

/** The part of a line between two fractions. */
export function slice(line, from, to) {
  if (!line?.length || line.length < 2) return line ? [...line] : [];
  const sums = cumulative(line); const total = sums.at(-1);
  const a = Math.max(0, Math.min(from, to)) * total; const b = Math.min(1, Math.max(from, to)) * total;
  const result = [pointAt(line, a / (total || 1))];
  for (let i = 1; i < line.length - 1; i++) if (sums[i] > a && sums[i] < b) result.push([...line[i]]);
  result.push(pointAt(line, b / (total || 1)));
  return result;
}

/** Nearest point of a line to `point`: `{fraction, distance (m), point}`. Planar per segment, which is close enough near a road. */
export function project(line, point) {
  if (!line?.length) return null;
  if (line.length === 1) return { fraction: 0, distance: distance(line[0], point), point: [...line[0]] };
  const sums = cumulative(line); const total = sums.at(-1);
  let best = null;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]; const b = line[i];
    const kx = kmPerLng((a[1] + b[1]) / 2);
    const ax = a[0] * kx; const ay = a[1] * KM_LAT; const bx = b[0] * kx; const by = b[1] * KM_LAT;
    const px = point[0] * kx; const py = point[1] * KM_LAT;
    const dx = bx - ax; const dy = by - ay; const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
    const near = lerp(a, b, t);
    const d = distance(near, point);
    if (!best || d < best.distance) best = { distance: d, point: near, along: sums[i - 1] + (sums[i] - sums[i - 1]) * t };
  }
  return { fraction: total > 0 ? best.along / total : 0, distance: best.distance, point: best.point };
}

/**
 * Splits a routed line into one line per leg at the vertices nearest each intermediate waypoint (the route passes
 * through them). `waypoints` includes both ends.
 */
export function splitAtWaypoints(line, waypoints) {
  if (waypoints.length <= 2) return [line];
  const cuts = [0];
  let from = 0;
  for (const waypoint of waypoints.slice(1, -1)) {
    let best = from; let bestDistance = Infinity;
    for (let i = from; i < line.length; i++) {
      const d = distance(line[i], waypoint);
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    cuts.push(best); from = best;
  }
  cuts.push(line.length - 1);
  return cuts.slice(1).map((end, i) => {
    const piece = line.slice(cuts[i], end + 1);
    return piece.length >= 2 ? piece : [waypoints[i], waypoints[i + 1]];
  });
}

/** Adds vertices so no segment is longer than `stepKm` (straight estimates are two points), capped at `max` vertices. */
export function densify(line, stepKm = 5, max = 2000) {
  if (!line || line.length < 2) return line ?? [];
  const out = [line[0]];
  for (let i = 1; i < line.length && out.length < max; i++) {
    const pieces = Math.min(max, Math.ceil(distance(line[i - 1], line[i]) / 1000 / stepKm));
    for (let k = 1; k <= pieces; k++) out.push(lerp(line[i - 1], line[i], k / pieces));
  }
  return out;
}

/** Keeps at most `max` vertices, always the ends. */
export function downsample(line, max = 500) {
  if (line.length <= max) return line;
  const step = (line.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => line[Math.round(i * step)]);
}

function box(points, padKm) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of points) { w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat); }
  const lat = (s + n) / 2; const padLat = padKm / KM_LAT; const padLng = padKm / kmPerLng(lat);
  return [Math.max(-180, w - padLng), Math.max(-90, s - padLat), Math.min(180, e + padLng), Math.min(90, n + padLat)];
}

/**
 * Boxes that cover a line plus `widthKm` either side, each at most `maxSpan`° wide and tall, for a POI search along a
 * route. Long lines get longer pieces so the count stays at or under `maxBoxes`; `truncated` says boxes were dropped.
 */
export function corridorBoxes(line, widthKm, { maxBoxes = 12, maxSpan = 2, minPieceKm = 15 } = {}) {
  if (!line?.length) return { boxes: [], truncated: false };
  const points = line.length === 1 ? [line[0], line[0]] : line;
  const sums = cumulative(points); const totalKm = sums.at(-1) / 1000;
  const pieceKm = Math.max(minPieceKm, totalKm / maxBoxes);
  const boxes = [];
  let start = 0;
  const pieces = Math.max(1, Math.ceil(totalKm / pieceKm));
  for (let piece = 1; piece <= pieces; piece++) {
    const end = piece === pieces ? 1 : (piece * pieceKm) / (totalKm || 1);
    const part = totalKm > 0 ? slice(points, start, end) : points;
    const queue = [part];
    while (queue.length) {
      const current = queue.shift();
      const b = box(current, widthKm);
      if ((b[2] - b[0] > maxSpan || b[3] - b[1] > maxSpan) && current.length >= 2 && lineLength(current) > 2000) {
        queue.unshift(slice(current, 0, 0.5), slice(current, 0.5, 1));
        continue;
      }
      boxes.push([b[0], b[1], Math.min(b[2], b[0] + maxSpan), Math.min(b[3], b[1] + maxSpan)]);
    }
    start = end;
  }
  return { boxes: boxes.slice(0, maxBoxes), truncated: boxes.length > maxBoxes };
}

/**
 * Results (`{lat, lng}`) within `widthKm` of a line, with `off` (m from the route) and `along` (0–1), sorted along
 * the route. Duplicates by id are dropped.
 */
export function withinCorridor(results, line, widthKm) {
  const seen = new Set(); const kept = [];
  for (const item of results ?? []) {
    if (!Number.isFinite(item?.lat) || !Number.isFinite(item?.lng)) continue;
    const key = item.id ?? `${item.lat},${item.lng}`;
    if (seen.has(key)) continue;
    const near = project(line, [item.lng, item.lat]);
    if (!near || near.distance > widthKm * 1000) continue;
    seen.add(key);
    kept.push({ ...item, off: near.distance, along: near.fraction });
  }
  return kept.sort((a, b) => a.along - b.along || a.off - b.off);
}
