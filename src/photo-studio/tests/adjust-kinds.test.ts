import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_KINDS,
  applyAdjustment,
  compileAdjustment,
  defaultAdjustment,
  adjustmentEvaluator,
  defaultParams,
  evaluateAdjustment,
  isIdentityAdjustment,
  luma,
  type Adjustment,
} from '../src/imaging/adjust';
import { rgba8 } from '../src/imaging/types';
import { diffStats, randomImage, rampImage, sampleAdjustment } from './adjust-fixtures';

const lumaCode = (d: Uint8ClampedArray, i: number) => luma(d[i], d[i + 1], d[i + 2]);
// Defaults that are intentionally not identities.
const NON_IDENTITY = new Set(['invert', 'posterize', 'threshold', 'gradient-map', 'black-white', 'photo-filter', 'grain', 'relight']);

describe('default adjustments', () => {
  const img = randomImage(64, 48, 11, true);

  for (const kind of ADJUSTMENT_KINDS.filter((k) => !NON_IDENTITY.has(k)))
    it(`${kind} default is an identity`, () => {
      const adj = defaultAdjustment(kind);
      expect(adj.kind).toBe(kind);
      const out = applyAdjustment(img, adj);
      expect(diffStats(out, img).max).toBeLessThanOrEqual(1);
      expect(isIdentityAdjustment(adj)).toBe(true);
      expect(compileAdjustment(adj)).toEqual({});
    });

  it('defaults are fresh objects', () => {
    const a = defaultParams('levels'),
      b = defaultParams('levels');
    a.rgb.gamma = 2;
    expect(b.rgb.gamma).toBe(1);
  });

  it('invert maps v to 255 - v and twice is the identity', () => {
    const out = applyAdjustment(img, defaultAdjustment('invert'));
    for (let i = 0; i < img.data.length; i++)
      expect(out.data[i]).toBe((i & 3) === 3 ? img.data[i] : 255 - img.data[i]);
    expect(diffStats(applyAdjustment(out, defaultAdjustment('invert')), img).max).toBe(0);
  });

  it('posterize to 4 levels yields 0, 85, 170, 255 with rounded steps', () => {
    const out = applyAdjustment(rampImage(), defaultAdjustment('posterize'));
    const values = new Set<number>();
    for (let x = 0; x < 256; x++) values.add(out.data[x * 4]);
    expect([...values].sort((a, b) => a - b)).toEqual([0, 85, 170, 255]);
    // Thresholds sit halfway between output levels: 42.5, 127.5, 212.5.
    expect(out.data[42 * 4]).toBe(0);
    expect(out.data[43 * 4]).toBe(85);
    expect(out.data[127 * 4]).toBe(85);
    expect(out.data[128 * 4]).toBe(170);
    expect(out.data[213 * 4]).toBe(255);
    const two = applyAdjustment(rampImage(), { kind: 'posterize', params: { levels: 2 } });
    expect(two.data[127 * 4]).toBe(0);
    expect(two.data[128 * 4]).toBe(255);
  });

  it('threshold splits at the rounded luma level', () => {
    const out = applyAdjustment(rampImage(), defaultAdjustment('threshold'));
    for (let x = 0; x < 256; x++) expect(out.data[x * 4]).toBe(x >= 128 ? 255 : 0);
    const color = applyAdjustment(img, { kind: 'threshold', params: { level: 100 } });
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.round(lumaCode(img.data, i)) >= 100 ? 255 : 0;
      if (Math.abs(lumaCode(img.data, i) - 99.5) > 1e-6) expect(color.data[i]).toBe(v);
      expect(color.data[i + 1]).toBe(color.data[i]);
    }
  });

  it('black & white and the default gradient map produce luma gray', () => {
    for (const adj of [defaultAdjustment('black-white'), defaultAdjustment('gradient-map')] as Adjustment[]) {
      const out = applyAdjustment(img, adj);
      for (let i = 0; i < img.data.length; i += 4) {
        expect(Math.abs(out.data[i] - lumaCode(img.data, i))).toBeLessThanOrEqual(1);
        expect(out.data[i + 1]).toBe(out.data[i]);
        expect(out.data[i + 2]).toBe(out.data[i]);
        expect(out.data[i + 3]).toBe(img.data[i + 3]);
      }
    }
  });

  it('photo filter with preserved luminosity keeps luma close while warming', () => {
    const gray = rgba8(1, 1, [128, 128, 128, 255]);
    const out = applyAdjustment(gray, defaultAdjustment('photo-filter'));
    const [r, g, b] = out.data;
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    // Luminance is preserved in linear light; encoded luma stays within a few codes.
    expect(Math.abs(luma(r, g, b) - 128)).toBeLessThan(4);
    const noKeep = applyAdjustment(gray, { kind: 'photo-filter', params: { ...defaultParams('photo-filter'), preserveLuminosity: false } });
    expect(luma(noKeep.data[0], noKeep.data[1], noKeep.data[2])).toBeLessThan(luma(r, g, b));
  });
});

