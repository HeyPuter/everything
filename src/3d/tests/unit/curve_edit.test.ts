import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import * as K from '../../src/modes/curve/curveops';
import type { BezierPoint, CurveData, Spline } from '../../src/data/types';

const bp = (co: number[], hl = co, hr = co, t: BezierPoint['handle_left_type'] = 'AUTO'): BezierPoint => ({
  co: [co[0], co[1], co[2]],
  handle_left: [hl[0], hl[1], hl[2]],
  handle_right: [hr[0], hr[1], hr[2]],
  handle_left_type: t,
  handle_right_type: t,
  radius: 1,
  tilt: 0,
});

function spline(points: BezierPoint[], cyclic = false): Spline {
  return { type: 'BEZIER', bezier_points: points, points: [], use_cyclic_u: cyclic, resolution_u: 12, order_u: 4, use_smooth: true, material_index: 0 };
}

function curve(...splines: Spline[]): CurveData {
  return { id: 'cu', name: 'Curve', dimensions: '3D', splines, resolution_u: 12, bevel_depth: 0, bevel_resolution: 0, extrude: 0, offset: 0, fill_mode: 'FULL', use_fill_caps: false, materials: [] };
}

/** Circle of n automatic-handle points with radius 1. */
function circle(n = 8): CurveData {
  const pts = [...Array(n).keys()].map((i) => bp([Math.cos((i / n) * Math.PI * 2), Math.sin((i / n) * Math.PI * 2), 0]));
  const sp = spline(pts, true);
  sp.bezier_points.forEach((b, i) => {
    const a = K.autoHandles(sp, i);
    b.handle_left = [a.left.x, a.left.y, a.left.z];
    b.handle_right = [a.right.x, a.right.y, a.right.z];
  });
  return curve(sp);
}

function select(cu: CurveData, idx: number[], s = 0) {
  K.deselectAll(cu);
  for (const i of idx) K.setSel(cu.splines[s], i, true);
}
const selected = (cu: CurveData, s = 0) => [...Array(K.pointCount(cu.splines[s])).keys()].filter((i) => K.isSel(cu.splines[s], i));

/** Sample a Bézier spline densely (world points). */
function samples(sp: Spline, per = 16): Vector3[] {
  const out: Vector3[] = [];
  const n = sp.bezier_points.length;
  const segs = sp.use_cyclic_u ? n : n - 1;
  const V = (a: number[]) => new Vector3(a[0], a[1], a[2]);
  for (let i = 0; i < segs; i++) {
    const a = sp.bezier_points[i],
      b = sp.bezier_points[(i + 1) % n];
    for (let k = 0; k < per; k++) out.push(K.bezierAt(V(a.co), V(a.handle_right), V(b.handle_left), V(b.co), k / per));
  }
  return out;
}

describe('curve selection kernels', () => {
  it('more / less / next / previous on a cyclic spline', () => {
    const cu = circle();
    select(cu, [2]);
    K.selectMore(cu);
    expect(selected(cu)).toEqual([1, 2, 3]);
    K.selectLess(cu);
    expect(selected(cu)).toEqual([2]);
    K.selectAdjacent(cu, 'NEXT');
    expect(selected(cu)).toEqual([2, 3]);
    select(cu, [0]);
    K.selectAdjacent(cu, 'PREVIOUS');
    expect(selected(cu)).toEqual([0, 7]);
  });

  it('first / last toggle and checker deselect from the active point', () => {
    const cu = circle();
    select(cu, [2]);
    K.toggleEnds(cu, 'FIRST');
    expect(selected(cu)).toEqual([0, 2]);
    K.toggleEnds(cu, 'FIRST');
    expect(selected(cu)).toEqual([2]);
    K.selectAll(cu, 'SELECT');
    K.selectNth(cu, 1, 1, 0, { s: 0, i: 1 });
    expect(selected(cu)).toEqual([1, 3, 5, 7]);
  });

  it('random selection is deterministic for a seed', () => {
    const a = circle(32),
      b = circle(32);
    K.selectRandom(a, 0.5, 3, 'SELECT');
    K.selectRandom(b, 0.5, 3, 'SELECT');
    expect(selected(a)).toEqual(selected(b));
    expect(selected(a).length).toBeGreaterThan(5);
    expect(selected(a).length).toBeLessThan(27);
  });

  it('similar radius and shortest path', () => {
    const cu = circle();
    cu.splines[0].bezier_points[4].radius = 2;
    cu.splines[0].bezier_points[6].radius = 2.05;
    select(cu, [4]);
    K.selectSimilar(cu, 'RADIUS', 'EQUAL', 0.1);
    expect(selected(cu)).toEqual([4, 6]);
    K.deselectAll(cu);
    K.selectPath(cu, { s: 0, i: 6 }, { s: 0, i: 1 });
    expect(selected(cu)).toEqual([0, 1, 6, 7]);
  });

  it('hide and reveal', () => {
    const cu = circle();
    select(cu, [1, 2]);
    K.hidePoints(cu, false);
    expect(cu.splines[0].bezier_points.filter((b) => b.hide).length).toBe(2);
    K.selectAll(cu, 'SELECT');
    expect(selected(cu)).toEqual([0, 3, 4, 5, 6, 7]);
    K.revealPoints(cu, true);
    expect(cu.splines[0].bezier_points.some((b) => b.hide)).toBe(false);
    expect(selected(cu).length).toBe(8);
  });
});

