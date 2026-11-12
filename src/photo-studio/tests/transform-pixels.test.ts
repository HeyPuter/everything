import { describe, expect, it } from 'vitest';
import { TileStore, gridFromImage, readRGBA, readMask, gridDocBounds, writeRect, emptyGrid } from '../src/model/tiles';
import { commitPixelResample, newPixelLayer, setPixelResampleMethod } from '../src/model/pixel-layer';
import { exactPlacement, renderFrame } from '../src/features/transform/render';
import { exactPivot, isSimilarity, transformMaskGrid, transformPixelGrid, trimGrid } from '../src/features/transform/layer-ops';
import { extensionStrips, fillBehind } from '../src/features/transform/canvas-size';
import { boxCorners, fitInside, orderQuad, resizeBox } from '../src/features/transform/crop';
import { scaleRect, resolveMethod } from '../src/features/transform/image-size';
import { about, compose, mapQuad, rectQuad, rotateM, scaleM, translate } from '../src/features/transform/math';
import type { RGBA8 } from '../src/imaging/types';

function numbered(w: number, h: number): RGBA8 {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([(i * 37) % 256, (i * 11) % 256, i % 7, 255], i * 4);
  return { width: w, height: h, data };
}
const solid = (w: number, h: number, c: [number, number, number, number]): RGBA8 => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(c, i * 4);
  return { width: w, height: h, data };
};

describe('exact placement', () => {
  it('rearranges quarter turns, mirrors and integer moves only', () => {
    const src = numbered(5, 3);
    const rot = exactPlacement(src, compose(translate(10, 0), rotateM(90)));
    expect(rot?.rect).toEqual({ x: 7, y: 0, width: 3, height: 5 });
    const mirror = exactPlacement(src, compose(translate(5, 0), scaleM(-1, 1)));
    expect(mirror?.rect).toEqual({ x: 0, y: 0, width: 5, height: 3 });
    expect([...mirror!.image.data.subarray(0, 4)]).toEqual([...src.data.subarray(16, 20)]);
    expect(exactPlacement(src, translate(0.5, 0))).toBeUndefined();
    expect(exactPlacement(src, rotateM(30))).toBeUndefined();
    expect(exactPlacement(src, scaleM(2, 2))).toBeUndefined();
  });
  it('renders an identity frame unchanged and a 2x scale with exact interior', () => {
    const src = solid(4, 4, [10, 200, 30, 255]);
    const r = { x: 3, y: 5, width: 4, height: 4 };
    const same = renderFrame(src, r, rectQuad(r), undefined, { exact: true });
    expect(same?.rect).toEqual(r);
    expect([...same!.image.data]).toEqual([...src.data]);
    const big = renderFrame(src, r, mapQuad(about(scaleM(2, 2), 3, 5), rectQuad(r)), undefined, { method: 'bicubic' });
    expect(big?.rect).toEqual({ x: 3, y: 5, width: 8, height: 8 });
    expect([...big!.image.data.subarray((3 * 8 + 3) * 4, (3 * 8 + 3) * 4 + 4)]).toEqual([10, 200, 30, 255]);
  });
});

describe('frame bounds', () => {
  it('does not grow a faint extra row or column from rounding noise', () => {
    // A 2x scale about the corner lands exactly on (20, 20)–(100, 80); the
    // solved homography carries tiny errors that used to round outward.
    const src = solid(40, 30, [0, 0, 255, 255]);
    const r = { x: 20, y: 20, width: 40, height: 30 };
    for (const [sx, sy] of [[2, 2], [3, 3], [1.5, 2.5], [0.5, 0.5]]) {
      const quad = mapQuad(about(scaleM(sx, sy), 20, 20), rectQuad(r));
      const out = renderFrame(src, r, quad, undefined, { method: 'bicubic' })!;
      expect(out.rect).toEqual({ x: 20, y: 20, width: 40 * sx, height: 30 * sy });
      // The first and last rows are part of the image, not filter spill.
      expect(out.image.data[3]).toBeGreaterThan(100);
      expect(out.image.data[out.image.data.length - 1]).toBeGreaterThan(100);
    }
  });
});

