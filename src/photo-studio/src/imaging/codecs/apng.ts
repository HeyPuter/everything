// Animated PNG writer and reader from the APNG specification (Mozilla, 2008;
// now part of the W3C PNG third edition): acTL announces the animation, each
// frame has an fcTL control chunk, the first frame's pixels are the IDAT
// default image and later frames are fdAT chunks (a sequence number followed
// by zlib data, exactly like IDAT).
import { deflate, inflate } from 'pako';
import { inflateLimited } from './inflate';
import { checkCancelled, rgba8, type Progress, type RGBA8 } from '../types';
import { CodecError, frameBudgetBytes, rethrowAsCodecError } from './bytes';
import { buildPng, readPngChunks, type NewChunk } from './png-chunks';

export type ApngEncodeFrame = { rgba: RGBA8; delayMs: number };
export type ApngEncodeOptions = {
  // Number of plays; 0 repeats forever.
  plays?: number;
  // zlib effort 0-9.
  level?: number;
  // Crop frames after the first to the rectangle that changed (default true).
  optimize?: boolean;
  progress?: Progress;
};
type Rect = { x: number; y: number; width: number; height: number };

const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = (v: number) => [(v >>> 8) & 255, v & 255];

export function encodeApng(frames: ApngEncodeFrame[], opts: ApngEncodeOptions = {}): Uint8Array {
  if (!frames.length) throw new CodecError('No frames to encode.');
  const writer = new ApngWriter(opts);
  for (let i = 0; i < frames.length; i++) {
    if (opts.progress) {
      checkCancelled(opts.progress);
      opts.progress.report?.(i / frames.length);
    }
    writer.add(frames[i]);
  }
  return writer.finish();
}

/** An APNG encoded one frame at a time, so a long animation never needs all
 * its frames in memory: only the previous frame and the compressed data are
 * kept. The file is the same as `encodeApng` writes. */
export class ApngWriter {
  private width = 0;
  private height = 0;
  private previous?: RGBA8;
  // Opaque animations are stored as RGB, saving a quarter of the samples.
  private opaque = true;
  private frames: { rect: Rect; delayMs: number; z: Uint8Array }[] = [];
  private level: 0;
  constructor(private opts: Omit<ApngEncodeOptions, 'progress'> = {}) {
    this.level = Math.max(0, Math.min(9, opts.level ?? 6)) as 0;
  }
  add({ rgba: cur, delayMs }: ApngEncodeFrame) {
    if (!this.previous) {
      if (!cur.width || !cur.height) throw new CodecError('APNG frames need a size.');
      this.width = cur.width;
      this.height = cur.height;
    } else if (cur.width !== this.width || cur.height !== this.height)
      throw new CodecError('All APNG frames must have the same size.');
    if (this.opaque && !isOpaque(cur)) {
      // Frames stored as RGB so far are stored again with alpha.
      this.opaque = false;
      for (const f of this.frames) {
        const stride = f.rect.width * 3;
        const raw = inflate(f.z);
        unfilter(raw, stride, f.rect.height, 3);
        const img = rgba8(f.rect.width, f.rect.height);
        for (let y = 0, q = 0; y < f.rect.height; y++)
          for (let x = 0, o = y * (stride + 1) + 1; x < f.rect.width; x++, o += 3, q += 4) {
            img.data[q] = raw[o];
            img.data[q + 1] = raw[o + 1];
            img.data[q + 2] = raw[o + 2];
            img.data[q + 3] = 255;
          }
        f.z = deflate(filterRows(img, { x: 0, y: 0, width: img.width, height: img.height }, 4), {
          level: this.level,
        });
      }
    }
    const full = { x: 0, y: 0, width: this.width, height: this.height };
    const rect =
      this.previous && this.opts.optimize !== false ? changedRect(this.previous, cur) : full;
    const z = deflate(filterRows(cur, rect, this.opaque ? 3 : 4), { level: this.level });
    this.frames.push({ rect, delayMs, z });
    this.previous = cur;
  }
  finish(): Uint8Array {
    if (!this.frames.length) throw new CodecError('No frames to encode.');
    const ihdr = new Uint8Array([
      ...u32(this.width),
      ...u32(this.height),
      8,
      this.opaque ? 2 : 6,
      0,
      0,
      0,
    ]);
    const plays = Math.max(0, Math.min(0x7fffffff, this.opts.plays ?? 0));
    const chunks: NewChunk[] = [
      { type: 'IHDR', data: ihdr },
      { type: 'acTL', data: new Uint8Array([...u32(this.frames.length), ...u32(plays)]) },
    ];
    let seq = 0;
    for (const [i, { rect, delayMs, z }] of this.frames.entries()) {
      const [num, den] = apngDelay(delayMs);
      // Frames replace their rectangle (blend SOURCE) and stay for the next one
      // (dispose NONE), so a rectangle covering every change is exact.
      chunks.push({
        type: 'fcTL',
        data: new Uint8Array([
          ...u32(seq++),
          ...u32(rect.width),
          ...u32(rect.height),
          ...u32(rect.x),
          ...u32(rect.y),
          ...u16(num),
          ...u16(den),
          0,
          0,
        ]),
      });
      if (i === 0) chunks.push({ type: 'IDAT', data: z });
      else {
        const data = new Uint8Array(4 + z.length);
        data.set(u32(seq++));
        data.set(z, 4);
        chunks.push({ type: 'fdAT', data });
      }
    }
    chunks.push({ type: 'IEND', data: new Uint8Array() });
    return buildPng(chunks);
  }
}
function isOpaque(img: RGBA8) {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false;
  return true;
}

