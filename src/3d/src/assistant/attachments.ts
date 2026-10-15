// Reading a file the user attaches into what the model is sent (attach.ts):
// an image fitted to the vision API's limits, a PDF checked for its length,
// a text file as its text. Ported from Spreadsheet's assistant.
//
// The API refuses an image over 5 MB or 8000 px and scales anything over about
// 1568 px on its long edge down itself, at full cost, so an image is sent at
// most that size. A phone photo is routinely 3-12 MB and 4000 px or more.

import {
  type Attachment, MAX_PDF_PAGES, MAX_TEXT_CHARS, VISION_TYPES, attachmentKind, attachmentProblem, estimatePdfPages, imageBlock, imageType, pdfBlock,
  textBlock,
} from './attach';

// The API's 5 MB is the base64 it is sent as, a third larger than the image.
const VISION_MAX_BYTES = (5 * 1024 * 1024 * 3) / 4;
const VISION_MAX_EDGE = 1568;
const MAX_SHRINK_ROUNDS = 4;
const DECODE_MS = 10000;
/** Longest edge of an attached image as scripts load it into the scene (larger photos are scaled down to it). */
const MAX_TEXTURE_EDGE = 8192;
/** Long edge of the previews shown in the chat. */
const THUMB_EDGE = 320;
/** At most this much inflated from a PDF's object streams (a few kilobytes can inflate to gigabytes). */
const MAX_INFLATED_CHARS = 16 * 1024 * 1024;

/** A file the assistant cannot take, with the reason in the user's words. */
export class AttachmentError extends Error {}

interface Decoded { img: CanvasImageSource; width: number; height: number; release: () => void }

// Decoded to something drawImage takes: createImageBitmap where there is one
// (it honours a photo's EXIF orientation), else an <img> over an object URL.
async function decode(blob: Blob): Promise<Decoded | null | undefined> {
  const bitmaps = typeof createImageBitmap === 'function';
  if (bitmaps) {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { img: bmp, width: bmp.width, height: bmp.height, release: () => { try { bmp.close(); } catch { /* gone */ } } };
    } catch { /* the <img> next */ }
  }
  if (typeof Image !== 'function' || !globalThis.URL?.createObjectURL) return bitmaps ? null : undefined;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const node = new Image();
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

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob | null>((resolve) => {
  try { canvas.toBlob((b) => resolve(b ?? null), type, quality); } catch { resolve(null); }
});

