// Trip files for every module: upload, URLs, downloads, drive hand-off, trash, links and the trip cover.
// Bytes move directly through the owner's shared folders when the trip allows it (direct.js), otherwise through the
// trip worker. Reads fall back to the offline copy of a kept trip (lib/offline/files.js).
import { FileError } from './errors.js';
import { createUrlCache } from './cache.js';
import { coverImage } from './image.js';
import { absorb, addLinks, createUpload } from './upload.js';
import { readDirect } from './direct.js';
import { ACCEPT, blobType, cleanName, fileType, renameExtension } from './types.js';
import { fileLinkPatch, hasFileLink } from '../../shared/file-links.js';
import { saveBlob } from '../download.js';
import { readCachedFile } from '../offline/files.js';
import { appOnline } from '../offline/pwa.js';

export { ACCEPT, IMAGE_ACCEPT, VIDEO_ACCEPT, MAX_FILE_BYTES, MAX_VIDEO_BYTES, fileType, groupOf, previewKind, rejectReason, isRaster, isHeic, isVideo, isVideoFile } from './types.js';
export { FileError, errorCode, errorKey, retryable } from './errors.js';
export { formatBytes } from './format.js';
export { prepareFile, findDuplicate } from './upload.js';
export { directAvailable } from './direct.js';
export { fileLinks, hasFileLink, fileLinkPatch } from '../../shared/file-links.js';

let bound = null;
const full = createUrlCache({ maxBytes: 96 * 1024 * 1024 });
const thumbs = createUrlCache({ maxBytes: 24 * 1024 * 1024 });
const inflight = new Map();
const waiting = [];
let active = 0;
const CONCURRENT = 4;

/**
 * Binds the session's worker client (and SDK, for the drive) once per sign-in; `account` (uuid) finds the offline
 * copies. Returns an unbind function.
 */
export function bindFiles({ api, puter, account } = {}) {
  const same = bound?.api === api;
  if (!same) { full.clear(); thumbs.clear(); inflight.clear(); }
  bound = api ? { api, puter: puter ?? null, account: account ?? (same ? bound.account : null) } : null;
  return () => { if (bound?.api === api) bound = null; };
}
function apiOf(options) {
  const api = options?.api ?? bound?.api;
  if (!api) throw new FileError('files_unbound');
  return api;
}
const puterOf = (options) => options?.puter ?? bound?.puter ?? globalThis.puter;
const refOf = (target) => target?.ref ?? target;
const entityOf = (target, id) => (typeof target?.get === 'function' ? target.get('file', id) ?? null : null);