describe('pixel layer baking', () => {
  it('bakes quarter-turn layer transforms losslessly', () => {
    const store = new TileStore();
    const img = numbered(6, 4);
    const l = newPixelLayer('L', { width: 100, height: 100 }, gridFromImage(store, img, 10, 20));
    // Rotate 90° about the center (13, 22): the 4x6 result starts at (11, 19).
    l.transform = { ...l.transform, rotation: 90 };
    commitPixelResample(l, store, { width: 100, height: 100 }, 'bilinear');
    expect(gridDocBounds(l.pixels!)).toEqual({ x: 11, y: 19, width: 4, height: 6 });
    const out = readRGBA(store, l.pixels!, { x: 11, y: 19, width: 4, height: 6 });
    // Source (0, 0) lands at the top-right after a clockwise turn.
    expect([...out.data.subarray(3 * 4, 3 * 4 + 4)]).toEqual([...img.data.subarray(0, 4)]);
    // 180° twice returns the original exactly.
    l.transform = { ...l.transform, rotation: 180 };
    commitPixelResample(l, store, { width: 100, height: 100 });
    l.transform = { ...l.transform, rotation: 180 };
    commitPixelResample(l, store, { width: 100, height: 100 });
    expect(gridDocBounds(l.pixels!)).toEqual({ x: 11, y: 19, width: 4, height: 6 });
    const back = readRGBA(store, l.pixels!, { x: 11, y: 19, width: 4, height: 6 });
    expect([...back.data]).toEqual([...out.data]);
    expect([...out.data]).toEqual([...rotateBack(img)]);
  });
  it('resamples other transforms with the chosen interpolation', () => {
    const store = new TileStore();
    const l = newPixelLayer('L', { width: 100, height: 100 }, gridFromImage(store, solid(10, 10, [200, 0, 0, 255]), 5, 5));
    l.transform = { x: 5, y: 5, width: 30, height: 30, rotation: 0 };
    setPixelResampleMethod('nearest');
    commitPixelResample(l, store, { width: 100, height: 100 });
    setPixelResampleMethod('bicubic');
    const b = gridDocBounds(l.pixels!)!;
    expect(b).toEqual({ x: 5, y: 5, width: 30, height: 30 });
    // Nearest neighbour keeps hard, fully opaque edges.
    expect(readRGBA(store, l.pixels!, { x: 5, y: 5, width: 1, height: 1 }).data[3]).toBe(255);
  });
});
// Reference clockwise quarter turn.
function rotateBack(img: RGBA8) {
  const out = new Uint8ClampedArray(img.data.length);
  const w = img.width,
    h = img.height;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(img.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (x * h + (h - 1 - y)) * 4);
  return out;
}

describe('grid transforms', () => {
  it('rotates pixel grids exactly about a half-pixel pivot', () => {
    const store = new TileStore();
    const g = gridFromImage(store, numbered(3, 2), 0, 0);
    const c = exactPivot(1.5, 1);
    expect(Math.abs((c.x - c.y) % 1)).toBe(0);
    const r = transformPixelGrid(store, g, about(rotateM(90), c.x, c.y));
    const b = gridDocBounds(r)!;
    expect([b.width, b.height]).toEqual([2, 3]);
    expect(Number.isInteger(b.x) && Number.isInteger(b.y)).toBe(true);
  });
  it('keeps the fill of reveal-all masks outside the stored tiles', () => {
    const store = new TileStore();
    const m = { width: 4, height: 4, data: new Uint8Array(16).fill(0) };
    const grid = writeRect(store, { ...emptyGrid(1), fill: 255 }, 10, 10, m);
    const turned = transformMaskGrid(store, grid, about(rotateM(90), 128, 128));
    expect(turned.fill).toBe(255);
    // Far away stays revealed; the hidden square moved but stayed hidden.
    expect(readMask(store, turned, { x: 600, y: 600, width: 1, height: 1 }).data[0]).toBe(255);
    expect(readMask(store, turned, { x: 10, y: 10, width: 1, height: 1 }).data[0]).toBe(255);
    const rotated = transformMaskGrid(store, grid, about(rotateM(30), 128, 128));
    expect(rotated.fill).toBe(255);
    expect(readMask(store, rotated, { x: 600, y: 600, width: 1, height: 1 }).data[0]).toBe(255);
  });
  it('trims pixels outside a rectangle', () => {
    const store = new TileStore();
    const g = gridFromImage(store, solid(20, 20, [1, 2, 3, 255]), -5, -5);
    expect(gridDocBounds(trimGrid(store, g, { x: 0, y: 0, width: 10, height: 10 }))).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });
  it('recognizes similarities', () => {
    expect(isSimilarity(compose(translate(3, 4), rotateM(33), scaleM(2, 2)))).toBe(true);
    expect(isSimilarity(scaleM(-1, 1))).toBe(true);
    expect(isSimilarity(scaleM(2, 1))).toBe(false);
  });
});

