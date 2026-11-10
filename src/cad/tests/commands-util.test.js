import { describe, it, expect } from 'vitest';
import { circle3, arc3, tangentBulge, endTangent, polygonPoints, circleTTR, loopFromEntity, M } from '../src/editor/commands/util.js';

describe('construction helpers', () => {
  it('finds the circle through three points', () => {
    const c = circle3({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 });
    expect(c.cx).toBeCloseTo(0);
    expect(c.cy).toBeCloseTo(0);
    expect(c.r).toBeCloseTo(10);
    expect(circle3({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBeNull();
  });

  it('orients a three-point arc through its middle point', () => {
    const ccw = arc3({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 });
    expect(ccw.start).toBeCloseTo(0);
    expect(ccw.end).toBeCloseTo(Math.PI);
    const cw = arc3({ x: 10, y: 0 }, { x: 0, y: -10 }, { x: -10, y: 0 });
    // Counter-clockwise from (-10,0) round through the bottom to (10,0).
    expect(cw.start).toBeCloseTo(Math.PI);
    expect(cw.end).toBeCloseTo(0, 6);
  });

  it('computes the bulge of a tangent arc', () => {
    // Leaving east, ending straight north of the start at distance 2r: a half circle to the left.
    expect(tangentBulge({ x: 0, y: 0 }, 1, 0, { x: 0, y: 10 })).toBeCloseTo(1);
    expect(tangentBulge({ x: 0, y: 0 }, 1, 0, { x: 0, y: -10 })).toBeCloseTo(-1);
    expect(tangentBulge({ x: 0, y: 0 }, 1, 0, { x: 10, y: 0 })).toBeCloseTo(0);
  });

  it('continues tangent after an arc segment', () => {
    const t = endTangent([
      { x: 0, y: 0, b: 1 },
      { x: 0, y: 10, b: 0 },
    ]);
    // A CCW half circle from (0,0) to (0,10) ends heading west.
    expect(t.x).toBeCloseTo(-1);
    expect(t.y).toBeCloseTo(0);
  });

  it('builds inscribed and circumscribed polygons', () => {
    const ins = polygonPoints({ x: 0, y: 0 }, 4, 10, 0, false);
    expect(Math.hypot(ins[0], ins[1])).toBeCloseTo(10);
    const circ = polygonPoints({ x: 0, y: 0 }, 4, 10, 0, true);
    // Edge midpoints of a circumscribed square touch the circle.
    const mx = (circ[0] + circ[3]) / 2,
      my = (circ[1] + circ[4]) / 2;
    expect(Math.hypot(mx, my)).toBeCloseTo(10);
  });

  it('places a tangent-tangent-radius circle between two lines', () => {
    const a = { type: 'line', x1: -20, y1: 0, x2: 20, y2: 0 };
    const b = { type: 'line', x1: 0, y1: -20, x2: 0, y2: 20 };
    const c = circleTTR(a, { x: 10, y: 0 }, b, { x: 0, y: 10 }, 3);
    expect(c.cx).toBeCloseTo(3);
    expect(c.cy).toBeCloseTo(3);
  });

  it('places a circle tangent to a line and a circle', () => {
    const line = { type: 'line', x1: -50, y1: 0, x2: 50, y2: 0 };
    const circ = { type: 'circle', cx: 0, cy: 20, r: 5 };
    // The gap below the circle is 15, so a radius 8 circle can touch both.
    const c = circleTTR(line, { x: 10, y: 0 }, circ, { x: 3, y: 16 }, 8);
    expect(c.cy).toBeCloseTo(8);
    expect(Math.hypot(c.cx, c.cy - 20)).toBeCloseTo(13);
    expect(c.cx).toBeGreaterThan(0);
    // Too small to bridge the gap.
    expect(circleTTR(line, { x: 10, y: 0 }, circ, { x: 3, y: 16 }, 4)).toBeNull();
  });

  it('makes hatch loops from closed objects', () => {
    expect(loopFromEntity({ type: 'circle', cx: 0, cy: 0, r: 2 })).toEqual([2, 0, 1, -2, 0, 1]);
    expect(loopFromEntity({ type: 'polyline', pts: [0, 0, 0, 1, 0, 0, 1, 1, 0], closed: true })).toHaveLength(9);
    expect(loopFromEntity({ type: 'polyline', pts: [0, 0, 0, 1, 0, 0, 1, 1, 0], closed: false })).toBeNull();
    expect(loopFromEntity({ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1 })).toBeNull();
    // open curves are not boundaries either, as open polylines are not
    const full = { type: 'ellipse', cx: 0, cy: 0, mx: 4, my: 0, ratio: 0.5, start: 0, end: Math.PI * 2 };
    expect(loopFromEntity(full).length).toBeGreaterThan(9);
    expect(loopFromEntity({ ...full, end: Math.PI })).toBeNull();
    const open = { type: 'spline', degree: 3, ctrl: [0, 0, 2, 4, 6, 4, 8, 0], closed: false };
    expect(loopFromEntity(open)).toBeNull();
    expect(loopFromEntity({ ...open, ctrl: [0, 0, 2, 4, 6, 4, 8, 0, 4, -3, 0, 0] }).length).toBeGreaterThan(9);
  });

  it('builds affine matrices', () => {
    const p = { x: 2, y: 0 };
    const r = M.apply(M.rotate(Math.PI / 2, 1, 0), p);
    expect(r.x).toBeCloseTo(1);
    expect(r.y).toBeCloseTo(1);
    const s = M.apply(M.scale(3, 1, 1), p);
    expect(s).toEqual({ x: 4, y: -2 });
    const m = M.apply(M.mirror({ x: 0, y: 0 }, { x: 1, y: 1 }), p);
    expect(m.x).toBeCloseTo(0);
    expect(m.y).toBeCloseTo(2);
  });
});
