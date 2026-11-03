import { coordinate, point } from '../src/services/core.js';

export const TTL = Object.freeze({ nominatim: 30 * 86400, osrm: 7 * 86400, valhalla: 7 * 86400 });
export const invalid = (code, status = 400) => Object.assign(new Error(code), { code, status });
const PROFILES = { drive: 'car', bike: 'bike', walk: 'foot' };
const COSTING = { drive: 'auto', bike: 'bicycle', walk: 'pedestrian' };
const AVOID = ['ferry', 'motorway', 'toll'];
const round = (value, digits) => Number(value.toFixed(digits));
const language = value => {
  const lang = (value ?? 'en').toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(lang) || lang.length > 20) throw invalid('invalid_language');
  return lang;
};
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const routePoints = (points, max) => {
  if (!Array.isArray(points) || points.length < 2 || points.length > max) throw invalid('invalid_route');
  return points.map(value => point(value).map(n => round(n, 5)));
};

function nominatim(kind, params) {
  const allowed = { search: ['q', 'lang', 'viewbox'], reverse: ['lat', 'lon', 'lang'], lookup: ['osm_ids', 'lang'] }[kind];
  if (!allowed) return null;
  const names = [...params.keys()];
  if (names.some(name => !allowed.includes(name)) || new Set(names).size !== names.length) throw invalid('invalid_query');
  const lang = language(params.get('lang') ?? undefined);
  const upstream = new URL(`https://nominatim.openstreetmap.org/${kind}`);
  upstream.search = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', extratags: '1', 'accept-language': lang });
  let key;
  if (kind === 'search') {
    const q = params.get('q')?.replace(/\s+/g, ' ').trim();
    if (!q || q.length > 200) throw invalid('invalid_query');
    upstream.searchParams.set('q', q); upstream.searchParams.set('limit', '8');
    let viewbox;
    if (params.has('viewbox')) {
      viewbox = params.get('viewbox').split(',').map(value => value.trim() === '' ? NaN : Number(value));
      if (viewbox.length !== 4) throw invalid('invalid_viewbox');
      coordinate(viewbox[1], viewbox[0]); coordinate(viewbox[3], viewbox[2]);
      viewbox = viewbox.map(value => round(value, 2));
      upstream.searchParams.set('viewbox', viewbox.join(','));
    }
    key = { kind, q: q.toLocaleLowerCase('en'), lang, viewbox };
  } else if (kind === 'reverse') {
    const latRaw = params.get('lat'), lonRaw = params.get('lon');
    if (latRaw === null || lonRaw === null || !latRaw.trim() || !lonRaw.trim()) throw invalid('invalid_coordinates');
    const lat = Number(latRaw), lng = Number(lonRaw); coordinate(lat, lng);
    upstream.searchParams.set('lat', lat.toFixed(5)); upstream.searchParams.set('lon', lng.toFixed(5));
    key = { kind, lat: lat.toFixed(5), lng: lng.toFixed(5), lang };
  } else {
    const ids = params.get('osm_ids');
    if (!/^[NWR]\d{1,15}$/.test(ids ?? '')) throw invalid('invalid_query');
    upstream.searchParams.set('osm_ids', ids);
    key = { kind, ids, lang };
  }
  // Search and lookup answer arrays; reverse answers one object. A 200 `{error}` means "nothing here" and is cached for a day.
  const accept = kind === 'reverse' ? data => plainObject(data) : data => Array.isArray(data) || (plainObject(data) && typeof data.error === 'string');
  return { provider: 'nominatim', upstream: { url: upstream.href, method: 'GET' }, key, accept, negative: data => plainObject(data) && 'error' in data };
}

function osrm(kind, body) {
  if (!plainObject(body) || Object.keys(body).some(name => !['points', 'mode'].includes(name)) || !Object.hasOwn(PROFILES, body.mode)) throw invalid('invalid_route');
  const points = routePoints(body.points, kind === 'route' ? 25 : 10);
  const upstream = new URL(`https://routing.openstreetmap.de/routed-${PROFILES[body.mode]}/${kind === 'route' ? 'route' : 'table'}/v1/driving/${points.map(p => p.join(',')).join(';')}`);
  upstream.search = new URLSearchParams(kind === 'route' ? { overview: 'full', geometries: 'polyline6', steps: 'false' } : { annotations: 'duration,distance' });
  return { provider: 'osrm', upstream: { url: upstream.href, method: 'GET' }, key: { kind, points, mode: body.mode }, accept: data => data?.code === 'Ok' };
}

function valhalla(body) {
  if (!plainObject(body) || Object.keys(body).some(name => !['points', 'mode', 'avoid'].includes(name)) || !Object.hasOwn(COSTING, body.mode)) throw invalid('invalid_route');
  const points = routePoints(body.points, 25);
  const avoid = body.avoid ?? [];
  if (!Array.isArray(avoid) || avoid.length > AVOID.length || avoid.some(value => !AVOID.includes(value))) throw invalid('invalid_route');
  const avoids = [...new Set(avoid)].sort(); const costing = COSTING[body.mode]; const options = {};
  if (avoids.includes('ferry')) options.use_ferry = 0;
  if (costing === 'auto' && avoids.includes('toll')) options.use_tolls = 0;
  if (costing === 'auto' && avoids.includes('motorway')) options.use_highways = 0;
  const request = { locations: points.map(([lng, lat]) => ({ lat, lon: lng })), costing, costing_options: { [costing]: options }, units: 'kilometers', directions_type: 'none' };
  return { provider: 'valhalla', upstream: { url: 'https://valhalla1.openstreetmap.de/route', method: 'POST', body: JSON.stringify(request) }, key: { kind: 'valhalla', points, mode: body.mode, avoid: avoids }, accept: data => data?.trip?.status === 0 };
}

/** Maps a client request to its upstream call and cache identity; null for unknown routes. */
export function normalizeRequest({ method, pathname, params = new URLSearchParams(), body }) {
  if (method === 'GET' && pathname.startsWith('/nominatim/')) return nominatim(pathname.slice('/nominatim/'.length), params);
  if (method === 'POST' && (pathname === '/route' || pathname === '/matrix')) return osrm(pathname.slice(1), body);
  if (method === 'POST' && pathname === '/valhalla') return valhalla(body);
  return null;
}
