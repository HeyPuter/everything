// Library file store: the browser has no file paths, so every file data-blocks are linked from is
// kept here (IndexedDB) under a stable key, together with where it came from: a project of the
// Open Recent list (re-read from there, so saving that project again updates the links), a file
// handle from a folder (re-read from the folder) or just the copy taken when it was picked.
// Without IndexedDB (tests) the store lives in memory.
import { recentBytes } from '../io/session';

export interface StoredLibrary {
  key: string;
  name: string;
  /** where the file was found, for display */
  path: string;
  /** the latest bytes seen */
  bytes: Uint8Array;
  time: number;
  /** a project of the Open Recent list */
  recentName?: string;
  /** a file in a folder (File System Access handle; can be stored in IndexedDB) */
  handle?: FileSystemFileHandle;
}

const DB = 'p3d-libraries';
const STORE = 'files';
const memory = new Map<string, StoredLibrary>();

let dbPromise: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (!dbPromise)
    dbPromise = new Promise((res) => {
      if (typeof indexedDB === 'undefined') return res(null);
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((res) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req ? (req.result as T) : undefined);
    t.onerror = () => res(undefined);
    t.onabort = () => res(undefined);
  });
}

export async function getStored(key: string): Promise<StoredLibrary | undefined> {
  return memory.get(key) ?? (await tx<StoredLibrary>('readonly', (s) => s.get(key)));
}

export async function putStored(entry: StoredLibrary) {
  memory.set(entry.key, entry);
  await tx('readwrite', (s) => void s.put(entry, entry.key));
}

export async function listStored(): Promise<StoredLibrary[]> {
  const all = (await tx<StoredLibrary[]>('readonly', (s) => s.getAll())) ?? [];
  const byKey = new Map(all.map((e) => [e.key, e]));
  for (const [k, e] of memory) byKey.set(k, e);
  return [...byKey.values()].sort((a, b) => b.time - a.time);
}

export async function deleteStored(key: string) {
  memory.delete(key);
  await tx('readwrite', (s) => void s.delete(key));
}

/** Short fingerprint of a file's bytes (FNV-1a over the whole file plus its length). */
export function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return `${bytes.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

async function sameFile(a: FileSystemFileHandle, b: FileSystemFileHandle) {
  try {
    return a === b || (await a.isSameEntry(b));
  } catch {
    return false;
  }
}

/** Store (or update) a file the user picked to link from; returns its entry with a stable key. */
export async function rememberFile(name: string, bytes: Uint8Array, from: { recentName?: string; handle?: FileSystemFileHandle; path?: string }): Promise<StoredLibrary> {
  let key: string;
  if (from.recentName) key = `recent:${from.recentName}`;
  else if (from.handle) {
    const known = (await listStored()).find((e) => e.handle && e.name === name);
    key = known && (await sameFile(known.handle!, from.handle)) ? known.key : `file:${name}:${Date.now().toString(36)}`;
  } else key = `copy:${name}:${fingerprint(bytes)}`;
  const entry: StoredLibrary = { key, name, path: from.path ?? name, bytes, time: Date.now(), recentName: from.recentName, handle: from.handle };
  await putStored(entry);
  return entry;
}

/**
 * The newest bytes of a stored library: re-read from the Open Recent list or the folder when
 * possible (asking for folder access only when `prompt` is set), else the stored copy.
 */
export async function latestBytes(key: string, prompt = false): Promise<{ bytes: Uint8Array; entry: StoredLibrary } | null> {
  const entry = await getStored(key);
  if (!entry) return null;
  let fresh: Uint8Array | null = null;
  if (entry.recentName) fresh = await recentBytes(entry.recentName).catch(() => null);
  else if (entry.handle) {
    try {
      const h = entry.handle as FileSystemFileHandle & { queryPermission?(o: object): Promise<string>; requestPermission?(o: object): Promise<string> };
      let state = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted';
      if (state !== 'granted' && prompt) state = (await h.requestPermission?.({ mode: 'read' })) ?? state;
      if (state === 'granted') fresh = new Uint8Array(await (await h.getFile()).arrayBuffer());
    } catch {
      fresh = null;
    }
  }
  if (fresh && fingerprint(fresh) !== fingerprint(entry.bytes)) {
    entry.bytes = fresh;
    entry.time = Date.now();
    await putStored(entry);
  }
  return { bytes: entry.bytes, entry };
}
