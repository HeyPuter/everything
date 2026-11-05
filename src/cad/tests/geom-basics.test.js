import { describe, it, expect } from 'vitest';
import {
  TWO_PI,
  normAngle,
  ccwSweep,
  angleInSweep,
  arcFromBulge,
  bulgeFromArc,
  bulgeMidpoint,
  bulgeLength,
  arcSegments,
  tessellate,
  entityBounds,
  evalSpline,
  splineFromFitPoints,
  splineFromControlPoints,
  tessellateSpline,
  splitSpline,
  subSpline,
  lengthOf,
  areaOf,
  signedAreaPolyline,
  pointInPolygon,
  centroidPolyline,
  ellipsePoint,
  ellipseParamOf,
  ellipseClosestParam,
  toPrims,
  subPolyline,
  reversePolyPts,
} from '../src/core/geom/index.js';
import { fitToSpline } from '../src/io/dxf/geom.js';

const close = (a, b, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe('angles', () => {
  it('normalizes to [0, 2PI)', () => {
    close(normAngle(-Math.PI / 2), 1.5 * Math.PI);
    close(normAngle(5 * Math.PI), Math.PI);
    expect(normAngle(TWO_PI)).toBe(0);
    expect(normAngle(-1e-18)).toBeLessThan(TWO_PI);
  });
  it('computes CCW sweeps and sweep membership', () => {
    close(ccwSweep(0, Math.PI / 2), Math.PI / 2);
    close(ccwSweep(Math.PI * 1.5, Math.PI / 2), Math.PI);
    close(ccwSweep(1, 1), TWO_PI);
    expect(angleInSweep(0.1, 6, 1)).toBe(true);
    expect(angleInSweep(3, 6, 1)).toBe(false);
  });
});

describe('bulge', () => {
  it('converts a half circle bulge to an arc', () => {
    const a = arcFromBulge(1, 0, -1, 0, 1);
    close(a.cx, 0);
    close(a.cy, 0);
    close(a.r, 1);
    expect(a.ccw).toBe(true);
    close(a.sweep, Math.PI);
    const m = bulgeMidpoint(1, 0, -1, 0, 1);
    close(m.x, 0);
    close(m.y, 1);
  });
  it('round trips arc and bulge', () => {
    const b = bulgeFromArc(0, 0, 5, 0, Math.PI / 2, true);
    close(b, Math.tan(Math.PI / 8));
    const a = arcFromBulge(5, 0, 0, 5, b);
    close(a.cx, 0);
    close(a.cy, 0);
    close(a.r, 5);
    const bcw = bulgeFromArc(0, 0, 5, Math.PI / 2, 0, false);
    close(bcw, -Math.tan(Math.PI / 8));
    const acw = arcFromBulge(0, 5, 5, 0, bcw);
    close(acw.cx, 0);
    close(acw.cy, 0);
    expect(acw.ccw).toBe(false);
  });
  it('measures bulged segment length', () => {
    close(bulgeLength(1, 0, -1, 0, 1), Math.PI);
    close(bulgeLength(0, 0, 3, 4, 0), 5);
    expect(arcFromBulge(0, 0, 1, 0, 0)).toBe(null);
  });
});

describe('tessellation', () => {
  it('keeps chord deviation within tolerance', () => {
    const r = 100,
      tol = 0.01;
    const [{ pts, closed }] = tessellate({ type: 'circle', cx: 0, cy: 0, r }, tol);
    expect(closed).toBe(true);
    const n = pts.length / 2;
    const step = TWO_PI / n;
    expect(r * (1 - Math.cos(step / 2))).toBeLessThanOrEqual(tol + 1e-12);
    // Not wildly over-tessellated either.
    expect(r * (1 - Math.cos(TWO_PI / (n - 2) / 2))).toBeGreaterThan(tol * 0.5);
  });
  it('clamps segment counts', () => {
    expect(arcSegments(1, TWO_PI, 1000)).toBe(8);
    expect(arcSegments(1e9, TWO_PI, 1e-9)).toBe(4096);
    expect(arcSegments(0, 1, 1)).toBe(1);
  });
  it('tessellates arcs, ellipses and polylines with bulges', () => {
    const [arc] = tessellate({ type: 'arc', cx: 0, cy: 0, r: 10, start: 0, end: Math.PI / 2 }, 0.001);
    close(arc.pts[0], 10);
    close(arc.pts[arc.pts.length - 1], 10);
    const [el] = tessellate({ type: 'ellipse', cx: 0, cy: 0, mx: 10, my: 0, ratio: 0.5, start: 0, end: TWO_PI }, 0.01);
    expect(el.closed).toBe(true);
    for (let i = 0; i < el.pts.length; i += 2) close((el.pts[i] / 10) ** 2 + (el.pts[i + 1] / 5) ** 2, 1, 1e-9);
    const [pl] = tessellate({ type: 'polyline', pts: [0, 0, 1, 10, 0, 0], closed: false }, 0.01);
    expect(pl.pts.length).toBeGreaterThan(8);
    close(pl.pts[pl.pts.length - 2], 10);
    for (let i = 0; i < pl.pts.length; i += 2) close(Math.hypot(pl.pts[i] - 5, pl.pts[i + 1]), 5, 1e-9);
    expect(tessellate({ type: 'text', x: 0, y: 0 }, 1)).toEqual([]);
  });
});

describe('bounds', () => {
  it('includes quadrant crossings of arcs', () => {
    const b = entityBounds({ type: 'arc', cx: 0, cy: 0, r: 2, start: Math.PI / 4, end: (3 * Math.PI) / 4 });
    close(b[0], -Math.SQRT2);
    close(b[2], Math.SQRT2);
    close(b[1], Math.SQRT2);
    close(b[3], 2);
    const w = entityBounds({ type: 'arc', cx: 0, cy: 0, r: 1, start: (7 * Math.PI) / 4, end: Math.PI / 4 });
    close(w[2], 1);
    close(w[0], Math.SQRT1_2);
  });
  it('bounds rotated ellipses exactly', () => {
    const a = 10,
      b = 5,
      th = Math.PI / 6;
    const e = { type: 'ellipse', cx: 1, cy: 2, mx: a * Math.cos(th), my: a * Math.sin(th), ratio: b / a, start: 0, end: TWO_PI };
    const box = entityBounds(e);
    const hx = Math.sqrt((a * Math.cos(th)) ** 2 + (b * Math.sin(th)) ** 2);
    const hy = Math.sqrt((a * Math.sin(th)) ** 2 + (b * Math.cos(th)) ** 2);
    close(box[0], 1 - hx);
    close(box[2], 1 + hx);
    close(box[1], 2 - hy);
    close(box[3], 2 + hy);
  });
  it('bounds polylines with bulges, splines and nulls', () => {
    const b = entityBounds({ type: 'polyline', pts: [0, 0, 1, 10, 0, 0], closed: false });
    close(b[1], -5);
    close(b[3], 0);
    const s = splineFromControlPoints([0, 0, 5, 10, 10, 0], 2);
    const sb = entityBounds({ type: 'spline', ...s, fit: [], closed: false });
    close(sb[3], 5, 1e-9);
    expect(entityBounds({ type: 'xline', x: 0, y: 0, dx: 1, dy: 0 })).toBe(null);
    expect(entityBounds({ type: 'text', x: 0, y: 0 })).toBe(null);
  });
});

describe('ellipse helpers', () => {
  it('maps points and parameters', () => {
    const e = { cx: 0, cy: 0, mx: 0, my: 4, ratio: 0.5, start: 0, end: TWO_PI };
    const p = ellipsePoint(e, Math.PI / 2);
    close(p.x, -2);
    close(p.y, 0);
    close(ellipseParamOf(e, p.x, p.y), Math.PI / 2);
  });
  it('finds the closest parameter', () => {
    const e = { cx: 0, cy: 0, mx: 10, my: 0, ratio: 0.5, start: 0, end: TWO_PI };
    const t = ellipseClosestParam(e, 20, 0);
    close(normAngle(t), 0);
    const t2 = ellipseClosestParam(e, 3, 20);
    const p = ellipsePoint(e, t2);
    // The connecting vector is normal to the ellipse.
    const d = { x: -10 * Math.sin(t2), y: 5 * Math.cos(t2) };
    close((p.x - 3) * d.x + (p.y - 20) * d.y, 0, 1e-8);
  });
});

describe('spline', () => {
  it('interpolates fit points', () => {
    const fit = [0, 0, 3, 4, 7, 2, 10, 8, 14, 3];
    const s = splineFromFitPoints(fit);
    expect(s.degree).toBe(3);
    expect(s.knots.length).toBe(s.ctrl.length / 2 + 4);
    // Fit point k is reached at its chord-length parameter.
    let total = 0;
    const d = [0];
    for (let i = 2; i < fit.length; i += 2) d.push((total += Math.hypot(fit[i] - fit[i - 2], fit[i + 1] - fit[i - 1])));
    for (let k = 0; k < fit.length / 2; k++) {
      const p = evalSpline(s, d[k] / total);
      close(p.x, fit[2 * k], 1e-9);
      close(p.y, fit[2 * k + 1], 1e-9);
    }
  });
  it('handles 2 and 3 fit points', () => {
    const s2 = splineFromFitPoints([0, 0, 10, 0]);
    expect(s2.ctrl.length).toBe(8);
    close(evalSpline(s2, 0.5).x, 5);
    close(evalSpline(s2, 0.5).y, 0);
    const s3 = splineFromFitPoints([0, 0, 5, 5, 10, 0]);
    const m = evalSpline(s3, 0.5);
    close(m.x, 5, 1e-9);
    close(m.y, 5, 1e-9);
    expect(splineFromFitPoints([1, 1, 1, 1])).toBe(null);
  });
  it('builds the same curve as AutoCAD (and the DXF importer) from fit points', () => {
    const open = [0, 0, 5, 3, 10, 0, 12, 6];
    const sq = [0, 0, 10, 0, 10, 10, 0, 10];
    for (const [fit, closed, st, et] of [
      [open, false],
      [sq, true],
      [open, false, [1, 0], [0, 1]],
    ]) {
      const a = splineFromFitPoints(fit, closed, st, et);
      const b = fitToSpline(fit, closed, st, et);
      a.ctrl.forEach((v, i) => close(v, b.ctrl[i], 1e-12));
      a.knots.forEach((v, i) => close(v, b.knots[i], 1e-15));
    }
    // Without end tangents the ends have zero curvature: the first three
    // control points are collinear with spacing given by the first knots.
    const s = splineFromFitPoints(open);
    const [x0, y0, x1, y1, x2, y2] = s.ctrl;
    close((x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1), 0, 1e-9);
  });
  it('builds closed interpolating splines', () => {
    const s = splineFromFitPoints([0, 0, 10, 0, 10, 10, 0, 10], true);
    const a = evalSpline(s, 0),
      b = evalSpline(s, 1);
    close(a.x, b.x);
    close(a.y, b.y);
  });
  it('tessellates and splits', () => {
    const s = splineFromControlPoints([0, 0, 0, 10, 10, 10, 10, 0], 3);
    const pts = tessellateSpline(s, 0.001);
    close(pts[0], 0);
    close(pts[pts.length - 2], 10);
    const [l, r] = splitSpline(s, 0.3);
    const p = evalSpline(s, 0.3);
    const le = evalSpline(l, 0.3),
      rs = evalSpline(r, 0.3);
    close(le.x, p.x);
    close(rs.y, p.y);
    const q = evalSpline(s, 0.6);
    const q2 = evalSpline(r, 0.6);
    close(q.x, q2.x);
    close(q.y, q2.y);
    const mid = subSpline(s, 0.2, 0.8);
    close(evalSpline(mid, 0.5).x, evalSpline(s, 0.5).x);
  });
});

describe('measure', () => {
  it('computes area of a rectangle polyline with a half-circle bulge', () => {
    // 10 x 5 rectangle whose top edge is replaced by an outward half circle.
    const pts = [0, 0, 0, 10, 0, 0, 10, 5, 1, 0, 5, 0];
    const poly = { type: 'polyline', pts, closed: true };
    close(areaOf(poly), 50 + (Math.PI * 25) / 2, 1e-9);
    close(signedAreaPolyline(pts, true), 50 + (Math.PI * 25) / 2, 1e-9);
    close(lengthOf(poly), 10 + 5 + 5 + Math.PI * 5, 1e-9);
    // Clockwise order gives a negative signed area.
    close(signedAreaPolyline(reversePolyPts(pts, true), true), -(50 + (Math.PI * 25) / 2), 1e-9);
  });
  it('finds the centroid of a closed polyline with a bulge', () => {
    // Full circle as two half-circle bulges.
    const c = centroidPolyline([1, 2, 1, -1, 2, 1]);
    close(c.x, 0, 1e-12);
    close(c.y, 2, 1e-12);
    close(c.area, Math.PI, 1e-12);
    const sq = centroidPolyline([0, 0, 0, 4, 0, 0, 4, 2, 0, 0, 2, 0]);
    close(sq.x, 2);
    close(sq.y, 1);
  });
  it('measures lengths and areas of curves', () => {
    close(lengthOf({ type: 'circle', cx: 0, cy: 0, r: 2 }), 4 * Math.PI);
    close(lengthOf({ type: 'arc', cx: 0, cy: 0, r: 2, start: 0, end: Math.PI }), 2 * Math.PI);
    close(lengthOf({ type: 'ellipse', cx: 0, cy: 0, mx: 3, my: 0, ratio: 1, start: 0, end: TWO_PI }), 6 * Math.PI, 1e-9);
    // Known value for a = 2, b = 1 (perimeter 9.688448220547676).
    close(lengthOf({ type: 'ellipse', cx: 0, cy: 0, mx: 2, my: 0, ratio: 0.5, start: 0, end: TWO_PI }), 9.688448220547676, 1e-9);
    close(areaOf({ type: 'ellipse', cx: 0, cy: 0, mx: 2, my: 0, ratio: 0.5, start: 0, end: TWO_PI }), 2 * Math.PI);
    close(lengthOf({ type: 'spline', ...splineFromControlPoints([0, 0, 10, 0], 1), fit: [], closed: false }), 10);
    const hatch = {
      type: 'hatch',
      loops: [
        [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
        [2, 2, 0, 4, 2, 0, 4, 4, 0, 2, 4, 0],
      ],
    };
    close(areaOf(hatch), 96);
  });
  it('tests points in polygons', () => {
    const sq = [0, 0, 4, 0, 4, 4, 0, 4];
    expect(pointInPolygon(2, 2, sq)).toBe(true);
    expect(pointInPolygon(5, 2, sq)).toBe(false);
  });
});

describe('primitives and polyline helpers', () => {
  it('decomposes polylines with segment indices', () => {
    const prims = toPrims({ type: 'polyline', pts: [0, 0, 0, 10, 0, -1, 10, 10, 0], closed: true });
    expect(prims.map((p) => p.t)).toEqual(['seg', 'arc', 'seg']);
    expect(prims.map((p) => p.seg)).toEqual([0, 1, 2]);
    expect(prims[1].rev).toBe(true);
    expect(prims[1].a1).toBeGreaterThan(prims[1].a0);
    expect(toPrims({ type: 'text' })).toEqual([]);
    expect(toPrims({ type: 'circle', cx: 0, cy: 0, r: 1 })[0]).toMatchObject({ a0: 0, a1: TWO_PI, full: true });
  });
  it('extracts sub-polylines with partial bulges', () => {
    const pts = [0, 0, 1, 10, 0, 0, 10, 10, 0];
    const sub = subPolyline(pts, false, 0.5, 1.5);
    expect(sub.length).toBe(9);
    close(sub[0], 5);
    close(sub[1], -5);
    close(sub[2], Math.tan(Math.PI / 8));
    close(sub[6], 10);
    close(sub[7], 5);
  });
});
