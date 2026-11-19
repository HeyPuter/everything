import { describe, expect, it } from 'vitest';
import { filtersA } from '../src/imaging/filters/index-a';
import {
  defaults,
  type OperationContext,
  type ParamValues,
  type RGBA8,
} from '../src/imaging/types';

// Filter → Blur → Edge-Preserving Blur: blurs only across differences below
// the threshold; Edge Only and Overlay Edge draw the remaining edges.
const ctx: OperationContext = { foreground: [0, 0, 0], background: [255, 255, 255], seed: 1 };
const op = filtersA.find((f) => f.id === 'edge-preserving-blur')!;
const run = (src: RGBA8, params: ParamValues) =>
  op.apply(src, { ...defaults(op), ...params }, ctx) as RGBA8;

/** A gray image from a function of the pixel position, with optional noise. */
function gray(
  w: number,
  h: number,
  f: (x: number, y: number) => number,
  noise = 0,
  alpha = 255,
): RGBA8 {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 12345;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const v = f(x, y) + ((s >>> 24) / 255 - 0.5) * 2 * noise;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(v);
      data[i + 3] = alpha;
    }
  return { width: w, height: h, data };
}
const at = (img: RGBA8, x: number, y: number) => img.data[(y * img.width + x) * 4];
function columnMean(img: RGBA8, x: number) {
  let s = 0;
  for (let y = 0; y < img.height; y++) s += at(img, x, y);
  return s / img.height;
}
function deviation(img: RGBA8, x0: number, x1: number) {
  const v: number[] = [];
  for (let y = 4; y < img.height - 4; y++) for (let x = x0; x < x1; x++) v.push(at(img, x, y));
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}

describe('Edge-Preserving Blur', () => {
  it('smooths noise below the threshold and keeps steps above it', () => {
    for (const radius of [3, 12]) {
      const src = gray(64, 40, (x) => (x < 32 ? 50 : 200), 10);
      const out = run(src, { radius, threshold: 25 });
      expect(deviation(out, 2, 28)).toBeLessThan(deviation(src, 2, 28) * 0.5);
      expect(deviation(out, 36, 62)).toBeLessThan(deviation(src, 36, 62) * 0.5);
      // Nothing bleeds across the step.
      expect(Math.abs(columnMean(out, 31) - 50)).toBeLessThan(6);
      expect(Math.abs(columnMean(out, 32) - 200)).toBeLessThan(6);
    }
  });

  it('blurs across a step smaller than the threshold', () => {
    const src = gray(40, 20, (x) => (x < 20 ? 110 : 130));
    const out = run(src, { radius: 6, threshold: 40 });
    expect(columnMean(out, 19)).toBeGreaterThan(114);
    expect(columnMean(out, 20)).toBeLessThan(126);
  });

  it('keeps alpha', () => {
    const src = gray(20, 20, (x) => x * 10, 5, 120);
    const out = run(src, { radius: 4, threshold: 20 });
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(120);
  });

  it('draws edges white on black (Edge Only) or over the blurred image (Overlay Edge)', () => {
    const src = gray(30, 12, (x) => (x < 15 ? 40 : 220));
    const edges = run(src, { radius: 2, threshold: 30, mode: 'edge' });
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 30; x++)
        expect(at(edges, x, y), `${x},${y}`).toBe(x === 14 || x === 15 ? 255 : 0);
    const normal = run(src, { radius: 2, threshold: 30 });
    const overlay = run(src, { radius: 2, threshold: 30, mode: 'overlay' });
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 30; x++)
        expect(at(overlay, x, y)).toBe(x === 14 || x === 15 ? 255 : at(normal, x, y));
    // A flat image has no edges.
    const flat = run(
      gray(10, 10, () => 128),
      { mode: 'edge' },
    );
    expect(flat.data.filter((_, i) => i % 4 !== 3).every((v) => v === 0)).toBe(true);
  });

  it('finds soft diagonal edges at the same contrast as level ones from Medium quality up', () => {
    // A 45° ramp rising 30 levels per pixel of distance: its level and
    // upright neighbors differ by only 21 levels.
    const ramp = gray(24, 24, (x, y) => 20 + ((x + y) * 30) / Math.SQRT2);
    const share = (img: RGBA8) => {
      let n = 0;
      for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) if (at(img, x, y) === 255) n++;
      return n / 16;
    };
    const params = { radius: 0.1, threshold: 25, mode: 'edge' };
    expect(share(run(ramp, { ...params, quality: 'low' }))).toBe(0);
    expect(share(run(ramp, { ...params, quality: 'medium' }))).toBe(1);
    expect(share(run(ramp, { ...params, quality: 'high' }))).toBe(1);
    // A level ramp of the same slope is an edge at every quality.
    const level = gray(24, 24, (x) => 20 + x * 30 * 0.3);
    expect(share(run(level, { radius: 0.1, threshold: 8, mode: 'edge', quality: 'low' }))).toBe(1);
  });
});
