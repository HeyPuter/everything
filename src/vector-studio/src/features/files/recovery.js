/**
 * Crash recovery copies of unsaved documents.
 *
 * Layout inside a backend:
 *   recovery/index.json, index.next.json  alternating generations of the index
 *   recovery/<id>/<snapshot>.vstudio  immutable document bytes
 * Older entries without a snapshot token use recovery/<id>.vstudio.
 *
 * Several backends can be given: writes go to the first that works (the
 * Puter appdata folder when signed in, then this browser's OPFS when the
 * cloud is unreachable), and listing merges all of them. Operations are
 * serialized so the index read-modify-write never races.
 */
import { uid } from '../../lib/ids.js';

const DIR = 'recovery';
const INDEX = `${DIR}/index.json`;
const INDEXES = [INDEX, `${DIR}/index.next.json`];

function snapshotPath(entry) {
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
  async #readState(backend, { strict = false } = {}) {
    const slots = await Promise.allSettled(INDEXES.map((path) => backend.readJSON(path)));
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
      const entries = (legacy ? value : value.entries).filter((e) => e && typeof e.id === 'string');
      if (!latest || generation > latest.generation) latest = { entries, generation, slot };
    }
    if (failure && strict) throw failure;
    return { ...((!failure && latest) || { entries: [], generation: 0, slot: 1 }), incomplete };
  }

  async #readIndex(backend, options) {
    return (await this.#readState(backend, options)).entries;
  }

  #publishIndex(backend, state, entries) {
    return backend.writeJSON(INDEXES[1 - state.slot], { version: 1, generation: state.generation + 1, entries });
  }

  /** Save a recovery copy. Returns the backend kind it landed in. */
  put(id, { name, file = null, data, revision = 0, commentsRevision = 0, sequence, session = null, saved = Date.now() }) {
    return this.#run(async () => {
      let lastErr = null;
      for (const b of this.backends) {
        const snapshot = uid('snapshot');
        const next = { id, snapshot, name, file: file ? { kind: file.kind, path: file.path || null, name: file.name || null, handleId: file.handleId || null } : null,
          saved, revision, commentsRevision, ...(sequence === undefined ? {} : { sequence }), session };
        let previous, blobAttempted = false, indexAttempted = false;
        try {
          const state = await this.#readState(b, { strict: true });
          const index = state.entries;
          previous = index.find((e) => e.id === id);
          blobAttempted = true;
          this.#staging.set(b, { id, snapshot });
          await b.writeBlob(snapshotPath(next), data instanceof Blob ? data : new Blob([data]));
          indexAttempted = true;
          await this.#publishIndex(b, state, [...index.filter((e) => e.id !== id), next]);
        } catch (err) {
          lastErr = err;
          if (blobAttempted) {
            try {
              // A write can succeed remotely but lose its acknowledgement. Never
              // delete bytes that the persisted index already published.
              const published = indexAttempted && (await this.#readIndex(b, { strict: true })).some((e) => e.id === id && e.snapshot === snapshot);
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
    const state = await this.#readState(b, { strict: true });
    const index = state.entries;
    if (expected) {
      const observed = expected.copies?.find((copy) => copy.backend === b)?.entry || (expected.backend === b ? expected : null);
      const current = index.find((e) => e.id === id);
      if (!observed) return !current && !(await this.#otherSnapshots(b, id));
      if (current && (!sameSnapshot(current, observed) || current.snapshot !== observed.snapshot)) return false;
      if (current) await this.#publishIndex(b, state, index.filter((e) => e.id !== id));
      // The dialog authorized only the copies it displayed. A later publication
      // or an unindexed snapshot must survive cleanup of this observed copy.
      await b.remove(snapshotPath(observed));
      return !(await this.#otherSnapshots(b, id));
    }
    if (index.some((e) => e.id === id)) await this.#publishIndex(b, state, index.filter((e) => e.id !== id));
    // Retry orphan cleanup too: an earlier removal may have published its index
    // before losing access to the document's snapshot files.
    await b.remove(`${DIR}/${id}`);
    await b.remove(`${DIR}/${id}.vstudio`);
    return true;
  }

  remove(id, { expected = null } = {}) {
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
        for (const e of await this.#readIndex(b)) {
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
  async isCurrent(entry) {
    const current = (await this.list()).find((e) => e.id === entry.id);
    return Boolean(current && sameSnapshot(current, entry) &&
      (current.backend !== entry.backend || current.snapshot === entry.snapshot));
  }

  /**
   * The stored bytes for an entry from list(), or null when no store has
   * them. Only an identical snapshot may substitute for the selected copy.
   * Throws when matching bytes cannot be read but storage failed or another
   * snapshot remains, so recovery never silently substitutes stale work.
   */
  async read(entry) {
    const backends = entry.backend ? [entry.backend, ...this.backends.filter((b) => b !== entry.backend)] : this.backends;
    let failure = null;
    for (const b of backends) {
      try {
        const state = await this.#readState(b, { strict: true });
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
        const current = (await this.#readIndex(b, { strict: true })).find((e) => e.id === entry.id);
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
