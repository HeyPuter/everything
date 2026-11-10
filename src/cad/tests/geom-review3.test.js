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

describe('trimming a long polyline among many cutters', () => {
  it('cuts at the two crossings next to the pick and nowhere else', () => {
    const pts = [];
    for (let i = 0; i <= 2000; i++) pts.push(i, i % 2, i % 5 === 0 ? 0.3 : 0);
    const poly = { type: 'polyline', pts, closed: false, width: 0 };
    const cutters = [];
    // Crossing cutters every 100 units, and many more that only come close.
    for (let x = 50.5; x < 2000; x += 100) cutters.push({ t: 'seg', x1: x, y1: -3, x2: x, y2: 3 });
    for (let x = 0.5; x < 2000; x += 1) cutters.push({ t: 'seg', x1: x, y1: 2.5, x2: x + 0.4, y2: 9 });
    cutters.push({ t: 'arc', cx: 1000, cy: 500, r: 100, a0: 0, a1: G.TWO_PI, full: true });
    const r = G.trimEntity(poly, cutters, 1000.2, 0.5);
    expect(r.add).toHaveLength(2);
    const [a, b] = r.add;
    expect(a.pts[0]).toBe(0);
    expect(a.pts.at(-3)).toBeCloseTo(950.5, 9);
    expect(b.pts[0]).toBeCloseTo(1050.5, 9);
    expect(b.pts.at(-3)).toBe(2000);
    expect(G.lengthOf(a) + G.lengthOf(b)).toBeLessThan(G.lengthOf(poly));
  });

  it('still finds cutters that only touch the object with an end', () => {
    const line = { type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 };
    const touch = [{ t: 'seg', x1: 4, y1: 0, x2: 4, y2: 5 }, { t: 'seg', x1: 7, y1: -5, x2: 7, y2: 0 }];
    const r = G.trimEntity(line, touch, 5, 0);
    expect(r.add.map((e) => [e.x1, e.x2])).toEqual([[0, 4], [7, 10]]);
  });
});

describe('objects that end exactly on an ellipse or spline', () => {
  const ell = { type: 'ellipse', cx: 2, cy: 1, mx: 5, my: 2, ratio: 0.5, start: 0, end: G.TWO_PI };
  const fit = [6, 0, 0, 5, -7, 1, -4, -6, 3, -5];
  const spl = { type: 'spline', ...G.splineFromFitPoints(fit), fit, closed: false };
  const at = (e, f) => {
    const pr = G.toPrims(e)[0];
    return G.curveAt(e, pr.us[0] + (pr.us.at(-1) - pr.us[0]) * f);
  };
  const touches = (hits, p) => hits.some((h) => Math.hypot(h.x - p.x, h.y - p.y) < 1e-9);

  it('intersects a line that reaches the curve from either side, at any angle', () => {
    for (const e of [ell, spl]) {
      for (let k = 1; k < 40; k++) {
        const p = at(e, k / 40);
        for (let a = 0; a < 12; a++) {
          const ang = 0.26 + (a * Math.PI) / 6;
          const line = { type: 'line', x1: p.x + 3 * Math.cos(ang), y1: p.y + 3 * Math.sin(ang), x2: p.x, y2: p.y };
          expect(touches(G.intersectEntities(e, line), p)).toBe(true);
          expect(touches(G.intersectEntities(line, e), p)).toBe(true);
        }
      }
    }
  });

  it('intersects a ray, an arc and a spline that start on the curve', () => {
    for (const e of [ell, spl]) {
      for (let k = 1; k < 20; k++) {
        const p = at(e, k / 20);
        const ang = k * 0.7;
        const ray = { type: 'ray', x: p.x, y: p.y, dx: Math.cos(ang), dy: Math.sin(ang) };
        expect(touches(G.intersectEntities(e, ray), p)).toBe(true);
        const arc = { type: 'arc', cx: p.x - 2 * Math.cos(ang), cy: p.y - 2 * Math.sin(ang), r: 2, start: ang, end: ang + 1 };
        expect(touches(G.intersectEntities(e, arc), p)).toBe(true);
        const other = G.splineFromFitPoints([p.x, p.y, p.x + 3 * Math.cos(ang), p.y + 3 * Math.sin(ang), p.x + 5, p.y + 4]);
        expect(touches(G.intersectEntities(e, { type: 'spline', ...other }), p)).toBe(true);
      }
    }
  });

  it('does not report an end that stops short of the curve', () => {
    for (let k = 1; k < 20; k++) {
      const p = at(ell, k / 20);
      const d = G.ellipseDeriv(ell, (k / 20) * G.TWO_PI);
      const l = Math.hypot(d.x, d.y);
      // outward normal of a counter-clockwise ellipse
      const nx = d.y / l,
        ny = -d.x / l;
      const line = { type: 'line', x1: p.x + 3 * nx, y1: p.y + 3 * ny, x2: p.x + 1e-6 * nx, y2: p.y + 1e-6 * ny };
      expect(G.intersectEntities(ell, line)).toEqual([]);
    }
  });

  it('trims an ellipse with lines drawn to its quadrant points', () => {
    const e = { type: 'ellipse', cx: 0, cy: 0, mx: 5, my: 0, ratio: 0.5, start: 0, end: G.TWO_PI };
    const cutters = [
      { t: 'seg', x1: 9, y1: 0, x2: 5, y2: 0 },
      { t: 'seg', x1: -8, y1: 0, x2: -5, y2: 0 },
    ];
    const r = G.trimEntity(e, cutters, 0, 2.5);
    expect(r.add).toHaveLength(1);
    expect(G.lengthOf(r.add[0])).toBeCloseTo(G.lengthOf(e) / 2, 6);
    expect(G.closestPoint(r.add[0], 0, 2.5).d).toBeGreaterThan(4);
  });
});

describe('fillet with a radius larger than the arc', () => {
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const joins = (arc, e) => Math.min(...G.endpoints(arc).flatMap((p) => G.endpoints(e).map((q) => near(p, q))));

  it('connects the fillet to both objects when its circle goes around the arc', () => {
    const arc = { id: 1, type: 'arc', cx: -0.889, cy: -3.328, r: 1.558, start: 4.712, end: 5.82 };
    const line = { id: 2, type: 'line', x1: -3.2085, y1: -4.638, x2: -7.1035, y2: 2.6063 };
    const f = G.fillet(arc, { x: 0.5045, y: -4.0241 }, line, { x: -3.2085, y: -4.638 }, 2.712);
    expect(f.arc.r).toBe(2.712);
    expect(joins(f.arc, f.e1)).toBeLessThan(1e-9);
    expect(joins(f.arc, f.e2)).toBeLessThan(1e-9);
    // the trimmed arc stays on its circle and the line on its carrier
    expect([f.e1.cx, f.e1.cy, f.e1.r]).toEqual([arc.cx, arc.cy, arc.r]);
    const d = Math.hypot(f.arc.cx - arc.cx, f.arc.cy - arc.cy);
    expect(Math.min(Math.abs(d - (2.712 + arc.r)), Math.abs(d - (2.712 - arc.r)))).toBeLessThan(1e-9);
  });
});
