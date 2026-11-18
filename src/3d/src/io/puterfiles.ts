// Files on the Puter drive: double-click and "Open with" on the Puter desktop, Puter's Open and Save
// dialogs, files dragged in from a Puter desktop folder window, and saving a Puter file back where
// it came from. Without the Puter SDK (offline, online access off) nothing here does anything and
// files come from and go to this device as before.
import { app } from '../app/app';
import { PUTER_LOADED } from '../assistant/puter';
import { fileEvents, formats, isReadableFile, openFile } from './files';

/** An entry of the Puter drive: a launch item, a picked file or a record dropped from a desktop folder. */
export interface DriveItem {
  name?: string;
  path?: string;
  uid?: string;
  is_dir?: boolean;
  isDir?: boolean;
  isDirectory?: boolean;
  fsentry_is_dir?: boolean;
  /** launch items and picked files read themselves; dropped records do not */
  read?: () => Promise<Blob>;
}

/** Puter's pickers never settle when cancelled; newer SDKs hang a promise on them that does, with undefined. */
type Picking<T> = Promise<T> & { undefinedOnCancel?: Promise<T | undefined> };

interface PuterFilesSDK {
  env?: string;
  ui?: {
    onLaunchedWithItems?: (cb: (items: DriveItem[] | DriveItem) => void) => void;
    showOpenFilePicker?: (opts: { multiple?: boolean; accept?: string | string[] }) => Picking<DriveItem | DriveItem[] | null | undefined>;
    showSaveFilePicker?: (content: Blob, suggestedName: string) => Picking<DriveItem | null | undefined>;
  };
  fs?: {
    read: (path: string) => Promise<Blob>;
    write: (path: string, data: Blob, opts?: Record<string, unknown>) => Promise<unknown>;
  };
}

const sdk = () => (globalThis as unknown as { puter?: PuterFilesSDK }).puter ?? null;
const settleOnCancel = <T>(p: Picking<T>) => p?.undefinedOnCancel ?? p;
const errorText = (e: unknown) => {
  const err = e as { message?: string; error?: { message?: string } } | string | null;
  return (typeof err === 'string' ? err : err?.message || err?.error?.message) || 'the file could not be read';
};

/** Puter's Open dialog can be shown (also outside the desktop, where it opens a Puter window). */
export const canOpenFromPuter = () => typeof sdk()?.ui?.showOpenFilePicker === 'function';
/** Inside the Puter desktop, Open and Import use Puter's Open dialog first. */
export const opensFromPuter = () => sdk()?.env === 'app' && canOpenFromPuter();
/** Inside the Puter desktop, a file's first save, Save As and Save Copy go where Puter's Save dialog says. */
export const savesToPuter = () => sdk()?.env === 'app' && typeof sdk()?.ui?.showSaveFilePicker === 'function';

/** File extensions File ▸ Open reads (as `isReadableFile` decides). */
export const openExtensions = () => [...new Set(['.blend', '.p3d', '.json', ...formats.flatMap((f) => (f.import ? f.extensions : []))])];

// ---------------------------------------------------------------------------
// save targets

/** Save targets that write a Puter file, by its drive path. */
const puterTargets = new WeakMap<object, string>();

/** Save writes the current file back to this Puter file (when it saves under the file's name, see saveFile). */
export function puterSaveTarget(path: string, name: string): NonNullable<typeof fileEvents.saveTarget> {
  const target = {
    name,
    write: async (bytes: Uint8Array) => {
      const fs = sdk()?.fs;
      if (!fs) throw new Error('Puter is not available right now. Check your connection and try again.');
      await fs.write(path, new Blob([bytes as Uint8Array<ArrayBuffer>]), { overwrite: true });
    },
  };
  puterTargets.set(target, path);
  return target;
}

/** The drive path of the Puter file that is open (the one Save writes to), if any. */
export const openPuterPath = (): string | null => (fileEvents.saveTarget && puterTargets.get(fileEvents.saveTarget)) || null;

// Puter's Save dialog never answers when the desktop fails to write the file. A save made while one
// is open waits for that one rather than opening another; once the app has the focus back (the
// desktop holds it while its dialog is up) the dialog is gone, answered or not.
let saving: Promise<void> | null = null;

/**
 * Where saveFile sends the bytes when there is no file to update in place. Inside the Puter desktop
 * that is Puter's Save dialog (true: handled here); elsewhere false, and the file is downloaded.
 */
