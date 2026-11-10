import { describe, it, expect } from 'vitest';
import {
  TWO_PI,
  toPrims,
  intersectPrims,
  intersectEntities,
  selfIntersections,
  closestPoint,
  distanceTo,
  endpoints,
  midpoints,
  centers,
  quadrants,
  nodes,
  perpendicularFrom,
  tangentsFrom,
  geometricCenter,
  splineFromFitPoints,
  ellipsePoint,
} from '../src/core/geom/index.js';

const close = (a, b, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
const seg = (x1, y1, x2, y2) => ({ t: 'seg', x1, y1, x2, y2 });
const arc = (cx, cy, r, a0, a1) => ({ t: 'arc', cx, cy, r, a0, a1, full: a1 - a0 >= TWO_PI });
const inf = (x, y, dx, dy, ray = false) => {
  const l = Math.hypot(dx, dy);
  return { t: 'inf', x, y, dx: dx / l, dy: dy / l, ray };
};
const sortXY = (pts) => pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);

const ellipse = { type: 'ellipse', cx: 0, cy: 0, mx: 10, my: 0, ratio: 0.5, start: 0, end: TWO_PI };
const spline = { type: 'spline', ...splineFromFitPoints([-10, -3, -4, 4, 2, -2, 8, 5, 12, 0]), fit: [], closed: false };

