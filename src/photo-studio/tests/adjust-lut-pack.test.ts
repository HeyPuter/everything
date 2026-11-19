import { describe, expect, it } from 'vitest';
import { curveEntries, packLut, type CompiledLut } from '../src/renderer/lut-shaders';
import { compileSpec, specAdjustment, adjustmentLayerName } from '../src/features/adjust/compile';
import { applyAdjustment, ADJUSTMENT_KINDS, isSpatialKind, defaultParams, type Adjustment } from '../src/imaging/adjust';
import { randomImage, rampImage, sampleAdjustment } from './adjust-fixtures';
import type { RGBA8 } from '../src/imaging/types';

// CPU emulation of glLutFragment / wgslLut over a packed texture: fetches use
// integer texel coordinates exactly like texelFetch/textureLoad.
function shade(p: ReturnType<typeof packLut>, rgb: [number, number, number]): [number, number, number] {
  const { width, data, uniforms: u } = p;
  const fetch = (x: number, y: number, c: number) => data[(y * width + x) * 4 + c];
  const curveAt = (v: number, c: number, row: number) => {
    const x = Math.min(1, Math.max(0, v)) * (curveEntries - 1),
      i = Math.floor(x);
    return fetch(i, row, c) + (fetch(Math.min(i + 1, curveEntries - 1), row, c) - fetch(i, row, c)) * (x - i);
  };
  let c = [...rgb];
  if (u[0] > 0.5) c = [curveAt(c[0], 0, 0), curveAt(c[1], 1, 0), curveAt(c[2], 2, 0)];
  const n = u[2];
  if (u[1] > 0.5) {
    const tap = (r: number, g: number, b: number, k: number) => fetch(r + b * n, 1 + g, k);
    const x = c.map((v) => Math.min(1, Math.max(0, v)) * (n - 1));
    const i = x.map(Math.floor),
      f = x.map((v, k) => v - i[k]),
      j = i.map((v) => Math.min(v + 1, n - 1));
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    c = [0, 1, 2].map((k) => {
      const c00 = lerp(tap(i[0], i[1], i[2], k), tap(j[0], i[1], i[2], k), f[0]);
      const c10 = lerp(tap(i[0], j[1], i[2], k), tap(j[0], j[1], i[2], k), f[0]);
      const c01 = lerp(tap(i[0], i[1], j[2], k), tap(j[0], i[1], j[2], k), f[0]);
      const c11 = lerp(tap(i[0], j[1], j[2], k), tap(j[0], j[1], j[2], k), f[0]);
      return lerp(lerp(c00, c10, f[1]), lerp(c01, c11, f[1]), f[2]);
    });
  }
  if (u[1] > 1.5) c = [curveAt(c[0], 0, n + 1), curveAt(c[1], 1, n + 1), curveAt(c[2], 2, n + 1)];
  if (u[4] > 0.5) c = c.map((v) => (v >= u[5] ? 1 : 0));
  return c.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number];
}

function gpuApply(src: RGBA8, adj: Adjustment): RGBA8 {
  const packed = packLut(compileSpec({ kind: adj.kind, params: adj.params as unknown as Record<string, unknown> })!);
  const out = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  for (let i = 0; i < src.data.length; i += 4) {
    const v = shade(packed, [src.data[i] / 255, src.data[i + 1] / 255, src.data[i + 2] / 255]);
    out.data[i] = v[0] * 255;
    out.data[i + 1] = v[1] * 255;
    out.data[i + 2] = v[2] * 255;
  }
  return out;
}
function maxDiff(a: RGBA8, b: RGBA8) {
  let m = 0;
  for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) m = Math.max(m, Math.abs(a.data[i] - b.data[i]));
  return m;
}
function meanDiff(a: RGBA8, b: RGBA8) {
  let s = 0;
  for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) s += Math.abs(a.data[i] - b.data[i]);
  return s / ((a.data.length * 3) / 4);
}

