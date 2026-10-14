// Thin wrapper around Puter.js (the only backend). Every call degrades
// gracefully when the SDK is missing (offline, blocked, tests).


export function sdk() {
  return typeof window !== 'undefined' && window.puter ? window.puter : null;
}

export function env() {
  return sdk()?.env || 'web';
}

/** Inside the Puter desktop the app window owns the session: no sign-out. */
export function canSignOut() {
  return env() !== 'app';
}

export function isSignedIn() {
  try {
    return Boolean(sdk()?.auth?.isSignedIn());
  } catch {
    return false;
  }
}

export async function signIn() {
  const p = sdk();
  if (!p) throw new Error('Puter is not available. Check your connection.');
  await p.auth.signIn();
  return isSignedIn();
}

export async function signOut() {
  if (!canSignOut()) return;
  cachedHome = null;
  await sdk()?.auth.signOut();
}

export async function getUser() {
  try {
    return (await sdk()?.auth.getUser()) || null;
  } catch {
    return null;
  }
}

/** Base64 data URL of the user's profile picture, or null. */
export async function getProfilePicture() {
  try {
    return (await sdk()?.auth.getProfilePicture?.()) || null;
  } catch {
    return null;
  }
}

/** Puter file picker. Resolves FSItem[] (never resolves on cancel, per the SDK). */
export async function pickFiles({ multiple = true, accept, path } = {}) {
  const p = sdk();
  if (!p?.ui?.showOpenFilePicker) throw new Error('The Puter file picker is not available.');
  const r = await p.ui.showOpenFilePicker({ multiple, accept, ...(path ? { path } : {}) });
  return Array.isArray(r) ? r : [r];
}

/** Puter save dialog. Resolves the saved FSItem. */
export async function pickSave(blob, suggestedName) {
  const p = sdk();
  if (!p?.ui?.showSaveFilePicker) throw new Error('The Puter save dialog is not available.');
  return p.ui.showSaveFilePicker(blob, suggestedName);
}

export async function readFile(path) {
  return sdk().fs.read(path);
}

export async function writeFile(path, data, options = {}) {
  return sdk().fs.write(path, data, { overwrite: true, createMissingParents: true, ...options });
}

// ------------------------------------------------------------ file browsing

let cachedHome = null; // { username, home } for the signed-in session

/** The signed-in user's home folder ("/username"), or "~" when unknown. */
export async function homeDir() {
  if (!isSignedIn()) {
    cachedHome = null;
    return '~';
  }
  if (cachedHome) return cachedHome.home;
  const user = await getUser();
  if (!user?.username) return '~';
  cachedHome = { username: user.username, home: `/${user.username}` };
  return cachedHome.home;
}

/** Forgets cached account details (after sign-in changes). */
export function resetAccountCache() {
  cachedHome = null;
  cachedAppDir = null;
}

let cachedAppDir = null;

/**
 * The app's own folder in the user's Puter cloud (~/AppData/<app id>/).
 * Puter confines an app to this folder unless the user grants more, so every
 * file the app writes on its own lives here; files the user picks elsewhere
 * with the Puter file dialogs keep their own paths. Relative paths resolve
 * here, but listings and stored references need the absolute path, which is
 * read once from the FSItem of the Projects folder.
 */
export async function appDir() {
  if (cachedAppDir) return cachedAppDir;
  const fs = sdk().fs;
  let item;
  try {
    item = await fs.stat('Projects');
  } catch {
    item = await fs.mkdir('Projects', { createMissingParents: true });
  }
  const path = item?.path || '';
  // FSItem paths are absolute ('/user/AppData/app-.../Projects'); fall back to relative paths.
  cachedAppDir = path.startsWith('/') ? dirname(path) : '.';
  return cachedAppDir;
}

/** Lists a folder. Resolves FSItem[] (name, path, is_dir, size, modified). */
export async function readdir(path) {
  return sdk().fs.readdir(path);
}

export async function stat(path) {
  return sdk().fs.stat(path);
}

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A temporary URL that streams the file (for previews). */
export async function readURL(path, expiresIn = '2h') {
  return sdk().fs.getReadURL(path, expiresIn);
}

/** Puter folder picker. Resolves an FSItem (never resolves on cancel, per the SDK). */
export async function pickDirectory() {
  const p = sdk();
  if (!p?.ui?.showDirectoryPicker) throw new Error('The Puter folder picker is not available.');
  const r = await p.ui.showDirectoryPicker({ multiple: false });
  return Array.isArray(r) ? r[0] : r;
}

/** Whether an FSItem-like object is a folder. */
export function isDir(item) {
  return Boolean(item?.is_dir ?? item?.isDir);
}

/** Parent folder of a Puter path. */
export function dirname(path = '') {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '/';
}

export function joinPath(dir, name) {
  return `${String(dir).replace(/\/+$/, '')}/${name}`;
}

// ------------------------------------------------------------ app helpers

/** Throws a friendly error unless signed in (so no call can pop up a sign-in prompt). */
export function requireSignedIn() {
  if (!isSignedIn()) throw new Error('Sign in to use your Puter cloud storage.');
}

/** A folder in the app's Puter folder ('Projects', 'Samples', 'Exports'). */
export async function appSubdir(name) {
  return joinPath(await appDir(), name);
}

/** Writes a file without replacing an existing one ("name (1).wav"). Resolves the FSItem. */
export async function writeNew(path, data) {
  return sdk().fs.write(path, data, { overwrite: false, dedupeName: true, createMissingParents: true });
}

export async function deleteFile(path) {
  return sdk().fs.delete(path);
}

/** Whether an error from Puter means the storage quota is used up. */
export function isQuotaError(err) {
  const code = err?.code || err?.error?.code || '';
  return code === 'storage_limit_reached' || code === 'input_too_large' || err?.status === 413;
}

/** Whether an error means the app may not access that path. */
export function isPermissionError(err) {
  const code = String(err?.code || err?.error?.code || '');
  return err?.status === 403 || /forbidden|access_denied|permission/i.test(code);
}

/** A user-facing message for a Puter error. */
export function errorMessage(err, fallback = 'Something went wrong with Puter storage.') {
  if (isQuotaError(err)) return 'Your Puter storage is full. Free some space or save to your device instead.';
  if (err?.code === 'subject_does_not_exist' || err?.status === 404) return 'The file was not found. It may have been moved or deleted.';
  return err?.message || err?.error?.message || fallback;
}

/** Inside the Puter desktop: sets the window title. */
export function setWindowTitle(title) {
  try {
    if (env() === 'app') sdk()?.ui?.setWindowTitle?.(title);
  } catch {
    // Older SDKs without window control.
  }
}

/** Inside the Puter desktop: runs `fn(items)` when the app is opened with files. */
export function onLaunchedWithItems(fn) {
  const ui = sdk()?.ui;
  if (env() !== 'app' || !ui?.onLaunchedWithItems) return false;
  ui.onLaunchedWithItems(fn);
  return Boolean(ui.wasLaunchedWithItems?.());
}
