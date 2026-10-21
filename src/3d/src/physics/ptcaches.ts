// Several point caches per simulation (ptcache.add / ptcache.remove): a simulation keeps a list of
// caches, each with its own frame range and bake; one is active. Switching swaps the simulated
// frames in memory, so going back to a cache shows what it held.
import { app, registerOperators } from '../app/app';
import { caches, FrameCache } from './common';
import { cacheOwners, type CacheOwner } from './ops';
import { defaultPointCache, type PointCacheSettings } from './types';
import { freeRigidBodyLive, RB_CACHE } from './rigidbody';

export type NamedCache = PointCacheSettings & { name?: string };

/** The cache list of an owner (made on first use from its single cache). */
export function cacheList(holder: Record<string, unknown>): NamedCache[] {
  let l = holder.point_caches as NamedCache[] | undefined;
  if (!l || !l.length) {
    const pc = holder.point_cache as NamedCache;
    pc.name ??= 'Cache';
    l = holder.point_caches = [{ ...pc }];
    holder.point_cache_index = 0;
  }
  return l;
}

/** Frames of the caches that are not active, per `${cache key}#${slot}`. */
const stored = new Map<string, FrameCache<unknown, unknown>>();

function stash(key: string, slot: number) {
  const c = caches.get(key);
  if (!c) return;
  const copy = new FrameCache<unknown, unknown>();
  copy.hash = c.hash;
  copy.frames = new Map(c.frames);
  copy.last = c.last;
  copy.live = c.live;
  stored.set(`${key}#${slot}`, copy);
  // the live cache starts empty for the next slot (its live solver state moved with the frames)
  c.frames = new Map();
  c.live = null;
  c.last = -Infinity;
  c.hash = '';
}

function restore(key: string, slot: number) {
  const s = stored.get(`${key}#${slot}`);
  const c = caches.get(key);
  if (!c) return;
  if (s) {
    c.frames = s.frames;
    c.hash = s.hash;
    c.last = s.last;
    c.live = s.live;
    stored.delete(`${key}#${slot}`);
  } else c.reset('');
}

/** Make cache `to` of an owner the active one. */
export function switchCache(o: CacheOwner, to: number) {
  const h = o.holder;
  if (!h) return;
  const list = cacheList(h);
  const from = Math.min(list.length - 1, Math.max(0, (h.point_cache_index as number) ?? 0));
  if (to === from || to < 0 || to >= list.length) return;
  // keep the active cache's current settings in the list
  list[from] = { ...(h.point_cache as NamedCache) };
  if (o.key === RB_CACHE) freeRigidBodyLive();
  stash(o.key, from);
  restore(o.key, to);
  h.point_cache = { ...list[to] };
  h.point_cache_index = to;
}

const ownerOf = (key: string) => cacheOwners(app.doc).find((o) => o.key === key);

function uniqueCacheName(list: NamedCache[]): string {
  const names = new Set(list.map((c) => c.name));
  if (!names.has('Cache')) return 'Cache';
  for (let i = 1; ; i++) {
    const n = `Cache.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

registerOperators([
  {
    idname: 'ptcache.add',
    label: 'Add Point Cache',
    description: 'Add a point cache to the simulation (and make it the active one)',
    props: [{ id: 'cache', label: 'Cache', type: 'string', default: '', hidden: true }],
    poll: () => cacheOwners(app.doc).some((o) => !!o.holder),
    exec: (ctx, p) => {
      const o = ownerOf(String(p.cache)) ?? cacheOwners(ctx.doc).find((x) => !!x.holder);
      if (!o?.holder) return 'CANCELLED';
      const list = cacheList(o.holder);
      const pc = o.holder.point_cache as NamedCache;
      list.push({ ...defaultPointCache(pc.frame_start, pc.frame_end), name: uniqueCacheName(list) });
      switchCache(o, list.length - 1);
      app.changed('frame');
    },
  },
  {
    idname: 'ptcache.remove',
    label: 'Delete Current Cache',
    description: 'Delete the active point cache of the simulation',
    props: [{ id: 'cache', label: 'Cache', type: 'string', default: '', hidden: true }],
    poll: () => cacheOwners(app.doc).some((o) => !!o.holder && ((o.holder.point_caches as unknown[] | undefined)?.length ?? 1) > 1),
    exec: (ctx, p) => {
      const o = ownerOf(String(p.cache)) ?? cacheOwners(ctx.doc).find((x) => !!x.holder && ((x.holder.point_caches as unknown[] | undefined)?.length ?? 1) > 1);
      if (!o?.holder) return 'CANCELLED';
      const list = cacheList(o.holder);
      if (list.length < 2) return 'CANCELLED';
      const i = (o.holder.point_cache_index as number) ?? 0;
      const to = i > 0 ? i - 1 : 1;
      switchCache(o, to);
      // drop the removed slot; slots after it move down one
      list.splice(i, 1);
      stored.delete(`${o.key}#${i}`);
      for (let k = i + 1; k <= list.length; k++) {
        const s = stored.get(`${o.key}#${k}`);
        stored.delete(`${o.key}#${k}`);
        if (s) stored.set(`${o.key}#${k - 1}`, s);
      }
      o.holder.point_cache_index = to > i ? to - 1 : to;
      app.changed('frame');
    },
  },
]);
