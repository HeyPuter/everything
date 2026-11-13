/**
 * Crash recovery copies of unsaved documents.
 *
 * Layout inside a backend:
 *   recovery/index.json        [{ id, name, file, saved, revision, session }]
 *   recovery/<id>.vstudio      the document (same format as a saved file)
 *
 * Several backends can be given: writes go to the first that works (the
 * Puter appdata folder when signed in, then this browser's OPFS when the
 * cloud is unreachable), and listing merges all of them. Operations are
 * serialized so the index read-modify-write never races.
 */
const DIR = 'recovery';
const INDEX = `${DIR}/index.json`;

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
  constructor(backends) {
    this.backends = (Array.isArray(backends) ? backends : [backends]).filter(Boolean);
    this.queue = Promise.resolve();
  }

  #run(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * The entries a backend lists ([] when it has none). With `strict`, a
   * read that failed (offline) throws instead, so the index is never
   * rewritten without the entries it could not read; a damaged one still
   * starts over.
   */
  async #readIndex(backend, { strict = false } = {}) {
    let v;
    try {
      v = await backend.readJSON(INDEX);
    } catch (err) {
      if (strict && !(err instanceof SyntaxError)) throw err;
      return [];
    }
    return Array.isArray(v) ? v.filter((e) => e && typeof e.id === 'string') : [];
  }

  /** Save a recovery copy. Returns the backend kind it landed in. */
  put(id, { name, file = null, data, revision = 0, commentsRevision = 0, sequence, session = null, saved = Date.now() }) {
    return this.#run(async () => {
      let lastErr = null;
      for (const b of this.backends) {
        try {
          await b.writeBlob(`${DIR}/${id}.vstudio`, data instanceof Blob ? data : new Blob([data]));
          const index = (await this.#readIndex(b, { strict: true })).filter((e) => e.id !== id);
          index.push({ id, name, file: file ? { kind: file.kind, path: file.path || null, name: file.name || null, handleId: file.handleId || null } : null, saved, revision, commentsRevision, ...(sequence === undefined ? {} : { sequence }), session });
          await b.writeJSON(INDEX, index);
          // A stale copy in a lower-priority store would resurrect old work.
          for (const other of this.backends) if (other !== b) await this.#removeFrom(other, id).catch(() => {});
          return b.kind;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error('No storage available for recovery data');
    });
  }

  async #removeFrom(b, id) {
    const index = await this.#readIndex(b);
    if (!index.some((e) => e.id === id)) return;
    await b.remove(`${DIR}/${id}.vstudio`);
    await b.writeJSON(INDEX, index.filter((e) => e.id !== id));
  }

  remove(id) {
    return this.#run(async () => {
      for (const b of this.backends) await this.#removeFrom(b, id).catch(() => {});
    });
  }

  /** Every recovery entry, newest first, each with the backend that holds it. */
  list() {
    return this.#run(async () => {
      const byId = new Map();
      for (const b of this.backends) {
        for (const e of await this.#readIndex(b)) {
          const prev = byId.get(e.id);
          if (!prev || newerSnapshot(e, prev.entry)) byId.set(e.id, { entry: e, backend: b });
        }
      }
      return [...byId.values()].sort((a, b) => (b.entry.saved || 0) - (a.entry.saved || 0)).map(({ entry, backend }) => ({ ...entry, store: backend.kind, backend }));
    });
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
        if (b !== entry.backend) {
          const candidate = (await this.#readIndex(b, { strict: true })).find((e) => e.id === entry.id);
          if (!candidate) continue;
          if (!sameSnapshot(candidate, entry)) {
            failure ||= new Error('The selected recovery snapshot is not available right now.');
            continue;
          }
        }
        const blob = await b.readBlob(`${DIR}/${entry.id}.vstudio`);
        if (blob) return blob;
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
