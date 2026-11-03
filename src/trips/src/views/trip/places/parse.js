// Reads a location from pasted text: "lat, lng" in decimal or DMS, or a Google Maps, OSM, Apple Maps, Waze or geo: link.
// Returns {lat, lng, name?}, {query, name?} (a link that only names a place), {short: url} (to follow) or null.

const NUM = (digits) => `(\\d{1,${digits}}(?:\\.\\d+)?)(?![\\d.])`;
const PART = `([NSEW])?\\s*([-+])?${NUM(3)}\\s*(°|º|deg)?\\s*(?:${NUM(2)}\\s*')?\\s*(?:${NUM(2)}\\s*(?:"|''))?\\s*([NSEW])?`;
const PAIR = new RegExp(`^\\(?\\s*${PART}\\s*(?:[,;]\\s*|\\s+)${PART}\\s*\\)?$`, 'i');
const NAME_MAX = 200;

function component([before, sign, deg, mark, min, sec, after]) {
  const hemisphere = (before || after || '').toUpperCase();
  if (before && after) return null;
  if ((min || sec) && deg.includes('.')) return null;
  if (sec && !min) return null;
  const minutes = min ? Number(min) : 0;
  const seconds = sec ? Number(sec) : 0;
  if (minutes >= 60 || seconds >= 60) return null;
  let value = Number(deg) + minutes / 60 + seconds / 3600;
  if (sign === '-' || hemisphere === 'S' || hemisphere === 'W') {
    if (sign === '-' && (hemisphere === 'S' || hemisphere === 'W')) return null;
    value = -value;
  }
  return { value, hemisphere, precise: Boolean(mark || min || sec || hemisphere || deg.includes('.')) };
}

const round = (value) => Math.round(value * 1e6) / 1e6;
const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** "48.8584, 2.2945", "48.8584 2.2945", "48°51'30.2\"N 2°17'40.2\"E", "S 33.86 E 151.21". */
export function parseCoordinates(input) {
  if (typeof input !== 'string' || input.length > 120) return null;
  const text = input.trim().replace(/[′’‘]/g, "'").replace(/[″“”]/g, '"');
  const match = PAIR.exec(text);
  if (!match) return null;
  const a = component(match.slice(1, 8));
  const b = component(match.slice(8, 15));
  if (!a || !b || !(a.precise || b.precise)) return null;
  const latFirst = !['E', 'W'].includes(a.hemisphere) && !['N', 'S'].includes(b.hemisphere);
  const lngFirst = ['E', 'W'].includes(a.hemisphere) && !['E', 'W'].includes(b.hemisphere);
  if (!latFirst && !lngFirst) return null;
  const [lat, lng] = latFirst ? [a.value, b.value] : [b.value, a.value];
  return valid(lat, lng) ? { lat: round(lat), lng: round(lng) } : null;
}

function decode(value) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\+/g, ' ');
  try { text = decodeURIComponent(text); } catch { /* keep the raw text */ }
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}
const withName = (place, name) => (name ? { ...place, name } : place);

/** A query value that is itself coordinates (`q=48.85,2.29`) or a label `48.85,2.29(Tower)`. */
function coordinatesIn(value) {
  const text = decode(value);
  const label = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(text);
  const coords = parseCoordinates(label ? label[1] : text);
  return coords ? withName(coords, label ? decode(label[2]) : '') : null;
}

function isGoogle(url) {
  const host = url.hostname.toLowerCase();
  if (!/(^|\.)google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host)) return false;
  return host.startsWith('maps.') || url.pathname.startsWith('/maps');
}

function google(url) {
  const href = url.href;
  const params = url.searchParams;
  // `!3d…!4d…` is the dropped pin; `@lat,lng` is only the viewport centre.
  const pin = /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/.exec(href);
  const segments = url.pathname.split('/').filter(Boolean);
  const placeIndex = segments.indexOf('place');
  const pathName = placeIndex >= 0 && segments[placeIndex + 1] && !segments[placeIndex + 1].startsWith('@') ? decode(segments[placeIndex + 1]) : '';
  const name = pathName && !parseCoordinates(pathName) ? pathName : '';
  if (pin && valid(Number(pin[1]), Number(pin[2]))) return withName({ lat: round(Number(pin[1])), lng: round(Number(pin[2])) }, name);
  for (const key of ['q', 'query', 'destination', 'daddr', 'll', 'center', 'sll']) {
    const coords = params.has(key) && coordinatesIn(params.get(key));
    if (coords) return withName(coords, coords.name || name || (['ll', 'center', 'sll'].includes(key) ? decode(params.get('q') ?? '') : ''));
  }
  if (pathName && parseCoordinates(pathName)) return parseCoordinates(pathName);
  const text = ['q', 'query', 'destination', 'daddr'].map((key) => decode(params.get(key) ?? '')).find(Boolean);
  if (text) return { query: text };
  // A search or directions link names its target in the path; its `@` is only where the map was looking.
  const searchIndex = segments.indexOf('search');
  const dirIndex = segments.indexOf('dir');
  const target = searchIndex >= 0 ? segments[searchIndex + 1]
    : dirIndex >= 0 ? segments.slice(dirIndex + 1).filter((segment) => !segment.startsWith('@') && !segment.startsWith('data=')).at(-1) : undefined;
  if (target && !target.startsWith('@')) return coordinatesIn(target) ?? { query: decode(target) };
  const at = /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(url.pathname);
  if (at && valid(Number(at[1]), Number(at[2]))) return withName({ lat: round(Number(at[1])), lng: round(Number(at[2])) }, name);
  return name ? { query: name } : null;
}

