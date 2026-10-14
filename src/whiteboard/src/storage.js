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
    let req;
    try {
      req = fn(tx.objectStore(store));
    } catch (error) {
      // Whatever the transaction did before the failure is not kept either.
      try {
        tx.abort();
      } catch {}
      throw error;
    }
    tx.oncomplete = () => resolve(req?.result);
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
// Pictures and attached files are kept in a board as data URLs, megabytes
// each, and stay the same from one version to the next. A version keeps
// each one longer than this once, under a hash of it, and refers to it
// there: a copy in every version left a board with pictures only a few
// versions within the budget.
const MEDIA_CHARS = 16 * 1024;
const isMedia = (value) =>
  value.length >= MEDIA_CHARS && value.startsWith("data:");
// A reference takes the place of the data in the version as written, so it
// counts as that many characters.
const HASH_CHARS = 64;
// The hash of each picture seen lately, so one is hashed once rather than
// on every edit: comparing a string with the one it was copied from is
// cheap, where hashing megabytes is not. Past a total length the ones used
// longest ago are let go, never those of the version being written.
const mediaHashes = new Map();
const HASHED_CHARS = 128 * 1024 * 1024;
let hashedChars = 0,
  hashRound = 0;
function rememberHash(data, hash) {
  if (mediaHashes.has(data)) mediaHashes.delete(data);
  else hashedChars += data.length;
  mediaHashes.set(data, { hash, round: hashRound });
  for (const [old, { round }] of mediaHashes) {
    if (hashedChars <= HASHED_CHARS || round === hashRound) break;
    mediaHashes.delete(old);
    hashedChars -= old.length;
  }
}
function mediaHash(data) {
  let hash = mediaHashes.get(data)?.hash;
  if (hash === undefined)
    hash = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(data))
      .then((digest) =>
        Array.from(new Uint8Array(digest), (n) =>
          n.toString(16).padStart(2, "0"),
        ).join(""),
      )
      .catch((error) => {
        if (mediaHashes.get(data)?.hash === hash) {
          mediaHashes.delete(data);
          hashedChars -= data.length;
        }
        throw error;
      });
  rememberHash(data, hash);
  return hash;
}
// What a version takes beyond what the versions kept before it do: each
// picture counts once among the versions kept, however many of them show
// it. Data URLs are plain ASCII, written at one byte a character.
const extraBytes = (r, counted) => {
  let bytes = r.bytes;
  r.media?.forEach((hash, n) => {
    if (!counted.has(hash)) bytes += r.mediaBytes[n];
  });
  return bytes;
};
const countMedia = (r, counted) =>
  r.media?.forEach((hash) => counted.add(hash));
// Puts each picture a version refers to back in its place. Versions sharing
// a picture share the one string read for it.
function withMedia(r, media) {
  for (const path of r.mediaAt || []) {
    let at = r.board;
    for (const key of path.slice(0, -1)) at = at?.[key];
    const data = at && media.get(at[path.at(-1)]);
    if (data !== undefined) at[path.at(-1)] = data;
  }
  delete r.media;
  delete r.mediaBytes;
  delete r.mediaAt;
  return r;
}
// Pictures are kept in the versions store, beside the versions, rather than
// in a store of their own: adding a store takes a newer database version,
// which a tab still running the release before can then no longer open, and
// every save there would fail. Each picture is one row, and which versions
// use it another, small enough to rewrite with each version where the
// picture is not. Neither has a board, so a board's versions as its index
// lists them, in this release or the one before, never include them.
const mediaId = (hash) => `media:${hash}`,
  usersId = (hash) => `media-users:${hash}`;
