/**
 * Crash recovery copies of unsaved documents.
 *
 * Layout inside a backend:
 *   recovery/index.0.<id>.json, index.1.<id>.json  per-document index generations
 *   recovery/<id>/<snapshot>.vstudio  immutable document bytes
 * Older shared indexes (index.json, index.next.json) remain readable. Entries
 * without a snapshot token use recovery/<id>.vstudio.
 *
 * Several backends can be given: writes go to the first that works (the
 * Puter appdata folder when signed in, then this browser's OPFS when the
 * cloud is unreachable), and listing merges all of them. Each document owns
 * its metadata so independent tabs/devices never replace another document's
 * index entry. Operations within this store are serialized too.
 */
import { uid } from '../../lib/ids.js';

const DIR = 'recovery';
const INDEX = `${DIR}/index.json`;
const INDEXES = [INDEX, `${DIR}/index.next.json`];
// Recovery ids and snapshot names are opaque app-generated tokens, never paths.
// Validate persisted metadata too: slash-only ids can resolve to the whole store.
const validToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const validEntry = (entry) => Boolean(entry && validToken(entry.id) && (entry.snapshot == null || validToken(entry.snapshot)));
const indexPaths = (id) => [0, 1].map((slot) => `${DIR}/index.${slot}.${encodeURIComponent(id)}.json`);
const textOrNull = (value) => typeof value === 'string' && value ? value : null;

/** Display and file metadata can be repaired without changing snapshot identity. */
function normalizeEntry(entry) {
  const file = entry.file && typeof entry.file === 'object' && !Array.isArray(entry.file) ? entry.file : null;
  return { ...entry, name: textOrNull(entry.name) || 'Untitled', file: file ? {
    kind: textOrNull(file.kind), path: textOrNull(file.path), name: textOrNull(file.name), handleId: textOrNull(file.handleId),
  } : null };
}

function indexedId(file) {
  const match = !file.isDir && /^index\.[01]\.(.+)\.json$/.exec(file.name);
  if (!match) return null;
  try { const id = decodeURIComponent(match[1]); return validToken(id) ? id : null; } catch { return null; }
}

function snapshotPath(entry) {
  if (!validEntry(entry)) throw new Error('Invalid recovery identifier.');
  return entry.snapshot ? `${DIR}/${entry.id}/${entry.snapshot}.vstudio` : `${DIR}/${entry.id}.vstudio`;
}

/** Capture order wins within one session, even when Undo or the system clock goes backward. */
export function newerSnapshot(a, b) {
  if (a.session === b.session && Number.isFinite(a.sequence) && Number.isFinite(b.sequence)) return a.sequence > b.sequence;
  // Older versions did not record capture order. Prefer time, then revisions for ties.
  if (a.saved !== b.saved || a.session !== b.session) return (a.saved || 0) > (b.saved || 0);
  return a.revision > b.revision ||
    (a.revision === b.revision && (a.commentsRevision || 0) > (b.commentsRevision || 0));
}

function sameSnapshot(a, b) {
  if ((a.session || null) !== (b.session || null)) return false;
  const sequenced = Number.isFinite(a.sequence), otherSequenced = Number.isFinite(b.sequence);
  if (sequenced || otherSequenced) return sequenced && otherSequenced && a.sequence === b.sequence;
  return (a.saved || 0) === (b.saved || 0) && (a.revision || 0) === (b.revision || 0) &&
    (a.commentsRevision || 0) === (b.commentsRevision || 0);
}

export class RecoveryStore {
  #staging = new Map();

  constructor(backends) {
    this.backends = (Array.isArray(backends) ? backends : [backends]).filter(Boolean);
    this.queue = Promise.resolve();
  }

