// Web Mercator tile math for offline map downloads. Boxes are {west, south, east, north} in degrees;
// `west > east` means the box crosses the antimeridian.
const MAX_LAT = 85.0511287798;
const KM_PER_DEGREE = 111.32;
export const MAX_ZOOM = 14;

const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
const wrap = (lng) => (lng < -180 ? lng + 360 : lng > 180 ? lng - 360 : lng);
const validPoint = (point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])
  && point[0] >= -180 && point[0] <= 180 && point[1] >= -90 && point[1] <= 90;

export function lngToX(lng, z) {
  const n = 2 ** z;
  return Math.min(n - 1, Math.max(0, Math.floor(((lng + 180) / 360) * n)));
}
export function latToY(lat, z) {
  const n = 2 ** z;
  const r = (clampLat(lat) * Math.PI) / 180;
  return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
}

/** Smallest box around `[lng, lat]` points, choosing the side of the globe with the largest empty gap. */
export function bounds(points) {
  const valid = points.filter(validPoint);
  if (!valid.length) return null;
  const lats = valid.map((point) => point[1]);
  const lngs = [...new Set(valid.map((point) => point[0]))].sort((a, b) => a - b);
  let gap = lngs[0] + 360 - lngs.at(-1);
  let west = lngs[0];
  let east = lngs.at(-1);
  for (let index = 0; index < lngs.length - 1; index++) {
    const width = lngs[index + 1] - lngs[index];
    if (width > gap) { gap = width; west = lngs[index + 1]; east = lngs[index]; }
  }
  return { west, south: Math.min(...lats), east, north: Math.max(...lats) };
}

/** Grows a box by `fraction` of its size on each side, at least `minDegrees`. */
export function pad(box, fraction = 0.1, minDegrees = 0.02) {
  const width = box.west <= box.east ? box.east - box.west : box.east + 360 - box.west;
  const dx = Math.max(width * fraction, minDegrees);
  const dy = Math.max((box.north - box.south) * fraction, minDegrees);
  const south = clampLat(box.south - dy);
  const north = clampLat(box.north + dy);
  if (width + 2 * dx >= 360) return { west: -180, south, east: 180, north };
  return { west: wrap(box.west - dx), south, east: wrap(box.east + dx), north };
}

/** A box `km` around one point. */
export function around([lng, lat], km) {
  const dy = km / KM_PER_DEGREE;
  const dx = km / (KM_PER_DEGREE * Math.max(Math.cos((clampLat(lat) * Math.PI) / 180), 0.01));
  if (dx >= 180) return { west: -180, south: clampLat(lat - dy), east: 180, north: clampLat(lat + dy) };
  return { west: wrap(lng - dx), south: clampLat(lat - dy), east: wrap(lng + dx), north: clampLat(lat + dy) };
}

/** Tile ranges `{z, x0, x1, y0, y1}` covering a box at one zoom; two when it crosses the antimeridian. */
export function ranges(box, z) {
  const y0 = latToY(box.north, z);
  const y1 = latToY(box.south, z);
  if (box.west <= box.east) return [{ z, x0: lngToX(box.west, z), x1: lngToX(box.east, z), y0, y1 }];
  return [{ z, x0: lngToX(box.west, z), x1: 2 ** z - 1, y0, y1 }, { z, x0: 0, x1: lngToX(box.east, z), y0, y1 }];
}
export const rangeCount = (range) => (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);

/**
 * Ranges for one trip, low zooms first: the whole trip (`overview` points, padded) down to the deepest zoom that keeps
 * it under `overviewTiles`, then `radiusKm` around each detail point down to `maxZoom`.
 */
export function planTiles({ overview = [], detail = overview, maxZoom = MAX_ZOOM, overviewTiles = 800, radiusKm = 2.5 } = {}) {
  const box = bounds(overview.length ? overview : detail);
  if (!box) return { ranges: [], overviewZoom: -1 };
  const whole = pad(box);
  const result = [];
  let total = 0;
  let overviewZoom = 0;
  for (let z = 0; z <= maxZoom; z++) {
    const level = ranges(whole, z);
    const count = level.reduce((sum, range) => sum + rangeCount(range), 0);
    if (z > 0 && total + count > overviewTiles) break;
    result.push(...level); total += count; overviewZoom = z;
  }
  const points = detail.filter(validPoint);
  for (let z = overviewZoom + 1; z <= maxZoom; z++) {
    for (const point of points) result.push(...ranges(around(point, radiusKm), z));
  }
  return { ranges: result, overviewZoom };
}

/** Unique tiles in plan order, at most `limit`. */
export function* tilesOf(planned, limit = Infinity) {
  const seen = new Set();
  for (const range of planned) {
    for (let x = range.x0; x <= range.x1; x++) {
      for (let y = range.y0; y <= range.y1; y++) {
        const key = `${range.z}/${x}/${y}`;
        if (seen.has(key)) continue;
        if (seen.size >= limit) return;
        seen.add(key);
        yield { z: range.z, x, y };
      }
    }
  }
}

export function countTiles(planned, limit = Infinity) {
  let count = 0;
  for (const _tile of tilesOf(planned, limit)) count++;
  return count;
}

/** `{z}`, `{x}`, `{y}` in a tile URL template. */
export const tileURL = (template, { z, x, y }) => template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
