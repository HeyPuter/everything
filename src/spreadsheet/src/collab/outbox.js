/**
 * Changes made to a shared workbook that the room has not confirmed yet, kept in this browser (IndexedDB) so
 * that edits made offline survive a reload and are sent when the workbook is next opened. One record per
 * account and room, under outboxKey: { room, user, rev, pending: [{ id, label, ops }], at }, where `rev` is the
 * room revision the pending changes apply on top of. Each account's unsent changes are its own: another account
 * signed in on this browser never reads them (they would go to the room as that account's), and signing out
 * removes them (clearOutbox). A memory store stands in where IndexedDB is missing (and in tests).
 */

const DB = 'spreadsheet-collab';
const STORE = 'outbox';

/** Where an account's unsent changes to a room are kept. */
export const outboxKey = (user, room) => `${user}:${room}`;

export function memoryOutbox() {
  const rows = new Map();
  return {
    durable: false, // gone with the page
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async get(key) { return rows.has(key) ? structuredClone(rows.get(key)) : null; },
    async delete(key) { rows.delete(key); },
    async all() { return [...rows.values()].map((v) => structuredClone(v)); },
    async sweep(fn) { for (const [key, value] of [...rows]) if (fn(value)) rows.delete(key); },
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
  // Remove every record `fn` picks.
  const sweep = async (fn) => {
    const req = (await db()).transaction(STORE, 'readwrite').objectStore(STORE).openCursor();
    await new Promise((resolve, reject) => {
      req.onsuccess = () => { const c = req.result; if (!c) { resolve(); return; } if (fn(c.value)) c.delete(); c.continue(); };
      req.onerror = () => reject(req.error);
    });
  };
  const fallback = memoryOutbox();
  // Once IndexedDB refuses (a full disk, a private window of some browsers), what is kept goes with the page.
  let durable = true;
  const guard = (fn, alt) => async (...args) => { try { return await fn(...args); } catch { durable = false; return alt(...args); } };
  return {
    /** Whether what is kept here survives the page: a reload or a closed tab. */
    get durable() { return durable; },
    put: guard((key, value) => run('readwrite', (s) => s.put(value, key)), fallback.put),
    get: guard(async (key) => (await run('readonly', (s) => s.get(key))) ?? null, fallback.get),
    delete: guard((key) => run('readwrite', (s) => s.delete(key)), fallback.delete),
    all: guard(() => run('readonly', (s) => s.getAll()), fallback.all),
    sweep: guard(sweep, fallback.sweep),
  };
}

/**
 * Signing out: the account's unsent changes leave this browser, as its drafts do (see account-storage.js), with
 * any record that names no account (kept before records did). Without `user` (the account is not known), all go.
 */
export function clearOutbox(user, store = browserOutbox()) {
  return store.sweep((r) => !user || !r?.user || r.user === user);
}
