import { describe, it, expect } from 'vitest';
import {
  TWO_PI,
  normAngle,
  toPrims,
  offsetEntity,
  offsetPolylinePts,
  trimEntity,
  extendEntity,
  breakEntity,
  breakAtPoint,
  fillet,
  filletPolyline,
  chamfer,
  chamferPolyline,
  joinEntities,
  explodePolyline,
  explodeEntity,
  areaOf,
  lengthOf,
  endpoints,
  distanceTo,
  closestPoint,
  arcFromBulge,
  ellipsePoint,
  splineFromFitPoints,
  evalSpline,
  splineDomain,
  tessellate,
} from '../src/core/geom/index.js';

const close = (a, b, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
const closePt = (p, q, eps = 1e-9) => {
  close(p.x, q.x, eps);
  close(p.y, q.y, eps);
};
const line = (x1, y1, x2, y2, extra = {}) => ({ type: 'line', layer: 'L1', color: 2, x1, y1, x2, y2, ...extra });
const vline = (x) => toPrims(line(x, -100, x, 100))[0];
const hline = (y) => toPrims(line(-100, y, 100, y))[0];
const rect = (w, h, extra = {}) => ({ type: 'polyline', pts: [0, 0, 0, w, 0, 0, w, h, 0, 0, h, 0], closed: true, width: 0, ...extra });

describe('offset', () => {
  it('offsets lines, xlines and rays to the picked side', () => {
    const l = offsetEntity(line(0, 0, 10, 0, { id: 4 }), 2, 5, 5);
    expect(l).toMatchObject({ type: 'line', x1: 0, y1: 2, x2: 10, y2: 2, layer: 'L1', color: 2 });
    expect(l.id).toBeUndefined();
    const r = offsetEntity(line(0, 0, 10, 0), 2, 5, -5);
    close(r.y1, -2);
    const x = offsetEntity({ type: 'xline', x: 0, y: 0, dx: 0, dy: 1 }, 3, 10, 0);
    close(x.x, 3);
    expect(offsetEntity(line(0, 0, 10, 0), 2, 20, 0)).toBe(null);
  });
  it('offsets circles and arcs, refusing collapse', () => {
    expect(offsetEntity({ type: 'circle', cx: 0, cy: 0, r: 5 }, 1, 10, 0).r).toBe(6);
    expect(offsetEntity({ type: 'circle', cx: 0, cy: 0, r: 5 }, 1, 1, 0).r).toBe(4);
    expect(offsetEntity({ type: 'circle', cx: 0, cy: 0, r: 5 }, 5, 1, 0)).toBe(null);
    const a = offsetEntity({ type: 'arc', cx: 0, cy: 0, r: 5, start: 0, end: 1 }, 2, 0, 0);
    expect(a).toMatchObject({ type: 'arc', r: 3, start: 0, end: 1 });
  });
  it('offsets a closed rectangle inward and outward', () => {
    for (const poly of [rect(10, 6), { ...rect(10, 6), pts: [0, 6, 0, 10, 6, 0, 10, 0, 0, 0, 0, 0] }]) {
      const inner = offsetEntity(poly, 1, 5, 3);
      expect(inner.closed).toBe(true);
      expect(inner.pts.length).toBe(12);
      close(areaOf(inner), 8 * 4);
      const outer = offsetEntity(poly, 1, 20, 3);
      expect(outer.pts.length).toBe(12);
      close(areaOf(outer), 12 * 8);
    }
  });
  it('offsets a closed stadium with bulges', () => {
    const st = { type: 'polyline', pts: [0, 0, 0, 10, 0, 1, 10, 10, 0, 0, 10, 1], closed: true, width: 0 };
    close(areaOf(st), 100 + Math.PI * 25);
    const out = offsetEntity(st, 2, 30, 5);
    close(areaOf(out), 10 * 14 + Math.PI * 49, 1e-9);
    const inn = offsetEntity(st, 2, 5, 5);
    close(areaOf(inn), 10 * 6 + Math.PI * 9, 1e-9);
  });
  it('splits inward offsets of closed polylines where a neck collapses', () => {
    // Two 10 x 10 squares joined by a 2-high neck.
    const pts = [0, 0, 0, 10, 0, 0, 10, 4, 0, 20, 4, 0, 20, 0, 0, 30, 0, 0];
    pts.push(30, 10, 0, 20, 10, 0, 20, 6, 0, 10, 6, 0, 10, 10, 0, 0, 10, 0);
    const db = { type: 'polyline', layer: 'L1', pts, closed: true, width: 0 };
    close(areaOf(offsetEntity(db, 0.5, 5, 5)), 173);
    for (const [d, side] of [
      [1, 8],
      [1.5, 7],
      [3, 4],
    ]) {
      const r = offsetEntity(db, d, 5, 5);
      expect(r).toHaveLength(2);
      for (const e of r) {
        expect(e.closed).toBe(true);
        expect(e.layer).toBe('L1');
        expect(e.pts).toHaveLength(12);
        close(areaOf(e), side * side);
      }
    }
    expect(offsetEntity(db, 6, 5, 5)).toBe(null);
    // An L whose arms are thinner than twice the distance leaves nothing.
    const l = {
      type: 'polyline',
      pts: [0, 0, 0, 10, 0, 0, 10, 2, 0, 2, 2, 0, 2, 10, 0, 0, 10, 0],
      closed: true,
    };
    expect(offsetEntity(l, 1.5, 1, 1)).toBe(null);
    close(areaOf(offsetEntity(l, 0.5, 1, 1)), 17);
    // Outward offsets close a narrow gap.
    const c = {
      type: 'polyline',
      pts: [0, 0, 0, 10, 0, 0, 10, 1, 0, 1, 1, 0, 1, 9, 0, 10, 9, 0, 10, 10, 0, 0, 10, 0],
      closed: true,
    };
    const o = offsetEntity(c, 4, -5, 5);
    expect(o.pts).toHaveLength(12);
    close(areaOf(o), 18 * 18);
  });
  it('drops offset loops that end up outside the shape', () => {
    // Collapsing inward offset whose raw corners overshoot far outside.
    const pts = [
      7.119, 0, 0, 6.424, 2.661, -0.265, 5.419, 5.419, 0, 2.141, 5.17, 0, 0, 9.795, -0.154, -1.494,
      3.608, 0, -6.145, 6.145, 0, -7.271, 3.012, -0.004, -5.106, 0, 0, -2.866, -1.187, 0, -3.483,
      -3.483, 0, -2.88, -6.954, 0, 0, -7.483, 0, 1.22, -2.946, -0.263, 5.373, -5.373, 0, 8.483,
      -3.514, 0,
    ];
    const p = { type: 'polyline', pts, closed: true, width: 0 };
    const o = offsetEntity(p, 3, 0, 0);
    expect(Array.isArray(o)).toBe(false);
    const [{ pts: ring }] = tessellate(o, 1e-4);
    for (let i = 0; i < ring.length; i += 2) {
      expect(distanceTo(p, ring[i], ring[i + 1])).toBeGreaterThan(3 - 1e-9);
    }
    close(areaOf(o), 6.9085, 1e-4);
  });
  it('offsets open polylines with tangent arcs keeping a constant distance', () => {
    const b = Math.tan(Math.PI / 8);
    const p = { type: 'polyline', pts: [0, 0, 0, 10, 0, b, 15, 5, 0, 15, 20, 0], closed: false, width: 0 };
    const o = offsetEntity(p, 1.5, 5, 5);
    expect(o.closed).toBe(false);
    const [{ pts }] = tessellate(o, 1e-4);
    for (let i = 0; i < pts.length; i += 2) close(distanceTo(p, pts[i], pts[i + 1]), 1.5, 1e-9);
    close(o.pts[0], 0);
    close(o.pts[1], 1.5);
    const arc = arcFromBulge(o.pts[3], o.pts[4], o.pts[6], o.pts[7], o.pts[5]);
    close(arc.r, 3.5);
  });
  it('miters outer corners and trims inner corners of open polylines', () => {
    const p = { type: 'polyline', pts: [0, 0, 0, 10, 0, 0, 10, 10, 0], closed: false, width: 0 };
    const inner = offsetEntity(p, 1, 5, 5);
    const want = [0, 1, 0, 9, 1, 0, 9, 10, 0];
    expect(inner.pts.length).toBe(9);
    want.forEach((v, i) => close(inner.pts[i], v));
    const outer = offsetEntity(p, 1, 5, -5);
    const want2 = [0, -1, 0, 11, -1, 0, 11, 10, 0];
    expect(outer.pts.length).toBe(9);
    want2.forEach((v, i) => close(outer.pts[i], v));
  });
  it('drops collapsed arc segments and joins the neighbours', () => {
    // A small CCW arc that collapses when offset 2 to the left.
    const p = { type: 'polyline', pts: [0, 0, 0, 10, 0, Math.tan(Math.PI / 8), 11, 1, 0, 11, 10, 0], closed: false, width: 0 };
    const o = offsetEntity(p, 2, 5, 5);
    expect(o).not.toBe(null);
    expect(o.pts.filter((v, i) => i % 3 === 2 && v !== 0).length).toBe(0);
    close(o.pts[3], 9);
    close(o.pts[4], 2);
  });
  it('gives a finite bulge when one arc survives collapse removal', () => {
    const pts = [5.145, 0, 0.346, -2.7526, 4.7677, -0.7423, -2.2468, -3.8916, 0];
    const r = offsetPolylinePts(pts, true, -5);
    expect(r.pts.length).toBe(6);
    expect(r.pts.every(Number.isFinite)).toBe(true);
  });
  it('removes many collapsing segments of a dense wavy outline', () => {
    const pts = [];
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TWO_PI;
      const r = 100 + 5 * Math.sin(a * 40);
      pts.push(r * Math.cos(a), r * Math.sin(a), 0);
    }
    const o = offsetEntity({ type: 'polyline', pts, closed: true }, 3, 0, 0);
    expect(o.closed).toBe(true);
    for (let i = 0; i < o.pts.length; i += 3) {
      expect(Math.hypot(o.pts[i], o.pts[i + 1])).toBeLessThan(105 - 3 + 1e-6);
    }
  });
  it('offsets ellipses and splines as polylines within tolerance', () => {
    const e = { type: 'ellipse', cx: 0, cy: 0, mx: 10, my: 0, ratio: 0.5, start: 0, end: TWO_PI };
    const o = offsetEntity(e, 1, 0, 20);
    expect(o.type).toBe('polyline');
    expect(o.closed).toBe(true);
    for (let i = 0; i < o.pts.length; i += 3) close(distanceTo(e, o.pts[i], o.pts[i + 1]), 1, 1e-6);
    const s = { type: 'spline', ...splineFromFitPoints([0, 0, 5, 3, 10, 0]), fit: [], closed: false };
    const os = offsetEntity(s, 0.5, 5, 10);
    for (let i = 0; i < os.pts.length; i += 3) close(distanceTo(s, os.pts[i], os.pts[i + 1]), 0.5, 1e-6);
  });
});

