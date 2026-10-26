import { validateSpaceRef } from '../../shared/protocol.js';
import { openSpaceStore } from '../store/space.js';
import { createTiles } from '../../services/tiles.js';
import { createConfigLoader } from '../../services/core.js';
import { decide, localToday, MODES } from './policy.js';
import { planTiles, tilesOf, tileURL, MAX_ZOOM } from './tiles.js';
import { MAP_CACHE, MAX_TILES, TILE_BYTES, PrefetchError, dropTiles, prefetchMapResources, prefetchTiles, templatePrefix } from './prefetch.js';
import { dropTripFiles, fileCacheName, syncTripFiles } from './files.js';
import { evictReplica, readReplica, replicaKey, warmSpace } from './warm.js';
import { appOnline, isForcedOffline, onForcedOffline } from './pwa.js';

const INDEX = 'offline:index';
// Personal private-item writes still to send (src/lib/store/personal.js).
const PERSONAL_QUEUE = 'personal:queue';
const WARM_EVERY = 15 * 60_000;
const RUN_EVERY = 3 * 60 * 60_000;
const TILES_FRESH = 7 * 24 * 60 * 60_000;
// A newer tile dataset replaces the one on the device only after this long, so offline maps stay complete.
const DATASET_AGE = 30 * 24 * 60 * 60_000;
const DATA_CACHE = 'trips-data-v1';
const tripKey = (ref) => `${ref.w}:${ref.s}`;
const emptyIndex = () => ({ v: 1, tiles: true, modes: {}, map: null, trips: {} });
const sameRanges = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
const abortError = () => new DOMException('Aborted', 'AbortError');

/** A short code for a failed download step, for translated messages. */
export function failureCode(error) {
  if (error?.name === 'QuotaExceededError') return 'storage_full';
  if (error instanceof PrefetchError) return error.code;
  const status = error?.status;
  if (status === 0 || error?.code === 'network' || error?.code === 'timeout' || error instanceof TypeError) return 'offline';
  if (status === 402) return 'credit';
  if (status === 401 || status === 403 || status === 426) return 'forbidden';
  if (status === 404 || error?.code === 'space_not_found') return 'gone';
  if (status === 429) return 'busy';
  return 'failed';
}

/**
 * Offline downloads for one signed-in account on this device: which trips are kept, their replicas, non-media files and
 * map tiles, eviction of ended trips, storage use, pending writes and parked conflicts. `download(ref, file, {signal})`
 * returns a file's Blob (supplied by the files module); without it files are not kept.
 */
