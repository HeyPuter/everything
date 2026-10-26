import { featureCode } from './countries.js';

// Points up to this far outside every polygon (coastal places, small islands the data drops) snap to the nearest one.
const SNAP_DEGREES = 0.25;

function polygonsOf(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}
function bounds(rings) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [x, y] of rings[0] ?? []) { if (x < west) west = x; if (x > east) east = x; if (y < south) south = y; if (y > north) north = y; }
  return [west, south, east, north];
}
// Even-odd rule over all rings, so holes are excluded.
function contains(rings, x, y) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
function segmentDistance(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax; const dy = by - ay;
  const length = dx * dx + dy * dy;
  const k = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  const px = ax + k * dx - x; const py = ay + k * dy - y;
  return Math.sqrt(px * px + py * py);
}

/**
 * Point-in-polygon lookup over a FeatureCollection in planar lng/lat, already split at the antimeridian
 * (`splitAntimeridian`). `keyOf(feature)` names each feature; features without a key are skipped.
 * `locate(lat, lng)` returns the key or null.
 */
export function createShapeLocator(collection, keyOf, { snap = SNAP_DEGREES } = {}) {
  const shapes = [];
  for (const feature of collection?.features ?? []) {
    const code = keyOf(feature);
    if (!code) continue;
    for (const rings of polygonsOf(feature.geometry)) if (rings[0]?.length >= 4) shapes.push({ code, rings, box: bounds(rings) });
  }
  // Smallest first, so enclaves drawn inside a neighbour without a hole (Vatican, San Marino) win.
  const area = ({ box }) => (box[2] - box[0]) * (box[3] - box[1]);
  shapes.sort((a, b) => area(a) - area(b));
  return function locate(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    for (const { code, rings, box } of shapes) {
      if (lng >= box[0] && lng <= box[2] && lat >= box[1] && lat <= box[3] && contains(rings, lng, lat)) return code;
    }
    let best = null; let distance = snap;
    for (const { code, rings, box } of shapes) {
      if (lng < box[0] - distance || lng > box[2] + distance || lat < box[1] - distance || lat > box[3] + distance) continue;
      const ring = rings[0];
      for (let i = 1; i < ring.length; i++) {
        const d = segmentDistance(lng, lat, ring[i - 1], ring[i]);
        if (d < distance) { distance = d; best = code; }
      }
    }
    return best;
  };
}

/** Point-in-country lookup over countries-50m; `locate(lat, lng)` returns an alpha-2 code or null. */
export function createLocator(collection) {
  return createShapeLocator(collection, featureCode);
}