describe('trim', () => {
  it('removes the middle of a line between two cutters', () => {
    const r = trimEntity(line(0, 0, 10, 0, { id: 9 }), [vline(3), vline(7)], 5, 0.1);
    expect(r.remove).toBe(true);
    expect(r.add.length).toBe(2);
    expect(r.add[0]).toMatchObject({ type: 'line', x1: 0, y1: 0, layer: 'L1' });
    close(r.add[0].x2, 3);
    close(r.add[1].x1, 7);
    expect(r.add[1].x2).toBe(10);
    expect(r.add[0].id).toBeUndefined();
  });
  it('removes an end piece and ignores non-crossing cutters', () => {
    const r = trimEntity(line(0, 0, 10, 0), [vline(3), vline(7)], 1, 0);
    expect(r.add.length).toBe(1);
    close(r.add[0].x1, 3);
    expect(trimEntity(line(0, 0, 10, 0), [vline(30)], 1, 0)).toBe(null);
    // A cutter through an end point does not count.
    expect(trimEntity(line(0, 0, 10, 0), [vline(10)], 5, 0)).toBe(null);
  });
  it('turns a circle into an arc', () => {
    const c = { type: 'circle', layer: '0', cx: 0, cy: 0, r: 5 };
    const r = trimEntity(c, [vline(0)], 5, 0);
    expect(r.add.length).toBe(1);
    const a = r.add[0];
    expect(a.type).toBe('arc');
    close(a.start, Math.PI / 2);
    close(a.end, (3 * Math.PI) / 2);
    expect(trimEntity(c, [hline(5)], 5, 0)).toBe(null);
  });
  it('trims arcs', () => {
    const a = { type: 'arc', cx: 0, cy: 0, r: 5, start: 0, end: Math.PI };
    const r = trimEntity(a, [vline(0)], 4, 3);
    expect(r.add.length).toBe(1);
    close(r.add[0].start, Math.PI / 2);
    close(r.add[0].end, Math.PI);
  });
  it('turns xlines into rays and rays into lines', () => {
    const x = { type: 'xline', x: 0, y: 0, dx: 1, dy: 0 };
    const r = trimEntity(x, [vline(5)], 10, 0);
    expect(r.add.length).toBe(1);
    expect(r.add[0]).toMatchObject({ type: 'ray', dx: -1, dy: 0 });
    close(r.add[0].x, 5);
    const r2 = trimEntity(x, [vline(-5), vline(5)], 0, 0);
    expect(r2.add.map((e) => e.type)).toEqual(['ray', 'ray']);
    const ray = { type: 'ray', x: 0, y: 0, dx: 1, dy: 0 };
    const r3 = trimEntity(ray, [vline(5)], 10, 0);
    expect(r3.add[0]).toMatchObject({ type: 'line', x1: 0, y1: 0 });
    close(r3.add[0].x2, 5);
  });
  it('splits an open polyline', () => {
    const p = { type: 'polyline', pts: [0, 0, 0, 10, 0, 0, 10, 10, 0, 20, 10, 0], closed: false, width: 0.5 };
    const r = trimEntity(p, [vline(5), hline(5)], 10, 2);
    expect(r.add.length).toBe(2);
    expect(r.add[0].pts).toEqual([0, 0, 0, 5, 0, 0]);
    const b = r.add[1].pts;
    close(b[0], 10);
    close(b[1], 5);
    expect(b.slice(3)).toEqual([10, 10, 0, 20, 10, 0]);
    expect(r.add[1].width).toBe(0.5);
  });
  it('opens a closed polyline', () => {
    const r = trimEntity(rect(10, 10), [vline(5)], 10, 5);
    expect(r.add.length).toBe(1);
    const q = r.add[0];
    expect(q.closed).toBe(false);
    close(lengthOf(q), 20);
    expect(q.pts.length).toBe(4 * 3);
  });
  it('trims polyline arc segments on the circle', () => {
    const p = { type: 'polyline', pts: [0, 0, 1, 10, 0, 0], closed: false, width: 0 };
    const r = trimEntity(p, [vline(5)], 9, -3);
    expect(r.add.length).toBe(1);
    const q = r.add[0];
    const arc = arcFromBulge(q.pts[0], q.pts[1], q.pts[3], q.pts[4], q.pts[2]);
    close(arc.cx, 5);
    close(arc.cy, 0);
    close(arc.r, 5);
    closePt({ x: q.pts[3], y: q.pts[4] }, { x: 5, y: -5 });
  });
  it('trims a full ellipse into an elliptical arc', () => {
    const e = { type: 'ellipse', cx: 0, cy: 0, mx: 10, my: 0, ratio: 0.5, start: 0, end: TWO_PI };
    const r = trimEntity(e, [vline(0)], 10, 0);
    const a = r.add[0];
    expect(a.type).toBe('ellipse');
    close(a.start, Math.PI / 2, 1e-9);
    close(a.end, (3 * Math.PI) / 2, 1e-9);
  });
  it('trims splines at the exact intersection', () => {
    const s = { type: 'spline', ...splineFromFitPoints([0, 0, 5, 4, 10, 0, 15, 4]), fit: [], closed: false };
    const r = trimEntity(s, [vline(7)], 2, 2);
    expect(r.add.length).toBe(1);
    const q = r.add[0];
    const [u0] = splineDomain(q);
    const p = evalSpline(q, u0);
    close(p.x, 7, 1e-9);
    expect(closestPoint(s, p.x, p.y).d).toBeLessThan(1e-9);
  });
});

