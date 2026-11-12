/**
 * Local copies of shared documents on this device: the last confirmed
 * state and the edits not yet confirmed by the server, so work survives a
 * lost connection or a reload and is sent when the connection returns.
 * IndexedDB in browsers; an in-memory store elsewhere (tests).
 */
const DB = 'vector-studio-collab';
const STORE = 'rooms';

function idb() {
  return typeof indexedDB !== 'undefined' && indexedDB ? indexedDB : null;
}

let dbPromise = null;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = idb().open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/**
 * A room is kept as two rows written together: the confirmed state (large,
 * changed only when the server orders batches) and the rest (the edits not
 * yet confirmed, small, changed on every local edit). put() with no `state`
 * leaves the stored state as it is, so a local edit writes only its own row.
 * get() returns them as one { seq, state, pending, ... }.
 */
const STATE = '#state';

function splitRow(value) {
  const { state, seq, ...rest } = value;
  return { meta: { ...rest, split: true }, state: state === undefined ? null : { seq, state } };
}

function joined(meta, state) {
  if (!meta) return null;
  if (!meta.split) return meta; // kept by an older release in one row
  const { split, ...rest } = meta;
  return state ? { ...rest, seq: state.seq, state: state.state } : rest;
}

export function memoryOutbox() {
  const rows = new Map();
  const copy = (v) => (v === undefined ? null : structuredClone(v));
  return {
    rows,
    async get(key) {
      return joined(copy(rows.get(key)), copy(rows.get(key + STATE)));
    },
    async put(key, value) {
      const { meta, state } = splitRow(value);
      if (state) rows.set(key + STATE, structuredClone(state));
      rows.set(key, structuredClone(meta));
    },
    async delete(key) {
      rows.delete(key);
      rows.delete(key + STATE);
    },
  };
}

export function indexedOutbox() {
  return {
    get: async (key) => {
      let meta = null;
      let state = null;
      await tx('readonly', (s) => {
        const a = s.get(key);
        const b = s.get(key + STATE);
        a.onsuccess = () => (meta = a.result ?? null);
        b.onsuccess = () => (state = b.result ?? null);
      });
      return joined(meta, state);
    },
    // One transaction: the state and the edits on top of it are never stored out of step.
    put: (key, value) =>
      tx('readwrite', (s) => {
        const { meta, state } = splitRow(value);
        if (state) s.put(state, key + STATE);
        s.put(meta, key);
      }),
    delete: (key) =>
      tx('readwrite', (s) => {
        s.delete(key);
        s.delete(key + STATE);
      }),
  };
}

/** The store for this environment (falls back to memory when IndexedDB is unavailable). */
export function defaultOutbox() {
  if (!idb()) return memoryOutbox();
  const store = indexedOutbox();
  const memory = memoryOutbox();
  // Private browsing can refuse IndexedDB: keep working in memory then.
  const guard = (name) => async (...args) => {
    try {
      return await store[name](...args);
    } catch {
      return memory[name](...args);
    }
  };
  return { get: guard('get'), put: guard('put'), delete: guard('delete') };
}

export const outboxKey = (server, room, user) => `${server}|${room}|${user || ''}`;
