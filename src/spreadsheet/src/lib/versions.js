/**
 * Version history: snapshots of a spreadsheet kept as .xlsx files under
 * Spreadsheets/.versions/<name> ~<id>/. One is written automatically when a save
 * lands and the newest snapshot is older than AUTO_VERSION_MS; any number can
 * be saved by hand with a label. Unlabeled snapshots beyond MAX_VERSIONS are
 * pruned, oldest first; labeled ones are kept.
 *
 * A folder is named after the file it belongs to and after the file's id on the
 * drive, which stays the same whatever the file is called and wherever it is
 * moved: a rename or a move made outside the app, which the app never sees, no
 * longer leaves the history behind under the old name. Histories kept under the
 * name alone — from before ids were used, and for a file whose id is not known —
 * are still read, pruned and deleted with the rest, and the next snapshot a file
 * with an id takes moves its own history into the folder the id names.
 */

import * as P from './puter.js';

export const VERSIONS_DIR = '.versions';
export const AUTO_VERSION_MS = 10 * 60 * 1000;
export const MAX_VERSIONS = 30;

const hash = (s) => { const text = String(s ?? ''); let h = 5381; for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
// A file's id is the one thing that tells its history from every other file's, so its tag is hashed
// twice over: two files landing on one short hash would read, prune and take over each other's snapshots.
const uidTag = (uid) => `~${hash(uid)}${hash(`${uid}:${String(uid).length}`)}`;

/** The file a history belongs to: `{ path, uid }`, or a bare path for a file whose id on the drive is not known. */
function fileOf(file) {
  return typeof file === 'string' || !file ? { path: file || null, uid: null } : { path: file.path || null, uid: file.uid || null };
}

/**
 * The folders a file's snapshots may be kept in, by what names each:
 *
 *  uid   the file's id on the drive, where its history is kept once the id is known;
 *  name  the file's name, where every history was kept before ids were used and where one
 *        is still kept for a file with no id (never saved, or a look-up that failed);
 *  path  the absolute address, from before one address was kept per file, when a file in
 *        the app folder opened by that spelling got a folder of its own, as if it lay elsewhere.
 */
function spellings(file) {
  const { path, uid } = fileOf(file);
  const inApp = P.inAppFolder(path);
  return {
    uid: uid ? folderFor(path, inApp, uid) : null,
    name: folderFor(path, inApp),
    path: inApp && P.isAbsolutePath(path) ? folderFor(path, false) : null,
    tag: uid ? uidTag(uid) : null,
  };
}

/**
 * Where a document's snapshots live: inside the app folder, under the file's name and a short
 * tag of its id, which follows the file through any rename or move, wherever it was made. With
 * no id the folder is named after the file alone: a file elsewhere on the drive gets a short
 * hash of its path, and a name the folder cannot carry as it is ("Q3: Forecast") a short hash of
 * the name, so it never shares a history with the file whose name it was cut down to
 * ("Q3 Forecast"): mixed histories restore and prune the wrong file.
 */
export function versionsFolder(file) {
  const of = spellings(file);
  return of.uid || of.name;
}

function folderFor(path, inApp, uid = null) {
  const file = P.displayName(path);
  const rawStem = file.replace(/\.[^.]+$/, '');
  const stem = rawStem.replace(/[\\/:*?"<>|]/g, '').trim();
  const base = !stem || /^\.+$/.test(stem) ? 'Untitled' : stem; // never "..", which would name the parent folder
  // Budget.csv and Budget.xlsx are different files: only the app's own .xlsx keeps the bare stem.
  const ext = /\.xlsx$/i.test(file) ? '' : file.match(/\.([^.]+)$/)?.[1].toLowerCase();
  const name = ext ? `${base} ${ext}` : base;
  // An id's tag opens with a ~, which no hash of a name or of a path carries: the two are never confused.
  const tag = uid ? uidTag(uid) : !inApp ? hash(path) : base !== rawStem ? hash(rawStem) : '';
  return `${P.FOLDER}/${VERSIONS_DIR}/${tag ? `${name} ${tag}` : name}`;
}

/**
 * The folder a file's snapshots went to under a name it no longer has: renamed or moved outside the
 * app, the file keeps its id, and so does the folder's tag, while the readable part of the name is
 * the one the file had when the last snapshot was written. It is looked for only when the folder the
 * file's name and id would make is not there, so an ordinary read asks the drive for nothing extra.
 * (Empty for a file with no id: nothing names it. A history put aside is not one, and ends elsewhere.)
 */
async function strayedFolders(of) {
  if (!of.tag) return [];
  return (await P.listDir(`${P.FOLDER}/${VERSIONS_DIR}`))
    .filter((it) => it.is_dir && it.name.endsWith(` ${of.tag}`))
    .map((it) => `${P.FOLDER}/${VERSIONS_DIR}/${it.name}`);
}

/** Every folder this file's snapshots are read from: the one its name and id make, the older spellings, and any the file strayed from under an older name. */
async function foldersOf(file) {
  const of = spellings(file);
  const here = [of.uid || of.name, of.name, of.path].filter(Boolean);
  const strayed = of.uid && !(await P.fileExists(of.uid)) ? await strayedFolders(of) : [];
  return [...new Set([...here, ...strayed])];
}

/**
 * A file with an id takes over the history it has: the folder is renamed to the one the file's name
 * and id make, whether the history was kept under the name alone (from before ids were used) or
 * under the name the file had when it last took a snapshot, a rename made outside the app having
 * changed the name since. Only when that folder is not there already — and what is kept under a bare
 * name belongs to the file that bears the name, which is this one, a history left behind by a file
 * that is gone having been put aside when the name was taken (see parkVersions). Callers write inside
 * the document's write queue; reading a history never moves anything. True when a folder was taken over.
 */
export async function adoptVersionsByUid(file) {
  const of = spellings(file);
  if (!of.uid || of.uid === of.name || await P.fileExists(of.uid)) return false;
  // The file's own, under a name it has left behind, before a bare name, which any file of that name could have written.
  for (const old of [...await strayedFolders(of), of.name, of.path].filter(Boolean)) {
    if (old === of.uid || !(await P.fileExists(old))) continue;
    await P.renameFile(old, P.displayName(of.uid));
    return true;
  }
  return false;
}

/** "2026-08-28T13-45-10[.SSS]Z[~id] My label.xlsx"; the id separates concurrent snapshots. */
export function versionFileName(when = new Date(), label = '', id = '') {
  const stamp = when.toISOString().replace(/\.000Z$/, 'Z').replace(/:/g, '-');
  const clean = String(label || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${stamp}${id ? `~${id}` : ''}${clean ? ` ${clean}` : ''}.xlsx`;
}

/** { at, label } from a snapshot's file name, or null for other files. */
export function parseVersionName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d{3}))?Z(?:~[0-9a-f]{32})?(?: (.*))?\.xlsx$/.exec(name);
  if (!m) return null;
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0));
  return Number.isFinite(at) ? { at, label: m[8] || '' } : null;
}

/** Snapshots of a document, newest first: [{ name, path, at, label, size }]. */
export async function listVersions(file) {
  const lists = await Promise.all((await foldersOf(file)).map(async (folder) => (await P.listDir(folder))
    .map((it) => ({ ...parseVersionName(it.name), name: it.name, path: it.path || `${folder}/${it.name}`, size: it.size ?? 0 }))));
  return lists.flat()
    .filter((v) => v.at != null)
    .sort((a, b) => b.at - a.at);
}

/** Write a snapshot of `blob` (the .xlsx bytes) for `file`; returns its entry. */
export async function saveVersion(file, blob, label = '', when = new Date()) {
  // The history this file kept under its name, if it still has one, becomes the history its id names.
  await adoptVersionsByUid(file).catch(() => {});
  const folder = versionsFolder(file);
  // Timestamp-only names overwrite snapshots taken in the same second, including from other tabs.
  const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16).padStart(8, '0')).join('');
  const name = versionFileName(when, label, id);
  await P.writeFile(`${folder}/${name}`, blob);
  await pruneVersions(file).catch(() => {});
  return { name, path: `${folder}/${name}`, at: when.getTime(), label, size: blob.size ?? 0 };
}

/** Drop the oldest unlabeled snapshots beyond the cap. Returns how many were removed. */
export const RESTORE_LABEL = 'Before restore';
/** What a file changed elsewhere held when the user chose to overwrite it with their own version. */
export const OVERWRITE_LABEL = 'Before overwrite';

export async function pruneVersions(file, max = MAX_VERSIONS) {
  const versions = await listVersions(file);
  // Snapshots the app labels on its own (before a restore or an overwrite) age out like unlabelled
  // ones; only the user's labels are kept for good.
  const auto = versions.filter((v) => !v.label || v.label === RESTORE_LABEL || v.label === OVERWRITE_LABEL);
  const extra = auto.slice(max);
  for (const v of extra) await P.deleteFile(v.path).catch(() => {});
  return extra.length;
}

/** A document was deleted: its snapshots go with it (best effort). */
export async function removeVersions(file) {
  let removed = false;
  for (const folder of await foldersOf(file)) {
    if (!(await P.fileExists(folder))) continue;
    await P.deleteFile(folder, { recursive: true });
    removed = true;
  }
  return removed;
}

/**
 * A history kept by name, and a file deleted or renamed outside the app leaves its history behind:
 * the next file of that name must not take it for its own (its snapshots would be listed as the new
 * file's, restored into it, and the new file's first snapshot suppressed). Such a folder is put aside
 * under a name no file's history is read from, its snapshots kept, rather than merged with or deleted.
 */
async function parkFolder(folder, when = new Date()) {
  const stamp = when.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  const id = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  const parked = `${P.displayName(folder)} (orphaned ${stamp} ${id})`;
  await P.renameFile(folder, parked);
  return `${P.FOLDER}/${VERSIONS_DIR}/${parked}`;
}

/**
 * A file was just created at `path`: a history already under its name is a gone file's, and is put
 * aside (see parkFolder). Only the folders a name makes are looked at: the one this file's own id
 * names is its own, and no file that is gone can have left it. The folders put aside.
 */
export async function parkVersions(file) {
  const of = spellings(file);
  const parked = [];
  for (const folder of [...new Set([of.name, of.path].filter(Boolean))]) {
    if (await P.fileExists(folder)) parked.push(await parkFolder(folder));
  }
  return parked;
}

/**
 * A document was renamed or moved: its snapshots follow (best effort; a history already at the
 * destination, a gone file's, is put aside). A history kept under the file's id keeps the readable
 * part of its name in step with the file's, and is found by its id even when a rename made outside
 * the app leaves it behind under the old one (see strayedFolders).
 */
export async function moveVersions(from, to) {
  const source = spellings(from);
  const target = spellings(to);
  let moved = false;
  // The oldest spelling first, so that the folder a history is read from is the last to land.
  for (const kind of ['path', 'name', 'uid']) {
    const a = source[kind];
    const b = target[kind];
    if (!a || !b || a === b) continue;
    if (!(await P.fileExists(a))) {
      // Nothing of this file's under the old name, while a history sits under the new one: that one
      // is a gone file's — this file's own is kept under its id — and is put aside rather than read
      // as this file's, as it is wherever a name a history was left under is taken.
      if (kind === 'name' && source.uid && await P.fileExists(b)) await parkFolder(b);
      continue;
    }
    if (await P.fileExists(b)) {
      // A history at the destination is a gone file's and is put aside, as it is wherever a name is
      // taken. The absolute spelling's folder is left alone, as it always has been.
      if (kind === 'path') continue;
      await parkFolder(b);
    }
    try { await P.renameFile(a, P.displayName(b)); moved = true; }
    catch (e) { if (kind !== 'path') throw e; } // the oldest spelling moves best effort, as it always has
  }
  return moved;
}

export async function deleteVersion(versionPath) {
  await P.deleteFile(versionPath);
}

export async function readVersion(versionPath) {
  return P.readFile(versionPath);
}

/** Is it time for another automatic snapshot? */
export function dueForVersion(lastAt, now = Date.now(), every = AUTO_VERSION_MS) {
  return lastAt == null || now - lastAt >= every;
}
