import { describe, expect, it } from 'vitest';
import { rgba8, type RGBA8 } from '../src/imaging/types';
import { rng } from '../src/imaging/filters/sampling';
import {
  detailActive,
  reduceNoise,
  sharpen,
  sharpenMask,
} from '../src/imaging/filters/develop/detail';

const clone = (img: RGBA8): RGBA8 => ({ ...img, data: new Uint8ClampedArray(img.data) });

function gaussian(seed: number) {
  const r = rng(seed);
  return () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

function make(
  w: number,
  h: number,
  f: (x: number, y: number) => [number, number, number, number?],
) {
  const img = rgba8(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = f(x, y);
      img.data.set([r, g, b, a ?? 255], (y * w + x) * 4);
    }
  return img;
}

const px = (img: RGBA8, x: number, y: number, c = 0) => img.data[(y * img.width + x) * 4 + c];

function stats(img: RGBA8, x0: number, y0: number, x1: number, y1: number, c = 0) {
  let s = 0,
    s2 = 0,
    n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const v = px(img, x, y, c);
      s += v;
      s2 += v * v;
      n++;
    }
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
}

// 2x box reduction.
function half(img: RGBA8): RGBA8 {
  const w = img.width >> 1,
    h = img.height >> 1,
    out = rgba8(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++)
        out.data[(y * w + x) * 4 + c] =
          (px(img, 2 * x, 2 * y, c) +
            px(img, 2 * x + 1, 2 * y, c) +
            px(img, 2 * x, 2 * y + 1, c) +
            px(img, 2 * x + 1, 2 * y + 1, c)) /
          4;
  return out;
}

function meanAbsDiff(a: RGBA8, b: RGBA8) {
  let s = 0;
  for (let i = 0; i < a.data.length; i++) if ((i & 3) < 3) s += Math.abs(a.data[i] - b.data[i]);
  return s / ((a.data.length / 4) * 3);
}

// Soft vertical step edge (64 -> 192) at x = w / 2 with an optional noise level.
function softEdge(w: number, h: number, noise = 0, seed = 1) {
  const g = gaussian(seed);
  return make(w, h, (x) => {
    const t = 1 / (1 + Math.exp(-(x + 0.5 - w / 2) / 0.6));
    const v = 64 + 128 * t + noise * g();
    return [v, v, v];
  });
}

describe('develop detail: activity and identity', () => {
  it('is inactive at defaults and returns the input untouched', () => {
    expect(detailActive({})).toEqual({ noise: false, sharpen: false });
    expect(detailActive({ sharpenAmount: 40 }).sharpen).toBe(true);
    expect(detailActive({ colorNoise: 25 }).noise).toBe(true);
    const src = softEdge(32, 16, 8);
    const copy = clone(src);
    expect(reduceNoise(src, {}, 1)).toBe(src);
    const out = sharpen(src, { sharpenAmount: 0, sharpenRadius: 2 }, 1);
    expect(out.data).toEqual(copy.data);
  });

  it('is deterministic', () => {
    const src = softEdge(48, 40, 10, 7);
    const p = { sharpenAmount: 80, sharpenMasking: 30, noiseReduction: 50, colorNoise: 40 };
    const a = sharpen(reduceNoise(src, p, 1), p, 1),
      b = sharpen(reduceNoise(src, p, 1), p, 1);
    expect(a.data).toEqual(b.data);
  });
});