async function queued(task) {
  if (active >= CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
  active += 1;
  try { return await task(); } finally { active -= 1; waiting.shift()?.(); }
}

const MAGIC = [['image/jpeg', [0xff, 0xd8, 0xff]], ['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/gif', [0x47, 0x49, 0x46, 0x38]]];
function sniffImage(bytes) {
  for (const [type, magic] of MAGIC) if (magic.every((byte, i) => bytes[i] === byte)) return type;
  const ascii = (start, text) => [...text].every((char, i) => bytes[start + i] === char.charCodeAt(0));
  return ascii(0, 'RIFF') && ascii(8, 'WEBP') ? 'image/webp' : null;
}

// ---- Reading ----

// Answers that mean the file is gone or no longer readable, so an offline copy must not stand in.
const REFUSED = new Set([403, 404, 410]);
const keepTrying = (error) => error?.name !== 'AbortError' && error?.code !== 'aborted' && !REFUSED.has(error?.status);

/** The kept trip's offline copy of a full file (non-media attachments only), or null. */
async function offlineCopy(target, entity, { account } = {}) {
  const owner = account ?? bound?.account;
  if (!owner || !entity) return null;
  return readCachedFile({ account: owner, ref: refOf(target), file: entity });
}

/**
 * A trip file (or its thumbnail) as a typed Blob. `target` is an open space (preferred: the entity's mime types the
 * blob) or a space ref `{w, s, k}`. Only images, PDF and text are typed for display; `download` keeps document types.
 * Offline, or when the network read fails, a kept trip's offline copy answers instead.
 */
export async function fileBlob(target, id, { thumb = false, download = false, signal, onProgress, ...options } = {}) {
  const entity = entityOf(target, id);
  const kept = async () => {
    const copy = thumb ? null : await offlineCopy(target, entity, options);
    if (copy) onProgress?.({ loaded: copy.size, total: copy.size });
    return copy;
  };
  let raw = appOnline() ? null : await kept();
  if (!raw) {
    try {
      raw = await queued(async () => {
        // Direct mode: straight from the owner's storage, billed to this reader; otherwise through the worker.
        const direct = entity ? await readDirect(target, entity, { thumb, signal, puter: puterOf(options) }) : null;
        if (direct) { onProgress?.({ loaded: direct.size, total: direct.size }); return direct; }
        return apiOf(options).download(refOf(target), id, { thumb, signal, onProgress });
      });
    } catch (error) {
      raw = keepTrying(error) && !signal?.aborted ? await kept() : null;
      if (!raw) throw error;
    }
  }
  let type = thumb ? null : blobType(entity?.mime, { download });
  if (thumb || !entity) type = sniffImage(new Uint8Array(await raw.slice(0, 12).arrayBuffer())) ?? 'application/octet-stream';
  return new Blob([raw], { type });
}

const urlKey = (target, id, thumb) => {
  const ref = refOf(target);
  const entity = entityOf(target, id);
  return `${ref.w}/${ref.s}/${id}/${(thumb ? entity?.thumb : entity?.sha256) ?? ''}`;
};

/** The cached object URL, if this session already loaded it; lets lists render thumbnails without a flash. */
export const cachedFileUrl = (target, id, { thumb = false } = {}) => (thumb ? thumbs : full).get(urlKey(target, id, thumb));

/**
 * An object URL for a trip file or its thumbnail, cached per session (revoked when evicted). Resolves to null for a
 * thumbnail the file does not have. Pass `signal` only for one-off full downloads (they are then not shared).
 */
export function fileUrl(target, id, { thumb = false, signal, onProgress, ...options } = {}) {
  const entity = entityOf(target, id);
  if (thumb && entity && !entity.thumb) return Promise.resolve(null);
  const cache = thumb ? thumbs : full;
  const key = urlKey(target, id, thumb);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const flight = `${thumb ? 't' : 'f'}:${key}`;
  if (!signal && inflight.has(flight)) return inflight.get(flight);
  const promise = fileBlob(target, id, { thumb, signal, onProgress, ...options }).then((blob) => cache.set(key, blob));
  if (signal) return promise;
  inflight.set(flight, promise);
  return promise.finally(() => inflight.delete(flight));
}

/** Saves a trip file through the browser's download. */
export async function downloadFile(space, id, options = {}) {
  const entity = space.get('file', id);
  saveBlob(await fileBlob(space, id, { ...options, download: true }), entity?.name ?? 'file');
}

// ---- Puter drive and local files ----

export const canUseDrive = (puter = puterOf()) => typeof puter?.ui?.showOpenFilePicker === 'function';
export const canSaveToDrive = (puter = puterOf()) => typeof puter?.ui?.showSaveFilePicker === 'function';

/** Copies a trip file into the user's drive with Puter's save picker. Dismissing the picker never settles. */
export async function saveToDrive(space, id, options = {}) {
  const puter = puterOf(options);
  if (!canSaveToDrive(puter)) throw new FileError('drive_unavailable');
  const entity = space.get('file', id);
  const blob = await fileBlob(space, id, { ...options, download: true });
  return puter.ui.showSaveFilePicker(blob, entity?.name ?? 'file');
}

/** Files picked from the user's Puter drive, read into memory for the normal upload path. Cancelling never settles. */
export async function pickFromDrive({ multiple = true, ...options } = {}) {
  const puter = puterOf(options);
  if (!canUseDrive(puter)) throw new FileError('drive_unavailable');
  const picked = await puter.ui.showOpenFilePicker({ multiple });
  const items = (Array.isArray(picked) ? picked : [picked]).filter((item) => item && !item.is_dir);
  return Promise.all(items.map(async (item) => {
    const blob = await item.read();
    return new File([blob], String(item.name ?? 'file'), { type: blob.type ?? '' });
  }));
}

/** Opens the device file chooser; resolves to the chosen files (empty when cancelled). */
export function chooseLocalFiles({ accept = ACCEPT, multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept, multiple });
    input.hidden = true;
    const done = (files) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => done([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

// ---- Writing ----

/** An upload task bound to the session's worker client; see `createUpload` in upload.js. */
export function startUpload(space, file, options = {}) {
  return createUpload(space, file, { ...options, api: apiOf(options), puter: puterOf(options) });
}

/** Uploads one file into the trip. `link: {t, id}` (or `links`) attaches it to an entity. Resolves to `{id, entity, duplicate}`. */
export function uploadFile(space, file, options = {}) {
  return startUpload(space, file, options).run();
}

async function fileOp(space, input, options) {
  const result = await apiOf(options).call(space.ref, 'file.del', input);
  await absorb(space, result);
  return result;
}
export const trashFile = (space, id, options) => fileOp(space, { fileId: id }, options);
export const restoreFile = (space, id, options) => fileOp(space, { fileId: id, restore: true }, options);
export const purgeFile = (space, id, options) => fileOp(space, { fileId: id, purge: true }, options);

/** Permanently deletes every trashed file, one at a time. Resolves to `{purged, failures}`. */
export async function emptyTrash(space, { onProgress, ...options } = {}) {
  const ids = trashedFiles(space).map((file) => file.id);
  const failures = [];
  for (const [index, id] of ids.entries()) {
    try { await purgeFile(space, id, options); } catch (error) { failures.push({ id, error }); }
    onProgress?.(index + 1, ids.length);
  }
  return { purged: ids.length - failures.length, failures };
}

export const setStar = (space, id, star) => space.apply([space.ops.patch('file', id, star ? { set: { star: true } } : { unset: ['star'] })]);
export const setDescription = (space, id, desc) => space.apply([space.ops.patch('file', id, desc.trim() ? { set: { desc } } : { unset: ['desc'] })]);

// ---- Links ----

/** Files in the Files tab (user files), trashed ones excluded unless asked. */
export const userFiles = (space, { trashed = false } = {}) => space.select.file.all().filter((file) => file.kind === 'user' && Boolean(file.trashed) === trashed);
export const trashedFiles = (space) => userFiles(space, { trashed: true });
/** Non-trashed files linked to `{t, id}`. */
export const filesFor = (space, target) => userFiles(space).filter((file) => hasFileLink(file, target));
export const linkFile = (space, id, target) => addLinks(space, id, [target]);

/** The patch op linking and unlinking one file (`{add, remove}` lists of `{t, id}`), or null when nothing changes. */
export function fileLinkOp(space, id, changes) {
  const file = space.get('file', id);
  const patch = file ? fileLinkPatch(file, changes) : null;
  return patch ? space.ops.patch('file', id, patch) : null;
}

export async function unlinkFile(space, id, target) {
  const op = fileLinkOp(space, id, { remove: [target] });
  if (op) await space.apply([op]);
}

// ---- Images and covers ----

/**
 * Uploads a photo resized to a 1600 px JPEG where the browser can decode it (otherwise the original), for covers and
 * place images. `links` attach it. Any space kind works. Resolves to `{id, entity, duplicate}`.
 */
export async function uploadImage(space, file, { onProgress, signal, links = [], ...options } = {}) {
  const type = fileType(file?.name);
  if (!type || type.group !== 'image') throw new FileError('image_type');
  const resized = await coverImage(file);
  if (!resized && type.heic) throw new FileError('heic_unsupported');
  const name = resized ? renameExtension(cleanName(file.name, type.ext), 'jpg') : file.name;
  const source = resized ? new File([resized], name, { type: 'image/jpeg' }) : file;
  return startUpload(space, source, { ...options, signal, convert: false, links, onChange: onProgress }).run();
}

/**
 * Uploads an image as the trip (or collection, journey) cover through `uploadImage`, linked to `{t:'meta', id:'meta'}`
 * and set as `meta.cover`. Needs `trip.cover` and `files.upload`. Resolves to `{id}`.
 */
export async function uploadCover(space, file, options = {}) {
  if (!space.can('trip.cover')) throw new FileError('forbidden');
  if (fileType(file?.name)?.group !== 'image') throw new FileError('cover_type');
  const { id } = await uploadImage(space, file, { ...options, links: [{ t: 'meta', id: 'meta' }] });
  await space.apply([space.ops.patch('meta', 'meta', { set: { cover: id } })]);
  return { id };
}

/**
 * A displayable URL for `meta.cover`: a trip file or an external http(s) image. `thumb: true` prefers the 320 px
 * thumbnail and falls back to the full image when there is none.
 */
export async function coverUrl(target, cover, { thumb = false, ...options } = {}) {
  if (typeof cover === 'string') {
    if (thumb) {
      const small = await fileUrl(target, cover, { ...options, thumb: true }).catch((error) => { if (error?.status === 404) return null; throw error; });
      if (small) return small;
    }
    return fileUrl(target, cover, options);
  }
  if (cover && typeof cover.url === 'string') {
    try { const url = new URL(cover.url); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
  }
  return null;
}
