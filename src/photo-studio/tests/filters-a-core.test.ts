import { describe, expect, it } from 'vitest';
import {
  applySelection,
  bilateralPlane,
  boxH,
  boxV,
  boxesForGauss,
  convolve2D,
  fillTransparent,
  hasTransparentIn,
  defineOp,
  gaussianPlane,
  gaussianRGBA,
  medianRGBA,
  minMaxPlane,
  minMaxRGBA,
  sanitize,
} from '../src/imaging/filters/common';
import { defaults, mask8, rgba8, type RGBA8 } from '../src/imaging/types';
import { filtersA } from '../src/imaging/filters/index-a';
import { filterMargin, selectionMargin } from '../src/features/filters/catalog';
import { aperture, apertureConvolve, motionBlurPlane } from '../src/imaging/filters/blur';

function random(w: number, h: number, seed: number, opaque = true): RGBA8 {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < d.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    d[i] = s >>> 24;
  }
  if (opaque) for (let j = 3; j < d.length; j += 4) d[j] = 255;
  return { width: w, height: h, data: d };
}
const clampi = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

describe('box and gaussian kernels', () => {
  it('running-sum box matches a brute-force clamped average', () => {
    const w = 13, h = 7, src = new Float32Array(w * h).map((_, i) => (i * 37) % 101);
    const dst = new Float32Array(w * h);
    for (const [a, b] of [[0, 0], [1, 1], [2, 5], [9, 3], [20, 20]]) {
      boxH(src, dst, w, h, a, b);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0;
          for (let k = -a; k <= b; k++) s += src[y * w + clampi(x + k, 0, w - 1)];
          expect(dst[y * w + x]).toBeCloseTo(s / (a + b + 1), 3);
        }
      boxV(src, dst, w, h, a, b);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0;
          for (let k = -a; k <= b; k++) s += src[clampi(y + k, 0, h - 1) * w + x];
          expect(dst[y * w + x]).toBeCloseTo(s / (a + b + 1), 3);
        }
    }
  });

  it('three-box widths approximate the requested variance', () => {
    for (const sigma of [5, 12.5, 50, 300]) {
      const v = boxesForGauss(sigma).reduce((s, r) => s + ((2 * r + 1) ** 2 - 1) / 12, 0);
      expect(Math.sqrt(v)).toBeGreaterThan(sigma * 0.93);
      expect(Math.sqrt(v)).toBeLessThan(sigma * 1.07);
    }
  });

  it('gaussian of an impulse keeps its mass and spreads by about sigma', () => {
    for (const sigma of [1.5, 3, 10]) {
      const w = 201, h = 1, p = new Float32Array(w);
      p[100] = 1000;
      const out = gaussianPlane(p, new Float32Array(w), w, h, sigma);
      let m = 0, v = 0;
      for (let x = 0; x < w; x++) { m += out[x]; v += out[x] * (x - 100) ** 2; }
      expect(m).toBeCloseTo(1000, 1);
      expect(Math.sqrt(v / m)).toBeCloseTo(sigma, 0);
    }
  });

  it('blurring a constant image leaves it constant, also with varying alpha', () => {
    const src = rgba8(40, 30, [90, 160, 220, 255]);
    for (let i = 0; i < 40 * 30; i++) src.data[i * 4 + 3] = 255 - ((i * 7) % 200);
    for (const sigma of [0.7, 3, 25]) {
      const out = gaussianRGBA(src, sigma);
      for (let j = 0; j < out.data.length; j += 4) {
        expect(out.data[j]).toBe(90);
        expect(out.data[j + 1]).toBe(160);
        expect(out.data[j + 2]).toBe(220);
      }
    }
  });

  it('opaque red next to transparent black does not darken', () => {
    const src = rgba8(20, 20);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) src.data.set([255, 0, 0, 255], (y * 20 + x) * 4);
    for (const sigma of [1, 6, 40]) {
      const out = gaussianRGBA(src, sigma);
      for (let j = 0; j < out.data.length; j += 4) {
        if (out.data[j + 3] === 0) continue;
        expect(out.data[j]).toBe(255);
        expect(out.data[j + 1]).toBe(0);
      }
      // Alpha spreads into the transparent half and drops on the opaque side.
      expect(out.data[(10 * 20 + 10) * 4 + 3]).toBeGreaterThan(0);
      expect(out.data[(10 * 20 + 9) * 4 + 3]).toBeLessThan(255);
    }
  });

  it('handles 1x1 and one-row images', () => {
    expect(Array.from(gaussianRGBA(rgba8(1, 1, [1, 2, 3, 4]), 30).data)).toEqual([1, 2, 3, 4]);
    const row = random(17, 1, 3);
    const out = gaussianRGBA(row, 10);
    expect(out.width).toBe(17);
    expect(out.data.every((v, i) => (i % 4 === 3 ? v === 255 : true))).toBe(true);
  });

  it('general 2-D convolution with an identity kernel is identity', () => {
    const w = 9, h = 6, src = new Float32Array(w * h).map((_, i) => i), dst = new Float32Array(w * h);
    const k = new Array(25).fill(0);
    k[12] = 1;
    convolve2D(src, dst, w, h, k, 5);
    expect(Array.from(dst)).toEqual(Array.from(src));
  });
});

