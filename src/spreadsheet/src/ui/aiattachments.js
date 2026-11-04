/**
 * Reading a file the user attaches to a message into what the model is sent (core/aiattach.js): an image fitted
 * to the vision API's limits, a PDF checked for its length, a text file as its text.
 *
 * The image fitting is Puter Builder's (src/tools/fs/view_image.js): the API refuses an image over 5 MB or 8000 px
 * and scales anything over about 1568 px on its long edge down itself, at full cost, so an image is sent at most
 * that size. A phone photo is routinely 3–12 MB and 4000 px or more.
 */

import { decodeText } from '../core/io.js';
import { sniffImageType } from '../core/importrange.js';
import { t, tSource } from '../i18n/index.js';
import { attachmentKind, attachmentProblem, imageType, estimatePdfPages, textBlock, imageBlock, pdfBlock, VISION_TYPES, MAX_PDF_PAGES, MAX_TEXT_CHARS } from '../core/aiattach.js';

// The API's 5 MB is the base64 it is sent as, a third larger than the image: a 4 MB image is 5.3 MB of it, and refused.
const VISION_MAX_BYTES = (5 * 1024 * 1024 * 3) / 4;
const VISION_MAX_EDGE = 1568;
const MAX_SHRINK_ROUNDS = 4;
const DECODE_MS = 10000;
/** The previews' long edge: the sent message's, 160 px, sharp on a screen of twice the density. */
const THUMB_EDGE = 320;

/** A file the assistant cannot take, with the reason in the user's words. */
export class AttachmentError extends Error {}

// Decoded to something drawImage takes, with its size: createImageBitmap where there is one (it honours a photo's
// EXIF orientation), else an <img> over an object URL. Null when the bytes do not decode, undefined where there is
// nothing to decode them with.
async function decode(blob) {
  const bitmaps = typeof createImageBitmap === 'function';
  if (bitmaps) {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { img: bmp, width: bmp.width, height: bmp.height, release: () => { try { bmp.close?.(); } catch { /* gone */ } } };
    } catch { /* the <img> next */ }
  }
  if (typeof Image !== 'function' || !globalThis.URL?.createObjectURL) return bitmaps ? null : undefined;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const node = new Image();
      // A browser that never loads it (a format it does not know may fire neither event) is a failed decode.
      const timer = setTimeout(() => reject(new Error('decode timed out')), DECODE_MS);
      node.onload = () => { clearTimeout(timer); resolve(node); };
      node.onerror = () => { clearTimeout(timer); reject(new Error('decode failed')); };
      node.src = url;
    });
    return { img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => {
  try { canvas.toBlob((b) => resolve(b || null), type, quality); } catch { resolve(null); }
});

// The image drawn at w × h on `canvas` and encoded as `type`: on white for a JPEG, which has no transparency (what is
// see-through would come out black, and dark text on it unreadable). Null where the canvas cannot be drawn on.
async function drawn(canvas, img, w, h, type, quality) {
  canvas.width = w; // resizing clears it, and resets the context's settings
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.imageSmoothingQuality = 'high';
  if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
  g.drawImage(img, 0, 0, w, h);
  return toBlob(canvas, type, quality);
}

/**
 * The image as the model can take it: the original when it already fits and is a format the model reads, otherwise a
 * copy scaled to VISION_MAX_EDGE on its long edge (PNG where the source may be transparent, JPEG otherwise), shrunk
 * further until it is under VISION_MAX_BYTES. With it, `thumb`: a copy at most THUMB_EDGE on its long edge for the
 * previews, which drawn from the original would hold a photo decoded at full size (some 48 MB for 12 megapixels)
 * for as long as the chat shows it. Null when it cannot be decoded (or, with nothing to decode it with, is not a
 * format sent as it is).
 */
