// Project files. Every open project has a location:
//   { type: 'cloud', path }  a .circuits file in the user's Puter storage
//   { type: 'local', id }    a file in this browser's private storage (OPFS)
// Signed-in users get cloud locations by default; anyone can use the app
// signed out with local storage, and import or download files at any time.
// Files never go into the key-value store.

import { puter, cloudAvailable, isMissing, toMs } from './puter.js';

export const EXT = '.circuits';
export const CLOUD_DIR = 'Projects';
const LOCAL_DIR = 'circuits-projects';
const LOCAL_INDEX = 'circuits:local-projects';
const RECENT_KEY = 'circuits:recent';

const safeName = (name) => (name || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';

// ---- Local (OPFS) ----

async function opfsDir() {
  if (!navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(LOCAL_DIR, { create: true });
  } catch { return null; }
}

function readIndex() {
  try { const v = JSON.parse(localStorage.getItem(LOCAL_INDEX) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeIndex(list) {
  try { localStorage.setItem(LOCAL_INDEX, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

export const localAvailable = async () => !!(await opfsDir());

async function localWrite(id, name, text) {
  const dir = await opfsDir();
  if (!dir) throw new Error('This browser cannot store projects locally. Download the project or sign in to save it to your Puter cloud.');
  const fh = await dir.getFileHandle(`${id}${EXT}`, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
  const list = readIndex().filter((p) => p.id !== id);
  list.unshift({ id, name, modified: Date.now(), size: text.length });
  writeIndex(list);
}

/**
 * Stored projects the index does not know about: the index lives in
 * localStorage, and a write to it can be refused (full or blocked site
 * storage) after the project file itself was saved.
 */
async function localUnindexed(known) {
  const out = [];
  try {
    const dir = await opfsDir();
    if (!dir?.entries) return out;
    for await (const [file, handle] of dir.entries()) {
      const id = file.endsWith(EXT) ? file.slice(0, -EXT.length) : null;
      if (!id || known.has(id) || !handle.getFile) continue;
      try {
        const f = await handle.getFile();
        const name = JSON.parse(await f.text()).name;
        out.push({ id, name: String(name ?? 'Untitled'), modified: f.lastModified, size: f.size });
      } catch { /* not a readable project */ }
    }
  } catch { /* storage unavailable */ }
  return out;
}

async function localRead(id) {
  const dir = await opfsDir();
  if (!dir) throw new Error('Local storage is not available in this browser.');
  const fh = await dir.getFileHandle(`${id}${EXT}`);
  return (await fh.getFile()).text();
}

async function localDelete(id) {
  const dir = await opfsDir();
  try { await dir?.removeEntry(`${id}${EXT}`); } catch { /* already gone */ }
  writeIndex(readIndex().filter((p) => p.id !== id));
}

// ---- Cloud (Puter FS) ----

async function cloudWrite(path, text) {
  const fs = puter()?.fs;
  if (!fs) throw new Error('Puter storage is not available.');
  return fs.write(path, new Blob([text], { type: 'application/json' }), { overwrite: true, createMissingParents: true });
}

async function cloudRead(path) {
  const blob = await puter().fs.read(path);
  return blob.text();
}

/** A free file path for a new cloud project named name. */
export async function uniqueCloudPath(name) {
  const fs = puter()?.fs;
  const base = safeName(name);
  let existing = new Set();
  try {
    const items = await fs.readdir(CLOUD_DIR);
    existing = new Set(items.map((i) => i.name.toLowerCase()));
  } catch (err) { if (!isMissing(err)) throw err; }
  let n = 1, file = `${base}${EXT}`;
  while (existing.has(file.toLowerCase())) file = `${base} (${++n})${EXT}`;
  return `${CLOUD_DIR}/${file}`;
}

// ---- Public API ----

export async function newLocation(name, id) {
  if (cloudAvailable()) return { type: 'cloud', path: await uniqueCloudPath(name) };
  return { type: 'local', id };
}

/** Writes a project's JSON text to its location. Returns the (possibly updated) location. */
export async function saveText(location, name, text) {
  if (location.type === 'cloud') {
    const item = await cloudWrite(location.path, text);
    rememberRecent({ location: { type: 'cloud', path: item?.path || location.path }, name });
    return { type: 'cloud', path: item?.path || location.path };
  }
  await localWrite(location.id, name, text);
  rememberRecent({ location, name });
  return location;
}

export async function loadText(location) {
  return location.type === 'cloud' ? cloudRead(location.path) : localRead(location.id);
}

export async function deleteProject(location) {
  if (location.type === 'cloud') await puter().fs.delete(location.path);
  else await localDelete(location.id);
  forgetRecent(location);
}

export async function renameCloud(location, newName) {
  const item = await puter().fs.rename(location.path, `${safeName(newName)}${EXT}`);
  return { type: 'cloud', path: item?.path || location.path.replace(/[^/]+$/, `${safeName(newName)}${EXT}`) };
}

/** Projects the user can open: cloud folder listing plus local index. */
export async function listProjects() {
  const out = [];
  if (cloudAvailable()) {
    try {
      const items = await puter().fs.readdir(CLOUD_DIR);
      for (const it of items) {
        if (it.is_dir || it.isDir || !it.name.endsWith(EXT)) continue;
        out.push({ name: it.name.slice(0, -EXT.length), location: { type: 'cloud', path: it.path }, modified: toMs(it.modified), size: it.size });
      }
    } catch (err) { if (!isMissing(err)) console.warn('Could not list projects', err); }
  }
  const index = readIndex();
  const unindexed = await localUnindexed(new Set(index.map((p) => p.id)));
  if (unindexed.length) writeIndex([...index, ...unindexed]);
  for (const p of [...index, ...unindexed]) out.push({ name: p.name, location: { type: 'local', id: p.id }, modified: p.modified, size: p.size });
  out.sort((a, b) => (b.modified || 0) - (a.modified || 0));
  return out;
}

export const sameLocation = (a, b) => !!a && !!b && a.type === b.type && (a.type === 'cloud' ? a.path === b.path : a.id === b.id);

/** A stored location in a usable shape (the stored lists may be damaged or from another version). */
const validLocation = (l) => !!l && typeof l === 'object' && (l.type === 'cloud' ? typeof l.path === 'string' : l.type === 'local' && typeof l.id === 'string');

export function recentProjects() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((r) => r && validLocation(r.location)).map((r) => ({ ...r, name: String(r.name ?? 'Untitled') })) : [];
  } catch { return []; }
}

export function rememberRecent({ location, name }) {
  const list = recentProjects().filter((r) => !sameLocation(r.location, location));
  list.unshift({ location, name, opened: Date.now() });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* storage unavailable */ }
}

export function forgetRecent(location) {
  const list = recentProjects().filter((r) => !sameLocation(r.location, location));
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

export const locationLabel = (loc) => (loc?.type === 'cloud' ? loc.path.replace(/^.*\/AppData\/[^/]+\//, '') : 'This browser');

/** Opens a .circuits file chosen from Puter storage. Returns { text, location, name } or null. */
export async function pickCloudFile() {
  const p = puter();
  if (!p?.ui?.showOpenFilePicker) return null;
  const pick = p.ui.showOpenFilePicker({ accept: [EXT, '.json'], path: `%appdata%/${CLOUD_DIR}` });
  const item = await (pick?.undefinedOnCancel ?? pick);
  if (!item) return null;
  const file = Array.isArray(item) ? item[0] : item;
  const text = await (await file.read()).text();
  return { text, location: { type: 'cloud', path: file.path }, name: file.name.replace(/\.(circuits|json)$/i, '') };
}

/** Save As into a user-chosen Puter folder. Returns the new location or null. */
export async function pickCloudSave(text, name) {
  const p = puter();
  if (!p?.ui?.showSaveFilePicker) return null;
  const pick = p.ui.showSaveFilePicker(new Blob([text], { type: 'application/json' }), `${safeName(name)}${EXT}`);
  const item = await (pick?.undefinedOnCancel ?? pick);
  if (!item) return null;
  return { type: 'cloud', path: item.path };
}

/** Reads a file from the user's device. */
export function pickDeviceFile(accept = `${EXT},.json`) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      resolve(f ? { text: await f.text(), name: f.name.replace(/\.(circuits|json)$/i, ''), file: f } : null);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Saves bytes or text to the user's device through a download. */
export function download(data, filename, type = 'application/octet-stream') {
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

export { safeName };