/** Delay as a fraction: milliseconds when they fit 16 bits, else hundredths. */
function apngDelay(ms: number): [number, number] {
  const v = Math.max(0, Math.round(ms));
  return v <= 0xffff ? [v, 1000] : [Math.min(0xffff, Math.round(v / 10)), 100];
}

// Pixels as 32-bit words, without a copy when the bytes are aligned.
const words = (d: RGBA8['data']) =>
  d.byteOffset % 4
    ? new Uint32Array(d.slice().buffer)
    : new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
function changedRect(a: RGBA8, b: RGBA8): Rect {
  const { width, height } = b;
  const ua = words(a.data),
    ub = words(b.data);
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0, i = y * width; x < width; x++, i++)
      if (ua[i] !== ub[i]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  // An unchanged frame still needs a (1×1) image.
  if (x1 < 0) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Filtered scanlines of a rectangle, choosing each row's filter by the
 * minimum sum of absolute residuals (PNG specification, section 12.8). */
function filterRows(img: RGBA8, r: Rect, channels: 3 | 4): Uint8Array {
  const stride = r.width * channels;
  const out = new Uint8Array((stride + 1) * r.height);
  let prev = new Uint8Array(stride),
    cur = new Uint8Array(stride);
  const tmp = new Uint8Array(stride);
  const bpp = channels;
  for (let y = 0; y < r.height; y++) {
    const src = ((r.y + y) * img.width + r.x) * 4;
    if (channels === 4) cur.set(img.data.subarray(src, src + r.width * 4));
    else for (let x = 0; x < r.width; x++) cur.set(img.data.subarray(src + x * 4, src + x * 4 + 3), x * 3);
    const row = out.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    let best = 0,
      bestSum = 0;
    for (let i = 0; i < stride; i++) bestSum += cur[i] < 128 ? cur[i] : 256 - cur[i];
    row.set(cur);
    for (let f = 1; f < 5; f++) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0,
          b = prev[i],
          c = i >= bpp ? prev[i - bpp] : 0;
        tmp[i] = (cur[i] - (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c))) & 255;
      }
      let sum = 0;
      for (let i = 0; i < stride; i++) sum += tmp[i] < 128 ? tmp[i] : 256 - tmp[i];
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
        row.set(tmp);
      }
    }
    out[y * (stride + 1)] = best;
    [prev, cur] = [cur, prev];
  }
  return out;
}

// ----- Reading -----

