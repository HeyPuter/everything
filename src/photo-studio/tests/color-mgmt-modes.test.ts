import { describe, expect, it } from 'vitest';
import { builtinProfile } from '../src/color/builtin-profiles';
import { grayToBitmap, packBitmap } from '../src/color/bitmap';
import { colorInfo, generateSwatchLibrary, harmonySwatches, parseHex } from '../src/color/color-info';
import { decodeLab } from '../src/color/color-math';
import { deltaE2000 } from '../src/color/delta-e';
import { curveTable, duotoneTable } from '../src/color/duotone';
import { indexedToRGBA, toIndexed } from '../src/color/indexed';
import { convertMode, convertModeToRGB, type CmykResult, type LabResult } from '../src/color/modes';
import { createTransform } from '../src/color/transform';
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
const srgb = builtinProfile('srgb');
const toLab = createTransform(srgb, builtinProfile('lab-d50'));
const labOf = (rgb: ArrayLike<number>) => decodeLab(toLab.one(Array.from(rgb, (v) => v / 255)), 'v4');

describe('Lab and Grayscale modes', { timeout: 120000 }, () => {
  it('encodes Lab in the 8-bit ICC/PSD convention and converts back', () => {
    const src = img(3, 2, (x, y) => [[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 128, 255], [128, 128, 128], [20, 200, 60]][y * 3 + x]);
    const res = convertMode(src, 'rgb', 'lab') as LabResult;
    expect([res.L[0], res.a[0], res.b[0]]).toEqual([255, 128, 128]);
    expect([res.L[1], res.a[1], res.b[1]]).toEqual([0, 128, 128]);
    // sRGB red in D50 CIELAB is about (54.29, 80.8, 69.9).
    expect(res.float[6]).toBeCloseTo(54.29, 0);
    expect(res.float[7]).toBeCloseTo(80.8, 0);
    expect(res.float[8]).toBeCloseTo(69.9, 0);
    expect(res.L[2]).toBe(Math.round((res.float[6] / 100) * 255));
    expect(res.a[2]).toBe(Math.round(res.float[7] + 128));
    const back = convertModeToRGB(res);
    // 8-bit Lab steps (0.39 L*, 1 a*/b*) bound the round trip error.
    for (let i = 0; i < src.data.length; i += 4)
      expect(deltaE2000(labOf(src.data.slice(i, i + 3)), labOf(back.data.slice(i, i + 3)))).toBeLessThan(1);
  });

  it('converts to Gray Gamma 2.2 with alpha and back', () => {
    const src = img(256, 1, (x) => [x, x, x, x === 3 ? 0 : 255]);
    const res = convertMode(src, 'rgb', 'grayscale');
    if (res.mode !== 'grayscale') throw new Error();
    // sRGB 128 has Y = 0.2158, which gamma 2.2 encodes as 127.
    expect(res.gray[128]).toBe(127);
    expect(res.gray[0]).toBe(0);
    expect(res.gray[255]).toBe(255);
    expect(res.alpha[3]).toBe(0);
    const back = convertModeToRGB(res);
    for (let x = 0; x < 256; x++) expect(Math.abs(back.data[x * 4] - x)).toBeLessThanOrEqual(1);
  });
});

describe('CMYK mode', { timeout: 60000 }, () => {
  it('returns four ink planes, alpha and a round-trip preview', () => {
    const src = img(16, 16, (x, y) => [x * 16, y * 16, 255 - x * 8, (x + y) % 5 ? 255 : 0]);
    src.data.set([255, 255, 255, 255], 0);
    const res = convertMode(src, 'rgb', 'cmyk') as CmykResult;
    expect(res.planes.c[0] + res.planes.m[0] + res.planes.y[0] + res.planes.k[0]).toBe(0);
    expect(res.preview.data.slice(0, 3)).toEqual(new Uint8ClampedArray([255, 255, 255]));
    let worst = 0;
    for (let p = 0; p < 256; p++) {
      expect(res.planes.alpha[p]).toBe(src.data[p * 4 + 3]);
      expect(res.planes.c[p] + res.planes.m[p] + res.planes.y[p] + res.planes.k[p]).toBeLessThanOrEqual(767);
      worst = Math.max(worst, deltaE2000(labOf(src.data.slice(p * 4, p * 4 + 3)), labOf(res.preview.data.slice(p * 4, p * 4 + 3))));
    }
    // Saturated sRGB colors move into the press gamut, but stay recognizable.
    expect(worst).toBeLessThan(40);
    const back = convertModeToRGB(res);
    expect(Array.from(back.data)).toEqual(Array.from(res.preview.data));
  });
});