export function saveToPuter(bytes: Uint8Array, name: string, copy: boolean): boolean {
  if (!savesToPuter()) return false;
  if (saving) return true;
  const rev = app.revision;
  const done = (async () => {
    let item: DriveItem | null | undefined;
    try {
      item = await settleOnCancel(sdk()!.ui!.showSaveFilePicker!(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), name));
    } catch (e) {
      app.report('ERROR', `Cannot save "${name}": ${errorText(e)}`);
      return;
    }
    if (!item) return; // cancelled
    const saved = item.name || (item.path ? item.path.split('/').pop()! : name);
    if (!copy) {
      app.filename = saved;
      // saved as of when the dialog opened: edits made meanwhile keep the file modified
      if (app.revision === rev) app.dirty = false;
      fileEvents.saveTarget = item.path ? puterSaveTarget(item.path, saved) : null;
      fileEvents.keepOriginal = false;
    }
    for (const f of fileEvents.saved) f(saved, bytes);
    app.report('INFO', copy ? `Saved a copy as "${saved}"` : `Saved "${saved}"`);
    app.changed('ui');
  })();
  saving = done;
  const release = () => {
    removeEventListener('focus', release);
    if (saving === done) saving = null;
  };
  void done.finally(release);
  addEventListener('focus', release);
  return true;
}

// ---------------------------------------------------------------------------
// opening

const isDriveDir = (it: DriveItem) => !!(it.is_dir || it.isDir || it.isDirectory || it.fsentry_is_dir);
const driveName = (it: DriveItem) => it.name || (it.path ?? '').replace(/\/+$/, '').split('/').pop() || 'file';

/** The files among drive entries; folders are left out, with a word when there is nothing else. */
function driveFiles(given: unknown): DriveItem[] {
  const all = (Array.isArray(given) ? given : [given]).filter((it): it is DriveItem => !!it && typeof it === 'object');
  const files = all.filter((it) => typeof it.path === 'string' && !!it.path && !isDriveDir(it));
  if (all.some(isDriveDir)) app.report('WARNING', files.length ? 'Folders were skipped: open the files inside them instead' : 'Folders cannot be opened: open the files inside them instead');
  return files;
}

/** A drive entry's contents as a File. */
export async function readDriveFile(it: DriveItem, name = driveName(it)): Promise<File> {
  const blob = typeof it.read === 'function' ? await it.read() : await sdk()!.fs!.read(it.path!);
  return new File([blob], name, { type: blob.type || '' });
}

const unsupported = (name: string) => app.report('ERROR', `Cannot open "${name}": no format reads this type of file`);

/** Drive paths being opened: opening one again meanwhile (a launch and a drop) waits for that one. */
const opening = new Map<string, Promise<void>>();

/** Open a File that is the Puter file at `path`: when it replaces the document, Save writes back to it. */
async function openAsPuterFile(file: File, path: string) {
  // openFile clears the save target when the file replaces the document; a file that fails to open,
  // or is imported into the current one, keeps it. A stand-in shows which happened.
  const prev = fileEvents.saveTarget;
  const probe = { name: prev?.name ?? '', write: (b: Uint8Array) => (prev ? prev.write(b) : Promise.reject(new Error('The file is still opening.'))) };
  fileEvents.saveTarget = probe;
  try {
    await openFile(file, 'open');
  } finally {
    if (fileEvents.saveTarget === probe) fileEvents.saveTarget = prev;
    else if (fileEvents.saveTarget === null) fileEvents.saveTarget = puterSaveTarget(path, file.name);
  }
}

/**
 * Open a Puter drive file (File ▸ Open from Puter, a launch, a dropped project's Open). A file no
 * format reads is not read; the file that is already open, or being opened, is not opened again.
 */
export function openDriveFile(it: DriveItem, mode: 'open' | 'import' = 'open'): Promise<void> {
  const path = it.path!;
  const name = driveName(it);
  if (!isReadableFile(name)) return Promise.resolve(unsupported(name));
  if (mode === 'open') {
    if (openPuterPath() === path) return Promise.resolve(app.report('INFO', `"${name}" is already open`));
    const pending = opening.get(path);
    if (pending) return pending;
  }
  const run = (async () => {
    let file: File;
    try {
      file = await readDriveFile(it, name);
    } catch (e) {
      app.report('ERROR', `Cannot open "${name}": ${errorText(e)}`);
      return;
    }
    if (mode === 'import') await openFile(file, 'import');
    else await openAsPuterFile(file, path);
  })();
  if (mode === 'open') {
    opening.set(path, run);
    void run.finally(() => opening.delete(path));
  }
  return run;
}

/** Open (or import) drive entries one after another; folders and unreadable files are left out. */
export async function openDriveItems(given: unknown, mode: 'open' | 'import' = 'open') {
  for (const it of driveFiles(given)) await openDriveFile(it, mode);
}

/** File ▸ Open / Import ▸ From Puter: Puter's Open dialog. Cancelling it does nothing. */
export async function pickFromPuter(mode: 'open' | 'import' = 'open', accept: string[] = openExtensions()) {
  if (!canOpenFromPuter()) return;
  let picked: DriveItem | DriveItem[] | null | undefined;
  try {
    picked = await settleOnCancel(sdk()!.ui!.showOpenFilePicker!({ multiple: false, accept }));
  } catch (e) {
    app.report('ERROR', `Cannot open from Puter: ${errorText(e)}`);
    return;
  }
  if (picked) await openDriveItems(Array.isArray(picked) ? picked.slice(0, 1) : picked, mode);
}

