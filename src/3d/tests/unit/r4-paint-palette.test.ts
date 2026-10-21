import { describe, it, expect } from 'vitest';
import { extractColors, joinColors, moveColor, paletteColor, sortColors, type PaletteColor } from '../../src/paint/palettemath';
import { strokePoints } from '../../src/paint/strokemath';

const cols = (...c: [number, number, number][]): PaletteColor[] => c.map((x) => paletteColor(x));
const rgb = (p: PaletteColor[]) => p.map((c) => c.color.map((x) => Math.round(x * 100) / 100));

describe('palette sorting', () => {
  const set = cols([1, 0, 0], [0, 0, 1], [0, 1, 0], [0.2, 0.2, 0.2], [1, 1, 1], [0.5, 0.1, 0.9]);
  it('HSV: hue up, then saturation up, then value down', () => {
    expect(rgb(sortColors(set, 'HSV'))).toEqual([
      [1, 1, 1],
      [0.2, 0.2, 0.2],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.5, 0.1, 0.9],
    ]);
  });
  it('SVH: saturation up, then value down, then hue up', () => {
    expect(rgb(sortColors(set, 'SVH'))).toEqual([
      [1, 1, 1],
      [0.2, 0.2, 0.2],
      [0.5, 0.1, 0.9],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });
  it('VHS: value down, then hue up, then saturation up', () => {
    expect(rgb(sortColors(set, 'VHS'))).toEqual([
      [1, 1, 1],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.5, 0.1, 0.9],
      [0.2, 0.2, 0.2],
    ]);
  });
  it('LUMINANCE: brightest first', () => {
    const s = sortColors(set, 'LUMINANCE');
    expect(rgb(s)[0]).toEqual([1, 1, 1]);
    expect(rgb(s)[1]).toEqual([0, 1, 0]);
    expect(rgb(s).at(-1)).toEqual([0, 0, 1]);
  });
});

describe('palette editing', () => {
  it('moves colors and clamps at the ends', () => {
    const p = cols([1, 0, 0], [0, 1, 0], [0, 0, 1]);
    expect(moveColor(p, 0, 'UP')).toBe(0);
    expect(moveColor(p, 0, 'DOWN')).toBe(1);
    expect(rgb(p)[1]).toEqual([1, 0, 0]);
    expect(moveColor(p, 2, 'DOWN')).toBe(2);
  });
  it('joins without duplicates', () => {
    const a = cols([1, 0, 0], [0, 1, 0]);
    expect(joinColors(a, cols([0, 1, 0], [0, 0, 1]))).toBe(1);
    expect(a.length).toBe(3);
  });
});

describe('palette extraction', () => {
  // 8-bit sRGB pixels: red, green, blue, red, two close greys, yellow, black
  const px = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 128, 128, 128, 255, 131, 128, 128, 255, 230, 230, 26, 255, 0, 0, 0, 255];
  it('merges near colors at a low threshold and keeps them apart at a high one', () => {
    expect(extractColors(px, 1).length).toBe(6);
    expect(extractColors(px, 3).length).toBe(7);
  });
  it('returns linear colors rounded down in display space', () => {
    const c = extractColors(px, 1);
    // pure red rounds down to 0.9 display, i.e. about 0.787 linear
    const red = c.find((x) => x.color[1] === 0 && x.color[2] === 0 && x.color[0] > 0)!;
    expect(red.color[0]).toBeCloseTo(0.787, 2);
    // mid grey 128/255 → 0.5 display → 0.214 linear
    expect(c.some((x) => Math.abs(x.color[0] - 0.214) < 0.002 && Math.abs(x.color[1] - 0.214) < 0.002)).toBe(true);
  });
  it('skips transparent pixels', () => {
    expect(extractColors([10, 20, 30, 0, 40, 50, 60, 0], 2)).toEqual([]);
  });
});

describe('scripted stroke points', () => {
  it('converts region coordinates (y up) and projects 3D locations', () => {
    const pts = strokePoints(
      [{ mouse: [10, 20], pressure: 0.5 }, { location: [1, 2, 3] }, { mouse: [0, 0], location: [9, 9, 9] }],
      100,
      (p) => (p[0] === 9 ? null : { x: p[0] * 10, y: p[1] * 10, z: 0 }),
    );
    expect(pts).toEqual([
      { x: 10, y: 80, pressure: 0.5 },
      { x: 10, y: 20, pressure: 1 },
    ]);
  });
});

import { colorJitterOn, colorJitterer, seededRandom } from '../../src/paint/paintmath';

describe('randomize color', () => {
  it('is off without amounts and varies the color within its limits', () => {
    expect(colorJitterOn({ use_color_jitter: true })).toBe(false);
    const j = { use_color_jitter: true, value_jitter: 0.2 };
    expect(colorJitterOn(j)).toBe(true);
    const f = colorJitterer(j, seededRandom(7));
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const c = f([0.5, 0.25, 0.25], 1);
      // value only: hue and saturation are kept
      expect(c[1] / c[0]).toBeCloseTo(0.5, 5);
      expect(c[0]).toBeGreaterThanOrEqual(0.3 - 1e-6);
      expect(c[0]).toBeLessThanOrEqual(0.7 + 1e-6);
      seen.add(Math.round(c[0] * 1000));
    }
    expect(seen.size).toBeGreaterThan(5);
  });
  it('a per-stroke pick stays the same for every dab, pressure scales it', () => {
    const f = colorJitterer({ use_color_jitter: true, hue_jitter: 0.5, use_stroke_random_hue: true }, seededRandom(3));
    const a = f([1, 0, 0], 1),
      b = f([1, 0, 0], 1);
    expect(a).toEqual(b);
    const g = colorJitterer({ use_color_jitter: true, value_jitter: 1, use_random_press_val: true }, seededRandom(3));
    expect(g([0.5, 0.5, 0.5], 0)).toEqual([0.5, 0.5, 0.5]);
  });
});