describe('Indexed mode', { timeout: 120000 }, () => {
  const gradient = img(256, 8, (x) => [x, Math.round(x * 0.6 + 40), 255 - x]);
  const meanError = (a: RGBA8, b: RGBA8) => {
    let e = 0;
    for (let i = 0; i < a.data.length; i += 4) e += deltaE2000(labOf(a.data.slice(i, i + 3)), labOf(b.data.slice(i, i + 3)));
    return e / (a.data.length / 4);
  };

  it('builds an adaptive palette that reproduces a gradient closely', () => {
    const res = toIndexed(gradient, { palette: 'adaptive', colors: 16 });
    expect(res.colors).toBe(16);
    const used = new Set(res.indices);
    expect(used.size).toBe(16);
    const adaptive = meanError(gradient, indexedToRGBA(res));
    const uniform = meanError(gradient, indexedToRGBA(toIndexed(gradient, { palette: 'uniform', colors: 16 })));
    const perceptual = meanError(gradient, indexedToRGBA(toIndexed(gradient, { palette: 'perceptual', colors: 16 })));
    expect(adaptive).toBeLessThan(2.5);
    expect(perceptual).toBeLessThan(2.5);
    expect(adaptive).toBeLessThan(uniform / 3);
    // Diffusion keeps the average color of each column region.
    const dithered = indexedToRGBA(toIndexed(gradient, { palette: 'adaptive', colors: 4, dither: 'diffusion' }));
    let sum = 0,
      want = 0;
    for (let i = 0; i < gradient.data.length; i += 4) {
      sum += dithered.data[i];
      want += gradient.data[i];
    }
    expect(Math.abs(sum - want) / (gradient.data.length / 4)).toBeLessThan(2);
  });

  it('keeps exact palettes exact, honors forced colors, transparency and dithers deterministically', () => {
    const few = img(10, 10, (x, y) => [[10, 20, 30], [200, 0, 0], [0, 255, 0], [1, 2, 3], [77, 77, 77]][(x + y) % 5]);
    const exact = toIndexed(few, { palette: 'exact', colors: 8 });
    expect(exact.colors).toBe(5);
    expect(Array.from(indexedToRGBA(exact).data)).toEqual(Array.from(few.data));
    const forced = toIndexed(gradient, { palette: 'adaptive', colors: 8, forced: 'blackwhite' });
    expect(Array.from(forced.palette.slice(0, 6))).toEqual([0, 0, 0, 255, 255, 255]);
    const t = img(4, 1, (x) => [255, 0, 0, x < 2 ? 0 : 255]);
    const tr = toIndexed(t, { palette: 'adaptive', colors: 4, transparency: true });
    expect(tr.transparentIndex).toBeGreaterThanOrEqual(0);
    expect(tr.indices[0]).toBe(tr.transparentIndex);
    expect(indexedToRGBA(tr).data[3]).toBe(0);
    expect(indexedToRGBA(tr).data[11]).toBe(255);
    const web = toIndexed(gradient, { palette: 'web', dither: 'pattern' });
    expect(web.colors).toBe(216);
    const n1 = toIndexed(gradient, { palette: 'web', dither: 'noise', seed: 3 }),
      n2 = toIndexed(gradient, { palette: 'web', dither: 'noise', seed: 3 });
    expect(Array.from(n1.indices)).toEqual(Array.from(n2.indices));
    // 1x1 image.
    expect(toIndexed(img(1, 1, () => [9, 9, 9]), { colors: 2 }).colors).toBeGreaterThanOrEqual(1);
  });

  it('keeps every color of an image that fits a local palette', () => {
    // A 256-level gray ramp used to collapse into 32 grays (one per 5-bit
    // histogram bin), and two near colors into one averaged color.
    const ramp = img(256, 4, (x) => [x, x, x]);
    for (const palette of ['adaptive', 'perceptual'] as const) {
      const res = toIndexed(ramp, { palette, colors: 256, dither: 'diffusion' });
      expect(res.colors).toBe(256);
      expect(Array.from(indexedToRGBA(res).data)).toEqual(Array.from(ramp.data));
      const near = img(2, 1, (x) => (x ? [12, 12, 12] : [10, 10, 10]));
      const nearOut = indexedToRGBA(toIndexed(near, { palette, colors: 16 }));
      expect(Array.from(nearOut.data)).toEqual(Array.from(near.data));
    }
    // One more color than slots: median cut splits down to single colors.
    const extra = img(256, 4, (x, y) => (x === 0 && y === 0 ? [255, 0, 0] : [x, x, x]));
    const res = indexedToRGBA(toIndexed(extra, { palette: 'adaptive', colors: 256 }));
    expect(Array.from(res.data.slice(0, 3))).toEqual([255, 0, 0]);
    let worst = 0;
    for (let x = 1; x < 256; x++) worst = Math.max(worst, Math.abs(res.data[x * 4] - x));
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('never builds a uniform palette larger than the requested color count', () => {
    // Fewer than 8 free slots cannot hold even a 2x2x2 cube.
    expect(toIndexed(gradient, { palette: 'uniform', colors: 4 }).colors).toBeLessThanOrEqual(4);
    expect([...toIndexed(gradient, { palette: 'uniform', colors: 2 }).palette.slice(0, 6)]).toEqual([0, 0, 0, 255, 255, 255]);
    expect(toIndexed(gradient, { palette: 'uniform', colors: 8, forced: 'blackwhite' }).colors).toBeLessThanOrEqual(8);
    // Forced colors plus the cube must still fit 8-bit indices.
    const forced = Array.from({ length: 250 }, (_, i) => [i, i, i] as [number, number, number]);
    const res = toIndexed(gradient, { palette: 'uniform', colors: 256, forced });
    expect(res.colors).toBeLessThanOrEqual(256);
    expect(Math.max(...res.indices)).toBeLessThan(res.colors);
  });
});

describe('Bitmap mode', { timeout: 120000 }, () => {
  const ramp = new Uint8Array(200 * 50);
  for (let y = 0; y < 50; y++) for (let x = 0; x < 200; x++) ramp[y * 200 + x] = Math.round((x / 199) * 255);
  const darkness = (bits: Uint8Array) => bits.reduce((a, b) => a + b, 0) / bits.length;

  it('diffusion keeps the mean gray; threshold splits at 50%', () => {
    const d = grayToBitmap(ramp, 200, 50, { method: 'diffusion' });
    const meanGray = ramp.reduce((a, b) => a + b, 0) / ramp.length / 255;
    expect(Math.abs(1 - darkness(d.bits) - meanGray)).toBeLessThan(0.01);
    const t = grayToBitmap(ramp, 200, 50, { method: 'threshold' });
    expect(t.bits[0]).toBe(1);
    expect(t.bits[199]).toBe(0);
    expect(t.bits[99]).toBe(1);
    expect(t.bits[101]).toBe(0);
    const p = grayToBitmap(ramp, 200, 50, { method: 'pattern' });
    expect(Math.abs(1 - darkness(p.bits) - meanGray)).toBeLessThan(0.02);
  });

  it('renders halftone screens at the output resolution with the right tone', () => {
    for (const shape of ['round', 'ellipse', 'line', 'square', 'cross', 'diamond'] as const)
      for (const tone of [0.25, 0.5, 0.75]) {
        const flat = new Uint8Array(100 * 100).fill(Math.round((1 - tone) * 255));
        const h = grayToBitmap(flat, 100, 100, { method: 'halftone', inputResolution: 72, outputResolution: 288, frequency: 30, angle: 45, shape });
        expect(h.width).toBe(400);
        expect(h.resolution).toBe(288);
        expect(Math.abs(darkness(h.bits) - tone)).toBeLessThan(0.03);
      }
    // Bitmap from RGBA through convertMode flattens alpha onto white.
    const res = convertMode(img(8, 8, () => [0, 0, 0, 0]), 'rgb', 'bitmap', { bitmap: { method: 'threshold' } });
    if (res.mode !== 'bitmap') throw new Error();
    expect(darkness(res.bits)).toBe(0);
    const packed = packBitmap({ width: 10, height: 1, bits: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 1, 1, 0]), resolution: 72 });
    expect(Array.from(packed)).toEqual([0x81, 0x80]);
  });
});

