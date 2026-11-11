// Export pipeline shared by Export As, Quick Export, Export Layers and the
// Image Processor: resample, place on an output canvas, convert to sRGB,
// flatten onto a matte where needed, encode and attach metadata.
import { encodeBmp } from '../../imaging/codecs/bmp';
import { encodeGif } from '../../imaging/codecs/gif';
import { encodeIco, type IcoEncodeEntry } from '../../imaging/codecs/ico';
import { insertJpegIcc, readJpegSegments, setJpegDensity } from '../../imaging/codecs/jpeg-markers';
import { makeIccpChunk, makePhysChunk, makeSrgbChunk, makeTextChunk, type NewChunk } from '../../imaging/codecs/png-chunks';
import { encodeTga } from '../../imaging/codecs/tga';
import { encodeTiff } from '../../imaging/codecs/tiff';
import { concatBytes } from '../../imaging/codecs/bytes';
import type { RgbProfile } from '../../color/profile';
import { convertToSrgb } from './color';
import { encodePng, rgba16To8 } from './png';
import { resampleRGBA, type ResampleMethod } from './resample';

export { formatInfo, type ExportFormat } from './formats';
import { formatInfo, type ExportFormat } from './formats';

export type ExportSettings = {
  format: ExportFormat;
  // 1-100 for JPEG, WebP and AVIF.
  quality: number;
  transparency: boolean;
  // zlib effort 0-9 for PNG and TIFF Deflate.
  pngLevel: number;
  tiffCompression: 'none' | 'lzw' | 'deflate';
  depth: 8 | 16;
  sizeMode: 'percent' | 'width' | 'height' | 'exact';
  scale: number;
  width: number;
  height: number;
  resample: ResampleMethod;
  // Output canvas; 0 keeps the scaled image size. The image is centered.
  canvasWidth: number;
  canvasHeight: number;
  metadata: 'none' | 'copyright' | 'all';
  embedIcc: boolean;
  convertSrgb: boolean;
  matte: string;
  gifColors: number;
  gifDither: boolean;
};
export const defaultSettings: ExportSettings = {
  format: 'png',
  quality: 85,
  transparency: true,
  pngLevel: 6,
  tiffCompression: 'lzw',
  depth: 8,
  sizeMode: 'percent',
  scale: 100,
  width: 0,
  height: 0,
  resample: 'bicubic',
  canvasWidth: 0,
  canvasHeight: 0,
  metadata: 'copyright',
  embedIcc: true,
  convertSrgb: true,
  matte: '#ffffff',
  gifColors: 256,
  gifDither: true,
};

export type DocInfo = { title?: string; author?: string; copyright?: string; description?: string; contact?: string };
export type SourceImage = { width: number; height: number; data: Uint8ClampedArray | Uint16Array };
export type ExportContext = {
  // Document working profile (null = sRGB) and its raw ICC bytes.
  profile: RgbProfile | null;
  icc?: Uint8Array;
  dpi?: number;
  info?: DocInfo;
};

/** Output pixel size for the settings, before the canvas is applied. */
export function outputSize(w: number, h: number, s: Pick<ExportSettings, 'sizeMode' | 'scale' | 'width' | 'height'>): [number, number] {
  let nw = w,
    nh = h;
  if (s.sizeMode === 'percent') {
    nw = (w * s.scale) / 100;
    nh = (h * s.scale) / 100;
  } else if (s.sizeMode === 'width' && s.width > 0) {
    nw = s.width;
    nh = (h * s.width) / w;
  } else if (s.sizeMode === 'height' && s.height > 0) {
    nh = s.height;
    nw = (w * s.height) / h;
  } else if (s.sizeMode === 'exact') {
    nw = s.width || w;
    nh = s.height || h;
  }
  // Scaled sizes keep their proportions within the 8192-pixel limit.
  const k = s.sizeMode === 'exact' ? 1 : Math.min(1, 8192 / nw, 8192 / nh);
  return [Math.max(1, Math.min(8192, Math.round(nw * k))), Math.max(1, Math.min(8192, Math.round(nh * k)))];
}
/** Largest size that fits within w × h, keeping the aspect ratio (never enlarges unless asked). */
export function fitSize(w: number, h: number, maxW: number, maxH: number, enlarge = false): [number, number] {
  let k = Math.min(maxW > 0 ? maxW / w : Infinity, maxH > 0 ? maxH / h : Infinity);
  if (!Number.isFinite(k)) k = 1;
  if (!enlarge) k = Math.min(1, k);
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

export function hexColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [n >> 16, (n >> 8) & 255, n & 255];
}

