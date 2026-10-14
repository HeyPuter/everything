// Thin wrapper around Puter.js (the only backend). Every call degrades
// gracefully when the SDK is missing (offline, blocked, tests).

export const APP_DIR = 'MusicStudio';

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
export async function pickFiles({ multiple = true, accept } = {}) {
  const p = sdk();
  if (!p?.ui?.showOpenFilePicker) throw new Error('The Puter file picker is not available.');
  const r = await p.ui.showOpenFilePicker({ multiple, accept });
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

/** The signed-in user's home folder ("/username"), or "~" when unknown. */
export async function homeDir() {
  const user = await getUser();
  return user?.username ? `/${user.username}` : '~';
}

/** Default folder for files the app writes: ~/MusicStudio. */
export async function appDir() {
  return `${await homeDir()}/${APP_DIR}`;
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

export async function mkdir(path) {
  return sdk().fs.mkdir(path, { createMissingParents: true });
}

/** Reads `count` bytes at `offset` (for headers and durations). */
export async function readRange(path, offset, count) {
  return sdk().fs.read(path, { offset, byte_count: count });
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
