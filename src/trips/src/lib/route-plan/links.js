// Deep links into external map apps. Points are `[lng, lat]`; names are optional labels.

const GOOGLE_MODES = { walk: 'walking', drive: 'driving', bike: 'bicycling', transit: 'transit' };
const APPLE_MODES = { walk: 'w', drive: 'd', transit: 'r' };
const COMAPS_MODES = { walk: 'pedestrian', drive: 'vehicle', bike: 'bicycle', transit: 'transit' };
// Google Maps URLs accept at most 9 waypoints between origin and destination.
export const GOOGLE_MAX_WAYPOINTS = 9;

const number = (value) => String(Number(value.toFixed(6)));
const latLng = ([lng, lat]) => `${number(lat)},${number(lng)}`;
const valid = (point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90 && Math.abs(point[0]) <= 180;
const label = (value) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '');

function url(base, params) {
  const target = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') target.searchParams.set(key, value);
  return target.href;
}

/** Google Maps directions through up to 11 points; `truncated` when later stops were dropped. */
export function googleDirections(points, mode = 'walk') {
  const list = points.filter(valid);
  if (list.length < 2) return null;
  const middle = list.slice(1, -1);
  const kept = mode === 'transit' ? [] : middle.slice(0, GOOGLE_MAX_WAYPOINTS);
  return {
    url: url('https://www.google.com/maps/dir/', { api: '1', origin: latLng(list[0]), destination: latLng(list.at(-1)), waypoints: kept.map(latLng).join('|'), travelmode: GOOGLE_MODES[mode] ?? 'walking' }),
    truncated: kept.length < middle.length,
  };
}

/** Apple Maps directions between two points (Apple Maps links take no waypoints). */
export function appleDirections(from, to, mode = 'walk') {
  if (!valid(from) || !valid(to)) return null;
  return url('https://maps.apple.com/', { saddr: latLng(from), daddr: latLng(to), dirflg: APPLE_MODES[mode] });
}

/** CoMaps route between two points, through the app's `cm://` link scheme (route links take no waypoints). */
export function comapsRoute(from, to, mode = 'walk', { fromName, toName } = {}) {
  if (!valid(from) || !valid(to)) return null;
  const params = new URLSearchParams({ sll: latLng(from), saddr: label(fromName) || latLng(from), dll: latLng(to), daddr: label(toName) || latLng(to), type: COMAPS_MODES[mode] ?? 'pedestrian' });
  return `cm://route?${params}`;
}

export function googlePlace(point, name) {
  if (!valid(point)) return null;
  return url('https://www.google.com/maps/search/', { api: '1', query: label(name) ? `${label(name)} ${latLng(point)}` : latLng(point) });
}
export function applePlace(point, name) {
  if (!valid(point)) return null;
  return url('https://maps.apple.com/', { ll: latLng(point), q: label(name) || latLng(point) });
}
export function comapsPlace(point, name) {
  if (!valid(point)) return null;
  const params = new URLSearchParams({ v: '1', ll: latLng(point), n: label(name) || latLng(point) });
  return `cm://map?${params}`;
}

/** Day export links from a day's planned points `[{point, name}]` (start stay first, end stay last). */
export function dayLinks(points, mode = 'walk') {
  const located = points.filter((entry) => valid(entry.point));
  if (located.length < 2) return null;
  const first = located[0]; const last = located.at(-1);
  return {
    google: googleDirections(located.map((entry) => entry.point), mode),
    apple: appleDirections(first.point, last.point, mode),
    comaps: comapsRoute(first.point, last.point, mode, { fromName: first.name, toName: last.name }),
  };
}

/** Public transit directions for one leg. */
export function transitLinks(from, to) {
  if (!valid(from) || !valid(to)) return null;
  return { google: googleDirections([from, to], 'transit')?.url ?? null, apple: appleDirections(from, to, 'transit') };
}