describe('packLut', () => {
  it('lays out curves, the 3D atlas and post curves in separate rows', () => {
    const n = 3;
    const lut = new Float32Array(n * n * n * 4);
    for (let b = 0, k = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++, k += 4) lut.set([r / 2, g / 2, b / 2, 1], k);
    const ramp = (f: (x: number) => number) => Float32Array.from({ length: 5 }, (_, i) => f(i / 4));
    const p = packLut({
      curves: { r: ramp((x) => x), g: ramp((x) => x * x), b: ramp((x) => 1 - x) },
      lut3d: { size: n, data: lut },
      postCurves: { r: ramp((x) => 1 - x), g: ramp((x) => x), b: ramp(() => 0.25) },
    });
    expect(p.width).toBe(curveEntries);
    expect(p.height).toBe(1 + n + 1);
    expect([...p.uniforms]).toEqual([1, 2, 3, 0, 0, 0, 0, 0]);
    // Row 0 resamples the 5-entry curves at 1024 points.
    const at = (x: number, y: number, c: number) => p.data[(y * p.width + x) * 4 + c];
    expect(at(0, 0, 2)).toBeCloseTo(1);
    expect(at(curveEntries - 1, 0, 1)).toBeCloseTo(1);
    expect(at(511, 0, 0)).toBeCloseTo(511 / 1023, 5);
    // Atlas: x = r + b * n, y = 1 + g.
    expect([at(2 + 1 * n, 1 + 0, 0), at(2 + 1 * n, 1 + 0, 1), at(2 + 1 * n, 1 + 0, 2)]).toEqual([1, 0, 0.5]);
    expect(at(0 + 2 * n, 1 + 2, 1)).toBe(1);
    // Post row.
    expect(at(0, n + 1, 0)).toBeCloseTo(1);
    expect(at(700, n + 1, 2)).toBeCloseTo(0.25);
  });
  it('keeps the original layout and flags without post curves', () => {
    const p = packLut({ lut3d: { size: 2, data: new Float32Array(32).fill(1) } });
    expect(p.height).toBe(3);
    expect([...p.uniforms]).toEqual([0, 1, 2, 0, 0, 0, 0, 0]);
    expect(packLut({}).height).toBe(1);
  });
  it('folds post curves into the first row when there is no 3D table', () => {
    const id = Float32Array.from([0, 1]);
    const p = packLut({ curves: { r: Float32Array.from([1, 0]), g: id, b: id }, postCurves: { r: Float32Array.from([0, 0.5]), g: id, b: Float32Array.from([1, 1]) } });
    expect(p.height).toBe(1);
    expect([...p.uniforms]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(p.data[0]).toBeCloseTo(0.5); // r: post(1 - 0) = 0.5
    expect(p.data[(curveEntries - 1) * 4]).toBeCloseTo(0);
    expect(p.data[2]).toBe(1);
  });
  it('rejects malformed tables', () => {
    expect(() => packLut({ lut3d: { size: 3, data: new Float32Array(10) } })).toThrow();
    const bad: CompiledLut = { curves: { r: new Float32Array(1), g: new Float32Array(2), b: new Float32Array(2) } };
    expect(() => packLut(bad)).toThrow();
  });
});

describe('compiled adjustment layers on the GPU path', () => {
  const img = randomImage(48, 32, 7);
  it('match the exact CPU path for every kind', () => {
    for (const kind of ADJUSTMENT_KINDS.filter((k) => !isSpatialKind(k))) {
      const adj = sampleAdjustment(kind);
      if (kind === 'gradient-map') (adj.params as { dither: boolean }).dither = false;
      const exact = applyAdjustment(img, adj),
        gpu = gpuApply(img, adj);
      expect(meanDiff(exact, gpu), kind).toBeLessThan(1.2);
      // Threshold compares its edge exactly: no gray pixels, no flips.
      expect(maxDiff(exact, gpu), kind).toBeLessThanOrEqual(kind === 'threshold' ? 0 : 6);
    }
  });
  it('render Threshold and Gradient Map exactly with post curves', () => {
    const ramp = rampImage();
    for (const level of [1, 77, 128, 200, 255]) {
      const adj: Adjustment = { kind: 'threshold', params: { level } };
      const exact = applyAdjustment(ramp, adj),
        gpu = gpuApply(ramp, adj);
      let wrong = 0;
      for (let i = 0; i < ramp.data.length; i += 4) if (exact.data[i] !== gpu.data[i]) wrong++;
      expect(wrong, `level ${level}`).toBe(0);
    }
    const gm: Adjustment = {
      kind: 'gradient-map',
      params: {
        gradient: { stops: [{ location: 0, color: [0, 0, 255] }, { location: 0.5, color: [255, 0, 0], midpoint: 0.2 }, { location: 1, color: [255, 255, 0] }] },
        reverse: false,
        dither: false,
      },
    };
    expect(maxDiff(applyAdjustment(ramp, gm), gpuApply(ramp, gm))).toBeLessThanOrEqual(1);
  });
  it('keep Threshold black and white where luma sits next to the edge', () => {
    // Luma 109.51 is 0.01 level above the edge of level 110 (109.5): a table
    // entry spans 0.25 levels, which used to give gray (83) here.
    const px = { width: 1, height: 1, data: new Uint8ClampedArray([102, 102, 206, 255]) };
    const adj: Adjustment = { kind: 'threshold', params: { level: 110 } };
    expect([...gpuApply(px, adj).data]).toEqual([...applyAdjustment(px, adj).data]);
    expect([...gpuApply(px, adj).data]).toEqual([255, 255, 255, 255]);
    let gray = 0;
    const img = randomImage(128, 128, 11);
    for (const level of [2, 64, 110, 128, 191, 255]) {
      const out = gpuApply(img, { kind: 'threshold', params: { level } });
      for (let i = 0; i < out.data.length; i++) if (i % 4 !== 3 && out.data[i] % 255) gray++;
    }
    expect(gray).toBe(0);
  });
  it('compose the composite curve before the channel curves', () => {
    const p = defaultParams('levels');
    p.rgb.inWhite = 128; // doubles
    p.r.outWhite = 128; // halves red afterwards
    const out = gpuApply({ width: 1, height: 1, data: new Uint8ClampedArray([100, 100, 100, 255]) }, { kind: 'levels', params: p });
    expect(out.data[0]).toBeCloseTo(100, -0.5);
    expect(out.data[1]).toBeCloseTo(200, -0.5);
  });
  it('return null for identity and unknown kinds', () => {
    expect(compileSpec({ kind: 'levels', params: defaultParams('levels') as unknown as Record<string, unknown> })).toBeNull();
    expect(compileSpec({ kind: 'mystery', params: {} })).toBeNull();
  });
});

describe('specAdjustment', () => {
  it('fills missing and mistyped fields from defaults', () => {
    const adj = specAdjustment({ kind: 'levels', params: { rgb: { inBlack: 20, gamma: 'x' } } })!;
    expect(adj.kind).toBe('levels');
    const p = adj.params as ReturnType<typeof defaultParams<'levels'>>;
    expect(p.rgb).toEqual({ inBlack: 20, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
    expect(p.g.inWhite).toBe(255);
  });
  it('keeps optional curve values, look sources and opacity stops', () => {
    const values = Array.from({ length: 256 }, (_, i) => 255 - i);
    const c = specAdjustment({ kind: 'curves', params: { rgb: { mode: 'pencil', points: [[0, 0], [255, 255]], values } } })!;
    expect((c.params as { rgb: { values: number[] } }).rgb.values).toEqual(values);
    const l = specAdjustment({ kind: 'color-lookup', params: { source: { type: 'builtin', id: 'faded' }, amount: 50 } })!;
    expect(l.params).toEqual({ source: { type: 'builtin', id: 'faded' }, amount: 50 });
    const g = specAdjustment({ kind: 'gradient-map', params: { gradient: { stops: [], opacityStops: [] } } })!;
    expect((g.params as { gradient: { stops: unknown[] } }).gradient.stops.length).toBe(2);
  });
  it('names layers uniquely', () => {
    expect(adjustmentLayerName('levels', ['Levels 1', 'Curves 1'])).toBe('Levels 2');
    expect(adjustmentLayerName('black-white', [])).toBe('Black & White 1');
  });
});
