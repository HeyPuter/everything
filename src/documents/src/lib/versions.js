/**
 * Version history. Every document in the app folder gets a folder of
 * snapshots at `Documents/.versions/<name>/`, one .docx per version, named
 * by the moment it was taken. A document elsewhere on the drive (inside the
 * Puter desktop, Save puts a new one where the user chooses) keeps its
 * snapshots at `Documents/.versions-by-id/<tag>/`, named after the file's id
 * on the drive, which stays the same through a rename or a move. A snapshot is written after a save when the
 * last one is older than VERSION_INTERVAL_MS (or there is none), and whenever
 * the user asks for one; the oldest go once there are more than MAX_VERSIONS.
 * The folder follows the document through renames and goes with it when the
 * document is deleted. Everything here is best effort: a failed snapshot
 * never fails the save.
 */

import * as P from './puter.js';
import { documentRoot } from './document-paths.js';

export const VERSION_INTERVAL_MS = 10 * 60 * 1000;
export const MAX_VERSIONS = 30;
export const VERSIONS_DIR = `${P.FOLDER}/.versions`;
/** Histories of documents outside the app folder, by file id. A sibling of VERSIONS_DIR, so no document name can reach it. */
export const ELSEWHERE_VERSIONS_DIR = `${P.FOLDER}/.versions-by-id`;