/** Puter's Open dialog for a format's own import (File ▸ Import ▸ <format> inside the desktop): the picked files. */
export async function pickFilesFromPuter(accept: string, multiple: boolean): Promise<File[]> {
  let picked: DriveItem | DriveItem[] | null | undefined;
  try {
    picked = await settleOnCancel(sdk()!.ui!.showOpenFilePicker!({ multiple, accept: accept.split(',').filter(Boolean) }));
  } catch (e) {
    app.report('ERROR', `Cannot open from Puter: ${errorText(e)}`);
    return [];
  }
  const files: File[] = [];
  for (const it of driveFiles(picked ?? [])) {
    try {
      files.push(await readDriveFile(it));
    } catch (e) {
      app.report('ERROR', `Cannot open "${driveName(it)}": ${errorText(e)}`);
    }
  }
  return files;
}

/**
 * Files dragged in from a Puter desktop folder window, read as Files for the drop handler (which
 * treats them as files dropped from this device). Folders, files no format reads and the file that
 * is already open (or being opened) are left out. `drivePathOf` tells which drive file a File is.
 */
export async function readDroppedDriveItems(given: unknown): Promise<File[]> {
  const files: File[] = [];
  for (const it of driveFiles(given)) {
    const name = driveName(it);
    if (!isReadableFile(name)) {
      unsupported(name);
      continue;
    }
    if (openPuterPath() === it.path || opening.has(it.path!)) {
      app.report('INFO', `"${name}" is already open`);
      continue;
    }
    try {
      const f = await readDriveFile(it, name);
      dropped.set(f, it.path!);
      files.push(f);
    } catch (e) {
      app.report('ERROR', `Cannot open "${name}": ${errorText(e)}`);
    }
  }
  return files;
}

const dropped = new WeakMap<File, string>();
/** The drive path of a File read from a Puter drop, if it is one. */
export const drivePathOf = (f: File) => dropped.get(f) ?? null;

/** Open a dropped File: one that came from the Puter drive stays tied to it, so Save writes back there. */
export function openDroppedFile(f: File): Promise<void> {
  const path = drivePathOf(f);
  if (!path) return openFile(f);
  if (openPuterPath() === path) return Promise.resolve(app.report('INFO', `"${f.name}" is already open`));
  return opening.get(path) ?? openDriveFile({ name: f.name, path, read: async () => f });
}

// ---------------------------------------------------------------------------
// launch

const LAUNCHED_KEY = 'p3d-puter-launched';

/**
 * The files the app was launched with. The launch stays in the window's address, so a reload hands
 * the same file over again: when the session that was recovered is that file, it is not opened a
 * second time (that would replace the recovered edits), and Save still writes back to it.
 */
export async function openLaunchItems(given: unknown) {
  const keyOf = (it: DriveItem) => `${typeof location === 'undefined' ? '' : location.search}|${it.uid || it.path}`;
  let seen: string[] = [];
  try {
    seen = JSON.parse(sessionStorage.getItem(LAUNCHED_KEY) || '[]');
  } catch {
    // storage blocked: every launch is new
  }
  const items = driveFiles(given);
  const fresh: DriveItem[] = [];
  for (const it of items) {
    const name = driveName(it);
    if (seen.includes(keyOf(it)) && app.filename === name) {
      fileEvents.saveTarget ??= puterSaveTarget(it.path!, name);
      continue;
    }
    fresh.push(it);
  }
  try {
    sessionStorage.setItem(LAUNCHED_KEY, JSON.stringify([...seen.filter((k) => !items.some((it) => keyOf(it) === k)), ...items.map(keyOf)].slice(-50)));
  } catch {
    // as above
  }
  for (const it of fresh) await openDriveFile(it, 'open');
}

/**
 * Open the files the Puter desktop launched the app with (double-click, "Open with"), in a desktop
 * window or a browser tab it opened, once `ready` (startup recovery) is done. The SDK may arrive
 * after the app started: the handler is registered when it is there. Only onLaunchedWithItems is
 * used: the SDK hands launch items to the deprecated onItemsOpened as well, which would open twice.
 */
export function installPuterFiles(ready: Promise<unknown> = Promise.resolve()) {
  let registered = false;
  const register = () => {
    const ui = sdk()?.ui;
    if (registered || typeof ui?.onLaunchedWithItems !== 'function') return;
    registered = true;
    removeEventListener(PUTER_LOADED, register);
    try {
      ui.onLaunchedWithItems((items) => void ready.then(() => openLaunchItems(items)));
    } catch {
      // an SDK without launch items
    }
  };
  register();
  if (!registered) addEventListener(PUTER_LOADED, register);
}