describe('extend', () => {
  it('extends the nearer end of a line', () => {
    const b = [toPrims(line(10, -5, 10, 5))[0], toPrims(line(-3, -5, -3, 5))[0]];
    const e = extendEntity(line(0, 0, 5, 0, { id: 3 }), b, 4, 0);
    expect(e.id).toBe(3);
    close(e.x2, 10);
    expect(e.x1).toBe(0);
    const s = extendEntity(line(0, 0, 5, 0), b, 1, 0);
    close(s.x1, -3);
    expect(extendEntity(line(0, 0, 5, 0), [toPrims(line(20, 5, 30, 5))[0]], 4, 0)).toBe(null);
  });
  it('extends arcs', () => {
    const a = { type: 'arc', cx: 0, cy: 0, r: 5, start: 0, end: Math.PI / 2 };
    const r = extendEntity(a, [hline(-3)], 5, 0.5);
    close(r.start, normAngle(Math.asin(-3 / 5)));
    close(r.end, Math.PI / 2);
    const r2 = extendEntity(a, [vline(-4)], 0.5, 5);
    close(r2.end, Math.PI - Math.acos(4 / 5));
  });
  it('extends rays and open polylines (line and arc ends)', () => {
    const ray = extendEntity({ type: 'ray', x: 0, y: 0, dx: 1, dy: 0 }, [vline(-4)], 1, 0);
    close(ray.x, -4);
    const p = { type: 'polyline', pts: [0, 0, 0, 5, 0, 0, 5, 5, 0], closed: false, width: 0 };
    const e = extendEntity(p, [hline(9)], 5, 4);
    close(e.pts[7], 9);
    // Last segment is a quarter arc (CCW) around (0, 5) from (5, 5) to (0, 10).
    const pa = { type: 'polyline', pts: [5, 0, 0, 5, 5, Math.tan(Math.PI / 8), 0, 10, 0], closed: false, width: 0 };
    const ea = extendEntity(pa, [vline(-3)], 0.1, 10);
    closePt({ x: ea.pts[6], y: ea.pts[7] }, { x: -3, y: 9 });
    const arc = arcFromBulge(ea.pts[3], ea.pts[4], ea.pts[6], ea.pts[7], ea.pts[5]);
    close(arc.cx, 0);
    close(arc.cy, 5);
    close(arc.r, 5);
  });
});

