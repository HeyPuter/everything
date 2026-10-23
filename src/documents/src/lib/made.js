/**
 * The documents the app made elsewhere on the drive, kept on this device for
 * the account. Inside the Puter desktop, Save and Save a Copy write a new file
 * where the user puts it in Puter's Save dialog, outside the app folder that
 * the home screen and Open recent list. Remembered here, they are listed with
 * the folder's own, wherever they are now.
 */

import * as P from './puter.js';
import { accountKey } from './account-key.js';
import { documentPathKey } from './document-paths.js';

const KEY = 'documents:made';
// Enough for years of documents; past it the oldest record goes.
const LIMIT = 1000;

function browserStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function read(storage) {
  try {
    const list = JSON.parse(storage.getItem(accountKey(KEY, storage)) || '[]');
    return Array.isArray(list) ? list.filter((r) => r && typeof r.path === 'string' && r.path) : [];
  } catch { return []; }
}

function write(storage, list) {
  try { storage.setItem(accountKey(KEY, storage), JSON.stringify(list.slice(0, LIMIT))); } catch { /* storage unavailable */ }
}

const parentOf = (path) => path.slice(0, path.lastIndexOf('/'));

/** Whether a path names a file directly in the app folder, which the folder's own listing shows. */
export function inAppFolder(path) {
  const key = documentPathKey(path);
  return typeof key === 'string' && key.startsWith(`${P.FOLDER}/`) && !key.slice(P.FOLDER.length + 1).includes('/');
}

/** Whether a path is in the Puter trash (a file put there from the desktop). */
export function inTrash(path) {
  return typeof path === 'string' && /^(?:\/[^/]+|~)\/Trash(?:\/|$)/.test(path);
}

/** Note a document the app made outside its folder (`file` is { path, uid }); a record of the same file is replaced. */
export function rememberMade(file, storage = browserStorage()) {
  const { path, uid = null } = file || {};
  if (!storage || !path || inAppFolder(path)) return;
  const others = read(storage).filter((r) => r.path !== path && !(uid && r.uid === uid));
  write(storage, [{ path, ...(uid ? { uid } : {}) }, ...others]);
}

/** The file was deleted (`to` null), or renamed here to `to`: its record goes, or follows it. */
export function forgetMade(path, to = null, storage = browserStorage()) {
  if (!storage || !path) return;
  const list = read(storage);
  const next = to ? list.map((r) => (r.path === path ? { ...r, path: to } : r)) : list.filter((r) => r.path !== path);
  if (JSON.stringify(next) !== JSON.stringify(list)) write(storage, next);
}

/**
 * The documents the app made elsewhere, as they are now: { name, path, size, modified, uid }, the way the app
 * folder's listing gives its files. Each folder they were left in is listed once rather than each file asked
 * after; a file no longer there is looked up by its id and followed where it was moved or renamed. One deleted
 * (or in the trash) is forgotten, and so is one moved into the app folder, which lists it itself. A folder or a
 * file that cannot be asked about just now (offline, say) keeps its record and is left out: its path is in
 * `unreachable`, so that nothing else is forgotten on its account.
 */
export async function madeFiles(storage = browserStorage()) {
  const result = Object.assign([], { unreachable: [] });
  if (!storage) return result;
  const before = read(storage);
  if (!before.length) return result;
  const folders = new Map([...new Set(before.map((r) => parentOf(r.path)))].map((dir) => [dir, P.listFolder(dir).catch(() => null)]));
  const found = await Promise.all(before.map(async (r) => {
    const listing = await folders.get(parentOf(r.path));
    if (!listing) return { keep: r, unreachable: true };
    const here = listing.find((it) => !it.isDir && (r.uid && it.uid ? it.uid === r.uid : it.name === P.displayName(r.path)));
    if (here) return { keep: { ...r, path: here.path }, file: here };
    if (!r.uid) return null; // gone from its folder, with nothing else to know it by
    let st;
    try { st = await P.statByUid(r.uid); } catch { return { keep: r, unreachable: true }; }
    if (!st?.path || st.is_dir || st.isDir || inTrash(st.path) || inAppFolder(st.path)) return null;
    return { keep: { ...r, path: st.path }, file: { name: st.name || P.displayName(st.path), path: st.path, size: st.size ?? 0, modified: st.modified ?? st.created ?? 0, uid: st.uid || st.id || r.uid } };
  }));
  // Records added meanwhile (a save while the folders were listed) stay; those looked up are replaced, or go.
  const looked = new Map(before.map((r, i) => [`${r.path}\n${r.uid || ''}`, found[i]]));
  const next = [];
  const seen = new Set();
  const current = read(storage);
  for (const r of current) {
    const key = `${r.path}\n${r.uid || ''}`;
    const kept = looked.has(key) ? looked.get(key)?.keep : r;
    if (!kept || seen.has(kept.path)) continue;
    seen.add(kept.path);
    next.push(kept);
  }
  if (JSON.stringify(next) !== JSON.stringify(current)) write(storage, next);
  const shown = new Set();
  for (const f of found) {
    if (f?.unreachable) { result.unreachable.push(f.keep.path); continue; }
    if (!f?.file || !P.OPENABLE.test(f.file.name) || shown.has(f.file.path)) continue;
    shown.add(f.file.path);
    result.push({ name: f.file.name, path: f.file.path, size: f.file.size ?? 0, modified: f.file.modified ?? 0, uid: f.file.uid || null });
  }
  return result;
}

/**
 * The app folder's files with the documents made elsewhere, each once: a record of a file the folder lists
 * itself (by its id, or by either spelling of its path) is left to the folder's listing.
 */
export function withMade(folder, made) {
  const uids = new Set(folder.map((f) => f.uid).filter(Boolean));
  const paths = new Set(folder.map((f) => documentPathKey(f.path)));
  return [...folder, ...made.filter((m) => !(m.uid && uids.has(m.uid)) && !paths.has(documentPathKey(m.path)))];
}

/** Where a document outside the app folder is, for showing beside its name: "Desktop/Reports" for /alice/Desktop/Reports/A.docx. */
export function madeLocation(path) {
  if (!path || inAppFolder(path)) return '';
  return parentOf(path).replace(/^(?:\/[^/]+|~)(?:\/|$)/, '') || 'Home';
}
