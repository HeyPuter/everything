// This device's storage: a tiny promise wrapper over IndexedDB with one
// interface shared by an in-memory version (tests, and browsers where
// IndexedDB is blocked, such as some private windows).
//
//   const db = await openDB()            // IndexedDB, or memory when unavailable
//   await db.get(store, key) / put(store, key, value) / delete(store, key)
//   await db.all(store) -> [[key, value], ...]
//   db.persistent                        // false for the memory fallback
//
// Stores:
//   projects     key -> { key, name, modified, size }        local project list
//   projectData  key -> JSON string                          local project files
//   samples      id  -> { id, name, type, size, data: ArrayBuffer, path }
//                      imported audio bytes (path: its Puter copy, once uploaded)
//   drafts       'tab:<slot>' -> { json, file, dirty, at }    autosaved session per tab
//                (storage/tabs.js; 'session' is the shared key of older versions)

export const DB_NAME = 'music-studio';
export const DB_VERSION = 1;
export const STORES = ['projects', 'projectData', 'samples', 'drafts'];

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('Storage request failed.'));
  });

/** Opens the app database. Falls back to memory (with persistent=false) if IndexedDB fails. */
export async function openDB(name = DB_NAME) {
  const idb = globalThis.indexedDB;
  if (!idb) return memoryDB();
  try {
    const open = idb.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      for (const s of STORES) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s);
    };
    const db = await Promise.race([req(open), new Promise((_, reject) => setTimeout(() => reject(new Error('Storage timed out.')), 5000))]);
    return wrap(db);
  } catch (err) {
    console.warn('Music Studio: browser storage is unavailable, using memory only.', err);
    return memoryDB();
  }
}

function wrap(db) {
  const tx = (store, mode) => db.transaction(store, mode).objectStore(store);
  const done = (t) =>
    new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error || new Error('Could not save to this device. The browser storage may be full.'));
    });
  return {
    persistent: true,
    get: (store, key) => req(tx(store, 'readonly').get(key)).then((v) => v ?? null),
    async put(store, key, value) {
      const s = tx(store, 'readwrite');
      s.put(value, key);
      await done(s.transaction);
    },
    async delete(store, key) {
      const s = tx(store, 'readwrite');
      s.delete(key);
      await done(s.transaction);
    },
    async all(store) {
      const s = tx(store, 'readonly');
      const [keys, values] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
      return keys.map((k, i) => [k, values[i]]);
    },
    close: () => db.close(),
  };
}

/** Same interface, kept in memory (values are structured-cloned like IndexedDB does). */
export function memoryDB() {
  const stores = new Map(STORES.map((s) => [s, new Map()]));
  const get = (s) => {
    if (!stores.has(s)) stores.set(s, new Map());
    return stores.get(s);
  };
  const clone = (v) => (v === null || v === undefined ? null : structuredClone(v));
  return {
    persistent: false,
    stores,
    get: async (store, key) => clone(get(store).get(key)),
    put: async (store, key, value) => void get(store).set(key, clone(value)),
    delete: async (store, key) => void get(store).delete(key),
    all: async (store) => [...get(store)].map(([k, v]) => [k, clone(v)]),
    close() {},
  };
}
