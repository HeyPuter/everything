// OpenEXR writer (scanline images): scene-linear float passes as half or full floats, without
// compression or with zlib (one or sixteen scanlines per block). Multilayer files name their
// channels "<layer>.<pass>.<channel>". Written from the public file format description.
import { zlibSync } from 'three/examples/jsm/libs/fflate.module.js';

export type ExrCompression = 'NONE' | 'ZIPS' | 'ZIP';

export interface ExrChannel {
  name: string;
  /** w×h values, rows top-down */
  data: Float32Array;
}

const COMPRESSION_CODE: Record<ExrCompression, number> = { NONE: 0, ZIPS: 2, ZIP: 3 };
const LINES_PER_BLOCK: Record<ExrCompression, number> = { NONE: 1, ZIPS: 1, ZIP: 16 };

/** IEEE half from a float (round to nearest, with infinities and NaN). */
export function toHalf(v: number): number {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  f[0] = v;
  const x = u[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >> shift;
    if ((mant >> (shift - 1)) & 1) h++;
    return sign | h;
  }
  let h = sign | (e << 10) | (mant >> 13);
  if (mant & 0x1000) h++; // round (may carry into the exponent, which is still correct)
  return h & 0xffff;
}

class Writer {
  private bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  i32(v: number) {
    for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i));
  }
  f32(v: number) {
    const b = new Uint8Array(new Float32Array([v]).buffer);
    for (const x of b) this.u8(x);
  }
  str(s: string) {
    for (const c of s) this.u8(c.charCodeAt(0));
    this.u8(0);
  }
  attr(name: string, type: string, payload: (w: Writer) => void) {
    const inner = new Writer();
    payload(inner);
    this.str(name);
    this.str(type);
    this.i32(inner.bytes.length);
    for (const b of inner.bytes) this.u8(b);
  }
  get length() {
    return this.bytes.length;
  }
  out(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** Reorder and delta-encode a block as the ZIP codecs expect before deflating. */
function zipPredict(raw: Uint8Array): Uint8Array {
  const n = raw.length;
  const t = new Uint8Array(n);
  // even bytes first, then odd bytes
  let a = 0,
    b = (n + 1) >> 1;
  for (let i = 0; i < n; i++) {
    if (i & 1) t[b++] = raw[i];
    else t[a++] = raw[i];
  }
  // difference to the previous byte
  let p = t[0];
  for (let i = 1; i < n; i++) {
    const d = (t[i] - p + 128 + 256) & 0xff;
    p = t[i];
    t[i] = d;
  }
  return t;
}

/**
 * Encode channels into an OpenEXR file. Channels are stored sorted by name, as the format
 * requires; `half` stores 16-bit floats.
 */
export function writeExr(channels: ExrChannel[], w: number, h: number, opts: { half?: boolean; compression?: ExrCompression; pixelAspect?: number } = {}): Uint8Array {
  const half = opts.half !== false;
  const comp = opts.compression ?? 'ZIP';
  const chans = [...channels].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const size = half ? 2 : 4;
  const longNames = chans.some((c) => c.name.length > 31);
  const head = new Writer();
  // magic number and version (with the long names flag when needed)
  head.i32(20000630);
  head.i32(2 | (longNames ? 0x400 : 0));
  head.attr('channels', 'chlist', (a) => {
    for (const c of chans) {
      a.str(c.name);
      a.i32(half ? 1 : 2);
      a.u8(0);
      a.u8(0);
      a.u8(0);
      a.u8(0);
      a.i32(1);
      a.i32(1);
    }
    a.u8(0);
  });
  head.attr('compression', 'compression', (a) => a.u8(COMPRESSION_CODE[comp]));
  const box = (a: Writer) => {
    a.i32(0);
    a.i32(0);
    a.i32(w - 1);
    a.i32(h - 1);
  };
  head.attr('dataWindow', 'box2i', box);
  head.attr('displayWindow', 'box2i', box);
  head.attr('lineOrder', 'lineOrder', (a) => a.u8(0));
  head.attr('pixelAspectRatio', 'float', (a) => a.f32(opts.pixelAspect ?? 1));
  head.attr('screenWindowCenter', 'v2f', (a) => {
    a.f32(0);
    a.f32(0);
  });
  head.attr('screenWindowWidth', 'float', (a) => a.f32(1));
  head.u8(0);
  const header = head.out();
  // scanline blocks
  const per = LINES_PER_BLOCK[comp];
  const nBlocks = Math.ceil(h / per);
  const blocks: Uint8Array[] = [];
  for (let k = 0; k < nBlocks; k++) {
    const y0 = k * per,
      y1 = Math.min(h, y0 + per);
    const raw = new Uint8Array((y1 - y0) * chans.length * w * size);
    const dv = new DataView(raw.buffer);
    let o = 0;
    for (let y = y0; y < y1; y++)
      for (const c of chans) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const v = c.data[row + x];
          if (half) {
            dv.setUint16(o, toHalf(v), true);
            o += 2;
          } else {
            dv.setFloat32(o, v, true);
            o += 4;
          }
        }
      }
    let data = raw;
    if (comp !== 'NONE') {
      const z = zlibSync(zipPredict(raw));
      // a block that does not shrink is stored as it is
      if (z.length < raw.length) data = z;
    }
    const b = new Uint8Array(8 + data.length);
    const bv = new DataView(b.buffer);
    bv.setInt32(0, y0, true);
    bv.setInt32(4, data.length, true);
    b.set(data, 8);
    blocks.push(b);
  }
  const tableSize = nBlocks * 8;
  let total = header.length + tableSize;
  for (const b of blocks) total += b.length;
  const out = new Uint8Array(total);
  out.set(header, 0);
  const ov = new DataView(out.buffer);
  let pos = header.length + tableSize;
  blocks.forEach((b, k) => {
    ov.setBigUint64(header.length + k * 8, BigInt(pos), true);
    out.set(b, pos);
    pos += b.length;
  });
  return out;
}

/** Split interleaved RGBA (or n-channel) pixels into named planes. */
export function planes(data: Float32Array, n: number, names: string[], prefix = ''): ExrChannel[] {
  const count = data.length / n;
  return names.map((name, c) => {
    const p = new Float32Array(count);
    for (let i = 0; i < count; i++) p[i] = data[i * n + c];
    return { name: prefix + name, data: p };
  });
}
