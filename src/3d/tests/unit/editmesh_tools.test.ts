// @vitest-environment happy-dom
// Edit-mode modelling tools: counts and positions checked against known-good results.
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { MeshEdit } from '../../src/modes/editmesh/meshedit';
import { subdivide, extrudeRegion } from '../../src/modes/editmesh/ops-topology';
import { shrinkFatten, extrudeRepeat, dissolveOrthogonalWalls, moveSelected, screw } from '../../src/modes/editmesh/ops-extrude';
import { dissolveLimited, collapseEdges, deleteEdgeLoops, makePlanar, splitNonPlanar, splitConcave, fillHoles, unsubdivideStep, decimate, dissolveDegenerate } from '../../src/modes/editmesh/ops-cleanup';
import { deleteGeometry } from '../../src/modes/editmesh/ops-basic';

export function cube() {
  return MeshEdit.from(newMeshData('Cube', prim.cube(2)));
}
export function fromPrim(p: ReturnType<typeof prim.cube>) {
  return MeshEdit.from(newMeshData('M', p));
}
export function edgeCount(m: MeshEdit) {
  return m.edges().length;
}
export function counts(m: MeshEdit) {
  return [m.vcount, edgeCount(m), m.faces.length];
}
export function manifold(m: MeshEdit) {
  return [...m.edgeFaces().values()].every((l) => l.length === 2);
}
export function selectAll(m: MeshEdit) {
  m.sel = m.sel.map(() => 1);
}
export function selectWhere(m: MeshEdit, pred: (p: number[]) => boolean) {
  m.sel = m.sel.map((_, i) => (pred(m.p(i)) ? 1 : 0));
}
export function selectFaces(m: MeshEdit, pred: (c: number[]) => boolean) {
  m.sel = m.sel.map(() => 0);
  for (const f of m.faces) if (pred(m.faceCenter(f))) for (const v of f.verts) m.sel[v] = 1;
}
/** Select edges whose midpoint matches (vertex selection of their endpoints). */
export function selectEdges(m: MeshEdit, pred: (c: number[]) => boolean) {
  m.sel = m.sel.map(() => 0);
  for (const [a, b] of m.edges()) {
    const c = [0, 1, 2].map((k) => (m.p(a)[k] + m.p(b)[k]) / 2);
    if (pred(c)) m.sel[a] = m.sel[b] = 1;
  }
}
const sorted = (m: MeshEdit) =>
  Array.from({ length: m.vcount }, (_, i) => m.p(i).map((x) => Math.round(x * 1e4) / 1e4))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

describe('extrude variants', () => {
  it('extrudes along normals with per-vertex offsets', () => {
    const m = cube();
    selectFaces(m, (c) => c[2] > 0.9 || c[0] > 0.9);
    extrudeRegion(m);
    shrinkFatten(m, -0.5);
    expect(counts(m)).toEqual([14, 24, 12]);
    const pts = sorted(m);
    expect(pts).toContainEqual([0.5, 1, -1]);
    expect(pts).toContainEqual([0.6464, 1, 0.6464]);
  });

  it('keeps a closed region as an inner shell', () => {
    const m = cube();
    selectAll(m);
    extrudeRegion(m);
    shrinkFatten(m, -0.5);
    expect(counts(m)).toEqual([16, 24, 12]);
    expect(sorted(m)).toContainEqual([0.7113, 0.7113, 0.7113]);
  });

  it('repeats an extrusion', () => {
    const m = cube();
    selectFaces(m, (c) => c[2] > 0.9);
    extrudeRepeat(m, 3, new Vector3(0, 0, 0.5));
    expect(counts(m)).toEqual([20, 36, 18]);
    expect(m.selectedVerts().every((v) => Math.abs(m.p(v)[2] - 2.5) < 1e-6)).toBe(true);
  });

  it('extrude manifold merges coplanar walls', () => {
    const m = cube();
    selectFaces(m, (c) => c[2] > 0.9);
    extrudeRegion(m);
    moveSelected(m, new Vector3(0, 0, 0.5));
    dissolveOrthogonalWalls(m);
    expect(counts(m)).toEqual([8, 12, 6]);
    expect(manifold(m)).toBe(true);
    const zs = sorted(m).map((p) => p[2]);
    expect(Math.max(...zs)).toBeCloseTo(1.5);
  });

  it('screws an edge profile', () => {
    const m = fromPrim(prim.plane());
    m.looseEdges = m.edges();
    m.faces = [];
    // the edge on +X
    selectWhere(m, (p) => p[0] > 0.9);
    expect(screw(m, 4, 1, new Vector3(), new Vector3(0, 0, 1))).toBe(true);
    expect(m.vcount).toBe(12);
    expect(m.faces.length).toBe(4);
  });
});

