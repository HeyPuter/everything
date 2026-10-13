import { describe, it, expect } from 'vitest';
import { deflateSync, deflateRawSync, gzipSync, inflateSync } from 'node:zlib';
import { createHash, createCipheriv } from 'node:crypto';
import { inflate, inflateRaw, gunzipSync, adler32, crc32, zlibStored } from '../src/features/interop/codec/zlib.js';
import { encodePNG, encodePNGSync } from '../src/features/interop/codec/png.js';
import { decodeTIFF, encodeTIFF, lzwEncode, isTIFF } from '../src/features/interop/codec/tiff.js';
import { decodeBMP } from '../src/features/interop/codec/bmp.js';
import { decodePSD } from '../src/features/interop/codec/psd.js';
import { rasterKind, rasterToPNG } from '../src/features/interop/codec/raster.js';
import { lzw, ascii85, unpredict } from '../src/features/interop/pdf/filters.js';
import { md5, sha256, sha512, aesCbcDecrypt } from '../src/features/interop/pdf/crypto.js';
import { ascii85 as encode85 } from '../src/features/interop/ps/eps-export.js';
import { PDFDict } from '../src/features/interop/pdf/primitives.js';

const sample = (n, seed = 1) => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = i % 7 === 0 ? s & 255 : (i * 13) & 255;
  }
  return out;
};

describe('zlib', () => {
  it('inflates what node compresses (raw, zlib, gzip, every level)', () => {
    for (const n of [0, 1, 100, 70000]) {
      const data = sample(n, n + 3);
      for (const level of [0, 1, 6, 9]) {
        expect(Array.from(inflate(new Uint8Array(deflateSync(data, { level }))))).toEqual(Array.from(data));
        expect(Array.from(inflateRaw(new Uint8Array(deflateRawSync(data, { level }))))).toEqual(Array.from(data));
      }
      expect(Array.from(gunzipSync(new Uint8Array(gzipSync(data))))).toEqual(Array.from(data));
    }
  });

  it('keeps what it decoded from truncated streams', () => {
    const data = new TextEncoder().encode('hello world '.repeat(200));
    const z = new Uint8Array(deflateSync(data));
    const part = inflate(z.subarray(0, Math.floor(z.length / 2)));
    expect(part.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(part.subarray(0, 11))).toBe('hello world');
  });

  it('computes checksums and stored streams node can read', () => {
    const data = sample(100000);
    expect(adler32(data)).toBe(new Uint8Array(deflateSync(data)).subarray(-4).reduce((a, b) => (a * 256 + b) >>> 0, 0));
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(Array.from(inflateSync(zlibStored(data)))).toEqual(Array.from(data));
  });
});

describe('PDF filters', () => {
  it('decodes LZW, ASCII85 and PNG predictors', () => {
    const data = sample(5000);
    expect(Array.from(lzw(lzwEncode(data)))).toEqual(Array.from(data));
    expect(new TextDecoder().decode(ascii85(new TextEncoder().encode('<~87cURD]i,"Ebo80~>')))).toBe('Hello World!');
    expect(Array.from(ascii85(new TextEncoder().encode(encode85(data))))).toEqual(Array.from(data));
    // PNG "Up" predictor rows.
    const parms = new PDFDict();
    parms.set('Predictor', 12);
    parms.set('Columns', 3);
    const out = unpredict(Uint8Array.from([2, 1, 2, 3, 2, 1, 1, 1]), parms);
    expect(Array.from(out)).toEqual([1, 2, 3, 2, 3, 4]);
  });
});

describe('crypto primitives', () => {
  it('match node crypto', () => {
    const data = sample(1000);
    expect(Buffer.from(md5(data)).toString('hex')).toBe(createHash('md5').update(data).digest('hex'));
    expect(Buffer.from(sha256(data)).toString('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    expect(Buffer.from(sha512(data)).toString('hex')).toBe(createHash('sha512').update(data).digest('hex'));
    expect(Buffer.from(sha512(data, true)).toString('hex')).toBe(createHash('sha384').update(data).digest('hex'));
    for (const bits of [128, 256]) {
      const key = sample(bits / 8, 9);
      const iv = sample(16, 4);
      const c = createCipheriv(`aes-${bits}-cbc`, key, iv);
      const enc = Buffer.concat([iv, c.update(data), c.final()]);
      expect(Array.from(aesCbcDecrypt(key, new Uint8Array(enc)))).toEqual(Array.from(data));
    }
  });
});

describe('PNG', () => {
  it('encodes RGB and RGBA pixels', async () => {
    const img = { width: 3, height: 2, data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 128]) };
    for (const png of [await encodePNG(img), encodePNGSync(img)]) {
      expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(png[25]).toBe(6);
    }
  });
});

