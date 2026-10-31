// Dawarich: the user's location history on their own server (bearer key). Detected stays ("visits") become
// suggestions the user accepts or dismisses; recorded points give a day's trail for the map.
import { addDays, isDate, isTimeZone, zonedInstant, zonedParts } from '../../shared/dates.js';
import { lngLatMeters } from '../../shared/geo.js';
import { createClient, serverTag } from './client.js';
import { IntegrationError } from './errors.js';

const SERVICE = 'dawarich';
export const DAWARICH_KEY = 'me:dawarich';
export const REVIEW_MAX = 2000;
const POINTS_PAGE = 1000;
const POINTS_PAGES = 10;
const TRAIL_MAX = 5000;
const GAP_MS = 30 * 60_000;
const ID = /^[A-Za-z0-9-]{1,40}$/;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value) => { const out = typeof value === 'string' && value.trim() ? Number(value) : value; return typeof out === 'number' && Number.isFinite(out) ? out : undefined; };
const text = (value, max = 500) => (typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : undefined);

export function dawarichClient(puter, config) {
  if (!config?.url || !config?.key) throw new IntegrationError('not_configured', { service: SERVICE });
  const client = createClient({ puter, url: config.url, service: SERVICE, headers: { authorization: `Bearer ${config.key}` } });
  // Older servers read the key only from the query string; it is added after a 401, never up front.
  return {
    ...client,
    async request(path, options = {}) {
      try { return await client.request(path, options); } catch (error) {
        if (error.code !== 'unauthorized') throw error;
        return client.request(path, { ...options, query: { ...options.query, api_key: config.key } });
      }
    },
  };
}

/** Checks the URL and key: `{user: {id, email}}`, or `{user: null}` on servers without `/users/me`. */
export async function verifyDawarich(client, { signal } = {}) {
  try {
    const { data } = await client.request('/api/v1/users/me', { signal });
    const user = data?.user ?? data;
    if (!plain(user) || user.id == null) throw new IntegrationError('bad_response', { service: SERVICE });
    return { user: { id: String(user.id), email: text(user.email, 200) ?? '' } };
  } catch (error) { if (error.code !== 'not_found') throw error; }
  await client.request('/api/v1/points', { query: { per_page: 1 }, signal });
  return { user: null };
}

/** A detected stay: `{id, name, status, start, end, minutes, lat, lng, city, country}`, or null. Declined ones are dropped. */
export function stayFromVisit(visit) {
  if (!plain(visit) || visit.id == null || !ID.test(String(visit.id)) || visit.status === 'declined') return null;
  const start = Date.parse(visit.started_at); const end = Date.parse(visit.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const place = plain(visit.place) ? visit.place : {};
  const lat = number(place.latitude ?? place.lat); const lng = number(place.longitude ?? place.lng);
  const located = lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const minutes = Number.isSafeInteger(visit.duration) && visit.duration >= 0 ? visit.duration : Math.round((end - start) / 60_000);
  return {
    id: String(visit.id), name: text(visit.name) ?? text(place.name) ?? '', status: ['suggested', 'confirmed'].includes(visit.status) ? visit.status : 'suggested',
    start, end, minutes, lat: located ? lat : null, lng: located ? lng : null, city: text(place.city, 200) ?? null, country: text(place.country, 200) ?? null,
  };
}

/** Stays from `from` to `to` (dates, inclusive, with a day of slack each side for time zones), oldest first. */
export async function listStays(client, { from, to, signal } = {}) {
  if (!isDate(from) || !isDate(to) || to < from) throw new IntegrationError('rejected', { service: SERVICE });
  const { data } = await client.request('/api/v1/visits', { query: { start_at: `${addDays(from, -1)}T00:00:00Z`, end_at: `${addDays(to, 2)}T00:00:00Z` }, signal });
  if (!Array.isArray(data)) throw new IntegrationError('bad_response', { service: SERVICE });
  return data.map(stayFromVisit).filter(Boolean).sort((a, b) => a.start - b.start);
}

/** The local date and time of an instant in `zone`. */
export const localParts = (epoch, zone) => zonedParts(Math.round(epoch), isTimeZone(zone) ? zone : 'UTC');

/**
 * Recorded points as line segments of `[lng, lat]`: inaccurate fixes dropped, points closer than `minMeters` to the
 * last kept one skipped, a new segment after a gap of 30 minutes, and at most 5,000 positions in all.
 */
export function trailFromPoints(points, { minMeters = 15, maxAccuracy = 250 } = {}) {
  const fixes = [];
  for (const point of Array.isArray(points) ? points : []) {
    if (!plain(point)) continue;
    const lat = number(point.latitude ?? point.lat); const lng = number(point.longitude ?? point.lon ?? point.lng);
    const at = number(point.timestamp);
    const accuracy = number(point.accuracy);
    if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180 || at === undefined) continue;
    if (accuracy !== undefined && accuracy > maxAccuracy) continue;
    fixes.push({ at: at < 1e12 ? at * 1000 : at, position: [lng, lat] });
  }
  fixes.sort((a, b) => a.at - b.at);
  const segments = [];
  let current = null; let last = null;
  for (const fix of fixes) {
    if (!current || fix.at - last.at > GAP_MS) { current = [fix.position]; segments.push(current); last = fix; continue; }
    if (lngLatMeters(last.position, fix.position) < minMeters) continue;
    current.push(fix.position); last = fix;
  }
  let lines = segments.filter((segment) => segment.length > 1);
  const count = lines.reduce((sum, segment) => sum + segment.length, 0);
  if (count > TRAIL_MAX) {
    const step = Math.ceil(count / TRAIL_MAX);
    lines = lines.map((segment) => segment.filter((_, index) => index % step === 0 || index === segment.length - 1)).filter((segment) => segment.length > 1);
  }
  return { segments: lines, count: lines.reduce((sum, segment) => sum + segment.length, 0) };
}