describe('clean up', () => {
  it('limited dissolve restores a subdivided cube', () => {
    const m = cube();
    selectAll(m);
    subdivide(m, 2, 0);
    selectAll(m);
    dissolveLimited(m, { angle: (5 * Math.PI) / 180 });
    expect(counts(m)).toEqual([8, 12, 6]);
    expect(manifold(m)).toBe(true);
  });

  it('collapses an edge and a face', () => {
    const m = cube();
    selectEdges(m, (c) => c[2] > 0.9 && c[0] > 0.9);
    collapseEdges(m);
    expect(counts(m)).toEqual([7, 11, 6]);
    const m2 = cube();
    selectFaces(m2, (c) => c[2] > 0.9);
    collapseEdges(m2);
    expect(counts(m2)).toEqual([5, 8, 5]);
  });

  it('deletes an edge loop', () => {
    const m = cube();
    selectAll(m);
    subdivide(m, 1, 0);
    selectEdges(m, (c) => Math.abs(c[2]) < 0.01);
    expect(deleteEdgeLoops(m)).toBe(true);
    expect(m.vcount).toBe(18);
    expect(m.faces.length).toBe(16);
  });

  it('makes faces planar', () => {
    const m = cube();
    selectWhere(m, (p) => p[0] > 0.9 && p[1] > 0.9 && p[2] > 0.9);
    moveSelected(m, new Vector3(0, 0, 0.5));
    selectAll(m);
    makePlanar(m, 1, 1);
    const pts = sorted(m);
    expect(pts).toContainEqual([1.0051, 1.0051, 1.4596]);
    expect(pts).toContainEqual([-0.9949, -0.9949, 0.9596]);
  });

  it('splits non-planar and concave faces', () => {
    const m = cube();
    selectWhere(m, (p) => p[0] > 0.9 && p[1] > 0.9 && p[2] > 0.9);
    moveSelected(m, new Vector3(0, 0, 0.5));
    selectAll(m);
    expect(splitNonPlanar(m, (5 * Math.PI) / 180)).toBe(1);
    expect(counts(m)).toEqual([8, 13, 7]);
    // an L-shaped hexagon is split into two convex parts
    const L = new MeshEdit();
    for (const p of [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]) L.addVert([p[0], p[1], 0]);
    L.faces.push(L.makeFace([0, 1, 2, 3, 4, 5]));
    selectAll(L);
    expect(splitConcave(L)).toBe(1);
    expect(L.faces.length).toBe(2);
  });

  it('fills holes', () => {
    const m = cube();
    selectFaces(m, (c) => c[2] > 0.9);
    deleteGeometry(m, 'ONLY_FACE');
    selectAll(m);
    expect(fillHoles(m, 4)).toBe(1);
    expect(counts(m)).toEqual([8, 12, 6]);
    expect(manifold(m)).toBe(true);
  });

  it('un-subdivides a subdivided cube step by step', () => {
    const m = cube();
    selectAll(m);
    subdivide(m, 3, 0);
    expect(m.vcount).toBe(98);
    selectAll(m);
    unsubdivideStep(m);
    expect(counts(m)).toEqual([50, 96, 48]);
    selectAll(m);
    unsubdivideStep(m);
    expect(counts(m)).toEqual([26, 48, 24]);
    selectAll(m);
    unsubdivideStep(m);
    expect(counts(m)).toEqual([14, 24, 12]);
    selectAll(m);
    unsubdivideStep(m);
    expect(counts(m)).toEqual([8, 12, 6]);
    expect(manifold(m)).toBe(true);
  });

  it('decimates the selection and keeps the surface closed', () => {
    const m = fromPrim(prim.uvSphere(32, 16));
    selectAll(m);
    const before = m.faces.length;
    expect(decimate(m, 0.5)).toBe(true);
    expect(m.faces.length).toBeLessThan(before);
    expect(manifold(m)).toBe(true);
  });

  it('dissolves degenerate geometry', () => {
    const m = cube();
    selectWhere(m, (p) => p[0] > 0.9 && p[1] > 0.9 && p[2] > 0.9);
    moveSelected(m, new Vector3(0, -2, 0)); // onto its neighbour
    selectAll(m);
    expect(dissolveDegenerate(m, 0.001)).toBeGreaterThan(0);
    expect(m.vcount).toBe(7);
  });
});