export function createOfflineManager({ db, personal, puter = null, api = null, deployer = null, services = null, account = null,
  download = null, resolveDownload = () => download, window: target = globalThis.window, caches: storage = globalThis.caches, fetch: fetcher = globalThis.fetch?.bind(globalThis),
  navigatorStorage = globalThis.navigator?.storage, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const listeners = new Set();
  const results = new Map();
  let progress = null;
  let running = null;
  let queued = null;
  let queuedRun = null;
  let controller = null;
  let timers = [];
  let stops = [];
  let started = false;
  let loadConfig;

  let lastEmit = 0;
  let emitTimer = null;
  const emit = () => { lastEmit = now(); const value = snapshot(); for (const listener of listeners) listener(value); };
  // Per-tile and per-file progress reaches listeners at most every 250 ms.
  const emitSoon = () => {
    if (emitTimer) return;
    emitTimer = setTimer(() => { emitTimer = null; emit(); }, Math.max(0, 250 - (now() - lastEmit)));
  };
  const snapshot = () => ({ running: Boolean(running), progress: progress && { ...progress }, results: Object.fromEntries(results) });
  const readIndex = async () => ({ ...emptyIndex(), ...((await db.get(INDEX)) ?? {}) });
  const writeIndex = (change) => db.update(INDEX, (current) => { const next = structuredClone({ ...emptyIndex(), ...(current ?? {}) }); change(next); return next; });
  const fileDownloader = () => { const fn = resolveDownload(); return typeof fn === 'function' ? fn : null; };
  const online = () => appOnline(target);

  async function tileConfig() {
    if (services?.tiles) return services.tiles();
    loadConfig ??= createConfigLoader({ fetch: fetcher, online });
    return createTiles(await loadConfig());
  }
  async function ownWorker() {
    try { return (await deployer?.current())?.name ?? null; } catch { return null; }
  }
  async function entries() {
    const list = await personal.spaces.list();
    return list.filter((entry) => entry.ref.k === 'trip');
  }
  const datesOf = (entry, replica) => ({ start: replica?.meta?.start ?? entry.start ?? null, end: replica?.meta?.end ?? entry.end ?? null });

  async function listTrips({ sizes = false } = {}) {
    const [index, list] = await Promise.all([readIndex(), entries()]);
    const today = localToday(now());
    return Promise.all(list.map(async (entry) => {
      const key = tripKey(entry.ref);
      const replica = await readReplica({ ref: entry.ref, db, size: sizes });
      const mode = index.modes[key] ?? 'auto';
      const dates = datesOf(entry, replica);
      const auto = decide({ dates, mode: 'auto', opened: entry.opened }, { today, now: now() }).keep;
      const saved = index.trips[key] ?? {};
      return {
        ref: entry.ref, key, role: entry.role, title: replica.meta?.title || entry.title || '', ...dates,
        mode, auto, keep: decide({ dates, mode, opened: entry.opened }, { today, now: now() }).keep,
        replica: { loaded: replica.loaded, rev: replica.rev, pending: replica.pending, conflicts: replica.conflicts.length, bytes: replica.bytes ?? null },
        files: saved.files ?? null, tiles: saved.tiles ? { count: saved.tiles.count, bytes: saved.tiles.bytes, truncated: saved.tiles.truncated, at: saved.tiles.at } : null,
        warmAt: saved.warmAt ?? null, error: saved.error ?? null,
      };
    }));
  }

  async function mapResources(index, signal) {
    const tiles = await tileConfig();
    const styleUrls = [tiles.styleUrl('light'), tiles.styleUrl('dark')].filter(Boolean);
    if (!styleUrls.length) return null;
    const cache = await storage.open(MAP_CACHE);
    const previous = index.map;
    let replaced = null;
    const adopt = (template) => {
      if (!previous?.template || previous.template === template) return true;
      if (now() - (previous.at ?? 0) > DATASET_AGE || previous.broken) { replaced = previous.template; return true; }
      return false;
    };
    const resources = await prefetchMapResources({ styleUrls, fetch: fetcher, cache, signal, adopt });
    const template = replaced || !previous?.template ? resources.template : previous.template;
    if (replaced) await dropTiles(cache, { prefix: templatePrefix(replaced) });
    if (replaced || !previous?.template) {
      await writeIndex((next) => {
        next.map = { template, at: now() };
        if (replaced) for (const trip of Object.values(next.trips)) delete trip.tiles;
      });
    }
    return { cache, template, maxzoom: Math.min(MAX_ZOOM, resources.maxzoom) };
  }

  async function tripTiles({ key, points, map, saved, signal, explicit }) {
    const plan = planTiles({ overview: points.overview, detail: points.detail, maxZoom: map.maxzoom });
    if (!plan.ranges.length) return { template: map.template, ranges: [], count: 0, bytes: 0, truncated: false, at: now() };
    const fresh = saved?.template === map.template && sameRanges(saved.ranges, plan.ranges) && now() - (saved.at ?? 0) < TILES_FRESH;
    if (fresh && !explicit) return saved;
    progress = { ...progress, stage: 'map', done: 0, total: 0 }; emit();
    const result = await prefetchTiles({ template: map.template, ranges: plan.ranges, cache: map.cache, fetch: fetcher, signal, maxBytes: TILE_BYTES,
      onProgress: ({ done, total }) => { progress = { key, stage: 'map', done, total }; emitSoon(); } });
    return { template: map.template, ranges: plan.ranges, count: result.count, bytes: result.bytes, truncated: result.truncated, failed: result.failed, at: now() };
  }

  /** Removes cached tiles no kept trip plans any more. */
  async function collectTiles(map) {
    const index = await readIndex();
    if (!index.map?.template) return;
    const keep = new Set();
    for (const trip of Object.values(index.trips)) {
      if (!trip.tiles?.ranges?.length || trip.tiles.template !== index.map.template) continue;
      for (const tile of tilesOf(trip.tiles.ranges, MAX_TILES)) keep.add(new URL(tileURL(index.map.template, tile)).href);
    }
    const cache = map?.cache ?? await storage.open(MAP_CACHE);
    const prefix = new URL(templatePrefix(index.map.template)).href;
    for (const request of await cache.keys()) if (request.url.startsWith(prefix) && !keep.has(request.url)) await cache.delete(request);
  }

  async function runOnce({ refs = null, explicit = false, warmOnly = false, signal }) {
    if (!online()) return { skipped: 'offline' };
    const list = (await entries()).filter((entry) => !refs || refs.some((ref) => tripKey(ref) === tripKey(entry.ref)));
    let index = await readIndex();
    const today = localToday(now());
    const worker = api ? await ownWorker() : null;
    let map;
    let mapError = null;
    let tilesChanged = false;
    for (const entry of list) {
      if (signal.aborted) throw abortError();
      const key = tripKey(entry.ref);
      const before = await readReplica({ ref: entry.ref, db });
      const decision = decide({ dates: datesOf(entry, before), mode: index.modes[key] ?? 'auto', opened: entry.opened }, { today, now: now() });
      const saved = index.trips[key] ?? {};
      if (!decision.keep && !warmOnly) {
        if (saved.tiles || saved.files) {
          if (account) await dropTripFiles({ account, ref: entry.ref, caches: storage });
          await writeIndex((next) => { if (next.trips[key]) { delete next.trips[key].tiles; delete next.trips[key].files; } });
          tilesChanged ||= Boolean(saved.tiles);
        }
        if (decision.evictReplica && await evictReplica({ ref: entry.ref, db })) await writeIndex((next) => { delete next.trips[key]; });
        results.set(key, { state: 'evicted' });
        continue;
      }
      if (!decision.keep && !(warmOnly && before.pending)) continue;
      const record = { error: null };
      try {
        progress = { key, stage: 'data', done: 0, total: 0 }; emit();
        if (api && (explicit || warmOnly || before.pending || now() - (saved.warmAt ?? 0) > WARM_EVERY)) {
          const warmed = await warmSpace({ ref: entry.ref, db, api, puter, handles: entry.handles, ownWorker: worker, signal });
          record.warmAt = now();
          if (warmed.error) record.error = failureCode(warmed.error);
        }
        if (!warmOnly) {
          const replica = await readReplica({ ref: entry.ref, db });
          if (account && fileDownloader()) {
            progress = { key, stage: 'files', done: 0, total: 0 }; emit();
            record.files = await syncTripFiles({ account, ref: entry.ref, files: replica.files, download: fileDownloader(), signal, caches: storage,
              onProgress: ({ done, total }) => { progress = { key, stage: 'files', done, total }; emitSoon(); } });
          }
          if (index.tiles && mapError) record.error ??= failureCode(mapError);
          else if (index.tiles) {
            try {
              if (map === undefined) map = await mapResources(index, signal);
              index = await readIndex();
              if (map) {
                record.tiles = await tripTiles({ key, points: replica.points, map, saved: index.trips[key]?.tiles, signal, explicit });
                tilesChanged ||= record.tiles !== index.trips[key]?.tiles;
              }
            } catch (error) {
              if (error?.name === 'AbortError') throw error;
              mapError = error; record.error = failureCode(error);
              if (error?.code === 'tiles_failed') await writeIndex((next) => { if (next.map) next.map.broken = true; });
            }
          }
        }
        results.set(key, { state: record.error ? 'error' : 'done', error: record.error });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        record.error = failureCode(error);
        results.set(key, { state: 'error', error: record.error });
      }
      await writeIndex((next) => { next.trips[key] = { ...(next.trips[key] ?? {}), ...record, errorAt: record.error ? now() : null }; });
      emit();
    }
    if (tilesChanged && !signal.aborted) await collectTiles(map).catch(() => {});
    return { trips: list.length };
  }

  const merge = (a, b) => ({ refs: a.refs && b.refs ? [...a.refs, ...b.refs] : null, explicit: Boolean(a.explicit || b.explicit), warmOnly: Boolean(a.warmOnly && b.warmOnly) });
  /** Single flight; requests made during a run are merged into one more run after it. */
  function run(options = {}) {
    if (running) {
      queued = queued ? merge(queued, options) : merge(options, options);
      queuedRun ??= running.catch(() => {}).then(() => {
        const next = queued; queued = null; queuedRun = null;
        return next ? run(next) : undefined;
      });
      return queuedRun;
    }
    controller = new AbortController();
    const signal = controller.signal;
    running = (async () => {
      try { return await runOnce({ ...options, signal }); }
      catch (error) {
        // Signed out or another account: this manager's session is over.
        if (error?.code === 'account_changed') manager.stop();
        throw error;
      } finally { running = null; progress = null; emit(); }
    })();
    emit();
    return running;
  }

  async function storageUse({ trips } = {}) {
    let estimate = null;
    let persisted = null;
    try { estimate = await navigatorStorage?.estimate?.() ?? null; } catch { /* Unavailable. */ }
    try { persisted = await navigatorStorage?.persisted?.() ?? null; } catch { /* Unavailable. */ }
    let app = 0;
    if (storage) {
      for (const name of await storage.keys()) {
        if (!name.startsWith('trips-shell-') && name !== DATA_CACHE) continue;
        const cache = await storage.open(name);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          app += Number(response?.headers.get('content-length')) || (response ? (await response.blob()).size : 0);
        }
      }
    }
    const list = trips ?? await listTrips({ sizes: true });
    const sum = (pick) => list.reduce((total, trip) => total + (pick(trip) ?? 0), 0);
    return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted, app, data: sum((trip) => trip.replica.bytes),
      files: sum((trip) => trip.files?.bytes), tiles: sum((trip) => trip.tiles?.bytes) };
  }

  const manager = {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listTrips,
    async settings() { const index = await readIndex(); return { tiles: index.tiles, forced: isForcedOffline(target), modes: { ...index.modes } }; },
    async setTiles(on) {
      await writeIndex((next) => { next.tiles = Boolean(on); });
      if (!on) {
        controller?.abort();
        await storage?.delete(MAP_CACHE);
        await writeIndex((next) => { next.map = null; for (const trip of Object.values(next.trips)) delete trip.tiles; });
      }
      emit();
    },
    async setMode(ref, mode) {
      validateSpaceRef(ref);
      if (!MODES.includes(mode)) throw new TypeError('invalid_mode');
      await writeIndex((next) => { if (mode === 'auto') delete next.modes[tripKey(ref)]; else next.modes[tripKey(ref)] = mode; });
      emit();
    },
    run,
    /** Downloads one trip now, even if it was fetched recently. */
    download: (ref) => run({ refs: [ref], explicit: true }),
    /** Sends queued writes and refreshes every trip with pending work, then wakes open trips. */
    async resync() {
      if (!online()) return { skipped: 'offline' };
      await personal.flush?.().catch(() => {});
      const result = await run({ warmOnly: true, explicit: true });
      target?.dispatchEvent(new target.Event('online'));
      return result;
    },
    stopRun() { controller?.abort(); },
    async pendingWrites() {
      const list = await entries().catch(() => []);
      let trips = 0;
      for (const entry of list) trips += (await readReplica({ ref: entry.ref, db })).pending;
      const queue = await db.get(PERSONAL_QUEUE);
      return { trips, personal: Array.isArray(queue) ? queue.length : 0 };
    },
    async failedWrites() { return personal.failedWrites ? personal.failedWrites() : []; },
    async dismissFailed(qid) { await personal.dismissFailed?.(qid); },
    /** Parked conflicts of every space in the index, newest first per space. */
    async conflicts() {
      const list = await personal.spaces.list();
      const found = [];
      for (const entry of list) {
        const replica = await readReplica({ ref: entry.ref, db });
        if (replica.conflicts.length) found.push({ ref: entry.ref, title: replica.meta?.title || entry.title || '', conflicts: replica.conflicts });
      }
      return found;
    },
    async resolveConflict(ref, opId, choice) {
      const store = await openSpaceStore({ ref, db, api, uid: db.account });
      try {
        const op = await store.resolveConflict(opId, choice);
        if (op && api && online()) await store.flush().catch(() => {});
        return op;
      } finally { store.close(); }
    },
    storage: storageUse,
    async requestPersist() { try { return await navigatorStorage?.persist?.() ?? false; } catch { return false; } },
    /** Clears map tiles, cached files and provider responses. Trip data and the app stay. */
    async clearCache() {
      controller?.abort();
      if (storage) {
        await storage.delete(MAP_CACHE);
        await storage.delete(DATA_CACHE);
        if (account) await storage.delete(fileCacheName(account));
      }
      try { await services?.context?.cache?.clear?.(); } catch { /* The provider cache is optional. */ }
      await writeIndex((next) => { next.map = null; for (const trip of Object.values(next.trips)) { delete trip.tiles; delete trip.files; } });
      emit();
    },
    /** Background downloads: shortly after start, when the connection returns, every few hours and when trips change. */
    start({ delay = 10_000 } = {}) {
      if (started) return manager.stop;
      started = true;
      const later = (ms) => { const timer = setTimer(() => { timers = timers.filter((item) => item !== timer); void run().catch(() => {}); }, ms); timers.push(timer); };
      later(delay);
      const onOnline = () => later(5_000);
      target?.addEventListener('online', onOnline);
      stops.push(() => target?.removeEventListener('online', onOnline));
      const interval = setInterval(() => { if (!target?.document?.hidden) void run().catch(() => {}); }, RUN_EVERY);
      stops.push(() => clearInterval(interval));
      stops.push(onForcedOffline((value) => { if (value) controller?.abort(); }));
      if (personal.subscribe) stops.push(personal.subscribe('me:spaces', () => later(30_000)));
      return manager.stop;
    },
    stop() {
      started = false;
      queued = null;
      controller?.abort();
      clearTimer(emitTimer); emitTimer = null;
      for (const timer of timers) clearTimer(timer);
      timers = [];
      for (const stop of stops.splice(0)) stop();
    },
  };
  return manager;
}

export { replicaKey };