describe('intersectPrims', () => {
  it('seg / seg crossing and parameters', () => {
    const h = intersectPrims(seg(0, 0, 10, 10), seg(0, 10, 10, 0));
    expect(h.length).toBe(1);
    close(h[0].x, 5);
    close(h[0].y, 5);
    close(h[0].ta, 0.5);
    close(h[0].tb, 0.5);
  });
  it('seg / seg miss, parallel and extended', () => {
    expect(intersectPrims(seg(0, 0, 1, 1), seg(0, 10, 10, 0))).toEqual([]);
    expect(intersectPrims(seg(0, 0, 10, 0), seg(0, 1, 10, 1))).toEqual([]);
    const h = intersectPrims(seg(0, 0, 1, 1), seg(0, 10, 10, 0), { extA: true });
    expect(h.length).toBe(1);
    close(h[0].ta, 5);
  });
  it('seg touching at an end point counts', () => {
    const h = intersectPrims(seg(0, 0, 10, 0), seg(10, 0, 10, 10));
    expect(h.length).toBe(1);
    close(h[0].ta, 1);
    close(h[0].tb, 0);
  });
  it('seg / inf and ray direction', () => {
    const h = intersectPrims(seg(-5, 2, 5, 2), inf(0, 0, 0, 1));
    expect(h.length).toBe(1);
    close(h[0].tb, 2);
    expect(intersectPrims(seg(-5, -2, 5, -2), inf(0, 0, 0, 1, true))).toEqual([]);
    expect(intersectPrims(seg(-5, -2, 5, -2), inf(0, 0, 0, 1, false)).length).toBe(1);
  });
  it('inf / inf', () => {
    const h = intersectPrims(inf(0, 0, 1, 0), inf(3, 3, 0, 1));
    expect(h.length).toBe(1);
    close(h[0].x, 3);
    close(h[0].y, 0);
    close(h[0].tb, -3);
  });
  it('line / circle: two points, tangent, miss', () => {
    const c = arc(0, 0, 5, 0, TWO_PI);
    const two = sortXY(intersectPrims(seg(-10, 3, 10, 3), c));
    expect(two.length).toBe(2);
    close(two[0].x, -4);
    close(two[1].x, 4);
    const tan = intersectPrims(seg(-10, 5, 10, 5), c);
    expect(tan.length).toBe(1);
    close(tan[0].x, 0);
    close(tan[0].y, 5);
    expect(intersectPrims(seg(-10, 6, 10, 6), c)).toEqual([]);
    // Segment too short to reach the circle.
    expect(intersectPrims(seg(-1, 0, 1, 0), c)).toEqual([]);
    expect(intersectPrims(seg(-1, 0, 1, 0), c, { extA: true }).length).toBe(2);
  });
  it('line / arc respects the sweep and reports angles', () => {
    const a = arc(0, 0, 5, 0, Math.PI);
    const h = intersectPrims(seg(-10, 3, 10, 3), a);
    expect(h.length).toBe(2);
    const below = intersectPrims(seg(-10, -3, 10, -3), a);
    expect(below).toEqual([]);
    expect(intersectPrims(seg(-10, -3, 10, -3), a, { extB: true }).length).toBe(2);
    const v = intersectPrims(a, seg(0, 0, 0, 10));
    expect(v.length).toBe(1);
    close(v[0].ta, Math.PI / 2);
    close(v[0].tb, 0.5);
  });
  it('arc wrapping through angle 0', () => {
    const a = arc(0, 0, 1, (7 * Math.PI) / 4, (9 * Math.PI) / 4);
    const h = intersectPrims(inf(0, 0, 1, 0), a);
    expect(h.length).toBe(1);
    close(h[0].x, 1);
    close(h[0].tb, TWO_PI);
  });
  it('circle / circle: two, tangent outside, tangent inside, none, concentric', () => {
    const c1 = arc(0, 0, 5, 0, TWO_PI);
    const two = sortXY(intersectPrims(c1, arc(8, 0, 5, 0, TWO_PI)));
    expect(two.length).toBe(2);
    close(two[0].x, 4);
    close(two[0].y, -3);
    const t1 = intersectPrims(c1, arc(10, 0, 5, 0, TWO_PI));
    expect(t1.length).toBe(1);
    close(t1[0].x, 5);
    const t2 = intersectPrims(c1, arc(2, 0, 3, 0, TWO_PI));
    expect(t2.length).toBe(1);
    close(t2[0].x, 5);
    expect(intersectPrims(c1, arc(20, 0, 5, 0, TWO_PI))).toEqual([]);
    expect(intersectPrims(c1, arc(0, 0, 3, 0, TWO_PI))).toEqual([]);
    expect(intersectPrims(c1, arc(0, 0, 5, 0, TWO_PI))).toEqual([]);
  });
  it('arc / arc sweep filtering', () => {
    const h = intersectPrims(arc(0, 0, 5, 0, Math.PI), arc(8, 0, 5, 0, TWO_PI));
    expect(h.length).toBe(1);
    close(h[0].y, 3);
  });
  it('line / ellipse is refined onto the exact curve', () => {
    const [pl] = toPrims(ellipse);
    const h = sortXY(intersectPrims(seg(-20, 3, 20, 3), pl));
    expect(h.length).toBe(2);
    const x = 10 * Math.sqrt(1 - (3 / 5) ** 2);
    close(h[0].x, -x, 1e-9);
    close(h[1].x, x, 1e-9);
    close(h[1].y, 3, 1e-12);
    const p = ellipsePoint(ellipse, h[1].tb);
    close(p.x, h[1].x, 1e-9);
  });
  it('circle / ellipse and ellipse / ellipse', () => {
    const [pl] = toPrims(ellipse);
    const h = intersectPrims(arc(0, 0, 7, 0, TWO_PI), pl);
    expect(h.length).toBe(4);
    for (const p of h) {
      close(Math.hypot(p.x, p.y), 7, 1e-9);
      close((p.x / 10) ** 2 + (p.y / 5) ** 2, 1, 1e-9);
    }
    const [pl2] = toPrims({ type: 'ellipse', cx: 0, cy: 0, mx: 0, my: 10, ratio: 0.5, start: 0, end: TWO_PI });
    const ee = intersectPrims(pl, pl2);
    expect(ee.length).toBe(4);
    for (const p of ee) {
      close((p.x / 10) ** 2 + (p.y / 5) ** 2, 1, 1e-9);
      close((p.x / 5) ** 2 + (p.y / 10) ** 2, 1, 1e-9);
    }
  });
  it('line / spline', () => {
    const [pl] = toPrims(spline);
    const h = intersectPrims(inf(0, 0, 1, 0), pl);
    expect(h.length).toBeGreaterThanOrEqual(3);
    for (const p of h) close(p.y, 0, 1e-9);
  });
  it('no intersection with distant curves', () => {
    const [pl] = toPrims(ellipse);
    expect(intersectPrims(seg(100, 100, 200, 200), pl)).toEqual([]);
    expect(intersectPrims(arc(100, 0, 1, 0, TWO_PI), pl)).toEqual([]);
  });
});