export type ApngFrame = {
  // The full canvas after this frame was drawn.
  rgba: RGBA8;
  delayMs: number;
  rect: Rect;
  dispose: 0 | 1 | 2;
  blend: 0 | 1;
};
// `truncated`: frames were left out because they exceed the memory budget.
export type ApngDecodeResult = { width: number; height: number; plays: number; frames: ApngFrame[]; truncated?: boolean };

/** True when a PNG file carries an animation control chunk before its image data. */
export function isApng(bytes: Uint8Array) {
  try {
    for (const c of readPngChunks(bytes)) {
      if (c.type === 'acTL') return true;
      if (c.type === 'IDAT') return false;
    }
  } catch {
    /* Not a readable PNG. */
  }
  return false;
}

/** Decode every frame of an APNG (8-bit, non-interlaced; all color types). */
export function decodeApng(bytes: Uint8Array, opts: { maxFrames?: number; maxBytes?: number } = {}): ApngDecodeResult {
  try {
    return decodeApngImpl(bytes, opts.maxFrames ?? Infinity, opts.maxBytes ?? frameBudgetBytes);
  } catch (e) {
    rethrowAsCodecError(e, 'APNG');
  }
}
function decodeApngImpl(bytes: Uint8Array, maxFrames: number, maxBytes: number): ApngDecodeResult {
  const chunks = readPngChunks(bytes);
  const ihdr = chunks.find((c) => c.type === 'IHDR')?.data;
  const actl = chunks.find((c) => c.type === 'acTL')?.data;
  if (!ihdr || ihdr.length < 13) throw new CodecError('PNG has no IHDR chunk.');
  if (!actl || actl.length < 8) throw new CodecError('Not an animated PNG.');
  const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
  const width = dv(ihdr).getUint32(0),
    height = dv(ihdr).getUint32(4);
  const depth = ihdr[8],
    colorType = ihdr[9];
  if (depth !== 8 || ihdr[12] !== 0 || ![0, 2, 3, 4, 6].includes(colorType)) throw new CodecError('Only 8-bit, non-interlaced animated PNGs are supported.');
  if (!width || !height || width * height > 24_000_000) throw new CodecError('Unsupported APNG dimensions.');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]!;
  const plte = chunks.find((c) => c.type === 'PLTE')?.data;
  const trns = chunks.find((c) => c.type === 'tRNS')?.data;
  if (colorType === 3 && !plte) throw new CodecError('Indexed PNG without a palette.');
  // tRNS for gray and RGB images names one transparent color (16-bit fields).
  const key =
    trns && colorType === 2 && trns.length >= 6 ? [dv(trns).getUint16(0), dv(trns).getUint16(2), dv(trns).getUint16(4)] : trns && colorType === 0 && trns.length >= 2 ? [dv(trns).getUint16(0)] : undefined;
  const plays = dv(actl).getUint32(4);

  type Pending = { ctl: Uint8Array; data: Uint8Array[] };
  const pending: Pending[] = [];
  let seenIdat = false;
  for (const c of chunks) {
    if (c.type === 'fcTL') pending.push({ ctl: c.data, data: [] });
    else if (c.type === 'IDAT') {
      // An IDAT before any fcTL is a default image that is not part of the animation.
      if (pending.length) pending.at(-1)!.data.push(c.data);
      seenIdat = true;
    } else if (c.type === 'fdAT' && seenIdat && pending.length) pending.at(-1)!.data.push(c.data.subarray(4));
  }
  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames: ApngFrame[] = [];
  let prevDispose: { rect: Rect; dispose: number; saved?: Uint8ClampedArray } | undefined;
  let truncated = false;
  for (const p of pending.slice(0, maxFrames)) {
    if (frames.length && (frames.length + 1) * canvas.length > maxBytes) {
      truncated = true;
      break;
    }
    const d = dv(p.ctl);
    if (p.ctl.length < 26) throw new CodecError('Damaged frame control chunk.');
    const rect = { width: d.getUint32(4), height: d.getUint32(8), x: d.getUint32(12), y: d.getUint32(16) };
    if (!rect.width || !rect.height || rect.x + rect.width > width || rect.y + rect.height > height) throw new CodecError('Frame lies outside the image.');
    const num = d.getUint16(20),
      den = d.getUint16(22) || 100;
    const dispose = (p.ctl[24] > 2 ? 0 : p.ctl[24]) as 0 | 1 | 2;
    const blend = (p.ctl[25] ? 1 : 0) as 0 | 1;
    if (prevDispose) {
      const r = prevDispose.rect;
      if (prevDispose.dispose === 1) for (let y = r.y; y < r.y + r.height; y++) canvas.fill(0, (y * width + r.x) * 4, (y * width + r.x + r.width) * 4);
      else if (prevDispose.dispose === 2 && prevDispose.saved) canvas.set(prevDispose.saved);
    }
    const saved = dispose === 2 && frames.length ? canvas.slice() : undefined;
    const total = p.data.reduce((n, a) => n + a.length, 0);
    const z = new Uint8Array(total);
    let o = 0;
    for (const a of p.data) {
      z.set(a, o);
      o += a.length;
    }
    const stride = rect.width * channels;
    const raw = inflateLimited(z, (stride + 1) * rect.height);
    if (!raw || raw.length < (stride + 1) * rect.height) throw new CodecError('Frame data is too short.');
    unfilter(raw, stride, rect.height, channels);
    for (let y = 0; y < rect.height; y++) {
      const row = raw.subarray(y * (stride + 1) + 1);
      for (let x = 0; x < rect.width; x++) {
        let r: number, g: number, b: number, a: number;
        const s = x * channels;
        if (colorType === 6) {
          r = row[s];
          g = row[s + 1];
          b = row[s + 2];
          a = row[s + 3];
        } else if (colorType === 2) {
          r = row[s];
          g = row[s + 1];
          b = row[s + 2];
          a = key && key[0] === r && key[1] === g && key[2] === b ? 0 : 255;
        } else if (colorType === 3) {
          const i = row[s];
          r = plte![i * 3] ?? 0;
          g = plte![i * 3 + 1] ?? 0;
          b = plte![i * 3 + 2] ?? 0;
          a = trns && i < trns.length ? trns[i] : 255;
        } else if (colorType === 4) {
          r = g = b = row[s];
          a = row[s + 1];
        } else {
          r = g = b = row[s];
          a = key && key[0] === r ? 0 : 255;
        }
        const q = ((rect.y + y) * width + rect.x + x) * 4;
        if (blend === 0 || a === 255) {
          canvas[q] = r;
          canvas[q + 1] = g;
          canvas[q + 2] = b;
          canvas[q + 3] = a;
        } else if (a) {
          // Source-over in straight alpha.
          const da = canvas[q + 3] / 255,
            sa = a / 255,
            oa = sa + da * (1 - sa);
          canvas[q] = (r * sa + canvas[q] * da * (1 - sa)) / oa;
          canvas[q + 1] = (g * sa + canvas[q + 1] * da * (1 - sa)) / oa;
          canvas[q + 2] = (b * sa + canvas[q + 2] * da * (1 - sa)) / oa;
          canvas[q + 3] = oa * 255;
        }
      }
    }
    frames.push({ rgba: { width, height, data: canvas.slice() }, delayMs: Math.round((num * 1000) / den), rect, dispose, blend });
    prevDispose = { rect, dispose: dispose === 2 && frames.length === 1 ? 1 : dispose, saved };
  }
  if (!frames.length) throw new CodecError('The animated PNG contains no frames.');
  return { width, height, plays, frames, ...(truncated ? { truncated } : {}) };
}

function unfilter(raw: Uint8Array, stride: number, rows: number, bpp: number) {
  for (let y = 0; y < rows; y++) {
    const o = y * (stride + 1);
    const f = raw[o];
    const row = raw.subarray(o + 1, o + 1 + stride);
    const prev = y ? raw.subarray(o - stride, o) : new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0,
        b = prev[i],
        c = i >= bpp ? prev[i - bpp] : 0;
      const p = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0;
      row[i] = (row[i] + p) & 255;
    }
  }
}
