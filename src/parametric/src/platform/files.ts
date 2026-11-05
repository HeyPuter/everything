// Part files. Every open document has a location:
//   { type: 'cloud', path }  a .parametric file in the user's Puter storage
//   { type: 'local', id }    a file in this browser's private storage (OPFS)
// Signed-in users save to the cloud by default; anyone can work signed out
// with browser storage and import or download files at any time.
// Files never go into the key-value store.

import { cloudAvailable, isMissing, puter, toMs } from './puter';

export const EXT = '.parametric';
/** Files that open as an imported body rather than as a part document. */
export const IMPORT_EXTS = ['.step', '.stp', '.sldprt'];
export const isStepFile = (name: string) => /\.(step|stp)$/i.test(name);
export const isSolidWorksFile = (name: string) => /\.(sldprt|sldasm|slddrw)$/i.test(name);
export const CLOUD_DIR = 'Parts';
const LOCAL_DIR = 'parametric-parts';
const LOCAL_INDEX = 'parametric:local-parts';
const RECENT_KEY = 'parametric:recent';

export type Location = { type: 'cloud'; path: string } | { type: 'local'; id: string };

export interface FileEntry {
  name: string;
  location: Location;
  modified: number;
  size?: number | null;
}

export const safeName = (name: string) =>
  (name || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';

// ---- Local (OPFS) ----

async function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(LOCAL_DIR, { create: true });
  } catch {
    return null;
  }
}

