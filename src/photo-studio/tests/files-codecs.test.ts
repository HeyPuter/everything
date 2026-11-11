// Export helpers in src/features/files: STORE zip writer, PNG writer/16-bit
// reader, resampling, sRGB conversion and the export pipeline.
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { zipStore, uniqueName } from '../src/features/files/zip';
import { decodePng16, encodePng, rgba16To8 } from '../src/features/files/png';
import { resampleRGBA } from '../src/features/files/resample';
import { convertToSrgb, documentProfile, floatTo16 } from '../src/features/files/color';
import { applyMatte, defaultSettings, encodeExport, encodeIcon, fitSize, insertJpegComments, outputSize, placeOnCanvas, prepareExport, type ExportSettings } from '../src/features/files/encode';
import { crc32 } from '../src/imaging/codecs/bytes';
import { readPngChunks, readPngText, readPngIcc, readPngDpi } from '../src/imaging/codecs/png-chunks';
import { readJpegDensity } from '../src/imaging/codecs/jpeg-markers';
import { decodeTiff } from '../src/imaging/codecs/tiff';
import { decodeBmp } from '../src/imaging/codecs/bmp';
import { decodeTga } from '../src/imaging/codecs/tga';
import { decodeGif } from '../src/imaging/codecs/gif';
import { decodeIco } from '../src/imaging/codecs/ico';
import { linearSrgbProfile, srgbProfile } from '../src/color/profile';

// Independent reader for the archives (central directory walk).
function readZip(zip: Uint8Array) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files: { name: string; data: Uint8Array; crc: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const crc = dv.getUint32(p + 16, true),
      size = dv.getUint32(p + 20, true),
      nameLen = dv.getUint16(p + 28, true),
      local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    expect(dv.getUint32(local, true)).toBe(0x04034b50);
    expect(dv.getUint16(local + 8, true)).toBe(0);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    files.push({ name, data: zip.subarray(start, start + size), crc });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return files;
}
// Independent 8-bit PNG reader (Node zlib, filters 0-4).
function readPng8(png: Uint8Array) {
  const chunks = readPngChunks(png);
  const ihdr = chunks.find((c) => c.type === 'IHDR')!.data;
  const dv = new DataView(ihdr.buffer, ihdr.byteOffset);
  const w = dv.getUint32(0),
    h = dv.getUint32(4),
    ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr[9]] as number;
  expect(ihdr[8]).toBe(8);
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const out = new Uint8Array(w * h * ch),
    stride = w * ch;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= ch ? out[y * stride + i - ch] : 0,
        b = y ? out[(y - 1) * stride + i] : 0,
        c = i >= ch && y ? out[(y - 1) * stride + i - ch] : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * stride + i] = (x + pred) & 255;
    }
  }
  return { w, h, ch, data: out };
}
function noise(w: number, h: number, seed = 1) {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < d.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    d[i] = s >>> 24;
  }
  return d;
}

describe('zipStore', () => {
  it('writes stored entries with CRCs and UTF-8 names that an independent reader extracts', () => {
    const a = new Uint8Array([1, 2, 3]),
      b = new TextEncoder().encode('héllo wörld');
    const zip = zipStore([{ name: 'a.png', data: a }, { name: 'ébauche/b.txt', data: b }, { name: 'empty', data: new Uint8Array() }]);
    const files = readZip(zip);
    expect(files.map((f) => f.name)).toEqual(['a.png', 'ébauche/b.txt', 'empty']);
    expect([...files[0].data]).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(files[1].data)).toBe('héllo wörld');
    expect(files[1].crc).toBe(crc32(b));
    expect(files[2].data.length).toBe(0);
    expect(zip.length).toBe(22 + (30 + 46) * 3 + 2 * (5 + new TextEncoder().encode('ébauche/b.txt').length + 5) + 3 + b.length);
  });
  it('makes names unique case-insensitively and strips path separators', () => {
    const used = new Set<string>();
    expect(uniqueName('Layer.png', used)).toBe('Layer.png');
    expect(uniqueName('layer.png', used)).toBe('layer 2.png');
    expect(uniqueName('a/b:c.png', used)).toBe('a_b_c.png');
    expect(uniqueName('', used)).toBe('file');
  });
});

