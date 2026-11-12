import { describe, expect, it } from 'vitest';
import { inflate } from 'pako';
import { decodeTiff, listTiffTags } from '../src/imaging/codecs/tiff';
import { readPngChunks, readPngIcc, verifyPngCrcs, readPngDpi } from '../src/imaging/codecs/png-chunks';
import { bitmapPng, encodeCmykTiff, encodeGrayTiff, encodeLabTiff, grayPng, palettePng } from '../src/features/color/encode';
import { encodeModePng, encodeModeTiff } from '../src/features/color/export';
import { builtinProfile } from '../src/color/builtin-profiles';
import { parseIcc } from '../src/color/icc-lut';
import { serializeIcc } from '../src/color/icc-write';
import { newDocument, type PhotoDocument } from '../src/model/document';
import type { RGBA8 } from '../src/imaging/types';

const img = (w: number, h: number, f: (x: number, y: number) => number[]): RGBA8 => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = f(x, y);
      data.set([r, g, b, a], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
};
const pngPixels = (png: Uint8Array) => {
  const chunks = readPngChunks(png);
  const ihdr = chunks.find((c) => c.type === 'IHDR')!.data;
  const v = new DataView(ihdr.buffer, ihdr.byteOffset);
  const idat = chunks.filter((c) => c.type === 'IDAT');
  const all = new Uint8Array(idat.reduce((s, c) => s + c.data.length, 0));
  let o = 0;
  for (const c of idat) {
    all.set(c.data, o);
    o += c.data.length;
  }
  return { width: v.getUint32(0), height: v.getUint32(4), depth: ihdr[8], colorType: ihdr[9], raw: inflate(all), chunks };
};

