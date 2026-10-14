/**
 * Everything the app asks of Puter, in one place, so the rest of the code
 * never touches the global directly and the dev harness can swap in a mock.
 *
 *  auth      sign-in state and the current user
 *  env       'app' inside the Puter desktop, 'web' on a standalone page
 *  settings  a small JSON document in puter.kv (theme, regional format); this browser's storage without a session, and a copy there for boots that cannot reach the store
 *  files     spreadsheets as real files in the app's own folder on Puter FS
 *  pickers   Puter's Open / Save dialogs, feature-detected
 *  sharing   who else may open a file, and the files others shared with this user
 *
 * Files are never stored in KV. Spreadsheets are .xlsx blobs written to
 * `Spreadsheets/<name>.xlsx`, so they show up as ordinary files a user can
 * move, share, or open with any other app.
 */

import { optionState } from './option-state.js';
import { trackEvent, trackExport } from './analytics.js';

export const FOLDER = 'Spreadsheets';
export const SETTINGS_KEY = 'spreadsheet:settings:v1';

const sdk = () => (typeof puter !== 'undefined' ? puter : null);

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
  profilePictureCache = null;
  return sdk()?.auth.signOut();
}

export async function getUser() {
  try {
    return await sdk().auth.getUser();
  } catch {
    return null;
  }
}

// One account's picture in memory, shared by home/editor and concurrent renders.
// Base64 pictures never go into browser storage. Missing pictures and failures
// get a shorter cache lifetime because the SDK reports both as null.
const PROFILE_PICTURE_TTL_MS = 5 * 60_000;
const PROFILE_PICTURE_MISS_TTL_MS = 60_000;
let profilePictureCache = null;

/** The signed-in user's picture; `user` scopes the cache, not the SDK lookup. */
export function getProfilePicture(user) {
  const owner = sdk();
  const identity = user?.uuid || user?.username;
  if (!identity || typeof owner?.auth?.getProfilePicture !== 'function') return Promise.resolve(null);
  const cached = profilePictureCache;
  if (cached?.owner === owner && cached.identity === identity && Date.now() < cached.expires) return cached.promise;
  const entry = { owner, identity, expires: Infinity, promise: null };
  entry.promise = Promise.resolve().then(() => owner.auth.getProfilePicture()).catch(() => null).then((picture) => {
    const value = typeof picture === 'string' && picture.startsWith('data:image/') ? picture : null;
    entry.expires = Date.now() + (value ? PROFILE_PICTURE_TTL_MS : PROFILE_PICTURE_MISS_TTL_MS);
    return value;
  });
  profilePictureCache = entry;
  return entry.promise;
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

/* ---------- Settings (small, hot, KV) ---------- */

const DEFAULT_SETTINGS = { theme: 'system' };
const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };

/** The settings kept in this browser for visitors without a Puter session. */
export function loadLocalSettings() {
  try {
    const obj = JSON.parse(storage()?.getItem(SETTINGS_KEY) || 'null');
    return { ...DEFAULT_SETTINGS, ...(obj && typeof obj === 'object' ? obj : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveLocalSettings(next) {
  try { storage()?.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...next })); } catch { /* storage unavailable */ }
}

/**
 * The account's settings from puter.kv, the defaults filling in what the record leaves out;
 * null when the store could not be reached (offline, a flaky connection), which is not the
 * same as an account with no record: nothing derived from the defaults may be written back
 * over a record that could not be read.
 */
export async function loadSettings() {
  let raw;
  try { raw = await sdk().kv.get(SETTINGS_KEY); } catch { return null; }
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ...DEFAULT_SETTINGS, ...(obj && typeof obj === 'object' ? obj : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS }; // a record that cannot be read is as good as none
  }
}

export async function saveSettings(patch, current = {}) {
  const next = { ...DEFAULT_SETTINGS, ...current, ...patch };
  try {
    await sdk().kv.set(SETTINGS_KEY, next);
  } catch { /* offline or quota: the in-memory copy still applies */ }
  return next;
}

/* ---------- Small records in KV ---------- */

/** A value from puter.kv, or null when there is none; `unreachable` (null unless given) when the store cannot be reached. */
export async function kvGet(key, unreachable = null) {
  try { return (await sdk().kv.get(key)) ?? null; } catch { return unreachable; }
}

/** Put a value in puter.kv; false when it could not be written (offline, no session). */
export async function kvSet(key, value) {
  try { await sdk().kv.set(key, value); return true; } catch { return false; }
}

