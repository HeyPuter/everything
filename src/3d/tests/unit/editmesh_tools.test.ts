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

import { solidify, wireframe, gridFill, beautifyFill, convexHull, intersectKnife, intersectBoolean, splitFacesByEdges } from '../../src/modes/editmesh/ops-faces';
import { duplicateSelection } from '../../src/modes/editmesh/ops-basic';

function twoCubes() {
  const m = cube();
  selectAll(m);
  duplicateSelection(m);
  moveSelected(m, new Vector3(1, 1, 1));
  return m;
}

describe('face tools', () => {
  it('solidifies a face', () => {
    const m = cube();
    selectFaces(m, (c) => c[2] > 0.9);
    solidify(m, 0.1);
    expect(counts(m)).toEqual([12, 20, 11]);
    expect(m.selectedVerts().length).toBe(4);
  });

  it('builds a wireframe', () => {
    const m = cube();
    selectAll(m);
    wireframe(m, { thickness: 0.2, offset: 0, boundary: true, even: true, relative: false, replace: true });
    expect(counts(m)).toEqual([40, 96, 48]);
    expect(manifold(m)).toBe(true);
    const pts = sorted(m);
    expect(pts).toContainEqual([-0.9423, -0.9423, -0.9423]);
    expect(pts).toContainEqual([-0.9, -0.9, -1]);
    const p = fromPrim(prim.plane());
    selectAll(p);
    wireframe(p, { thickness: 0.2, offset: 0, boundary: true, even: true, relative: false, replace: true });
    expect(counts(p)).toEqual([16, 32, 16]);
    expect(manifold(p)).toBe(true);
    expect(sorted(p)).toContainEqual([1.1, 1.1, 0]);
  });

  it('grid fills a closed loop', () => {
    const ring = (n: number) => {
      const r = fromPrim(prim.circle(n));
      r.looseEdges = Array.from({ length: n }, (_, i) => [i, (i + 1) % n] as [number, number]);
      return r;
    };
    const m = ring(12);
    selectAll(m);
    expect(gridFill(m, 3, 0)).toBe(true);
    expect(counts(m)).toEqual([16, 24, 9]);
    const m2 = ring(16);
    selectAll(m2);
    gridFill(m2, 3, 0);
    expect(counts(m2)).toEqual([24, 38, 15]);
  });

  it('beautifies triangles without changing counts', () => {
    const m = fromPrim(prim.grid(2, 2));
    selectAll(m);
    // triangulate along one diagonal, then beautify
    const tris = m.faces.flatMap((f) => [m.makeFace([f.verts[0], f.verts[1], f.verts[2]], f), m.makeFace([f.verts[0], f.verts[2], f.verts[3]], f)]);
    m.faces = tris;
    const before = counts(m);
    beautifyFill(m, Math.PI);
    expect(counts(m)).toEqual(before);
  });

  it('makes a convex hull', () => {
    const m = cube();
    selectAll(m);
    subdivide(m, 1, 0);
    selectAll(m);
    expect(convexHull(m, { deleteUnused: true, joinTriangles: true, faceThreshold: 0 })).toBe(true);
    expect(counts(m)).toEqual([8, 12, 6]);
  });

  it('intersects two overlapping cubes (knife)', () => {
    const m = twoCubes();
    intersectKnife(m, 'SELECT_UNSELECT', 'CUT');
    expect(counts(m)).toEqual([28, 42, 18]);
    expect(m.selectedVerts().length).toBe(12);
  });

  it('boolean union / intersect / difference', () => {
    const u = twoCubes();
    intersectBoolean(u, 'UNION', false);
    expect(counts(u)).toEqual([20, 30, 12]);
    expect(u.selectedVerts().length).toBe(6);
    expect(manifold(u)).toBe(true);
    const i = twoCubes();
    intersectBoolean(i, 'INTERSECT', false);
    expect(counts(i)).toEqual([8, 12, 6]);
    const d = twoCubes();
    intersectBoolean(d, 'DIFFERENCE', false);
    expect(counts(d)).toEqual([14, 21, 9]);
    expect(manifold(d)).toBe(true);
  });

  it('welds a loose edge chain into a face', () => {
    const m = fromPrim(prim.plane());
    // a loose path across the plane between two opposite corners, through a middle vertex
    const mid = m.addVert([0, 0, 0], [], 0);
    const f = m.faces[0];
    m.looseEdges.push([f.verts[0], mid], [mid, f.verts[2]]);
    expect(splitFacesByEdges(m)).toBe(1);
    expect(m.faces.length).toBe(2);
    expect(m.looseEdges.length).toBe(0);
  });
});

import { subdivideEdgeRing, offsetEdgeLoops, edgeSplit, connectVertexPairs, sharpnessByAngle } from '../../src/modes/editmesh/ops-edges';

