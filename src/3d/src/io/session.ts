// Session files kept in the browser: recently opened/saved projects (Open Recent, Revert),
// the user's startup file (File ▸ Defaults ▸ Save Startup File) and timed autosave snapshots
// (File ▸ Recover ▸ Auto Save…). Everything lives in IndexedDB; failures degrade to no-ops.
import { app, onAppReady } from '../app/app';
import { prefs } from '../app/prefs';
import { encodeDocument, decodeDocument } from './native';
import { projectUiState, fileEvents } from './files';

import { bumpRecent, MAX_RECENT, type RecentEntry } from './recentlist';

export { MAX_RECENT, type RecentEntry };

export interface Snapshot {
  key: string;
  name: string;
  time: number;
  size: number;
}

const DB = 'p3d-session';
const FILES = 'files';
const KV = 'kv';
/** Larger files are listed in Open Recent only for this session. */
const MAX_STORED_BYTES = 96 * 1024 * 1024;
export const MAX_SNAPSHOTS = 5;

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise)
    dbPromise = new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') return rej(new Error('IndexedDB unavailable'));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(FILES);
        r.result.createObjectStore(KV);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  return dbPromise;
}

async function idb<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req ? (req.result as T) : undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

const get = <T>(store: string, key: string) => idb<T>(store, 'readonly', (s) => s.get(key)).catch(() => undefined);
const put = (store: string, key: string, value: unknown) => idb(store, 'readwrite', (s) => void s.put(value, key)).catch(() => undefined);
const del = (store: string, key: string) => idb(store, 'readwrite', (s) => void s.delete(key)).catch(() => undefined);

/** Small persistent key/value store for UI state (bookmarks, recent folders). */
export const kvGet = <T>(key: string) => get<T>(KV, `ui:${key}`);
export const kvSet = (key: string, value: unknown) => put(KV, `ui:${key}`, value);

// ---------------------------------------------------------------------------
// recent files

let recent: RecentEntry[] = [];
/** Bytes of recent files that could not be stored (too large), for this session only. */
const memoryFiles = new Map<string, Uint8Array>();
const listeners = new Set<() => void>();
export function onSessionChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((f) => f());

/** Most recently used first. */
export function recentFiles(): readonly RecentEntry[] {
  return recent;
}

export async function recordRecent(name: string, bytes: Uint8Array) {
  const { list, dropped } = bumpRecent(recent, { name, time: Date.now(), size: bytes.length });
  recent = list;
  notify();
  for (const n of dropped) {
    memoryFiles.delete(n);
    await del(FILES, n);
  }
  if (bytes.length > MAX_STORED_BYTES) memoryFiles.set(name, bytes);
  else {
    memoryFiles.delete(name);
    await put(FILES, name, bytes);
  }
  await put(KV, 'recent', recent);
}

export async function recentBytes(name: string): Promise<Uint8Array | null> {
  return memoryFiles.get(name) ?? (await get<Uint8Array>(FILES, name)) ?? null;
}

export async function clearRecent() {
  for (const e of recent) await del(FILES, e.name);
  memoryFiles.clear();
  recent = [];
  await put(KV, 'recent', recent);
  notify();
}

/** Load a project from bytes into the application (as Open does). */
export function loadProjectBytes(bytes: Uint8Array, name: string) {
  const { doc, extra } = decodeDocument(bytes);
  app.setDocument(doc);
  app.filename = name;
  if (extra.ui && typeof extra.ui === 'object') projectUiState.load(extra.ui as Record<string, unknown>);
  app.dirty = false;
}

