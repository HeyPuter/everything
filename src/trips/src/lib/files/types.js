import { LIMITS } from '../../shared/limits.js';

export const MAX_FILE_BYTES = LIMITS.fileBytes;
// Videos go only through direct file mode (the worker refuses them proxied), up to its 500 MB limit.
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_NAME = 200;

// Files a member may add to the Files tab. Mirrors the worker allowlist for `kind: 'user'` (worker/engine/files.js).
const TYPES = Object.freeze({
  jpg: { mime: 'image/jpeg', group: 'image' }, jpeg: { mime: 'image/jpeg', group: 'image' },
  png: { mime: 'image/png', group: 'image' }, gif: { mime: 'image/gif', group: 'image' }, webp: { mime: 'image/webp', group: 'image' },
  avif: { mime: 'image/avif', group: 'image' }, heic: { mime: 'image/heic', group: 'image', heic: true }, heif: { mime: 'image/heif', group: 'image', heic: true },
  pdf: { mime: 'application/pdf', group: 'pdf' },
  doc: { mime: 'application/msword', group: 'document' }, xls: { mime: 'application/vnd.ms-excel', group: 'document' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', group: 'document' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', group: 'document' },
  txt: { mime: 'text/plain', group: 'document', text: true }, csv: { mime: 'text/csv', group: 'document', text: true },
  md: { mime: 'text/markdown', group: 'document', text: true },
  pkpass: { mime: 'application/vnd.apple.pkpass', group: 'document' }, pkpasses: { mime: 'application/vnd.apple.pkpasses', group: 'document' },
});
// Videos the worker accepts through a member's inbox; other video formats are refused.
const VIDEO_TYPES = Object.freeze({
  mp4: { mime: 'video/mp4', group: 'video', video: true }, mov: { mime: 'video/quicktime', group: 'video', video: true }, webm: { mime: 'video/webm', group: 'video', video: true },
});
const OTHER_VIDEO = new Set(['m4v', 'mkv', 'avi', 'wmv', 'flv', '3gp']);

export const ACCEPT = Object.keys(TYPES).map((ext) => `.${ext}`).join(',');
export const VIDEO_ACCEPT = Object.keys(VIDEO_TYPES).map((ext) => `.${ext}`).join(',');
export const IMAGE_ACCEPT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'heif'].map((ext) => `.${ext}`).join(',');

export const extensionOf = (name) => {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(String(name ?? ''));
  return match ? match[1].toLowerCase() : '';
};

/** `{ext, mime, group, heic?, text?, video?}` for an allowed file name (videos included), else null. */
export function fileType(name) {
  const ext = extensionOf(name);
  if (Object.hasOwn(TYPES, ext)) return { ext, ...TYPES[ext] };
  return Object.hasOwn(VIDEO_TYPES, ext) ? { ext, ...VIDEO_TYPES[ext] } : null;
}
export const isVideoFile = (file) => Object.hasOwn(VIDEO_TYPES, extensionOf(file?.name)) || OTHER_VIDEO.has(extensionOf(file?.name))
  || (!fileType(file?.name) && String(file?.type ?? '').startsWith('video/'));

/**
 * Reason a file cannot be added, or null. Codes match `files.error.<code>` strings. `video: true` when this trip takes
 * videos (direct file mode, see `directAvailable`); otherwise any video answers `video_direct`.
 */
export function rejectReason(file, { video = false } = {}) {
  const ext = extensionOf(file?.name);
  if (isVideoFile(file)) {
    if (!video) return 'video_direct';
    if (!Object.hasOwn(VIDEO_TYPES, ext)) return 'video_format';
    if (!(file.size > 0)) return 'file_empty';
    return file.size > MAX_VIDEO_BYTES ? 'video_too_large' : null;
  }
  if (!Object.hasOwn(TYPES, ext)) return 'file_type';
  if (!(file.size > 0)) return 'file_empty';
  // HEIC is converted first, and the converted size is checked again before upload.
  if (file.size > MAX_FILE_BYTES && !TYPES[ext].heic) return 'file_too_large';
  return null;
}

/** Keeps the extension, drops control and path characters, and caps the length. */
export function cleanName(name, ext = extensionOf(name)) {
  const base = String(name ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const stem = (ext ? base.slice(0, -(ext.length + 1)) : base).trim() || 'file';
  return `${[...stem].slice(0, MAX_NAME - ext.length - 1).join('')}${ext ? `.${ext}` : ''}`;
}

export function renameExtension(name, ext) {
  const current = extensionOf(name);
  return cleanName(`${current ? name.slice(0, -(current.length + 1)) : name}.${ext}`, ext);
}

/** Filter group of a stored file: image, pdf or document. */
export function groupOf(entity) {
  const mime = String(entity?.mime ?? '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return 'document';
}

const RASTER = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const PLAYABLE = new Set(Object.values(VIDEO_TYPES).map((type) => type.mime));
export const isRaster = (mime) => RASTER.has(String(mime ?? '').toLowerCase());
export const isVideo = (mime) => PLAYABLE.has(String(mime ?? '').toLowerCase());
export const isHeic = (mime) => /^image\/hei[cf]$/i.test(String(mime ?? ''));

/** How the preview shows a stored file. */
export function previewKind(entity) {
  const mime = String(entity?.mime ?? '').toLowerCase();
  if (isRaster(mime)) return 'image';
  if (isHeic(mime)) return 'heic';
  if (isVideo(mime)) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'text/plain' || mime === 'text/csv') return 'text';
  return 'none';
}

/** The type a downloaded Blob gets. Only images, video, PDF and plain text are ever typed for display. */
export function blobType(mime, { download = false } = {}) {
  const value = String(mime ?? '').toLowerCase();
  if (isRaster(value) || isHeic(value) || isVideo(value) || value === 'application/pdf') return value;
  if (value.startsWith('text/')) return 'text/plain;charset=utf-8';
  if (download && Object.values(TYPES).some((type) => type.mime === value)) return value;
  return 'application/octet-stream';
}
