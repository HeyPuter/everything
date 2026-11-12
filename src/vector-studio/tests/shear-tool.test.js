import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { apply } from '../src/lib/matrix.js';

const ev = (x, y, shift = false) => ({ x, y, shift });

describe('Shear tool', () => {
  const app = bootApp();
  app.newDocument();
  const tool = app.getTool('shear');
  // Reference point at (100, 100), drag starting at (200, 150).
  const d = { o: { x: 100, y: 100 }, x0: 200, y0: 150 };

  it('with Shift shears along whichever axis the drag is closer to', () => {
    const v = tool.matrixFor(d, ev(205, 190, true));
    // Mostly vertical: a vertical shear, so x never changes and the start point moves straight down.
    expect(v[0]).toBeCloseTo(1);
    expect(v[2]).toBeCloseTo(0);
    expect(v[4]).toBeCloseTo(0);
    expect(apply(v, 200, 150).x).toBeCloseTo(200);
    expect(apply(v, 200, 150).y).toBeCloseTo(190);
    const h = tool.matrixFor(d, ev(240, 155, true));
    // Mostly horizontal: a horizontal shear.
    expect(h[1]).toBeCloseTo(0);
    expect(h[3]).toBeCloseTo(1);
    expect(apply(h, 200, 150)).toMatchObject({ x: expect.closeTo(240), y: expect.closeTo(150) });
  });

  it('keeps the reference point and areas', () => {
    for (const shift of [false, true]) {
      const m = tool.matrixFor(d, ev(230, 190, shift));
      const o = apply(m, 100, 100);
      expect(o.x).toBeCloseTo(100);
      expect(o.y).toBeCloseTo(100);
      expect(m[0] * m[3] - m[1] * m[2]).toBeCloseTo(1);
    }
  });
});