describe('shaped and directional blurs', () => {
  it('aperture convolution matches a brute-force clamped sum', () => {
    const w = 17, h = 9, src = new Float32Array(w * h).map((_, i) => (i * 53) % 97), dst = new Float32Array(w * h);
    for (const [radius, blades] of [[1, 0], [3, 6], [5, 3], [12, 0]]) {
      const ap = aperture(radius, blades, 0, 10);
      apertureConvolve(src, dst, w, h, ap);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let s = 0;
          for (let dy = -ap.r; dy <= ap.r; dy++) {
            const lo = ap.spans[(dy + ap.r) * 2], hi = ap.spans[(dy + ap.r) * 2 + 1];
            for (let dx = lo; dx <= hi; dx++) s += src[clampi(y + dy, 0, h - 1) * w + clampi(x + dx, 0, w - 1)];
          }
          expect(dst[y * w + x]).toBeCloseTo(s / ap.area, 2);
        }
    }
  });

  it('motion blur keeps mass and spreads along its direction only', () => {
    const w = 81, h = 21, p = new Float32Array(w * h);
    p[10 * w + 40] = 1000;
    const out = motionBlurPlane(p, new Float32Array(w * h), w, h, 0, 30);
    let m = 0, spreadX = 0, offRow = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = out[y * w + x];
        m += v;
        spreadX = Math.max(spreadX, v > 1e-3 ? Math.abs(x - 40) : 0);
        if (y !== 10) offRow += v;
      }
    expect(m).toBeCloseTo(1000, 1);
    expect(offRow).toBeLessThan(1e-3);
    expect(spreadX).toBeGreaterThanOrEqual(14);
    expect(spreadX).toBeLessThanOrEqual(16);
  });
});

