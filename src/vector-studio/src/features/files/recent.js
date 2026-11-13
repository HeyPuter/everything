/**
 * Recently opened and saved files.
 *
 * Entries live in the preferences (small: kind, path, name, time); their
 * thumbnails live in a cache backend (OPFS) keyed by a hash of the entry so
 * localStorage stays small. Cloud entries are checked against
 * puter.fs.stat lazily (at most once per `staleAfter`) and dropped when the
 * file is gone; the user can also remove entries by hand.
 *
 * Entry: { kind: 'puter' | 'local', path, name, when, handleId? }
 *   puter  path is the absolute Puter path
 *   local  a File System Access handle stored in IndexedDB under handleId
 */
import { isMissing } from './backends.js';

export const RECENT_KEY = 'recentFiles';
export const RECENT_MAX = 20;

/** Stable short hash (FNV-1a) for cache keys. */
export function hashKey(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function entryKey(e) {
  return `${e.kind}:${e.kind === 'local' ? e.handleId || e.name : e.path}`;
}

export class RecentFiles {
  #validating = new Map();
  #thumbJobs = new Map();
  #thumbLoads = new Map();

  constructor(prefs, { cache = null, max = RECENT_MAX, now = () => Date.now(), staleAfter = 5 * 60 * 1000 } = {}) {
    this.prefs = prefs;
    this.cache = cache;
    this.max = max;
    this.now = now;
    this.staleAfter = staleAfter;
    this.checked = new Map(); // key -> time of last successful stat
    this.thumbs = new Map(); // key -> data URL (memory cache)
  }

  get limit() {
    const n = Number(this.prefs.get('recentFilesMax'));
    return Number.isFinite(n) && n > 0 ? Math.min(50, Math.round(n)) : this.max;
  }

  list() {
    const raw = this.prefs.get(RECENT_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((e) => e && typeof e === 'object' && (e.kind === 'puter' ? typeof e.path === 'string' : e.kind === 'local' && e.handleId)).slice(0, this.limit);
  }

  #store(list) {
    this.prefs.set(RECENT_KEY, list.slice(0, this.limit));
  }

  /** Add or move an entry to the top. Returns the stored entry. */
  async add({ kind, path = null, name, handleId = null, thumb = null }) {
    const entry = { kind, path, name, when: this.now(), ...(handleId ? { handleId } : {}) };
    const key = entryKey(entry);
    const list = this.list().filter((e) => entryKey(e) !== key);
    list.unshift(entry);
    const dropped = list.slice(this.limit);
    this.#store(list);
    this.checked.set(key, this.now());
    // Schedule evictions now, before another entry's write can delay cleanup
    // until after an evicted file has been reopened with a new thumbnail.
    for (const d of dropped) this.#dropThumb(d);
    if (thumb) await this.setThumb(entry, thumb);
    return entry;
  }

  async remove(entry) {
    const key = entryKey(entry);
    this.#store(this.list().filter((e) => entryKey(e) !== key));
    this.checked.delete(key);
    await this.#dropThumb(entry);
  }

  /** Update entries after a file moved or was renamed (Save As over the old path keeps one entry). */
  rename(oldEntry, patch) {
    const key = entryKey(oldEntry);
    this.#store(this.list().map((e) => (entryKey(e) === key ? { ...e, ...patch } : e)));
  }

  clear() {
    for (const e of this.list()) this.#dropThumb(e);
    this.#store([]);
  }

  thumbPath(entry) {
    return `thumbs/${hashKey(entryKey(entry))}.json`;
  }

  #cacheJob(key, run) {
    const job = (this.#thumbJobs.get(key) || Promise.resolve()).then(run, run);
    this.#thumbJobs.set(key, job);
    return job.finally(() => { if (this.#thumbJobs.get(key) === job) this.#thumbJobs.delete(key); });
  }

  #invalidateThumbRead(key) {
    const load = this.#thumbLoads.get(key);
    if (load) load.stale = true;
    this.#thumbLoads.delete(key);
  }

  async setThumb(entry, dataUrl) {
    const key = entryKey(entry), path = this.thumbPath(entry);
    this.#invalidateThumbRead(key);
    this.thumbs.set(key, dataUrl);
    await this.#cacheJob(key, async () => {
      try { await this.cache?.writeJSON(path, { key, thumb: dataUrl }); }
      catch { /* The cache is best effort. */ }
    });
  }

  async thumb(entry) {
    const key = entryKey(entry);
    if (this.thumbs.has(key)) return this.thumbs.get(key);
    if (this.#thumbLoads.has(key)) return this.#thumbLoads.get(key).promise;
    const path = this.thumbPath(entry), load = { stale: false, promise: null };
    this.#thumbLoads.set(key, load);
    const pending = this.#thumbJobs.get(key);
    load.promise = (async () => {
      // Read after preceding mutations, but never make a newer write wait for
      // an old read. Invalidation below prevents that read from returning stale data.
      await pending?.catch(() => {});
      if (load.stale) return this.thumbs.get(key) ?? null;
      try {
        const v = await this.cache?.readJSON(path);
        // A newer in-memory preview or removal owns the result of an old read.
        if (load.stale) return this.thumbs.get(key) ?? null;
        if (v && v.key === key && typeof v.thumb === 'string') {
          this.thumbs.set(key, v.thumb);
          return v.thumb;
        }
      } catch {
        if (load.stale) return this.thumbs.get(key) ?? null;
        // Missing or unreadable cache entry.
      }
      return null;
    })().finally(() => { if (this.#thumbLoads.get(key) === load) this.#thumbLoads.delete(key); });
    return load.promise;
  }

  async #dropThumb(entry) {
    const key = entryKey(entry), path = this.thumbPath(entry);
    this.#invalidateThumbRead(key);
    this.thumbs.delete(key);
    await this.#cacheJob(key, async () => {
      try { await this.cache?.remove(path); }
      catch { /* Best effort. */ }
    });
  }

  /**
   * Drop cloud entries whose file no longer exists. `stat(path)` rejects
   * with a not-found error for missing files; other errors (offline) keep
   * the entry. Returns the entries that were removed.
   */
  async validate(stat, { force = false } = {}) {
    const removed = [];
    const now = this.now();
    const requests = this.list()
      .filter((e) => {
        if (e.kind !== 'puter') return false;
        const last = this.checked.get(entryKey(e));
        return force || last == null || now - last >= this.staleAfter;
      })
      .map((entry) => ({ entry, key: entryKey(entry), token: Symbol() }));
    for (const request of requests) this.#validating.set(request.key, request.token);
    // Reopening/renaming replaces the entry even when timestamps tie. A newer
    // validation also supersedes older requests against the unchanged entry.
    const current = ({ entry, key, token }) => this.#validating.get(key) === token && entryKey(entry) === key && this.list().includes(entry);
    try {
      const missing = await Promise.all(requests.map(async (request) => {
        try {
          const item = await stat(request.entry.path);
          if (!current(request)) return false;
          if (item && (item.is_dir || item.isDir)) return true;
          this.checked.set(request.key, this.now());
        } catch (err) {
          if (!current(request)) return false;
          if (isMissing(err)) return true;
          // Could not tell (offline): check again next time.
          this.checked.delete(request.key);
        }
        return false;
      }));
      for (let i = 0; i < requests.length; i++) {
        // Another file check or thumbnail cleanup may have delayed this removal.
        if (!missing[i] || !current(requests[i])) continue;
        await this.remove(requests[i].entry);
        removed.push(requests[i].entry);
      }
      return removed;
    } finally {
      for (const { key, token } of requests) if (this.#validating.get(key) === token) this.#validating.delete(key);
    }
  }
}