describe('known values', () => {
  const px = (r: number, g: number, b: number) => rgba8(1, 1, [r, g, b, 255]);
  const run = (adj: Adjustment, r: number, g: number, b: number) => [...applyAdjustment(px(r, g, b), adj).data.slice(0, 3)];

  it('exposure +1 stop doubles linear light', () => {
    // 0.5 linear (188 code) at +1 stop clips to white; 0.2158 linear (128) becomes 0.4316 (176).
    const adj: Adjustment = { kind: 'exposure', params: { exposure: 1, offset: 0, gamma: 1 } };
    expect(run(adj, 128, 128, 128)).toEqual([176, 176, 176]);
    expect(run(adj, 188, 188, 188)).toEqual([255, 255, 255]);
    expect(run({ kind: 'exposure', params: { exposure: 0, offset: 0, gamma: 2 } }, 128, 128, 128)[0]).toBe(
      Math.round(255 * (1.055 * Math.pow(Math.sqrt(0.2140411), 1 / 2.4) - 0.055)),
    );
  });

  it('legacy brightness adds an offset and legacy contrast pivots on mid-gray', () => {
    expect(run({ kind: 'brightness-contrast', params: { brightness: 20, contrast: 0, legacy: true } }, 100, 0, 250)).toEqual([120, 20, 255]);
    const c = run({ kind: 'brightness-contrast', params: { brightness: 0, contrast: 50, legacy: true } }, 100, 128, 200);
    expect(c[0]).toBe(Math.round(((100 / 255 - 0.5) * 2 + 0.5) * 255));
    expect(Math.abs(c[1] - 128)).toBeLessThanOrEqual(1);
  });

  it('modern brightness and contrast keep black and white fixed', () => {
    for (const params of [
      { brightness: 150, contrast: 0, legacy: false },
      { brightness: -150, contrast: 100, legacy: false },
      { brightness: 0, contrast: -50, legacy: false },
    ]) {
      const adj: Adjustment = { kind: 'brightness-contrast', params };
      expect(run(adj, 0, 255, 0)).toEqual([0, 255, 0]);
    }
    expect(run({ kind: 'brightness-contrast', params: { brightness: 60, contrast: 0, legacy: false } }, 100, 100, 100)[0]).toBeGreaterThan(100);
    const s = run({ kind: 'brightness-contrast', params: { brightness: 0, contrast: 60, legacy: false } }, 64, 192, 128);
    expect(s[0]).toBeLessThan(64);
    expect(s[1]).toBeGreaterThan(192);
  });

  it('hue/saturation master hue rotates primaries and -100 saturation desaturates', () => {
    const p = defaultParams('hue-saturation');
    p.master.hue = 120;
    expect(run({ kind: 'hue-saturation', params: p }, 255, 0, 0)).toEqual([0, 255, 0]);
    const q = defaultParams('hue-saturation');
    q.master.saturation = -100;
    expect(run({ kind: 'hue-saturation', params: q }, 200, 100, 0)).toEqual([100, 100, 100]);
    const l = defaultParams('hue-saturation');
    l.master.lightness = 100;
    expect(run({ kind: 'hue-saturation', params: l }, 10, 50, 90)).toEqual([255, 255, 255]);
  });

  it('colorize keeps luma and applies the chosen hue', () => {
    const p = defaultParams('hue-saturation');
    Object.assign(p, { colorize: true, colorizeHue: 240, colorizeSaturation: 50 });
    const [r, g, b] = run({ kind: 'hue-saturation', params: p }, 90, 140, 60);
    expect(b).toBeGreaterThan(r);
    expect(r).toBe(g);
  });

  it('channel mixer swaps channels and adds constants', () => {
    const p = defaultParams('channel-mixer');
    p.red = { r: 0, g: 0, b: 100, constant: 0 };
    p.blue = { r: 100, g: 0, b: 0, constant: 10 };
    expect(run({ kind: 'channel-mixer', params: p }, 10, 20, 30)).toEqual([30, 20, 36]);
    p.monochrome = true;
    p.gray = { r: 50, g: 50, b: 0, constant: 0 };
    expect(run({ kind: 'channel-mixer', params: p }, 10, 20, 30)).toEqual([15, 15, 15]);
  });

  it('black & white weights pick hues: a 0% red weight turns pure red black', () => {
    const p = defaultParams('black-white');
    p.reds = 0;
    p.yellows = 100;
    expect(run({ kind: 'black-white', params: p }, 255, 0, 0)).toEqual([0, 0, 0]);
    expect(run({ kind: 'black-white', params: p }, 255, 255, 0)).toEqual([255, 255, 255]);
    expect(run({ kind: 'black-white', params: p }, 77, 77, 77)).toEqual([77, 77, 77]);
  });

  it('color balance with preserved luminosity shifts color but keeps luma', () => {
    const adj: Adjustment = { kind: 'color-balance', params: { ...defaultParams('color-balance'), midtones: [50, 0, 0] } };
    const [r, g, b] = run(adj, 128, 128, 128);
    expect(r).toBeGreaterThan(g);
    expect(Math.abs(luma(r, g, b) - 128)).toBeLessThanOrEqual(1);
  });

  it('vibrance boosts muted colors more than saturated ones and leaves gray', () => {
    const adj: Adjustment = { kind: 'vibrance', params: { vibrance: 100, saturation: 0 } };
    expect(run(adj, 120, 120, 120)).toEqual([120, 120, 120]);
    const muted = run(adj, 140, 120, 160),
      vivid = run(adj, 40, 200, 60);
    const spread = (c: number[]) => Math.max(...c) - Math.min(...c);
    expect(spread(muted) / 40).toBeGreaterThan(spread(vivid) / 160);
  });

  it('selective color: relative cyan in reds lowers red only on red pixels', () => {
    const p = defaultParams('selective-color');
    p.ranges.reds.cyan = 100;
    const adj: Adjustment = { kind: 'selective-color', params: p };
    const red = run(adj, 200, 40, 40);
    expect(red[0]).toBeLessThan(200);
    expect(red.slice(1)).toEqual([40, 40]);
    expect(run(adj, 40, 40, 255)).toEqual([40, 40, 255]);
    expect(run(adj, 128, 128, 128)).toEqual([128, 128, 128]);
    // Relative: a full red channel has no cyan ink to scale; absolute adds it.
    expect(run(adj, 255, 0, 0)).toEqual([255, 0, 0]);
    p.method = 'absolute';
    expect(run(adj, 255, 0, 0)[0]).toBe(0);
  });

  it('gradient map follows stops, midpoints and reverse', () => {
    const params = defaultParams('gradient-map');
    params.gradient = {
      stops: [
        { location: 0, color: [255, 0, 0], midpoint: 0.25 },
        { location: 1, color: [0, 0, 255] },
      ],
    };
    const mid = run({ kind: 'gradient-map', params }, 64, 64, 64);
    // t = 64/255 ~ 0.25 is the midpoint, so the blend is 50 percent.
    expect(Math.abs(mid[0] - 128)).toBeLessThanOrEqual(2);
    params.reverse = true;
    expect(run({ kind: 'gradient-map', params }, 0, 0, 0)).toEqual([0, 0, 255]);
  });

  it('gradient map dither is deterministic and stays within one code', () => {
    const params = { ...defaultParams('gradient-map'), dither: true };
    const img = randomImage(40, 30, 4);
    const a = applyAdjustment(img, { kind: 'gradient-map', params });
    const b = applyAdjustment(img, { kind: 'gradient-map', params });
    expect(diffStats(a, b).max).toBe(0);
    const plain = applyAdjustment(img, { kind: 'gradient-map', params: { ...params, dither: false } });
    expect(diffStats(a, plain).max).toBeLessThanOrEqual(1);
  });

  it('works on 1x1 and odd-sized images and keeps alpha', () => {
    for (const kind of ADJUSTMENT_KINDS) {
      const img = randomImage(1, 1, 2, true);
      const out = applyAdjustment(img, defaultAdjustment(kind));
      expect(out.width).toBe(1);
      expect(out.data[3]).toBe(img.data[3]);
      const odd = randomImage(7, 3, 5, true);
      const o2 = applyAdjustment(odd, defaultAdjustment(kind));
      for (let i = 3; i < odd.data.length; i += 4) expect(o2.data[i]).toBe(odd.data[i]);
    }
  });

  it('cached and uncached evaluation match per-color evaluation', () => {
    // Few colors: the color cache stays on and sees repeats within rows.
    const palette = randomImage(37, 1, 77);
    const few = rgba8(70, 90);
    for (let p = 0; p < 70 * 90; p++) few.data.set(palette.data.subarray(((p * 7) % 37) * 4, ((p * 7) % 37) * 4 + 4), p * 4);
    for (const img of [few, randomImage(70, 90, 78)])
      for (const kind of ['hue-saturation', 'selective-color', 'curves', 'gradient-map'] as const) {
        const adj = sampleAdjustment(kind);
        const out = applyAdjustment(img, adj);
        const evaluate = adjustmentEvaluator(adj);
        expect(evaluateAdjustment(adj, 10, 20, 30)).toEqual(evaluate(10, 20, 30));
        let worst = 0;
        for (let i = 0; i < img.data.length; i += 4) {
          const e = evaluate(img.data[i], img.data[i + 1], img.data[i + 2]);
          for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out.data[i + c] - e[c]));
        }
        expect(worst).toBeLessThanOrEqual(0.5 + 1e-6);
      }
  }, 30000);

  it('treats non-finite parameters as neutral', () => {
    const img = randomImage(6, 6, 3);
    const bad = [
      { kind: 'brightness-contrast', params: { brightness: NaN, contrast: Infinity, legacy: false } },
      { kind: 'exposure', params: { exposure: NaN, offset: NaN, gamma: NaN } },
      { kind: 'vibrance', params: { vibrance: NaN, saturation: NaN } },
    ] as Adjustment[];
    for (const adj of bad) {
      const out = applyAdjustment(img, adj);
      expect(out.data.every((v) => Number.isFinite(v))).toBe(true);
      if (adj.kind !== 'brightness-contrast') expect(diffStats(out, img).max).toBe(0);
    }
  });

  it('does not modify the source', () => {
    const img = randomImage(9, 9, 6);
    const copy = new Uint8ClampedArray(img.data);
    applyAdjustment(img, defaultAdjustment('invert'));
    expect(img.data).toEqual(copy);
  });
});