describe('PNG', () => {
  it('round-trips 8-bit RGBA and RGB through an independent decoder at every level', () => {
    const w = 37,
      h = 11,
      d = noise(w, h);
    for (const level of [0, 1, 6, 9]) {
      const png = encodePng({ width: w, height: h, data: d, channels: 4 }, { level });
      const out = readPng8(png);
      expect([out.w, out.h, out.ch]).toEqual([w, h, 4]);
      expect([...out.data]).toEqual([...d]);
    }
    const rgb = new Uint8Array([10, 20, 30, 40, 50, 60]);
    expect([...readPng8(encodePng({ width: 2, height: 1, data: rgb, channels: 3 })).data]).toEqual([...rgb]);
  });
  it('round-trips 16-bit RGBA and RGB and inserts extra chunks before IDAT', () => {
    const w = 9,
      h = 5,
      d16 = new Uint16Array(w * h * 4).map((_, i) => (i * 4099 + 17) & 0xffff);
    const png = encodePng({ width: w, height: h, data: d16, channels: 4 }, { chunks: [{ type: 'tEXt', data: new TextEncoder().encode('Author\0Me') }] });
    expect(readPngChunks(png).map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
    expect(readPngText(png).Author).toBe('Me');
    const back = decodePng16(png)!;
    expect([back.width, back.height]).toEqual([w, h]);
    expect([...back.data16]).toEqual([...d16]);
    const rgb16 = new Uint16Array([1, 2, 65535, 300, 40000, 0]);
    const back3 = decodePng16(encodePng({ width: 1, height: 2, data: rgb16, channels: 3 }))!;
    expect([...back3.data16]).toEqual([1, 2, 65535, 65535, 300, 40000, 0, 65535]);
  });
  it('returns null for 8-bit PNGs and reduces 16 to 8 bits by rounding', () => {
    expect(decodePng16(encodePng({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 4]), channels: 4 }))).toBeNull();
    expect([...rgba16To8(new Uint16Array([0, 128, 129 * 257, 65535]))]).toEqual([0, 0, 129, 255]);
  });
});

describe('resampleRGBA', () => {
  it('keeps flat colors flat with every filter and preserves fully transparent edges', () => {
    const w = 7,
      h = 5,
      d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < d.length; i += 4) d.set([200, 100, 50, 255], i);
    for (const m of ['nearest', 'bilinear', 'bicubic', 'lanczos'] as const)
      for (const [nw, nh] of [[3, 2], [14, 11], [1, 1]]) {
        const out = resampleRGBA(d, w, h, nw, nh, m);
        expect(out.length).toBe(nw * nh * 4);
        for (let i = 0; i < out.length; i += 4) expect([...out.subarray(i, i + 4)]).toEqual([200, 100, 50, 255]);
      }
  });
  it('weights colors by alpha so transparent pixels do not darken edges', () => {
    // Opaque red next to transparent black: averaging must stay pure red.
    const d = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]);
    const out = resampleRGBA(d, 2, 1, 1, 1, 'bilinear');
    expect([out[0], out[1], out[2]]).toEqual([255, 0, 0]);
    expect(out[3]).toBe(128);
  });
  it('box-averages a 2× reduction with bilinear and handles 16-bit samples', () => {
    const d = new Uint16Array([0, 0, 0, 65535, 65535, 65535, 65535, 65535]);
    const out = resampleRGBA(d, 2, 1, 1, 1, 'bilinear');
    expect(out).toBeInstanceOf(Uint16Array);
    expect(Math.abs(out[0] - 32767.5)).toBeLessThanOrEqual(0.5);
  });
});

describe('color conversion', () => {
  it('is the identity from sRGB and decodes linear sRGB', () => {
    const d = new Uint8ClampedArray([0, 64, 128, 255, 255, 200, 1, 7]);
    expect([...convertToSrgb(d.slice(), srgbProfile)]).toEqual([...d]);
    // Linear 0.5 encodes to sRGB 188 (0.7354).
    const lin = convertToSrgb(new Uint8ClampedArray([128, 0, 255, 255]), linearSrgbProfile);
    expect([lin[0], lin[1], lin[2], lin[3]]).toEqual([188, 0, 255, 255]);
    expect(documentProfile({ bitsPerChannel: 32 })).toBe(linearSrgbProfile);
    expect(documentProfile({})).toBeNull();
    expect([...floatTo16(new Float32Array([-1, 0.5, 2]))]).toEqual([0, 32768, 65535]);
  });
});