// A few zones skip midnight on DST days; the day then starts at 01:00.
function midnight(date, zone) {
  try { return zonedInstant(date, '00:00', zone, { disambiguation: 'earlier' }); } catch { return zonedInstant(date, '01:00', zone, { disambiguation: 'earlier' }); }
}

/** The recorded trail of one local day in `zone`: `{segments, count, truncated}`. */
export async function dayTrail(client, { date, zone, signal } = {}) {
  if (!isDate(date)) throw new IntegrationError('rejected', { service: SERVICE });
  const tz = isTimeZone(zone) ? zone : 'UTC';
  const start = midnight(date, tz);
  const end = midnight(addDays(date, 1), tz);
  const points = [];
  let truncated = true;
  for (let page = 1; page <= POINTS_PAGES; page += 1) {
    const { data, headers } = await client.request('/api/v1/points', {
      query: { start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString(), page, per_page: POINTS_PAGE, order: 'asc' }, signal,
    });
    if (!Array.isArray(data)) throw new IntegrationError('bad_response', { service: SERVICE });
    points.push(...data);
    const pages = Number(headers?.get?.('x-total-pages'));
    if (data.length < POINTS_PAGE || (Number.isFinite(pages) && page >= pages)) { truncated = false; break; }
  }
  return { ...trailFromPoints(points), truncated };
}

// ---- Review state in `me:dawarich` (data-model §4)

/** The `me:dawarich` key for one stay on one server, or null when the id cannot be a KV path segment. */
export const reviewKey = (url, stayId) => (ID.test(String(stayId)) ? `${serverTag(url)}_${stayId}` : null);

/** `Map<key, {s: accepted|dismissed, at, trip?}>` from the stored value; malformed entries are skipped. */
export function readReview(value) {
  const out = new Map();
  const reviewed = plain(value) && plain(value.reviewed) ? value.reviewed : {};
  for (const [key, entry] of Object.entries(reviewed)) {
    if (!/^[0-9a-f]{8}_[A-Za-z0-9-]{1,40}$/.test(key) || !plain(entry) || !['accepted', 'dismissed'].includes(entry.s) || !Number.isSafeInteger(entry.at)) continue;
    out.set(key, { s: entry.s, at: entry.at, ...(typeof entry.trip === 'string' && entry.trip.length <= 64 ? { trip: entry.trip } : {}) });
  }
  return out;
}

/**
 * Records review decisions with one path write per stay; `state: null` restores a stay. Drops the oldest entries
 * beyond 2,000. `current` is the review map the caller already holds. Resolves the new map.
 */
export async function writeReview(puter, changes, { current = new Map(), now = Date.now(), personal = null } = {}) {
  const set = {}; const remove = [];
  const next = new Map(current);
  for (const { key, state, trip } of changes) {
    if (!/^[0-9a-f]{8}_[A-Za-z0-9-]{1,40}$/.test(String(key))) throw new IntegrationError('rejected');
    if (state === null) { remove.push(`reviewed.${key}`); next.delete(key); continue; }
    if (!['accepted', 'dismissed'].includes(state)) throw new IntegrationError('rejected');
    const entry = { s: state, at: now, ...(trip ? { trip: String(trip).slice(0, 64) } : {}) };
    set[`reviewed.${key}`] = entry; next.set(key, entry);
  }
  const overflow = [...next.entries()].filter(([key]) => !Object.hasOwn(set, `reviewed.${key}`)).sort((a, b) => a[1].at - b[1].at).slice(0, Math.max(0, next.size - REVIEW_MAX));
  for (const [key] of overflow) { remove.push(`reviewed.${key}`); next.delete(key); }
  if (Object.keys(set).length) await puter.kv.update(DAWARICH_KEY, set);
  if (remove.length) await puter.kv.remove(DAWARICH_KEY, ...remove);
  if (personal?.refresh) await personal.refresh(DAWARICH_KEY).catch(() => {});
  return next;
}