describe('break', () => {
  it('breaks lines and circles', () => {
    const r = breakEntity(line(0, 0, 10, 0), 7, 0, 3, 0);
    expect(r.length).toBe(2);
    close(r[0].x2, 3);
    close(r[1].x1, 7);
    const c = breakEntity({ type: 'circle', cx: 0, cy: 0, r: 5 }, 5, 0, 0, 5);
    expect(c.length).toBe(1);
    close(c[0].start, Math.PI / 2);
    close(normAngle(c[0].end), 0);
  });
  it('splits at a point', () => {
    const r = breakAtPoint(line(0, 0, 10, 0), 4, 1);
    expect(r.length).toBe(2);
    close(r[0].x2, 4);
    close(r[1].x1, 4);
    const p = breakAtPoint({ type: 'polyline', pts: [0, 0, 0, 10, 0, 0, 10, 10, 0], closed: false, width: 0 }, 10, 5);
    expect(p.length).toBe(2);
    expect(p[1].pts).toEqual([10, 5, 0, 10, 10, 0]);
    expect(breakAtPoint({ type: 'circle', cx: 0, cy: 0, r: 1 }, 1, 0)).toBe(null);
    const cl = breakAtPoint(rect(10, 10), 5, 0);
    expect(cl.length).toBe(1);
    close(lengthOf(cl[0]), 40);
  });
});