describe('export pipeline', () => {
  const settings = (s: Partial<ExportSettings>): ExportSettings => ({ ...defaultSettings, ...s });
  it('computes output sizes from percent, width, height and fit bounds', () => {
    expect(outputSize(1000, 500, { sizeMode: 'percent', scale: 50, width: 0, height: 0 })).toEqual([500, 250]);
    expect(outputSize(1000, 500, { sizeMode: 'width', scale: 100, width: 300, height: 0 })).toEqual([300, 150]);
    expect(outputSize(1000, 500, { sizeMode: 'height', scale: 100, width: 0, height: 100 })).toEqual([200, 100]);
    expect(outputSize(3, 3, { sizeMode: 'percent', scale: 1, width: 0, height: 0 })).toEqual([1, 1]);
    // Sizes past the 8192-pixel limit shrink in proportion rather than per side.
    expect(outputSize(4000, 3000, { sizeMode: 'percent', scale: 300, width: 0, height: 0 })).toEqual([8192, 6144]);
    expect(outputSize(1000, 3000, { sizeMode: 'width', scale: 100, width: 8000, height: 0 })).toEqual([2731, 8192]);
    expect(outputSize(3000, 1000, { sizeMode: 'height', scale: 100, width: 0, height: 5000 })).toEqual([8192, 2731]);
    expect(outputSize(1000, 500, { sizeMode: 'exact', scale: 100, width: 9000, height: 300 })).toEqual([8192, 300]);
    expect(fitSize(4000, 3000, 1024, 1024)).toEqual([1024, 768]);
    expect(fitSize(100, 50, 1024, 1024)).toEqual([100, 50]);
    expect(fitSize(100, 50, 1024, 1024, true)).toEqual([1024, 512]);
  });
  it('places images centered on the canvas and mattes transparency', () => {
    const img = { width: 1, height: 1, data: new Uint8ClampedArray([9, 9, 9, 255]) };
    const big = placeOnCanvas(img, 3, 1);
    expect([...big.data]).toEqual([0, 0, 0, 0, 9, 9, 9, 255, 0, 0, 0, 0]);
    expect([...applyMatte(big.data, [255, 255, 255])]).toEqual([255, 255, 255, 255, 9, 9, 9, 255, 255, 255, 255, 255]);
    expect([...applyMatte(new Uint8ClampedArray([0, 0, 0, 128]), [255, 255, 255])]).toEqual([127, 127, 127, 255]);
    const small = placeOnCanvas({ width: 3, height: 1, data: new Uint8ClampedArray([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]) }, 1, 1);
    expect([...small.data]).toEqual([2, 2, 2, 2]);
  });
  it('writes PNG metadata, DPI and the sRGB chunk, and an ICC profile when kept', async () => {
    const src = { width: 4, height: 3, data: noise(4, 3) };
    const info = { copyright: '© 2026 Example', author: 'A. Person', title: 'Sunset', description: 'Test', contact: 'a@example.com' };
    const png = await encodeExport(prepareExport(src, settings({}), { profile: null }), settings({ metadata: 'all' }), { profile: null, dpi: 300, info });
    const text = readPngText(png);
    expect(text).toMatchObject({ Copyright: '© 2026 Example', Author: 'A. Person', Title: 'Sunset', Description: 'Test', Comment: 'Contact: a@example.com' });
    expect(readPngDpi(png)!.x).toBeCloseTo(300, 0);
    expect(readPngChunks(png).some((c) => c.type === 'sRGB')).toBe(true);
    const fake = new Uint8Array(200).fill(7);
    const keep = settings({ convertSrgb: false, metadata: 'none' });
    const tagged = await encodeExport(prepareExport(src, keep, { profile: srgbProfile, icc: fake }), keep, { profile: srgbProfile, icc: fake, info });
    expect([...readPngIcc(tagged)!.profile]).toEqual([...fake]);
    expect(readPngText(tagged)).toEqual({});
    // Copyright-only metadata leaves title and description out.
    const c = await encodeExport(prepareExport(src, settings({}), { profile: null }), settings({ metadata: 'copyright' }), { profile: null, info });
    expect(Object.keys(readPngText(c)).sort()).toEqual(['Author', 'Comment', 'Copyright']);
  });
  it('writes opaque PNGs as RGB and 16-bit PNG/TIFF from 16-bit sources', async () => {
    const opaque = noise(5, 4);
    for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
    const png = await encodeExport({ width: 5, height: 4, data: opaque }, settings({}), { profile: null });
    expect(readPngChunks(png)[0].data[9]).toBe(2);
    const d16 = new Uint16Array(5 * 4 * 4).map((_, i) => (i % 4 === 3 ? 65535 : i * 811));
    const s16 = settings({ depth: 16 });
    const prepared = prepareExport({ width: 5, height: 4, data: d16 }, s16, { profile: null });
    expect(prepared.data).toBeInstanceOf(Uint16Array);
    const back = decodePng16(await encodeExport(prepared, s16, { profile: null }))!;
    expect([...back.data16]).toEqual([...d16]);
    const tiff = decodeTiff(await encodeExport(prepared, settings({ depth: 16, format: 'tiff', tiffCompression: 'deflate' }), { profile: null, dpi: 240 })).pages[0];
    expect(tiff.bitsPerSample).toBe(16);
    expect([...tiff.data16!]).toEqual([...d16]);
    expect(tiff.resolution?.x).toBeCloseTo(240);
    // 8-bit output from a 16-bit source.
    expect(prepareExport({ width: 5, height: 4, data: d16 }, settings({}), { profile: null }).data).toBeInstanceOf(Uint8ClampedArray);
  });
  it('encodes TIFF, BMP, TGA, GIF and ICO that the decoders read back', async () => {
    const w = 6,
      h = 4,
      d = noise(w, h, 3);
    for (let i = 0; i < d.length; i += 4) d[i + 3] = i % 8 ? 255 : 0;
    for (let i = 0; i < d.length; i += 4) if (!d[i + 3]) d.fill(0, i, i + 3);
    const ctx = { profile: null };
    const enc = async (s: Partial<ExportSettings>) => encodeExport(prepareExport({ width: w, height: h, data: d }, settings(s), ctx), settings(s), ctx);
    for (const c of ['none', 'lzw', 'deflate'] as const) expect([...decodeTiff(await enc({ format: 'tiff', tiffCompression: c })).pages[0].rgba8.data]).toEqual([...d]);
    expect([...decodeBmp(await enc({ format: 'bmp' })).rgba8.data]).toEqual([...d]);
    expect([...decodeTga(await enc({ format: 'tga' })).rgba8.data]).toEqual([...d]);
    const gif = decodeGif(await enc({ format: 'gif' })).frames[0].rgba;
    for (let i = 0; i < d.length; i += 4) expect(gif.data[i + 3]).toBe(d[i + 3]);
    // Without transparency, BMP is 24-bit over the matte.
    const flat = decodeBmp(await enc({ format: 'bmp', transparency: false, matte: '#ff0000' })).rgba8.data;
    expect([...flat.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    const ico = decodeIco(encodeIcon({ width: 40, height: 20, data: noise(40, 20) }));
    expect(ico.entries.map((e) => e.width).sort((a, b) => a - b)).toEqual([16, 24, 32]);
    const ico256 = decodeIco(encodeIcon({ width: 300, height: 300, data: noise(300, 300) }));
    expect(ico256.entries.find((e) => e.width === 256)?.format).toBe('png');
  });
  it('passes JPEG through the browser hook and adds ICC, density and comments', async () => {
    // Minimal JPEG skeleton: SOI, APP0 JFIF, DQT stub, SOS stub, EOI.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 72, 0, 72, 0, 0, 0xff, 0xdb, 0, 3, 0, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
    let seen = '';
    const icc = new Uint8Array(64).fill(3);
    const s = settings({ format: 'jpeg', convertSrgb: false, metadata: 'copyright' });
    const out = await encodeExport({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) }, s, { profile: srgbProfile, icc, dpi: 150, info: { copyright: 'Me' } }, async (_i, mime, q) => {
      seen = `${mime} ${q}`;
      return jpeg;
    });
    expect(seen).toBe('image/jpeg 85');
    const str = new TextDecoder('latin1').decode(out);
    expect(str).toContain('ICC_PROFILE');
    expect(str).toContain('Copyright: Me');
    expect(readJpegDensity(out)).toMatchObject({ x: 150, y: 150, unit: 'inch' });
    expect(insertJpegComments(jpeg, [])).toBe(jpeg);
  });
});