export async function fitImageForVision(blob, mediaType) {
  const decoded = await decode(blob);
  // Bytes a browser cannot decode the API cannot read either, and a refused image fails every request that carries it:
  // only where nothing could decode it is an image in a format the model reads sent untried.
  if (decoded === undefined) return VISION_TYPES.has(mediaType) && blob.size <= VISION_MAX_BYTES ? { blob, mediaType, fitted: false } : null;
  if (!decoded) return null;
  const { width, height } = decoded;
  const longEdge = Math.max(width, height);
  const keepsAlpha = mediaType === 'image/png' || mediaType === 'image/gif' || mediaType === 'image/webp';
  // One canvas for every drawing, let go at the end: Safari on iOS caps all canvases together, and holds a dropped one
  // until it is collected, so a few photos fitted in a row would run it out.
  const canvas = document.createElement('canvas');
  try {
    const thumbScale = Math.min(1, THUMB_EDGE / longEdge);
    const thumb = thumbScale === 1 && VISION_TYPES.has(mediaType) ? blob
      : await drawn(canvas, decoded.img, Math.max(1, Math.round(width * thumbScale)), Math.max(1, Math.round(height * thumbScale)), keepsAlpha ? 'image/png' : 'image/jpeg', 0.8);
    if (VISION_TYPES.has(mediaType) && blob.size <= VISION_MAX_BYTES && longEdge <= VISION_MAX_EDGE) return { blob, mediaType, width, height, fitted: false, thumb };
    let scale = Math.min(1, VISION_MAX_EDGE / longEdge);
    let type = keepsAlpha ? 'image/png' : 'image/jpeg';
    let out = null, w = width, h = height;
    for (let round = 0; round <= MAX_SHRINK_ROUNDS; round++) {
      w = Math.max(1, Math.round(width * scale));
      h = Math.max(1, Math.round(height * scale));
      out = await drawn(canvas, decoded.img, w, h, type, type === 'image/jpeg' ? 0.85 : undefined);
      if (out && out.size <= VISION_MAX_BYTES) break;
      // Still too big: a PNG gives up its transparency for JPEG's far smaller size first, then the edge shrinks by a fifth a round.
      if (type === 'image/png') type = 'image/jpeg';
      else scale *= 0.8;
    }
    if (!out || out.size > VISION_MAX_BYTES) return null;
    return { blob: out, mediaType: type, width: w, height: h, fitted: true, thumb };
  } finally {
    decoded.release();
    canvas.width = 0;
    canvas.height = 0;
  }
}

// A blob's bytes, through FileReader where the blob has no methods of its own (Safari before 14).
const reading = (blob, how) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error(t('aiattachments.couldNotRead')));
  reader[how](blob);
});
const readBytes = (blob) => (typeof blob.arrayBuffer === 'function' ? blob.arrayBuffer() : reading(blob, 'readAsArrayBuffer'));

/** Base64 of bytes, in chunks: String.fromCharCode over a whole photo's bytes overflows the call stack. */
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const toBase64 = async (blob) => bytesToBase64(new Uint8Array(await readBytes(blob)));

// Bytes as text, a character a byte: what a PDF's keywords are found in, at the offsets of its bytes.
const latin1 = (bytes) => new TextDecoder('latin1').decode(bytes);
// At most this much inflated from a PDF's object streams: a few kilobytes can inflate to gigabytes.
const MAX_INFLATED_CHARS = 16 * 1024 * 1024;

// Flate data inflated, as text, up to `room` characters. What came out before data that does not inflate is kept.
async function inflate(data, room) {
  const reader = new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }).pipeThrough(new DecompressionStream('deflate')).getReader();
  const decoder = new TextDecoder('latin1');
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= room) { reader.cancel().catch(() => {}); break; }
    }
  } catch { /* not deflate, or cut short */ }
  return out.slice(0, room);
}

/**
 * A PDF's text, and the object streams it packs objects into, each { data, first } (core/aiattach.js counts the pages
 * in them): a PDF 1.5 or later may pack every page's dictionary into one, compressed, where the page count would not see
 * them. A stream in a filter other than Flate is left out, its objects unseen.
 */