describe('canvas size', () => {
  it('finds the extension strips around the old canvas', () => {
    const strips = extensionStrips(100, 50, 120, 70, 10, 10);
    const area = strips.reduce((s, r) => s + r.width * r.height, 0);
    expect(area).toBe(120 * 70 - 100 * 50);
    expect(extensionStrips(100, 50, 100, 50, 0, 0)).toEqual([]);
    // Shrinking adds nothing.
    expect(extensionStrips(100, 50, 50, 20, -10, -10)).toEqual([]);
  });
  it('fills behind existing pixels only', () => {
    const store = new TileStore();
    const img = solid(2, 1, [0, 0, 0, 0]);
    img.data.set([255, 0, 0, 255], 0);
    const g = fillBehind(store, gridFromImage(store, img, 0, 0), [{ x: 0, y: 0, width: 2, height: 1 }], [0, 0, 255]);
    const out = readRGBA(store, g, { x: 0, y: 0, width: 2, height: 1 });
    expect([...out.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });
});

describe('crop geometry', () => {
  it('orders perspective corners from the top-left, clockwise', () => {
    const q = orderQuad([{ x: 90, y: 80 }, { x: 0, y: 5 }, { x: 10, y: 70 }, { x: 100, y: 0 }]);
    expect(q).toEqual([{ x: 0, y: 5 }, { x: 100, y: 0 }, { x: 90, y: 80 }, { x: 10, y: 70 }]);
  });
  it('resizes a rotated box from a handle with the opposite side fixed', () => {
    const b = { cx: 50, cy: 50, w: 40, h: 20, angle: 90 };
    const r = resizeBox(b, 'e', { x: 10, y: 0 }, undefined, false);
    expect(r.w).toBe(50);
    // The box's local +x points down the canvas at 90°.
    expect(r.cx).toBeCloseTo(50);
    expect(r.cy).toBeCloseTo(55);
    const ratio = resizeBox({ ...b, angle: 0 }, 'se', { x: 20, y: 0 }, 2, false);
    expect(ratio.h).toBeCloseTo(ratio.w / 2);
  });
  it('fits a rotated box inside the canvas', () => {
    const f = fitInside({ cx: 50, cy: 50, w: 100, h: 100, angle: 45 }, 100, 100);
    for (const p of boxCorners(f)) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x).toBeLessThanOrEqual(100 + 1e-9);
    }
    expect(f.w).toBeCloseTo(100 / Math.SQRT2);
  });
});

describe('image size', () => {
  it('scales rectangles onto whole pixels and resolves Automatic', () => {
    expect(scaleRect({ x: 1, y: 1, width: 3, height: 3 }, 2, 2)).toEqual({ x: 2, y: 2, width: 6, height: 6 });
    expect(scaleRect({ x: 0, y: 0, width: 1, height: 1 }, 0.1, 0.1)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(resolveMethod('automatic', 10, 10, 20, 20)).toBe('bicubic-smoother');
    expect(resolveMethod('bilinear', 10, 10, 20, 20)).toBe('bilinear');
  });
});
