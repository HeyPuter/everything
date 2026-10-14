import { sharedPoints, validateBoard } from "./model.js";
const DB = "whiteboard-v1";
let dbPromise;
function db() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 3);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("boards"))
        req.result.createObjectStore("boards", { keyPath: "id" });
      if (!req.result.objectStoreNames.contains("revisions")) {
        const store = req.result.createObjectStore("revisions", {
          keyPath: "id",
        });
        store.createIndex("boardId", "boardId");
      }
      if (!req.result.objectStoreNames.contains("templates"))
        req.result.createObjectStore("templates", { keyPath: "id" });
      if (!req.result.objectStoreNames.contains("collaboration")) {
        const store = req.result.createObjectStore("collaboration", {
          keyPath: "id",
        });
        store.createIndex("scope", "scope");
      }
    };
    req.onsuccess = () => {
      const database = req.result;
      // A newer release in another tab must be able to upgrade the schema;
      // an open connection would otherwise block it indefinitely.
      database.onversionchange = () => {
        database.close();
        dbPromise = null;
      };
      // A connection the browser closes, as when site data is cleared, is
      // opened again on the next use instead of failing every save.
      database.onclose = () => {
        dbPromise = null;
      };
      resolve(database);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  }));
}
async function transaction(mode, fn, store = "boards") {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
// Each board's recovery versions as { id, created, bytes, kept }; see
// checkpoint.
const revisionIndex = new Map();
// What one board's versions may take: the ones each edit leaves, and
// separately the ones people named.
const REVISION_BYTES = 50 * 1024 * 1024;
// Whether a version is kept apart from the ones each edit leaves. Versions
// saved before they were marked are told by their label, as only the ones
// edits leave are called "Board edit".
export const keptRevision = (r) => r.kept ?? r.label !== "Board edit";
// The `updated` stamp each board had when this tab last read or wrote it.
// A save over a copy another tab wrote since is refused, so neither tab
// silently loses the other's edits.
const seen = new Map();
export class StaleBoardError extends Error {
  constructor() {
    super("This board changed in another tab. Reload to see the latest copy.");
    this.name = "StaleBoardError";
  }
}
export class DeletedBoardError extends Error {
  constructor() {
    super("This board was deleted in another tab.");
    this.name = "DeletedBoardError";
  }
}
// Whether a board is a favorite and whether it is in the trash belong to
// the library, not to its edits: another tab's choice stays through this
// tab's saves, unless the save is that choice.
const LIBRARY = ["favorite", "deletedAt"];
const noteSeen = (boards) => {
  for (const b of boards) seen.set(b.id, b.updated);
  return boards;
};
// Writes from this tab share a completion barrier for each board. A second
// write must compare against the first write's acknowledged stamp. Other
// boards remain independent, and a failed write releases the next attempt.
const pendingBoardWrites = new Map(),
  pendingContentWrites = new Map();
function boardWrite(id, write) {
  const previous = pendingBoardWrites.get(id),
    pending = previous ? previous.catch(() => {}).then(write) : write();
  pendingBoardWrites.set(id, pending);
  return pending.finally(() => {
    if (pendingBoardWrites.get(id) === pending) {
      pendingBoardWrites.delete(id);
      pendingContentWrites.delete(id);
    }
  });
}
export const local = {
  collaborationRows: (scope) =>
    transaction(
      "readonly",
      (s) => s.index("scope").getAll(scope),
      "collaboration",
    ),
  collaborationPut: (row) =>
    transaction("readwrite", (s) => s.put(row), "collaboration"),
  collaborationDelete: (id) =>
    transaction("readwrite", (s) => s.delete(id), "collaboration"),
  // Every row one shared-board session kept on this device.
  collaborationClear: (scope) =>
    transaction(
      "readwrite",
      (s) => {
        const keys = s.index("scope").getAllKeys(scope);
        keys.onsuccess = () => keys.result.forEach((key) => s.delete(key));
        return keys;
      },
      "collaboration",
    ),
  // Every row any account kept on this device for one shared board.
  collaborationBoardRows: ({ server, room }) =>
    local.collaborationRows(
      IDBKeyRange.bound(`${server}|${room}|`, `${server}|${room}|\uffff`),
    ),
  collaborationClearBoard: ({ server, room }) =>
    local.collaborationClear(
      IDBKeyRange.bound(`${server}|${room}|`, `${server}|${room}|\uffff`),
    ),
  // Every board's id, without reading the boards themselves.
  ids: () => transaction("readonly", (s) => s.getAllKeys()),
  list: () => transaction("readonly", (s) => s.getAll()).then(noteSeen),
  // One board as the store holds it now, or undefined once it is gone.
  // A guarded recovery can adopt the copy before acknowledging its stamp.
  get: (id, { accept } = {}) =>
    transaction("readonly", (s) => s.get(id)).then((b) => {
      if (b && (!accept || accept(b))) seen.set(b.id, b.updated);
      return b;
    }),
  // A library save writes the board's library choice onto whatever copy is
  // stored. Naming a library field leaves the other choice intact; true
  // writes both choices. Any other save writes the board
  // and carries the stored library choice along.
  save: (b, { library = false, accept } = {}) => {
    const intent = library ? pendingContentWrites.get(b.id) : {};
    if (!library) pendingContentWrites.set(b.id, intent);
    let gone = false,
      writtenUpdated,
      libraryCopy,
      seenAtRead;
    return boardWrite(b.id, () =>
      transaction("readwrite", (s) => {
        const put = (value) => {
          const request = s.put(value);
          // IndexedDB copies now; the caller may edit the board before completion.
          writtenUpdated = value.updated;
          if (library && value !== b) libraryCopy = value;
          return request;
        };
        // A board this tab never read may still be stored by another tab:
        // a board first saved here has no older copy to keep, and a newer
        // stored copy is not written over.
        const unseen = !seen.has(b.id);
        const read = s.get(b.id);
        read.onsuccess = () => {
          const stored = read.result;
          seenAtRead = seen.get(b.id);
          if (unseen && !stored) return put(b);
          // Shared boards converge through their worker, so every tab may
          // write its copy, and a copy deleted elsewhere while this tab is
          // on the board is only a copy. A personal board deleted elsewhere
          // stays deleted; one edited elsewhere is not written over.
          if (!stored) {
            if (b.shared && !library) return put(b);
            gone = true;
            return read.transaction.abort();
          }
          if (library) {
            for (const key of LIBRARY) {
              if (library !== true && library !== key) continue;
              if (b[key] === undefined) delete stored[key];
              else stored[key] = b[key];
            }
            return put(stored);
          }
          if (
            !b.shared &&
            (unseen
              ? stored.updated > b.updated
              : stored.updated !== seen.get(b.id))
          )
            return read.transaction.abort();
          for (const key of LIBRARY)
            if (stored[key] === undefined) delete b[key];
            else b[key] = stored[key];
          put(b);
        };
        return read;
      }).then(
        () => {
          // Library writes acknowledge content only when the caller adopts
          // the actual stored copy. A later queued edit or accepted read
          // retains its own conflict boundary instead.
          if (
            !libraryCopy ||
            (pendingContentWrites.get(b.id) === intent &&
              seen.get(b.id) === seenAtRead &&
              accept?.(libraryCopy, writtenUpdated !== seenAtRead))
          )
            seen.set(b.id, writtenUpdated);
          return b;
        },
        (error) => {
          // An abort of our own carries no error.
          if (error != null) throw error;
          throw gone ? new DeletedBoardError() : new StaleBoardError();
        },
      ),
    );
  },
  remove: (id) => {
    seen.delete(id);
    return transaction("readwrite", (s) => s.delete(id));
  },
  revisions: (id) =>
    transaction("readonly", (s) => s.index("boardId").getAll(id), "revisions"),
  templates: () => transaction("readonly", (s) => s.getAll(), "templates"),
  saveTemplate: (b) => transaction("readwrite", (s) => s.put(b), "templates"),
  removeTemplate: (id) =>
    transaction("readwrite", (s) => s.delete(id), "templates"),
  // Every recovery version of one board, as when it leaves the trash for good.
  removeRevisions: (id) => {
    revisionIndex.delete(id);
    return transaction(
      "readwrite",
      (s) => {
        const keys = s.index("boardId").getAllKeys(id);
        keys.onsuccess = () => keys.result.forEach((key) => s.delete(key));
        return keys;
      },
      "revisions",
    );
  },
  // A caller that made `b` for this version alone says it is `owned`: it
  // is kept as it is rather than copied again. A version someone named, or
  // the one saved before a restoration, is `kept` until they delete it
  // rather than pruned like the versions each edit leaves.
  async checkpoint(
    b,
    label = "Board edit",
    { owned = false, kept = false } = {},
  ) {
    // Pruning needs each version's time and size, not its board: they are
    // read once and then kept here, since reading every version back on each
    // edit reads up to 50 MB per change. Another tab can add or remove
    // versions too, so the stored keys are checked each time, which reads no
    // version, and the list is read again when they differ.
    const keys = await transaction(
      "readonly",
      (s) => s.index("boardId").getAllKeys(b.id),
      "revisions",
    );
    let known = revisionIndex.get(b.id);
    if (
      !known ||
      known.ids.size !== keys.length ||
      !keys.every((key) => known.ids.has(key))
    ) {
      const list = (await local.revisions(b.id)).map((r) => ({
        id: r.id,
        created: r.created,
        bytes: r.bytes ?? JSON.stringify(r).length * 2,
        kept: keptRevision(r),
      }));
      known = { list, ids: new Set(list.map((r) => r.id)) };
      revisionIndex.set(b.id, known);
    }
    // A version is stamped after every version before it, so two written
    // within one millisecond still list and prune in the order they were
    // made, the newest kept.
    const latest = Math.max(0, ...known.list.map((r) => r.created));
    const snapshot = owned ? b : structuredClone(b),
      revision = {
        id: crypto.randomUUID(),
        boardId: b.id,
        created: Math.max(Date.now(), latest + 1),
        label,
        board: snapshot,
      };
    revision.kept = kept;
    // Record the size once so pruning does not re-serialize every version.
    revision.bytes = jsonLength(revision) * 2;
    known.list.push({
      id: revision.id,
      created: revision.created,
      bytes: revision.bytes,
      kept,
    });
    known.ids.add(revision.id);
    const all = known.list.sort((a, b) => b.created - a.created);
    // The newest 30 versions are kept, then one for each quarter hour of
    // the last 30 days (the latest in it), up to 200 more, so an earlier
    // stage of the work can still be restored after a burst of edits; all
    // within 50 MB, newest first. Named versions do not count among them:
    // the newest 100 are kept, within 50 MB of their own, and any beyond
    // that are pruned like the others.
    const over = () => {
      const quarter = (r) => Math.floor(r.created / (15 * 60_000)),
        since = revision.created - 30 * 86400_000,
        seen = new Set(),
        ids = [];
      let bytes = 0,
        keptBytes = 0,
        named = 0,
        recent = 0,
        older = 0;
      for (const [index, r] of all.entries()) {
        if (
          r.kept &&
          named < 100 &&
          (index === 0 || keptBytes + r.bytes <= REVISION_BYTES)
        ) {
          named++;
          keptBytes += r.bytes;
          continue;
        }
        let keep =
          recent++ < 30 ||
          (r.created > since && !seen.has(quarter(r)) && older++ < 200);
        if (keep) {
          bytes += r.bytes;
          if (index > 0 && bytes > REVISION_BYTES) keep = false;
        }
        if (keep) seen.add(quarter(r));
        else ids.push(r.id);
      }
      return ids;
    };
    const drop = async (ids) => {
      if (!ids.length) return;
      await transaction(
        "readwrite",
        (s) => ids.map((id) => s.delete(id)).at(-1),
        "revisions",
      );
      const gone = new Set(ids);
      known.list = known.list.filter((r) => !gone.has(r.id));
      for (const id of gone) known.ids.delete(id);
    };
    // Older versions go before the new one is written: a store that is
    // full can then take it, where writing first would fail and never free
    // anything. The newest version so far stays until the new one is
    // written, so a write that fails never leaves the board without one.
    const previous = all[1]?.id;
    await drop(over().filter((id) => id !== previous));
    try {
      await transaction("readwrite", (s) => s.put(revision), "revisions");
    } catch (error) {
      known.list = known.list.filter((r) => r.id !== revision.id);
      known.ids.delete(revision.id);
      throw error;
    }
    await drop(over().filter((id) => id === previous));
    return revision;
  },
};
// A drawing's points, shared by the board's copies and never changed in
// place, are counted once rather than for each recovery version.
const pointLengths = new WeakMap();
// How many characters a value takes as JSON, counted without writing it
// out: a board with pictures is megabytes of text for each edit. Characters
// JSON escapes, as quotes and line breaks in text, count once.
function jsonLength(value) {
  switch (typeof value) {
    case "string":
      return value.length + 2;
    case "number":
      return Number.isFinite(value) ? String(value).length : 4;
    case "boolean":
      return value ? 4 : 5;
    case "object": {
      if (value === null) return 4;
      if (Array.isArray(value)) {
        let n = value.length + 1 || 2;
        for (const v of value)
          n += v === undefined || typeof v === "function" ? 4 : jsonLength(v);
        return n;
      }
      let n = 1,
        fields = 0;
      for (const key of Object.keys(value)) {
        const v = value[key];
        if (v === undefined || typeof v === "function") continue;
        let length;
        if (key === "points" && sharedPoints(v)) {
          length = pointLengths.get(v);
          if (length === undefined)
            pointLengths.set(v, (length = jsonLength(v)));
        } else length = jsonLength(v);
        n += key.length + 3 + length;
        fields++;
      }
      return n + (fields || 1);
    }
    default:
      return 0;
  }
}
const missing = (e) =>
  ["subject_does_not_exist", "ENOENT", "not_found"].includes(e.code);
const uuidPattern = /^[a-f\d-]{36}$/;
export class CloudStore {
  constructor(puter) {
    this.puter = puter;
    this.queue = Promise.resolve();
    this.catalog = null;
    this.catalogRequest = null;
  }
  // A small file index avoids reading every board (and embedded image) to list titles.
  // It is updated only for new boards and renamed boards, never for pointer movement.
  loadCatalog() {
    if (this.catalog) return Promise.resolve(this.catalog);
    this.catalogRequest ||= this.readCatalog().finally(() => {
      this.catalogRequest = null;
    });
    return this.catalogRequest;
  }
  async readCatalog() {
    let text;
    try {
      text = await (await this.puter.fs.read("whiteboard/catalog.json")).text();
    } catch (e) {
      if (!missing(e)) throw e;
      // Recover older files if the index was never written or its first write failed.
      return (this.catalog = await this.recoverCatalog());
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {}
    const valid = (b) =>
      typeof b?.id === "string" &&
      uuidPattern.test(b.id) &&
      typeof b.title === "string";
    if (!Array.isArray(data) || !data.every(valid))
      // The rows that are still sound go with the error, so a save can
      // rebuild the index around them.
      throw Object.assign(
        Error("The cloud board index is invalid. Your files remain in Puter."),
        { rows: Array.isArray(data) ? data.filter(valid) : [] },
      );
    return (this.catalog = data);
  }
  // The board files in the folder that `rows` does not list yet.
  async recoverCatalog(rows = []) {
    let files;
    try {
      files = await this.puter.fs.readdir("whiteboard");
    } catch (error) {
      if (!missing(error)) throw error;
      files = [];
    }
    const listed = new Set(rows.map((b) => b.id));
    return [
      ...rows,
      ...files
        .filter(
          (f) =>
            !f.is_dir &&
            uuidPattern.test(f.name.replace(/\.json$/, "")) &&
            f.name.endsWith(".json") &&
            !listed.has(f.name.slice(0, -5)),
        )
        .map((f) => ({ id: f.name.slice(0, -5), title: "Recovered board" })),
    ];
  }
  async list() {
    return (await this.loadCatalog()).map((b) => ({
      name: b.id + ".json",
      title: b.title,
      path: "whiteboard/" + b.id + ".json",
    }));
  }
  async read(path) {
    return validateBoard(
      JSON.parse(await (await this.puter.fs.read(path)).text()),
    );
  }
  save(b) {
    const snapshot = JSON.stringify(b);
    const id = b.id,
      title = b.title;
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        if (!uuidPattern.test(id)) throw Error("Invalid board identifier.");
        // The board is written before its index entry: an index that cannot
        // be read or written leaves the board saved, and a later save adds
        // the entry.
        await this.puter.fs.write(`whiteboard/${id}.json`, snapshot, {
          createMissingParents: true,
          overwrite: true,
        });
        try {
          const catalog = await this.loadCatalog().catch(() => null);
          if (
            catalog?.some((entry) => entry.id === id && entry.title === title)
          )
            return;
          // Other devices and tabs add and rename boards too. The index is
          // read again just before it is rewritten so their entries stay,
          // instead of the copy read when this session began replacing them.
          // A damaged index is rebuilt from its sound rows and the files.
          const stored = await this.readCatalog().catch((e) =>
            e.rows ? this.recoverCatalog(e.rows) : catalog,
          );
          if (!stored) return;
          const next = [
            ...stored.filter((entry) => entry.id !== id),
            { id, title },
          ];
          await this.puter.fs.write(
            "whiteboard/catalog.json",
            JSON.stringify(next),
            { createMissingParents: true, overwrite: true },
          );
          this.catalog = next;
        } catch {}
      });
    this.queue = task;
    return task;
  }
}
