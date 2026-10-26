// Entry photos and videos on the file API: thumbnails, uploads linked to an entry, ordering and removal.
import { el } from '../../ui/dom.js';
import { t } from '../../lib/i18n/index.js';
import {
  IMAGE_ACCEPT, cachedFileUrl, directAvailable, errorKey, fileUrl, isHeic, isRaster, startUpload, trashFile,
} from '../../lib/files/index.js';
import { icon } from './icons.js';

export const VIDEO_ACCEPT = '.mp4,.mov,.webm';
const VIDEO_NAME = /\.(mp4|mov|m4v|webm)$/i;

/** A live, non-trashed journey file. */
export const fileOf = (space, id) => {
  const entity = space.get('file', id);
  return entity && !entity.deleted && !entity.trashed ? entity : null;
};
export const isImageFile = (entity) => Boolean(entity) && (isRaster(entity.mime) || isHeic(entity.mime));
export const isVideoFile = (entity) => Boolean(entity) && String(entity.mime ?? '').startsWith('video/');
export const isVideoUpload = (file) => VIDEO_NAME.test(file?.name ?? '') || String(file?.type ?? '').startsWith('video/');

/** Media ids of an entry that still point at live files. */
export const liveMedia = (space, entry) => (entry?.media ?? []).filter((id) => fileOf(space, id));

/** What the add-photos picker accepts: images, plus videos when uploads can skip the worker (direct file mode). */
export async function mediaAccept(space) {
  return (await directAvailable(space).catch(() => false)) ? `${IMAGE_ACCEPT},${VIDEO_ACCEPT}` : IMAGE_ACCEPT;
}

/** A square tile: the thumbnail (or full image), a video badge, or a file icon. Loads lazily. */
export function mediaTile(space, fileId, { className = 'jr-tile', alt = '' } = {}) {
  const entity = fileOf(space, fileId);
  const tile = el(`span.${className}`, { dataset: { file: fileId } });
  if (isVideoFile(entity)) { tile.append(icon('video', 22)); tile.classList.add('is-video'); return tile; }
  if (!isImageFile(entity)) { tile.append(icon('file', 22)); return tile; }
  const image = el('img', { alt: alt || entity.desc || '', decoding: 'async', loading: 'lazy', hidden: true });
  const known = cachedFileUrl(space, fileId, { thumb: true }) ?? cachedFileUrl(space, fileId);
  const show = (src) => { if (src) { image.src = src; image.hidden = false; tile.classList.add('is-loaded'); } };
  tile.append(image);
  if (known) show(known);
  else {
    const load = () => fileUrl(space, fileId, { thumb: true })
      .then((url) => url ?? (isRaster(entity.mime) ? fileUrl(space, fileId) : null))
      .then(show).catch(() => tile.classList.add('is-broken'));
    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver((items) => { if (items.some((item) => item.isIntersecting)) { observer.disconnect(); void load(); } }, { rootMargin: '200px' });
      observer.observe(tile);
    } else void load();
  }
  return tile;
}

/**
 * Uploads files and appends them to an entry's media, one at a time so the entry is re-read before each patch.
 * Videos need direct file mode and are sent with `direct: 'require'`. Resolves `{added, failed: [{name, message}]}`.
 */
export async function uploadMedia(space, entryId, files, { onProgress, signal } = {}) {
  const added = [];
  const failed = [];
  for (const [index, file] of files.entries()) {
    if (signal?.aborted) break;
    onProgress?.({ index, total: files.length, name: file.name });
    try {
      const upload = startUpload(space, file, { link: { t: 'entry', id: entryId }, signal, ...(isVideoUpload(file) ? { direct: 'require' } : {}) });
      const { id } = await upload.run();
      const entry = space.get('entry', entryId);
      if (entry && !(entry.media ?? []).includes(id)) await space.apply([space.ops.patch('entry', entryId, { set: { media: [...(entry.media ?? []), id] } })]);
      added.push(id);
    } catch (error) {
      failed.push({ name: file.name, message: t(errorKey(error)) });
    }
  }
  return { added, failed };
}

/** Saves a new media order. */
export function reorderMedia(space, entryId, media) {
  return space.apply([space.ops.patch('entry', entryId, media.length ? { set: { media } } : { unset: ['media'] })]);
}

/**
 * Takes a file out of an entry and moves it to the trash when no other entry or the cover uses it (best effort:
 * trashing needs `files.delete` and a connection).
 */
export async function removeMedia(space, entryId, fileId) {
  const entry = space.get('entry', entryId);
  const media = (entry?.media ?? []).filter((id) => id !== fileId);
  if (entry) await reorderMedia(space, entryId, media);
  const used = space.select.entry.all().some((item) => item.id !== entryId && (item.media ?? []).includes(fileId)) || space.get('meta', 'meta')?.cover === fileId;
  if (!used && space.can('files.delete')) await trashFile(space, fileId).catch(() => {});
}

/** Trashes the files only `entry` used, after the entry itself is deleted. */
export async function trashOrphans(space, entry) {
  const others = new Set(space.select.entry.all().filter((item) => item.id !== entry.id).flatMap((item) => item.media ?? []));
  const cover = space.get('meta', 'meta')?.cover;
  if (!space.can('files.delete')) return;
  for (const id of entry.media ?? []) if (!others.has(id) && id !== cover && fileOf(space, id)) await trashFile(space, id).catch(() => {});
}
