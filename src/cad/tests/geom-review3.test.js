import { describe, it, expect } from 'vitest';
import * as G from '../src/core/geom/index.js';

describe('spline length far from the origin', () => {
  it('converges at once and matches the same curve at the origin', () => {
    const fit = [-8.5, 9, -1.8, 10.3, -5.2, 1.2, -4.1, 10.6, -8.5, 9];
    const near = { type: 'spline', ...G.splineFromFitPoints(fit) };
    const far = { ...near, ctrl: near.ctrl.map((v) => v + 1e7) };
    expect(G.lengthOf(far)).toBeCloseTo(G.lengthOf(near), 6);
  });
});

describe('closest point on an ellipse next to its major axis', () => {
  const brute = (e, x, y) => {
    let best = Infinity;
    for (let k = 0; k < 20000; k++) {
      const p = G.ellipsePoint(e, (k / 20000) * G.TWO_PI);
      best = Math.min(best, Math.hypot(p.x - x, p.y - y));
    }
    return best;
  };

  it('is right for a point a rounding error off the axis of a rotated ellipse', () => {
    const e = { type: 'ellipse', cx: -1.8050881731323898, cy: -2.0307034626603127, mx: -7.096561359405618, my: 0.7733397822080502, ratio: 0.25435960572212934, start: 0, end: G.TWO_PI };
    const x = -7.533585683359837,
      y = -1.4064468977442446;
    expect(G.closestPoint(e, x, y).d).toBeCloseTo(brute(e, x, y), 6);
  });

  it('is right for tiny offsets from the axis and from the centre', () => {
    const e = { type: 'ellipse', cx: 3, cy: -2, mx: 4, my: 3, ratio: 0.4, start: 0, end: G.TWO_PI };
    const { a, ux, uy } = G.ellipseAxes(e);
    for (const u of [0, 1e-16, 0.2 * a, -0.5 * a, 0.83 * a, 0.9 * a]) {
      for (const v of [1e-17, -1e-16, 1e-14, -1e-12, 1e-9, 1e-6]) {
        const x = e.cx + u * ux - v * uy,
          y = e.cy + u * uy + v * ux;
        const c = G.closestPoint(e, x, y);
        expect(Number.isFinite(c.d)).toBe(true);
        expect(c.d).toBeCloseTo(brute(e, x, y), 6);
      }
    }
  });
});
