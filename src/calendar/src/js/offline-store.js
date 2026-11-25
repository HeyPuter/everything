/**
 * A snapshot-caching wrapper around `puter.kv`.
 *
 * It has the exact `{ list, get, set, del }` shape `store.js` expects, so the
 * store is created over it with NO change to store.js. Its only job is to make
 * `store.load()` work offline by transparently serving the last successful read
 * from a small `localStorage` snapshot — the app can then show your last-synced
 * calendar with no connection.
 *
 * Sync safety: the snapshot is READ-ONLY as far as the cloud is concerned. It is
 * only ever written FROM the cloud (on a successful read) or kept in step with a
 * write that already reached the cloud. It is never replayed back to `puter.kv`,
 * so it can never cause a divergent or clobbering write. The cloud stays the
 * single source of truth.
 *
 * Cache writes are strictly best-effort: a failing `localStorage` (quota,
 * private-mode Safari, blocked storage) must NEVER turn a successful cloud
 * `set`/`del` into a rejected promise, or the editor would show a false
 * "couldn't save" and the user would retry a write that already landed.
 */
import { isCompleteListing } from './paged-kv.js';
import { looksTruncated } from './store.js';

const SNAPSHOT_KEY = 'cal:snapshot';

function readBlob() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const blob = JSON.parse(raw);
    if (!blob || typeof blob !== 'object' || !blob.entries) return null;
    return blob;
  } catch {
    return null;
  }
}

export function createOfflineKv(puterKv) {
  // Reachability for the current load(): reset to true by resetReachable(), then
  // any read that falls back to cache sets it false and it STAYS false for the
  // rest of that load. Reads never set it back to true, so with concurrent boot
  // reads wasOffline() means "any read fell back", not "the last one did".
  let lastReachable = true;
  let userId = null;
  // How many reads have been answered from the snapshot, ever. Unlike
  // lastReachable this is never reset, so a caller can bracket one read and
  // tell whether THAT answer came from the cloud (see fallbackCount below).
  let fallbacks = 0;

  function writeBlob(mutate) {
    // Best-effort: swallow every failure. Never throws.
    try {
      const blob = readBlob() || { userId, ts: 0, entries: {} };
      mutate(blob);
      // Only stamp a known user; never overwrite a real id with null (e.g. an
      // online write while getUser() returned an object without an id).
      if (userId) blob.userId = userId;
      blob.ts = Date.now();
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(blob));
    } catch {
      /* storage unavailable / full — offline cache is optional. */
    }
  }

  function prefixOf(pattern) {
    return String(pattern == null ? '' : pattern).replace(/\*$/, '');
  }

  async function list(pattern, returnValues) {
    try {
      const result = await puterKv.list(pattern, returnValues);
      const prefix = prefixOf(pattern);
      const entries = Array.isArray(result) ? result : [];
      // Replace the whole prefix namespace so an event deleted on another device
      // (absent from the fresh list) doesn't linger and reappear offline — but
      // ONLY for a result known to be the complete truth: one the backend
      // read to its last page (paged-kv.js), or one too small to have been
      // cut. A big flat list can come back cut short with no sign of it (the
      // reason store.js shards them), and replacing on one would poison the
      // last good snapshot with a partial calendar before the shard fan-out
      // repairs it — permanently, if the network drops mid-fan-out or the tab
      // closes first. A suspect result only MERGES; the trusted per-shard
      // replaces that follow still carry cross-device deletions on every
      // fully-online load.
      const suspect = !isCompleteListing(result) && looksTruncated(entries);
      writeBlob((blob) => {
        if (!suspect) {
          for (const key of Object.keys(blob.entries)) {
            if (key.startsWith(prefix)) delete blob.entries[key];
          }
        }
        for (const entry of entries) {
          if (entry && typeof entry.key === 'string') blob.entries[entry.key] = entry.value;
        }
      });
      return result;
    } catch (err) {
      lastReachable = false;
      const blob = readBlob();
      if (!blob) throw err; // never synced → let the caller surface the failure
      fallbacks += 1;
      const prefix = prefixOf(pattern);
      return Object.keys(blob.entries)
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, value: blob.entries[key] }));
    }
  }

  async function get(key) {
    try {
      const value = await puterKv.get(key);
      writeBlob((blob) => {
        blob.entries[key] = value;
      });
      return value;
    } catch (err) {
      lastReachable = false;
      const blob = readBlob();
      if (!blob) throw err;
      fallbacks += 1;
      // A missing single key offline is indistinguishable from "not set"; the
      // store treats null as "use defaults", which is the safe outcome for
      // settings. A caller for whom it is NOT safe brackets the read with
      // fallbackCount() and treats a fallback as a failed read.
      return key in blob.entries ? blob.entries[key] : null;
    }
  }

  async function set(key, value) {
    // Cloud write first; its result is what the caller sees. Only touch the
    // snapshot afterwards, best-effort, so cache trouble can't fail a real save.
    // Mirrors puter.kv.set's two signatures: `(key, value)` or a batch array of
    // `{ key, value }` items (used by importEvents) — the snapshot then tracks
    // every item of the batch, exactly like the per-key form.
    const result = await puterKv.set(key, value);
    writeBlob((blob) => {
      if (Array.isArray(key)) {
        for (const item of key) {
          if (item && typeof item.key === 'string') blob.entries[item.key] = item.value;
        }
      } else {
        blob.entries[key] = value;
      }
    });
    return result;
  }

  async function del(key) {
    const result = await puterKv.del(key);
    writeBlob((blob) => {
      delete blob.entries[key];
    });
    return result;
  }

  return {
    list,
    get,
    set,
    del,

    /** Call before a fresh load(); wasOffline() then reflects whether ANY read
     *  in that load had to fall back to the snapshot (a failure is sticky). */
    resetReachable() {
      lastReachable = true;
    },

    /** True when a read since the last resetReachable() fell back to the local
     *  snapshot — i.e. the cloud was unreachable during the current load(). */
    wasOffline() {
      return lastReachable === false;
    },

    /** How many reads so far were answered from the snapshot rather than the
     *  cloud. Monotonic and never reset: bracket a read with it to learn
     *  whether that particular answer is a cloud answer. */
    fallbackCount() {
      return fallbacks;
    },

    /** True when a real snapshot exists (synced at least once, even if empty) —
     *  distinguishes "offline, never synced" from "offline, synced, no events". */
    hasSnapshot() {
      return readBlob() != null;
    },

    /** Record the current user and drop a snapshot belonging to a different one,
     *  so account switching never shows the previous account's data offline. */
    ensureUser(id) {
      userId = id || null;
      if (!userId) return;
      const blob = readBlob();
      if (blob && blob.userId && blob.userId !== userId) this.clearSnapshot();
    },

    clearSnapshot() {
      try {
        localStorage.removeItem(SNAPSHOT_KEY);
      } catch {
        /* nothing to clear / storage unavailable */
      }
    },
  };
}

/** Clear the offline snapshot (used on sign-out; safe to call anywhere). */
export function clearSnapshot() {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* storage unavailable */
  }
}
