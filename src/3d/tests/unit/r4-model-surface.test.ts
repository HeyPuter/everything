// NURBS surfaces: primitive control grids and their tessellation match recorded reference results
// (vertex / face counts, sampled positions, face winding); knot vector rules.
import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/r4_surface_primitives.json';
import { surfacePrimitive, surfaceToMesh, knotSpec, evaluateGrid, type SurfacePrimitive } from '../../src/surface/nurbs';
import type { CurveData } from '../../src/data/types';

const curveOf = (kind: SurfacePrimitive): CurveData => ({ id: 'c', name: 'c', dimensions: '3D', splines: [surfacePrimitive(kind)], resolution_u: 4, resolution_v: 4, bevel_depth: 0, bevel_resolution: 0, extrude: 0, offset: 0, fill_mode: 'FULL', use_fill_caps: false, materials: [] }) as CurveData;

describe('surface primitives (recorded reference tessellation)', () => {
  for (const [kind, ref] of Object.entries(fixture as Record<string, { nv: number; nf: number; ne: number; sample: Record<string, number[]>; firstFaces: number[][] }>)) {
    it(kind, () => {
      const m = surfaceToMesh(curveOf(kind as SurfacePrimitive));
      expect(m.positions.length / 3).toBe(ref.nv);
      expect(m.offsets.length - 1).toBe(ref.nf);
      if (!ref.nf) expect((m.looseEdges?.length ?? 0) / 2).toBe(ref.ne);
      let worst = 0;
      for (const [i, p] of Object.entries(ref.sample)) {
        const k = Number(i) * 3;
        worst = Math.max(worst, Math.hypot(m.positions[k] - p[0], m.positions[k + 1] - p[1], m.positions[k + 2] - p[2]));
      }
      expect(worst).toBeLessThan(1e-4);
      // same corners in the same order (winding decides the normals)
      ref.firstFaces.forEach((f, fi) => expect(Array.from(m.indices.subarray(m.offsets[fi], m.offsets[fi + 1]))).toEqual(f));
    });
  }
});

describe('knot vectors', () => {
  it('open, endpoint and Bézier knots', () => {
    expect(knotSpec({ n: 5, order: 3, cyclic: false, endpoint: false, bezier: false }).knots).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(knotSpec({ n: 5, order: 3, cyclic: false, endpoint: true, bezier: false }).knots).toEqual([0, 0, 0, 1, 2, 3, 3, 3]);
    expect(knotSpec({ n: 5, order: 3, cyclic: false, endpoint: true, bezier: true }).knots).toEqual([0, 0, 0, 1, 1, 2, 2, 2]);
  });
  it('closed directions wrap the control points', () => {
    const p = knotSpec({ n: 4, order: 3, cyclic: true, endpoint: false, bezier: false });
    expect(p.ctrl).toEqual([0, 1, 2, 3, 0, 1]);
    expect([p.t0, p.t1]).toEqual([2, 6]);
    const e = knotSpec({ n: 4, order: 3, cyclic: true, endpoint: true, bezier: false });
    expect(e.ctrl).toEqual([0, 1, 2, 3, 0]);
    expect(e.knots).toEqual([0, 0, 0, 1, 2, 3, 3, 3]);
  });
  it('order is limited by the point count', () => {
    expect(knotSpec({ n: 2, order: 4, cyclic: false, endpoint: false, bezier: false }).order).toBe(2);
  });
  it('the sphere is exactly round', () => {
    const g = evaluateGrid(surfacePrimitive('SPHERE'));
    for (let i = 0; i < g.positions.length; i += 3) expect(Math.hypot(g.positions[i], g.positions[i + 1], g.positions[i + 2])).toBeCloseTo(1, 5);
  });
});

import * as G from '../../src/surface/grid';
import type { Spline } from '../../src/data/types';

const patch = (): Spline => {
  const sp = surfacePrimitive('SURFACE');
  sp.points.forEach((p) => (p.select = false));
  return sp;
};
const sel = (sp: Spline, idx: number[]) => idx.forEach((i) => (sp.points[i].select = true));

describe('surface grid editing', () => {
  it('select row alternates U and V rows through a point', () => {
    const sp = patch();
    G.selectRow(sp, 5, 'U');
    expect(sp.points.map((p, i) => (p.select ? i : -1)).filter((i) => i >= 0)).toEqual([4, 5, 6, 7]);
    G.selectRow(sp, 5, 'V');
    expect(sp.points.map((p, i) => (p.select ? i : -1)).filter((i) => i >= 0)).toEqual([1, 5, 9, 13]);
  });
  it('deletes fully selected rows only', () => {
    const sp = patch();
    sel(sp, [0, 1]);
    expect(G.deleteRows(sp)).toBe(null);
    sel(sp, [2, 3]);
    expect(G.deleteRows(sp)).toBe(true);
    expect([sp.point_count_u, sp.point_count_v, sp.points.length]).toEqual([4, 3, 12]);
    sp.points.forEach((p) => (p.select = true));
    expect(G.deleteRows(sp)).toBe(false);
  });
  it('extrudes a boundary row and a one-row curve into a surface', () => {
    const sp = patch();
    sel(sp, [12, 13, 14, 15]);
    expect(G.extrudeEdge(sp)).toBe(true);
    expect(sp.point_count_v).toBe(5);
    expect(sp.points.slice(16).every((p) => p.select)).toBe(true);
    expect(sp.points.slice(0, 16).some((p) => p.select)).toBe(false);
    const c = surfacePrimitive('CURVE');
    c.points.forEach((p) => (p.select = true));
    expect(G.extrudeEdge(c)).toBe(true);
    expect([c.point_count_u, c.point_count_v, c.order_v]).toEqual([4, 2, 2]);
  });
  it('subdivides between selected rows and grows / shrinks the selection', () => {
    const sp = patch();
    sel(sp, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(G.subdivideGrid(sp, 2)).toBe(true);
    expect(sp.point_count_v).toBe(6);
    expect(sp.points[4].co[0]).toBeCloseTo(-1.5 + 1 / 3, 5);
    expect(sp.points[8].co[0]).toBeCloseTo(-1.5 + 2 / 3, 5);
    const g = patch();
    sel(g, [5]);
    G.growSelection(g, true);
    expect(g.points.filter((p) => p.select).length).toBe(5);
    G.growSelection(g, false);
    expect(g.points.filter((p) => p.select).length).toBe(1);
  });
  it('duplicates a selected rectangle and spins a row into an exact surface of revolution', () => {
    const sp = patch();
    sel(sp, [5, 6, 9, 10]);
    const d = G.duplicateRect(sp)!;
    expect([d.point_count_u, d.point_count_v, d.points.length]).toEqual([2, 2, 4]);
    const row = surfacePrimitive('CURVE').points;
    const rows = G.spinRow(row, [0, 0, 0], [1, 0, 0]);
    expect(rows.length).toBe(8);
    // revolving around X keeps the distance from the axis of every on-circle row
    const r0 = Math.hypot(row[1].co[1], row[1].co[2]);
    expect(Math.hypot(rows[2][1].co[1], rows[2][1].co[2])).toBeCloseTo(r0, 5);
    expect(rows[1][1].co[3]).toBeCloseTo(Math.SQRT1_2, 5);
  });
});