// Drawn at w x h and encoded; on white for a JPEG (transparency would turn black).
async function drawn(canvas: HTMLCanvasElement, img: CanvasImageSource, w: number, h: number, type: string, quality?: number) {
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.imageSmoothingQuality = 'high';
  if (type === 'image/jpeg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
  g.drawImage(img, 0, 0, w, h);
  return toBlob(canvas, type, quality);
}

/** An image as scripts load it into the scene (D.images.load): full size up to MAX_TEXTURE_EDGE, in a format textures decode. */
export interface TextureImage { blob: Blob; mediaType: string; width: number; height: number }

/**
 * The image as the model can take it: the original when it fits and is a
 * format the model reads, else a copy scaled to VISION_MAX_EDGE (PNG where it
 * may be transparent, JPEG otherwise), shrunk until it is under the byte limit.
 * With it a small `thumb` for the chat and the `texture` scripts may load.
 * Null when it cannot be decoded.
 */
export async function fitImageForVision(blob: Blob, mediaType: string): Promise<{ blob: Blob; mediaType: string; thumb?: Blob | null; texture?: TextureImage | null } | null> {
  const decoded = await decode(blob);
  if (decoded === undefined) return VISION_TYPES.has(mediaType) && blob.size <= VISION_MAX_BYTES ? { blob, mediaType } : null;
  if (!decoded) return null;
  const { width, height } = decoded;
  const longEdge = Math.max(width, height);
  const keepsAlpha = mediaType === 'image/png' || mediaType === 'image/gif' || mediaType === 'image/webp';
  // One canvas for every drawing, let go at the end (iOS caps canvas memory).
  const canvas = document.createElement('canvas');
  try {
    const t = Math.min(1, THUMB_EDGE / longEdge);
    const thumb = t === 1 && VISION_TYPES.has(mediaType) ? blob
      : await drawn(canvas, decoded.img, Math.max(1, Math.round(width * t)), Math.max(1, Math.round(height * t)), keepsAlpha ? 'image/png' : 'image/jpeg', 0.8);
    let texture: TextureImage | null = null;
    if (VISION_TYPES.has(mediaType) && longEdge <= MAX_TEXTURE_EDGE) texture = { blob, mediaType, width, height };
    else {
      const k = Math.min(1, MAX_TEXTURE_EDGE / longEdge);
      const [w, h] = [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
      const type = keepsAlpha ? 'image/png' : 'image/jpeg';
      const out = await drawn(canvas, decoded.img, w, h, type, type === 'image/jpeg' ? 0.92 : undefined);
      if (out) texture = { blob: out, mediaType: type, width: w, height: h };
    }
    if (VISION_TYPES.has(mediaType) && blob.size <= VISION_MAX_BYTES && longEdge <= VISION_MAX_EDGE) return { blob, mediaType, thumb, texture };
    let scale = Math.min(1, VISION_MAX_EDGE / longEdge);
    let type = keepsAlpha ? 'image/png' : 'image/jpeg';
    let out: Blob | null = null;
    for (let round = 0; round <= MAX_SHRINK_ROUNDS; round++) {
      out = await drawn(canvas, decoded.img, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), type, type === 'image/jpeg' ? 0.85 : undefined);
      if (out && out.size <= VISION_MAX_BYTES) break;
      if (type === 'image/png') type = 'image/jpeg';
      else scale *= 0.8;
    }
    if (!out || out.size > VISION_MAX_BYTES) return null;
    return { blob: out, mediaType: type, thumb, texture };
  } finally {
    decoded.release();
    canvas.width = 0;
    canvas.height = 0;
  }
}

const readBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** Base64 of bytes, in chunks (String.fromCharCode over a whole photo overflows the stack). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

/** An image's real type from its first bytes (a WebP renamed .jpg would be refused under the wrong type). */
export function sniffImageType(b: Uint8Array): string | null {
  if (b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

async function imageMediaType(file: File): Promise<string> {
  const declared = imageType(file);
  let head: Uint8Array;
  try { head = await readBytes(file.slice(0, 16)); } catch { return declared; }
  const sniffed = sniffImageType(head);
  if (sniffed && VISION_TYPES.has(sniffed)) return sniffed;
  // Not a format sent as it is: never give it one of those types, so it is re-encoded.
  return VISION_TYPES.has(declared) ? 'image/x-unknown' : declared;
}

/** Text in the encoding it was saved in: UTF-8, UTF-16 with a byte-order mark, or Windows-1252. */
export function decodeText(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    try { return new TextDecoder('windows-1252').decode(b); } catch { return new TextDecoder('utf-8').decode(b); }
  }
}

async function inflate(data: Uint8Array, room: number): Promise<string> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
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

/** A PDF's text and its object streams (where PDF 1.5+ may pack every page's dictionary). */
async function pdfText(bytes: Uint8Array): Promise<{ text: string; streams: { data: string; first: number }[] }> {
  const text = new TextDecoder('latin1').decode(bytes);
  const streams: { data: string; first: number }[] = [];
  if (!text.includes('/ObjStm')) return { text, streams };
  const inflates = typeof DecompressionStream === 'function';
  let room = MAX_INFLATED_CHARS;
  const re = /\/Type\s*\/ObjStm\b/g;
  for (let m = re.exec(text); m && room > 0; m = re.exec(text)) {
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
    let data: string;
    if (/\/FlateDecode\b/.test(dict)) { if (!inflates) continue; data = await inflate(bytes.subarray(start, end), room); }
    else if (/\/Filter\b/.test(dict)) continue;
    else data = text.slice(start, end);
    room -= data.length;
    streams.push({ data, first });
  }
  return { text, streams };
}

/** A file read for sending. Throws an AttachmentError, in words for the user, for one the assistant cannot take. */
export async function readAttachment(file: File): Promise<Attachment> {
  const problem = attachmentProblem(file);
  if (problem) throw new AttachmentError(problem);
  const kind = attachmentKind(file)!;
  const base = { name: file.name || (kind === 'image' ? 'Pasted image' : 'File'), kind, size: file.size };
  if (kind === 'image') {
    const fit = await fitImageForVision(file, await imageMediaType(file));
    if (!fit) throw new AttachmentError(`${base.name} could not be read as an image. Try a PNG or JPEG.`);
    const tex = fit.texture;
    const source = tex ? { name: base.name, bytes: await readBytes(tex.blob), mime: tex.mediaType, width: tex.width, height: tex.height } : undefined;
    return { ...base, thumb: fit.thumb ?? null, source, blocks: [imageBlock(fit.mediaType, bytesToBase64(await readBytes(fit.blob)))] };
  }
  if (kind === 'pdf') {
    const bytes = await readBytes(file);
    const { text, streams } = await pdfText(bytes);
    const pages = estimatePdfPages(text, streams);
    if (pages > MAX_PDF_PAGES) throw new AttachmentError(`${base.name} has about ${pages} pages; the assistant reads at most ${MAX_PDF_PAGES}. Attach the pages you need as a shorter PDF.`);
    return { ...base, pages: Math.max(1, pages), blocks: [pdfBlock(bytesToBase64(bytes))] };
  }
  const text = decodeText(await readBytes(file));
  if (!text.trim()) throw new AttachmentError(`${base.name} is empty.`);
  return { ...base, chars: Math.min(text.length, MAX_TEXT_CHARS), blocks: [textBlock(base.name, text)] };
}