describe('mode-aware encoders', { timeout: 120000 }, () => {
  it('writes CMYK TIFF that the codec decodes as separated CMYK with the profile', () => {
    const w = 5,
      h = 3,
      n = w * h;
    const planes = { width: w, height: h, c: new Uint8Array(n), m: new Uint8Array(n), y: new Uint8Array(n), k: new Uint8Array(n), alpha: new Uint8Array(n).fill(255) };
    for (let i = 0; i < n; i++) {
      planes.c[i] = i * 17;
      planes.m[i] = 255 - i * 17;
      planes.y[i] = (i * 53) % 256;
      planes.k[i] = i % 2 ? 255 : 0;
    }
    const icc = serializeIcc(builtinProfile('srgb'));
    for (const compression of ['none', 'lzw', 'deflate'] as const) {
      const tif = encodeCmykTiff(planes, { icc, dpi: 300, compression });
      const page = decodeTiff(tif).pages[0];
      expect(page.colorModel).toBe('cmyk');
      expect(page.photometric).toBe(5);
      expect(page.alpha).toBeUndefined();
      const cmyk = page.cmyk!;
      expect(Array.from(cmyk.subarray(0, n))).toEqual(Array.from(planes.c));
      expect(Array.from(cmyk.subarray(n, 2 * n))).toEqual(Array.from(planes.m));
      expect(Array.from(cmyk.subarray(2 * n, 3 * n))).toEqual(Array.from(planes.y));
      expect(Array.from(cmyk.subarray(3 * n))).toEqual(Array.from(planes.k));
      expect(page.icc?.length).toBe(icc.length);
      expect(page.resolution?.x).toBeCloseTo(300);
      const tags = listTiffTags(tif)[0];
      expect(tags[332]).toEqual([1]);
      expect(tags[338]).toBeUndefined();
    }
  });

  it('writes CIELab TIFF with signed a/b samples', () => {
    const lab = { width: 2, height: 1, L: new Uint8Array([255, 0]), a: new Uint8Array([128, 200]), b: new Uint8Array([128, 20]) };
    const tif = encodeLabTiff(lab, { compression: 'none' });
    const tags = listTiffTags(tif)[0];
    expect(tags[262]).toEqual([8]);
    const off = (tags[273] as number[])[0];
    expect(Array.from(tif.subarray(off, off + 6))).toEqual([255, 0, 0, 0, 72, (20 - 128) & 255]);
  });

  it('writes gray TIFF with and without alpha', () => {
    const g = new Uint8Array([0, 128, 255, 64]);
    const page = decodeTiff(encodeGrayTiff(g, null, 2, 2)).pages[0];
    expect(page.colorModel).toBe('gray');
    expect(Array.from(page.rgba8.data.subarray(4, 8))).toEqual([128, 128, 128, 255]);
    const withAlpha = decodeTiff(encodeGrayTiff(g, new Uint8Array([255, 0, 128, 255]), 2, 2)).pages[0];
    expect(withAlpha.rgba8.data[7]).toBe(0);
  });

  it('writes valid gray, 1-bit and palette PNGs', () => {
    const gp = grayPng(new Uint8Array([10, 20, 30, 40, 50, 60]), null, 3, 2, { name: 'Gray', bytes: serializeIcc(builtinProfile('gray-gamma-22')) }, 300);
    expect(verifyPngCrcs(gp)).toBe(true);
    const g = pngPixels(gp);
    expect([g.colorType, g.depth]).toEqual([0, 8]);
    expect(Array.from(g.raw)).toEqual([0, 10, 20, 30, 0, 40, 50, 60]);
    expect(parseIcc(readPngIcc(gp)!.profile).colorSpace).toBe('GRAY');
    expect(Math.round(readPngDpi(gp)!.x)).toBe(300);

    const bp = pngPixels(bitmapPng(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 1, 1]), 10, 1));
    expect([bp.colorType, bp.depth]).toEqual([0, 1]);
    // 1 = black ink -> PNG gray 0; first byte 0b01111111, second 0b00______.
    expect(Array.from(bp.raw)).toEqual([0, 0b01111111, 0b00000000]);

    const pal = new Uint8Array([255, 0, 0, 0, 0, 255, 0, 0, 0]);
    const pp = pngPixels(palettePng(new Uint8Array([0, 1, 2, 1]), pal, 2, 2, 2));
    expect(pp.colorType).toBe(3);
    expect(Array.from(pp.chunks.find((c) => c.type === 'PLTE')!.data)).toEqual(Array.from(pal));
    expect(Array.from(pp.chunks.find((c) => c.type === 'tRNS')!.data)).toEqual([255, 255, 0]);
  });

  it('exports documents in their image mode', () => {
    const base = newDocument(4, 2, 'Test');
    const src = img(4, 2, (x) => [[0, 0, 255], [255, 0, 0], [255, 255, 255], [0, 0, 0]][x]);
    const cmykDoc: PhotoDocument = { ...base, mode: 'cmyk', modeData: { profile: 'builtin:generic-coated-cmyk' } };
    const cmyk = encodeModeTiff(cmykDoc, src);
    const page = decodeTiff(cmyk.bytes).pages[0];
    expect(page.colorModel).toBe('cmyk');
    const n = 8;
    // White is no ink; black carries heavy K.
    expect([page.cmyk![2], page.cmyk![n + 2], page.cmyk![2 * n + 2], page.cmyk![3 * n + 2]]).toEqual([0, 0, 0, 0]);
    expect(page.cmyk![3 * n + 3]).toBeGreaterThan(200);
    expect(parseIcc(page.icc!).colorSpace).toBe('CMYK');

    const grayDoc: PhotoDocument = { ...base, mode: 'grayscale', modeData: { profile: 'builtin:gray-gamma-22' } };
    const gray = decodeTiff(encodeModeTiff(grayDoc, src).bytes).pages[0];
    expect(gray.colorModel).toBe('gray');
    const grayPngFile = encodeModePng(grayDoc, src);
    expect(pngPixels(grayPngFile.bytes).colorType).toBe(0);

    const indexedDoc: PhotoDocument = { ...base, mode: 'indexed', modeData: { palette: ['#0000ff', '#ff0000', '#ffffff', '#000000'], transparentIndex: -1 } };
    const ip = pngPixels(encodeModePng(indexedDoc, src).bytes);
    expect(ip.colorType).toBe(3);
    expect(Array.from(ip.raw)).toEqual([0, 0, 1, 2, 3, 0, 0, 1, 2, 3]);

    const labDoc: PhotoDocument = { ...base, mode: 'lab' };
    expect(listTiffTags(encodeModeTiff(labDoc, src).bytes)[0][262]).toEqual([8]);

    const rgb = decodeTiff(encodeModeTiff(base, src).bytes).pages[0];
    expect(rgb.colorModel).toBe('rgb');
    expect(Array.from(rgb.rgba8.data.subarray(0, 4))).toEqual([0, 0, 255, 255]);
  });

  it('exports the inks a perceptual CMYK conversion produced, not a second perceptual mapping', async () => {
    const { saveColorSettings, defaultSettings } = await import('../src/features/color/profiles');
    const { cmykMap } = await import('../src/features/color/convert');
    const { cachedTransform, bakeLut3D, transformToCMYK } = await import('../src/color/color-management');
    const srgb = builtinProfile('srgb'),
      cmyk = builtinProfile('generic-coated-cmyk');
    saveColorSettings({ ...defaultSettings, intent: 'perceptual' });
    try {
      const src = img(8, 2, (x, y) => [x * 36, y ? 200 - x * 20 : 40 + x * 25, (x * 70 + y * 90) % 256]);
      // Image > Mode > CMYK Color with Perceptual: these are the inks of the conversion.
      const inks = transformToCMYK(src, bakeLut3D(cachedTransform(srgb, cmyk, 'perceptual', { bpc: true }), 33));
      const doc: PhotoDocument = { ...newDocument(8, 2, 'Test'), mode: 'cmyk', modeData: { profile: 'builtin:generic-coated-cmyk' } };
      const page = decodeTiff(encodeModeTiff(doc, cmykMap(srgb, cmyk, 'perceptual', true)(src)).bytes).pages[0];
      const n = 16;
      let total = 0;
      for (const [k, plane] of [inks.c, inks.m, inks.y, inks.k].entries())
        for (let p = 0; p < n; p++) total += Math.abs(page.cmyk![k * n + p] - plane[p]);
      // Mapping the already printable colors perceptually again moved the
      // inks by 9 levels on average (up to 48); what remains is rounding and
      // the freedom of black generation in the deepest shadows.
      expect(total / (4 * n)).toBeLessThan(3);
    } finally {
      saveColorSettings({ ...defaultSettings });
    }
  });
});
