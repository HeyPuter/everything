/**
 * Reading a file the user attaches to an AI sidebar message (media/ai-attach.js
 * decides what is taken). A picture is fitted to the vision API's limits for
 * the model to see, with a small thumbnail for the chat; a video or audio
 * file is only checked, as it goes to the model by its media id once
 * imported. (The fitting is the Spreadsheet app's: the API refuses an image
 * over 5 MB or 8000 px, and scales anything over about 1568 px on its long
 * edge down itself, at full cost.)
 */
import { attachmentKind, attachmentProblem, imageBlock, VISION_TYPES } from '../media/ai-attach.js';

// The API's 5 MB is the base64 it is sent as, a third larger than the image.
const VISION_MAX_BYTES = (5 * 1024 * 1024 * 3) / 4;
const VISION_MAX_EDGE = 1568;
const MAX_SHRINK_ROUNDS = 4;
const DECODE_MS = 10000;
/** The previews' long edge. */
const THUMB_EDGE = 320;

/** A file the assistant cannot take, with the reason in the user's words. */
export class AttachmentError extends Error {}

/** An image's media type by its first bytes, or null. */
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

// A picture's size, read without decoding its pixels (an <img> decodes only when drawn), or null.
async function imageSize(blob) {
  if (typeof Image !== 'function' || !globalThis.URL?.createObjectURL) return null;
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve) => {
      const node = new Image();
      const timer = setTimeout(() => resolve(null), DECODE_MS);
      node.onload = () => {
        clearTimeout(timer);
        resolve(node.naturalWidth > 0 && node.naturalHeight > 0 ? { width: node.naturalWidth, height: node.naturalHeight } : null);
      };
      node.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      node.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Decoded to something drawImage takes, with the picture's own size. A picture larger than maxEdge is decoded at
// that size (with the browser's best scaling, as drawing it smaller did): a 50 megapixel photo decoded whole took
// 200 MB at once only to be drawn 1568 pixels wide. Null when the bytes do not decode, undefined where there is
// nothing to decode them with.
async function decode(blob, maxEdge) {
  const bitmaps = typeof createImageBitmap === 'function';
  if (bitmaps) {
    const size = await imageSize(blob);
    const scale = size ? Math.min(1, maxEdge / Math.max(size.width, size.height)) : 1;
    const resize = scale < 1 ? { resizeWidth: Math.max(1, Math.round(size.width * scale)), resizeHeight: Math.max(1, Math.round(size.height * scale)), resizeQuality: 'high' } : {};
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', ...resize });
      return { img: bmp, width: scale < 1 ? size.width : bmp.width, height: scale < 1 ? size.height : bmp.height, release: () => bmp.close?.() };
    } catch {
      /* the <img> next */
    }
  }
  if (typeof Image !== 'function' || !globalThis.URL?.createObjectURL) return bitmaps ? null : undefined;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const node = new Image();
      const timer = setTimeout(() => reject(new Error('decode timed out')), DECODE_MS);
      node.onload = () => {
        clearTimeout(timer);
        resolve(node);
      };
      node.onerror = () => {
        clearTimeout(timer);
        reject(new Error('decode failed'));
      };
      node.src = url;
    });
    return { img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => {
  try {
    canvas.toBlob((b) => resolve(b || null), type, quality);
  } catch {
    resolve(null);
  }
});

async function drawn(canvas, img, w, h, type, quality) {
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.imageSmoothingQuality = 'high';
  if (type === 'image/jpeg') {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
  }
  g.drawImage(img, 0, 0, w, h);
  return toBlob(canvas, type, quality);
}

/**
 * The image as the model can take it: { blob, mediaType, width, height, thumb },
 * the original when it already fits, else a scaled copy. Null when it cannot
 * be decoded.
 */
export async function fitImageForVision(blob, mediaType) {
  const decoded = await decode(blob, VISION_MAX_EDGE);
  if (decoded === undefined) return VISION_TYPES.has(mediaType) && blob.size <= VISION_MAX_BYTES ? { blob, mediaType, thumb: null } : null;
  if (!decoded) return null;
  const { width, height } = decoded;
  const longEdge = Math.max(width, height);
  const keepsAlpha = mediaType === 'image/png' || mediaType === 'image/gif' || mediaType === 'image/webp';
  const canvas = document.createElement('canvas');
  try {
    const t = Math.min(1, THUMB_EDGE / longEdge);
    const thumb = t === 1 && VISION_TYPES.has(mediaType) ? blob
      : await drawn(canvas, decoded.img, Math.max(1, Math.round(width * t)), Math.max(1, Math.round(height * t)), keepsAlpha ? 'image/png' : 'image/jpeg', 0.8);
    if (VISION_TYPES.has(mediaType) && blob.size <= VISION_MAX_BYTES && longEdge <= VISION_MAX_EDGE) return { blob, mediaType, width, height, thumb };
    let scale = Math.min(1, VISION_MAX_EDGE / longEdge);
    let type = keepsAlpha ? 'image/png' : 'image/jpeg';
    let out = null;
    let w = width;
    let h = height;
    for (let round = 0; round <= MAX_SHRINK_ROUNDS; round++) {
      w = Math.max(1, Math.round(width * scale));
      h = Math.max(1, Math.round(height * scale));
      out = await drawn(canvas, decoded.img, w, h, type, type === 'image/jpeg' ? 0.85 : undefined);
      if (out && out.size <= VISION_MAX_BYTES) break;
      if (type === 'image/png') type = 'image/jpeg';
      else scale *= 0.8;
    }
    if (!out || out.size > VISION_MAX_BYTES) return null;
    return { blob: out, mediaType: type, width, height, thumb };
  } finally {
    decoded.release();
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Base64 of a Blob, in chunks (String.fromCharCode over a whole photo overflows the call stack). */
export async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * A file read for sending: { name, kind, size, blocks, thumb?, width?, height? }.
 * A picture that cannot be read for the model still goes (as media, unseen).
 * Throws an AttachmentError, in words for the user, for a file the assistant cannot take.
 */
export async function readAttachment(file) {
  const problem = attachmentProblem(file);
  if (problem) throw new AttachmentError(problem);
  const kind = attachmentKind(file);
  const base = { name: file.name || (kind === 'image' ? 'Pasted image' : 'File'), kind, size: file.size, blocks: [] };
  if (kind !== 'image') return base;
  let head;
  try {
    head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  } catch {
    head = null;
  }
  const declared = String(file.type || '').toLowerCase();
  const sniffed = head && sniffImageType(head);
  const mediaType = VISION_TYPES.has(sniffed) ? sniffed : VISION_TYPES.has(declared) ? 'image/x-unknown' : declared || 'image/x-unknown';
  const fit = await fitImageForVision(file, mediaType).catch(() => null);
  if (!fit) return base;
  return { ...base, thumb: fit.thumb || null, width: fit.width, height: fit.height, blocks: [imageBlock(fit.mediaType, await toBase64(fit.blob))] };
}
