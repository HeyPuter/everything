import { describe, it, expect } from 'vitest';
import { gripsOf, applyGrip } from '../src/editor/grips.js';
import { stretchEntity } from '../src/editor/commands/modify.js';
import { splineFromFitPoints } from '../src/core/geom/index.js';

const P = { layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1 };

describe('grips', () => {
  it('lists line ends and midpoint', () => {
    const g = gripsOf({ ...P, type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    expect(g.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
  });

  it('keeps a fit-point spline when a grip would make all fit points coincide', () => {
    const fit = [0, 0, 10, 0];
    const s = { ...P, type: 'spline', ...splineFromFitPoints(fit), fit, closed: false };
    expect(applyGrip(s, 1, 0, 0)).toBe(s);
    const moved = applyGrip(s, 1, 10, 5);
    expect(moved.fit).toEqual([0, 0, 10, 5]);
    expect(moved.ctrl.slice(-2)).toEqual([10, 5]);
  });

  it('keeps the end tangents of a fit-point spline when a fit point moves', () => {
    const fit = [80, 0, 83, 5, 87, 2, 90, 8, 95, 3];
    const free = { ...P, type: 'spline', ...splineFromFitPoints(fit), fit, closed: false };
    // built with DXF end tangents (groups 12/13): up at the start, diagonal at the end
    const tan = { ...free, ...splineFromFitPoints(fit, false, [0, 1], [1, 1]) };
    // a grip dropped where it was leaves both curves as they were
    const same = applyGrip(tan, 2, 87, 2);
    same.ctrl.forEach((v, i) => expect(v).toBeCloseTo(tan.ctrl[i], 9));
    applyGrip(free, 2, 87, 2).ctrl.forEach((v, i) => expect(v).toBeCloseTo(free.ctrl[i], 9));
    // moving a fit point keeps the tangent directions; a curve without them stays free
    const moved = applyGrip(tan, 2, 87, 4);
    const c = moved.ctrl;
    expect(c[2]).toBeCloseTo(80, 9);
    expect(c[3]).toBeGreaterThan(0);
    const n = c.length;
    expect(c[n - 2] - c[n - 4]).toBeCloseTo(c[n - 1] - c[n - 3], 9);
    const ref = splineFromFitPoints(moved.fit);
    applyGrip(free, 2, 87, 4).ctrl.forEach((v, i) => expect(v).toBeCloseTo(ref.ctrl[i], 9));
    const st = stretchEntity(tan, (x, y) => x > 86 && x < 88 && y > 1 && y < 3, 0, 2);
    expect(st.ctrl[2]).toBeCloseTo(80, 9);
  });

  it('stretches line ends and moves with the midpoint', () => {
    const l = { ...P, type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 };
    expect(applyGrip(l, 2, 20, 5)).toMatchObject({ x1: 0, y1: 0, x2: 20, y2: 5 });
    expect(applyGrip(l, 1, 5, 3)).toMatchObject({ x1: 0, y1: 3, x2: 10, y2: 3 });
  });

  it('moves circles by the centre and resizes by quadrants', () => {
    const c = { ...P, type: 'circle', cx: 0, cy: 0, r: 5 };
    expect(gripsOf(c)).toHaveLength(5);
    expect(applyGrip(c, 0, 3, 4)).toMatchObject({ cx: 3, cy: 4, r: 5 });
    expect(applyGrip(c, 1, 0, 8).r).toBeCloseTo(8);
  });

  it('keeps arcs passing through their middle grip when an end moves', () => {
    const a = { ...P, type: 'arc', cx: 0, cy: 0, r: 10, start: 0, end: Math.PI };
    const mid = gripsOf(a)[1];
    const b = applyGrip(a, 2, -10, -2);
    const d = Math.hypot(mid.x - b.cx, mid.y - b.cy);
    expect(d).toBeCloseTo(b.r, 6);
    expect(Math.hypot(-10 - b.cx, -2 - b.cy)).toBeCloseTo(b.r, 6);
  });

  it('moves polyline vertices and straight segments', () => {
    const p = { ...P, type: 'polyline', pts: [0, 0, 0, 10, 0, 0, 10, 10, 0], closed: false, width: 0 };
    const g = gripsOf(p);
    expect(g).toHaveLength(5);
    expect(applyGrip(p, 1, 12, 1).pts.slice(3, 5)).toEqual([12, 1]);
    // Segment grip 3 is the midpoint of the first segment: both ends move.
    const moved = applyGrip(p, 3, 5, 2);
    expect(moved.pts.slice(0, 2)).toEqual([0, 2]);
    expect(moved.pts.slice(3, 5)).toEqual([10, 2]);
  });

  it('bends an arc segment through a dragged midpoint', () => {
    const p = { ...P, type: 'polyline', pts: [0, 0, 1, 10, 0, 0], closed: false, width: 0 };
    const g = gripsOf(p);
    const segGrip = g.findIndex((x) => x.kind === 'seg');
    // A bulge of 1 is a half circle below the chord (to the right of travel).
    expect(g[segGrip].y).toBeCloseTo(-5);
    const flat = applyGrip(p, segGrip, 5, -2);
    expect(flat.pts[2]).toBeGreaterThan(0);
    expect(flat.pts[2]).toBeLessThan(1);
    const flipped = applyGrip(p, segGrip, 5, 3);
    expect(flipped.pts[2]).toBeLessThan(0);
  });

  it('edits dimension definition points and text location', () => {
    const d = { ...P, type: 'dimension', dimType: 'linear', x1: 0, y1: 0, x2: 10, y2: 0, lx: 5, ly: -5, rot: 0 };
    expect(applyGrip(d, 2, 5, -9)).toMatchObject({ lx: 5, ly: -9 });
  });
});

describe('stretchEntity', () => {
  const inside = (x) => x > 5;
  it('moves only the vertices inside the window', () => {
    const l = { ...P, type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 };
    expect(stretchEntity(l, inside, 3, 0)).toMatchObject({ x1: 0, x2: 13 });
    const p = { ...P, type: 'polyline', pts: [0, 0, 0, 10, 0, 0, 10, 5, 0], closed: false, width: 0 };
    expect(stretchEntity(p, inside, 0, 2).pts).toEqual([0, 0, 0, 10, 2, 0, 10, 7, 0]);
  });

  it('moves single-point objects whole when their point is inside', () => {
    const c = { ...P, type: 'circle', cx: 8, cy: 0, r: 1 };
    expect(stretchEntity(c, inside, 1, 1)).toMatchObject({ cx: 9, cy: 1 });
    const c2 = { ...P, type: 'circle', cx: 2, cy: 0, r: 1 };
    expect(stretchEntity(c2, inside, 1, 1)).toBe(c2);
  });
});

describe('elliptical arc grips', () => {
  const arc = { ...P, type: 'ellipse', cx: 0, cy: 0, mx: 10, my: 0, ratio: 0.5, start: 0, end: Math.PI / 2 };

  it('has start and end grips on the arc ends, and a full ellipse has none', () => {
    const g = gripsOf(arc);
    expect(g).toHaveLength(7);
    expect(g[5].x).toBeCloseTo(10);
    expect(g[5].y).toBeCloseTo(0);
    expect(g[6].x).toBeCloseTo(0);
    expect(g[6].y).toBeCloseTo(5);
    expect(gripsOf({ ...arc, start: 0, end: Math.PI * 2 })).toHaveLength(5);
  });

  it('moves an end along the ellipse', () => {
    const e = applyGrip(arc, 6, -10, 0);
    expect(e.start).toBe(0);
    expect(e.end).toBeCloseTo(Math.PI);
    const s = applyGrip(arc, 5, 0, -5);
    expect(s.start).toBeCloseTo((3 * Math.PI) / 2);
    expect(s.end).toBe(Math.PI / 2);
  });

  it('does not close the arc when an end is dropped on the other end', () => {
    expect(applyGrip(arc, 5, 0, 5)).toBe(arc);
  });
});