describe('edge tools', () => {
  it('subdivides the ring between two loops', () => {
    const m = fromPrim(prim.cylinder(16));
    selectAll(m);
    expect(subdivideEdgeRing(m, 2, 'LINEAR', 0)).toBe(true);
    expect(counts(m)).toEqual([64, 112, 50]);
    expect(manifold(m)).toBe(true);
    expect(m.selectedVerts().length).toBe(32);
  });

  it('offsets edge loops on both sides', () => {
    const m = cube();
    selectEdges(m, (c) => c[2] > 0.9);
    // the whole top loop: only the side faces get a new loop
    expect(offsetEdgeLoops(m, 0.25)).toBe(true);
    expect(counts(m)).toEqual([12, 20, 10]);
    const one = cube();
    selectEdges(one, (c) => c[2] > 0.9 && c[0] > 0.9);
    offsetEdgeLoops(one, 0.25);
    expect(counts(one)).toEqual([12, 18, 8]);
    expect(manifold(one)).toBe(true);
  });

  it('splits edges and vertices', () => {
    const m = cube();
    selectEdges(m, (c) => c[2] > 0.9);
    // keep only the loop (not the top face) for the split
    expect(edgeSplit(m, 'EDGE')).toBe(true);
    expect(counts(m)).toEqual([12, 16, 6]);
    const v = cube();
    selectEdges(v, (c) => c[2] > 0.9);
    edgeSplit(v, 'VERT');
    expect(v.vcount).toBe(16);
  });

  it('connects vertex pairs and sets sharpness by angle', () => {
    const m = cube();
    selectWhere(m, (p) => (p[0] > 0.9 && p[1] > 0.9 && p[2] > 0.9) || (p[0] > 0.9 && p[1] < -0.9 && p[2] < -0.9));
    expect(connectVertexPairs(m)).toBe(1);
    expect(counts(m)).toEqual([8, 13, 7]);
    const s = cube();
    selectAll(s);
    subdivide(s, 1, 0);
    selectAll(s);
    sharpnessByAngle(s, Math.PI / 6, false);
    const sharp = new Set<string>();
    for (const f of s.faces) f.verts.forEach((v, i) => f.sharp[i] && sharp.add([v, f.verts[(i + 1) % f.verts.length]].sort().join()));
    expect(sharp.size).toBe(24);
  });
});

import { symmetrySnap, sortElements, smoothLaplacian, blendFromShape, propagateToShapes, randomizeVerts } from '../../src/modes/editmesh/ops-vertex';
import { ripSelection, ripFill, ripEdge } from '../../src/modes/editmesh/rip';

describe('vertex tools', () => {
  it('snaps near-symmetrical pairs', () => {
    const m = cube();
    const v = m.pos.findIndex((_, i) => i % 3 === 0 && m.pos[i] > 0.9 && m.pos[i + 1] > 0.9 && m.pos[i + 2] > 0.9) / 3;
    m.pos[v * 3] += 0.02;
    selectAll(m);
    const r = symmetrySnap(m, 'NEGATIVE_X', 0.05, 0.5, true);
    expect(r.mirrored).toBe(1);
    expect(r.already).toBe(3);
    const pts = sorted(m);
    expect(pts).toContainEqual([1.01, 1, 1]);
    expect(pts).toContainEqual([-1.01, 1, 1]);
  });

  it('sorts selected vertices and keeps faces intact', () => {
    const m = cube();
    selectAll(m);
    const before = counts(m);
    sortElements(m, 'CURSOR_DISTANCE', ['VERT'], false, 0, { cursor: new Vector3(1, 1, 1) });
    expect(m.p(0)).toEqual([1, 1, 1]);
    expect(counts(m)).toEqual(before);
    expect(manifold(m)).toBe(true);
    sortElements(m, 'REVERSE', ['VERT'], false, 0, {});
    expect(m.p(7)).toEqual([1, 1, 1]);
  });

  it('smooths, blends shapes, propagates and randomizes', () => {
    const m = cube();
    selectAll(m);
    subdivide(m, 2, 0);
    selectAll(m);
    expect(smoothLaplacian(m, { repeat: 1, lambda: 0.5, lambdaBorder: 0, axes: [true, true, true], preserveVolume: false })).toBe(true);
    // the corners round off
    const cornerness = Math.max(...sorted(m).map((p) => Math.min(...p.map(Math.abs))));
    expect(cornerness).toBeLessThan(1);
    expect(cornerness).toBeGreaterThan(0.8);
    const k = cube();
    k.keys = [k.pos.slice(), k.pos.map((x) => x * 2)];
    selectAll(k);
    blendFromShape(k, 1, 0.5, true);
    expect(Math.max(...k.pos)).toBeCloseTo(1.5);
    k.pos = k.pos.map((x) => x + 1);
    propagateToShapes(k);
    expect(k.keys[1]).toEqual(k.pos);
    const r = cube();
    selectAll(r);
    randomizeVerts(r, 0.1, 0, 0, 3);
    expect(r.pos.some((x) => Math.abs(Math.abs(x) - 1) > 1e-6)).toBe(true);
  });

  it('rips with fill and extends boundary vertices', () => {
    const m = fromPrim(prim.grid(2, 2));
    // the middle row of edges along X
    selectWhere(m, (p) => Math.abs(p[1]) < 1e-6);
    const map = new Map<number, number>();
    expect(ripSelection(m, (fi) => m.faceCenter(m.faces[fi])[1], map)).toBe(3);
    expect(ripFill(m, map)).toBe(2);
    expect(m.faces.length).toBe(6);
    const e = fromPrim(prim.plane());
    selectWhere(e, (p) => p[0] > 0.9 && p[1] > 0.9);
    expect(ripEdge(e, () => 0)).toBe(1);
    expect(counts(e)).toEqual([5, 6, 2]);
  });
});