/** Composite straight RGBA over an opaque color (in place). */
export function applyMatte<T extends Uint8ClampedArray | Uint16Array>(data: T, rgb: [number, number, number]): T {
  const max = data instanceof Uint16Array ? 65535 : 255;
  const k = max / 255;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === max) continue;
    for (let c = 0; c < 3; c++) data[i + c] = Math.round((data[i + c] * a + rgb[c] * k * (max - a)) / max);
    data[i + 3] = max;
  }
  return data;
}

/** Place an image centered on a larger or smaller transparent canvas. */
export function placeOnCanvas<T extends Uint8ClampedArray | Uint16Array>(img: { width: number; height: number; data: T }, cw: number, ch: number): { width: number; height: number; data: T } {
  if (cw === img.width && ch === img.height) return img;
  const Ctor = img.data.constructor as { new (n: number): T };
  const out = new Ctor(cw * ch * 4);
  const ox = Math.round((cw - img.width) / 2),
    oy = Math.round((ch - img.height) / 2);
  for (let y = Math.max(0, -oy); y < Math.min(img.height, ch - oy); y++) {
    const x0 = Math.max(0, -ox),
      x1 = Math.min(img.width, cw - ox);
    if (x1 <= x0) continue;
    out.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x1) * 4), ((y + oy) * cw + x0 + ox) * 4);
  }
  return { width: cw, height: ch, data: out };
}

export function hasTransparency(data: Uint8ClampedArray | Uint16Array) {
  const max = data instanceof Uint16Array ? 65535 : 255;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== max) return true;
  return false;
}

/** Resample, place, convert and matte the source for the given settings. */
export function prepareExport(src: SourceImage, s: ExportSettings, ctx: ExportContext): SourceImage {
  const info = formatInfo[s.format];
  const [nw, nh] = outputSize(src.width, src.height, s);
  let data = resampleRGBA(src.data, src.width, src.height, nw, nh, s.resample);
  let img: SourceImage = { width: nw, height: nh, data };
  const cw = s.canvasWidth > 0 ? Math.min(8192, Math.round(s.canvasWidth)) : nw,
    ch = s.canvasHeight > 0 ? Math.min(8192, Math.round(s.canvasHeight)) : nh;
  img = placeOnCanvas(img, cw, ch);
  data = img.data;
  const deep = s.depth === 16 && info.deep && data instanceof Uint16Array;
  if (!deep && data instanceof Uint16Array) data = rgba16To8(data);
  else if (deep && data === src.data) data = data.slice();
  if (ctx.profile && s.convertSrgb) convertToSrgb(data, ctx.profile);
  if (!info.alpha || !s.transparency) applyMatte(data, hexColor(s.matte));
  return { width: img.width, height: img.height, data };
}

function metadataText(s: ExportSettings, info?: DocInfo): Record<string, string> {
  if (!info || s.metadata === 'none') return {};
  const out: Record<string, string> = {};
  // Keywords defined by the PNG specification (section 11.3.4.2).
  if (info.copyright) out.Copyright = info.copyright;
  if (info.author) out.Author = info.author;
  if (info.contact) out.Comment = `Contact: ${info.contact}`;
  if (s.metadata === 'all') {
    if (info.title) out.Title = info.title;
    if (info.description) out.Description = info.description;
  }
  return out;
}

// Insert JPEG COM segments (T.81 B.2.4.5) after the application segments.
export function insertJpegComments(jpeg: Uint8Array, comments: string[]): Uint8Array {
  if (!comments.length) return jpeg;
  const { segments } = readJpegSegments(jpeg);
  const at = segments.find((s, i) => i > 0 && !(s.marker >= 0xe0 && s.marker <= 0xef))?.offset ?? 2;
  const enc = new TextEncoder();
  const segs = comments.map((c) => {
    const body = enc.encode(c).subarray(0, 65533);
    const seg = new Uint8Array(body.length + 4);
    seg[0] = 0xff;
    seg[1] = 0xfe;
    seg[2] = (body.length + 2) >> 8;
    seg[3] = (body.length + 2) & 255;
    seg.set(body, 4);
    return seg;
  });
  return concatBytes([jpeg.subarray(0, at), ...segs, jpeg.subarray(at)]);
}

/** Encode browser formats (JPEG, WebP, AVIF) with an OffscreenCanvas. */
export async function canvasEncode(img: SourceImage, mime: string, quality: number): Promise<Uint8Array> {
  const data = img.data instanceof Uint16Array ? rgba16To8(img.data) : img.data;
  const canvas = new OffscreenCanvas(img.width, img.height);
  const c = canvas.getContext('2d')!;
  c.putImageData(new ImageData(new Uint8ClampedArray(data), img.width, img.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: mime, quality: Math.max(0.01, Math.min(1, quality / 100)) });
  if (blob.type !== mime) throw new Error(`This browser cannot encode ${mime.split('/')[1].toUpperCase()}.`);
  return new Uint8Array(await blob.arrayBuffer());
}

