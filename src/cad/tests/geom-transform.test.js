import { describe, it, expect } from 'vitest';
import {
  TWO_PI,
  identity,
  translate,
  rotate,
  scale,
  mirror,
  multiply,
  invert,
  apply,
  transformEntity,
  endpoints,
  ellipsePoint,
  areaOf,
  signedAreaPolyline,
  evalSpline,
  splineFromFitPoints,
} from '../src/core/geom/index.js';
import { patternSegments } from '../src/core/hatch/fill.js';
import { hatchPattern } from '../src/core/hatch/patterns.js';

const close = (a, b, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
const closePt = (p, q, eps = 1e-9) => {
  close(p.x, q.x, eps);
  close(p.y, q.y, eps);
};
const sortXY = (pts) => pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);

describe('matrices', () => {
  it('compose and invert', () => {
    const m = multiply(translate(3, 4), multiply(rotate(0.7, 1, 2), scale(2.5, -1, 3)));
    const inv = invert(m);
    const p = apply(m, 7, -2);
    closePt(apply(inv, p.x, p.y), { x: 7, y: -2 });
    expect(multiply(m, identity())).toEqual(m);
    expect(invert([0, 0, 0, 0, 1, 1])).toBe(null);
  });
  it('rotates about a point and mirrors across a line', () => {
    closePt(apply(rotate(Math.PI / 2, 1, 1), 2, 1), { x: 1, y: 2 });
    closePt(apply(mirror(0, 0, 1, 1), 3, 0), { x: 0, y: 3 });
    closePt(apply(mirror(5, 0, 5, 10), 7, 3), { x: 3, y: 3 });
    closePt(apply(scale(2, 1, 1), 2, 2), { x: 3, y: 3 });
  });
});

