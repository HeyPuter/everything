// Trip data from this device's replicas, without opening spaces or touching the network.
import { replicaKey } from '../offline/warm.js';

export const TRIP_TYPES = Object.freeze(['meta', 'day', 'visit', 'place', 'res', 'todo', 'listMeta', 'dayNote']);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

// Lenient path patch for display; the store validated the same ops before queueing them.
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
 * `{rev, meta, day: [], visit: [], …}` from a replica record (`{confirmed, pending}`), with this device's queued edits
 * applied. Null when the trip was never opened here.
 */
export function replicaData(record, types = TRIP_TYPES) {
  if (!plain(record?.confirmed)) return null;
  const wanted = new Set(types);
  const entities = new Map();
  for (const [key, entity] of Object.entries(record.confirmed)) {
    if (wanted.has(key.slice(0, key.indexOf(':'))) && plain(entity) && !entity.deleted) entities.set(key, entity);
  }
  for (const entry of Array.isArray(record.pending) ? record.pending : []) {
    const effects = entry?.effects ?? (entry?.op?.do ? [] : [entry?.op]);
    for (const effect of effects) {
      if (!plain(effect) || !wanted.has(effect.t) || typeof effect.id !== 'string') continue;
      const key = `${effect.t}:${effect.id}`;
      if (effect.del) entities.delete(key);
      else if (plain(effect.put)) entities.set(key, { ...effect.put, id: effect.id });
      else if (entities.has(key)) entities.set(key, patched(entities.get(key), effect));
    }
  }
  const data = { rev: Number.isSafeInteger(record.rev) ? record.rev : 0, meta: entities.get('meta:meta') ?? null };
  for (const type of types) if (type !== 'meta') data[type] = [];
  for (const [key, entity] of entities) {
    const type = key.slice(0, key.indexOf(':'));
    if (type !== 'meta') data[type].push({ ...entity, id: entity.id ?? key.slice(type.length + 1) });
  }
  return data;
}

/** Every trip in `me:spaces` with its replica data (null when not on this device). `keep(entry)` filters first. */
export async function loadTrips({ personal, db, keep = () => true, types = TRIP_TYPES }) {
  const entries = (await personal.spaces.list()).filter((entry) => entry?.ref?.k === 'trip' && keep(entry));
  const records = db ? await Promise.all(entries.map((entry) => db.get(replicaKey(entry.ref)).catch(() => null))) : entries.map(() => null);
  return entries.map((entry, index) => ({ entry, data: replicaData(records[index], types) }));
}
