/**
 * Everything the app asks of Puter, in one place, so the rest of the code
 * never touches the global directly and the dev harness can swap in a mock.
 *
 *  auth      sign-in state and the current user
 *  env       'app' inside the Puter desktop, 'web' on a standalone page
 *  files     documents as real files in the app's own folder on Puter FS
 *  pickers   Puter's Open / Save dialogs, feature-detected
 *
 * Files are never stored in KV. Documents are .docx blobs written to
 * `Documents/<name>.docx`, so they show up as ordinary files a user can
 * move, share, or open with any other app.
 */

import { DOCUMENT_FOLDER, documentRoot, rememberDocumentRoot, learnDocumentPath } from './document-paths.js';

export const FOLDER = DOCUMENT_FOLDER;
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const OPENABLE = /\.(docx|dotx|docm|hwp|hwpx)$/i;
export const DOCUMENT_EXTENSIONS = ['.docx', '.dotx', '.docm', '.hwp', '.hwpx'];
/** Device imports: DOCX, Hanword, and the text formats the engine reads. */
export const IMPORTABLE = /\.(docx|dotx|docm|hwp|hwpx|md|markdown|txt|html?)$/i;
export const IMPORT_ACCEPT = '.docx,.dotx,.docm,.hwp,.hwpx,.md,.markdown,.txt,.html,.htm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/x-hwp,application/haansofthwp,application/vnd.hancom.hwp,application/hwp+zip,text/markdown,text/plain,text/html';
/** Image types the engine places on the page, with their MIME types. */
export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
export const IMAGE_EXTENSIONS = Object.keys(IMAGE_TYPES);

/** The MIME type for a file name by its extension, or '' when unknown. */
export function mimeFor(name) {
  const m = /\.[^./\\]+$/.exec(String(name || ''));
  if (m && /\.hwp$/i.test(m[0])) return 'application/x-hwp';
  if (m && /\.hwpx$/i.test(m[0])) return 'application/hwp+zip';
  return (m && IMAGE_TYPES[m[0].toLowerCase()]) || (m && OPENABLE.test(m[0]) ? DOCX_MIME : '');
}

const sdk = () => (typeof puter !== 'undefined' ? puter : null);
const pathLookups = new WeakMap();

/** Resolve aliases before a document opens directly, without changing its filesystem path. */
export async function prepareDocumentPaths(owner = sdk()) {
  if (!owner?.fs?.stat || documentRoot(owner)) return;
  if (!pathLookups.has(owner)) pathLookups.set(owner, (async () => {
    try { rememberDocumentRoot((await owner.fs.stat(FOLDER))?.path, owner); }
    catch { /* Local settings must not prevent opening a file. */ }
  })().finally(() => pathLookups.delete(owner)));
  await pathLookups.get(owner);
}

export function hasSDK() {
  return !!sdk();
}

/** 'app' when launched inside the Puter desktop, otherwise 'web'. */
export function env() {
  return sdk()?.env || 'web';
}

export function isApp() {
  return env() === 'app';
}

/* ---------- Auth ---------- */

export async function isSignedIn() {
  try {
    return !!(await Promise.resolve(sdk()?.auth.isSignedIn()));
  } catch {
    return false;
  }
}

export async function signIn() {
  await sdk().auth.signIn();
}

export function signOut() {
  return sdk()?.auth.signOut();
}

export async function getUser() {
  try {
    return await sdk().auth.getUser();
  } catch {
    return null;
  }
}

/** Optional account decoration: older SDKs and failed requests keep the initial. */
export async function getProfilePicture() {
  try {
    const picture = await sdk()?.auth?.getProfilePicture?.();
    // Only inline images: never turn an unexpected SDK value into a remote request.
    return typeof picture === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(picture) ? picture : null;
  } catch {
    return null;
  }
}

/**
 * Learn about sign-ins the SDK performs on its own: on the open web it opens
 * Puter's dialog before any cloud call made without a session (an AI request,
 * say) and then calls this with the user.
 */
export function onAuth(handler) {
  const owner = sdk();
  if (owner) owner.onAuth = handler;
}

/* ---------- Names ---------- */

export function isNotFound(err) {
  const code = err?.code || err?.error?.code || '';
  const msg = String(err?.message || err?.error?.message || err || '').toLowerCase();
  return code === 'subject_does_not_exist' || code === 'ENOENT' || msg.includes('not found') || msg.includes('does not exist') || msg.includes('no such');
}

export function displayName(path) {
  return String(path || '').split('/').pop();
}

export function stripExtension(name) {
  return String(name || '').replace(/\.[^./\\]+$/, '');
}

