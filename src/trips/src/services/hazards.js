import { DAY, MINUTE, plainText, httpURL } from './core.js';

const GDACS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const DWD_URL = 'https://maps.dwd.de/geoserver/dwd/ows';
const GDACS_TYPES = ['EQ', 'TC', 'FL', 'VO', 'DR', 'WF'];
// Germany's extent; DWD warnings are only asked for where a route enters it.
export const GERMANY = Object.freeze([5.5, 47.2, 15.5, 55.1]);
const DWD_LEVELS = Object.freeze({ Moderate: 'orange', Severe: 'red', Extreme: 'red' });
export const HAZARD_CREDITS = Object.freeze({
  gdacs: { text: 'GDACS', url: 'https://www.gdacs.org/' },
  dwd: { text: 'Deutscher Wetterdienst', url: 'https://www.dwd.de/', license: 'CC BY 4.0' },
});
const MAX_RING = 2000;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const lngLat = (value) => (Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])
  && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90 ? [value[0], value[1]] : null);
const instant = (value) => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; };
const ring = (values) => {
  const points = Array.isArray(values) ? values.map(lngLat).filter(Boolean) : [];
  if (points.length <= MAX_RING) return points;
  const step = points.length / MAX_RING;
  return Array.from({ length: MAX_RING }, (_, i) => points[Math.floor(i * step)]);
};
function polygons(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates.map(ring).filter((item) => item.length >= 4)];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.map((rings) => rings.map(ring).filter((item) => item.length >= 4));
  return [];
}
function bounds(list) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const rings of list) for (const [lng, lat] of rings[0] ?? []) { w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat); }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/** GDACS event list GeoJSON → `[{id, source, type, level, name, from, to, point, url, country}]`, current events only. */
export function gdacsEvents(data, now = Date.now()) {
  if (!Array.isArray(data?.features)) throw new Error('Invalid GDACS response');
  const seen = new Set();
  return data.features.slice(0, 500).flatMap((feature) => {
    const p = feature?.properties ?? {};
    const type = GDACS_TYPES.includes(p.eventtype) ? p.eventtype : null;
    const level = String(p.alertlevel ?? '').toLowerCase();
    const at = feature?.geometry?.type === 'Point' ? lngLat(feature.geometry.coordinates) : null;
    if (!type || !['green', 'orange', 'red'].includes(level) || !at) return [];
    const id = `gdacs:${type}:${String(p.eventid ?? '').slice(0, 20)}`;
    if (seen.has(id)) return [];
    const to = instant(p.todate);
    if (p.iscurrent === false || p.iscurrent === 'false' || (to !== null && to < now - DAY)) return [];
    seen.add(id);
    return [{
      id, source: 'gdacs', type, level, name: plainText(p.name ?? p.eventname ?? '', 200), from: instant(p.fromdate), to,
      point: at, url: httpURL(p.url?.report ?? p.url?.details ?? '') ?? null, country: plainText(p.country ?? '', 120),
    }];
  });
}

/** DWD warning features → `[{id, source, level, name, headline, from, to, polygons, bbox}]`, Minor ones dropped. */
export function dwdWarnings(data, now = Date.now()) {
  if (!Array.isArray(data?.features)) throw new Error('Invalid DWD response');
  const seen = new Set();
  return data.features.slice(0, 500).flatMap((feature, index) => {
    const p = feature?.properties ?? {};
    const level = DWD_LEVELS[p.SEVERITY];
    const shapes = polygons(feature?.geometry);
    if (!level || !shapes.length) return [];
    const to = instant(p.EXPIRES);
    if (to !== null && to < now) return [];
    const id = `dwd:${plainText(String(p.IDENTIFIER ?? p.WARNCELLID ?? index), 120)}:${plainText(String(p.EVENT ?? ''), 60)}`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, source: 'dwd', type: 'WX', level, name: plainText(p.EVENT ?? '', 120), headline: plainText(p.HEADLINE ?? '', 300), area: plainText(p.AREADESC ?? '', 200), from: instant(p.ONSET), to, polygons: shapes, bbox: bounds(shapes) }];
  });
}

const overlap = (a, b) => {
  const box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return box[0] < box[2] && box[1] < box[3] ? box : null;
};

/**
 * Hazards for road trips: GDACS disasters worldwide and DWD weather warnings in Germany, cached ten minutes.
 * `gdacs()` and `dwd(bbox)` resolve `{data, attribution, cached, stale}` or null offline without a cache.
 */
export function createHazards(ctx) {
  return {
    gdacs({ signal } = {}) {
      const now = ctx.now?.() ?? Date.now();
      const from = isoDate(now - 14 * DAY); const to = isoDate(now + DAY);
      return ctx.run('hazards', { gdacs: 1, from, to }, {
        gdacs: async (_cfg, request = {}) => {
          const url = new URL(GDACS_URL);
          url.search = new URLSearchParams({ eventlist: GDACS_TYPES.join(';'), fromDate: from, toDate: to, alertlevel: 'orange;red' });
          const { data } = await ctx.json(url.href, { provider: 'gdacs', interval: 1000, ...request });
          return { data: gdacsEvents(data, now), attribution: [HAZARD_CREDITS.gdacs] };
        },
      }, { ttl: 10 * MINUTE, signal });
    },
    /** Warnings inside `bbox` ([w, s, e, n]) where it overlaps Germany; `{data: []}` elsewhere. */
    async dwd(bbox, { signal } = {}) {
      const area = Array.isArray(bbox) ? overlap(bbox, GERMANY) : null;
      if (!area) return { data: [], attribution: [], cached: false, stale: false };
      const box = [Math.floor(area[0] * 10) / 10, Math.floor(area[1] * 10) / 10, Math.ceil(area[2] * 10) / 10, Math.ceil(area[3] * 10) / 10];
      const now = ctx.now?.() ?? Date.now();
      return ctx.run('hazards', { dwd: 1, box }, {
        dwd: async (_cfg, request = {}) => {
          const url = new URL(DWD_URL);
          url.search = new URLSearchParams({
            service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: 'dwd:Warnungen_Landkreise', outputFormat: 'application/json',
            srsName: 'EPSG:4326', bbox: `${box.join(',')},EPSG:4326`, count: '200',
          });
          const { data } = await ctx.json(url.href, { provider: 'dwd', interval: 1000, ...request });
          return { data: dwdWarnings(data, now), attribution: [HAZARD_CREDITS.dwd] };
        },
      }, { ttl: 10 * MINUTE, signal });
    },
  };
}
