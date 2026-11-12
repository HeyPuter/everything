import { describe, expect, it } from 'vitest';
import { filtersA } from '../src/imaging/filters/index-a';
import { filterMargin } from '../src/features/filters/catalog';
import { flattenPath, kernelConvolve, kernelRows, shapeKernel } from '../src/imaging/filters/shape-blur';
import { linearFilterRGBA, sample, type Plane } from '../src/imaging/filters/common';
import { fieldSigma, pathSegments, spinArc } from '../src/imaging/filters/gallery-blur';
import { convertChannels, hsbToRgb, hslToRgb, rgbToHsb, rgbToHsl } from '../src/imaging/filters/channels-hsb';
import { builtinShapes } from '../src/model/shape-library';
import { defaults, mask8, rgba8, type OperationContext, type ParamValues, type RGBA8 } from '../src/imaging/types';

const ctx: OperationContext = { foreground: [0, 0, 0], background: [255, 255, 255], seed: 3 };
const op = (id: string) => filtersA.find((f) => f.id === id)!;
const run = (id: string, src: RGBA8, params: ParamValues = {}, c = ctx) => op(id).apply(src, { ...defaults(op(id)), ...params }, c) as RGBA8;
function noise(w: number, h: number, seed: number): RGBA8 {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < d.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    d[i] = (i & 3) === 3 ? 255 : s >>> 24;
  }
  return { width: w, height: h, data: d };
}
const at = (img: RGBA8, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe('shape blur', () => {
  it('flattens absolute and relative path commands into closed contours', () => {
    const square = flattenPath('M0 0H10V10H0Z');
    expect(square).toEqual([[[0, 0], [10, 0], [10, 10], [0, 10]]]);
    const rel = flattenPath('m5 5l10 0l0 10l-10 0z');
    expect(rel[0]).toEqual([[5, 5], [15, 5], [15, 15], [5, 15]]);
    const curve = flattenPath('M0 0C0 10 10 10 10 0Z', 8);
    expect(curve[0].length).toBe(9);
    expect(curve[0][8]).toEqual([10, 0]);
    for (const s of builtinShapes) expect(flattenPath(s.d).length).toBeGreaterThan(0);
  });

  it('kernels are normalized and follow the shape (a ring has a hole)', () => {
    const ring = builtinShapes.find((s) => s.id === 'ring')!;
    const k = shapeKernel(ring.d, 20);
    expect(k.size).toBe(41);
    expect(k.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(k.weights[20 * 41 + 20]).toBe(0); // center of the hole
    expect(k.weights[20 * 41 + 2]).toBeGreaterThan(0); // on the ring
  });

  it('span convolution matches a direct convolution', () => {
    const w = 23, h = 17, k = shapeKernel(builtinShapes.find((s) => s.id === 'star')!.d, 4);
    const src = new Float32Array(w * h).map((_, i) => (i * 37) % 101);
    const fast = kernelConvolve(src, new Float32Array(w * h), w, h, k);
    const r = (k.size - 1) / 2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let j = 0; j < k.size; j++)
          for (let i = 0; i < k.size; i++) {
            const sx = Math.min(w - 1, Math.max(0, x + i - r)), sy = Math.min(h - 1, Math.max(0, y + j - r));
            acc += k.weights[j * k.size + i] * src[sy * w + sx];
          }
        expect(fast[y * w + x]).toBeCloseTo(acc, 2);
      }
  });

  it('sharing the sums of kernel rows above the image keeps every value bit-identical', () => {
    // The straightforward row-by-row sum, in the original order of additions.
    const reference = (src: Plane, w: number, h: number, k: ReturnType<typeof shapeKernel>) => {
      const r = (k.size - 1) / 2, pw = w + 2 * r, dst = new Float32Array(w * h);
      const prefix = new Float32Array((pw + 1) * h);
      for (let y = 0; y < h; y++) {
        let acc = 0;
        for (let i = 0; i < pw; i++) prefix[y * (pw + 1) + i + 1] = acc += src[y * w + Math.min(w - 1, Math.max(0, i - r))];
      }
      for (let y = 0; y < h; y++)
        for (const row of kernelRows(k)) {
          const sy = Math.min(h - 1, Math.max(0, y + row.dy)), p = sy * (pw + 1);
          for (const [a, b, wt] of row.spans)
            for (let x = 0; x < w; x++) dst[y * w + x] += wt * (prefix[p + b + r + 1 + x] - prefix[p + a + r + x]);
          for (const [dx, wt] of row.taps)
            for (let x = 0; x < w; x++) dst[y * w + x] += wt * src[sy * w + Math.min(w - 1, Math.max(0, x + dx))];
        }
      return dst;
    };
    for (const [id, radius, w, h] of [['star', 30, 12, 9], ['ring', 7, 40, 25], ['heart', 18, 5, 60], ['star', 3, 1, 1], ['plus', 25, 70, 3]] as const) {
      const k = shapeKernel(builtinShapes.find((s) => s.id === id)!.d, radius);
      const src = new Float32Array(w * h).map((_, i) => ((i * 7919) % 257) * 0.731);
      expect(kernelConvolve(src, new Float32Array(w * h), w, h, k)).toEqual(reference(src, w, h, k));
    }
  });

  it('a single bright pixel spreads into the shape footprint', () => {
    const src = rgba8(41, 41, [0, 0, 0, 255]);
    src.data.set([255, 255, 255, 255], (20 * 41 + 20) * 4);
    const out = run('shape-blur', src, { radius: 12, shape: 'plus' });
    // The plus covers the arms but not the corners.
    expect(at(out, 20, 10)[0]).toBeGreaterThan(0);
    expect(at(out, 10, 20)[0]).toBeGreaterThan(0);
    expect(at(out, 11, 11)[0]).toBe(0);
    expect(at(out, 20, 5)[0]).toBe(0);
    expect(filterMargin('shape-blur', { radius: 12 })).toBeGreaterThanOrEqual(13);
  });
});