describe('fillet and chamfer', () => {
  it('fillets two lines with a tangent arc', () => {
    const l1 = line(0, 0, 10, 0, { id: 1 }),
      l2 = line(12, 2, 12, 10, { id: 2 });
    const r = fillet(l1, { x: 5, y: 0 }, l2, { x: 12, y: 5 }, 2);
    expect(r.arc).toMatchObject({ type: 'arc', r: 2 });
    close(r.arc.cx, 10);
    close(r.arc.cy, 2);
    close(normAngle(r.arc.end - r.arc.start), Math.PI / 2);
    const ends = endpoints(r.arc);
    // Arc ends are the tangent points, which are line ends.
    closePt(ends[0], { x: 10, y: 0 });
    closePt(ends[1], { x: 12, y: 2 });
    expect(r.e1.id).toBe(1);
    close(r.e1.x2, 10);
    close(r.e2.y1, 2);
  });
  it('fillets crossing lines keeping the picked quadrant', () => {
    const r = fillet(line(-10, 0, 10, 0), { x: 5, y: 0 }, line(0, -10, 0, 10), { x: 0, y: 5 }, 1);
    close(r.e1.x1, 1);
    expect(r.e1.x2).toBe(10);
    close(r.e2.y1, 1);
    close(r.arc.cx, 1);
    close(r.arc.cy, 1);
    // Tangency: the centre is at distance r from both lines.
    close(Math.abs(r.arc.cy), r.arc.r);
    close(Math.abs(r.arc.cx), r.arc.r);
    // Oblique lines: tangent points are feet of the centre.
    const o = fillet(line(0, 0, 10, 0), { x: 8, y: 0 }, line(0, 0, 10, 6), { x: 8, y: 4.8 }, 1.5);
    const c = { x: o.arc.cx, y: o.arc.cy };
    close(distanceTo(line(0, 0, 10, 6), c.x, c.y), 1.5);
    close(c.y, 1.5);
    for (const p of endpoints(o.arc)) expect(Math.min(distanceTo(o.e1, p.x, p.y), distanceTo(o.e2, p.x, p.y))).toBeLessThan(1e-9);
  });
  it('makes a sharp corner with radius 0', () => {
    const r = fillet(line(0, 0, 5, 0), { x: 1, y: 0 }, line(10, 2, 10, 8), { x: 10, y: 5 }, 0);
    expect(r.arc).toBe(null);
    close(r.e1.x2, 10);
    close(r.e2.y1, 0);
    expect(r.e2.y2).toBe(8);
  });
  it('joins parallel lines with a half circle', () => {
    const r = fillet(line(0, 0, 10, 0), { x: 9, y: 0 }, line(0, 4, 6, 4), { x: 3, y: 4 }, 1);
    close(r.arc.r, 2);
    close(r.arc.cx, 10);
    close(r.arc.cy, 2);
    close(normAngle(r.arc.end - r.arc.start), Math.PI);
    close(r.e2.x2, 10);
  });
  it('fillets a line and an arc', () => {
    const l = line(-10, 0, 10, 0);
    const a = { type: 'arc', cx: 0, cy: 5, r: 3, start: Math.PI, end: Math.PI / 2 };
    const r = fillet(l, { x: 5, y: 0 }, a, { x: 3, y: 5 }, 1.5);
    expect(r).not.toBe(null);
    const c = { x: r.arc.cx, y: r.arc.cy };
    close(c.y, 1.5);
    close(Math.hypot(c.x, c.y - 5), 4.5);
    expect(c.x).toBeGreaterThan(0);
    close(r.e1.x1, c.x);
    close(r.e2.start, normAngle(Math.atan2(c.y - 5, c.x)));
  });
  it('chamfers two lines', () => {
    const r = chamfer(line(0, 0, 10, 0), { x: 5, y: 0 }, line(0, 0, 0, 10), { x: 0, y: 5 }, 2, 3);
    close(r.e1.x1, 2);
    close(r.e2.y1, 3);
    expect(r.line).toMatchObject({ type: 'line' });
    closePt({ x: r.line.x1, y: r.line.y1 }, { x: 2, y: 0 });
    closePt({ x: r.line.x2, y: r.line.y2 }, { x: 0, y: 3 });
  });
  it('fillets and chamfers polylines', () => {
    const f = filletPolyline(rect(10, 6, { id: 5 }), 1);
    expect(f.id).toBe(5);
    expect(f.pts.length).toBe(8 * 3);
    close(areaOf(f), 60 - 4 + Math.PI);
    close(lengthOf(f), 32 - 8 + 2 * Math.PI);
    expect(filletPolyline(rect(10, 6), 4)).toBe(null);
    const c = chamferPolyline(rect(10, 6), 1);
    close(areaOf(c), 58);
  });
});