async function pdfText(bytes) {
  const text = latin1(bytes);
  const streams = [];
  if (!text.includes('/ObjStm')) return { text, streams };
  const inflates = typeof DecompressionStream === 'function' && typeof ReadableStream === 'function';
  let room = MAX_INFLATED_CHARS;
  const re = /\/Type\s*\/ObjStm\b/g;
  for (let m = re.exec(text); m && room > 0; m = re.exec(text)) {
    // The stream's dictionary runs on to its "stream" keyword; the data, from the line after, to "endstream".
    const keyword = text.indexOf('stream', m.index);
    if (keyword < 0) break;
    let start = keyword + 'stream'.length;
    if (text[start] === '\r') start++;
    if (text[start] === '\n') start++;
    let end = text.indexOf('endstream', start);
    if (end < 0) break;
    re.lastIndex = end;
    while (end > start && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
    const dict = text.slice(Math.max(0, text.lastIndexOf('obj', m.index)), keyword);
    const first = Number(/\/First\s+(\d+)/.exec(dict)?.[1]);
    let data;
    if (/\/FlateDecode\b/.test(dict)) { if (!inflates) continue; data = await inflate(bytes.subarray(start, end), room); }
    else if (/\/Filter\b/.test(dict)) continue;
    else data = text.slice(start, end);
    room -= data.length;
    streams.push({ data, first });
  }
  return { text, streams };
}

/**
 * An image's media type by its bytes: the browser takes a file's type from its name, and a WebP saved as .jpg or a
 * JPEG renamed .png, sent as it is under that type, is refused by the API ("does not match the provided media type")
 * with every request that carries it. Bytes that are none of the formats sent as they are must be re-encoded, so they
 * are not given one of those types; where they cannot be read, the file's own type stands.
 */
async function imageMediaType(file) {
  const declared = imageType(file);
  let head;
  try { head = new Uint8Array(await readBytes(file.slice(0, 16))); } catch { return declared; }
  const sniffed = sniffImageType(head);
  if (VISION_TYPES.has(sniffed)) return sniffed;
  return VISION_TYPES.has(declared) ? 'image/x-unknown' : declared;
}

/**
 * A file read for sending: { name, kind, size, blocks, pages?, chars?, thumb? }, the blocks being what goes to the
 * model, and an image's `thumb` its preview (null where none could be drawn).
 * Throws an AttachmentError, in words for the user, for a file the assistant cannot take.
 */
export async function readAttachment(file) {
  const problem = attachmentProblem(file);
  if (problem) throw new AttachmentError(problem);
  const kind = attachmentKind(file);
  const base = { name: file.name || (kind === 'image' ? t('aiattachments.pastedImage') : t('aiattachments.file')), kind, size: file.size };
  if (kind === 'image') {
    const fit = await fitImageForVision(file, await imageMediaType(file));
    if (!fit) throw new AttachmentError(t('aiattachments.notAnImage', { name: base.name }));
    return { ...base, thumb: fit.thumb || null, blocks: [imageBlock(fit.mediaType, await toBase64(fit.blob))] };
  }
  if (kind === 'pdf') {
    const bytes = new Uint8Array(await readBytes(file));
    const { text, streams } = await pdfText(bytes);
    const pages = estimatePdfPages(text, streams);
    if (pages > MAX_PDF_PAGES) throw new AttachmentError(t('aiattachments.tooManyPages', { name: base.name, pages, max: MAX_PDF_PAGES }));
    return { ...base, pages: Math.max(1, pages), blocks: [pdfBlock(bytesToBase64(bytes))] };
  }
  // In the encoding it was saved in: a CSV from Excel on Windows is Windows-1252, an export may be UTF-16.
  const text = decodeText(new Uint8Array(await readBytes(file)));
  if (!text.trim()) throw new AttachmentError(t('aiattachments.empty', { name: base.name }));
  return { ...base, chars: Math.min(text.length, MAX_TEXT_CHARS), blocks: [textBlock(file.name || tSource('aiattachments.file'), text)] };
}
