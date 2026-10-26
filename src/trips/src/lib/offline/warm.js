import { openSpaceStore } from '../store/space.js';
import { feedKey } from '../store/feed.js';
import { createPathA, handleFailure, spaceScope } from '../sync/path-a.js';
import { createPathC } from '../sync/path-c.js';

// The space store keeps one IndexedDB record per space under this key (src/lib/store/space.js).
export const replicaKey = (ref) => `space:${ref.w}:${ref.s}`;
const point = (lat, lng) => (Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null);

/** Map points of a trip: places and booking locations for the overview, plus booking endpoints for detail. */
export function tripPoints(entities) {
  const overview = [];
  const detail = [];
  for (const place of entities('place')) { const p = point(place.lat, place.lng); if (p) overview.push(p); }
  for (const res of entities('res')) {
    if (res.status === 'cancelled') continue;
    const p = point(res.location?.lat, res.location?.lng);
    if (p) overview.push(p);
    for (const leg of Array.isArray(res.legs) ? res.legs : []) for (const end of [leg?.from, leg?.to]) { const q = point(end?.lat, end?.lng); if (q) detail.push(q); }
  }
  return { overview, detail: [...overview, ...detail] };
}

function summary(state) {
  const confirmed = state?.confirmed && typeof state.confirmed === 'object' ? state.confirmed : {};
  const entities = (type) => Object.entries(confirmed).filter(([key, entity]) => key.startsWith(`${type}:`) && !entity?.deleted).map(([, entity]) => entity);
  return {
    loaded: Boolean(state), rev: state?.rev ?? 0, pending: Array.isArray(state?.pending) ? state.pending.length : 0,
    conflicts: Array.isArray(state?.conflicts) ? state.conflicts : [], meta: confirmed['meta:meta'] ?? null,
    files: entities('file'), points: tripPoints(entities),
  };
}

/** Reads a replica record without building the store's views: counts, dates, points and files. */
export async function readReplica({ ref, db, size = false }) {
  const state = await db.get(replicaKey(ref));
  const result = summary(state);
  if (size) result.bytes = state ? new Blob([JSON.stringify(state)]).size : 0;
  return result;
}

/**
 * One background pull and flush of a space replica, without presence or a polling engine: path A through the owner's
 * KV or a read handle, falling back to path C as `openSpace` does.
 */
export async function warmSpace({ ref, db, api, puter, handles = null, ownWorker = null, signal }) {
  const uid = db.account;
  const store = await openSpaceStore({ ref, db, api, uid });
  const active = () => !signal?.aborted;
  try {
    const owner = ref.w === ownWorker;
    const pathC = () => createPathC({ store, api, uid });
    let adapter = owner ? createPathA({ store, puter, uid, scope: spaceScope(puter, { prefix: `shared:${ref.s}:` }) })
      : typeof handles?.read === 'string' ? createPathA({ store, puter, uid, scope: spaceScope(puter, { handle: handles.read }) }) : pathC();
    let outcome;
    try { outcome = await adapter.pull(active); }
    catch (error) {
      const kind = adapter.name === 'A' ? handleFailure(error) : null;
      if (!(kind === 'credit' || (kind === 'handle' && !owner))) throw error;
      adapter = pathC();
      outcome = await adapter.pull(active);
    }
    let flushed = null;
    for (let round = 0; active() && store.pending.length && round < 8; round++) {
      flushed = await store.flush();
      if (flushed.status !== 'sent' && !flushed.retry && !['conflict', 'rejected'].includes(flushed.status)) break;
    }
    return { behind: Boolean(outcome?.behind), error: flushed?.status === 'queued' ? flushed.error ?? null : null };
  } finally { store.close(); }
}

/** Drops a replica and its activity feed unless it holds unsent writes or conflicts. Resolves true when removed. */
export async function evictReplica({ ref, db }) {
  let removed = false;
  await db.update(replicaKey(ref), (state) => {
    if (!state) return undefined;
    if (state.pending?.length || state.batch || state.conflicts?.length) return state;
    removed = true;
    return undefined;
  });
  if (removed) await db.remove(feedKey(ref));
  return removed;
}