export async function kvDel(key) {
  try { await sdk().kv.del(key); return true; } catch { return false; }
}

/* ---------- Files ---------- */

export function isNotFound(err) {
  const code = err?.code || err?.error?.code || '';
  const msg = String(err?.message || err?.error?.message || err || '').toLowerCase();
  return code === 'subject_does_not_exist' || code === 'ENOENT' || msg.includes('not found') || msg.includes('does not exist') || msg.includes('no such');
}

export function displayName(path) {
  return String(path || '').split('/').pop();
}

/**
 * A safe file name: no path separators or control characters, trimmed, not ending in a dot, and
 * empty when nothing visible is left. Control characters go, and with them the bidi controls that
 * would show the rest of a name reversed and the zero-width characters that shape nothing (a name
 * pasted from the web can carry them, and a name made only of them saves an invisible file); the
 * joiners that shape a word or an emoji sequence (Persian text, 👨‍👩‍👧, 🏴󠁧󠁢󠁥󠁮󠁧󠁿) stay, save at the ends.
 */
export function sanitizeName(name) {
  // Cut on characters, not UTF-16 units, so the name never ends on half of an emoji.
  const clean = Array.from(String(name || '').replace(/[/\\]/g, ' ').replace(/[\p{Cc}​⁠﻿‪-‮⁦-⁩]/gu, '').replace(/^[\s\p{Cf}]+|[\s\p{Cf}]+$/gu, '')).slice(0, 200).join('');
  if (!/[^\s\p{Cf}]/u.test(clean)) return '';
  // The dots and spaces a name ends with go: Windows drops them from a downloaded file's name, and
  // "." and ".." are directory names, not file names, from which a path would climb out of the folder.
  return clean.replace(/[.\s\p{Cf}]+$/u, '');
}

export function ensureXlsx(name) {
  const clean = sanitizeName(name);
  return /\.xlsx$/i.test(clean) ? clean : `${clean}.xlsx`;
}

/**
 * Create the app folder once per session (per SDK instance, so a swapped-in
 * mock starts afresh). Writes create missing parents themselves, so a failure
 * here is not worth retrying on every save.
 */
let folderReady = null;
let folderOwner = null;
function ensureFolder() {
  const owner = sdk();
  if (folderOwner !== owner) {
    folderOwner = owner;
    folderReady = Promise.resolve().then(() => owner.fs.mkdir(FOLDER)).catch(() => {});
  }
  return folderReady;
}

