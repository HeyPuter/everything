import { describe, expect, it } from 'vitest';
import { rgba8, type RGBA8 } from '../src/imaging/types';
import { resize, type ResizeMethod } from '../src/imaging/filters/resample';
import { sample, warpImage, edgeIndex } from '../src/imaging/filters/sampling';
import { homography, applyMat3, transformImage, rectifyQuad, mat3Invert, type Mat3 } from '../src/imaging/filters/warp';

function gradient(w: number, h: number): RGBA8 {
  const img = rgba8(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      img.data[k] = (x * 255) / Math.max(1, w - 1);
      img.data[k + 1] = (y * 255) / Math.max(1, h - 1);
      img.data[k + 2] = ((x + y) * 7) & 255;
      img.data[k + 3] = 255;
    }
  return img;
}
function maxDiff(a: RGBA8, b: RGBA8) {
  let m = 0;
  for (let i = 0; i < a.data.length; i++) m = Math.max(m, Math.abs(a.data[i] - b.data[i]));
  return m;
}
const methods: ResizeMethod[] = [
  'nearest',
  'bilinear',
  'bicubic',
  'bicubic-smoother',
  'bicubic-sharper',
  'lanczos',
  'preserve-details',
];

describe('resize', () => {
  it('keeps a constant image constant for every method, up and down', () => {
    const src = rgba8(37, 23, [200, 100, 50, 180]);
    for (const m of methods)
      for (const [w, h] of [
        [11, 7],
        [80, 61],
        [37, 23],
        [1, 1],
      ]) {
        const out = resize(src, w, h, m);
        expect(out.width).toBe(w);
        for (let i = 0; i < out.data.length; i += 4)
          expect([out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]]).toEqual([200, 100, 50, 180]);
      }
  });
  it('is the identity at the same size for interpolating kernels', () => {
    const src = gradient(19, 13);
    for (const m of ['nearest', 'bilinear', 'bicubic', 'lanczos'] as ResizeMethod[])
      expect(maxDiff(resize(src, 19, 13, m), src)).toBe(0);
  });
  it('does not darken colors next to transparent pixels', () => {
    // Opaque red block in a fully transparent (black) field.
    const src = rgba8(16, 16);
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) src.data.set([255, 0, 0, 255], (y * 16 + x) * 4);
    for (const m of methods)
      for (const s of [5, 7, 13, 31, 64]) {
        const out = resize(src, s, s, m);
        for (let i = 0; i < out.data.length; i += 4)
          if (out.data[i + 3] > 8) {
            expect(out.data[i]).toBeGreaterThanOrEqual(250);
            expect(out.data[i + 1]).toBeLessThanOrEqual(3);
          }
      }
  });
  it('area-averages when reducing instead of aliasing', () => {
    // One-pixel checkerboard: a point sampler would return pure black or white.
    const src = rgba8(64, 64);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) src.data.set((x + y) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 64 + x) * 4);
    for (const m of ['bilinear', 'bicubic', 'lanczos'] as ResizeMethod[]) {
      const out = resize(src, 16, 16, m);
      for (let i = 0; i < out.data.length; i += 4) expect(Math.abs(out.data[i] - 128)).toBeLessThanOrEqual(4);
    }
  });
  it('handles 1x1 sources and odd sizes', () => {
    const one = rgba8(1, 1, [10, 20, 30, 255]);
    expect(Array.from(resize(one, 3, 5, 'lanczos').data.slice(0, 4))).toEqual([10, 20, 30, 255]);
    const out = resize(gradient(7, 5), 1, 1, 'bicubic');
    expect(out.data[3]).toBe(255);
    expect(Math.abs(out.data[0] - 128)).toBeLessThan(6);
  });
});

