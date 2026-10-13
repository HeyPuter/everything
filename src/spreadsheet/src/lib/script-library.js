/**
 * The user's own scripts, apart from any workbook, and the user's trust in scripts that came inside files.
 *
 * My Scripts: each script is a .js file in the Scripts folder beside the app's spreadsheets on the user's Puter
 * drive, named after the script, so it can be run on any workbook (and is a plain file the user can see, back up
 * or share like any other).
 *
 * Trust: a script that arrives inside a workbook could have been written by anyone, so it runs only once the user
 * says so. What the user has written, edited, saved or allowed is remembered by its code's fingerprint, kept with
 * the account (puter.kv, so every device knows it) and copied in this browser; a script whose code changes is a new
 * script and is asked about again.
 */
import * as P from './puter.js';
import { storageScope, accountStorageKey } from './account-storage.js';
import { scriptFingerprint } from '../core/scripts.js';

export const LIBRARY_FOLDER = `${P.FOLDER}/Scripts`;
const TRUST_KEY = 'spreadsheet:script-trust:v1';
const TRUST_RECORD = 'spreadsheet:script-trust:v1:';
const MAX_TRUSTED = 1000;

/** A file name for a script name: the characters a drive refuses replaced, and .js on the end. */
export function libraryFileName(name) {
  const stem = String(name ?? '').trim().replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '-').replace(/^\.+/, '').slice(0, 80) || 'Script';
  return `${stem}.js`;
}

/** The scripts in My Scripts, by name: [{ name, path, modified }]; [] without a drive or a folder. */
export async function listLibrary() {
  if (!P.hasSDK()) return [];
  const items = await P.listDir(LIBRARY_FOLDER);
  return items.filter((it) => !it.is_dir && /\.js$/i.test(it.name))
    .map((it) => ({ name: it.name.replace(/\.js$/i, ''), path: it.path, modified: it.modified || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readLibraryScript(path) {
  return new TextDecoder().decode(await P.readFile(path));
}

/** Save `code` to My Scripts as `name`, replacing a script of that name. Returns the path. */
export async function saveToLibrary(name, code) {
  const path = `${LIBRARY_FOLDER}/${libraryFileName(name)}`;
  await P.writeFile(path, new Blob([String(code ?? '')], { type: 'text/javascript' }), { overwrite: true });
  await trustScript(code);
  return path;
}

export async function deleteFromLibrary(path) {
  await P.deleteFile(path);
}

export async function renameInLibrary(path, name) {
  return P.renameFile(path, libraryFileName(name));
}

/* ---------- Trust ---------- */

const localKey = () => `${accountStorageKey(TRUST_KEY, storageScope())}list`;
function localTrusted() {
  try { return new Set(JSON.parse(globalThis.localStorage?.getItem(localKey()) || '[]')); } catch { return new Set(); }
}
function rememberLocally(fingerprint) {
  try {
    const list = [...localTrusted()].filter((f) => f !== fingerprint);
    list.push(fingerprint);
    globalThis.localStorage?.setItem(localKey(), JSON.stringify(list.slice(-MAX_TRUSTED)));
  } catch { /* optional storage */ }
}

/** Remember that the user stands behind this code (wrote it, edited it, saved it, or allowed it). */
export async function trustScript(code) {
  const fingerprint = scriptFingerprint(code);
  rememberLocally(fingerprint);
  await P.kvSet(`${TRUST_RECORD}${fingerprint}`, '1');
}

/** Whether this code has been trusted before, on this device or another of the account's. */
export async function isScriptTrusted(code) {
  const fingerprint = scriptFingerprint(code);
  if (localTrusted().has(fingerprint)) return true;
  if ((await P.kvGet(`${TRUST_RECORD}${fingerprint}`)) === '1') { rememberLocally(fingerprint); return true; }
  return false;
}