describe('intersectEntities', () => {
  it('intersects polylines with bulges and lines', () => {
    const poly = { type: 'polyline', pts: [0, 0, 0, 10, 0, 1, 10, 10, 0], closed: false };
    const line = { type: 'line', x1: 2, y1: -2, x2: 20, y2: 7 };
    const pts = intersectEntities(poly, line);
    // Crosses the bottom edge and the half circle on the right.
    expect(pts.length).toBe(2);
  });
  it('finds polyline self intersections', () => {
    const bow = { type: 'polyline', pts: [0, 0, 0, 10, 10, 0, 10, 0, 0, 0, 10, 0], closed: false };
    const s = selfIntersections(bow);
    expect(s.length).toBe(1);
    close(s[0].x, 5);
    close(s[0].y, 5);
  });
  it('reports neighbouring segments that cross away from their shared vertex', () => {
    // A line, then an arc, both curling back across the previous segment.
    const hook = { type: 'polyline', pts: [0, 0, -2, 10, 0, 0, 5, 20, 0], closed: false };
    expect(selfIntersections(hook).length).toBe(1);
    const arcs = { type: 'polyline', pts: [0, 0, 1, 10, 0, -3, 4, 2, 0], closed: false };
    const s = selfIntersections(arcs);
    expect(s.length).toBe(1);
    expect(s[0]).toMatchObject({ i: 0, j: 1 });
    // Shared vertices alone are not crossings, also across zero-length segments.
    const lens = { type: 'polyline', pts: [0, 0, 0.5, 10, 0, 0.5, 0, 0, 0], closed: true };
    expect(selfIntersections(lens)).toEqual([]);
    const sq = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0];
    const square = { type: 'polyline', pts: sq, closed: true };
    expect(selfIntersections(square)).toEqual([]);
  });
});

describe('closest point', () => {
  it('handles lines, rays and xlines', () => {
    const c = closestPoint({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }, 5, 3);
    close(c.x, 5);
    close(c.d, 3);
    const r = closestPoint({ type: 'ray', x: 0, y: 0, dx: 1, dy: 0 }, -5, 3);
    close(r.x, 0);
    const x = closestPoint({ type: 'xline', x: 0, y: 0, dx: 1, dy: 0 }, -5, 3);
    close(x.x, -5);
  });
  it('handles arcs (outside sweep goes to an end) and circles', () => {
    const a = { type: 'arc', cx: 0, cy: 0, r: 5, start: 0, end: Math.PI / 2 };
    const c = closestPoint(a, -1, -10);
    close(c.x, 5);
    close(c.y, 0);
    close(distanceTo({ type: 'circle', cx: 0, cy: 0, r: 5 }, 0, 9), 4);
  });
  it('handles polylines with bulges, ellipses and splines', () => {
    const poly = { type: 'polyline', pts: [0, 0, 1, 10, 0, 0], closed: false };
    const c = closestPoint(poly, 5, -20);
    close(c.x, 5);
    close(c.y, -5);
    const e = closestPoint(ellipse, 0, 20);
    close(e.x, 0, 1e-9);
    close(e.y, 5, 1e-9);
    const s = closestPoint(spline, 2, 10);
    // The foot is normal to the curve: compare with brute force sampling.
    let best = Infinity;
    const pl = toPrims(spline)[0].pts;
    for (let i = 0; i < pl.length; i += 2) best = Math.min(best, Math.hypot(pl[i] - 2, pl[i + 1] - 10));
    expect(s.d).toBeLessThanOrEqual(best + 1e-12);
    expect(closestPoint({ type: 'text', x: 0, y: 0 }, 0, 0)).toBe(null);
  });
});

