import { newId } from '../../shared/ids.js';
import { FileError, errorCode } from './errors.js';
import { convertHeic, makeThumbnail } from './image.js';
import { directAccess, directFailure, pauseDirect, writeInbox } from './direct.js';
import { MAX_FILE_BYTES, MAX_VIDEO_BYTES, cleanName, fileType, isRaster, isVideoFile, rejectReason, renameExtension } from './types.js';
import { sha256Stream } from './sha256.js';
import { fileLinkPatch } from '../../shared/file-links.js';

const STREAM_HASH_BYTES = 64 * 1024 * 1024;

export async function sha256Hex(blob) {
  if (blob.size > STREAM_HASH_BYTES) return sha256Stream(blob);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Checks a picked file and gets it ready to send: allowlist and size, HEIC re-encoded as JPEG where this browser can
 * decode it (otherwise the original is kept and `notice` says so), and the SHA-256.
 */
export async function prepareFile(file, { convert = true, video = false } = {}) {
  const reason = rejectReason(file, { video });
  if (reason) throw new FileError(reason);
  const type = fileType(file.name);
  let blob = file;
  let name = cleanName(file.name, type.ext);
  let mime = type.mime;
  let notice = null;
  if (type.heic && convert) {
    const jpeg = await convertHeic(file);
    if (jpeg) { blob = jpeg; name = renameExtension(name, 'jpg'); mime = 'image/jpeg'; notice = 'heic_converted'; }
    else notice = 'heic_kept';
  }
  if (blob.size > (type.video ? MAX_VIDEO_BYTES : MAX_FILE_BYTES)) throw new FileError(type.video ? 'video_too_large' : 'file_too_large');
  return { blob, name, mime, sha256: await sha256Hex(blob), notice };
}

/** Applies a `file.put`/`file.del`/thumbnail response to the replica at once; the change record follows by sync. */
export async function absorb(space, result) {
  const ents = Array.isArray(result?.ents) ? result.ents : [];
  const del = (Array.isArray(result?.del) ? result.del : []).map((item) => ({ ...item, deleted: true, rev: result.rev }));
  if (!ents.length && !del.length) return;
  // A closed or failing replica still gets the change from the next sync.
  try { await space.store.merge(ents, del, { lenient: true }); } catch { void Promise.resolve(space.sync?.()).catch(() => {}); }
}

/** Adds links to a file, one path each; a no-op when all are present. */
export async function addLinks(space, fileId, links) {
  const entity = space.get('file', fileId);
  if (!entity || !links?.length) return;
  const patch = fileLinkPatch(entity, { add: links });
  if (patch) await space.apply([space.ops.patch('file', fileId, patch)]);
}

/** A non-trashed user file with the same content, so an upload can reuse it. */
export function findDuplicate(space, sha256, kind = 'user') {
  return space.select.file.all().find((file) => file.sha256 === sha256 && !file.trashed && file.kind === kind) ?? null;
}

let sequence = 0;

/**
 * One upload: send the bytes (into the member's inbox in direct mode, else `PUT` through the worker), register them
 * with `file.put`, store a thumbnail, then add links. `direct`: `auto` uses the inbox when the trip allows it and falls
 * back to the worker, `require` never falls back (`direct_required`), `never` always uses the worker. `run()` resumes
 * after a failure without repeating finished steps. State: `{key, name, size, status, loaded, total, error, notice,
 * fileId, duplicate, via}`; status is queued|preparing|uploading|saving|thumbnail|done|error|canceled.
 */
export function createUpload(space, file, { api, puter, direct = 'auto', link, links = link ? [link] : [], desc, dedupe = true, convert = true, kind = 'user', fields = null, signal, onChange } = {}) {
  const state = { key: `upload-${++sequence}`, name: file.name, size: file.size, status: 'queued', loaded: 0, total: file.size, error: null, notice: null, fileId: null, duplicate: false, via: null };
  // Videos only ever go through the inbox: the worker refuses them proxied.
  const video = isVideoFile(file);
  if (video) direct = 'require';
  let prepared = null;
  let sent = false;
  let inboxName = null;
  let entity = null;
  let thumbed = false;
  let controller = null;
  let running = null;
  const set = (patch) => { Object.assign(state, patch); onChange?.({ ...state }); };
  const cancelExternal = () => controller?.abort();
  signal?.addEventListener('abort', cancelExternal, { once: true });

  async function steps(own) {
    if (!api) throw new FileError('files_unbound');
    if (!space.can('files.upload')) throw new FileError('forbidden');
    if (!prepared) {
      set({ status: 'preparing', error: null });
      // Checked before hashing, which takes a while for a large video.
      if (video && !(await directAccess(space).then((access) => access?.owner || access?.inbox))) throw new FileError('video_direct');
      prepared = await prepareFile(file, { convert, video });
      set({ name: prepared.name, total: prepared.blob.size, notice: prepared.notice });
    }
    if (own.aborted) throw new FileError('aborted');
    if (!entity && dedupe) {
      const existing = findDuplicate(space, prepared.sha256, kind);
      if (existing) {
        await addLinks(space, existing.id, links);
        set({ status: 'done', fileId: existing.id, duplicate: true });
        return { id: existing.id, entity: existing, duplicate: true };
      }
    }
    state.fileId ??= newId();
    const ref = space.ref;
    // A direct attempt that fails falls back once to the worker within the same run.
    for (let attempt = 0; !entity; attempt++) {
      if (!sent) {
        set({ status: 'uploading', loaded: 0, error: null });
        const access = state.via === 'proxied' || direct === 'never' ? null : await directAccess(space);
        if (direct === 'require' && !(access?.owner || access?.inbox)) throw new FileError('direct_required');
        set({ via: access?.owner || access?.inbox ? 'direct' : 'proxied' });
        if (state.via === 'direct') {
          try { inboxName = await writeInbox(space, access, state.fileId, prepared, { puter }); }
          catch (error) {
            if (!directFailure(error) || own.aborted) throw error;
            if (direct === 'require') throw new FileError('direct_required');
            pauseDirect(space);
            set({ via: 'proxied' });
          }
        }
        if (own.aborted) throw new FileError('aborted');
        if (state.via === 'proxied') await api.upload(ref, state.fileId, prepared.blob, { signal: own, onProgress: ({ loaded, total }) => set({ loaded, total: total || state.total }) });
        sent = true;
        set({ loaded: state.total });
      }
      set({ status: 'saving', error: null });
      let result;
      try {
        result = await api.call(ref, 'file.put', { fileId: state.fileId, name: prepared.name, mime: prepared.mime, sha256: prepared.sha256, kind, ...(desc ? { desc } : {}), ...(fields ?? {}),
          ...(state.via === 'direct' ? { inboxName } : {}) });
      } catch (error) {
        // The worker no longer accepts inbox uploads for this trip (files went proxied).
        if (state.via !== 'direct' || error?.code !== 'direct_unavailable' || direct === 'require' || attempt) throw error;
        pauseDirect(space);
        set({ via: 'proxied' });
        sent = false;
        continue;
      }
      await absorb(space, result);
      entity = result.ents?.find((item) => item.id === state.fileId) ?? space.get('file', state.fileId) ?? null;
      if (!entity) break;
    }
    if (!thumbed && isRaster(prepared.mime)) {
      set({ status: 'thumbnail' });
      // A missing thumbnail only costs a generic icon.
      try {
        const thumb = await makeThumbnail(prepared.blob);
        if (thumb && !own.aborted) await absorb(space, await api.upload(ref, state.fileId, thumb, { thumb: true, signal: own }));
      } catch { /* keep the file */ }
      thumbed = true;
    }
    await addLinks(space, state.fileId, links);
    set({ status: 'done', error: null });
    return { id: state.fileId, entity: space.get('file', state.fileId) ?? entity, duplicate: false };
  }

  return {
    get state() { return { ...state }; },
    /** Resolves to `{id, entity, duplicate}`; rejects with the error also kept in `state.error`. */
    run() {
      if (running) return running;
      if (state.status === 'done') return Promise.resolve({ id: state.fileId, entity: space.get('file', state.fileId) ?? entity, duplicate: state.duplicate });
      if (signal?.aborted) { set({ status: 'canceled' }); return Promise.reject(new FileError('aborted')); }
      controller = new AbortController();
      running = steps(controller.signal).catch((error) => {
        const code = errorCode(error);
        // The worker sweeps unregistered uploads after an hour; send the bytes again next time.
        if (code === 'upload_missing') sent = false;
        set(code === 'aborted' ? { status: 'canceled', error: null } : { status: 'error', error });
        throw error;
      }).finally(() => { running = null; controller = null; });
      return running;
    },
    cancel() { controller?.abort(); if (!running && state.status !== 'done') set({ status: 'canceled' }); },
  };
}