function osm(url) {
  const params = url.searchParams;
  const mlat = Number(params.get('mlat'));
  const mlon = Number(params.get('mlon'));
  if (params.has('mlat') && params.has('mlon') && valid(mlat, mlon)) return { lat: round(mlat), lng: round(mlon) };
  const map = /(?:^|&|#)map=\d{1,2}\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)/.exec(url.hash);
  if (map && valid(Number(map[1]), Number(map[2]))) return { lat: round(Number(map[1])), lng: round(Number(map[2])) };
  const query = decode(params.get('query') ?? '');
  if (query) return coordinatesIn(query) ?? { query };
  return null;
}

function apple(url) {
  const params = url.searchParams;
  const name = decode(params.get('name') ?? '') || decode(params.get('q') ?? '');
  for (const key of ['coordinate', 'll', 'sll', 'daddr']) {
    const coords = params.has(key) && coordinatesIn(params.get(key));
    if (coords) return withName(coords, coords.name || name);
  }
  const query = name || decode(params.get('address') ?? '');
  return query ? (coordinatesIn(query) ?? { query }) : null;
}

function waze(url) {
  const params = url.searchParams;
  const ll = params.get('ll') ?? params.get('to')?.replace(/^ll\./, '') ?? '';
  const coords = coordinatesIn(ll);
  if (coords) return coords;
  const query = decode(params.get('q') ?? '');
  return query ? { query } : null;
}

function geoUri(text) {
  const match = /^geo:(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,[-\d.]+)?(?:;[^?]*)?(?:\?(.*))?$/i.exec(text);
  if (!match) return null;
  const params = new URLSearchParams(match[3] ?? '');
  const fromQuery = params.has('q') ? coordinatesIn(params.get('q')) : null;
  if (fromQuery) return fromQuery;
  const lat = Number(match[1]); const lng = Number(match[2]);
  if (lat === 0 && lng === 0) return params.has('q') ? { query: decode(params.get('q')) } : null;
  return valid(lat, lng) ? withName({ lat: round(lat), lng: round(lng) }, decode(params.get('q') ?? '')) : null;
}

const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl']);

/** Map links Trips may follow with `puter.net.fetch`: only Google's short link hosts. */
export function isShortLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !SHORT_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    return parsed.hostname.toLowerCase() === 'maps.app.goo.gl' ? parsed.pathname.length > 1 : parsed.pathname.startsWith('/maps/');
  } catch { return false; }
}

export function parseLocation(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > 4096) return null;
  const coords = parseCoordinates(text);
  if (coords) return coords;
  if (/^geo:/i.test(text)) return geoUri(text);
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || /\s/.test(text)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (isShortLink(url.href.replace(/^http:/, 'https:'))) return { short: url.href.replace(/^http:/, 'https:') };
  if (/^consent\.google\./.test(host) && url.searchParams.has('continue')) return parseLocation(url.searchParams.get('continue'));
  if (isGoogle(url)) return google(url);
  if (host === 'openstreetmap.org' || host === 'osm.org') return osm(url);
  if (host === 'maps.apple.com') return apple(url);
  if (host === 'waze.com' || host === 'ul.waze.com') return waze(url);
  return null;
}

/**
 * Follows a short map link up to three hops. `fetch` is `puter.net.fetch`, which does not follow redirects,
 * so only the `Location` header is read; the page body is never parsed.
 */
export async function followShortLink(url, fetch) {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const response = await fetch(current, { method: 'GET' });
    const location = response?.headers?.get?.('location');
    if (!location) return null;
    let next;
    try { next = new URL(location, current).href; } catch { return null; }
    const found = parseLocation(next);
    if (!found?.short) return found;
    current = found.short;
  }
  return null;
}