// Notes that version `id` uses these pictures, writing any not kept yet. It
// runs in the transaction that writes the version; transactions writing one
// store never overlap, so another tab removing the last version that used a
// picture does so wholly before, and the picture is written again, or after,
// and finds this version among its users.
function useMedia(s, id, hashes, data) {
  for (const hash of hashes) {
    const read = s.get(usersId(hash));
    read.onsuccess = () => {
      const row = read.result;
      if (!row) {
        s.put({ id: mediaId(hash), data: data(hash) });
        s.put({ id: usersId(hash), users: [id] });
      } else if (!row.users.includes(id))
        s.put({ ...row, users: [...row.users, id] });
    };
  }
}
// Notes that versions no longer use pictures, `gone` holding the versions
// for each, and removes the pictures no version uses any more; in the
// transaction that removes the versions.
function releaseMedia(s, gone) {
  for (const [hash, ids] of gone) {
    const read = s.get(usersId(hash));
    read.onsuccess = () => {
      const row = read.result;
      if (!row) return;
      const users = row.users.filter((user) => !ids.has(user));
      if (users.length) s.put({ ...row, users });
      else {
        s.delete(usersId(hash));
        s.delete(mediaId(hash));
      }
    };
  }
}
// Each picture these versions use, with the versions that use it.
function mediaOf(versions) {
  const gone = new Map();
  for (const r of versions)
    for (const hash of r.media || []) {
      if (!gone.has(hash)) gone.set(hash, new Set());
      gone.get(hash).add(r.id);
    }
  return gone;
}
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
  // Every version of one board, each with its board whole. Pruning needs
  // only each version's size and pictures, so it asks for them `bare`: as
  // written, the pictures left where they are kept.
  revisions: (id, { bare = false } = {}) => {
    let list;
    const media = new Map();
    return transaction(
      "readonly",
      (s) => {
        const read = s.index("boardId").getAll(id);
        read.onsuccess = () => {
          list = read.result;
          if (bare) return;
          for (const hash of new Set(list.flatMap((r) => r.media || []))) {
            const get = s.get(mediaId(hash));
            get.onsuccess = () => {
              if (!get.result) return;
              media.set(hash, get.result.data);
              // A version restored brings this copy into the board, which
              // then needs no hashing again.
              rememberHash(get.result.data, hash);
            };
          }
        };
        return read;
      },
      "revisions",
    ).then(() => (bare ? list : list.map((r) => withMedia(r, media))));
  },
  templates: () => transaction("readonly", (s) => s.getAll(), "templates"),
  saveTemplate: (b) => transaction("readwrite", (s) => s.put(b), "templates"),
  removeTemplate: (id) =>
    transaction("readwrite", (s) => s.delete(id), "templates"),
  // Every recovery version of one board, as when it leaves the trash for
  // good, and the pictures only they used. A tab still running the release
  // before prunes versions without noting it beside their pictures, so
  // every picture's users are checked against the versions left.
  removeRevisions: (id) => {
    revisionIndex.delete(id);
    return transaction(
      "readwrite",
      (s) => {
        const keys = s.index("boardId").getAllKeys(id);
        keys.onsuccess = () => {
          keys.result.forEach((key) => s.delete(key));
          const left = s.getAllKeys();
          left.onsuccess = () => {
            const versions = new Set(left.result);
            for (const key of left.result) {
              if (typeof key !== "string" || !key.startsWith("media-users:"))
                continue;
              const read = s.get(key);
              read.onsuccess = () => {
                const row = read.result,
                  users = row.users.filter((user) => versions.has(user));
                if (users.length === row.users.length) return;
                if (users.length) s.put({ ...row, users });
                else {
                  s.delete(key);
                  s.delete(mediaId(key.slice("media-users:".length)));
                }
              };
            }
          };
        };
        return keys;
      },
      "revisions",
    );
  },
  // Names one version, which keeps it apart from those each edit leaves.
  nameRevision: (id, label) => {
    // Pruning reads whether a version is kept from what it last read.
    for (const known of revisionIndex.values()) {
      const entry = known.list.find((r) => r.id === id);
      if (entry) entry.kept = true;
    }
    return transaction(
      "readwrite",
      (s) => {
        const get = s.get(id);
        get.onsuccess = () => {
          if (get.result) s.put({ ...get.result, label, kept: true });
        };
        return get;
      },
      "revisions",
    );
  },
  // One version, and the pictures only it used.
  removeRevision: (id) =>
    transaction(
      "readwrite",
      (s) => {
        const get = s.get(id);
        get.onsuccess = () => {
          if (!get.result) return;
          s.delete(id);
          releaseMedia(s, mediaOf([get.result]));
        };
        return get;
      },
      "revisions",
    ),
  // A caller that made `b` for this version alone says it is `owned`: it
  // is kept as it is rather than copied again. A version someone named, or
  // the one saved before a restoration, is `kept` until they delete it
  // rather than pruned like the versions each edit leaves. A version that
  // `replaces` another, as one holding the latest of edits still coming
  // does, takes its place under its id.
  async checkpoint(
    b,
    label = "Board edit",
    { owned = false, kept = false, replaces = null } = {},
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
      const list = (await local.revisions(b.id, { bare: true })).map((r) => ({
        id: r.id,
        created: r.created,
        bytes: r.bytes ?? JSON.stringify(r).length * 2,
        kept: keptRevision(r),
        media: r.media,
        mediaBytes: r.mediaBytes,
      }));
      known = { list, ids: new Set(list.map((r) => r.id)) };
      revisionIndex.set(b.id, known);
    }
    // The board is measured as it is written, each picture by its
    // reference, while the walk finds them.
    const snapshot = owned ? b : structuredClone(b),
      found = globalThis.crypto?.subtle ? [] : null,
      boardLength = jsonLength(snapshot, found, []);
    hashRound++;
    const hashes = found?.length
      ? await Promise.all(found.map((f) => mediaHash(f.data)))
      : [];
    let replaced =
      replaces != null && known.list.find((r) => r.id === replaces);
    // A version named since it was written, as someone may name the one
    // holding refused edits, is kept as named: this one goes beside it.
    if (replaced) {
      const row = await transaction(
        "readonly",
        (s) => s.get(replaced.id),
        "revisions",
      );
      if (row && row.label !== label) {
        replaced.kept = keptRevision(row);
        replaced = null;
      }
    }
    if (replaced) known.list = known.list.filter((r) => r !== replaced);
    // A version is stamped after every version before it, so two written
    // within one millisecond still list and prune in the order they were
    // made, the newest kept.
    const latest = Math.max(0, ...known.list.map((r) => r.created));
    const revision = {
      id: replaced ? replaced.id : crypto.randomUUID(),
      boardId: b.id,
      created: Math.max(Date.now(), latest + 1),
      label,
      board: snapshot,
    };
    revision.kept = kept;
    const written = found?.length
      ? withReferences(revision, found, hashes)
      : revision;
    // Record the size once so pruning does not re-serialize every version.
    written.bytes =
      (jsonLength({ ...written, board: 0 }) - 1 + boardLength) * 2;
    known.list.push({
      id: written.id,
      created: written.created,
      bytes: written.bytes,
      kept,
      media: written.media,
      mediaBytes: written.mediaBytes,
    });
    known.ids.add(written.id);
    const all = known.list.sort((a, b) => b.created - a.created);
    // The newest 30 versions are kept, then one for each quarter hour of
    // the last 30 days (the latest in it), up to 200 more, so an earlier
    // stage of the work can still be restored after a burst of edits; all
    // within 50 MB, each picture counted once. Named versions do not count
    // among them: the newest 100 are kept, within 50 MB of their own, and
    // any beyond that are pruned like the others.
    const over = () => {
      const quarter = (r) => Math.floor(r.created / (15 * 60_000)),
        since = written.created - 30 * 86400_000,
        seen = new Set(),
        keptCounted = new Set(),
        // The versions to keep, by what the budget goes to first when they
        // do not all fit: the newest version, then the latest of each day,
        // then the newest 30, then the latest of each hour, then the other
        // quarter hours. On a large board a minute of small edits would
        // otherwise take it all and leave nothing from the days before.
        ranked = [[], [], [], [], []],
        ids = [];
      let keptBytes = 0,
        named = 0,
        recent = 0,
        older = 0,
        lastDay,
        lastHour;
      for (const [index, r] of all.entries()) {
        if (r.kept && named < 100) {
          const cost = extraBytes(r, keptCounted);
          if (index === 0 || keptBytes + cost <= REVISION_BYTES) {
            named++;
            keptBytes += cost;
            countMedia(r, keptCounted);
            continue;
          }
        }
        const isRecent = recent++ < 30;
        if (
          !isRecent &&
          !(r.created > since && !seen.has(quarter(r)) && older++ < 200)
        ) {
          ids.push(r.id);
          continue;
        }
        seen.add(quarter(r));
        // Newest first, so the first of a day or an hour is its latest.
        const day = (r.day ??= new Date(r.created).toDateString()),
          hour = Math.floor(r.created / 3_600_000),
          latestOfDay = day !== lastDay && r.created > since,
          latestOfHour = hour !== lastHour;
        lastDay = day;
        lastHour = hour;
        ranked[
          index === 0
            ? 0
            : latestOfDay
              ? 1
              : isRecent
                ? 2
                : latestOfHour
                  ? 3
                  : 4
        ].push(r);
      }
      const counted = new Set();
      let bytes = 0;
      for (const [rank, list] of ranked.entries())
        for (const r of list) {
          const cost = extraBytes(r, counted);
          if (rank > 0 && bytes + cost > REVISION_BYTES) ids.push(r.id);
          else {
            bytes += cost;
            countMedia(r, counted);
          }
        }
      return ids;
    };
    // Each version is read back before it goes: one named in another tab
    // since this tab read the list is kept, and the list learns it is.
    const drop = async (ids) => {
      if (!ids.length) return;
      const listed = new Map(known.list.map((r) => [r.id, r])),
        gone = new Set(),
        named = new Set();
      await transaction(
        "readwrite",
        (s) => {
          const rows = [];
          let read;
          for (const id of ids) {
            read = s.get(id);
            const request = read;
            request.onsuccess = () => {
              rows.push([id, request.result]);
              if (rows.length < ids.length) return;
              // Pictures are let go in one pass, so versions sharing one
              // do not each rewrite its list of users from the same read.
              const dropped = [];
              for (const [id, row] of rows) {
                if (row && keptRevision(row) && !listed.get(id)?.kept) {
                  named.add(id);
                  continue;
                }
                s.delete(id);
                gone.add(id);
                dropped.push({
                  id,
                  media: row?.media ?? listed.get(id)?.media,
                });
              }
              releaseMedia(s, mediaOf(dropped));
            };
          }
          return read;
        },
        "revisions",
      );
      for (const id of named) listed.get(id).kept = true;
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
      // Each picture is written with the first version to use it, and
      // after that only referred to.
      await transaction(
        "readwrite",
        (s) => {
          const put = s.put(written);
          useMedia(
            s,
            written.id,
            written.media || [],
            (hash) => found.find((f) => f.hash === hash).data,
          );
          if (replaced)
            releaseMedia(
              s,
              mediaOf([
                {
                  id: replaced.id,
                  media: replaced.media?.filter(
                    (hash) => !written.media?.includes(hash),
                  ),
                },
              ]),
            );
          return put;
        },
        "revisions",
      );
    } catch (error) {
      // A version this one was to replace is still there.
      known.list = known.list.filter((r) => r.id !== written.id);
      if (replaced) known.list.push(replaced);
      else known.ids.delete(written.id);
      throw error;
    }
    await drop(over().filter((id) => id === previous));
    // The caller gets the version with its board whole.
    return written === revision ? revision : { ...written, board: snapshot };
  },
};
// The version as written: each picture found in its board is replaced by
// its hash, in copies of the objects that held it, the caller's board left
// as it is. `mediaAt` says where each one goes back.
function withReferences(revision, found, hashes) {
  const copies = new Set(),
    own = (value) => {
      if (copies.has(value)) return value;
      const copy = Array.isArray(value) ? value.slice() : { ...value };
      copies.add(copy);
      return copy;
    };
  const board = own(revision.board),
    sizes = new Map();
  found.forEach((f, n) => {
    f.hash = hashes[n];
    sizes.set(f.hash, f.data.length);
    let at = board;
    for (const key of f.path.slice(0, -1)) at = at[key] = own(at[key]);
    at[f.path.at(-1)] = f.hash;
  });
  return {
    ...revision,
    board,
    media: [...sizes.keys()],
    mediaBytes: [...sizes.values()],
    mediaAt: found.map((f) => f.path),
  };
}
// A drawing's points, shared by the board's copies and never changed in
// place, are counted once rather than for each recovery version.
const pointLengths = new WeakMap();
// How many characters a value takes as JSON, counted without writing it
// out: a board with pictures is megabytes of text for each edit. Characters
// JSON escapes, as quotes and line breaks in text, count once.
// Given `found`, a picture is counted as the reference that takes its place
// and noted there with its `path` from `value`.
function jsonLength(value, found, path) {
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
        for (let i = 0; i < value.length; i++) {
          const v = value[i];
          if (v === undefined || typeof v === "function") n += 4;
          else n += found ? nestedLength(v, i, found, path) : jsonLength(v);
        }
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
        } else
          length = found ? nestedLength(v, key, found, path) : jsonLength(v);
        n += key.length + 3 + length;
        fields++;
      }
      return n + (fields || 1);
    }
    default:
      return 0;
  }
}
// The length of `v`, held at `key` of the value at `path`, a picture noted.
function nestedLength(v, key, found, path) {
  if (typeof v === "string") {
    if (!isMedia(v)) return v.length + 2;
    found.push({ path: [...path, key], data: v });
    return HASH_CHARS + 2;
  }
  if (typeof v !== "object" || v === null) return jsonLength(v);
  path.push(key);
  const n = jsonLength(v, found, path);
  path.pop();
  return n;
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
