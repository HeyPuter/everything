// Direct file mode: members read trip files from the owner's shared `files/` folder (the reader pays the egress) and
// upload into their own inbox, which the worker checks and moves in (`file.put` with `inboxName`). Anything that does
// not work falls back to the worker routes.
import { storedPath } from '../../shared/storage.js';
import { FileError } from './errors.js';
import { extensionOf } from './types.js';

const PAUSE = 10 * 60_000;
const paused = new Map();
const folders = new Map();
const MISSING = new Set(['subject_does_not_exist', 'not_found']);
const UNUSABLE = new Set([...MISSING, 'permission_denied', 'access_denied', 'forbidden', 'verification_required', 'insufficient_funds', 'direct_unavailable', 'direct_required']);

const keyOf = (ref) => `${ref.w}/${ref.s}`;
const codeOf = (error) => error?.code ?? error?.error?.code;
const statusOf = (error) => error?.status ?? error?.statusCode;

/** True when the direct route itself failed (share gone, path unknown, reader out of credit), so the worker should be used. */
export function directFailure(error) {
  if (!error || error.name === 'AbortError') return false;
  return [401, 402, 403, 404].includes(statusOf(error)) || UNUSABLE.has(codeOf(error));
}
const missing = (error) => statusOf(error) === 404 || MISSING.has(codeOf(error));

/**
 * `{mode: 'direct', owner?, account?, uid?, inbox?}` when this open space moves bytes directly right now, else null
 * (proxied trip, flag off, a ref instead of a space, or paused after a failure).
 */
export async function directAccess(space, { now = Date.now } = {}) {
  if (typeof space?.fileAccess !== 'function' || !space.ref) return null;
  if ((paused.get(keyOf(space.ref)) ?? 0) > now()) return null;
  const access = await space.fileAccess().catch(() => null);
  return access?.mode === 'direct' ? access : null;
}

/** Whether uploads to this trip can skip the worker (videos need this; see `startUpload` with `direct: 'require'`). */
export async function directAvailable(space) {
  const access = await directAccess(space);
  return Boolean(access && (access.owner || access.inbox));
}

/** Uses the worker for this trip for 10 minutes and asks it to re-share the folders. */
export function pauseDirect(space, { now = Date.now } = {}) {
  const key = keyOf(space.ref);
  paused.set(key, now() + PAUSE);
  for (const entry of folders.keys()) if (entry.startsWith(`${key}/`)) folders.delete(entry);
  void Promise.resolve(space.refreshAccess?.({ renew: true })).catch(() => {});
}

/** Test hook: forgets pauses and folder paths. */
export function resetDirect() { paused.clear(); folders.clear(); }

/**
 * The path of a folder the worker named by uid. The trip owner controls the worker, so the folder must be this trip's
 * `files/` or an `inbox/<uuid>/`, never one the caller can reach for some other reason.
 */
async function folderPath(puter, space, uid, kind) {
  const key = `${keyOf(space.ref)}/${uid}`;
  if (!folders.has(key)) {
    const stat = await puter.fs.stat({ uid });
    const expected = kind === 'inbox' ? new RegExp(`/spaces/${space.ref.s}/inbox/[^/]+$`) : new RegExp(`/spaces/${space.ref.s}/files$`);
    if (!stat?.is_dir || typeof stat.path !== 'string' || !/^[0-9a-z]{16}$/.test(space.ref.s) || !expected.test(stat.path)) throw new FileError('direct_unavailable');
    folders.set(key, stat.path);
  }
  return folders.get(key);
}

/**
 * Reads a file or its thumbnail straight from the owner's storage; null when the caller should use the worker. A
 * missing file falls back alone; any other direct failure pauses direct reads for the trip.
 */
export async function readDirect(space, entity, { thumb = false, puter, signal } = {}) {
  if (!puter?.fs || !entity?.id) return null;
  const access = await directAccess(space);
  if (!access) return null;
  try {
    // By path inside the trip's folder, never by the entity's `loc.uid`: the trip owner writes entities, and a uid could
    // name a file only the caller can read.
    const name = thumb ? `${entity.id}/.thumb` : storedPath(entity);
    let target = null;
    if (access.owner) target = `spaces/${space.ref.s}/files/${name}`;
    else if (access.uid) target = `${await folderPath(puter, space, access.uid, 'files')}/${name}`;
    if (!target) return null;
    const blob = await puter.fs.read(target);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return blob instanceof Blob ? blob : new Blob([blob ?? '']);
  } catch (error) {
    if (!directFailure(error)) throw error;
    if (!missing(error)) pauseDirect(space);
    return null;
  }
}

/** Writes an upload into the caller's inbox and returns the `inboxName` for `file.put`. */
export async function writeInbox(space, access, fileId, { blob, name }, { puter }) {
  if (!puter?.fs) throw new FileError('direct_unavailable');
  const ext = extensionOf(name);
  const inboxName = ext ? `${fileId}.${ext}` : fileId;
  let folder;
  if (access.owner) folder = `spaces/${space.ref.s}/inbox/${access.account}`;
  else if (access.inbox) folder = await folderPath(puter, space, access.inbox, 'inbox');
  else throw new FileError('direct_unavailable');
  await puter.fs.write(`${folder}/${inboxName}`, blob, { overwrite: true, dedupeName: false, createMissingParents: Boolean(access.owner) });
  return inboxName;
}
