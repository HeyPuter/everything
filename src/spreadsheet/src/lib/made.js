/**
 * The spreadsheets the app made elsewhere on the drive, kept on this device for the account: inside the Puter
 * desktop, Save and Save a copy write a new file where the user picks it in Puter's Save dialog, outside the app
 * folder the home screen lists. The home screen lists these with the folder's own, wherever they are now, so that
 * they are not left to the eight files kept as opened elsewhere (recent.js), out of which they soon fell.
 */

import { accountStorageKey } from './account-storage.js';
import { inAppFolder, inTrash, statByUid, listDir, displayName } from './puter.js';

const KEY = 'spreadsheet:made';
// Enough for years of spreadsheets; past it the oldest record goes.
const LIMIT = 1000;

function browserStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function read(storage) {
  try {
    const list = JSON.parse(storage.getItem(accountStorageKey(KEY)) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && typeof x.path === 'string') : [];
  } catch { return []; }
}

function write(storage, list) {
  try { storage.setItem(accountStorageKey(KEY), JSON.stringify(list.slice(0, LIMIT))); } catch { /* no storage */ }
}

/** Note a spreadsheet the app made outside its folder (`file` is { path, uid }); a record of the same file is replaced. */
export function rememberMade(file, storage = browserStorage()) {
  const { path, uid = null } = file || {};
  if (!storage || !path || inAppFolder(path)) return;
  const others = read(storage).filter((x) => x.path !== path && !(uid && x.uid === uid));
  write(storage, [{ path, ...(uid ? { uid } : {}) }, ...others]);
}

/** The file was deleted, or is known by another address now (`to`, renamed here): its record follows or goes. */
export function forgetMade(path, to = null, storage = browserStorage()) {
  if (!storage) return;
  const list = read(storage);
  const next = to ? list.map((x) => (x.path === path ? { ...x, path: to } : x)) : list.filter((x) => x.path !== path);
  if (JSON.stringify(next) !== JSON.stringify(list)) write(storage, next);
}

const parentOf = (path) => path.slice(0, path.lastIndexOf('/'));

/**
 * The spreadsheets the app made elsewhere on the drive, as they are now: { name, path, size, modified, uid }, the way
 * the app folder's listing gives its files. Each folder they were left in is listed once, rather than each file asked
 * after; a file not there any more is looked up by its id, and followed where it was moved or renamed. One deleted
 * (or in the trash) is forgotten, and so is one moved into the app folder, which lists it itself. A folder or a file
 * that cannot be asked about (offline, say) keeps its record, and is left out for now.
 */
export async function madeFiles(storage = browserStorage()) {
  if (!storage) return [];
  const before = read(storage);
  if (!before.length) return [];
  const folders = new Map([...new Set(before.map((r) => parentOf(r.path)))].map((dir) => [dir, listDir(dir).catch(() => null)]));
  const found = await Promise.all(before.map(async (r) => {
    const listing = await folders.get(parentOf(r.path));
    if (!listing) return { keep: r };
    const here = listing.find((it) => !it.is_dir && (r.uid && it.uid ? it.uid === r.uid : it.path === r.path || it.name === displayName(r.path)));
    if (here) return { keep: { ...r, path: here.path }, file: here };
    if (!r.uid) return null; // gone from its folder, and nothing else to know it by
    let st;
    try { st = await statByUid(r.uid); } catch { return { keep: r }; }
    if (!st?.path || st.is_dir || inTrash(st.path) || inAppFolder(st.path)) return null;
    return { keep: { ...r, path: st.path }, file: { name: st.name || displayName(st.path), path: st.path, size: st.size ?? 0, modified: st.modified ?? st.created ?? 0, uid: st.uid || st.id || r.uid } };
  }));
  // Records added meanwhile (a save while the folders were listed) stay; those looked up are replaced, or go.
  const looked = new Map(before.map((r, i) => [`${r.path}\n${r.uid || ''}`, found[i]]));
  const next = [];
  const seen = new Set();
  for (const r of read(storage)) {
    const key = `${r.path}\n${r.uid || ''}`;
    const kept = looked.has(key) ? looked.get(key)?.keep : r;
    if (!kept || seen.has(kept.path)) continue;
    seen.add(kept.path);
    next.push(kept);
  }
  if (JSON.stringify(next) !== JSON.stringify(read(storage))) write(storage, next);
  const shown = new Set();
  return found.filter((f) => f?.file && /\.(xlsx|xlsm|xls|csv|tsv|ods)$/i.test(f.file.name) && !shown.has(f.file.path) && shown.add(f.file.path)).map(({ file }) => ({
    name: file.name, path: file.path, size: file.size ?? 0, modified: file.modified ?? 0, uid: file.uid || null,
  }));
}