describe('TIFF', () => {
  const pixels = () => {
    const w = 37;
    const h = 11;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = (i * 7) & 255;
      data[i * 4 + 1] = (i * 3) & 255;
      data[i * 4 + 2] = 255 - ((i * 5) & 255);
      data[i * 4 + 3] = i % 3 ? 255 : 100;
    }
    return { width: w, height: h, data };
  };

  it('roundtrips RGB(A) with every compression and byte order', async () => {
    const img = pixels();
    for (const compression of ['none', 'lzw', 'deflate']) {
      for (const byteOrder of ['II', 'MM']) {
        const bytes = await encodeTIFF(img, { mode: 'rgb', alpha: true, compression, byteOrder, ppi: 300 });
        expect(isTIFF(bytes)).toBe(true);
        const back = decodeTIFF(bytes);
        expect(back).toMatchObject({ width: 37, height: 11 });
        expect(back.ppi).toBeCloseTo(300);
        expect(Array.from(back.data)).toEqual(Array.from(img.data));
      }
    }
  });

  it('writes grayscale and CMYK and flattens transparency on white', async () => {
    const img = { width: 2, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 0, 255, 0, 0, 255]) };
    const gray = decodeTIFF(await encodeTIFF(img, { mode: 'gray' }));
    expect(Array.from(gray.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    expect(gray.data[4]).toBe(76);
    const cmyk = decodeTIFF(await encodeTIFF(img, { mode: 'cmyk', compression: 'none' }));
    expect(Array.from(cmyk.data.subarray(4, 8))).toEqual([255, 0, 0, 255]);
  });

  it('reads palette, bilevel, 16-bit, planar and PackBits images', () => {
    // Hand-built: 2x2 8-bit palette image, then a 16-bit gray strip.
    const build = (entries, data) => {
      const n = entries.length;
      const ifd = 8 + data.length + (data.length % 2);
      const extra = [];
      let extraAt = ifd + 2 + n * 12 + 4;
      const buf = [];
      const push16 = (v) => buf.push(v & 255, v >> 8);
      const push32 = (v) => buf.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
      buf.push(0x49, 0x49, 42, 0);
      push32(ifd);
      buf.push(...data);
      if (data.length % 2) buf.push(0);
      push16(n);
      for (const [tag, type, values] of entries) {
        push16(tag);
        push16(type);
        push32(values.length);
        const size = type === 3 ? 2 : 4;
        if (values.length * size <= 4) {
          for (const v of values) (size === 2 ? push16 : push32)(v);
          for (let k = values.length * size; k < 4; k++) buf.push(0);
        } else {
          push32(extraAt);
          extra.push(...values.flatMap((v) => (size === 2 ? [v & 255, v >> 8] : [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255])));
          extraAt += values.length * size;
        }
      }
      push32(0);
      buf.push(...extra);
      return Uint8Array.from(buf);
    };
    const map = [65535, 0, 0, 0, 65535, 0, 0, 0, 65535].concat(new Array(768 - 9).fill(0));
    const pal = build([[256, 3, [2]], [257, 3, [2]], [258, 3, [8]], [259, 3, [1]], [262, 3, [3]], [273, 4, [8]], [277, 3, [1]], [278, 3, [2]], [279, 4, [4]], [320, 3, rearrangeMap(map)]], [0, 1, 2, 0]);
    const p = decodeTIFF(pal);
    expect(Array.from(p.data.subarray(0, 12))).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    // PackBits bilevel (WhiteIsZero): one row of 8 pixels 0xF0.
    const bi = decodeTIFF(build([[256, 3, [8]], [257, 3, [1]], [258, 3, [1]], [259, 3, [32773]], [262, 3, [0]], [273, 4, [8]], [277, 3, [1]], [278, 3, [1]], [279, 4, [2]]], [0, 0xf0]));
    expect(bi.data[0]).toBe(0);
    expect(bi.data[4 * 4]).toBe(255);
    // 16-bit gray, little-endian.
    const g16 = decodeTIFF(build([[256, 3, [2]], [257, 3, [1]], [258, 3, [16]], [259, 3, [1]], [262, 3, [1]], [273, 4, [8]], [277, 3, [1]], [278, 3, [1]], [279, 4, [4]]], [0, 0, 255, 255]));
    expect(g16.data[0]).toBe(0);
    expect(g16.data[4]).toBe(255);
    // Planar RGB.
    const planar = decodeTIFF(build([[256, 3, [2]], [257, 3, [1]], [258, 3, [8, 8, 8]], [259, 3, [1]], [262, 3, [2]], [273, 4, [8, 10, 12]], [277, 3, [3]], [278, 3, [1]], [279, 4, [2, 2, 2]], [284, 3, [2]]], [255, 0, 0, 255, 0, 0]));
    expect(Array.from(planar.data.subarray(0, 8))).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });
});

