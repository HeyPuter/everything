import { describe, it, expect } from 'vitest';
import { newMask, newPoint, newLayer, type MaskSpline } from '../../src/mask/types';
import * as G from '../../src/mask/geom';

const closeTo = (a: number[], b: number[], d = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], d));

describe('mask geometry', () => {
  it('auto handles follow the neighbours; vector handles point at them', () => {
    const sp: MaskSpline = { points: [newPoint(0, 0), newPoint(0.3, 0), newPoint(0.6, 0)], use_cyclic: false, use_fill: false };
    G.recalcHandles(sp);
    closeTo(sp.points[1].handle_left, [0.2, 0]);
    closeTo(sp.points[1].handle_right, [0.4, 0]);
    sp.points[1].handle_type = 'VECTOR';
    sp.points[1].co = [0.3, 0.3];
    G.recalcHandles(sp);
    closeTo(sp.points[1].handle_left, [0.2, 0.2]);
  });

  it('aligned handles stay opposite', () => {
    const p = newPoint(0.5, 0.5, 'ALIGNED');
    p.handle_left = [0.4, 0.5];
    p.handle_right = [0.7, 0.5];
    p.handle_left = [0.5, 0.4];
    G.alignHandles(p, 'LEFT');
    closeTo(p.handle_right, [0.5, 0.7]);
  });

  it('circle primitive is round on screen and counter-clockwise', () => {
    const c = G.circleSpline(0.5, 0.5, 0.25, 2);
    const s = G.sampleSpline(c, 8);
    for (const { p } of s) expect(Math.hypot((p[0] - 0.5) * 2, p[1] - 0.5)).toBeCloseTo(0.25, 2);
    expect(G.signedArea(s.map((x) => x.p), 2)).toBeGreaterThan(0);
  });

  it('feather outlines push outward by the point weight', () => {
    const sq = G.squareSpline(0.5, 0.5, 0.2, 1);
    for (const p of sq.points) p.weight = 0.1;
    const s = G.sampleSpline(sq, 4);
    const ring = G.featherOutline(s, 1);
    // the middle of the bottom edge moves down by the weight
    const i = s.findIndex((x) => x.seg === 0 && x.t === 0.5);
    closeTo(ring[i], [0.5, 0.2]);
    G.switchDirection(sq);
    const ring2 = G.featherOutline(G.sampleSpline(sq, 4), 1);
    expect(Math.min(...ring2.map((p) => p[1]))).toBeCloseTo(0.2, 2);
  });

  it('inserting a point keeps the curve', () => {
    const c = G.circleSpline(0.5, 0.5, 0.2);
    const quarter = G.bezier(c.points[0], c.points[1], 0.25);
    const half = G.bezier(c.points[0], c.points[1], 0.5);
    const np = G.insertPoint(c, 0, 0.5);
    expect(c.points.length).toBe(5);
    closeTo(np.co, half);
    closeTo(G.bezier(c.points[0], c.points[1], 0.5), quarter, 6);
  });

  it('shape keys interpolate between frames and survive only matching topology', () => {
    const m = newMask('m');
    const L = m.layers[0];
    L.splines.push(G.squareSpline(0.5, 0.5, 0.1));
    G.insertShapeKey(L, 1);
    for (const p of L.splines[0].points) p.co = [p.co[0] + 0.2, p.co[1]];
    G.insertShapeKey(L, 11);
    const mid = G.layerAt(L, 6);
    expect(mid.splines[0].points[0].co[0]).toBeCloseTo(L.splines[0].points[0].co[0] - 0.1, 6);
    expect(G.layerAt(L, 50).splines[0].points[0].co[0]).toBeCloseTo(L.splines[0].points[0].co[0], 6);
    // adding a point invalidates the old keys
    G.insertPoint(L.splines[0], 0, 0.5);
    expect(G.keyedData(L, 6)).toBeNull();
    expect(newLayer().shape_keys).toEqual([]);
  });
});