const hash = (s) => { const text = String(s ?? ''); let h = 5381; for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
// Two files on one short hash would read, prune and restore each other's snapshots: the tag is hashed twice over.
const uidTag = (uid) => `${hash(uid)}${hash(`${uid}:${String(uid).length}`)}`;

/** A single DOCX history folder, or null for paths that cannot own one safely. */
export function versionsFolder(path) {
  const prefix = `${P.FOLDER}/`;
  if (!path || !path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!/\.docx$/i.test(rest) || rest.includes('/')) return null;
  const stem = P.stripExtension(rest);
  // These names would resolve to all histories (or Documents itself), including
  // when deleteVersions recursively removes a document's snapshot folder.
  if (!stem || stem === '.' || stem === '..') return null;
  return `${VERSIONS_DIR}/${stem}`;
}

/**
 * Puter listings return absolute paths; verify their app folder before sharing a history. A .docx elsewhere on
 * the drive has a history by its id (`uid`, when known); without one it has none.
 */
export async function resolveVersionsFolder(path, uid = null) {
  const own = await appFolderHistory(path);
  if (own || !uid || !/\.docx$/i.test(String(path || ''))) return own;
  // A file inside the app folder but not directly in it (Documents/sub/A.docx) is elsewhere too.
  return `${ELSEWHERE_VERSIONS_DIR}/${uidTag(uid)}`;
}

async function appFolderHistory(path) {
  if (!path?.startsWith('/')) return versionsFolder(path);
  // The app folder's absolute path is learned when a document opens; ask the cloud only when it is not known yet.
  const root = documentRoot() || (await P.statFile(P.FOLDER))?.path;
  if (!root?.startsWith('/') || !path.startsWith(`${root}/`)) return null;
  return versionsFolder(`${P.FOLDER}/${path.slice(root.length + 1)}`);
}

/** The file name of a snapshot taken at `time` (ms): sortable, safe for any file system. */
export function versionName(time) {
  return `${new Date(time).toISOString().replace(/[:.]/g, '-')}.docx`;
}

/** The time (ms) a snapshot name encodes, or null for other files. */
export function parseVersionTime(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.docx$/.exec(String(name || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

/** Whether a save at `now` should leave a snapshot, given when the last one was taken. */
export function shouldSnapshot(lastTime, now, interval = VERSION_INTERVAL_MS) {
  return lastTime == null || now - lastTime >= interval;
}

/** The document's snapshots, newest first: { path, name, time, size }. `uid`: the file's id, for one outside the app folder. */
export async function listVersions(path, { uid = null } = {}) {
  const folder = await resolveVersionsFolder(path, uid);
  if (!folder) return [];
  return listSnapshots(folder);
}

async function listSnapshots(folder) {
  const items = await P.listFolder(folder);
  return items
    .filter((it) => !it.isDir && parseVersionTime(it.name) != null)
    .map((it) => ({ path: it.path, name: it.name, time: parseVersionTime(it.name), size: it.size }))
    .sort((a, b) => b.time - a.time);
}

/** Write a snapshot of `blob` now and trim the history to `keep` entries. */
export async function saveVersion(path, blob, { now = Date.now(), keep = MAX_VERSIONS, meta = null, uid = null } = {}) {
  const folder = await resolveVersionsFolder(path, uid);
  if (!folder || !blob) return null;
  return writeSnapshot(folder, blob, now, keep, meta);
}

/**
 * A snapshot's details beside it, as `<snapshot>.json`: who saved it and the name given to it.
 * Older snapshots have none. Best effort: a version without details is still a version.
 */
export const metaPath = versionPath => versionPath.replace(/\.docx$/i, '.json');
export async function readVersionMeta(version) {
  try {
    const blob = await P.readFile(metaPath(version.path));
    const meta = JSON.parse(await blob.text());
    return meta && typeof meta === 'object' ? { author: typeof meta.author === 'string' ? meta.author.slice(0, 120) : '', label: typeof meta.label === 'string' ? meta.label.slice(0, 120) : '' } : {};
  } catch { return {}; }
}
export async function writeVersionMeta(version, meta) {
  const clean = { author: String(meta.author || '').slice(0, 120), label: String(meta.label || '').slice(0, 120) };
  await P.writeFile(metaPath(version.path), new Blob([JSON.stringify(clean)], { type: 'application/json' }));
  return clean;
}

async function writeSnapshot(folder, blob, now, keep, meta = null) {
  const previous = await listSnapshots(folder);
  // Stay newer than retained entries even if a clock moves backwards or an
  // older filename has become available again after trimming.
  let time = Math.max(now, (previous[0]?.time ?? now - 1) + 1);
  let name;
  while (true) {
    name = versionName(time);
    try {
      // Snapshots are immutable, even when two tabs share a timestamp.
      await P.writeFile(`${folder}/${name}`, blob, { overwrite: false });
      break;
    } catch (error) {
      // Only retry a verified collision. Other write failures still surface.
      if (!await P.fileExists(`${folder}/${name}`)) throw error;
      time += 1;
    }
  }
  const written = { path: `${folder}/${name}`, name, time, size: blob.size };
  if (meta && (meta.author || meta.label)) {
    try { await writeVersionMeta(written, meta); } catch (e) { console.warn('[documents] could not record version details', e); }
  }
  const versions = await listSnapshots(folder);
  for (const v of versions.slice(keep)) {
    try { await P.deleteFile(v.path); } catch (e) { console.warn('[documents] could not trim a version', e); }
    try { await P.deleteFile(metaPath(v.path)); } catch { /* no details were kept */ }
  }
  return written;
}

/**
 * After a save: snapshot when due. `lastTime` is the last snapshot's time,
 * null for none, or undefined when not yet known (the folder is read once).
 * Resolves the time of the newest snapshot afterwards.
 */
export async function snapshotIfDue(path, blob, lastTime, { now = Date.now(), meta = null, uid = null } = {}) {
  if (lastTime != null && !shouldSnapshot(lastTime, now)) return lastTime;
  const folder = await resolveVersionsFolder(path, uid);
  if (!folder) return lastTime ?? null;
  let last = lastTime;
  if (last === undefined) last = (await listSnapshots(folder))[0]?.time ?? null;
  if (!shouldSnapshot(last, now)) return last;
  if (blob) return (await writeSnapshot(folder, blob, now, MAX_VERSIONS, meta)).time;
  return now;
}

/** Move the snapshot folder along with a renamed document (best effort). A history kept by the file's id stays where it is. */
export async function renameVersions(oldPath, newPath) {
  try {
    const [from, to] = await Promise.all([resolveVersionsFolder(oldPath), resolveVersionsFolder(newPath)]);
    if (!from || !to || from === to) return;
    // A folder already at the new name belongs to a document that is gone (the
    // rename made sure no file has the name): left there, even empty, the
    // rename fails and this document shows no history, or that document's.
    let leftover = [];
    try { leftover = await P.listFolder(to); } catch (e) { if (!P.isNotFound(e)) throw e; leftover = null; }
    // An empty listing may also mean no folder at all: removing nothing is no failure.
    if (leftover) { try { await P.deleteFolder(to); } catch (e) { if (leftover.length) throw e; } }
    await P.renameFile(from, P.displayName(to));
  } catch (e) {
    if (!P.isNotFound(e)) console.warn('[documents] could not move the version history', e);
  }
}

/** Remove a deleted document's snapshots (best effort). */
export async function deleteVersions(path, { uid = null } = {}) {
  try {
    const folder = await resolveVersionsFolder(path, uid);
    if (!folder) return;
    await P.deleteFolder(folder);
  } catch (e) {
    if (!P.isNotFound(e)) console.warn('[documents] could not remove the version history', e);
  }
}
