// @vitest-environment happy-dom
// Edit-mode modelling tools: counts and positions checked against known-good results.
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { MeshEdit, edgeKey } from '../../src/modes/editmesh/meshedit';
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

import { regionToLoop, loopToRegion, selectSimilar, vertexPath } from '../../src/modes/editmesh/select-extra';

describe('selection tools', () => {
  it('region to loop and back', () => {
    const m = fromPrim(prim.grid(4, 4));
    selectFaces(m, (c) => Math.abs(c[0]) < 0.4 && Math.abs(c[1]) < 0.4);
    const loop = regionToLoop(m);
    expect(loop.length).toBe(8);
    m.sel = m.sel.map(() => 0);
    for (const v of loop) m.sel[v] = 1;
    const faces = loopToRegion(m, false);
    expect(faces.length).toBe(4);
  });

  it('selects similar edges by length and faces by area', () => {
    const m = cube();
    selectAll(m);
    subdivide(m, 1, 0);
    selectEdges(m, (c) => c[2] > 0.9 && c[0] > 0.9 && c[1] > 0.4);
    const sel = new Uint8Array(m.sel);
    selectSimilar(m, null as never, sel, 'EDGE_LENGTH', 'EQUAL', 0);
    expect(sel.reduce((a, b) => a + b, 0)).toBe(26);
    const f = cube();
    selectFaces(f, (c) => c[2] > 0.9);
    const fs = new Uint8Array(f.sel);
    selectSimilar(f, null as never, fs, 'FACE_NORMAL', 'EQUAL', 0);
    expect(fs.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('finds the shortest vertex path', () => {
    const m = fromPrim(prim.grid(4, 4));
    const corner = (x: number, y: number) => Array.from({ length: m.vcount }, (_, i) => i).find((i) => Math.abs(m.p(i)[0] - x) < 1e-6 && Math.abs(m.p(i)[1] - y) < 1e-6)!;
    const path = vertexPath(m, corner(-1, -1), corner(1, -1));
    expect(path.length).toBe(5);
  });
});

import { setNormalsFromFaces, pointNormals, mergeNormals, averageNormals, smoothNormals, normalsTools, ensureCustomNormals } from '../../src/modes/editmesh/normals';

describe('custom normals', () => {
  const corner = (m: MeshEdit, fi: number, c: number) => m.faces[fi].cnormals!.slice(c * 3, c * 3 + 3);

  it('round-trips through mesh data and survives topology edits', () => {
    const me = newMeshData('Cube', prim.cube(2));
    const m = MeshEdit.from(me);
    selectAll(m);
    mergeNormals(m, false);
    m.write(me);
    expect(me.custom_normals?.length).toBe(me.indices.length * 3);
    const back = MeshEdit.from(me);
    // merged: every corner at a vertex shares the diagonal direction
    const n = corner(back, 0, 0);
    expect(Math.abs(n[0])).toBeCloseTo(1 / Math.sqrt(3), 4);
    // a topology change keeps the array the right size
    selectFaces(back, (c) => c[2] > 0.9);
    extrudeRegion(back);
    back.write(me);
    expect(me.custom_normals?.length).toBe(me.indices.length * 3);
  });

  it('splits, points, averages, smooths and resets', () => {
    const m = cube();
    selectAll(m);
    mergeNormals(m, true);
    // split: corners carry their face normal
    const f0 = m.faceNormal(m.faces[0]);
    expect(corner(m, 0, 0).map((x) => Math.round(x * 1e4) / 1e4)).toEqual(f0.map((x) => Math.round(x * 1e4) / 1e4));
    pointNormals(m, new Vector3(0, 0, 10), {});
    for (const f of m.faces) for (let c = 0; c < 4; c++) expect(f.cnormals![c * 3 + 2]).toBeGreaterThan(0.8);
    averageNormals(m, 'FACE_AREA', 50, 0.01);
    smoothNormals(m, 0.5);
    setNormalsFromFaces(m, false);
    normalsTools(m, 'RESET', false, -1);
    const auto = m.customNormalsAuto();
    expect(Array.from(m.customNormals()!)).toEqual(Array.from(auto));
    ensureCustomNormals(m);
  });
});

describe('subdivide patterns', () => {
  const corner = () => {
    const m = cube();
    // three corners of the top face: two adjacent edges are cut
    selectWhere(m, (p) => p[2] > 0.9 && !(p[0] < -0.9 && p[1] < -0.9));
    return m;
  };
  it('splits a quad corner straight, with an inner vertex, or as a fan', () => {
    const s = corner();
    subdivide(s, 1, 0, { quadcorner: 'STRAIGHT_CUT' });
    expect(counts(s)).toEqual([10, 15, 7]);
    const i = corner();
    subdivide(i, 1, 0, { quadcorner: 'INNERVERT' });
    expect(counts(i)).toEqual([11, 17, 8]);
    const f = corner();
    subdivide(f, 1, 0, { quadcorner: 'FAN' });
    expect(counts(f)).toEqual([10, 16, 8]);
  });
  it('fractal displaces only the new vertices', () => {
    const m = cube();
    selectAll(m);
    subdivide(m, 1, 0, { fractal: 5, seed: 1 });
    for (let v = 0; v < 8; v++) expect(m.p(v).map(Math.abs)).toEqual([1, 1, 1]);
    expect(m.pos.slice(24).some((x) => Math.abs(x) % 1 > 1e-3 && Math.abs(Math.abs(x) - 1) > 1e-3)).toBe(true);
  });
});

import { bridgeLoops } from '../../src/modes/editmesh/ops-topology';
import { triangulate } from '../../src/modes/editmesh/ops-faces';

describe('bridge and triangulate options', () => {
  const twoRings = () => {
    const m = new MeshEdit();
    for (const z of [0, 2]) {
      const base = m.vcount;
      for (let i = 0; i < 8; i++) m.addVert([Math.cos((i / 8) * Math.PI * 2), Math.sin((i / 8) * Math.PI * 2), z]);
      for (let i = 0; i < 8; i++) m.looseEdges.push([base + i, base + ((i + 1) % 8)]);
    }
    selectAll(m);
    return m;
  };
  it('bridges with cuts and merges', () => {
    const m = twoRings();
    expect(bridgeLoops(m, { cuts: 2, interpolation: 'LINEAR' })).toBe(true);
    expect(m.vcount).toBe(32);
    expect(m.faces.length).toBe(24);
    const mm = twoRings();
    bridgeLoops(mm, { merge: true, mergeFactor: 0.5 });
    expect(mm.vcount).toBe(8);
    expect(mm.p(0)[2]).toBeCloseTo(1);
  });
  it('triangulates quads with fixed and alternate splits', () => {
    const a = cube();
    selectFaces(a, (c) => c[2] > 0.9);
    triangulate(a, new Set(a.selectedFaces()), 'FIXED', 'CLIP');
    const b = cube();
    selectFaces(b, (c) => c[2] > 0.9);
    triangulate(b, new Set(b.selectedFaces()), 'FIXED_ALTERNATE', 'CLIP');
    expect(a.faces.length).toBe(7);
    const diag = (m: MeshEdit) => m.edges().filter(([x, y]) => m.p(x)[2] > 0.9 && m.p(y)[2] > 0.9 && m.p(x)[0] !== m.p(y)[0] && m.p(x)[1] !== m.p(y)[1]).map((e) => e.map((v) => m.p(v).join()).sort().join('|'));
    expect(diag(a)).not.toEqual(diag(b));
  });
});

import { edgeSlideTargets, applyEdgeSlide } from '../../src/modes/editmesh/slide';

describe('edge slide', () => {
  it('slides a loop consistently to one side', () => {
    const m = cube();
    selectAll(m);
    subdivide(m, 1, 0);
    // the middle horizontal loop
    selectWhere(m, (p) => Math.abs(p[2]) < 1e-6);
    const slides = edgeSlideTargets(m);
    expect(slides.length).toBe(8);
    const base = m.pos.slice();
    applyEdgeSlide(m, base, slides, 0.5, false, false);
    const zs = slides.map((s) => Math.round(m.p(s.v)[2] * 1e4) / 1e4);
    // every vertex moved halfway to the same side
    expect(new Set(zs).size).toBe(1);
    expect(Math.abs(zs[0])).toBeCloseTo(0.5);
    applyEdgeSlide(m, base, slides, -0.5, false, false);
    expect(Math.round(m.p(slides[0].v)[2] * 1e4) / 1e4).toBeCloseTo(-zs[0]);
  });
});

import { selectFaces as selFaces, selectEdges as selEdges, selectedFaceSet } from '../../src/modes/editmesh/selset';

describe('exact edge / face selection', () => {
  it('keeps three faces of a 2x2 grid selected without the fourth', () => {
    const me = newMeshData('G', prim.grid(2, 2));
    selFaces(me, new Set([0, 1, 2]));
    expect(selectedFaceSet(me).size).toBe(3);
    const m = MeshEdit.from(me);
    expect(m.selectedFaces().length).toBe(3);
    // an operator on the selection keeps it exact (written back with the new arrays)
    m.write(me);
    expect(MeshEdit.from(me).selectedFaces().length).toBe(3);
  });
  it('selects two opposite edges of a quad and subdivides only those', () => {
    const me = newMeshData('P', prim.plane());
    const m0 = MeshEdit.from(me);
    const f = m0.faces[0].verts;
    selEdges(me, new Set([edgeKey(f[0], f[1]), edgeKey(f[2], f[3])]));
    const m = MeshEdit.from(me);
    expect(m.selectedEdges().length).toBe(2);
    expect(m.selectedFaces().length).toBe(0);
    subdivide(m, 1, 0);
    expect(m.vcount).toBe(6);
    expect(m.faces.length).toBe(2);
    expect(m.faces.every((x) => x.verts.length === 4)).toBe(true);
  });
});

import { spin } from '../../src/modes/editmesh/ops-topology';

describe('spin', () => {
  const edgeOnly = () => {
    const m = fromPrim(prim.plane());
    m.looseEdges = m.edges();
    m.faces = [];
    selectWhere(m, (p) => p[0] > 0.9);
    return m;
  };
  it('merges a full turn and sweeps faces like an extrusion', () => {
    const a = edgeOnly();
    spin(a, 4, Math.PI * 2, new Vector3(), new Vector3(0, 0, 1), false, { autoMerge: true });
    expect([a.vcount, a.faces.length]).toEqual([10, 4]);
    const b = edgeOnly();
    spin(b, 4, Math.PI / 2, new Vector3(), new Vector3(0, 0, 1), false, { autoMerge: true });
    expect([b.vcount, b.faces.length]).toEqual([12, 4]);
    const c = cube();
    selectFaces(c, (x) => x[0] > 0.9);
    spin(c, 3, Math.PI / 2, new Vector3(0, 0, -3), new Vector3(0, 1, 0));
    expect(counts(c)).toEqual([20, 36, 18]);
    expect(manifold(c)).toBe(true);
    const d = cube();
    selectFaces(d, (x) => x[0] > 0.9);
    spin(d, 3, Math.PI / 2, new Vector3(0, 0, -3), new Vector3(0, 1, 0), true);
    expect(counts(d)).toEqual([20, 24, 9]);
  });
});

import { similarRegions } from '../../src/modes/editmesh/select-extra';

describe('similar regions', () => {
  it('finds the same face pattern elsewhere', () => {
    // two separate cubes: selecting two adjacent faces of one finds every matching pair
    const m = cube();
    selectAll(m);
    duplicateSelection(m);
    moveSelected(m, new Vector3(5, 0, 0));
    m.sel = m.sel.map(() => 0);
    for (const f of m.faces) if (m.faceCenter(f)[0] < 3 && (m.faceCenter(f)[2] > 0.9 || m.faceCenter(f)[0] > 0.9)) for (const v of f.verts) m.sel[v] = 1;
    const before = m.selectedFaces().length;
    expect(before).toBe(2);
    const out = similarRegions(m);
    expect(out.length).toBeGreaterThan(2);
    expect(out.length % 2).toBe(0);
  });
});

describe('color attributes through edits', () => {
  it('keeps a second face-corner color attribute when the corners do not change', () => {
    const me = newMeshData('C', prim.cube(2));
    const n = me.indices.length;
    me.color_attributes = [
      { name: 'A', domain: 'CORNER', data: new Float32Array(n * 4).fill(0.5) },
      { name: 'B', domain: 'CORNER', data: new Float32Array(n * 4).fill(0.25) },
    ] as typeof me.color_attributes;
    const m = MeshEdit.from(me);
    selectAll(m);
    moveSelected(m, new Vector3(0, 0, 1));
    m.write(me);
    expect(me.color_attributes[0].data[0]).toBeCloseTo(0.5);
    expect(me.color_attributes[1].data[0]).toBeCloseTo(0.25);
  });
});

import { bevelEdges, bevelVertices } from '../../src/modes/editmesh/bevel';

describe('bevel with segments', () => {
  it('rounds cube corners with a patch per corner', () => {
    const two = cube();
    selectAll(two);
    bevelEdges(two, 0.2, 2);
    expect(counts(two)).toEqual([56, 108, 54]);
    expect(manifold(two)).toBe(true);
    const three = cube();
    selectAll(three);
    bevelEdges(three, 0.2, 3);
    expect(counts(three)).toEqual([96, 192, 98]);
    expect(manifold(three)).toBe(true);
  });
  it('keeps the end faces closed when one edge gets several segments', () => {
    const m = cube();
    selectWhere(m, (p) => p[2] > 0.9 && p[0] > 0.9);
    bevelEdges(m, 0.2, 3);
    expect(counts(m)).toEqual([14, 21, 9]);
    expect(manifold(m)).toBe(true);
  });
  it('rounds a vertex', () => {
    const m = cube();
    selectWhere(m, (p) => p.every((x) => x > 0.9));
    bevelVertices(m, 0.3, 2);
    expect(counts(m)).toEqual([14, 21, 9]);
    expect(manifold(m)).toBe(true);
  });
});

import { fillLoops } from '../../src/modes/editmesh/ops-faces';

describe('fill', () => {
  it('fills an open cylinder end with triangles only', () => {
    const m = fromPrim(prim.cylinder(8));
    selectFaces(m, (c) => c[2] > 0.9);
    deleteGeometry(m, 'ONLY_FACE');
    selectWhere(m, (p) => p[2] > 0.9);
    expect(fillLoops(m, true)).toBe(1);
    expect(counts(m)).toEqual([16, 29, 15]);
    expect(manifold(m)).toBe(true);
    // the side quads stay quads
    expect(m.faces.filter((f) => f.verts.length === 4).length).toBe(8);
  });
});

import { connectTwo } from '../../src/modes/editmesh/ops-edges';

describe('connect vertex path', () => {
  it('cuts across several faces between two vertices', () => {
    const m = fromPrim(prim.grid(4, 4));
    const at = (x: number, y: number) => Array.from({ length: m.vcount }, (_, i) => i).find((i) => Math.abs(m.p(i)[0] - x) < 1e-6 && Math.abs(m.p(i)[1] - y) < 1e-6)!;
    const before = m.faces.length;
    // across the grid: from the left edge to the right edge on a diagonal
    const path = connectTwo(m, at(-1, -1), at(1, 0));
    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toBe(at(1, 0));
    expect(m.faces.length).toBeGreaterThan(before);
    // still a valid 2-manifold sheet: every edge has one or two faces
    expect([...m.edgeFaces().values()].every((l) => l.length <= 2)).toBe(true);
  });
});
