/**
 * Storage for the fake Puter (dev/fake-puter.js): tables of key -> value.
 * memoryStorage() backs the unit tests; idbStorage() backs the browser
 * harness, where several tabs (an owner and reviewers) share one IndexedDB
 * database the way they would share Puter's servers. update() is atomic in
 * both, which is what KV incr and partial field updates need.
 */

export const TABLES = ['kv', 'files', 'tokens', 'workers', 'mints'];

export function memoryStorage() {
  const tables = new Map(TABLES.map((t) => [t, new Map()]));
  return {
    kind: 'memory',
    tables,
    async get(table, key) {
      return tables.get(table).get(key) ?? null;
    },
    async put(table, key, value) {
      tables.get(table).set(key, value);
    },
    async del(table, key) {
      tables.get(table).delete(key);
    },
    async update(table, key, fn) {
      const next = fn(tables.get(table).get(key) ?? null);
      if (next === undefined) tables.get(table).delete(key);
      else tables.get(table).set(key, next);
      return next;
    },
    async keys(table) {
      return [...tables.get(table).keys()];
    },
  };
}

const DB_NAME = 'video-studio-fake-puter';

export function openDb(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      for (const t of TABLES) if (!req.result.objectStoreNames.contains(t)) req.result.createObjectStore(t);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbStorage(name = DB_NAME) {
  const db = openDb(name);
  const run = async (table, mode, body) => {
    const d = await db;
    return new Promise((resolve, reject) => {
      const tx = d.transaction(table, mode);
      const store = tx.objectStore(table);
      let result;
      body(store, (v) => (result = v));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    kind: 'idb',
    get: (table, key) => run(table, 'readonly', (s, done) => {
      const r = s.get(key);
      r.onsuccess = () => done(r.result ?? null);
    }),
    put: (table, key, value) => run(table, 'readwrite', (s) => s.put(value, key)),
    del: (table, key) => run(table, 'readwrite', (s) => s.delete(key)),
    // Read and write in one transaction, so two tabs never interleave.
    update: (table, key, fn) => run(table, 'readwrite', (s, done) => {
      const r = s.get(key);
      r.onsuccess = () => {
        const next = fn(r.result ?? null);
        if (next === undefined) s.delete(key);
        else s.put(next, key);
        done(next);
      };
    }),
    keys: (table) => run(table, 'readonly', (s, done) => {
      const r = s.getAllKeys();
      r.onsuccess = () => done(r.result);
    }),
    async clear() {
      const d = await db;
      d.close();
      await new Promise((resolve) => {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = r.onerror = r.onblocked = () => resolve();
      });
    },
  };
}

/** The parts of a fake token-read URL the harness answers. */
export function parseTokenRead(url, apiOrigin) {
  const u = new URL(url);
  if (u.origin !== apiOrigin || u.pathname !== '/token-read') return null;
  return { uid: u.searchParams.get('uid'), token: u.searchParams.get('token') };
}

/**
 * Answer a token-read request the way Puter's /token-read does: the token
 * must be live and allow reading that file; a Range header gets a 206 with
 * Content-Range, otherwise the whole file with 200.
 */
export async function answerTokenRead(storage, { uid, token }, rangeHeader, now = Date.now()) {
  const fail = (status, message) => new Response(JSON.stringify({ message }), { status, headers: { 'Content-Type': 'application/json' } });
  const t = token ? await storage.get('tokens', token) : null;
  if (!t || t.revoked || t.exp * 1000 <= now || t.uid !== uid) return fail(401, 'Token authentication failed');
  const file = await storage.get('files', t.path);
  if (!file || file.uid !== uid) return fail(404, 'Not found');
  const blob = file.blob;
  const size = blob.size;
  const headers = { 'Content-Type': file.mime || 'application/octet-stream', 'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"` };
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  // Bytes rather than the Blob itself: a Blob from another realm (jsdom in tests) is not a body type everywhere.
  const bytes = async (b) => new Uint8Array(await b.arrayBuffer());
  if (!m) return new Response(await bytes(blob), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]));
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  start = Math.max(0, start);
  end = Math.max(start, end);
  return new Response(await bytes(blob.slice(start, end + 1)), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } });
}