function readIndex(): { id: string; name: string; modified: number; size: number }[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_INDEX) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeIndex(list: unknown[]) {
  try {
    localStorage.setItem(LOCAL_INDEX, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

export const localAvailable = async () => !!(await opfsDir());

async function writeFile(dir: FileSystemDirectoryHandle, name: string, text: string) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(text);
    await w.close();
  } catch (e) {
    // The file keeps its old contents; drop the half-written copy and its storage.
    await w.abort().catch(() => {});
    throw e;
  }
}

async function localWrite(id: string, name: string, text: string) {
  const dir = await opfsDir();
  if (!dir) throw new Error('This browser cannot store parts locally. Download the part or sign in to save it to your Puter cloud.');
  await writeFile(dir, `${id}${EXT}`, text);
  const list = readIndex().filter((p) => p.id !== id);
  list.unshift({ id, name, modified: Date.now(), size: text.length });
  writeIndex(list);
}

async function localRead(id: string): Promise<string> {
  const dir = await opfsDir();
  if (!dir) throw new Error('Browser storage is not available.');
  const fh = await dir.getFileHandle(`${id}${EXT}`);
  return (await fh.getFile()).text();
}

async function localDelete(id: string) {
  const dir = await opfsDir();
  try {
    await dir?.removeEntry(`${id}${EXT}`);
  } catch {
    /* already gone */
  }
  writeIndex(readIndex().filter((p) => p.id !== id));
}

// ---- Cloud (Puter FS) ----

async function cloudWrite(path: string, text: string) {
  const fs = puter()?.fs;
  if (!fs) throw new Error('Puter storage is not available.');
  return fs.write(path, new Blob([text], { type: 'application/json' }), { overwrite: true, createMissingParents: true });
}

async function cloudRead(path: string): Promise<string> {
  const p = puter();
  if (!p?.fs) throw new Error('Puter is not available right now. Check your connection and try again.');
  if (!cloudAvailable()) throw new Error('Sign in to Puter to open parts saved in your cloud.');
  const blob = await p.fs.read(path);
  return blob.text();
}

/** A free path for a new cloud part named `name`. */
export async function uniqueCloudPath(name: string): Promise<string> {
  const fs = puter()!.fs;
  const base = safeName(name);
  let existing = new Set<string>();
  try {
    const items = await fs.readdir(CLOUD_DIR);
    existing = new Set(items.map((i) => i.name.toLowerCase()));
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  let n = 1;
  let file = `${base}${EXT}`;
  while (existing.has(file.toLowerCase())) file = `${base} (${++n})${EXT}`;
  return `${CLOUD_DIR}/${file}`;
}

// ---- Public API ----

export async function newLocation(name: string, id: string): Promise<Location> {
  if (cloudAvailable()) return { type: 'cloud', path: await uniqueCloudPath(name) };
  return { type: 'local', id };
}

/** Writes a part's JSON text. Returns the (possibly updated) location. */
export async function saveText(location: Location, name: string, text: string): Promise<Location> {
  if (location.type === 'cloud') {
    const item = await cloudWrite(location.path, text);
    const loc: Location = { type: 'cloud', path: item?.path || location.path };
    rememberRecent({ location: loc, name });
    return loc;
  }
  await localWrite(location.id, name, text);
  rememberRecent({ location, name });
  return location;
}

export async function loadText(location: Location): Promise<string> {
  return location.type === 'cloud' ? cloudRead(location.path) : localRead(location.id);
}

export async function deletePart(location: Location) {
  if (location.type === 'cloud') await puter()!.fs.delete(location.path);
  else await localDelete(location.id);
  forgetRecent(location);
}

export async function renameCloud(location: Location & { type: 'cloud' }, newName: string): Promise<Location> {
  const item = await puter()!.fs.rename(location.path, `${safeName(newName)}${EXT}`);
  return { type: 'cloud', path: item?.path || location.path.replace(/[^/]+$/, `${safeName(newName)}${EXT}`) };
}

/**
 * Parts the user can open: cloud folder listing plus browser storage. When
 * the cloud cannot be listed (offline, say), the parts in this browser are
 * still returned and `onCloudError` is told why the cloud ones are missing.
 */
export async function listParts(onCloudError?: (err: unknown) => void): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  if (cloudAvailable()) {
    try {
      const items = await puter()!.fs.readdir(CLOUD_DIR);
      for (const it of items) {
        if (it.is_dir || it.isDir || !it.name.endsWith(EXT)) continue;
        out.push({ name: it.name.slice(0, -EXT.length), location: { type: 'cloud', path: it.path }, modified: toMs(it.modified), size: it.size });
      }
    } catch (err) {
      if (!isMissing(err)) onCloudError?.(err);
    }
  }
  for (const p of readIndex()) out.push({ name: p.name, location: { type: 'local', id: p.id }, modified: p.modified, size: p.size });
  out.sort((a, b) => (b.modified || 0) - (a.modified || 0));
  return out;
}

export const sameLocation = (a?: Location | null, b?: Location | null) =>
  !!a && !!b && a.type === b.type && (a.type === 'cloud' ? a.path === (b as { path: string }).path : a.id === (b as { id: string }).id);

export function recentParts(): { location: Location; name: string; opened: number }[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function rememberRecent({ location, name }: { location: Location; name: string }) {
  const list = recentParts().filter((r) => !sameLocation(r.location, location));
  list.unshift({ location, name, opened: Date.now() });
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
  } catch {
    /* storage unavailable */
  }
}

export function forgetRecent(location: Location) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentParts().filter((r) => !sameLocation(r.location, location))));
  } catch {
    /* storage unavailable */
  }
}

