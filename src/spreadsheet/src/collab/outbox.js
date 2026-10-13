/**
 * Changes made to a shared workbook that the room has not confirmed yet, kept in this browser (IndexedDB) so
 * that edits made offline survive a reload and are sent when the workbook is next opened. One record per room
 * and tab: { room, tab, rev, pending: [{ id, label, ops }], at }, where `rev` is the room revision the pending
 * changes apply on top of. A memory store stands in where IndexedDB is missing (and in tests).
 */

const DB = 'spreadsheet-collab';
const STORE = 'outbox';

export function memoryOutbox() {
  const rows = new Map();
  return {
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async get(key) { return rows.has(key) ? structuredClone(rows.get(key)) : null; },
    async delete(key) { rows.delete(key); },
    async all() { return [...rows.values()].map((v) => structuredClone(v)); },
  };
}

function request(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

/** The IndexedDB outbox, or a memory one when this browser has none (private windows of some browsers). */
export function browserOutbox() {
  if (typeof indexedDB === 'undefined') return memoryOutbox();
  let opened = null;
  const db = () => (opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (mode, fn) => {
    const tx = (await db()).transaction(STORE, mode);
    return request(fn(tx.objectStore(STORE)));
  };
  const fallback = memoryOutbox();
  const guard = (fn, alt) => async (...args) => { try { return await fn(...args); } catch { return alt(...args); } };
  return {
    put: guard((key, value) => run('readwrite', (s) => s.put(value, key)), fallback.put),
    get: guard(async (key) => (await run('readonly', (s) => s.get(key))) ?? null, fallback.get),
    delete: guard((key) => run('readwrite', (s) => s.delete(key)), fallback.delete),
    all: guard(() => run('readonly', (s) => s.getAll()), fallback.all),
  };
}
