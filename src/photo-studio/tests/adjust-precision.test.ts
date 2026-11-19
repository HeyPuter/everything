import { describe, expect, it } from 'vitest';
import { ADJUSTMENT_KINDS, isSpatialKind, applyAdjustment, applyCompiled, compileAdjustment, type AdjustmentKind } from '../src/imaging/adjust';
import { diffStats, randomImage, sampleAdjustment } from './adjust-fixtures';

// GPU path (curves + 33^3 trilinear LUT) against the exact CPU path on random
// images. Separable kinds compile to curves only and match exactly. Smooth
// non-separable kinds stay well below one code value on average; their worst
// pixels sit where the color function bends sharply inside one LUT cell.
// Threshold has a hard edge that a LUT cannot hold: it needs the exact path,
// or the optional post-LUT curve (compileAdjustment({ postCurves: true })).
const MAX_ERROR: Record<AdjustmentKind, number> = {
  'brightness-contrast': 0,
  levels: 0,
  curves: 0,
  exposure: 0,
  invert: 0,
  posterize: 0,
  vibrance: 4,
  'hue-saturation': 6,
  'color-balance': 3,
  'black-white': 2,
  'photo-filter': 2,
  'channel-mixer': 2,
  'color-lookup': 2,
  'gradient-map': 6,
  'selective-color': 3,
  threshold: 255,
  'light-tone': 0,
  'color-vibrance': 4,
  'clarity-dehaze': 0,
  grain: 0,
  relight: 0,
};
const EXACT_ONLY = new Set<AdjustmentKind>(['threshold']);

describe('compiled GPU path vs exact CPU path', () => {
  const images = [randomImage(256, 256, 101), randomImage(129, 77, 202)];

  // Spatial kinds have no color table (see adjust-spatial.test.ts).
  for (const kind of ADJUSTMENT_KINDS.filter((k) => !isSpatialKind(k)))
    it(`${kind}`, () => {
      const adj = sampleAdjustment(kind);
      const compiled = compileAdjustment(adj);
      if (compiled.lut3d) {
        expect(compiled.lut3d.size).toBe(33);
        expect(compiled.lut3d.data.length).toBe(33 ** 3 * 4);
      }
      if (compiled.curves) expect(compiled.curves.rgb.length).toBe(4096);
      for (const img of images) {
        const s = diffStats(applyCompiled(img, compiled), applyAdjustment(img, adj));
        if (EXACT_ONLY.has(kind)) {
          expect(compiled.approximate).toBe(true);
          continue;
        }
        expect(s.mean).toBeLessThan(kind === 'hue-saturation' || kind === 'vibrance' ? 0.5 : 0.25);
        expect(s.max).toBeLessThanOrEqual(MAX_ERROR[kind]);
      }
    });

  it('separable kinds compile to curves only', () => {
    for (const kind of ['brightness-contrast', 'levels', 'curves', 'exposure', 'invert', 'posterize'] as const) {
      const c = compileAdjustment(sampleAdjustment(kind));
      expect(c.curves).toBeDefined();
      expect(c.lut3d).toBeUndefined();
    }
  });

  it('post-LUT curves make Threshold and Gradient Map near exact', () => {
    const img = images[0];
    for (const kind of ['threshold', 'gradient-map'] as const) {
      const adj = sampleAdjustment(kind);
      const c = compileAdjustment(adj, { postCurves: true });
      expect(c.postCurves).toBeDefined();
      const s = diffStats(applyCompiled(img, c), applyAdjustment(img, adj));
      // Threshold may flip pixels whose luma is within float error of the edge.
      expect(s.mean).toBeLessThan(0.1);
      if (kind === 'gradient-map') expect(s.max).toBeLessThanOrEqual(1);
    }
  });

  it('larger LUTs are more accurate and sizes are clamped to 17..65', () => {
    const adj = sampleAdjustment('hue-saturation');
    const img = images[0];
    const exact = applyAdjustment(img, adj);
    const e17 = diffStats(applyCompiled(img, compileAdjustment(adj, { lutSize: 17 })), exact).mean;
    const e65 = diffStats(applyCompiled(img, compileAdjustment(adj, { lutSize: 65 })), exact).mean;
    expect(e65).toBeLessThan(e17);
    expect(compileAdjustment(adj, { lutSize: 5 }).lut3d!.size).toBe(17);
    expect(compileAdjustment(adj, { lutSize: 200 }).lut3d!.size).toBe(65);
  });

  it('256-entry curves are exact for 8-bit input', () => {
    const adj = sampleAdjustment('curves');
    const img = images[1];
    const s = diffStats(applyCompiled(img, compileAdjustment(adj, { curveSize: 256 })), applyAdjustment(img, adj));
    expect(s.max).toBe(0);
  });

  it('LUT layout is RGBA with red fastest', () => {
    const c = compileAdjustment({ kind: 'channel-mixer', params: { ...sampleAdjustment('channel-mixer').params, red: { r: 0, g: 0, b: 100, constant: 0 } } } as never);
    const d = c.lut3d!.data,
      n = c.lut3d!.size;
    // Grid point r=1, g=0, b=0 sits at index 1; its red output comes from blue (0).
    expect(d[4]).toBe(0);
    // Grid point r=0, g=0, b=1 sits at index n*n; its red output is 1/(n-1).
    expect(d[n * n * 4]).toBeCloseTo(1 / (n - 1), 6);
    expect(d[3]).toBe(1);
  });
});