export const locationLabel = (loc?: Location | null) =>
  !loc ? 'Not saved' : loc.type === 'cloud' ? loc.path.replace(/^.*\/AppData\/[^/]+\//, '') : 'This browser';

/** Opens a file chosen from Puter storage: a part, or a STEP or SolidWorks file to import. */
export async function pickCloudFile(): Promise<{ blob: Blob; fileName: string; location: Location; name: string } | null> {
  const p = puter();
  if (!p?.ui?.showOpenFilePicker) return null;
  const pick = p.ui.showOpenFilePicker({ accept: [EXT, '.json', ...IMPORT_EXTS], path: `%appdata%/${CLOUD_DIR}` });
  const item = await (pick?.undefinedOnCancel ?? pick);
  if (!item) return null;
  const file = Array.isArray(item) ? item[0] : item;
  const blob = await file.read!();
  return { blob, fileName: file.name, location: { type: 'cloud', path: file.path }, name: file.name.replace(/\.(parametric|json)$/i, '') };
}

/** Save As into a user-chosen Puter folder. */
export async function pickCloudSave(text: string, name: string): Promise<Location | null> {
  const p = puter();
  if (!p?.ui?.showSaveFilePicker) return null;
  const pick = p.ui.showSaveFilePicker(new Blob([text], { type: 'application/json' }), `${safeName(name)}${EXT}`);
  const item = await (pick?.undefinedOnCancel ?? pick);
  if (!item) return null;
  return { type: 'cloud', path: item.path };
}

/** Reads a file from the user's device. */
export function pickDeviceFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Saves bytes or text to the user's device through a download. */
export function download(data: BlobPart | Blob, filename: string, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ---- Crash recovery: a snapshot of each open tab's unsaved work ----
// Every tab writes its own file and holds a Web Lock named after it while it
// is open, so another tab never offers (or deletes) work that is still open,
// and two tabs never overwrite each other's copy. A copy whose tab is gone
// (closed, crashed, reloaded) is offered when Parametric starts.

const RECOVERY_PREFIX = 'recovery-';
const LOCK_PREFIX = 'parametric-recovery-';
const TAB_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const ownRecovery = `${RECOVERY_PREFIX}${TAB_ID}.json`;

type Locks = { request(name: string, cb: () => Promise<void>): Promise<void>; query(): Promise<{ held?: { name?: string }[] }> };
const locks = (): Locks | undefined => (typeof navigator !== 'undefined' ? (navigator as unknown as { locks?: Locks }).locks : undefined);
// Held until the tab goes away.
void locks()?.request(`${LOCK_PREFIX}${TAB_ID}`, () => new Promise<void>(() => {})).catch(() => {});

// Writes and removals run one at a time, so a removal never races a write in progress.
let recoveryQueue: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = recoveryQueue.then(fn, fn);
  recoveryQueue = run.catch(() => {});
  return run;
}

export function writeRecovery(text: string) {
  return queued(async () => {
    const dir = await opfsDir();
    if (!dir) return;
    try {
      await writeFile(dir, ownRecovery, text);
    } catch {
      /* best effort */
    }
  });
}

/** This tab's own recovery copy, if one has been written. */
export async function readRecovery(): Promise<string | null> {
  return queued(async () => {
    const dir = await opfsDir();
    try {
      return dir ? await (await (await dir.getFileHandle(ownRecovery)).getFile()).text() : null;
    } catch {
      return null;
    }
  });
}

export function clearRecovery() {
  return removeRecovery(ownRecovery);
}

export function removeRecovery(file: string) {
  return queued(async () => {
    try {
      await (await opfsDir())?.removeEntry(file);
    } catch {
      /* nothing to clear */
    }
  });
}

/** Recovery copies left by tabs that are no longer open, newest first. */
export async function orphanRecoveries(): Promise<{ file: string; text: string }[]> {
  const dir = await opfsDir();
  if (!dir) return [];
  let held: Set<string> | null = null;
  try {
    const q = await locks()?.query();
    if (q) held = new Set((q.held ?? []).map((l) => l.name ?? ''));
  } catch {
    held = null;
  }
  const out: { file: string; text: string; at: number }[] = [];
  try {
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      // recovery.json was the single copy written before there was one per tab.
      const id = name === 'recovery.json' ? '' : name.startsWith(RECOVERY_PREFIX) && name.endsWith('.json') ? name.slice(RECOVERY_PREFIX.length, -5) : null;
      if (id === null || name === ownRecovery || handle.kind !== 'file') continue;
      // Without Web Locks every other copy counts as left behind.
      if (id && held?.has(`${LOCK_PREFIX}${id}`)) continue;
      const f = await (handle as FileSystemFileHandle).getFile();
      out.push({ file: name, text: await f.text(), at: f.lastModified });
    }
  } catch {
    /* listing failed: nothing to offer */
  }
  return out.sort((a, b) => b.at - a.at).map(({ file, text }) => ({ file, text }));
}