describe('develop detail: sharpening', () => {
  it('increases edge contrast and keeps color', () => {
    const src = make(64, 16, (x) => {
      const t = 1 / (1 + Math.exp(-(x + 0.5 - 32) / 0.6));
      return [100 + 100 * t, 60 + 100 * t, 40 + 100 * t];
    });
    const out = sharpen(clone(src), { sharpenAmount: 100, sharpenDetail: 100 }, 1);
    const slope = (img: RGBA8) => px(img, 33, 8) - px(img, 30, 8);
    expect(slope(out)).toBeGreaterThan(slope(src) + 10);
    // Luminance-only: the channel differences stay as they were.
    for (const x of [28, 31, 34, 36]) {
      expect(px(out, x, 8, 0) - px(out, x, 8, 1)).toBeCloseTo(
        px(src, x, 8, 0) - px(src, x, 8, 1),
        -0.5,
      );
      expect(px(out, x, 8, 1) - px(out, x, 8, 2)).toBeCloseTo(
        px(src, x, 8, 1) - px(src, x, 8, 2),
        -0.5,
      );
    }
  });

  it('limits halos at low Detail', () => {
    const src = softEdge(64, 8);
    const lo = sharpen(clone(src), { sharpenAmount: 150, sharpenDetail: 0 }, 1),
      hi = sharpen(clone(src), { sharpenAmount: 150, sharpenDetail: 100 }, 1);
    const overshoot = (img: RGBA8) => {
      let m = 0;
      for (let x = 0; x < 64; x++) m = Math.max(m, px(img, x, 4) - 192, 64 - px(img, x, 4));
      return m;
    };
    expect(overshoot(lo)).toBeLessThanOrEqual(3);
    expect(overshoot(hi)).toBeGreaterThan(overshoot(lo) + 5);
  });

  it('Masking 100 leaves a flat noisy area nearly untouched but still sharpens edges', () => {
    const g = gaussian(3);
    // Left 64 columns: flat noisy gray; right part: a strong clean edge.
    const src = make(128, 48, (x) => {
      if (x < 64) {
        const v = 128 + 6 * g();
        return [v, v, v];
      }
      const v = x < 96 ? 40 : 220;
      return [v, v, v];
    });
    const plain = sharpen(clone(src), { sharpenAmount: 120 }, 1),
      masked = sharpen(clone(src), { sharpenAmount: 120, sharpenMasking: 100 }, 1);
    const region = (img: RGBA8) => {
      let s = 0;
      for (let y = 4; y < 44; y++)
        for (let x = 4; x < 56; x++) s += Math.abs(px(img, x, y) - px(src, x, y));
      return s / (40 * 52);
    };
    expect(region(plain)).toBeGreaterThan(2);
    expect(region(masked)).toBeLessThan(0.3);
    const edge = (img: RGBA8) => px(img, 97, 24) - px(img, 94, 24);
    expect(edge(masked)).toBeGreaterThanOrEqual(edge(src));
    const m = sharpenMask(src, { sharpenMasking: 100 }, 1);
    expect(m.data[24 * 128 + 30]).toBeLessThan(20);
    expect(m.data[24 * 128 + 96]).toBeGreaterThan(240);
    expect(sharpenMask(src, {}, 1).data.every((v) => v === 255)).toBe(true);
  });

  it('a half-size preview at scale 0.5 matches the reduced full render', () => {
    // Smooth blobs with soft edges, sharpened with radius 2.
    const src = make(128, 128, (x, y) => {
      const d = Math.hypot(x - 64, y - 64),
        t = 1 / (1 + Math.exp((d - 30) / 2)),
        v = 70 + 120 * t + 30 * Math.sin(x / 6) * Math.cos(y / 7);
      return [v, v * 0.9, v * 0.8];
    });
    const p = { sharpenAmount: 120, sharpenRadius: 2, sharpenDetail: 100 };
    const full = half(sharpen(clone(src), p, 1));
    const good = sharpen(half(src), p, 0.5),
      bad = sharpen(half(src), p, 1);
    const eGood = meanAbsDiff(full, good),
      eBad = meanAbsDiff(full, bad);
    expect(eGood).toBeLessThan(1.5);
    expect(eGood).toBeLessThan(eBad * 0.6);
  });

  it('does not pull transparent colors into visible pixels', () => {
    const src = make(32, 8, (x) => (x < 16 ? [0, 0, 0, 0] : [150, 150, 150, 255]));
    const out = sharpen(clone(src), { sharpenAmount: 150, sharpenDetail: 100 }, 1);
    for (let x = 16; x < 32; x++) expect(px(out, x, 4)).toBe(150);
    for (let x = 0; x < 32; x++) expect(px(out, x, 4, 3)).toBe(px(src, x, 4, 3));
  });
});