describe('curve editing kernels', () => {
  it('subdivides into equal parameter steps', () => {
    const cu = curve(spline([bp([-1, 0, 0], [-1.5, -0.5, 0], [-0.5, 0.5, 0], 'ALIGNED'), bp([1, 0, 0], [0, 0, 0], [2, 0, 0], 'ALIGNED')]));
    K.selectAll(cu, 'SELECT');
    K.subdivide(cu, 3);
    const co = cu.splines[0].bezier_points.map((b) => b.co.map((x) => +x.toFixed(4)));
    expect(co).toEqual([
      [-1, 0, 0],
      [-0.6172, 0.2109, 0],
      [-0.1875, 0.1875, 0],
      [0.3359, 0.0703, 0],
      [1, 0, 0],
    ]);
  });

  it('split keeps the boundary points in the remainder', () => {
    const cu = circle();
    select(cu, [1, 2, 3]);
    const runs = K.splitSelected(cu);
    expect(runs.length).toBe(1);
    expect(cu.splines.length).toBe(2);
    const [rest, piece] = cu.splines;
    expect(rest.use_cyclic_u).toBe(false);
    expect(rest.bezier_points.length).toBe(7);
    expect(piece.bezier_points.length).toBe(3);
    expect(piece.bezier_points.every((b) => b.select_control_point)).toBe(true);
    expect(rest.bezier_points.every((b) => !b.select_control_point)).toBe(true);
  });

  it('delete segments and selected runs', () => {
    const cu = circle();
    select(cu, [6, 7, 0, 1]);
    const runs = K.selectedRuns(cu);
    expect(runs.length).toBe(1);
    expect(runs[0].bezier_points.length).toBe(4);
    K.cutSelectedSegments(cu, false);
    // the 3 segments between the 4 selected points are gone; the rest stays one open spline
    expect(cu.splines.length).toBe(1);
    expect(cu.splines[0].bezier_points.length).toBe(6);
  });

  it('dissolve keeps the shape of a circle', () => {
    const cu = circle();
    select(cu, [2]);
    K.dissolveVerts(cu);
    expect(cu.splines[0].bezier_points.length).toBe(7);
    for (const p of samples(cu.splines[0])) expect(Math.abs(p.length() - 1)).toBeLessThan(0.04);
  });

  it('decimate halves the points and stays close', () => {
    const cu = circle(16);
    K.selectAll(cu, 'SELECT');
    K.decimate(cu, 0.5);
    expect(cu.splines[0].bezier_points.length).toBe(8);
    for (const p of samples(cu.splines[0])) expect(Math.abs(p.length() - 1)).toBeLessThan(0.02);
  });

  it('smooths positions and attributes', () => {
    const cu = circle();
    cu.splines[0].bezier_points[2].co = [0, 2, 0];
    select(cu, [2]);
    K.smoothPositions(cu);
    expect(cu.splines[0].bezier_points[2].co[1]).toBeLessThan(2);
    expect(cu.splines[0].bezier_points[2].co[1]).toBeGreaterThan(1.5);
    cu.splines[0].bezier_points[2].radius = 3;
    select(cu, [1, 2, 3]);
    K.smoothAttribute(cu, 'radius');
    const r = cu.splines[0].bezier_points.map((b) => b.radius);
    expect(r[2]).toBeLessThan(3);
    expect(r[0]).toBe(1);
    K.setRadius(cu, 0.5);
    expect(cu.splines[0].bezier_points[1].radius).toBe(0.5);
  });

  it('fits a freehand circle stroke to a few closed Bézier points', () => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 200; i++) pts.push(new Vector3(Math.cos((i / 200) * Math.PI * 2), Math.sin((i / 200) * Math.PI * 2), 0));
    const fit = K.fitStroke(pts, 0.01, Math.PI * 0.4, true);
    expect(fit.cyclic).toBe(true);
    expect(fit.points.length).toBeGreaterThanOrEqual(3);
    expect(fit.points.length).toBeLessThan(12);
    for (const p of samples(spline(fit.points, true))) expect(Math.abs(p.length() - 1)).toBeLessThan(0.02);
  });

  it('keeps corners of a stroke sharp', () => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 50; i++) pts.push(new Vector3(i / 50, 0, 0));
    for (let i = 1; i <= 50; i++) pts.push(new Vector3(1, i / 50, 0));
    const fit = K.fitStroke(pts, 0.005, Math.PI / 4, false);
    expect(fit.cyclic).toBe(false);
    const corner = fit.points.find((b) => Math.abs(b.co[0] - 1) < 0.03 && Math.abs(b.co[1]) < 0.03);
    expect(corner).toBeTruthy();
    for (const p of samples(spline(fit.points))) expect(Math.min(Math.abs(p.y), Math.abs(p.x - 1))).toBeLessThan(0.01);
  });

  it('inserts a point on a segment without changing the shape', () => {
    const cu = circle(4);
    const before = samples(cu.splines[0], 64);
    K.insertPointOnSegment(cu.splines[0], 1, 0.3);
    expect(cu.splines[0].bezier_points.length).toBe(5);
    for (const p of samples(cu.splines[0], 64)) {
      const d = Math.min(...before.map((q) => q.distanceTo(p)));
      expect(d).toBeLessThan(0.02);
    }
  });
});

