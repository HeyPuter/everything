import { describe, expect, it } from 'vitest';
import { builtinProfile } from '../src/color/builtin-profiles';
import { colorInfo } from '../src/color/color-info';
import { duotoneTable } from '../src/color/duotone';
import { sampleLut3D } from '../src/color/transform';
import { cmykMap, composeLut, duotoneLut, duotoneMap, flattenOn, grayLevels, grayMap, labMap, mapGrid, mapHex, nearestPaletteHex, profileMap } from '../src/features/color/convert';
import { eightBit } from '../src/features/color/docops';
import { TileStore, gridFromImage, readRGBA } from '../src/model/tiles';
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
const px = (im: RGBA8, i: number) => Array.from(im.data.subarray(i * 4, i * 4 + 4));
const srgb = builtinProfile('srgb');
const gray = builtinProfile('gray-gamma-22');

describe('mode pixel mappings', { timeout: 120000 }, () => {
  it('grayscale makes every pixel neutral and keeps alpha', () => {
    const src = img(4, 3, (x, y) => [x * 80, y * 120, (x * y * 37) % 256, x === 0 && y === 0 ? 0 : 50 + x * 40]);
    const out = grayMap(srgb, gray, 'relative', true)(src);
    for (let i = 0; i < 12; i++) {
      const [r, g, b, a] = px(out, i);
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(a).toBe(src.data[i * 4 + 3]);
    }
    // White and black survive exactly; mid gray stays close.
    const ends = grayMap(srgb, gray, 'relative', true)(img(3, 1, (x) => [[255, 255, 255], [0, 0, 0], [128, 128, 128]][x]));
    expect(px(ends, 0)).toEqual([255, 255, 255, 255]);
    expect(px(ends, 1)).toEqual([0, 0, 0, 255]);
    expect(Math.abs(px(ends, 2)[0] - 128)).toBeLessThanOrEqual(2);
  });

  it('gray levels map monotonically to neutral values', () => {
    const levels = grayLevels(builtinProfile('gray-dot-gain-20'), srgb, 'relative', true);
    for (let i = 1; i < 256; i++) expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
    expect(levels[0]).toBe(0);
    expect(levels[255]).toBe(255);
  });

  it('colors converted to CMYK with black point compensation pass the gamut checks', async () => {
    const { gamutWarning } = await import('../src/color/proof');
    const cmyk = builtinProfile('generic-coated-cmyk');
    // A spread of colors: dark, muted, saturated and near white.
    const src = img(16, 16, (x, y) => [(x * 17) % 256, (y * 17) % 256, ((x + y) * 29) % 256]);
    const out = cmykMap(srgb, cmyk, 'relative', true)(src);
    // Image > Mode > CMYK Color (default settings) made these printable: the
    // gamut warning with the same settings must not flag them.
    const flagged = gamutWarning(out, srgb, cmyk, 2, true).data.filter((v) => v).length;
    expect(flagged).toBeLessThanOrEqual(2);
    for (let i = 0; i < 256; i += 7) {
      const rgb = px(out, i).slice(0, 3) as [number, number, number];
      expect(colorInfo(rgb, srgb, { cmykProfile: cmyk }).outOfGamutForCMYK).toBe(false);
    }
    // Black itself is printable (as the press's darkest black).
    expect(colorInfo([0, 0, 0], srgb, { cmykProfile: cmyk }).outOfGamutForCMYK).toBe(false);
    // Unprintable colors are still flagged.
    expect(gamutWarning(img(1, 1, () => [0, 0, 255]), srgb, cmyk, 2, true).data[0]).toBe(255);
    expect(colorInfo([0, 0, 255], srgb, { cmykProfile: cmyk }).outOfGamutForCMYK).toBe(true);
  });

  it('CMYK constrains saturated RGB to printable colors and is stable', () => {
    const cmyk = builtinProfile('generic-coated-cmyk');
    const map = cmykMap(srgb, cmyk, 'relative', true);
    const src = img(4, 1, (x) => [[0, 0, 255], [0, 255, 0], [255, 0, 255], [128, 100, 90]][x]);
    const out = map(src);
    // Pure blue and green are outside a press gamut: they change visibly.
    const blue = px(out, 0),
      green = px(out, 1);
    expect(colorInfo([0, 0, 255], srgb, { cmykProfile: cmyk }).outOfGamutForCMYK).toBe(true);
    expect(Math.abs(blue[0] - 0) + Math.abs(blue[1] - 0) + Math.abs(blue[2] - 255)).toBeGreaterThan(30);
    expect(Math.abs(green[0] - 0) + Math.abs(green[1] - 255) + Math.abs(green[2] - 0)).toBeGreaterThan(30);
    // Without black point compensation the results are printable as they
    // are (the gamut test is relative colorimetric without compensation).
    const plain = cmykMap(srgb, cmyk, 'relative', false)(src);
    for (let i = 0; i < 4; i++) {
      const rgb = px(plain, i).slice(0, 3) as [number, number, number];
      expect(colorInfo(rgb, srgb, { cmykProfile: cmyk }).cmykDeltaE).toBeLessThan(2.5);
    }
    // And a second conversion barely moves them.
    const again = map(out);
    for (let i = 0; i < 16; i++) expect(Math.abs(again.data[i] - out.data[i])).toBeLessThanOrEqual(5);
    // A muted color barely changes.
    const muted = px(out, 3);
    expect(Math.abs(muted[0] - 128) + Math.abs(muted[1] - 100) + Math.abs(muted[2] - 90)).toBeLessThan(15);
  });

  it('profile conversion keeps appearance: sRGB red is less saturated in a wide gamut space', () => {
    const p3 = builtinProfile('display-p3');
    const toP3 = profileMap(srgb, p3, 'relative', false);
    const back = profileMap(p3, srgb, 'relative', false);
    const src = img(3, 1, (x) => [[255, 0, 0], [255, 255, 255], [40, 120, 200]][x]);
    const out = toP3(src);
    expect(px(out, 0)[0]).toBeLessThan(250);
    expect(px(out, 0)[1]).toBeGreaterThan(10);
    expect(px(out, 1)).toEqual([255, 255, 255, 255]);
    const rt = back(out);
    for (let i = 0; i < 12; i++) expect(Math.abs(rt.data[i] - src.data[i])).toBeLessThanOrEqual(2);
  });

  it('Lab round trip is nearly lossless', () => {
    const src = img(8, 8, (x, y) => [x * 32, y * 32, (x + y) * 16]);
    const out = labMap(srgb, builtinProfile('lab-d50'), 'relative')(src);
    // 8-bit Lab steps are coarse only where sRGB's curve is steep next to
    // the gamut boundary (channel values near 0).
    let max = 0,
      sum = 0;
    for (let i = 0; i < src.data.length; i++) {
      const d = Math.abs(out.data[i] - src.data[i]);
      max = Math.max(max, d);
      sum += d;
    }
    expect(sum / src.data.length).toBeLessThan(1);
    expect(max).toBeLessThanOrEqual(12);
  });

  it('a single black ink with a straight curve reproduces the gray image', () => {
    const src = img(16, 1, (x) => [x * 17, x * 17, x * 17]);
    const map = duotoneMap(srgb, gray, [{ name: 'Black', color: [0, 0, 0] }]);
    const out = map(src);
    for (let i = 0; i < 16; i++) expect(Math.abs(px(out, i)[0] - i * 17)).toBeLessThanOrEqual(2);
    // Two inks: the display LUT agrees with the pixel mapping.
    const inks = [{ name: 'Black', color: [0, 0, 0] as [number, number, number] }, { name: 'Orange', color: [230, 120, 20] as [number, number, number], curve: [[0, 0], [100, 60]] as [number, number][] }];
    const lut = duotoneLut(srgb, gray, inks, 17);
    const viaPixels = duotoneMap(srgb, gray, inks)(src);
    const o = [0, 0, 0];
    for (let i = 0; i < 16; i += 5) {
      sampleLut3D(lut, (i * 17) / 255, (i * 17) / 255, (i * 17) / 255, o);
      for (let c = 0; c < 3; c++) expect(Math.abs(o[c] * 255 - px(viaPixels, i)[c])).toBeLessThanOrEqual(4);
    }
    expect(duotoneTable(inks)[255 * 3]).toBe(255);
  });

  it('composes a LUT with a transform', () => {
    const id = duotoneLut(srgb, gray, [{ name: 'K', color: [0, 0, 0] }], 9);
    const composed = composeLut(id, { outChannels: 3, apply: (i, o, n = i.length / 3) => { for (let k = 0; k < n * 3; k++) o[k] = 1 - i[k]; } });
    expect(composed.data[0]).toBeCloseTo(1 - id.data[0], 5);
    expect(composed.data[3]).toBe(1);
  });

  it('maps every tile of a grid without touching the original tiles', () => {
    const store = new TileStore();
    const src = img(300, 260, (x, y) => [x % 256, y % 256, 200, 255]);
    const grid = gridFromImage(store, src, 5, 7);
    const before = readRGBA(store, grid, { x: 5, y: 7, width: 300, height: 260 });
    const mapped = mapGrid(store, grid, (im) => ({ ...im, data: im.data.map((v, i) => (i % 4 === 3 ? v : 255 - v)) as Uint8ClampedArray }));
    expect(Object.keys(mapped.tiles)).toEqual(Object.keys(grid.tiles));
    expect(Object.values(mapped.tiles).some((id) => Object.values(grid.tiles).includes(id))).toBe(false);
    const after = readRGBA(store, mapped, { x: 5, y: 7, width: 300, height: 260 });
    expect(px(after, 0)).toEqual([255 - px(before, 0)[0], 255 - px(before, 0)[1], 55, 255]);
    expect(readRGBA(store, grid, { x: 5, y: 7, width: 300, height: 260 }).data).toEqual(before.data);
    expect(mapped.bounds).toEqual(grid.bounds);
  });

  it('maps hex colors and finds the nearest palette entry', () => {
    expect(mapHex((im) => ({ ...im, data: new Uint8ClampedArray([1, 2, 3, 255]) }), '#ffffff')).toBe('#010203');
    expect(mapHex((im) => im, 'not-a-color')).toBe('not-a-color');
    expect(nearestPaletteHex(['#000000', '#ff0000', '#ffffff'], '#e01010')).toBe('#ff0000');
    expect(nearestPaletteHex(['#000000', '#ffffff'], '#808080')).toBe('#ffffff');
  });

  it('flattens over a matte with straight alpha', () => {
    const out = flattenOn(img(2, 1, (x) => [x ? 0 : 200, 0, 0, x ? 0 : 128]), [255, 255, 255]);
    expect(px(out, 0)).toEqual([227, 127, 127, 255]);
    expect(px(out, 1)).toEqual([255, 255, 255, 255]);
  });

  it('encodes linear float samples to sRGB when reducing depth', () => {
    const f = new Float32Array([0, 0.214, 1, 1, 2, -1, 0.5, 0.5]);
    const lin = eightBit(f, 2, 1, true);
    expect(Array.from(lin.data.subarray(0, 4))).toEqual([0, 128, 255, 255]);
    expect(Array.from(lin.data.subarray(4, 8))).toEqual([255, 0, 188, 128]);
    const plain = eightBit(f, 2, 1, false);
    expect(Array.from(plain.data.subarray(0, 4))).toEqual([0, 55, 255, 255]);
  });
});