describe('join', () => {
  it('merges collinear overlapping lines', () => {
    const r = joinEntities([line(0, 0, 5, 0, { id: 1 }), line(10, 0, 5, 0, { id: 2 }), line(3, 0, 7, 0, { id: 3 }), line(0, 1, 5, 1, { id: 4 })]);
    expect(r.result.length).toBe(1);
    expect(r.result[0]).toMatchObject({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0, layer: 'L1' });
    expect(r.consumedIds.sort()).toEqual([1, 2, 3]);
  });
  it('merges arcs into arcs and full circles', () => {
    const a = (id, s, e) => ({ id, type: 'arc', cx: 1, cy: 1, r: 2, start: s, end: e });
    const r = joinEntities([a(1, 0, 1), a(2, 1, 2)]);
    expect(r.result).toEqual([expect.objectContaining({ type: 'arc', start: 0, end: 2 })]);
    const c = joinEntities([a(1, 0, Math.PI), a(2, Math.PI, TWO_PI)]);
    expect(c.result[0].type).toBe('circle');
    const w = joinEntities([a(1, 5, 1), a(2, 1, 2)]);
    expect(w.result[0].type).toBe('arc');
    close(w.result[0].start, 5);
    close(w.result[0].end, 2);
  });
  it('chains lines, arcs and polylines into a polyline', () => {
    const ents = [
      line(0, 0, 10, 0, { id: 1 }),
      line(10, 10, 10, 0, { id: 2 }),
      { id: 3, type: 'arc', cx: 5, cy: 10, r: 5, start: 0, end: Math.PI },
      line(0, 10, 0, 0, { id: 4 }),
    ];
    const r = joinEntities(ents);
    expect(r.result.length).toBe(1);
    const p = r.result[0];
    expect(p.type).toBe('polyline');
    expect(p.closed).toBe(true);
    expect(p.layer).toBe('L1');
    close(areaOf(p), 100 + (Math.PI * 25) / 2);
    expect(r.consumedIds.sort()).toEqual([1, 2, 3, 4]);
    const open = joinEntities([{ id: 8, type: 'polyline', pts: [0, 0, 0, 5, 0, 0], closed: false, width: 0 }, line(5, 0, 5, 5, { id: 9 })]);
    expect(open.result[0].pts).toEqual([0, 0, 0, 5, 0, 0, 5, 5, 0]);
    expect(open.result[0].closed).toBe(false);
  });
  it('leaves unconnected entities alone', () => {
    const r = joinEntities([line(0, 0, 1, 0, { id: 1 }), line(5, 5, 6, 6, { id: 2 })]);
    expect(r.result).toEqual([]);
    expect(r.consumedIds).toEqual([]);
  });
  it('defaults to a tolerance relative to the selection size, not its position', () => {
    const o = 2e6;
    const a = line(o, o, o + 10, o, { id: 1 });
    const far = joinEntities([a, line(o + 10.5, o, o + 10.5, o + 10, { id: 2 })]);
    expect(far.result).toEqual([]);
    const near = joinEntities([a, line(o + 10, o, o + 10, o + 10, { id: 2 })]);
    expect(near.result[0].type).toBe('polyline');
    const b = line(0, 0, 1e-4, 0, { id: 1 });
    const tiny = joinEntities([b, line(1.001e-4, 0, 1e-4, 1e-4, { id: 2 })]);
    expect(tiny.result).toEqual([]);
  });
});