/** TIFF color maps list all reds, then greens, then blues. */
function rearrangeMap(m) {
  const r = [];
  const g = [];
  const b = [];
  for (let i = 0; i < 256; i++) {
    r.push(m[i * 3] ?? 0);
    g.push(m[i * 3 + 1] ?? 0);
    b.push(m[i * 3 + 2] ?? 0);
  }
  return [...r, ...g, ...b];
}

describe('BMP', () => {
  const header = (w, h, bpp, { compression = 0, colors = 0, extra = [], pixels = [] } = {}) => {
    const palette = extra;
    const offset = 14 + 40 + palette.length;
    const size = offset + pixels.length;
    const b = new Uint8Array(size);
    const dv = new DataView(b.buffer);
    b[0] = 0x42;
    b[1] = 0x4d;
    dv.setUint32(2, size, true);
    dv.setUint32(10, offset, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, w, true);
    dv.setInt32(22, h, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, bpp, true);
    dv.setUint32(30, compression, true);
    dv.setUint32(46, colors, true);
    b.set(palette, 54);
    b.set(pixels, offset);
    return b;
  };

  it('reads 24-bit bottom-up and 32-bit top-down bitmaps', () => {
    // 2x2, rows padded to 8 bytes; bottom row first.
    const b24 = header(2, 2, 24, { pixels: [255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0] });
    const r = decodeBMP(b24);
    expect(Array.from(r.data.subarray(0, 8))).toEqual([255, 0, 0, 255, 255, 255, 255, 255]);
    expect(Array.from(r.data.subarray(8, 16))).toEqual([0, 0, 255, 255, 0, 255, 0, 255]);
    const b32 = header(1, -1, 32, { pixels: [10, 20, 30, 0] });
    expect(Array.from(decodeBMP(b32).data)).toEqual([30, 20, 10, 255]);
  });

  it('reads palettes and RLE8', () => {
    const pal = [0, 0, 255, 0, 0, 255, 0, 0];
    const b8 = header(3, 1, 8, { colors: 2, extra: pal, pixels: [0, 1, 0, 0] });
    expect(Array.from(decodeBMP(b8).data)).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
    const rle = header(4, 1, 8, { compression: 1, colors: 2, extra: pal, pixels: [3, 1, 1, 0, 0, 1] });
    expect(Array.from(decodeBMP(rle).data.subarray(0, 16))).toEqual([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
  });
});

describe('PSD', () => {
  const psd = ({ w, h, channels, mode = 3, depth = 8, rle = false, planes, mergedAlpha = false }) => {
    const out = [];
    const u16 = (v) => out.push((v >> 8) & 255, v & 255);
    const u32 = (v) => out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    out.push(0x38, 0x42, 0x50, 0x53);
    u16(1);
    out.push(0, 0, 0, 0, 0, 0);
    u16(channels);
    u32(h);
    u32(w);
    u16(depth);
    u16(mode);
    u32(0);
    u32(0);
    if (mergedAlpha) {
      u32(8);
      u32(2);
      u16(0xffff);
      out.push(0, 0);
    } else u32(0);
    u16(rle ? 1 : 0);
    if (rle) {
      const rows = [];
      for (const p of planes) for (let y = 0; y < h; y++) rows.push([w - 1, ...p.slice(y * w, (y + 1) * w)]);
      for (const r of rows) u16(r.length);
      for (const r of rows) out.push(...r);
    } else for (const p of planes) out.push(...p);
    return Uint8Array.from(out);
  };

  it('reads raw and RLE RGB composites with merged transparency', () => {
    const planes = [[255, 0], [0, 255], [0, 0], [255, 128]];
    const raw = decodePSD(psd({ w: 2, h: 1, channels: 3, planes: planes.slice(0, 3) }));
    expect(Array.from(raw.data)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    const rle = decodePSD(psd({ w: 2, h: 1, channels: 4, planes, rle: true, mergedAlpha: true }));
    expect(rle.data[3]).toBe(255);
    expect(rle.data[7]).toBe(128);
    // The extra channel is not transparency unless the file says so.
    expect(decodePSD(psd({ w: 2, h: 1, channels: 4, planes, rle: true })).data[7]).toBe(255);
  });

  it('reads grayscale and CMYK (stored inverted)', () => {
    expect(Array.from(decodePSD(psd({ w: 1, h: 1, channels: 1, mode: 1, planes: [[64]] })).data)).toEqual([64, 64, 64, 255]);
    const cmyk = decodePSD(psd({ w: 1, h: 1, channels: 4, mode: 4, planes: [[0], [255], [255], [255]] }));
    expect(Array.from(cmyk.data)).toEqual([0, 255, 255, 255]);
  });

  it('converts to PNG through the raster helper', async () => {
    const bytes = psd({ w: 1, h: 1, channels: 3, planes: [[1], [2], [3]] });
    expect(rasterKind(bytes)).toBe('psd');
    const png = await rasterToPNG(bytes);
    expect(png).toMatchObject({ mime: 'image/png', width: 1, height: 1 });
  });
});
