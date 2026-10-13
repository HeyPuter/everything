import { describe, expect, it } from 'vitest';
import { edgeBand } from '../src/features/retouch/refine-mask';
import { refineComposite } from '../src/features/retouch/logic';

const mask = (w: number, h: number, f: (x: number, y: number) => number) => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { width: w, height: h, data };
};

describe('Refine Mask Edge', () => {
  it('finds the band around a mask edge, or none for a uniform mask', () => {
    const m = mask(100, 80, (x, y) => (x >= 30 && x < 60 && y >= 20 && y < 50 ? 255 : 0));
    expect(edgeBand(m, 0)).toEqual({ x: 29, y: 19, width: 31, height: 31 });
    expect(edgeBand(m, 10)).toEqual({ x: 19, y: 9, width: 51, height: 51 });
    expect(edgeBand(m, 500)).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(edgeBand(mask(10, 10, () => 255), 4)).toBeNull();
    expect(edgeBand(mask(10, 10, () => 0), 4)).toBeNull();
  });

  it('pulls a loose mask edge onto the image edge', () => {
    const w = 64, h = 64;
    // A bright disk of radius 16 on a dark background; the mask is a disk of radius 20.
    const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = Math.hypot(x - 32, y - 32) < 16 ? 230 : 20;
        img.data.set([v, v, v, 255], (y * w + x) * 4);
      }
    const loose = mask(w, h, (x, y) => (Math.hypot(x - 32, y - 32) < 20 ? 255 : 0));
    const out = refineComposite(img, loose, { radius: 8, adaptiveRadius: false, smooth: 0, feather: 0, contrast: 0, shiftEdge: 0, decontaminate: 0 }).mask;
    const at = (x: number, y: number) => out.data[y * w + x];
    expect(at(32, 32)).toBeGreaterThan(240);
    // Between the disk edge (16) and the old mask edge (20) the mask now hides.
    expect(at(32 + 18, 32)).toBeLessThan(60);
    expect(at(32 + 13, 32)).toBeGreaterThan(200);
  });
});