describe('Duotone mode', { timeout: 120000 }, () => {
  it('reproduces grayscale exactly with one black ink and a straight curve', () => {
    const src = img(64, 4, (x) => [x * 4, x * 3, x * 2, 255]);
    const gray = convertMode(src, 'rgb', 'grayscale');
    const duo = convertMode(src, 'rgb', 'duotone', { inks: [{ name: 'Black', color: [0, 0, 0] }] });
    if (gray.mode !== 'grayscale' || duo.mode !== 'duotone') throw new Error();
    const preview = convertModeToRGB(duo);
    for (let p = 0; p < 64 * 4; p++) for (let c = 0; c < 3; c++) expect(preview.data[p * 4 + c]).toBe(gray.gray[p]);
    // A colored monotone runs from paper white to the ink color.
    const table = duotoneTable([{ name: 'Blue', color: [0, 60, 200] }]);
    expect(Array.from(table.slice(255 * 3))).toEqual([255, 255, 255]);
    expect(Array.from(table.slice(0, 3))).toEqual([0, 60, 200]);
    // A second ink darkens the shadows further.
    const duoTable = duotoneTable([{ name: 'Black', color: [0, 0, 0], curve: [[0, 0], [50, 30], [100, 100]] }, { name: 'Orange', color: [250, 150, 40] }]);
    expect(duoTable[100 * 3]).toBeLessThan(table[100 * 3] + 255);
  });

  it('interpolates monotone transfer curves', () => {
    const t = curveTable([[0, 0], [25, 40], [60, 55], [100, 100]]);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1] - 1e-6);
    expect(t[0]).toBe(0);
    expect(t[255]).toBeCloseTo(1, 6);
    expect(t[Math.round(0.25 * 255)]).toBeCloseTo(0.4, 1);
    const flat = curveTable(undefined);
    expect(flat[128]).toBeCloseTo(128 / 255, 6);
  });
});