  #run(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async #otherSnapshots(backend, id, except = null) {
    const files = await backend.list(`${DIR}/${id}`);
    const staging = this.#staging.get(backend);
    const stagedName = staging?.id === id ? `${staging.snapshot}.vstudio` : null;
    return files.some((file) => !file.isDir && file.name.endsWith('.vstudio') && file.name !== except && file.name !== stagedName);
  }

  /**
   * Read both index slots concurrently. Publishing always replaces the older
   * slot, so an interrupted write leaves the last complete generation intact.
   * Legacy array indexes are generation zero. A storage failure must not make
   * an unknown, possibly newer slot look empty.
   */
  async #readSlots(backend, paths, { strict = false } = {}) {
    const slots = await Promise.allSettled(paths.map((path) => backend.readJSON(path)));
    let latest = null, failure = null, incomplete = false;
    for (let slot = 0; slot < slots.length; slot++) {
      const result = slots[slot];
      if (result.status === 'rejected') {
        if (!(result.reason instanceof SyntaxError)) failure ||= result.reason;
        incomplete = true;
        continue;
      }
      const value = result.value;
      const legacy = Array.isArray(value);
      if (!legacy && !(value?.version === 1 && Number.isSafeInteger(value.generation) && value.generation > 0 && Array.isArray(value.entries))) {
        incomplete = true;
        continue;
      }
      const generation = legacy ? 0 : value.generation;
      const entries = (legacy ? value : value.entries).filter(validEntry).map(normalizeEntry);
      if (!latest || generation > latest.generation) latest = { entries, generation, slot, legacy: value.legacy === true };
    }
    if (failure && strict) throw failure;
    return { ...((!failure && latest) || { entries: [], generation: 0, slot: 1, legacy: false }), found: Boolean(!failure && latest), incomplete };
  }

  async #readState(backend, id, { strict = false, legacyState } = {}) {
    if (!validToken(id)) throw new Error('Invalid recovery identifier.');
    const own = await this.#readSlots(backend, indexPaths(id), { strict });
    if (own.found) return { ...own, entries: own.entries.filter((e) => e.id === id) };
    const old = legacyState === undefined ? await this.#readSlots(backend, INDEXES, { strict }) : legacyState;
    if (!old) throw new Error('Legacy recovery metadata is unavailable.');
    const entries = old.entries.filter((e) => e.id === id);
    // Migration starts a new pair of generations without changing the shared
    // index. A retained tombstone masks its legacy entry after later deletion.
    return { ...own, entries, legacy: entries.length > 0, incomplete: own.incomplete || old.incomplete };
  }

  async #readIndex(backend) {
    const [legacyState, files] = await Promise.all([
      this.#readSlots(backend, INDEXES, { strict: true }).catch(() => null),
      backend.list(DIR),
    ]);
    const ids = [...new Set([...(legacyState?.entries || []).map((e) => e.id), ...files.map(indexedId).filter((id) => id !== null)])];
    const entries = new Array(ids.length);
    let next = 0;
    // Bound cloud requests while reading each document's two slots in parallel.
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= ids.length) return;
        try { entries[i] = (await this.#readState(backend, ids[i], { strict: true, legacyState })).entries; }
        catch { entries[i] = []; }
      }
    }));
    return entries.flat();
  }

  #publishIndex(backend, id, state, entries) {
    return backend.writeJSON(indexPaths(id)[1 - state.slot], { version: 1, generation: state.generation + 1, entries, ...(state.legacy ? { legacy: true } : {}) });
  }

  async #forgetIndex(backend, id, state, published) {
    if (state.legacy) return;
    const paths = indexPaths(id), slot = published ? 1 - state.slot : state.slot;
    // The deletion generation goes last, so an interrupted cleanup cannot expose
    // an older entry. Legacy tombstones stay until the entire store is cleared.
    await backend.remove(paths[1 - slot]);
    await backend.remove(paths[slot]);
  }

  /** Save a recovery copy. Returns the backend kind it landed in. */
  put(id, { name, file = null, data, revision = 0, commentsRevision = 0, sequence, session = null, saved = Date.now() }) {
    return this.#run(async () => {
      let lastErr = null;
      for (const b of this.backends) {
        const snapshot = uid('snapshot');
        const next = normalizeEntry({ id, snapshot, name, file,
          saved, revision, commentsRevision, ...(sequence === undefined ? {} : { sequence }), session });
        let previous, blobAttempted = false, indexAttempted = false;
        try {
          const state = await this.#readState(b, id, { strict: true });
          const index = state.entries;
          previous = index.find((e) => e.id === id);
          blobAttempted = true;
          this.#staging.set(b, { id, snapshot });
          await b.writeBlob(snapshotPath(next), data instanceof Blob ? data : new Blob([data]));
          indexAttempted = true;
          await this.#publishIndex(b, id, state, [next]);
        } catch (err) {
          lastErr = err;
          if (blobAttempted) {
            try {
              // A write can succeed remotely but lose its acknowledgement. Never
              // delete bytes that the persisted index already published.
              const published = indexAttempted && (await this.#readState(b, id, { strict: true })).entries.some((e) => e.snapshot === snapshot);
              if (!published) await b.remove(snapshotPath(next));
            } catch { /* Leave uncertain bytes for document removal to clean up. */ }
          }
          continue;
        } finally {
          this.#staging.delete(b);
        }
        if (previous) await b.remove(snapshotPath(previous)).catch(() => {});
        // A stale copy in a lower-priority store would resurrect old work.
        for (const other of this.backends) if (other !== b) await this.#removeFrom(other, id).catch(() => {});
        return b.kind;
      }
      throw lastErr || new Error('No storage available for recovery data');
    });
  }

  async #removeFrom(b, id, expected = null) {
    const state = await this.#readState(b, id, { strict: true });
    const index = state.entries;
    if (expected) {
      if (!validEntry(expected) || expected.id !== id) return false;
      const observed = expected.copies?.find((copy) => copy.backend === b)?.entry || (expected.backend === b ? expected : null);
      const current = index.find((e) => e.id === id);
      if (!observed) return !current && !(await this.#otherSnapshots(b, id));
      if (!validEntry(observed) || observed.id !== id) return false;
      if (current && (!sameSnapshot(current, observed) || current.snapshot !== observed.snapshot)) return false;
      if (current) await this.#publishIndex(b, id, state, []);
      // The dialog authorized only the copies it displayed. A later publication
      // or an unindexed snapshot must survive cleanup of this observed copy.
      await b.remove(snapshotPath(observed));
      if (await this.#otherSnapshots(b, id)) return false;
      await this.#forgetIndex(b, id, state, Boolean(current));
      return true;
    }
    const published = index.some((e) => e.id === id);
    if (published) await this.#publishIndex(b, id, state, []);
    // Retry orphan cleanup too: an earlier removal may have published its index
    // before losing access to the document's snapshot files.
    await b.remove(`${DIR}/${id}`);
    await b.remove(`${DIR}/${id}.vstudio`);
    await this.#forgetIndex(b, id, state, published);
    return true;
  }

  remove(id, { expected = null } = {}) {
    if (!validToken(id)) return Promise.resolve(false);
    return this.#run(async () => {
      let removed = true;
      for (const b of this.backends) {
        if (!await this.#removeFrom(b, id, expected).catch(() => false)) removed = false;
      }
      return removed;
    });
  }

  /** Every recovery entry, newest first, each with the backend that holds it. */
  list() {
    return this.#run(async () => {
      const byId = new Map();
      for (const b of this.backends) {
        for (const e of await this.#readIndex(b).catch(() => [])) {
          const prev = byId.get(e.id);
          const copies = prev?.copies || [];
          copies.push({ entry: e, backend: b });
          if (!prev || newerSnapshot(e, prev.entry)) byId.set(e.id, { entry: e, backend: b, copies });
        }
      }
      return [...byId.values()].sort((a, b) => (b.entry.saved || 0) - (a.entry.saved || 0)).map(({ entry, backend, copies }) => ({ ...entry, store: backend.kind, backend, copies }));
    });
  }

  /** Recheck after decoding or handle lookup, including writes already queued. */
  isCurrent(entry) {
    if (!validEntry(entry)) return Promise.resolve(false);
    return this.#run(async () => {
      let current = null, backend = null;
      for (const b of this.backends) {
        const state = await this.#readState(b, entry.id, { strict: true }).catch(() => null);
        const candidate = state?.entries[0];
        if (candidate && (!current || newerSnapshot(candidate, current))) { current = candidate; backend = b; }
      }
      return Boolean(current && sameSnapshot(current, entry) &&
        (backend !== entry.backend || current.snapshot === entry.snapshot));
    });
  }

  /**
   * The stored bytes for an entry from list(), or null when no store has
   * them. Only an identical snapshot may substitute for the selected copy.
   * Throws when matching bytes cannot be read but storage failed or another
   * snapshot remains, so recovery never silently substitutes stale work.
   */
  async read(entry) {
    if (!validEntry(entry)) throw new Error('Invalid recovery identifier.');
    const backends = entry.backend ? [entry.backend, ...this.backends.filter((b) => b !== entry.backend)] : this.backends;
    let failure = null;
    for (const b of backends) {
      try {
        const state = await this.#readState(b, entry.id, { strict: true });
        const candidate = state.entries.find((e) => e.id === entry.id);
        if (!candidate) {
          // A missing/damaged index is not proof that the selected bytes are gone.
          // Returning null would make the recovery dialog discard those bytes.
          if (await b.readBlob(snapshotPath(entry)) || await this.#otherSnapshots(b, entry.id)) failure ||= new Error('Recovery metadata is unavailable. Try recovery again.');
          continue;
        }
        if (!sameSnapshot(candidate, entry) || (b === entry.backend && candidate.snapshot !== entry.snapshot)) {
          failure ||= new Error('The selected recovery snapshot is not available right now.');
          continue;
        }
        if (state.incomplete && await this.#otherSnapshots(b, entry.id, candidate.snapshot ? `${candidate.snapshot}.vstudio` : null)) {
          failure ||= new Error('Recovery metadata is incomplete and other snapshots remain. Try recovery again.');
          continue;
        }
        const blob = await b.readBlob(snapshotPath(candidate));
        if (blob) return blob;
        // A concurrent publication can remove the selected file while it is read.
        const current = (await this.#readState(b, entry.id, { strict: true })).entries.find((e) => e.id === entry.id);
        if ((current && (!sameSnapshot(current, entry) || current.snapshot !== candidate.snapshot)) || await this.#otherSnapshots(b, entry.id, candidate.snapshot ? `${candidate.snapshot}.vstudio` : null)) failure ||= new Error('The selected recovery snapshot changed. Try recovery again.');
      } catch (err) {
        // Try the next store.
        failure = failure || err;
      }
    }
    if (failure) throw failure;
    return null;
  }

  clear() {
    return this.#run(async () => {
      for (const b of this.backends) {
        await b.remove(DIR).catch(() => {});
      }
    });
  }
}

/**
 * Which entries to offer for recovery: those not owned by a session that is
 * still alive (another open tab keeps autosaving its own documents).
 */
export function recoverableEntries(entries, liveSessions = new Set(), ownSession = null) {
  return entries.filter((e) => !e.session || (e.session !== ownSession && !liveSessions.has(e.session)));
}