describe('order statistics', () => {
  it('van Herk min/max matches brute force for squares and discs', () => {
    const w = 23, h = 17;
    const plane = new Uint8Array(w * h).map((_, i) => (Math.imul(i + 1, 2654435761) >>> 24) & 255);
    for (const r of [1, 2, 3, 5, 12])
      for (const round of [false, true])
        for (const isMax of [false, true]) {
          const out = minMaxPlane(plane, w, h, r, isMax, round);
          const R = r + 0.5;
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              let best = isMax ? 0 : 255;
              for (let dy = -r; dy <= r; dy++)
                for (let dx = -r; dx <= r; dx++) {
                  if (round && dx * dx + dy * dy > R * R) continue;
                  const yy = y + dy, xx = x + dx;
                  if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
                  const v = plane[yy * w + xx];
                  best = isMax ? Math.max(best, v) : Math.min(best, v);
                }
              expect(out[y * w + x]).toBe(best);
            }
        }
  });

  it('maximum grows a shape without pulling black from transparent pixels', () => {
    const src = rgba8(9, 9);
    src.data.set([200, 100, 50, 255], (4 * 9 + 4) * 4);
    const out = minMaxRGBA(src, 1, true, false);
    for (let y = 3; y <= 5; y++)
      for (let x = 3; x <= 5; x++) expect(Array.from(out.data.slice((y * 9 + x) * 4, (y * 9 + x) * 4 + 4))).toEqual([200, 100, 50, 255]);
    expect(out.data[(2 * 9 + 2) * 4 + 3]).toBe(0);
    const min = minMaxRGBA(src, 1, false, false);
    expect(min.data[(4 * 9 + 4) * 4 + 3]).toBe(0);
  });

  it('Huang median matches a sorted brute force with clamped edges', () => {
    const src = random(19, 11, 7);
    for (const r of [1, 2, 4]) {
      const out = medianRGBA(src, r);
      for (let y = 0; y < src.height; y++)
        for (let x = 0; x < src.width; x++)
          for (let c = 0; c < 4; c++) {
            const vals: number[] = [];
            for (let dy = -r; dy <= r; dy++)
              for (let dx = -r; dx <= r; dx++)
                vals.push(src.data[(clampi(y + dy, 0, src.height - 1) * src.width + clampi(x + dx, 0, src.width - 1)) * 4 + c]);
            vals.sort((a, b) => a - b);
            expect(out.data[(y * src.width + x) * 4 + c]).toBe(vals[(vals.length - 1) / 2]);
          }
    }
  });

  it('weights colors by alpha and handles radii larger than the image', () => {
    const src = random(7, 5, 19, false);
    for (let j = 3; j < src.data.length; j += 4) src.data[j] = (j * 37) % 256;
    for (const r of [1, 6]) {
      const out = medianRGBA(src, r);
      for (let y = 0; y < 5; y++)
        for (let x = 0; x < 7; x++) {
          const hist = Array.from({ length: 4 }, () => new Array(256).fill(0));
          let total = 0;
          for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++) {
              const j = (clampi(y + dy, 0, 4) * 7 + clampi(x + dx, 0, 6)) * 4, a = src.data[j + 3];
              for (let c = 0; c < 3; c++) hist[c][src.data[j + c]] += a;
              hist[3][a]++;
              total += a;
            }
          for (let c = 0; c < 4; c++) {
            const T = c === 3 ? (2 * r + 1) ** 2 : total;
            let m = 0, cum = hist[c][0];
            while (2 * cum < T) cum += hist[c][++m];
            expect(out.data[(y * 7 + x) * 4 + c]).toBe(T === 0 ? src.data[(y * 7 + x) * 4 + c] : m);
          }
        }
    }
  });

  it('median ignores the color of transparent pixels', () => {
    const src = rgba8(5, 5, [0, 0, 0, 0]);
    // Only the center is visible; the transparent black majority must not win.
    src.data.set([240, 120, 60, 255], 12 * 4);
    const out = medianRGBA(src, 1);
    expect(Array.from(out.data.slice(12 * 4, 12 * 4 + 3))).toEqual([240, 120, 60]);
    expect(out.data[12 * 4 + 3]).toBe(0);
  });
});

