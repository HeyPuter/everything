// GIF87a/GIF89a reader and writer from the GIF89a specification (CompuServe
// 1990) plus the NETSCAPE2.0 looping extension.
import { checkCancelled, type Progress, type RGBA8 } from '../types';
import { ByteWriter, CodecError, checkSize, rethrowAsCodecError, asciiAt, type SizeLimits } from './bytes';
import { lzwDecode, lzwEncode } from './lzw';
import { buildPalette, mapToPalette, type Quantizer } from './quantize';

export type GifDisposal = 0 | 1 | 2 | 3;
export type GifFrame = {
  // The full logical screen after this frame was drawn.
  rgba: RGBA8;
  // Raw delay (hundredths of a second × 10). Browsers show 0-10 ms as 100 ms.
  delayMs: number;
  disposal: GifDisposal;
  rect: { x: number; y: number; width: number; height: number };
  transparentIndex?: number;
  interlaced: boolean;
  localPalette: boolean;
};
export type GifDecodeResult = {
  width: number;
  height: number;
  frames: GifFrame[];
  // NETSCAPE2.0 repeat count: 0 = forever, N = N extra plays after the
  // first; undefined = no looping extension (play once).
  loopCount?: number;
  backgroundColor?: [number, number, number];
  comments: string[];
};

export function decodeGif(bytes: Uint8Array, opts: { maxFrames?: number; limits?: SizeLimits } = {}): GifDecodeResult {
  try {
    return decodeGifImpl(bytes, opts);
  } catch (e) {
    rethrowAsCodecError(e, 'GIF');
  }
}
function decodeGifImpl(bytes: Uint8Array, opts: { maxFrames?: number; limits?: SizeLimits } = {}): GifDecodeResult {
  const sig = asciiAt(bytes, 0, 6);
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new CodecError('Not a GIF file.');
  const u16 = (o: number) => bytes[o] | (bytes[o + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  if (!width || !height) throw new CodecError('GIF has no dimensions.');
  checkSize(width, height, opts.limits);
  const packed = bytes[10];
  let p = 13;
  let globalPalette: Uint8Array | null = null;
  if (packed & 0x80) {
    const n = 2 << (packed & 7);
    globalPalette = bytes.subarray(p, p + n * 3);
    p += n * 3;
  }
  const res: GifDecodeResult = { width, height, frames: [], comments: [] };
  if (globalPalette && bytes[11] * 3 + 2 < globalPalette.length) {
    const b = bytes[11] * 3;
    res.backgroundColor = [globalPalette[b], globalPalette[b + 1], globalPalette[b + 2]];
  }
  const canvas = new Uint8ClampedArray(width * height * 4);
  let saved: Uint8ClampedArray | null = null;
  let gce = { delay: 0, disposal: 0 as GifDisposal, transparent: -1 };
  let prev: GifFrame | null = null;
  const maxFrames = opts.maxFrames ?? Infinity;

  const readSubBlocks = (): Uint8Array => {
    let q = p;
    let total = 0;
    while (q < bytes.length && bytes[q]) {
      total += bytes[q];
      q += bytes[q] + 1;
    }
    const out = new Uint8Array(total);
    let o = 0;
    while (p < bytes.length && bytes[p]) {
      const n = bytes[p];
      out.set(bytes.subarray(p + 1, Math.min(bytes.length, p + 1 + n)), o);
      o += n;
      p += n + 1;
    }
    p++;
    return out;
  };

  while (p < bytes.length && res.frames.length < maxFrames) {
    const block = bytes[p++];
    if (block === 0x3b) break;
    if (block === 0) continue; // stray padding some encoders leave between blocks
    if (block === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9 && bytes[p] >= 4) {
        const f = bytes[p + 1];
        gce = { delay: u16(p + 2), disposal: ((f >> 2) & 7) as GifDisposal, transparent: f & 1 ? bytes[p + 4] : -1 };
        if (gce.disposal > 3) gce.disposal = 0;
        p += bytes[p] + 1;
        readSubBlocks();
      } else if (label === 0xff) {
        const app = asciiAt(bytes, p + 1, 11);
        p += bytes[p] + 1;
        const data = readSubBlocks();
        if ((app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') && data[0] === 1 && data.length >= 3) res.loopCount = data[1] | (data[2] << 8);
      } else if (label === 0xfe) {
        res.comments.push(asciiAt(readSubBlocks(), 0, 1 << 20));
      } else readSubBlocks();
      continue;
    }
    if (block !== 0x2c) break; // unknown block: stop like browsers do
    const fx = u16(p);
    const fy = u16(p + 2);
    const fw = u16(p + 4);
    const fh = u16(p + 6);
    const fp = bytes[p + 8];
    p += 9;
    let palette = globalPalette;
    const local = !!(fp & 0x80);
    if (local) {
      const n = 2 << (fp & 7);
      palette = bytes.subarray(p, p + n * 3);
      p += n * 3;
    }
    const interlaced = !!(fp & 0x40);
    const minCode = bytes[p++];
    const lzwData = readSubBlocks();

    // Dispose of the previous frame before drawing this one.
    if (prev) {
      if (prev.disposal === 2) {
        const r = prev.rect;
        for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.height); y++)
          canvas.fill(0, (y * width + Math.max(0, r.x)) * 4, (y * width + Math.min(width, r.x + r.width)) * 4);
      } else if (prev.disposal === 3 && saved) canvas.set(saved);
    }
    if (gce.disposal === 3) saved = canvas.slice();

    const indices = new Uint8Array(fw * fh);
    const decoded = minCode >= 1 && minCode <= 11 ? lzwDecode(lzwData, indices, 'gif', minCode) : 0;
    if (palette) {
      const nColors = palette.length / 3;
      const rowMap = interlaced ? interlaceRows(fh) : null;
      for (let row = 0; row < fh; row++) {
        const y = fy + (rowMap ? rowMap[row] : row);
        if (y >= height) continue;
        for (let x = 0; x < fw; x++) {
          const i = row * fw + x;
          if (i >= decoded) break;
          const cx = fx + x;
          if (cx >= width) break;
          const idx = indices[i];
          if (idx === gce.transparent || idx >= nColors) continue;
          const o = (y * width + cx) * 4;
          canvas[o] = palette[idx * 3];
          canvas[o + 1] = palette[idx * 3 + 1];
          canvas[o + 2] = palette[idx * 3 + 2];
          canvas[o + 3] = 255;
        }
      }
    }
    const frame: GifFrame = {
      rgba: { width, height, data: canvas.slice() },
      delayMs: gce.delay * 10,
      disposal: gce.disposal,
      rect: { x: fx, y: fy, width: fw, height: fh },
      interlaced,
      localPalette: local,
    };
    if (gce.transparent >= 0) frame.transparentIndex = gce.transparent;
    res.frames.push(frame);
    prev = frame;
    gce = { delay: 0, disposal: 0, transparent: -1 };
  }
  if (!res.frames.length) throw new CodecError('The GIF contains no images.');
  return res;
}

// Row order of an interlaced image: passes start at 0, 4, 2, 1 with steps 8, 8, 4, 2.
function interlaceRows(h: number): Int32Array {
  const map = new Int32Array(h);
  let n = 0;
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ])
    for (let y = start; y < h; y += step) map[n++] = y;
  return map;
}