describe('point sampling and warpImage', () => {
  it('maps edges for every mode', () => {
    expect(edgeIndex(-1, 5, 'clamp')).toBe(0);
    expect(edgeIndex(7, 5, 'wrap')).toBe(2);
    expect(edgeIndex(-1, 5, 'mirror')).toBe(0);
    expect(edgeIndex(5, 5, 'mirror')).toBe(4);
    expect(edgeIndex(-1, 5, 'transparent')).toBe(-1);
  });
  it('returns exact pixels at centers and alpha-weights neighbours', () => {
    const src = rgba8(2, 1);
    src.data.set([255, 0, 0, 255, 0, 0, 0, 0]);
    for (const m of ['nearest', 'bilinear', 'bicubic', 'mitchell', 'lanczos'] as const) {
      const [r, , , a] = sample(src, 1, 0.5, m, 'clamp');
      if (m !== 'nearest') {
        expect(r).toBeGreaterThan(254);
        expect(a).toBeGreaterThan(60);
        expect(a).toBeLessThan(200);
      }
    }
    expect(sample(src, 0.5, 0.5, 'bicubic', 'clamp')[0]).toBeCloseTo(255, 3);
  });
  it('identity map is exact with or without a coarse grid', () => {
    const src = gradient(23, 17);
    expect(
      maxDiff(
        warpImage(src, 23, 17, () => {}, { method: 'bicubic' }),
        src,
      ),
    ).toBe(0);
    expect(
      maxDiff(
        warpImage(src, 23, 17, (x, y, o) => ((o[0] = x), (o[1] = y)), { gridStep: 8 }),
        src,
      ),
    ).toBe(0);
  });
  it('a shifted map translates the image', () => {
    const src = gradient(20, 10);
    const out = warpImage(src, 20, 10, (x, y, o) => ((o[0] = x + 3), (o[1] = y)), { edge: 'transparent' });
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 17; x++) expect(out.data[(y * 20 + x) * 4]).toBe(src.data[(y * 20 + x + 3) * 4]);
    expect(out.data[(5 * 20 + 19) * 4 + 3]).toBe(0);
  });
});

describe('homography and projective transforms', () => {
  it('maps the four points exactly', () => {
    const s = [
      { x: 10, y: 20 },
      { x: 310, y: 5 },
      { x: 290, y: 400 },
      { x: -20, y: 380 },
    ];
    const d = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 800 },
      { x: 0, y: 800 },
    ];
    const H = homography(s, d);
    for (let k = 0; k < 4; k++) {
      const p = applyMat3(H, s[k].x, s[k].y);
      expect(p.x).toBeCloseTo(d[k].x, 6);
      expect(p.y).toBeCloseTo(d[k].y, 6);
    }
    const inv = mat3Invert(H)!;
    const q = applyMat3(inv, 1000, 800);
    expect(q.x).toBeCloseTo(290, 6);
    expect(q.y).toBeCloseTo(400, 6);
  });
  it('throws on degenerate (collinear) input', () => {
    const line = [0, 1, 2, 3].map((i) => ({ x: i, y: i }));
    expect(() => homography(line, line)).toThrow();
  });
  it('transformImage with identity and integer translation is exact', () => {
    const src = gradient(15, 9);
    const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (const m of ['nearest', 'bilinear', 'bicubic', 'lanczos'] as const)
      expect(maxDiff(transformImage(src, I, { x: 0, y: 0, width: 15, height: 9 }, m), src)).toBe(0);
    const T: Mat3 = [1, 0, 5, 0, 1, 2, 0, 0, 1];
    expect(maxDiff(transformImage(src, T, { x: 5, y: 2, width: 15, height: 9 }, 'bicubic'), src)).toBe(0);
  });
  it('scales by two with prefiltering', () => {
    const src = rgba8(64, 64);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) src.data.set((x + y) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 64 + x) * 4);
    const out = transformImage(
      src,
      [0.25, 0, 0, 0, 0.25, 0, 0, 0, 1],
      { x: 0, y: 0, width: 16, height: 16 },
      'bilinear',
    );
    for (let i = 0; i < out.data.length; i += 4) expect(Math.abs(out.data[i] - 128)).toBeLessThanOrEqual(10);
  });
  it('prefilters only the reduced axis of a one-sided scale', () => {
    // Horizontal stripes two rows tall: all of the detail runs vertically.
    const src = rgba8(200, 64);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 200; x++)
        src.data.set(y & 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 200 + x) * 4);
    for (const m of ['bilinear', 'bicubic'] as const) {
      const out = transformImage(
        src,
        [0.1, 0, 0, 0, 1, 0, 0, 0, 1],
        { x: 0, y: 0, width: 20, height: 64 },
        m,
      );
      for (let y = 4; y < 60; y++)
        expect(Math.abs(out.data[(y * 20 + 10) * 4] - (y & 2 ? 255 : 0))).toBeLessThanOrEqual(40);
    }
  });
  it('rectifyQuad of the full frame is the identity and a sub-quad crops', () => {
    const src = gradient(32, 24);
    const full = [
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 32, y: 24 },
      { x: 0, y: 24 },
    ];
    expect(maxDiff(rectifyQuad(src, full, 32, 24, 'bicubic'), src)).toBeLessThanOrEqual(1);
    const crop = rectifyQuad(
      src,
      [
        { x: 8, y: 4 },
        { x: 24, y: 4 },
        { x: 24, y: 20 },
        { x: 8, y: 20 },
      ],
      16,
      16,
      'bilinear',
    );
    expect(crop.data[0]).toBe(src.data[(4 * 32 + 8) * 4]);
  });
});