describe('alpha helpers and selection', () => {
  it('fills transparent colors from visible neighbors and keeps their alpha', () => {
    const src = rgba8(6, 6);
    for (let i = 0; i < 18; i++) src.data.set([10, 200, 30, 255], i * 4);
    const out = fillTransparent(src);
    for (let i = 18; i < 36; i++) {
      expect(out.data[i * 4 + 3]).toBe(0);
      expect(Array.from(out.data.slice(i * 4, i * 4 + 3))).toEqual([10, 200, 30]);
    }
    const opaque = rgba8(2, 2, [1, 2, 3, 255]);
    expect(fillTransparent(opaque)).toBe(opaque);
  });

  it('applySelection keeps unselected pixels and mixes partial coverage premultiplied', () => {
    const src = rgba8(3, 1, [255, 0, 0, 255]);
    const out = rgba8(3, 1, [0, 0, 255, 0]);
    const sel = mask8(3, 1);
    sel.data.set([0, 128, 255]);
    applySelection(src, out, sel);
    expect(Array.from(out.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
    // Half toward a transparent result: still pure red, half alpha.
    expect(Array.from(out.data.slice(4, 8))).toEqual([255, 0, 0, 127]);
    expect(Array.from(out.data.slice(8, 12))).toEqual([0, 0, 255, 0]);
  });

  it('sanitizes parameters against their specs', () => {
    const p = sanitize(
      [
        { key: 'a', label: 'A', type: 'number', min: 0, max: 10, default: 5 },
        { key: 'b', label: 'B', type: 'select', options: [{ value: 'x', label: 'X' }], default: 'x' },
        { key: 'c', label: 'C', type: 'point', default: { x: 0.5, y: 0.5 } },
      ],
      { a: 99, b: 'nope' },
    );
    expect(p).toEqual({ a: 10, b: 'x', c: { x: 0.5, y: 0.5 } });
  });
});

describe('bilateral filter', () => {
  for (const sigmaS of [1, 4]) {
    it(`keeps a strong step and flattens small noise (sigmaS ${sigmaS})`, () => {
      const w = 60, h = 40, v = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) v[y * w + x] = (x < 30 ? 50 : 200) + (((x * 7 + y * 13) % 5) - 2) * 2;
      const out = bilateralPlane(v, null, w, h, sigmaS, 10);
      let noise = 0;
      for (let y = 5; y < 35; y++) {
        expect(out[y * w + 28]).toBeLessThan(60);
        expect(out[y * w + 31]).toBeGreaterThan(190);
        for (let x = 5; x < 25; x++) noise = Math.max(noise, Math.abs(out[y * w + x] - 50));
      }
      expect(noise).toBeLessThan(sigmaS > 2 ? 1.5 : 3.5);
    });
  }
});

describe('filters that fill transparent pixels, limited by a selection', () => {
  it('fillTransparent with a reach fills rings around visible pixels only', () => {
    const src = rgba8(9, 1);
    src.data.set([100, 50, 0, 255], 0);
    const out = fillTransparent(src, 3);
    for (let x = 1; x <= 3; x++) {
      expect(Array.from(out.data.slice(x * 4, x * 4 + 4))).toEqual([100, 50, 0, 0]);
    }
    expect(Array.from(out.data.slice(16, 20))).toEqual([0, 0, 0, 0]); // beyond the reach
  });

  // A layer with transparent holes and stripes; the selection sits next to a hole.
  const W = 120, H = 90;
  const layer = random(W, H, 9, false);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) layer.data[(y * W + x) * 4 + 3] = (x * 7 + y * 3) % 5 < 2 || (x > 52 && x < 70) ? 0 : 255;
  const sel = mask8(W, H);
  for (let y = 40; y < 52; y++) for (let x = 46; x < 62; x++) sel.data[y * W + x] = 255;
  const ctx = { foreground: [0, 0, 0] as [number, number, number], background: [255, 255, 255] as [number, number, number], seed: 3 };
  for (const [id, params] of [
    ['despeckle', {}],
    ['reduce-noise', { strength: 8, color: 60 }],
    ['advanced-sharpen', { radius: 2.5, amount: 300 }],
    ['find-edges', {}],
    ['trace-contour', { level: 120 }],
    ['emboss', { height: 6 }],
    ['oil-paint', { stylization: 2, scale: 1.5 }],
  ] as const) {
    it(`${id} matches the whole-layer result inside the selection, also on the session's crop`, () => {
      const op = filtersA.find((f) => f.id === id)!;
      const p = { ...defaults(op), ...params };
      const full = op.apply(layer, p, ctx) as RGBA8;
      const limited = op.apply(layer, p, { ...ctx, selection: sel }) as RGBA8;
      // The dialog loads only the selection bounds grown by the filter's
      // margin, wider here because transparent pixels are near.
      const m = selectionMargin([{ id, params: p }], (mm) => hasTransparentIn(layer, { x: 46 - mm, y: 40 - mm, width: 16 + 2 * mm, height: 12 + 2 * mm }))!;
      expect(m).toBeGreaterThanOrEqual(filterMargin(id, p)!);
      const x0 = 46 - m, y0 = 40 - m, cw = 16 + 2 * m, ch = 12 + 2 * m;
      const crop = rgba8(cw, ch), csel = mask8(cw, ch);
      for (let y = 0; y < ch; y++) {
        crop.data.set(layer.data.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x0 + cw) * 4), y * cw * 4);
        csel.data.set(sel.data.subarray((y + y0) * W + x0, (y + y0) * W + x0 + cw), y * cw);
      }
      const cropped = op.apply(crop, p, { ...ctx, selection: csel }) as RGBA8;
      let visible = 0;
      for (let y = 40; y < 52; y++)
        for (let x = 46; x < 62; x++) {
          const i = (y * W + x) * 4, k = ((y - y0) * cw + x - x0) * 4;
          if (!layer.data[i + 3]) continue;
          visible++;
          expect(Array.from(limited.data.slice(i, i + 4))).toEqual(Array.from(full.data.slice(i, i + 4)));
          expect(Array.from(cropped.data.slice(k, k + 4))).toEqual(Array.from(full.data.slice(i, i + 4)));
        }
      expect(visible).toBeGreaterThan(40);
    });
  }
});