describe('explode', () => {
  it('explodes polylines into lines and arcs', () => {
    const p = { type: 'polyline', layer: 'X', pts: [0, 0, 0, 10, 0, -1, 10, 10, 0], closed: true, width: 1 };
    const parts = explodePolyline(p);
    expect(parts.map((e) => e.type)).toEqual(['line', 'arc', 'line']);
    expect(parts[0].layer).toBe('X');
    expect(parts[0].width).toBeUndefined();
    const a = parts[1];
    close(a.cx, 10);
    close(a.cy, 5);
    // Clockwise bulge: the CCW arc runs from the end vertex to the start vertex.
    closePt({ x: a.cx + a.r * Math.cos(a.start), y: a.cy + a.r * Math.sin(a.start) }, { x: 10, y: 10 });
    close(normAngle(a.end - a.start), Math.PI);
    expect(explodeEntity(line(0, 0, 1, 1))).toBe(null);
    expect(explodeEntity(p).length).toBe(3);
  });
});

describe('ellipse arc trims keep exact endpoints', () => {
  it('maps a trimmed ellipse end onto the cutter', () => {
    const e = { type: 'ellipse', cx: 0, cy: 0, mx: 6, my: 6, ratio: 0.3, start: 0, end: TWO_PI };
    // Pick on the upper-left flank, between the two cutters.
    const pick = ellipsePoint(e, 1.28);
    const r = trimEntity(e, [vline(1), vline(-1)], pick.x, pick.y);
    expect(r.add.length).toBe(1);
    const a = r.add[0];
    close(ellipsePoint(a, a.start).x, -1, 1e-9);
    close(ellipsePoint(a, a.end).x, 1, 1e-9);
  });
});
