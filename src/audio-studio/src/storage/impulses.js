// Impulse responses loaded into Convolution and Surround Reverb, kept in
// IndexedDB on this device so a reload (or a saved rack, favorite or
// session that names one) finds them again. Records are
// { name, rate, channels: Float32Array[], savedAt }; the newest MAX_KEPT
// stay, matching what the reverbs hold in memory.

import { setLoadedImpulse, MAX_LOADED_IMPULSES } from '../effects/defs/reverb-impulses.js';

const DB = 'audio-studio-impulses';
const STORE = 'impulses';
export const MAX_KEPT = MAX_LOADED_IMPULSES;

/** IndexedDB backend: getAll(), put(record), delete(name). */
export function idbBackend() {
  const open = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => {
        d.close();
        resolve(req?.result);
      };
      // A failed request fires `error`; a quota or other failure at commit only
      // `abort`. Either settles the promise, so callers never wait forever.
      const fail = () => {
        d.close();
        reject(t.error || new Error('The impulse storage could not be written.'));
      };
      t.onerror = fail;
      t.onabort = fail;
    });
  };
  return {
    getAll: () => tx('readonly', (s) => s.getAll()),
    put: (rec) => tx('readwrite', (s) => s.put(rec)),
    delete: (name) => tx('readwrite', (s) => s.delete(name)),
  };
}

/** An in-memory backend (tests, and browsers without IndexedDB). */
export function memoryBackend() {
  const map = new Map();
  return {
    getAll: async () => [...map.values()].map((r) => ({ ...r, channels: r.channels.map((c) => c.slice()) })),
    put: async (rec) => void map.set(rec.name, { ...rec, channels: rec.channels.map((c) => c.slice()) }),
    delete: async (name) => void map.delete(name),
  };
}

let backend = typeof indexedDB !== 'undefined' ? idbBackend() : memoryBackend();

/** Swaps the storage (tests). */
export function setImpulseBackend(b) {
  backend = b;
}

/** Stores a loaded impulse, dropping the oldest beyond MAX_KEPT. Never throws. */
export async function saveImpulse(name, impulse, now = Date.now()) {
  try {
    await backend.put({ name, rate: impulse.rate, channels: impulse.channels.map((c) => Float32Array.from(c)), savedAt: now });
    const all = (await backend.getAll()).sort((a, b) => b.savedAt - a.savedAt);
    for (const old of all.slice(MAX_KEPT)) await backend.delete(old.name);
    return true;
  } catch {
    return false;
  }
}

/** Stored impulses, newest first: [{ name, rate, channels, savedAt }]. */
export async function storedImpulses() {
  try {
    return ((await backend.getAll()) || []).filter((r) => r?.name && r.rate > 0 && r.channels?.length).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/** Forgets a stored impulse. */
export async function forgetImpulse(name) {
  try {
    await backend.delete(name);
  } catch {
    // Nothing stored under that name.
  }
}

/**
 * Loads the stored impulses into the reverbs (oldest first, so the newest
 * stay when memory is full). Resolves the names restored.
 */
export async function restoreImpulses() {
  const list = await storedImpulses();
  for (const r of list.slice().reverse()) setLoadedImpulse(r.name, { rate: r.rate, channels: r.channels });
  return list.map((r) => r.name);
}