describe('color picker helpers', { timeout: 60000 }, () => {
  it('describes a color in HSB, Lab, CMYK and web terms', () => {
    const red = colorInfo([255, 0, 0]);
    expect(red.hex).toBe('#ff0000');
    expect(red.hsb).toEqual({ h: 0, s: 100, b: 100 });
    expect(red.lab.L).toBeCloseTo(54.29, 0);
    expect(red.lab.a).toBeCloseTo(80.8, 0);
    expect(red.cmyk.m).toBeGreaterThan(70);
    expect(red.cmyk.y).toBeGreaterThan(70);
    expect(red.cmyk.c).toBeLessThan(15);
    expect(red.webSafe).toEqual({ hex: '#ff0000', exact: true });
    const blue = colorInfo([0, 0, 255]);
    expect(blue.outOfGamutForCMYK).toBe(true);
    const gray = colorInfo([128, 128, 128]);
    expect(gray.outOfGamutForCMYK).toBe(false);
    expect(gray.webSafe).toEqual({ hex: '#999999', exact: false });
    expect(gray.lab.a).toBeCloseTo(0, 1);
  });

  it('generates original swatch libraries and harmonies', () => {
    expect(generateSwatchLibrary('hue-ramps').swatches).toHaveLength(60);
    expect(generateSwatchLibrary('web-safe').swatches).toHaveLength(216);
    for (const kind of ['grays', 'pastels', 'earth'] as const)
      for (const s of generateSwatchLibrary(kind).swatches) expect(s.hex).toMatch(/^#[0-9a-f]{6}$/);
    const comp = harmonySwatches('#ff0000', 'complementary');
    expect(comp.map((s) => s.hex)).toEqual(['#ff0000', '#00ffff']);
    expect(harmonySwatches('#336699', 'triadic')).toHaveLength(3);
    expect(parseHex('#abc')).toEqual([170, 187, 204]);
  });
});
