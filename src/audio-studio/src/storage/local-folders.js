// Folders on this device that the Media Browser can browse, through the File
// System Access API (Chromium browsers). The user picks a folder once; its
// handle is kept in IndexedDB so it is listed again next time, though the
// browser asks for permission again after a reload (a click on the folder).
//
// Paths look like "local:<rootId>/<sub/folders>/<name>" so they never clash
// with Puter paths. Items match the shape of Puter directory entries
// ({ name, path, is_dir, size, modified }) plus `local: true`.

const DB = 'audio-studio-local-folders';
const STORE = 'roots';
const PREFIX = 'local:';

export const supported = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function' && typeof indexedDB !== 'undefined';

export const isLocalPath = (path) => typeof path === 'string' && path.startsWith(PREFIX);

/** Splits "local:<root>/a/b" into { rootId, parts: ['a', 'b'] }. */
export function parseLocalPath(path) {
  const rest = String(path).slice(PREFIX.length);
  const [rootId, ...parts] = rest.split('/').filter(Boolean);
  return { rootId, parts };
}

export const rootPath = (rootId) => `${PREFIX}${rootId}`;

export function joinLocal(path, name) {
  return `${path.replace(/\/+$/, '')}/${name}`;
}

/** Parent of a local path; a root is its own parent. */
export function localDirname(path) {
  const { rootId, parts } = parseLocalPath(path);
  return parts.length ? [rootPath(rootId), ...parts.slice(0, -1)].join('/') : rootPath(rootId);
}

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => {
      d.close();
      resolve(out?.result ?? out);
    };
    // A failed request fires `error`; a quota or other failure at commit only
    // `abort`. Either settles the promise, so callers never wait forever.
    const fail = () => {
      d.close();
      reject(t.error || new Error('The folder list could not be saved.'));
    };
    t.onerror = fail;
    t.onabort = fail;
  });
}

/** Saved roots: [{ id, name, handle }]. */
export async function loadRoots() {
  if (!supported()) return [];
  try {
    const list = await tx('readonly', (s) => s.getAll());
    return (list || []).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } catch {
    return [];
  }
}

/** Asks the user for a folder and remembers it. Returns the root, or null if cancelled. */
export async function addRoot() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'audio-studio-media', mode: 'read' });
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    throw err;
  }
  // The same folder picked twice keeps its first entry.
  for (const r of await loadRoots()) if (await r.handle.isSameEntry?.(handle)) return r;
  const root = { id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: handle.name, handle };
  await tx('readwrite', (s) => s.put(root));
  return root;
}

export async function removeRoot(id) {
  await tx('readwrite', (s) => s.delete(id));
}

/** 'granted' | 'prompt' | 'denied'. With `request`, asks the user (needs a click). */
export async function permission(handle, { request = false } = {}) {
  const opts = { mode: 'read' };
  try {
    const state = await handle.queryPermission?.(opts);
    if (state === 'granted' || !request) return state || 'granted';
    return await handle.requestPermission(opts);
  } catch {
    return 'denied';
  }
}

async function dirHandle(roots, path) {
  const { rootId, parts } = parseLocalPath(path);
  const root = roots.find((r) => r.id === rootId);
  if (!root) throw new Error('This folder is no longer available.');
  let h = root.handle;
  for (const p of parts) h = await h.getDirectoryHandle(p);
  return h;
}

/** Directory entries of a local folder, files with their size and date. */
export async function readLocalDir(roots, path) {
  const dir = await dirHandle(roots, path);
  const out = [];
  for await (const [name, entry] of dir.entries()) {
    if (name.startsWith('.')) continue;
    const item = { name, path: joinLocal(path, name), is_dir: entry.kind === 'directory', local: true, size: 0, modified: 0 };
    if (entry.kind === 'file') {
      try {
        const f = await entry.getFile();
        item.size = f.size;
        item.modified = f.lastModified;
      } catch {
        // Unreadable entries still list by name.
      }
    }
    out.push(item);
  }
  return out;
}

/** The File behind a local file path. */
export async function localFile(roots, path) {
  const parent = await dirHandle(roots, localDirname(path));
  const name = path.slice(path.lastIndexOf('/') + 1);
  return (await parent.getFileHandle(name)).getFile();
}