/**
 * A safe file name: no path separators or control characters, trimmed. The
 * invisible format characters go too: a right-to-left override would show
 * "exe.docx" as "xcod.exe", and a zero-width space makes two names look
 * alike while the "already exists" checks tell them apart.
 */
/** The document name a typed file name stands for: the extension off, then made safe (dots alone are no name). */
export function documentStem(name) {
  return sanitizeName(String(name || '').replace(/\.docx$/i, ''));
}

export function sanitizeName(name) {
  // Trim again after cutting to length: a space at the cut would end the name.
  // A cut through an emoji would leave half of it, which no URL can carry.
  const clean = String(name || '').replace(/[/\\]/g, ' ').replace(/[\x00-\x1f\x7f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').trim().slice(0, 200).replace(/[\ud800-\udbff]$/, '').trim();
  // Dots alone name no file: "..docx" would show as "." and its version history could not follow it.
  return /^\.+$/.test(clean) ? '' : clean;
}

export function ensureDocx(name) {
  const clean = sanitizeName(name);
  return /\.docx$/i.test(clean) ? clean : `${clean}.docx`;
}

/* ---------- Files ---------- */

/** Document files in the app folder, newest first. */
export async function listFiles() {
  const owner = sdk();
  let items;
  try {
    items = await owner.fs.readdir(FOLDER);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  for (const item of items || []) {
    if (item?.name && !item.name.includes('/') && item.path?.startsWith('/')) {
      learnDocumentPath(`${FOLDER}/${item.name}`, item.path, owner);
      break;
    }
  }
  await prepareDocumentPaths(owner);
  return (items || [])
    .filter((it) => !it.is_dir && !it.isDir && OPENABLE.test(it.name))
    .map((it) => ({
      name: it.name,
      path: it.path || `${FOLDER}/${it.name}`,
      size: it.size ?? 0,
      modified: it.modified ?? it.created ?? 0,
      uid: it.uid || it.id || null,
    }))
    .sort((a, b) => (b.modified || 0) - (a.modified || 0));
}

/** Read a file as a Blob. */
export async function readFile(path) {
  const blob = await sdk().fs.read(path);
  return blob instanceof Blob ? blob : new Blob([blob]);
}

/** Write a Blob to a path, creating the folder when needed. Returns the FSItem. */
export async function writeFile(path, blob, { dedupe = false, overwrite = !dedupe } = {}) {
  // The write creates the folder itself; a mkdir round trip before every autosave would only double the requests.
  return sdk().fs.write(path, blob, { overwrite, dedupeName: dedupe, createMissingParents: true });
}

/** Create a fresh file atomically and retain its actual name if another writer wins a collision. */
export async function createFile(path, blob) {
  return (await createFileWithMetadata(path, blob)).path;
}

/** Create a file and retain the returned timestamp for the next conflict check. */
export async function createFileWithMetadata(path, blob) {
  const owner = sdk();
  const item = await writeFile(path, blob, { dedupe: true });
  // Keep the caller's directory representation (app-relative or absolute).
  const name = item?.name || displayName(item?.path || path);
  const target = `${path.slice(0, path.lastIndexOf('/') + 1)}${name}`;
  learnDocumentPath(target, item?.path, owner);
  return { path: target, modified: item?.modified ?? null };
}

export async function deleteFile(path) {
  await sdk().fs.delete(path);
}

/** Remove a folder and everything in it. */
export async function deleteFolder(path) {
  await sdk().fs.delete(path, { recursive: true });
}

/** Everything directly inside a folder ({ name, path, size, modified, isDir }); [] when it does not exist. */
export async function listFolder(path) {
  let items;
  try {
    items = await sdk().fs.readdir(path);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  return (items || []).map((it) => ({
    name: it.name,
    path: it.path || `${path}/${it.name}`,
    size: it.size ?? 0,
    modified: it.modified ?? it.created ?? 0,
    isDir: !!(it.is_dir || it.isDir),
  }));
}

export async function renameFile(path, newName) {
  return sdk().fs.rename(path, newName);
}

export async function statFile(path) {
  try {
    return await sdk().fs.stat(path);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function fileExists(path) {
  return !!(await statFile(path));
}

/** A name that does not collide with an existing file in the folder. */
export async function uniqueName(base) {
  const stem = stripExtension(base) || 'Untitled document';
  let name = `${stem}.docx`;
  if (!await fileExists(`${FOLDER}/${name}`)) return name;
  // Read collisions together: many untitled documents must not turn the first
  // autosave into hundreds of sequential cloud round trips. Creation still
  // deduplicates atomically if another writer claims the suggested name.
  let names;
  try { names = new Set((await listFolder(FOLDER)).map((item) => item.name)); }
  catch { /* Keep stat-based naming available when listing is not permitted. */ }
  let n = 2;
  do { name = `${stem} ${n++}.docx`; }
  while (names ? names.has(name) : await fileExists(`${FOLDER}/${name}`));
  return name;
}

/* ---------- Pickers ---------- */

export function canPickFiles() {
  return typeof sdk()?.ui?.showOpenFilePicker === 'function';
}

export function canSaveFiles() {
  return typeof sdk()?.ui?.showSaveFilePicker === 'function';
}

/** Puter's Open dialog -> { path, name } or null when cancelled. Documents by default. */
export async function pickFile({ accept = DOCUMENT_EXTENSIONS } = {}) {
  if (!canPickFiles()) return null;
  let result;
  try {
    result = await sdk().ui.showOpenFilePicker({ multiple: false, accept });
  } catch {
    return null;
  }
  const item = Array.isArray(result) ? result[0] : result;
  if (!item) return null;
  return { path: item.path, name: item.name || displayName(item.path), item };
}

/**
 * Pick an image on Puter and read it: a File (named and typed like the
 * original) ready for the page, or null when cancelled.
 */
export async function pickImage() {
  const picked = await pickFile({ accept: IMAGE_EXTENSIONS });
  if (!picked) return null;
  const blob = await readFile(picked.path);
  return new File([blob], picked.name, { type: blob.type || mimeFor(picked.name) || 'application/octet-stream' });
}

/**
 * Puter's Save dialog with content. The SDK writes the file itself.
 * When the user cancels, the SDK's promise never settles, so callers must
 * not block UI on this.
 */
export async function saveFileAs(blob, suggestedName) {
  if (!canSaveFiles()) return null;
  const item = await sdk().ui.showSaveFilePicker(blob, suggestedName);
  if (!item) return null;
  return { path: item.path, name: item.name || displayName(item.path) };
}

/* ---------- Small per-user settings ---------- */

/** Whether Puter's key-value store is reachable (puter.kv). */
export function canUseKv() {
  return typeof sdk()?.kv?.get === 'function' && typeof sdk()?.kv?.set === 'function';
}

/** A per-user setting from Puter's key-value store, or null. */
export async function kvGet(key) {
  return canUseKv() ? sdk().kv.get(key) : null;
}

/** Save a per-user setting in Puter's key-value store. */
export async function kvSet(key, value) {
  if (canUseKv()) await sdk().kv.set(key, value);
}

/* ---------- AI ---------- */

/** Whether Puter's AI is reachable (puter.ai.chat). */
export function canUseAi() {
  return typeof sdk()?.ai?.chat === 'function';
}

/** One chat completion for a prompt; resolves the SDK's response object. */
export function aiChat(prompt, options = {}) {
  return sdk().ai.chat(prompt, options);
}

/** Whether Puter can make pictures from text (puter.ai.txt2img). */
export function canMakeImages() {
  return typeof sdk()?.ai?.txt2img === 'function';
}

/** A picture for a description; resolves the SDK's <img> element. */
export function makeImage(prompt, options = {}) {
  return sdk().ai.txt2img(prompt, options);
}

/** Whether Puter's text-to-speech is reachable (puter.ai.txt2speech). */
export function canSpeak() {
  return typeof sdk()?.ai?.txt2speech === 'function';
}

/** Speech for a piece of text; resolves an HTMLAudioElement ready to play. */
export async function speak(text, options = {}) {
  const audio = await sdk().ai.txt2speech(text, options);
  if (!audio || typeof audio.play !== 'function') throw new Error('No speech came back');
  return audio;
}

/* ---------- Hosting ---------- */

/** Whether Puter hosting (puter.site subdomains) is reachable. */
export function canHost() {
  return typeof sdk()?.hosting?.create === 'function';
}

export function hostingCreate(subdomain, dirPath) {
  return sdk().hosting.create(subdomain, dirPath);
}

export function hostingUpdate(subdomain, dirPath) {
  return sdk().hosting.update(subdomain, dirPath);
}

export function hostingDelete(subdomain) {
  return sdk().hosting.delete(subdomain);
}

/* ---------- Desktop integration ---------- */

export function setWindowTitle(title) {
  try { sdk()?.ui?.setWindowTitle?.(title); } catch { /* not in a window */ }
}

/** Register for "Open with" launches from the Puter desktop. */
export function onLaunchedWithItems(handler) {
  try {
    sdk()?.ui?.onLaunchedWithItems?.((items) => handler(Array.isArray(items) ? items : [items]));
  } catch { /* not supported */ }
}

/** Browser download of a Blob (for the open web; inside Puter, prefer saveFileAs). */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
