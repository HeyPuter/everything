import { safeName } from '../core/document.js';
export const FOLDER = 'PDF Editor';
const sdk = () => {
  if (!globalThis.puter)
    throw new Error('Puter is unavailable. You can still open and download PDFs on this device.');
  return globalThis.puter;
};
export const isApp = () => globalThis.puter?.env === 'app';
/** Compare the SDK's session in memory; never persist or expose its token. */
export const sessionToken = () => globalThis.puter?.authToken;
export async function currentUser() {
  try {
    const p = sdk();
    return isApp() || (await p.auth.isSignedIn()) ? await p.auth.getUser() : null;
  } catch {
    return null;
  }
}
/** Whether a Puter session exists. The desktop always has one; a missing SDK never does. */
export async function isSignedIn() {
  try {
    return isApp() || !!(await sdk().auth.isSignedIn());
  } catch {
    return false;
  }
}
/**
 * The browser's own words for a request that never reached Puter (Chrome, Firefox, Safari),
 * which say nothing to the reader; Puter's own reasons are left as they are.
 */
const LOST_CONNECTION =
  /^(?:failed to fetch|networkerror when attempting to fetch resource\.?|load failed)$/i;
export const isConnectionFailure = (error) =>
  error?.code === 'connection-failed' ||
  LOST_CONNECTION.test(String(error?.message || error?.error?.message || '').trim());
/** Rethrow a lost connection as a message saying what could not be done, and what to do. */
const overConnection =
  (done, subject = 'The PDF') =>
  (error) => {
    if (!isConnectionFailure(error)) throw error;
    const failure = new Error(
      `${subject} could not be ${done} because the connection to Puter failed. ${
        done === 'saved' ? 'Your changes are still here. ' : ''
      }Check your connection and try again.`,
    );
    failure.code = 'connection-failed';
    throw failure;
  };
/** Run an SDK call, reporting a lost connection by what could not be done. */
const overNetwork = (call, done, subject) =>
  Promise.resolve().then(call).catch(overConnection(done, subject));
/** Whether an error means the person closed Puter's sign-in dialog rather than a failure. */
export const isSignInCancelled = (error) => error?.code === 'sign-in-cancelled';
export async function signIn() {
  try {
    await sdk().auth.signIn();
  } catch (error) {
    // The SDK rejects with a plain object, {error, msg}, not an Error: a closed dialog is a
    // cancel, which callers pass over quietly; anything else needs a readable message.
    if (error instanceof Error) throw error;
    const normalized = new Error(
      error?.error === 'auth_window_closed'
        ? 'The sign-in was cancelled.'
        : error?.msg || error?.message || 'Puter could not sign you in. Please try again.',
    );
    if (error?.error === 'auth_window_closed') normalized.code = 'sign-in-cancelled';
    throw normalized;
  }
  return sdk().auth.getUser();
}
/**
 * Learn about sign-ins the SDK performs on its own: on the open web it opens Puter's dialog
 * before a cloud call made without a session and then calls this with the user.
 */
