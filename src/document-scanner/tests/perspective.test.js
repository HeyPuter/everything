import { describe, it, expect } from 'vitest';
import {
  orderCorners,
  applyHomography,
  computeHomography,
  warpPerspective,
  defaultQuad,
} from '../src/engine/perspective.js';

describe('perspective', () => {
  it('orders corners TL TR BR BL', () => {
    const ordered = orderCorners([
      { x: 10, y: 80 },
      { x: 90, y: 10 },
      { x: 10, y: 10 },
      { x: 90, y: 80 },
    ]);
    expect(ordered.map((p) => [p.x, p.y])).toEqual([
      [10, 10],
      [90, 10],
      [90, 80],
      [10, 80],
    ]);
  });

  it('maps a rectangle through a round-trip homography', () => {
    const src = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    const dst = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ];
    const H = computeHomography(src, dst);
    const p = applyHomography(H, 100, 50);
    expect(p.x).toBeCloseTo(50, 5);
    expect(p.y).toBeCloseTo(25, 5);
  });

  it('warps a solid-color image into the output size', () => {
    const w = 20;
    const h = 20;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 200;
      rgba[i + 1] = 40;
      rgba[i + 2] = 40;
      rgba[i + 3] = 255;
    }
    const out = warpPerspective(rgba, w, h, defaultQuad(w, h, 0.1), 40, 30);
    expect(out.width).toBe(40);
    expect(out.height).toBe(30);
    // Center pixel should be close to the red fill
    const mid = ((15 * 40 + 20) * 4);
    expect(out.data[mid]).toBeGreaterThan(150);
  });
});