describe('develop detail: noise reduction', () => {
  it('lowers noise in flat areas while keeping a step edge sharp', () => {
    const g = gaussian(11);
    const src = make(96, 64, (x) => {
      const v = (x < 48 ? 80 : 170) + 10 * g();
      return [v, v, v];
    });
    const out = reduceNoise(src, { noiseReduction: 60 }, 1);
    expect(out).not.toBe(src);
    for (const [x0, x1] of [
      [4, 40],
      [56, 92],
    ]) {
      const before = stats(src, x0, 4, x1, 60),
        after = stats(out, x0, 4, x1, 60);
      expect(after.std).toBeLessThan(before.std * 0.6);
      expect(Math.abs(after.mean - before.mean)).toBeLessThan(1.5);
    }
    // Column means next to the edge keep their levels.
    expect(stats(out, 46, 4, 47, 60).mean).toBeLessThan(90);
    expect(stats(out, 49, 4, 50, 60).mean).toBeGreaterThan(160);
  });

  it('more Detail keeps more texture, Contrast restores local contrast', () => {
    const g = gaussian(5);
    const src = make(64, 64, (x, y) => {
      const v = 128 + 25 * Math.sin(x / 3) * Math.sin(y / 3) + 8 * g();
      return [v, v, v];
    });
    const lo = reduceNoise(src, { noiseReduction: 80, noiseDetail: 0 }, 1),
      hi = reduceNoise(src, { noiseReduction: 80, noiseDetail: 100 }, 1);
    expect(meanAbsDiff(hi, src)).toBeLessThan(meanAbsDiff(lo, src));
    const flat = reduceNoise(src, { noiseReduction: 80 }, 1),
      punchy = reduceNoise(src, { noiseReduction: 80, noiseContrast: 100 }, 1);
    expect(stats(punchy, 8, 8, 56, 56).std).toBeGreaterThan(stats(flat, 8, 8, 56, 56).std);
  });

  it('a half-size preview at scale 0.5 smooths about as much as the reduced full render', () => {
    const g = gaussian(9);
    const src = make(128, 128, () => {
      const v = 128 + 14 * g();
      return [v, v, v];
    });
    const p = { noiseReduction: 50 };
    const full = half(reduceNoise(src, p, 1)),
      prev = reduceNoise(half(src), p, 0.5);
    const a = stats(full, 8, 8, 56, 56).std,
      b = stats(prev, 8, 8, 56, 56).std,
      raw = stats(half(src), 8, 8, 56, 56).std;
    expect(b).toBeLessThan(raw * 0.8);
    expect(b).toBeLessThan(a * 2.5);
    expect(a).toBeLessThan(b * 2.5);
  });

  it('color noise reduction lowers chroma variance without shifting the mean color', () => {
    const g = gaussian(21);
    const src = make(96, 96, () => [150 + 12 * g(), 120 + 12 * g(), 100 + 12 * g()]);
    const out = reduceNoise(src, { colorNoise: 60 }, 1);
    const chroma = (img: RGBA8) => {
      let sb = 0,
        sr = 0,
        sb2 = 0,
        sr2 = 0,
        n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const [r, gg, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
        const y = 0.2126 * r + 0.7152 * gg + 0.0722 * b,
          cb = b - y,
          cr = r - y;
        sb += cb;
        sr += cr;
        sb2 += cb * cb;
        sr2 += cr * cr;
        n++;
      }
      return sb2 / n - (sb / n) ** 2 + sr2 / n - (sr / n) ** 2;
    };
    expect(chroma(out)).toBeLessThan(chroma(src) * 0.4);
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs(stats(out, 0, 0, 96, 96, c).mean - stats(src, 0, 0, 96, 96, c).mean),
      ).toBeLessThan(1.5);
  });

  it('keeps a sharp color edge that follows a luminance edge', () => {
    const src = make(64, 16, (x) => (x < 32 ? [200, 40, 40] : [40, 40, 200]));
    const out = reduceNoise(src, { colorNoise: 100, colorNoiseSmoothness: 100 }, 1);
    expect(px(out, 30, 8, 0)).toBeGreaterThan(180);
    expect(px(out, 33, 8, 2)).toBeGreaterThan(180);
  });

  it('never bleeds transparent colors into visible pixels and keeps alpha', () => {
    const g = gaussian(4);
    const src = make(64, 32, (x) => {
      if (x < 32) return [255, 0, 0, 0];
      const v = 120 + 6 * g();
      return [v, v, v, 255];
    });
    const out = reduceNoise(
      src,
      { noiseReduction: 70, colorNoise: 100, colorNoiseSmoothness: 100 },
      1,
    );
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 64; x++) {
        expect(px(out, x, y, 3)).toBe(px(src, x, y, 3));
        if (x >= 32) expect(Math.abs(px(out, x, y, 0) - px(out, x, y, 2))).toBeLessThanOrEqual(3);
      }
  });
});