/** Spreadsheet files in the app folder, newest first. */
export async function listFiles() {
  let items;
  try {
    items = await sdk().fs.readdir(FOLDER);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  (items || []).forEach(noteAppFolder); // the listing shows the folder's absolute spelling
  return (items || [])
    .filter((it) => !it.is_dir && /\.(xlsx|xlsm|xls|csv|tsv|ods)$/i.test(it.name))
    .map((it) => ({
      name: it.name,
      path: it.path || `${FOLDER}/${it.name}`,
      size: it.size ?? 0,
      modified: it.modified ?? it.created ?? 0,
      uid: it.uid || it.id || null,
    }))
    .sort((a, b) => (b.modified || 0) - (a.modified || 0));
}

/** The entries of any folder ([] when it does not exist). */
export async function listDir(path) {
  try {
    const items = await sdk().fs.readdir(path);
    return (items || []).map((it) => ({ name: it.name, path: it.path || `${path}/${it.name}`, size: it.size ?? 0, is_dir: !!it.is_dir, modified: it.modified ?? it.created ?? 0 }));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

/** Read a file's bytes as an ArrayBuffer. */
export async function readFile(path) {
  const blob = await sdk().fs.read(path);
  return blob.arrayBuffer();
}

/** Write a Blob to a path, creating the folder when needed. Returns the FSItem. */
export async function writeFile(path, blob, { dedupe = false, overwrite = !dedupe } = {}) {
  if (path.startsWith(`${FOLDER}/`)) await ensureFolder();
  const written = await sdk().fs.write(path, blob, { overwrite, dedupeName: dedupe, createMissingParents: true });
  if (inFolderRelative(path)) noteAppFolder(written); // the result shows the folder's absolute spelling
  return written;
}

export async function deleteFile(path, { recursive = false } = {}) {
  await sdk().fs.delete(path, { recursive });
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

/** The file with this id, wherever the drive keeps it now (a file keeps its id when moved or renamed); null when it is gone. */
export async function statByUid(uid) {
  try {
    return await sdk().fs.stat({ uid });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function fileExists(path) {
  return !!(await statFile(path));
}

/* ---------- One file, one address ---------- */

// The SDK resolves a relative path under the app's own data folder and reports
// every file by its absolute path there (/user/AppData/<app>/Spreadsheets/Budget.xlsx):
// a listing, a stat, a write result, the picker and "Open with" all speak that
// spelling, while the app writes under the relative one. Records keyed by path
// (drafts, the outside-content decision, history, recents) must not split
// between the two spellings of one file, so the absolute spelling of the app
// folder is learned from the first result that shows it, documents keep the
// address the drive reports, and paths are compared with both in mind.
let appFolder = { owner: null, path: null };

export function isAbsolutePath(path) {
  return typeof path === 'string' && /^[/~]/.test(path);
}

/** Is `path` in the drive's trash (~/Trash, where the desktop keeps a deleted file until it is removed for good)? */
export function inTrash(path) {
  return typeof path === 'string' && /^(?:\/[^/]+|~)\/Trash(?:\/|$)/.test(path);
}

const parentOf = (path) => { const slash = path.lastIndexOf('/'); return slash > 0 ? path.slice(0, slash) : ''; };
const inFolderRelative = (path) => path.startsWith(`${FOLDER}/`) && !path.slice(FOLDER.length + 1).includes('/');

/** Learn the absolute spelling of the app folder from an entry known to be one of its direct children. */
function noteAppFolder(item) {
  const path = item?.path;
  if (!isAbsolutePath(path)) return;
  const dir = parentOf(path);
  if (dir && displayName(dir) === FOLDER) appFolder = { owner: sdk(), path: dir };
}

/** The absolute spelling of the app folder, once known for this SDK instance. */
function knownAppFolder() {
  return appFolder.owner === sdk() ? appFolder.path : null;
}

/** Resolve a known drive address synchronously for clipboard events.
 * An unresolved app-relative or home-relative address has no absolute URI yet. */
export function resolvedAbsolutePath(path) {
  if (typeof path !== 'string') return null;
  if (path.startsWith('/')) return path;
  const folder = knownAppFolder();
  if (inFolderRelative(path) && folder?.startsWith('/')) return `${folder}/${displayName(path)}`;
  return null;
}

/** Is `path` a direct child of the app folder, in either spelling? */
export function inAppFolder(path) {
  if (typeof path !== 'string') return false;
  if (inFolderRelative(path)) return true;
  const abs = knownAppFolder();
  return !!abs && parentOf(path) === abs;
}

/** Do the two addresses name the same file? Either spelling of the app folder counts once. */
export function samePath(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return inAppFolder(a) && inAppFolder(b) && displayName(a) === displayName(b);
}

/** The relative spelling of an app-folder file's address (where records were kept before the drive's own was adopted), or null. */
export function legacyAppPath(path) {
  if (!inAppFolder(path)) return null;
  const relative = `${FOLDER}/${displayName(path)}`;
  return relative === path ? null : relative;
}

/**
 * The address to keep for a file: the one the drive reports for it (absolute),
 * when the result names the same file; otherwise the path as asked for.
 */
export function canonicalPath(path, item) {
  const reported = item?.path;
  if (!isAbsolutePath(reported) || displayName(reported) !== displayName(path)) return path;
  if (inFolderRelative(path)) noteAppFolder(item);
  return reported;
}

/** Resolve the absolute spelling of the app folder from the drive, once per session. */
export async function resolveAppFolder() {
  const known = knownAppFolder();
  if (known) return known;
  const st = await statFile(FOLDER).catch(() => null);
  const reported = st?.path;
  if (isAbsolutePath(reported)) appFolder = { owner: sdk(), path: reported.replace(/\/+$/, '') };
  return knownAppFolder();
}

/**
 * A name that does not collide with an existing file in the folder: one
 * listing, rather than a look-up per candidate, however many "Untitled
 * spreadsheet N" files there already are. The check is advisory; the write
 * that follows dedupes on the server as well.
 */
export async function uniqueName(base) {
  const stem = base.replace(/\.xlsx$/i, '');
  const taken = new Set((await listDir(FOLDER)).map((it) => it.name));
  let name = `${stem}.xlsx`;
  let n = 2;
  while (taken.has(name)) name = `${stem} ${n++}.xlsx`;
  return name;
}

/* ---------- Pickers ---------- */

export function canPickFiles() {
  return typeof sdk()?.ui?.showOpenFilePicker === 'function';
}

export function canSaveFiles() {
  return typeof sdk()?.ui?.showSaveFilePicker === 'function';
}

/** Puter's Open dialog → { path, name } or null when cancelled. */
export async function pickFile({ accept = ['.xlsx', '.xls', '.xlsm', '.csv', '.tsv', '.ods'] } = {}) {
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
 * Puter's Save dialog with content. The SDK writes the file itself.
 * When the user cancels, the SDK's promise never settles, so callers must
 * not block UI on this.
 */
export async function saveFileAs(blob, suggestedName) {
  if (!canSaveFiles()) return null;
  const item = await sdk().ui.showSaveFilePicker(blob, suggestedName);
  if (!item) return null;
  trackExport(suggestedName, 'puter');
  return { path: item.path, name: item.name || displayName(item.path) };
}

/* ---------- Sharing ---------- */

// A file is shared with other Puter users by name or email address, to read or to edit. Opening one
// to anyone with a link is the owner's own call on Puter, never an app's, so it is not offered here;
// a link share the owner made there is listed, as whoever else can reach the file is.

/** Can this SDK share files? */
export function canShare() {
  return typeof sdk()?.fs?.share === 'function' && typeof sdk()?.fs?.getShares === 'function';
}

/** Puter's levels of access, from the least to the most. */
const MODE_RANK = { see: 0, list: 1, read: 2, write: 3, manage: 4 };

/** Is a spreadsheet's name one the app opens? (The folder listing keeps the same kinds.) */
const isSheetName = (name) => /\.(xlsx|xlsm|xls|csv|tsv|ods)$/i.test(String(name || ''));

/**
 * Who can reach one access row: the person (by username, or the address of an invite not yet
 * taken up), a team, or anyone with the link. `recipient` is what unshare() takes to withdraw it,
 * or null when the row is not the app's to withdraw here (a link, or access from a folder above).
 */
function accessRow(share) {
  const pending = !!share?.pending;
  const who = share?.anyone ? 'anyone' : pending ? 'invite' : share?.holder ? 'user' : 'team';
  const team = share?.holderTeam; // { uid, name, handle }, either of the last two possibly null
  const label = who === 'anyone' ? 'Anyone with the link' : pending ? (share.recipientEmail || 'Invited by email') : who === 'user' ? share.holder : (team?.name || team?.handle || 'A team');
  const recipient = share?.inheritedFrom ? null : who === 'user' ? share.holder : who === 'invite' ? share.recipientEmail || null : null;
  return { uid: share?.uid ?? null, who, label, mode: share?.mode || 'read', pending, recipient, inheritedFrom: share?.inheritedFrom || null, issuer: share?.issuer || null };
}

/**
 * Give `recipient` (a username, or an email address: one with no account yet is invited) `mode`
 * ('read' or 'write') on the file. Sharing again with the same person replaces their access.
 * Resolves the access row as shareAccess lists it; rejects with a readable message (see shareProblem).
 */
export async function shareFile(path, recipient, mode = 'read') {
  let result;
  try { result = await sdk().fs.share(path, String(recipient).trim(), mode); }
  catch (e) { throw shareError(e); }
  const share = Array.isArray(result) ? result[0] : result;
  return { ...accessRow(share), isNew: share?.isNew !== false };
}

/** Withdraw `recipient`'s access (a username, or an invited address); resolves how many grants went. */
export async function unshareFile(path, recipient) {
  try { return (await sdk().fs.unshare(path, recipient))?.revoked ?? 0; }
  catch (e) { throw shareError(e); }
}

/** Who can reach the file, as access rows: people first, by name, then invites, teams and a link. */
export async function shareAccess(path) {
  let shares;
  try { shares = await sdk().fs.getShares(path); }
  catch (e) { throw shareError(e); }
  const order = { user: 0, invite: 1, team: 2, anyone: 3 };
  return (shares || []).map(accessRow)
    .sort((a, b) => order[a.who] - order[b.who] || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

/**
 * The spreadsheets other people have shared with this user, newest first: { name, path, uid, mode,
 * owner, modified, size }. A shared file sits at a masked path (/<owner>/<uid>/<name>), which opens
 * like any other; shared folders are left out, as the list shows files. [] when sharing is not here.
 */
export async function listSharedWithMe({ max = 200 } = {}) {
  if (typeof sdk()?.fs?.listShared !== 'function') return [];
  // One entry per file: a file two people shared with the user is listed once for each share, and
  // the user may do with it whatever the more generous of them allows.
  const byFile = new Map();
  let cursor;
  // Until the cursor is gone, not until a page comes back short: a page can be short while more remain.
  do {
    const page = await sdk().fs.listShared({ limit: 50, ...(cursor ? { cursor } : {}) });
    for (const it of page?.items || []) {
      if (it.isDir || !isSheetName(it.name)) continue;
      const file = { name: it.name, path: it.path, uid: it.entryUid || null, mode: it.mode || 'read', owner: it.owner || it.issuer || null, modified: it.modified ?? 0, size: it.size ?? 0 };
      const key = file.uid || file.path;
      const seen = byFile.get(key);
      if (!seen) byFile.set(key, file);
      else if (MODE_RANK[file.mode] > MODE_RANK[seen.mode]) seen.mode = file.mode;
    }
    cursor = page?.cursor;
  } while (cursor && byFile.size < max);
  return [...byFile.values()].sort((a, b) => (b.modified || 0) - (a.modified || 0));
}

/** Does this level of access let the user change the file? */
export const canWriteMode = (mode) => mode === 'write' || mode === 'manage';

/**
 * The user's access to a file someone else shared with them ('read', 'write', …), from the shares
 * listed for them: Puter says it nowhere else (a stat calls every file writable). Null when the file
 * is not among them: the user's own, or one reached through a shared folder.
 */
export async function sharedModeOf({ path, uid = null }) {
  const found = (await listSharedWithMe()).find((f) => (uid && f.uid === uid) || f.path === path);
  return found?.mode ?? null;
}

/** Leave a share someone else gave this user: their own access to drop. */
export async function leaveShare(path) {
  const me = await getUser();
  if (!me?.username) throw new Error('Could not tell who is signed in');
  return unshareFile(path, me.username);
}

/**
 * The Puter link that opens the file in this app for the people it is shared with, or null where
 * there is none to build: outside the Puter desktop the app has no name to put in one.
 */
export async function puterShareLink(path) {
  if (!isApp() || typeof sdk()?.fs?.getShareLink !== 'function') return null;
  try { return await sdk().fs.getShareLink(path); } catch { return null; }
}

/** What a refused share, unshare or listing means, in words for the dialog. */
export function shareProblem(err) {
  const code = err?.code || err?.error?.code || '';
  switch (code) {
    case 'user_does_not_exist': return 'No Puter account has that username. Check the spelling, or enter their email address to invite them.';
    case 'recipient_not_accepting_shares': return 'That person is not accepting shares.';
    case 'email_not_allowed': return 'That email address cannot receive an invitation.';
    case 'cannot_share_with_self': return 'That is you. Enter someone else’s username or email address.';
    case 'cannot_share_with_owner': return 'That person owns this spreadsheet already.';
    case 'forbidden': return 'Only the owner of this spreadsheet, or someone they let manage it, can share it.';
    case 'subject_does_not_exist': return 'This spreadsheet cannot be shared from here. Only files you own, or may manage, can be shared.';
    case 'share_daily_limit_reached': return 'You have shared as much as Puter allows in one day. Try again tomorrow.';
    case 'phone_verification_required': return 'Puter needs a verified phone number on your account before you can share files.';
    case 'card_verification_required': return 'Puter needs a verified card on your account before you can share files.';
    case 'invalid_mode': return 'That level of access cannot be given.';
    case 'account_is_not_verified': return 'Confirm your email address on Puter before you share files.';
    case 'too_many_requests': return 'That was too many changes at once. Wait a moment, then try again.';
    default: return err?.message || err?.error?.message || (typeof err === 'string' ? err : 'Puter could not complete the share');
  }
}

/** An Error carrying the readable message and the SDK's code, for whatever the SDK threw. */
function shareError(e) {
  const code = e?.code || e?.error?.code || null;
  return Object.assign(new Error(shareProblem(e)), { code });
}

/* ---------- Desktop integration ---------- */

/** Is Puter's AI available here (an AI() formula can be answered), and wanted (the options' Privacy page)? */
export function canAI() {
  return optionState.aiFeatures !== false && !!window.puter?.ai?.chat;
}

/** How much a web address may serve to a formula or a picture: plenty for any sheet the cell budgets allow, not enough to fill memory. */
export const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const tooLarge = (url) => Object.assign(new Error(`The response from ${url} is too large (over ${MAX_FETCH_BYTES / (1024 * 1024)} MB)`), { code: 'too-large' });
const notPublic = (url) => Object.assign(new Error(`Cannot fetch ${url}: only addresses on the public internet can be fetched, not this computer's or a private network's`), { code: 'not-public' });

/**
 * Is `url` a web address on the public internet: http(s), to a host that is not this machine, a
 * private or link-local network (where cloud metadata services answer), or a name that resolves
 * only there? Puter's fetch reaches out on the app's behalf, so a formula or a dialog must not be
 * able to point it at what the browser itself could not reach. The URL parser writes an IP host
 * in one form whatever the spelling given (127.1, 0x7f000001 and 2130706433 all come out as
 * 127.0.0.1; IPv6 compressed, in lowercase hex), so each range is checked in that form.
 */
export function isPublicHttpUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host.startsWith('[')) return isPublicIPv6(host.slice(1, -1));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPublicIPv4(host.split('.').map(Number));
  return !/^localhost$|\.(?:localhost|local|internal|home\.arpa)$/.test(host);
}

function isPublicIPv4([a, b]) {
  if (a === 0 || a === 10 || a === 127) return false; // this host, private, loopback
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  return a < 224; // multicast and reserved, the broadcast address among them
}

function isPublicIPv6(ip) {
  if (ip === '::1' || ip === '::') return false; // loopback, unspecified
  if (/^(?:fe[89ab]|f[cd]|ff)/.test(ip)) return false; // link-local, unique local, multicast
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip); // an IPv4 address in IPv6 clothing
  if (!mapped) return true;
  const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  return isPublicIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
}

/** The response to a web address, through Puter's CORS-free fetch when the SDK offers it, else the browser's. */
async function fetchResponse(url) {
  if (!isPublicHttpUrl(url)) throw notPublic(url);
  const p = window.puter;
  const doFetch = p?.net?.fetch ? (u) => p.net.fetch(u) : (u) => fetch(u);
  const res = await doFetch(url);
  if (!res || (typeof res.ok === 'boolean' && !res.ok)) throw new Error(`Could not fetch ${url}`);
  return res;
}

/** A response's bytes, within the cap: the declared length is checked first, then what arrives, as it arrives. */
async function cappedBytes(res, url) {
  if (Number(res.headers?.get?.('content-length')) > MAX_FETCH_BYTES) throw tooLarge(url);
  if (typeof res.body?.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FETCH_BYTES) { Promise.resolve(reader.cancel?.()).catch(() => {}); throw tooLarge(url); }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
    return out;
  }
  // A response that cannot be streamed (the dev mock's, say) is read whole and measured after.
  const bytes = typeof res.arrayBuffer === 'function' ? new Uint8Array(await res.arrayBuffer()) : new TextEncoder().encode(await res.text());
  if (bytes.byteLength > MAX_FETCH_BYTES) throw tooLarge(url);
  return bytes;
}

/** Fetch text from a web address (decoded as UTF-8, as Response.text() does whatever the headers say). */
export async function fetchText(url) {
  return new TextDecoder().decode(await cappedBytes(await fetchResponse(url), url));
}

/** Fetch a file's bytes (an .xlsx from the web). */
export async function fetchBytes(url) {
  return cappedBytes(await fetchResponse(url), url);
}

/**
 * Ask Puter's AI a question; the answer as plain text. A failure throws an Error with the service's own message,
 * whether the SDK throws it as a plain object or hands it back as the reply: read as text, that was "[object Object]".
 */
export async function aiChat(prompt, { feature = 'formula' } = {}) {
  const p = window.puter;
  if (!p?.ai?.chat) throw new Error('AI is not available here');
  let res;
  try { res = await p.ai.chat(prompt); } catch (e) { throw aiError(e); }
  if (res?.success === false) throw aiError(res.error || res);
  const content = res?.message?.content;
  let answer;
  if (typeof res === 'string') answer = res;
  else if (typeof content === 'string') answer = content;
  else if (Array.isArray(content)) answer = content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  else return String(res?.toString?.() ?? '');
  if (answer.trim()) trackEvent('AI Interaction', { feature });
  return answer;
}

/**
 * One reply from Puter's AI to a conversation, as it arrives: yields { type: 'text', text },
 * { type: 'tool', id, name, input } (a function the model calls), { type: 'reasoning' }, and last
 * { type: 'cut' } when the reply was cut off at `maxTokens`.
 * `messages` are in the OpenAI shape Puter takes (system, user, assistant with tool_calls, tool).
 * A reply the SDK hands back whole, rather than streamed, is yielded in the same pieces. A
 * failure throws an Error whose message is the service's own, as far as it gives one.
 */
export async function* aiChatStream(messages, { model, tools, maxTokens } = {}) {
  const p = window.puter;
  if (!p?.ai?.chat) throw new Error('AI is not available here');
  const options = { stream: true, ...(model ? { model } : {}), ...(tools?.length ? { tools } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}) };
  let res;
  try { res = await p.ai.chat(messages, options); } catch (e) { throw aiError(e); }
  if (res && typeof res[Symbol.asyncIterator] === 'function') {
    try {
      for await (const part of res) {
        if (!part) continue;
        if (part.type === 'error' || (part.success === false && part.error)) throw aiError(part.error || part);
        if (part.type === 'tool_use') yield { type: 'tool', id: part.id, name: part.name, input: toolInput(part.input) };
        else if (part.type === 'reasoning') yield { type: 'reasoning' };
        // A stream says nothing of why it ended; its closing token count is how a cut-off reply shows.
        else if (part.type === 'usage') { if (reachedLimit(part.usage, maxTokens)) yield { type: 'cut' }; }
        else if (typeof part.text === 'string' && part.text) yield { type: 'text', text: part.text };
      }
    } catch (e) { throw aiError(e); }
    return;
  }
  if (res?.success === false) throw aiError(res.error || res);
  const message = res?.message || {};
  const content = typeof res === 'string' ? res : message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('') : '';
  if (text) yield { type: 'text', text };
  for (const call of message.tool_calls || []) yield { type: 'tool', id: call.id, name: call.function?.name, input: toolInput(call.function?.arguments) };
  if (res?.finish_reason === 'length' || res?.stop_reason === 'max_tokens' || message.stop_reason === 'max_tokens' || reachedLimit(res?.usage, maxTokens)) yield { type: 'cut' };
}

// Whether a reply's token count says it stopped at the limit (Anthropic's models count output_tokens, others completion_tokens).
const reachedLimit = (usage, maxTokens) => !!maxTokens && Number(usage?.output_tokens ?? usage?.completion_tokens) >= maxTokens;

/** A tool call's arguments, which may come as JSON text: what cannot be read is marked so, not taken for no arguments. */
function toolInput(input) {
  if (typeof input !== 'string') return input ?? {};
  try { return input.trim() ? JSON.parse(input) : {}; } catch { return { __unreadable: input }; }
}

/** An Error for whatever the SDK threw (it often throws a plain { error: { message } } object). */
function aiError(e) {
  if (e instanceof Error) return e;
  const inner = e?.error && typeof e.error === 'object' ? e.error : e;
  const message = inner?.message || (typeof e?.error === 'string' ? e.error : '') || (typeof e === 'string' ? e : '') || 'The AI did not answer';
  return Object.assign(new Error(message), { code: inner?.code || e?.code });
}

export function setWindowTitle(title) {
  try { sdk()?.ui?.setWindowTitle?.(title); } catch { /* not in a window */ }
}

/** Register for "Open with" launches from the Puter desktop. */
export function onLaunchedWithItems(handler) {
  try {
    sdk()?.ui?.onLaunchedWithItems?.((items) => handler(Array.isArray(items) ? items : [items]));
  } catch { /* not supported */ }
}

/**
 * Take over the Puter desktop window's close button: the window stays open
 * until exitApp() is called. False, and nothing taken over, where the window
 * could then never close (no window, or an SDK without puter.exit).
 */
export function onWindowClose(handler) {
  const s = sdk();
  if (!isApp() || typeof s?.ui?.onWindowClose !== 'function' || typeof s?.exit !== 'function') return false;
  try { s.ui.onWindowClose(handler); return true; } catch { return false; }
}

/** Close the app's Puter desktop window. */
export function exitApp() {
  try { sdk()?.exit?.(); } catch { /* not in a window */ }
}

/** Does the entry the drive describes (a launch item, a drop, a listing) name a folder? */
export function isDirItem(item) {
  return !!(item?.is_dir || item?.isDirectory || item?.isDir || item?.fsentry_is_dir);
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
  trackExport(filename, 'browser');
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