describe('selection margins of filters that fill transparent pixels', () => {
  it('stay at the normal margin on opaque pixels and grow only next to transparency', () => {
    for (const [id, params] of [['advanced-sharpen', { radius: 64 }], ['reduce-noise', {}], ['emboss', { height: 20 }], ['find-edges', {}], ['trace-contour', {}], ['oil-paint', {}]] as const) {
      const p = { ...defaults(filtersA.find((f) => f.id === id)!), ...params };
      expect(selectionMargin([{ id, params: p }], () => false)).toBe(filterMargin(id, p));
      expect(selectionMargin([{ id, params: p }], () => true)!).toBeGreaterThan(filterMargin(id, p)!);
    }
    // Filters without a fill never ask.
    expect(selectionMargin([{ id: 'gaussian-blur', params: { radius: 4 } }], () => { throw new Error('asked'); })).toBe(filterMargin('gaussian-blur', { radius: 4 }));
  });

  it('crop the image by the normal support unless transparent pixels are inside it', () => {
    const seen: number[] = [];
    const op = defineOp({
      id: 'probe', label: 'Probe', category: 'Other', params: [],
      support: () => 5,
      fillReach: () => 5,
      run: (src) => (seen.push(src.width), src),
    });
    const W = 100, H = 60;
    const sel = mask8(W, H);
    for (let y = 20; y < 30; y++) for (let x = 40; x < 50; x++) sel.data[y * W + x] = 255;
    const ctx = { foreground: [0, 0, 0] as [number, number, number], background: [255, 255, 255] as [number, number, number], selection: sel };
    const opaque = rgba8(W, H, [50, 60, 70, 255]);
    op.apply(opaque, {}, ctx);
    // A hole outside the normal crop changes nothing; one inside it widens the crop.
    const far = rgba8(W, H, [50, 60, 70, 255]);
    far.data[(25 * W + 30) * 4 + 3] = 0;
    op.apply(far, {}, ctx);
    const near = rgba8(W, H, [50, 60, 70, 255]);
    near.data[(25 * W + 37) * 4 + 3] = 0;
    op.apply(near, {}, ctx);
    expect(seen).toEqual([20, 20, 30]);
  });
});