describe('field, path and spin blur', () => {
  it('field blur with a zero pin returns the source; pins interpolate smoothly', () => {
    const src = noise(30, 20, 1);
    expect(Array.from(run('field-blur', src, { pins: [{ x: 0.5, y: 0.5, value: 0 }] }).data)).toEqual(Array.from(src.data));
    expect(Array.from(run('field-blur', src, { pins: [] }).data)).toEqual(Array.from(src.data));
    const s = fieldSigma(100, 10, [{ x: 0, y: 5, value: 0 }, { x: 100, y: 5, value: 20 }]);
    expect(s[5 * 100 + 1]).toBeLessThan(2);
    expect(s[5 * 100 + 98]).toBeGreaterThan(18);
    expect(s[5 * 100 + 50]).toBeGreaterThan(8);
    expect(s[5 * 100 + 50]).toBeLessThan(12);
  });

  it('field blur blurs only around the blurred pin', () => {
    const src = noise(64, 16, 2);
    const out = run('field-blur', src, { pins: [{ x: 0, y: 0.5, value: 0 }, { x: 1, y: 0.5, value: 6 }] });
    const diff = (x: number) => Math.abs(at(out, x, 8)[0] - at(src, x, 8)[0]);
    let left = 0, right = 0;
    for (let x = 0; x < 6; x++) left += diff(x);
    for (let x = 58; x < 64; x++) right += diff(x);
    expect(right).toBeGreaterThan(left * 3);
  });

  it('path blur smears along the path direction only', () => {
    // Vertical stripes: a horizontal path blurs them, a vertical one does not.
    const src = rgba8(40, 40, [0, 0, 0, 255]);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x += 4) src.data.set([255, 255, 255, 255], (y * 40 + x) * 4);
    const horizontal = run('path-blur', src, { paths: [[{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]], speed: 16 });
    const vertical = run('path-blur', src, { paths: [[{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }]], speed: 16 });
    expect(at(horizontal, 20, 20)[0]).toBeLessThan(128);
    expect(at(horizontal, 21, 20)[0]).toBeGreaterThan(20);
    expect(at(vertical, 20, 20)[0]).toBeGreaterThan(240);
    expect(at(vertical, 21, 20)[0]).toBeLessThan(10);
    const segs = pathSegments([[{ x: 0, y: 0 }, { x: 1, y: 0 }]], 100, 100, 0.5);
    expect(segs[0].strength).toBeLessThan(segs[Math.floor(segs.length / 2)].strength);
  });

  it('spin blur keeps the center and leaves the outside untouched', () => {
    const src = noise(41, 41, 7);
    const out = run('spin-blur', src, { radiusX: 20, radiusY: 20, feather: 0, angle: 40 });
    expect(at(out, 20, 20)).toEqual(at(src, 20, 20));
    expect(at(out, 0, 0)).toEqual(at(src, 0, 0));
    let changed = 0;
    for (let x = 22; x < 28; x++) if (at(out, x, 20)[0] !== at(src, x, 20)[0]) changed++;
    expect(changed).toBeGreaterThan(3);
    const arc = spinArc(20, 20, 10, 10, 5, 5, 0, 1, 0.5);
    expect(arc[10 * 20 + 10]).toBe(1);
    expect(arc[10 * 20 + 16]).toBeGreaterThan(0); // in the feather band
    expect(arc[0]).toBe(0);
  });

  it('spin blur matches filtering each channel plane on its own', () => {
    // Reference: the arc traced separately for alpha and each premultiplied color.
    const reference = (src: RGBA8, cxf: number, cyf: number, rxp: number, ryp: number, rotDeg: number, angleDeg: number, feather: number) => {
      const { width: w, height: h } = src, m = Math.min(w, h);
      const cx = cxf * w, cy = cyf * h, rx = Math.max(0.5, (rxp / 100) * m), ry = Math.max(0.5, (ryp / 100) * m);
      const rot = (rotDeg * Math.PI) / 180, cr = Math.cos(rot), sr = Math.sin(rot);
      const arc = spinArc(w, h, cx, cy, rx, ry, rot, (angleDeg * Math.PI) / 180, feather / 100);
      return linearFilterRGBA(src, (pl: Plane, dst: Plane, ww: number, hh: number) => {
        for (let y = 0; y < hh; y++)
          for (let x = 0; x < ww; x++) {
            const i = y * ww + x, a = arc[i];
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            const u = (dx * cr + dy * sr) / rx, v = (-dx * sr + dy * cr) / ry;
            const n = Math.min(128, Math.ceil(a * Math.hypot(u * rx, v * ry)));
            if (n < 1) {
              dst[i] = pl[i];
              continue;
            }
            let acc = 0;
            for (let k = 0; k <= n; k++) {
              const phi = a * (k / n - 0.5), co = Math.cos(phi), si = Math.sin(phi);
              const uu = (u * co - v * si) * rx, vv = (u * si + v * co) * ry;
              acc += sample(pl, ww, hh, cx + uu * cr - vv * sr - 0.5, cy + uu * sr + vv * cr - 0.5);
            }
            dst[i] = acc / (n + 1);
          }
        return dst;
      });
    };
    const transparent = noise(37, 29, 4);
    for (let j = 3; j < transparent.data.length; j += 4) transparent.data[j] = (j * 37) % 256;
    for (const src of [noise(37, 29, 3), transparent, noise(1, 1, 5)])
      for (const [cx, cy, rx, ry, rot, angle, feather] of [
        [0.5, 0.5, 35, 35, 0, 15, 20],
        [0.2, 0.8, 120, 40, 33, 270, 100],
        [0.5, 0.5, 200, 200, 0, 360, 0],
      ]) {
        const out = run('spin-blur', src, { center: { x: cx, y: cy }, radiusX: rx, radiusY: ry, rotation: rot, angle, feather });
        expect(Array.from(out.data)).toEqual(Array.from(reference(src, cx, cy, rx, ry, rot, angle, feather).data));
      }
  });

  it('respects the selection', () => {
    const src = noise(20, 20, 9);
    const sel = mask8(20, 20);
    for (let i = 0; i < 200; i++) sel.data[i] = 255;
    for (const id of ['field-blur', 'path-blur', 'spin-blur', 'shape-blur']) {
      const out = run(id, src, {}, { ...ctx, selection: sel });
      for (let y = 10; y < 20; y++) for (let x = 0; x < 20; x++) expect(at(out, x, y)).toEqual(at(src, x, y));
    }
  });
});

describe('HSB/HSL', () => {
  it('converts single colors', () => {
    expect(rgbToHsb(1, 0, 0)).toEqual([0, 1, 1]);
    expect(rgbToHsl(0, 0, 1)[0]).toBeCloseTo(2 / 3);
    expect(hsbToRgb(1 / 3, 1, 1).map((v) => Math.round(v * 255))).toEqual([0, 255, 0]);
    expect(hslToRgb(0, 0, 0.5).map((v) => Math.round(v * 255))).toEqual([128, 128, 128]);
  });

  it('round-trips through HSB and HSL (8-bit hue steps cost a few levels)', () => {
    const src = noise(16, 16, 4);
    for (const m of ['hsb', 'hsl']) {
      const there = run('hsb-hsl', src, { input: 'rgb', output: m });
      const back = run('hsb-hsl', there, { input: m, output: 'rgb' });
      for (let i = 0; i < src.data.length; i++) expect(Math.abs(back.data[i] - src.data[i])).toBeLessThanOrEqual(i % 4 === 3 ? 0 : 5);
    }
    expect(convertChannels(10, 20, 30, 'hsb', 'hsb')).toEqual([10, 20, 30]);
  });
});