export async function openRecent(name: string): Promise<boolean> {
  const bytes = await recentBytes(name);
  if (!bytes) {
    app.report('ERROR', `"${name}" is no longer available`);
    recent = recent.filter((e) => e.name !== name);
    await put(KV, 'recent', recent);
    notify();
    return false;
  }
  try {
    loadProjectBytes(bytes, name);
    void recordRecent(name, bytes);
    app.report('INFO', `Opened "${name}"`);
    return true;
  } catch (e) {
    app.report('ERROR', `Cannot open "${name}": ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// startup file

let startup: Uint8Array | null = null;

export function hasStartupFile() {
  return !!startup;
}

export async function saveStartupFile() {
  const bytes = encodeDocument(app.doc, { ui: projectUiState.save() });
  startup = bytes;
  await put(KV, 'startup', bytes);
  notify();
}

export async function clearStartupFile() {
  startup = null;
  await del(KV, 'startup');
  notify();
}

/** Load the saved startup file; false when there is none (or it cannot be read). */
export function loadStartupFile(): boolean {
  if (!startup) return false;
  try {
    loadProjectBytes(startup, 'untitled.p3d');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// timed autosave snapshots

let lastSnapshotRevision = -1;
let lastSnapshotTime = Date.now();

export async function listSnapshots(): Promise<Snapshot[]> {
  const list = (await get<Snapshot[]>(KV, 'snapshots')) ?? [];
  return [...list].sort((a, b) => b.time - a.time);
}

export async function takeSnapshot() {
  const bytes = encodeDocument(app.doc, { ui: projectUiState.save() });
  const list = await listSnapshots();
  const key = `snapshot-${Date.now()}`;
  const next = [{ key, name: app.filename, time: Date.now(), size: bytes.length }, ...list];
  for (const old of next.slice(MAX_SNAPSHOTS)) await del(FILES, old.key);
  await put(FILES, key, bytes);
  await put(KV, 'snapshots', next.slice(0, MAX_SNAPSHOTS));
  lastSnapshotRevision = app.revision;
  lastSnapshotTime = Date.now();
}

export async function openSnapshot(s: Snapshot): Promise<boolean> {
  const bytes = await get<Uint8Array>(FILES, s.key);
  if (!bytes) {
    app.report('ERROR', 'This auto save is no longer available');
    return false;
  }
  try {
    loadProjectBytes(bytes, s.name);
    app.dirty = true;
    app.report('INFO', `Recovered the auto save from ${new Date(s.time).toLocaleString()}`);
    return true;
  } catch (e) {
    app.report('ERROR', `The auto save could not be opened: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function snapshotTick() {
  const minutes = Math.max(1, prefs.autosave_interval || 2);
  if (app.revision === lastSnapshotRevision || !app.dirty) return;
  if (Date.now() - lastSnapshotTime < minutes * 60_000) return;
  void takeSnapshot().catch(() => {});
}

// ---------------------------------------------------------------------------
// startup

async function init() {
  recent = (await get<RecentEntry[]>(KV, 'recent')) ?? [];
  startup = (await get<Uint8Array>(KV, 'startup')) ?? null;
  notify();
}

export const sessionReady = typeof window === 'undefined' ? Promise.resolve() : init().catch(() => {});

fileEvents.opened.push((name, bytes) => void recordRecent(name, bytes));
fileEvents.saved.push((name, bytes) => void recordRecent(name, bytes));
fileEvents.loadStartup = loadStartupFile;
fileEvents.openRecent = openRecent;

let resolveFresh: (fresh: boolean) => void = () => {};
/**
 * Resolves once startup settled: true for a fresh start (no session recovered, nothing edited,
 * not ?factory-startup). A fresh start begins from the user's startup file.
 */
export const freshStart = new Promise<boolean>((res) => (resolveFresh = res));

onAppReady((a) => {
  if (typeof window === 'undefined') return resolveFresh(false);
  setInterval(snapshotTick, 30_000);
  const initialDoc = a.doc;
  const factory = new URLSearchParams(location.search).has('factory-startup');
  setTimeout(() => {
    const ready = (window as unknown as { appReady?: Promise<void> }).appReady ?? Promise.resolve();
    void Promise.all([ready, sessionReady]).then(() => {
      const fresh = !factory && a.doc === initialDoc && !a.undo.canUndo;
      if (fresh && startup && loadStartupFile()) a.dirty = false;
      resolveFresh(fresh);
    });
  }, 0);
});