describe('snaps', () => {
  const poly = { type: 'polyline', pts: [0, 0, 0, 10, 0, 1, 10, 10, 0], closed: false };
  it('endpoints and midpoints', () => {
    expect(endpoints({ type: 'line', x1: 0, y1: 0, x2: 4, y2: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ]);
    expect(endpoints(poly).length).toBe(3);
    const m = midpoints(poly);
    expect(m.length).toBe(2);
    close(m[1].x, 15);
    close(m[1].y, 5);
    const am = midpoints({ type: 'arc', cx: 0, cy: 0, r: 2, start: 0, end: Math.PI });
    close(am[0].x, 0);
    close(am[0].y, 2);
  });
  it('centers and quadrants', () => {
    const c = centers(poly);
    expect(c.length).toBe(1);
    close(c[0].x, 10);
    close(c[0].y, 5);
    expect(quadrants({ type: 'circle', cx: 0, cy: 0, r: 1 }).length).toBe(4);
    const q = quadrants({ type: 'arc', cx: 0, cy: 0, r: 1, start: -0.1, end: Math.PI / 2 + 0.1 });
    expect(q.length).toBe(2);
    expect(quadrants(ellipse).length).toBe(4);
    expect(nodes({ type: 'point', x: 3, y: 4 })).toEqual([{ x: 3, y: 4 }]);
  });
  it('perpendicular feet lie on the entity', () => {
    const f = perpendicularFrom({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }, 3, 5);
    expect(f).toEqual([{ x: 3, y: 0 }]);
    expect(perpendicularFrom({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }, 13, 5)).toEqual([]);
    const fc = perpendicularFrom({ type: 'circle', cx: 0, cy: 0, r: 5 }, 10, 0);
    expect(fc.length).toBe(2);
    const fa = perpendicularFrom({ type: 'arc', cx: 0, cy: 0, r: 5, start: -1, end: 1 }, 10, 0);
    expect(fa.length).toBe(1);
    const fe = perpendicularFrom(ellipse, 3, 20);
    expect(fe.length).toBeGreaterThanOrEqual(2);
    // Both feet on a small circle survive far from the origin.
    const o = 5e6;
    expect(perpendicularFrom({ type: 'circle', cx: o, cy: o, r: 0.4 }, o + 2, o + 0.1)).toHaveLength(2);
    const pl = { type: 'polyline', pts: [o, o, 0, o + 1, o, 0, o + 1, o + 1, 0], closed: false };
    expect(perpendicularFrom(pl, o + 0.5, o + 0.5)).toHaveLength(2);
  });
  it('tangent points from a base point', () => {
    const t = sortXY(tangentsFrom({ type: 'circle', cx: 0, cy: 0, r: 5 }, 10, 0));
    expect(t.length).toBe(2);
    close(t[0].x, 2.5);
    close(Math.abs(t[0].y), (5 * Math.sqrt(3)) / 2);
    expect(tangentsFrom({ type: 'circle', cx: 0, cy: 0, r: 5 }, 1, 0)).toEqual([]);
    const te = tangentsFrom(ellipse, 20, 0);
    expect(te.length).toBe(2);
    for (const p of te) {
      // Tangency: the line from the base point is perpendicular to the normal.
      const nx = p.x / 100,
        ny = p.y / 25;
      close((p.x - 20) * nx + p.y * ny, 0, 1e-9);
    }
  });
  it('geometric center of a closed polyline', () => {
    const g = geometricCenter({ type: 'polyline', pts: [0, 0, 0, 4, 0, 0, 4, 2, 0, 0, 2, 0], closed: true });
    close(g.x, 2);
    close(g.y, 1);
    expect(geometricCenter({ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 })).toBe(null);
  });
  it('geometric center of two-vertex closed polylines (donuts)', () => {
    const g = geometricCenter({ type: 'polyline', pts: [8, 7, 1, 2, 7, 1], closed: true, width: 1 });
    close(g.x, 5);
    close(g.y, 7);
    // Two straight vertices enclose nothing.
    expect(geometricCenter({ type: 'polyline', pts: [0, 0, 0, 4, 0, 0], closed: true })).toBe(null);
  });
});
