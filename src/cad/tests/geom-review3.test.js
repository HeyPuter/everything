import { describe, it, expect } from 'vitest';
import * as G from '../src/core/geom/index.js';
import { layoutText } from '../src/core/text/layout.js';

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

describe('small offsets far from the origin', () => {
  it('offsets a closed polyline at 1e6 by 0.01 on either side', () => {
    const O = 1e6;
    const pts = [5.36, -1.4, 0, 2.84, -2.97, 0, -3.92, -8.91, 0, -4.55, -8.75, -0.16, -7.37, 2.05, 0, 5.13, 2.19, 0];
    const far = { type: 'polyline', pts: pts.map((v, i) => (i % 3 === 2 ? v : v + O)), closed: true, width: 0 };
    for (const [sx, sy, sign] of [
      [O - 8.2, O + 3.8, 1],
      [O, O, -1],
    ]) {
      const r = G.offsetEntity(far, 0.01, sx, sy);
      expect(r).toBeTruthy();
      expect(Array.isArray(r)).toBe(false);
      expect(r.closed).toBe(true);
      const grown = G.areaOf(r) - G.areaOf(far);
      expect(grown * sign).toBeGreaterThan(0);
      expect(Math.abs(grown)).toBeCloseTo(0.01 * G.lengthOf(far), 2);
      for (let i = 0; i < r.pts.length; i += 3) {
        expect(G.closestPoint(far, r.pts[i], r.pts[i + 1]).d).toBeGreaterThan(0.0099);
      }
    }
  });

  it('offsets a full ellipse and a closed spline at 1e7 by 0.001', () => {
    const O = 1e7;
    const ell = { type: 'ellipse', cx: O + 2, cy: O - 3, mx: 6, my: 2, ratio: 0.5, start: 0, end: G.TWO_PI };
    const fit = [6, 0, 0, 5, -7, 1, -4, -6, 3, -5].map((v) => v + O);
    const spl = { type: 'spline', ...G.splineFromFitPoints(fit, true), fit, closed: true };
    for (const e of [ell, spl]) {
      for (const [sx, sy] of [
        [O, O],
        [O + 40, O + 40],
      ]) {
        const r = G.offsetEntity(e, 0.001, sx, sy);
        expect(r).toBeTruthy();
        expect(Array.isArray(r)).toBe(false);
        expect(r.closed).toBe(true);
        expect(G.lengthOf(r)).toBeCloseTo(G.lengthOf(e), 1);
      }
    }
  });
});

describe('mirroring text across its baseline direction', () => {
  // 'H' is its own mirror image, so the mirrored strokes must cover the mirrored extent.
  const inkBox = (ent, m) => {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const s of layoutText(ent).strokes) {
      for (let i = 0; i < s.length; i += 2) {
        const q = m ? G.apply(m, s[i], s[i + 1]) : { x: s[i], y: s[i + 1] };
        G.growBox(b, q.x, q.y);
      }
    }
    return b;
  };
  const m = G.mirror(0, 5, 1, 5.3);

  for (const valign of ['baseline', 'bottom', 'middle', 'top']) {
    it(`puts ${valign} text where its mirror image is, and back again`, () => {
      const t = { type: 'text', x: 3, y: 2, h: 2, rot: 0.7, value: 'H', halign: 'left', valign, widthFactor: 1, oblique: 0 };
      const once = G.transformEntity(t, m);
      const want = inkBox(t, m);
      inkBox(once).forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
      const twice = G.transformEntity(once, m);
      const orig = inkBox(t);
      inkBox(twice).forEach((v, i) => expect(v).toBeCloseTo(orig[i], 9));
    });
  }
});
