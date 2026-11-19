import { describe, expect, it } from 'vitest';
import {
  beforePlacement,
  cacheSize,
  clipPathCss,
  dividerKey,
  splitClip,
} from '../src/features/compare/geometry';
import { applyAffine, viewMatrix } from '../src/app/view-transform';

// Point-in-polygon (even-odd) for checking clip polygons.
function inside(poly: [number, number][], x: number, y: number) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

describe('Quick Compare geometry', () => {
  const doc = { width: 400, height: 300 },
    viewport = { width: 800, height: 600 };

  it('places a stored state of the same size or proportions over the canvas, otherwise centered at its size', () => {
    expect(beforePlacement(doc, doc)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    // Image Size halved the canvas: stretched over it.
    expect(beforePlacement({ width: 800, height: 600 }, doc)).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    // Canvas Size grew the canvas: centered at its own size.
    expect(beforePlacement({ width: 300, height: 300 }, doc)).toEqual({
      x: 50,
      y: 0,
      width: 300,
      height: 300,
    });
  });

  it('clips the stored state to the screen half before an upright divider, also on a rotated view', () => {
    for (const rotation of [0, 30, 90, 180]) {
      for (const flip of [false, true]) {
        const m = viewMatrix(
          { zoom: 1.5, pan: { x: 20, y: -10 }, rotation, flip, aspect: 1 },
          doc,
          viewport,
        );
        const poly = splitClip(m, viewport, 'vertical', 0.4, { x: 0, y: 0, ...doc });
        // Every document point is in the clip exactly when it shows left of the divider.
        for (let y = 5; y < doc.height; y += 37)
          for (let x = 5; x < doc.width; x += 41) {
            const [sx] = applyAffine(m, x, y);
            if (Math.abs(sx - 320) < 0.5) continue;
            expect(inside(poly, x, y), `rotation ${rotation} flip ${flip} at ${x},${y}`).toBe(
              sx < 320,
            );
          }
      }
    }
  });

  it('clips above a level divider, in the coordinates of an offset element', () => {
    const m = viewMatrix(
      { zoom: 1, pan: { x: 0, y: 0 }, rotation: 0, flip: false, aspect: 1 },
      doc,
      viewport,
    );
    const place = { x: 50, y: 20, width: 300, height: 260 };
    const poly = splitClip(m, viewport, 'horizontal', 0.5, place);
    // The document is centered: screen y 300 is document y 150, element y 130.
    expect(inside(poly, 100, 129)).toBe(true);
    expect(inside(poly, 100, 131)).toBe(false);
    expect(
      clipPathCss([
        [0, 0],
        [1.234, 5.678],
      ]),
    ).toBe('polygon(0px 0px, 1.23px 5.68px)');
  });

  it('caches large states at a reduced size', () => {
    expect(cacheSize(4000, 3000)).toEqual({ width: 4000, height: 3000 });
    expect(cacheSize(20000, 1000)).toEqual({ width: 8192, height: 409 });
    const big = cacheSize(10000, 8000);
    expect(big.width * big.height).toBeLessThanOrEqual(40_000_000);
    expect(big.width / big.height).toBeCloseTo(1.25, 2);
  });

  it('moves the divider with keys', () => {
    expect(dividerKey(0.5, 'ArrowLeft', false)).toBeCloseTo(0.49);
    expect(dividerKey(0.5, 'ArrowRight', true)).toBeCloseTo(0.6);
    expect(dividerKey(0.95, 'PageDown', false)).toBe(1);
    expect(dividerKey(0.5, 'Home', false)).toBe(0);
    expect(dividerKey(0.5, 'End', false)).toBe(1);
    expect(dividerKey(0.5, 'a', false)).toBeUndefined();
  });
});