export function onAuth(handler) {
  if (globalThis.puter) globalThis.puter.onAuth = handler;
}
export async function signOut() {
  if (isApp()) return;
  await sdk().auth.signOut();
}
export async function listFiles() {
  try {
    return (await sdk().fs.readdir(FOLDER))
      .filter((f) => !f.is_dir && !f.isDir && /\.pdf$/i.test(f.name))
      .map((f) => ({ ...f, path: f.path || `${FOLDER}/${f.name}` }));
  } catch (e) {
    if (['subject_does_not_exist', 'ENOENT'].includes(e?.code || e?.error?.code)) return [];
    throw e;
  }
}
/** Enforce import limits on the returned Blob before allocating an in-memory byte buffer. */
export async function readFile(path, { maxBytes = Infinity, signal } = {}) {
  signal?.throwIfAborted();
  const file = await overNetwork(() => sdk().fs.read(path), 'read');
  signal?.throwIfAborted();
  if (file.size > maxBytes)
    throw new Error(`Choose a PDF smaller than ${maxBytes / (1024 * 1024)} MB.`);
  const bytes = await overNetwork(() => file.arrayBuffer(), 'read');
  signal?.throwIfAborted();
  return new Uint8Array(bytes);
}
export async function saveFile(name, bytes, path = null) {
  return overNetwork(
    () =>
      sdk().fs.write(
        path || `${FOLDER}/${safeName(name)}`,
        new Blob([bytes], { type: 'application/pdf' }),
        { overwrite: !!path, dedupeName: !path, createMissingParents: true },
      ),
    'saved',
  );
}
export function pickFile() {
  return sdk().ui.showOpenFilePicker({ accept: '.pdf', multiple: false });
}
export function saveAs(name, bytes) {
  return overNetwork(
    () =>
      sdk().ui.showSaveFilePicker(new Blob([bytes], { type: 'application/pdf' }), safeName(name)),
    'saved',
  );
}
export const deleteFile = (path) => overNetwork(() => sdk().fs.delete(path), 'deleted');
export const renameFile = (path, name) =>
  overNetwork(() => sdk().fs.rename(path, safeName(name)), 'renamed');
/** Whether an SDK error means the file or folder is not there (any more). */
export function isNotFound(error) {
  const code = error?.code || error?.error?.code || '';
  if (code === 'subject_does_not_exist' || code === 'ENOENT') return true;
  const message = String(error?.message || error?.error?.message || '').toLowerCase();
  return /not found|does not exist|no such/.test(message);
}
/** Does a desktop item (a launch, a drop, a listing) name a folder rather than a file? */
export const isDirItem = (item) =>
  !!(item?.is_dir || item?.isDir || item?.isDirectory || item?.fsentry_is_dir);
/** Is the path in the desktop's Trash, where a deleted file waits before it is removed? */
export const inTrash = (path) =>
  typeof path === 'string' && /^(?:\/[^/]+|~)\/Trash(?:\/|$)/.test(path);
/**
 * What the app remembers about a cloud file to notice when someone else changes it: where it
 * is, its id (which survives a move or rename), its size, and when it was last written, in
 * milliseconds (the drive reports seconds in some places and milliseconds in others).
 */
export function fileInfo(item) {
  if (!item?.path) return null;
  const modified = Number(item.modified);
  return {
    path: item.path,
    name: item.name || item.path.split('/').pop(),
    uid: item.uid || item.id || null,
    size: Number(item.size) || 0,
    modified: modified > 0 ? (modified < 1e12 ? modified * 1000 : modified) : 0,
    dir: isDirItem(item),
  };
}
export const canStat = () => typeof globalThis.puter?.fs?.stat === 'function';
/** The file at a path, or with `{ uid }` wherever it is now; null when it is gone. */
export async function statFile(target) {
  try {
    return fileInfo(await sdk().fs.stat(target));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
/** A cloud file's contents as a Blob, for pictures dropped from the desktop. */
export async function readBlob(path, { maxBytes = Infinity, signal } = {}) {
  signal?.throwIfAborted();
  const file = await overNetwork(() => sdk().fs.read(path), 'read', 'The file');
  signal?.throwIfAborted();
  if (file.size > maxBytes)
    throw new Error(`Choose a file smaller than ${maxBytes / (1024 * 1024)} MB.`);
  return file;
}
/** Name the desktop window after the open document; outside a desktop window this does nothing. */
let windowTitle = null;
export function setWindowTitle(title) {
  if (!isApp() || title === windowTitle) return;
  try {
    globalThis.puter.ui?.setWindowTitle?.(title);
    windowTitle = title;
  } catch {
    /* Not in a desktop window. */
  }
}
/**
 * Take over the desktop window's close button: the window then stays open until exitApp().
 * Nothing is taken over where the window could never close again (an SDK without exit()).
 */
export function onWindowClose(handler) {
  const p = globalThis.puter;
  if (!isApp() || typeof p?.ui?.onWindowClose !== 'function' || typeof p.exit !== 'function')
    return false;
  p.ui.onWindowClose(handler);
  return true;
}
export function exitApp() {
  globalThis.puter?.exit?.();
}