export type GifEncodeFrame = { rgba: RGBA8; delayMs?: number };
export type GifEncodeOptions = {
  quantizer?: Quantizer;
  // Palette size 2-256 including the transparent entry.
  colors?: number;
  dither?: boolean;
  // Pixels with alpha below this become transparent (default 128).
  alphaThreshold?: number;
  // NETSCAPE2.0 repeat count for animations: 0 = forever (default), N = N
  // extra plays after the first, -1 = no looping extension (play once).
  loop?: number;
  // One palette for all frames (default) or one per frame.
  palette?: 'global' | 'local';
  // Crop frames to the changed area (default true).
  optimize?: boolean;
  interlace?: boolean;
  // NeuQuant sampling factor.
  sampleFactor?: number;
  // Reported per frame; cancellation throws CancelledError.
  progress?: Progress;
};

export function encodeGif(input: RGBA8 | GifEncodeFrame[], opts: GifEncodeOptions = {}): Uint8Array {
  const frames: GifEncodeFrame[] = Array.isArray(input) ? input : [{ rgba: input }];
  if (!frames.length) throw new CodecError('No frames to encode.');
  const { width, height } = frames[0].rgba;
  if (!width || !height || width > 65535 || height > 65535) throw new CodecError('GIF dimensions must be 1-65535.');
  for (const f of frames) if (f.rgba.width !== width || f.rgba.height !== height) throw new CodecError('All GIF frames must have the same size.');
  const threshold = opts.alphaThreshold ?? 128;
  const maxColors = Math.max(2, Math.min(256, opts.colors ?? 256));
  const animated = frames.length > 1;
  const optimize = opts.optimize ?? true;
  const hasTransparency = frames.map((f) => {
    const d = f.rgba.data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < threshold) return true;
    return false;
  });
  const anyTransparency = hasTransparency.some(Boolean);
  const local = opts.palette === 'local' && animated;
  const makePalette = (imgs: RGBA8[], transparent: boolean) => {
    const colors = buildPalette(imgs, { method: opts.quantizer, maxColors: transparent ? maxColors - 1 : maxColors, alphaThreshold: threshold, sampleFactor: opts.sampleFactor });
    const n = colors.length / 3;
    const tIndex = transparent ? n : -1;
    const size = tableSize(n + (transparent ? 1 : 0));
    const table = new Uint8Array(size * 3);
    table.set(colors);
    return { colors, table, tIndex, size };
  };
  const global = local ? null : makePalette(frames.map((f) => f.rgba), anyTransparency);

  const w = new ByteWriter(width * height + 1024);
  w.ascii('GIF89a');
  w.u16le(width);
  w.u16le(height);
  if (global) {
    w.u8(0xf0 | (Math.log2(global.size) - 1));
    w.u8(global.tIndex >= 0 ? global.tIndex : 0);
    w.u8(0);
    w.bytes(global.table);
  } else {
    w.u8(0x70);
    w.u8(0);
    w.u8(0);
  }
  if (animated && (opts.loop ?? 0) >= 0) {
    w.u8(0x21);
    w.u8(0xff);
    w.u8(11);
    w.ascii('NETSCAPE2.0');
    w.u8(3);
    w.u8(1);
    w.u16le(Math.min(65535, opts.loop ?? 0));
    w.u8(0);
  }
  let prevSrc: Uint8ClampedArray | null = null;
  for (let fi = 0; fi < frames.length; fi++) {
    if (opts.progress) {
      checkCancelled(opts.progress);
      opts.progress.report?.(fi / frames.length);
    }
    const f = frames[fi];
    const pal = global ?? makePalette([f.rgba], hasTransparency[fi]);
    const indices = mapToPalette(f.rgba, pal.colors, { dither: opts.dither, alphaThreshold: threshold, transparentIndex: Math.max(0, pal.tIndex) });
    // With transparency every frame is cleared after display (disposal 2), so
    // the canvas starts transparent and frames may be cropped to their opaque
    // pixels; otherwise frames are kept (disposal 1) and cropped to changes.
    const disposal = animated ? (anyTransparency ? 2 : 1) : 0;
    let rect = { x: 0, y: 0, width, height };
    if (animated && optimize) {
      rect = anyTransparency ? opaqueBounds(f.rgba.data, width, height, threshold) : prevSrc ? changedBounds(prevSrc, f.rgba.data, width, height) : rect;
    }
    prevSrc = f.rgba.data;
    const cs = Math.round((f.delayMs ?? (animated ? 100 : 0)) / 10);
    if (animated || pal.tIndex >= 0) {
      w.u8(0x21);
      w.u8(0xf9);
      w.u8(4);
      w.u8((disposal << 2) | (pal.tIndex >= 0 ? 1 : 0));
      w.u16le(Math.min(65535, cs));
      w.u8(Math.max(0, pal.tIndex));
      w.u8(0);
    }
    w.u8(0x2c);
    w.u16le(rect.x);
    w.u16le(rect.y);
    w.u16le(rect.width);
    w.u16le(rect.height);
    const interlace = !!opts.interlace;
    w.u8((global ? 0 : 0x80 | (Math.log2(pal.size) - 1)) | (interlace ? 0x40 : 0));
    if (!global) w.bytes(pal.table);
    let sub = indices;
    if (rect.width !== width || rect.height !== height || interlace) {
      sub = new Uint8Array(rect.width * rect.height);
      const rows = interlace ? interlaceRows(rect.height) : null;
      for (let r = 0; r < rect.height; r++) {
        const y = rect.y + (rows ? rows[r] : r);
        sub.set(indices.subarray(y * width + rect.x, y * width + rect.x + rect.width), r * rect.width);
      }
    }
    const minCode = Math.max(2, Math.log2(pal.size));
    w.u8(minCode);
    const data = lzwEncode(sub, 'gif', minCode);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      w.u8(n);
      w.bytes(data.subarray(i, i + n));
    }
    w.u8(0);
  }
  w.u8(0x3b);
  return w.result();
}

function tableSize(n: number): number {
  let s = 2;
  while (s < n) s <<= 1;
  return s;
}

function opaqueBounds(d: Uint8ClampedArray, width: number, height: number, threshold: number) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0, o = y * width * 4 + 3; x < width; x++, o += 4)
      if (d[o] >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  if (x1 < 0) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function changedBounds(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, height: number) {
  const view = (d: Uint8ClampedArray) => (d.byteOffset & 3 ? new Uint32Array(d.slice().buffer, 0, width * height) : new Uint32Array(d.buffer, d.byteOffset, width * height));
  const ua = view(a);
  const ub = view(b);
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0, i = y * width; x < width; x++, i++)
      if (ua[i] !== ub[i]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  if (x1 < 0) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