let avifSupport: Promise<boolean> | undefined;
export function canEncodeAvif() {
  return (avifSupport ??= (async () => {
    try {
      const blob = await new OffscreenCanvas(2, 2).convertToBlob({ type: 'image/avif' });
      return blob.type === 'image/avif';
    } catch {
      return false;
    }
  })());
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];

/** Encode prepared pixels. `browser` encodes JPEG/WebP/AVIF (injected so the
 * pure formats run under Node tests). */
export async function encodeExport(
  img: SourceImage,
  s: ExportSettings,
  ctx: ExportContext,
  browser: (img: SourceImage, mime: string, quality: number) => Promise<Uint8Array> = canvasEncode,
): Promise<Uint8Array> {
  const info = formatInfo[s.format];
  const toSrgb = !ctx.profile || s.convertSrgb;
  const icc = s.embedIcc && !toSrgb ? ctx.icc : undefined;
  const text = metadataText(s, ctx.info);
  const rgba8 = () => ({ width: img.width, height: img.height, data: img.data instanceof Uint16Array ? rgba16To8(img.data) : img.data });
  const alpha = s.transparency && info.alpha && hasTransparency(img.data);
  switch (s.format) {
    case 'png': {
      const chunks: NewChunk[] = [];
      if (icc) chunks.push(makeIccpChunk(icc));
      else if (s.embedIcc && toSrgb) chunks.push(makeSrgbChunk(0));
      if (ctx.dpi) chunks.push(makePhysChunk(ctx.dpi));
      for (const [k, v] of Object.entries(text)) chunks.push(makeTextChunk(k, v));
      return encodePng({ width: img.width, height: img.height, data: alpha ? img.data : stripAlpha(img.data), channels: alpha ? 4 : 3 }, { level: s.pngLevel, chunks });
    }
    case 'jpeg': {
      let out = await browser(img, 'image/jpeg', s.quality);
      if (icc) out = insertJpegIcc(out, icc);
      if (ctx.dpi) out = setJpegDensity(out, ctx.dpi);
      return insertJpegComments(out, Object.entries(text).map(([k, v]) => `${k}: ${v}`));
    }
    case 'webp':
    case 'avif':
      return browser(img, info.mime, s.quality);
    case 'gif':
      return encodeGif(rgba8(), { colors: Math.max(2, Math.min(256, s.gifColors)), dither: s.gifDither, optimize: false });
    case 'tiff':
      return encodeTiff(
        { width: img.width, height: img.height, data: alpha ? img.data : stripAlpha(img.data), channels: alpha ? 4 : 3 },
        { compression: s.tiffCompression, predictor: s.tiffCompression !== 'none', icc, dpi: ctx.dpi, level: Math.max(1, s.pngLevel) },
      );
    case 'bmp':
      return encodeBmp(rgba8(), { bits: alpha ? 32 : 24, dpi: ctx.dpi });
    case 'tga':
      return encodeTga(rgba8(), { bits: alpha ? 32 : 24, rle: true });
    case 'ico':
      return encodeIcon(rgba8(), s.resample);
    case 'svg':
      throw new Error('SVG export is layered; use exportSvg.');
  }
}

function stripAlpha<T extends Uint8ClampedArray | Uint16Array>(data: T): T {
  const Ctor = data.constructor as { new (n: number): T };
  const out = new Ctor((data.length / 4) * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    out[j] = data[i];
    out[j + 1] = data[i + 1];
    out[j + 2] = data[i + 2];
  }
  return out;
}

/** Multi-resolution icon: every standard size up to the image (max 256),
 * fitted into squares; 256 px uses a PNG entry as Windows Vista+ expects. */
export function encodeIcon(img: { width: number; height: number; data: Uint8ClampedArray }, method: ResampleMethod = 'bicubic'): Uint8Array {
  const side = Math.max(img.width, img.height);
  const square = placeOnCanvas(img, side, side);
  const sizes = icoSizes.filter((n) => n <= side);
  if (!sizes.length) sizes.push(Math.max(1, side));
  const entries: IcoEncodeEntry[] = sizes.reverse().map((n) => {
    const data = resampleRGBA(square.data, side, side, n, n, method);
    return n >= 256
      ? { png: encodePng({ width: n, height: n, data, channels: 4 }, { level: 9 }) }
      : { rgba: { width: n, height: n, data } };
  });
  return encodeIco(entries);
}

export function exportFileName(base: string, format: ExportFormat) {
  return `${base.replace(/[\\/:*?"<>|]+/g, '_') || 'Untitled'}.${formatInfo[format].ext}`;
}
