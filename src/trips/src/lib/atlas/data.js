// Atlas inputs: the `me:spaces` index, each trip's local replica, `heads` for fresher dates, and `me:atlas` marks.
import { loadHeads } from '../heads.js';
import { replicaKey } from '../offline/warm.js';
import { isDate } from '../../shared/dates.js';
import { countryCode } from './countries.js';
import { reservationStops } from './aggregate.js';
import { isRegionCode } from './regions.js';

export { loadCountries } from './boundaries.js';

export const MARKS_KEY = 'me:atlas';
const TYPES = new Set(['meta', 'place', 'res']);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const refKey = (ref) => `${ref.w}:${ref.s}`;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

// Lenient path patch for display; the store validates the same ops before they are queued.
function patched(entity, { set = {}, unset = [] }) {
  const data = structuredClone(entity);
  const walk = (path, create) => {
    const segments = String(path).split('.');
    if (segments.some((segment) => !segment || UNSAFE.has(segment))) return null;
    let parent = data;
    for (const segment of segments.slice(0, -1)) {
      if (!plain(parent[segment])) { if (!create) return null; parent[segment] = {}; }
      parent = parent[segment];
    }
    return [parent, segments.at(-1)];
  };
  for (const [path, value] of Object.entries(plain(set) ? set : {})) { const target = walk(path, true); if (target) target[0][target[1]] = structuredClone(value); }
  for (const path of Array.isArray(unset) ? unset : []) { const target = walk(path, false); if (target) delete target[0][target[1]]; }
  return data;
}

/**
 * Meta, places and reservations from a replica record, with this device's queued edits applied (so places marked
 * visited offline count). Null when the trip was never opened here.
 */
export function replicaEntities(record) {
  if (!plain(record?.confirmed)) return null;
  const entities = new Map();
  for (const [key, entity] of Object.entries(record.confirmed)) {
    const type = key.slice(0, key.indexOf(':'));
    if (TYPES.has(type) && plain(entity) && !entity.deleted) entities.set(key, entity);
  }
  for (const entry of Array.isArray(record.pending) ? record.pending : []) {
    const effects = entry?.effects ?? (entry?.op?.do ? [] : [entry?.op]);
    for (const effect of effects) {
      if (!plain(effect) || !TYPES.has(effect.t) || typeof effect.id !== 'string') continue;
      const key = `${effect.t}:${effect.id}`;
      if (effect.del) entities.delete(key);
      else if (plain(effect.put)) entities.set(key, { ...effect.put, id: effect.id });
      else if (entities.has(key)) entities.set(key, patched(entities.get(key), effect));
    }
  }
  const of = (type) => [...entities].filter(([key]) => key.startsWith(`${type}:`)).map(([, entity]) => entity);
  return { rev: Number.isSafeInteger(record.rev) ? record.rev : 0, meta: entities.get('meta:meta') ?? null, places: of('place'), res: of('res') };
}

/** One atlas trip from its index entry, replica and (when newer than the replica) its head. */
export function tripInput(entry, replica, head = null) {
  const fromHead = head && (!replica || head.rev > replica.rev);
  const meta = replica?.meta ?? {};
  const pick = (field) => {
    const value = fromHead ? head[field] : meta[field] !== undefined ? meta[field] : entry[field];
    return isDate(value) ? value : null;
  };
  return {
    key: refKey(entry.ref), ref: entry.ref, role: head?.role ?? entry.role,
    title: (fromHead ? head.title : meta.title) || entry.title || '',
    start: pick('start'), end: pick('end'), archived: Boolean(meta.archived),
    cached: Boolean(replica), places: replica?.places ?? [], res: replica?.res ?? [],
  };
}

/** Index entries and replicas of every trip; local only. */
export async function loadTrips({ personal, db }) {
  const entries = (await personal.spaces.list()).filter((entry) => entry.ref.k === 'trip');
  const replicas = db ? await Promise.all(entries.map((entry) => db.get(replicaKey(entry.ref)).then(replicaEntities, () => null))) : entries.map(() => null);
  return entries.map((entry, index) => ({ entry, replica: replicas[index] }));
}

/** Batched `heads` per worker; `Map<'w:s', head>`. Unreachable workers are left out. */
export async function loadTripHeads(items, { api, signal }) {
  if (!api || !items.length) return new Map();
  const { heads } = await loadHeads(items.map((item) => item.entry.ref), { api, signal });
  return new Map(heads.map((head) => [refKey(head.ref), head]));
}

/** `{visited: {cc: src}, hidden: {cc: true}, regions: {code: src}}` with unknown codes and values dropped. */
export function normalizeMarks(value) {
  const out = { visited: {}, hidden: {}, regions: {} };
  if (!plain(value)) return out;
  for (const [code, src] of Object.entries(plain(value.visited) ? value.visited : {})) if (countryCode(code) === code && typeof src === 'string') out.visited[code] = src;
  for (const [code, flag] of Object.entries(plain(value.hidden) ? value.hidden : {})) if (countryCode(code) === code && flag === true) out.hidden[code] = true;
  for (const [code, src] of Object.entries(plain(value.regions) ? value.regions : {})) if (isRegionCode(code) && typeof src === 'string') out.regions[code] = src;
  return out;
}

const validMark = (group, code) => (group === 'regions' ? isRegionCode(code) : ['visited', 'hidden'].includes(group) && countryCode(code) === code);

/**
 * Path writes on `me:atlas` (`visited.<cc>`, `hidden.<cc>`, `regions.<code>`), so two devices marking different
 * countries never overwrite each other. `changes` maps a path to a value, or to null to remove it. Resolves the new
 * marks.
 */
export async function writeMarks({ puter, personal, changes }) {
  const set = {}; const remove = [];
  for (const [path, value] of Object.entries(changes)) {
    const [group, code, extra] = path.split('.');
    if (extra !== undefined || !validMark(group, code)) throw new RangeError('Invalid atlas mark');
    if (value === null) remove.push(path); else set[path] = value;
  }
  let value;
  if (Object.keys(set).length) value = await puter.kv.update(MARKS_KEY, set);
  if (remove.length) value = await puter.kv.remove(MARKS_KEY, ...remove);
  // Refresh the personal cache (and its subscribers) from the cloud; the write already succeeded.
  const fresh = await personal.refresh(MARKS_KEY).catch(() => undefined);
  return normalizeMarks(fresh ?? value);
}

const IATA = /^[A-Za-z]{3}$/;
/**
 * Airport rows (`{country, lat, lng, name}`) through the airports service, for IATA codes on transport stops without
 * coordinates (to place them in a country) and on flight legs without coordinates (for distance flown).
 */
export async function airportRows(trips, airports, { signal } = {}) {
  const codes = new Set();
  const want = (stop) => { if (!Number.isFinite(stop?.lat) && typeof stop?.code === 'string' && IATA.test(stop.code)) codes.add(stop.code.toUpperCase()); };
  for (const trip of trips) {
    for (const res of trip.res) {
      for (const stop of reservationStops(res)) if (!countryCode(stop.cc)) want(stop);
      if (res?.type === 'flight' && Array.isArray(res.legs)) for (const leg of res.legs) { want(leg?.from); want(leg?.to); }
    }
  }
  const out = new Map();
  if (!codes.size || typeof airports?.byCode !== 'function') return out;
  for (const code of codes) {
    const row = await airports.byCode(code, { signal }).catch(() => null);
    if (row && Number.isFinite(row.lat) && Number.isFinite(row.lng)) out.set(code, { country: countryCode(row.country), lat: row.lat, lng: row.lng, name: row.name ?? code });
  }
  return out;
}