import { curveToMesh } from '../../src/eval/curve';

describe('2D curve fill', () => {
  it('fills an outline with a hole (front faces up, area = outer - inner)', () => {
    const sq = (r: number) => spline([bp([-r, -r, 0], [-r, -r, 0], [-r, -r, 0], 'VECTOR'), bp([r, -r, 0], [r, -r, 0], [r, -r, 0], 'VECTOR'), bp([r, r, 0], [r, r, 0], [r, r, 0], 'VECTOR'), bp([-r, r, 0], [-r, r, 0], [-r, r, 0], 'VECTOR')], true);
    const cu = curve(sq(2), sq(1));
    cu.dimensions = '2D';
    cu.fill_mode = 'FRONT';
    cu.resolution_u = 1;
    const m = curveToMesh(cu);
    let area = 0;
    for (let f = 0; f < m.offsets.length - 1; f++) {
      const v = [...m.indices.subarray(m.offsets[f], m.offsets[f + 1])].map((i) => [m.positions[i * 3], m.positions[i * 3 + 1]]);
      for (let k = 1; k + 1 < v.length; k++) area += ((v[k][0] - v[0][0]) * (v[k + 1][1] - v[0][1]) - (v[k][1] - v[0][1]) * (v[k + 1][0] - v[0][0])) / 2;
    }
    expect(area).toBeCloseTo(16 - 4, 5);
  });
});

import { edgeChains, meshToSplines } from '../../src/modes/curve/meshcurve';
import * as prim from '../../src/mesh/primitives';

describe('mesh to curve', () => {
  it('chains edges into open polylines and loops', () => {
    // a square loop and a separate 3-vertex line
    const chains = edgeChains(7, [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6]);
    expect(chains.map((c) => [c.verts.length, c.cyclic]).sort()).toEqual([
      [3, false],
      [4, true],
    ]);
  });

  it('turns every mesh edge into spline segments', () => {
    const m = prim.plane(2);
    const splines = meshToSplines(m as never);
    expect(splines.length).toBe(1);
    expect(splines[0].use_cyclic_u).toBe(true);
    expect(splines[0].points.length).toBe(4);
  });
});
