// Reads the stops of a Google Maps directions link, in order, parsed locally (no page is fetched). Handles
// `/maps/dir/A/B/…` with its `data=` blob (stop coordinates, dragged route points, travel mode), the `api=1` URL
// scheme, and the older `saddr`/`daddr` form. Short links are followed by reading only their `Location` header.
import { parseCoordinates } from '../../views/trip/places/parse.js';

const NAME_MAX = 200;
const MAX_STOPS = 25;
const MODES = Object.freeze({ 0: 'drive', 1: 'bike', 2: 'walk', 3: 'transit' });
const TRAVEL = Object.freeze({ driving: 'drive', bicycling: 'bike', walking: 'walk', transit: 'transit' });
const SHORT = new Set(['maps.app.goo.gl', 'goo.gl']);

const round = (value) => Math.round(value * 1e6) / 1e6;
const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

function decode(value) {
  let text = String(value ?? '').replace(/\+/g, ' ');
  try { text = decodeURIComponent(text); } catch { /* keep the raw text */ }
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/** A stop from a path segment or parameter: coordinates, or a name to look up. Empty means "your location". */
function stopOf(value) {
  const text = decode(value);
  if (!text) return null;
  const coords = parseCoordinates(text);
  return coords ? { lat: coords.lat, lng: coords.lng } : { name: text };
}

/**
 * The `!`-separated blob as a tree: `<field><type><value>`, where type `m` is a message holding the next N tokens
 * (all its descendants). Malformed counts end the parse.
 */
export function parseData(blob) {
  const tokens = String(blob ?? '').split('!').filter(Boolean).slice(0, 2000);
  let at = 0;
  function read(count) {
    const out = [];
    const end = Math.min(tokens.length, at + count);
    while (at < end) {
      const match = /^(\d+)([a-z])(.*)$/.exec(tokens[at]);
      at += 1;
      if (!match) continue;
      const node = { field: Number(match[1]), type: match[2], value: match[3] };
      if (node.type === 'm') {
        const size = Number(node.value);
        node.children = Number.isSafeInteger(size) && size >= 0 ? read(size) : [];
      }
      out.push(node);
    }
    return out;
  }
  return read(tokens.length);
}

const child = (node, field, type) => node?.children?.find((item) => item.field === field && item.type === type) ?? null;
function pointOf(node) {
  const lng = Number(child(node, 1, 'd')?.value);
  const lat = Number(child(node, 2, 'd')?.value);
  return valid(lat, lng) ? { lat: round(lat), lng: round(lng) } : null;
}

/** The message listing the stops: the one with the most repeated `1m` children (at least two). */
function stopList(nodes) {
  let best = null;
  const walk = (list) => {
    for (const node of list) {
      if (node.type !== 'm') continue;
      const stops = node.children.filter((item) => item.field === 1 && item.type === 'm');
      if (stops.length >= 2 && (!best || stops.length > best.stops.length)) best = { node, stops };
      walk(node.children);
    }
  };
  walk(nodes);
  return best;
}

/** Stop coordinates, dragged route points and travel mode from a directions link's `data=` blob. */
export function dataStops(blob) {
  const found = stopList(parseData(blob));
  if (!found) return null;
  const stops = found.stops.map((node) => {
    const point = pointOf(child(node, 2, 'm'));
    const vias = node.children.filter((item) => item.field === 3 && item.type === 'm').map((item) => pointOf(child(item, 1, 'm'))).filter(Boolean);
    return { point, vias };
  });
  const mode = MODES[child(found.node, 3, 'e')?.value] ?? null;
  return { stops, mode };
}

function fromDirPath(url) {
  const segments = url.pathname.split('/');
  const dir = segments.indexOf('dir');
  if (dir < 0) return null;
  const parts = [];
  let data = null;
  for (const segment of segments.slice(dir + 1)) {
    if (segment.startsWith('@')) continue;
    if (segment.startsWith('data=')) { data = segment.slice(5); continue; }
    parts.push(segment);
  }
  while (parts.length && !parts.at(-1)) parts.pop();
  const stops = parts.map(stopOf);
  const parsed = data ? dataStops(data) : null;
  const out = { stops: [], vias: [], mode: parsed?.mode ?? null };
  // Data stops follow the path segments one to one (including "your location"), adding coordinates and route points.
  const aligned = parsed && parsed.stops.length === stops.length;
  stops.forEach((stop, index) => {
    const extra = aligned ? parsed.stops[index] : null;
    if (!stop) return;
    const point = extra?.point;
    out.stops.push(point && !Number.isFinite(stop.lat) ? { ...stop, ...point } : stop);
    for (const via of extra?.vias ?? []) out.vias.push({ ...via, after: out.stops.length - 1 });
  });
  return out;
}

function fromApi(params) {
  const stops = [params.get('origin'), ...(params.get('waypoints') ?? '').split('|'), params.get('destination')].map((value) => (value ? stopOf(value) : null)).filter(Boolean);
  return { stops, vias: [], mode: TRAVEL[params.get('travelmode')] ?? null };
}

function fromLegacy(params) {
  const destinations = decode(params.get('daddr') ?? '').split(/\s+to:\s*/i);
  const stops = [params.get('saddr'), ...destinations].map((value) => (value ? stopOf(value) : null)).filter(Boolean);
  const dirflg = params.get('dirflg');
  return { stops, vias: [], mode: dirflg === 'w' ? 'walk' : dirflg === 'b' ? 'bike' : dirflg === 'r' ? 'transit' : dirflg === 'd' ? 'drive' : null };
}

function isGoogleMaps(url) {
  const host = url.hostname.toLowerCase();
  return /(^|\.)google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host) && (host.startsWith('maps.') || url.pathname.startsWith('/maps'));
}

/**
 * `{stops: [{name?, lat?, lng?}], vias: [{lat, lng, after}], mode}` for a directions link (2–25 stops), `{short: url}`
 * for a short link to follow, or null. `after` is the index of the stop a route point follows.
 */
export function parseRouteLink(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > 8192 || /\s/.test(text)) return null;
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (SHORT.has(host)) return url.pathname.length > 1 ? { short: url.href.replace(/^http:/, 'https:') } : null;
  if (/^consent\.google\./.test(host) && url.searchParams.has('continue')) return parseRouteLink(url.searchParams.get('continue'));
  if (!isGoogleMaps(url)) return null;
  const params = url.searchParams;
  const result = params.get('api') === '1' && (params.has('destination') || params.has('origin')) ? fromApi(params)
    : params.has('daddr') ? fromLegacy(params) : fromDirPath(url);
  if (!result || result.stops.length < 2) return null;
  const stops = result.stops.slice(0, MAX_STOPS);
  return { stops, vias: result.vias.filter((via) => via.after < stops.length - 1), mode: result.mode };
}

/** Follows a short link (at most three hops) with `puter.net.fetch`, reading only the `Location` header. */
export async function followRouteLink(url, fetch) {
  let current = url;
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await fetch(current, { method: 'GET' });
    const location = response?.headers?.get?.('location');
    if (!location) return null;
    let next;
    try { next = new URL(location, current).href; } catch { return null; }
    const found = parseRouteLink(next);
    if (!found?.short) return found;
    current = found.short;
  }
  return null;
}