describe('transformEntity', () => {
  it('does not mutate and keeps other fields', () => {
    const l = { id: 7, type: 'line', layer: 'A', color: 3, x1: 0, y1: 0, x2: 1, y2: 0 };
    const r = transformEntity(l, rotate(Math.PI / 2));
    expect(l.x2).toBe(1);
    expect(r).toMatchObject({ id: 7, layer: 'A', color: 3 });
    close(r.x2, 0);
    close(r.y2, 1);
  });
  it('rotates and scales arcs', () => {
    const a = { type: 'arc', cx: 1, cy: 0, r: 2, start: 0, end: Math.PI / 2 };
    const m = multiply(scale(3), rotate(Math.PI / 2));
    const r = transformEntity(a, m);
    close(r.r, 6);
    const [s, e] = endpoints(a).map((p) => apply(m, p.x, p.y));
    const [s2, e2] = endpoints(r);
    closePt(s2, s);
    closePt(e2, e);
  });
  it('mirrors arcs by swapping start and end', () => {
    const a = { type: 'arc', cx: 5, cy: 0, r: 2, start: 0, end: Math.PI / 2 };
    const m = mirror(0, 0, 0, 1);
    const r = transformEntity(a, m);
    close(r.cx, -5);
    close(r.start, Math.PI / 2);
    close(r.end, Math.PI);
    const want = sortXY(endpoints(a).map((p) => apply(m, p.x, p.y)));
    const got = sortXY(endpoints(r));
    closePt(got[0], want[0]);
    closePt(got[1], want[1]);
  });
  it('turns circles into ellipses under non-uniform scale', () => {
    const c = { type: 'circle', cx: 1, cy: 1, r: 2 };
    const r = transformEntity(c, scale(1, 0, 0, 3));
    expect(r.type).toBe('ellipse');
    close(Math.hypot(r.mx, r.my), 6);
    close(r.ratio, 1 / 3);
    close(r.cx, 1);
    close(r.cy, 3);
    close(areaOf(r), Math.PI * 12);
  });
  it('maps elliptical arcs exactly under rotation, mirror and shear', () => {
    const e = { type: 'ellipse', cx: 2, cy: 1, mx: 4, my: 1, ratio: 0.4, start: 0.3, end: 2.5 };
    for (const m of [rotate(1.1, 3, -2), mirror(0, 0, 1, 2), [1, 0.3, 0.5, 1.2, 4, -1]]) {
      const r = transformEntity(e, m);
      expect(r.ratio).toBeLessThanOrEqual(1);
      const want = [ellipsePoint(e, e.start), ellipsePoint(e, e.end)].map((p) => apply(m, p.x, p.y));
      const got = [ellipsePoint(r, r.start), ellipsePoint(r, r.end)];
      const ws = sortXY(want),
        gs = sortXY(got);
      closePt(gs[0], ws[0], 1e-9);
      closePt(gs[1], ws[1], 1e-9);
      // A middle point of the arc maps onto the transformed arc's middle.
      const mid = ellipsePoint(e, (e.start + e.end) / 2);
      const mm = apply(m, mid.x, mid.y);
      const sw = (((r.end - r.start) % TWO_PI) + TWO_PI) % TWO_PI;
      closePt(ellipsePoint(r, r.start + sw / 2), mm, 1e-9);
    }
  });
  it('negates polyline bulges when mirrored', () => {
    const p = { type: 'polyline', pts: [0, 0, 0, 10, 0, 0, 10, 5, 1, 0, 5, 0], closed: true, width: 0 };
    const r = transformEntity(p, mirror(0, 0, 0, 1));
    expect(r.pts[8]).toBe(-1);
    close(signedAreaPolyline(r.pts), -signedAreaPolyline(p.pts));
    const s = transformEntity(p, scale(2));
    close(areaOf(s), 4 * areaOf(p));
  });
  it('transforms splines through their control points', () => {
    const s = { type: 'spline', ...splineFromFitPoints([0, 0, 2, 3, 5, 1, 8, 4]), fit: [0, 0, 2, 3, 5, 1, 8, 4], closed: false };
    const m = rotate(0.5, 1, 1);
    const r = transformEntity(s, m);
    const p = evalSpline(s, 0.37);
    closePt(evalSpline(r, 0.37), apply(m, p.x, p.y));
    closePt({ x: r.fit[2], y: r.fit[3] }, apply(m, 2, 3));
  });
  it('rotates and scales text', () => {
    const t = { type: 'text', x: 1, y: 0, h: 2, rot: 0.2, value: 'A', halign: 'left', valign: 'baseline', widthFactor: 1 };
    const r = transformEntity(t, multiply(scale(2), rotate(0.5)));
    close(r.rot, 0.7);
    close(r.h, 4);
    expect(r.halign).toBe('left');
    expect(r.widthFactor).toBe(1);
  });
  it('keeps mirrored text readable', () => {
    const t = { type: 'text', x: 10, y: 0, h: 2, rot: 0, value: 'AB', halign: 'left', valign: 'baseline' };
    const v = transformEntity(t, mirror(0, 0, 0, 1));
    close(v.x, -10);
    close(v.rot, 0);
    expect(v.halign).toBe('right');
    expect(v.valign).toBe('baseline');
    const h = transformEntity(t, mirror(0, 0, 1, 0));
    close(h.rot, 0);
    expect(h.halign).toBe('left');
    expect(h.valign).toBe('top');
    const mt = { type: 'mtext', x: 0, y: 0, h: 1, rot: 0, value: 'x', width: 10, attach: 'tl' };
    expect(transformEntity(mt, mirror(0, 0, 0, 1)).attach).toBe('tr');
    expect(transformEntity(mt, mirror(0, 0, 1, 0)).attach).toBe('bl');
  });
  it('mirrors inserts as a negative X scale', () => {
    const b = { type: 'insert', name: 'B', x: 3, y: 1, sx: 1, sy: 2, rot: 0 };
    const r = transformEntity(b, mirror(0, 0, 0, 1));
    close(r.x, -3);
    close(r.sx, -1);
    close(r.sy, 2);
    close(Math.cos(r.rot), 1);
    const r2 = transformEntity(b, mirror(0, 0, 1, 0));
    // Mirror across X: equals a 180 degree rotation with negative X scale.
    close(r2.sx, -1);
    close(r2.sy, 2);
    close(Math.cos(r2.rot), -1);
    const rr = transformEntity(b, rotate(Math.PI / 2));
    close(rr.rot, Math.PI / 2);
    close(rr.sx, 1);
  });
  it('transforms dimensions, leaders, hatches, xlines and points', () => {
    const m = rotate(Math.PI / 2);
    const d = transformEntity({ type: 'dimension', dimType: 'linear', x1: 1, y1: 0, x2: 2, y2: 0, lx: 0, ly: 1, rot: 0 }, m);
    closePt({ x: d.x1, y: d.y1 }, { x: 0, y: 1 });
    close(d.rot, Math.PI / 2);
    const le = transformEntity({ type: 'leader', pts: [1, 0, 2, 0], h: 2 }, scale(2));
    expect(le.pts).toEqual([2, 0, 4, 0]);
    close(le.h, 4);
    const h = transformEntity({ type: 'hatch', loops: [[0, 0, 0.5, 1, 0, 0, 1, 1, 0]], pattern: 'X', scale: 1, angle: 0 }, mirror(0, 0, 0, 1));
    expect(h.loops[0][2]).toBe(-0.5);
    close(h.angle, Math.PI);
    const x = transformEntity({ type: 'xline', x: 1, y: 0, dx: 1, dy: 0 }, m);
    close(x.dx, 0);
    close(x.dy, 1);
    const p = transformEntity({ type: 'point', x: 1, y: 0 }, m);
    closePt(p, { x: 0, y: 1 });
  });
  it('mirrors hatch patterns into the mirror image of their lines', () => {
    const sq = [[-10, -10, 0, 10, -10, 0, 10, 10, 0, -10, 10, 0]];
    const segs = (e) => {
      const ring = e.loops[0].filter((_, i) => i % 3 !== 2);
      return patternSegments([ring], hatchPattern(e), e.scale, e.angle).segs;
    };
    const key = (x1, y1, x2, y2) => [[x1, y1], [x2, y2]].map((p) => p.map((v) => v.toFixed(3)).join()).sort().join('|');
    for (const pattern of ['LINES', 'STEEL', 'HERRINGBONE', 'PEBBLES']) {
      const h = { type: 'hatch', loops: sq, pattern, scale: 1.3, angle: 0.3 };
      const m = mirror(0, 0, 1, 1);
      const t = transformEntity(h, m);
      expect(t.mirror).toBe(true);
      expect(transformEntity(t, m).mirror).toBeUndefined();
      const a = segs(h);
      const want = new Set();
      for (let i = 0; i < a.length; i += 4) {
        const p = apply(m, a[i], a[i + 1]);
        const q = apply(m, a[i + 2], a[i + 3]);
        want.add(key(p.x, p.y, q.x, q.y));
      }
      const b = segs(t);
      const got = new Set();
      for (let i = 0; i < b.length; i += 4) got.add(key(b[i], b[i + 1], b[i + 2], b[i + 3]));
      expect(got).toEqual(want);
    }
  });
});
