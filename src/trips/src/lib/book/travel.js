// Geometry for travel elements: a fitted Web Mercator view, country outlines, route lines and pins.
const MAX_LAT = 85;
// About 0.7° of longitude: a city-sized journey still shows its surroundings.
const MIN_SPAN = 0.002;

export const located = (entry) => Number.isFinite(entry?.loc?.lat) && Number.isFinite(entry?.loc?.lng);

/** Unit Web Mercator: x and y in 0–1, y down. */
export function mercator(lng, lat) {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return [(lng + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2];
}

/** Located entries as `{id, lng, lat}` in story order; `ids` keeps only those entries. */
export function routePoints(entries, { ids = null } = {}) {
  return entries.filter((entry) => located(entry) && (!ids || ids.has(entry.id))).map((entry) => ({ id: entry.id, lng: entry.loc.lng, lat: entry.loc.lat }));
}

/** Points for a travel element: the page's own entries for `scope: 'page'` (all of them when it names none). */
export function scopedPoints(entries, page, scope) {
  if (scope !== 'page') return routePoints(entries);
  const ids = new Set(Object.values(page?.els ?? {}).map((item) => item.entry).filter(Boolean));
  const points = routePoints(entries, { ids });
  return points.length ? points : routePoints(entries);
}

/** A view `{x, y, span}` (unit Mercator) fitting `points` into a box of `aspect` (width / height) with padding. */
export function fitView(points, aspect = 1, pad = 0.18) {
  if (!points.length) return { x: 0, y: 0.1, spanX: 1, spanY: 0.8 / Math.max(aspect, 0.1) };
  const xy = points.map((point) => mercator(point.lng, point.lat));
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of xy) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  let spanX = Math.max(MIN_SPAN, (maxX - minX) * (1 + pad * 2));
  let spanY = Math.max(MIN_SPAN / Math.max(aspect, 0.1), (maxY - minY) * (1 + pad * 2));
  if (spanX / spanY > aspect) spanY = spanX / aspect; else spanX = spanY * aspect;
  return { x: (minX + maxX) / 2 - spanX / 2, y: (minY + maxY) / 2 - spanY / 2, spanX, spanY };
}

/** Projects lng/lat into a `w` × `h` box for a view. */
export const projector = (view, w, h) => (lng, lat) => {
  const [x, y] = mercator(lng, lat);
  return [((x - view.x) / view.spanX) * w, ((y - view.y) / view.spanY) * h];
};

const fmt = (value) => (Math.round(value * 10) / 10).toString();

/** An SVG path for Polygon or MultiPolygon rings; rings fully outside the box are dropped. */
export function shapePath(geometry, project, w, h) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  const parts = [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const points = ring.map(([lng, lat]) => project(lng, lat));
      if (points.every(([x]) => x < -w * 0.1) || points.every(([x]) => x > w * 1.1) || points.every(([, y]) => y < -h * 0.1) || points.every(([, y]) => y > h * 1.1)) continue;
      parts.push(`M${points.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L')}Z`);
    }
  }
  return parts.join('');
}

/** Outline points of a geometry's largest polygon, which frames a country without its far-off territories. */
export function geometryPoints(geometry) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  let best = null;
  let bestArea = -1;
  for (const polygon of polygons) {
    const ring = polygon[0] ?? [];
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    if (Math.abs(area) > bestArea) { bestArea = Math.abs(area); best = ring; }
  }
  return (best ?? []).map(([lng, lat]) => ({ lng, lat }));
}

/** An open polyline path through projected points. */
export const linePath = (points, project) => (points.length > 1 ? `M${points.map((point) => project(point.lng, point.lat)).map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L')}` : '');

/** A flag emoji from an ISO 3166-1 alpha-2 code. */
export const flagEmoji = (cc) => (/^[A-Z]{2}$/.test(cc ?? '') ? String.fromCodePoint(...[...cc].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65)) : '');
