// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Vector3, Matrix4 } from 'three';
import { knifeCut } from '../../src/modes/editmesh/knife';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { MeshEdit, edgeKey } from '../../src/modes/editmesh/meshedit';
import { extrudeRegion, insetFaces, loopCut } from '../../src/modes/editmesh/ops-topology';
import { bevelEdges, bevelVertices } from '../../src/modes/editmesh/bevel';
import { deleteGeometry, removeDoubles, makeNormalsConsistent, flipFace, duplicateSelection } from '../../src/modes/editmesh/ops-basic';
import { edgeLoop, edgeRing, edgeLoopsOf } from '../../src/modes/editmesh/select';
import { bisectMesh, packIslands } from '../../src/modes/editmesh/ops-uv';
import { ripSelection } from '../../src/modes/editmesh/rip';

function cubeEdit() {
  const me = newMeshData('Cube', prim.cube(2));
  return { me, m: MeshEdit.from(me) };
}

function manifold(m: MeshEdit) {
  const ef = m.edgeFaces();
  return [...ef.values()].every((l) => l.length === 2);
}

function signedVolume(m: MeshEdit) {
  let vol = 0;
  for (const f of m.faces)
    for (let i = 1; i < f.verts.length - 1; i++) {
      const a = new Vector3(...m.p(f.verts[0])),
        b = new Vector3(...m.p(f.verts[i])),
        c = new Vector3(...m.p(f.verts[i + 1]));
      vol += a.dot(b.clone().cross(c)) / 6;
    }
  return vol;
}

function selectFace(m: MeshEdit, pred: (center: number[]) => boolean) {
  m.sel = m.sel.map(() => 0);
  for (const f of m.faces) if (pred(m.faceCenter(f))) for (const v of f.verts) m.sel[v] = 1;
}

describe('MeshEdit', () => {
  it('round-trips mesh data', () => {
    const { me, m } = cubeEdit();
    const out = newMeshData('x', prim.plane());
    m.write(out);
    expect(out.positions).toEqual(me.positions);
    expect(out.indices).toEqual(me.indices);
    expect(out.offsets).toEqual(me.offsets);
    expect(manifold(m)).toBe(true);
    expect(signedVolume(m)).toBeCloseTo(8, 5);
  });

  it('keeps the sculpt mask, face sets, hidden faces and UV pins through topology changes', () => {
    const { me } = cubeEdit();
    me.sculpt_mask = Float32Array.from({ length: 8 }, (_, i) => i / 8);
    me.sculpt_face_set = Int32Array.from({ length: 6 }, (_, i) => i + 1);
    me.hide_poly = Uint8Array.from({ length: 6 }, (_, i) => (i === 5 ? 1 : 0));
    me.uv_pin = Uint8Array.from({ length: 24 }, (_, i) => (i < 4 ? 1 : 0));
    const m = MeshEdit.from(me);
    selectFace(m, (c) => c[2] > 0.9);
    extrudeRegion(m);
    m.write(me);
    const nf = me.offsets.length - 1;
    expect(me.sculpt_mask?.length).toBe(me.positions.length / 3);
    expect(Array.from(me.sculpt_mask!.subarray(0, 8))).toEqual(Array.from({ length: 8 }, (_, i) => Math.fround(i / 8)));
    expect(me.sculpt_face_set?.length).toBe(nf);
    expect(Array.from(me.sculpt_face_set!.subarray(0, 6))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(me.sculpt_face_set!.every((x) => x >= 1)).toBe(true);
    expect(me.hide_poly?.length).toBe(nf);
    expect(me.hide_poly![5]).toBe(1);
    expect(me.uv_pin?.length).toBe(me.indices.length);
    expect(Array.from(me.uv_pin!.subarray(0, 4))).toEqual([1, 1, 1, 1]);
    expect(me.attributes ?? []).toEqual([]);
    // deleting a face keeps the remaining faces' sets in order
    const m2 = MeshEdit.from(me);
    m2.sel = m2.sel.map(() => 0);
    for (const v of m2.faces[0].verts) m2.sel[v] = 1;
    deleteGeometry(m2, 'FACE');
    m2.write(me);
    expect(me.sculpt_face_set?.length).toBe(me.offsets.length - 1);
    expect(me.sculpt_face_set![0]).toBe(2);
  });

  it('keeps a mesh without UV maps without one after a topology change', () => {
    const { me } = cubeEdit();
    me.uvs = new Float32Array(0);
    const m = MeshEdit.from(me);
    selectFace(m, (c) => c[2] > 0.9);
    extrudeRegion(m);
    m.write(me);
    expect(me.uvs.length).toBe(0);
    expect(me.indices.length).toBe(40);
  });

  it('bevel keeps the corner colors of the faces it reshapes', () => {
    const { me } = cubeEdit();
    me.color_attributes = [{ name: 'Col', domain: 'CORNER', data: Float32Array.from({ length: 24 * 4 }, (_, i) => (i % 4 === 0 || i % 4 === 3 ? 1 : 0)) }];
    const m = MeshEdit.from(me);
    // one edge of the top face
    m.sel = m.sel.map(() => 0);
    const top = m.faces.find((f) => f.verts.every((v) => m.p(v)[2] > 0.9))!;
    m.sel[top.verts[0]] = m.sel[top.verts[1]] = 1;
    expect(bevelEdges(m, 0.2, 1)).toBe(true);
    m.write(me);
    const data = me.color_attributes[0].data;
    expect(data.length).toBe(me.indices.length * 4);
    let red = 0;
    for (let c = 0; c < me.indices.length; c++) if (data[c * 4] === 1 && data[c * 4 + 1] === 0) red++;
    // the 6 original faces keep red on all their (now 4 or 5) corners; only the new strip is white
    expect(red).toBe(me.indices.length - 4);
  });

  it('extrudes a face region with walls', () => {
    const { m } = cubeEdit();
    selectFace(m, (c) => c[2] > 0.9);
    expect(extrudeRegion(m)).toBe('FACES');
    expect(m.faces.length).toBe(10);
    expect(m.vcount).toBe(12);
    expect(manifold(m)).toBe(true);
    expect(m.selectedFaces().length).toBe(1);
  });

  it('extrudes edges and vertices', () => {
    const me = newMeshData('Plane', prim.plane());
    const m = MeshEdit.from(me);
    m.sel = [1, 1, 0, 0];
    m.faces = [];
    m.looseEdges = [[0, 1]];
    expect(extrudeRegion(m)).toBe('EDGES');
    expect(m.faces.length).toBe(1);
    const m2 = MeshEdit.from(newMeshData('P', prim.plane()));
    m2.faces = [];
    m2.sel = [1, 0, 0, 0];
    expect(extrudeRegion(m2)).toBe('VERTS');
    expect(m2.looseEdges.length).toBe(1);
  });

  it('insets a face (region and individual)', () => {
    const { m } = cubeEdit();
    selectFace(m, (c) => c[2] > 0.9);
    expect(insetFaces(m, 0.2, 0, false)).toBe(true);
    expect(m.faces.length).toBe(10);
    expect(m.vcount).toBe(12);
    expect(manifold(m)).toBe(true);
    // the inner face is smaller
    const inner = m.faces[m.selectedFaces()[0]];
    const xs = inner.verts.map((v) => m.p(v)[0]);
    expect(Math.max(...xs)).toBeCloseTo(0.8, 5);
  });

  it('loop cuts a quad ring', () => {
    const { m } = cubeEdit();
    // any vertical edge on the side
    const [a, b] = m.edges().find(([x, y]) => Math.abs(m.p(x)[2] - m.p(y)[2]) > 1)!;
    expect(loopCut(m, a, b, 1, 0)).toBe(true);
    expect(m.faces.length).toBe(10);
    expect(m.vcount).toBe(12);
    expect(manifold(m)).toBe(true);
    expect(signedVolume(m)).toBeCloseTo(8, 4);
    const m2 = cubeEdit().m;
    loopCut(m2, a, b, 3, 0);
    expect(m2.faces.length).toBe(18);
  });

  it('bevels one edge and all edges of a cube', () => {
    const { m } = cubeEdit();
    const [a, b] = m.edges()[0];
    m.sel = m.sel.map((_, i) => (i === a || i === b ? 1 : 0));
    expect(bevelEdges(m, 0.2, 1)).toBe(true);
    expect(manifold(m)).toBe(true);
    expect(m.faces.length).toBe(7);
    expect(m.vcount).toBe(10);
    expect(signedVolume(m)).toBeLessThan(8);
    const all = cubeEdit().m;
    all.sel = all.sel.map(() => 1);
    expect(bevelEdges(all, 0.2, 1)).toBe(true);
    expect(manifold(all)).toBe(true);
    expect(all.faces.length).toBe(26);
    expect(all.vcount).toBe(24);
    expect(signedVolume(all)).toBeGreaterThan(7);
  });

  it('bevels vertices', () => {
    const { m } = cubeEdit();
    m.sel = m.sel.map((_, i) => (i === 0 ? 1 : 0));
    expect(bevelVertices(m, 0.3)).toBe(true);
    expect(manifold(m)).toBe(true);
    expect(m.faces.length).toBe(7);
    expect(m.vcount).toBe(10);
  });

  it('deletes vertices, faces and only faces', () => {
    const { m } = cubeEdit();
    m.sel = m.sel.map((_, i) => (i === 0 ? 1 : 0));
    deleteGeometry(m, 'VERT');
    expect(m.vcount).toBe(7);
    expect(m.faces.length).toBe(3);
    const m2 = cubeEdit().m;
    selectFace(m2, (c) => c[2] > 0.9);
    deleteGeometry(m2, 'FACE');
    expect(m2.faces.length).toBe(5);
    expect(m2.vcount).toBe(8);
    const m3 = cubeEdit().m;
    selectFace(m3, (c) => c[2] > 0.9);
    deleteGeometry(m3, 'ONLY_FACE');
    expect(m3.faces.length).toBe(5);
  });

  it('merges duplicate vertices and recalculates normals', () => {
    const { m } = cubeEdit();
    m.sel = m.sel.map(() => 1);
    duplicateSelection(m);
    expect(m.vcount).toBe(16);
    m.sel = m.sel.map(() => 1);
    const merged = removeDoubles(m, 0.0001);
    expect(merged).toBe(8);
    expect(m.vcount).toBe(8);
    const n = cubeEdit().m;
    flipFace(n.faces[0]);
    flipFace(n.faces[3]);
    n.sel = n.sel.map(() => 1);
    makeNormalsConsistent(n);
    expect(signedVolume(n)).toBeCloseTo(8, 5);
  });

  it('finds edge loops and rings on a grid', () => {
    const me = newMeshData('Grid', prim.grid(4, 4));
    // an edge along X in the middle row
    const i = 2 * 5 + 1;
    const loop = edgeLoop(me, i, i + 1);
    expect(loop.length).toBe(4);
    const ring = edgeRing(me, i, i + 1);
    expect(ring.length).toBe(5);
    expect(new Set(loop.map(([a, b]) => edgeKey(a, b))).size).toBe(4);
  });

  it('walks loops and rings on the current topology after it changes', () => {
    const me = newMeshData('Grid', prim.grid(4, 4));
    const i = 2 * 5 + 1;
    expect(edgeLoop(me, i, i + 1).length).toBe(4);
    expect(edgeRing(me, i, i + 1).length).toBe(5);
    // the same mesh with a wider grid (new arrays) gives the new loop, not a cached one
    Object.assign(me, prim.grid(6, 4));
    expect(edgeLoop(me, 2 * 7 + 1, 2 * 7 + 2).length).toBe(6);
    expect(edgeRing(me, 2 * 7 + 1, 2 * 7 + 2).length).toBe(5);
  });

  it('unions the loops and rings of many edges like walking each one', () => {
    for (const me of [newMeshData('T', prim.torus(12, 8)), newMeshData('S', prim.uvSphere(8, 6)), newMeshData('G', prim.grid(5, 4))]) {
      const edges = MeshEdit.from(me).edges();
      for (const ring of [false, true]) {
        const naive = new Set(edges.flatMap(([a, b]) => (ring ? edgeRing(me, a, b) : edgeLoop(me, a, b)).map(([x, y]) => edgeKey(x, y))));
        const fast = new Set(edgeLoopsOf(me, edges, ring).map(([x, y]) => edgeKey(x, y)));
        expect([...fast].sort()).toEqual([...naive].sort());
      }
    }
  });

  it('bisects a cube along a plane', () => {
    const { m } = cubeEdit();
    m.sel = m.sel.map(() => 1);
    bisectMesh(m, new Vector3(0, 0, 0), new Vector3(1, 0, 0), false, false);
    expect(m.faces.length).toBe(10);
    expect(m.vcount).toBe(12);
    expect(manifold(m)).toBe(true);
  });

  it('knife cuts faces crossed by a segment', () => {
    const { m } = cubeEdit();
    const project = (p: Vector3) => ({ x: p.x, y: p.y });
    // cut over the top face from the -X edge to the +X edge, seen from above
    knifeCut(m, null, new Vector3(-1, 0, 1), new Vector3(1, 0, 1), new Vector3(0, 0, -1), new Matrix4(), project, (_f, p) => p.z > 0.99);
    expect(m.faces.length).toBe(7);
    expect(m.vcount).toBe(10);
    expect(manifold(m)).toBe(true);
    expect(signedVolume(m)).toBeCloseTo(8, 5);
  });

  it('rips a grid along a selected edge row', () => {
    const me = newMeshData('Grid', prim.grid(4, 4));
    const m = MeshEdit.from(me);
    // middle row of vertices (y == 0) on a 5x5 vertex grid, excluding the border columns
    m.sel = m.sel.map((_, i) => (Math.abs(m.p(i)[1]) < 1e-6 && Math.abs(m.p(i)[0]) < 0.99 ? 1 : 0));
    const before = m.vcount;
    // faces with positive y are "nearest the mouse"
    const n = ripSelection(m, (f) => -m.faceCenter(m.faces[f])[1]);
    expect(n).toBe(3);
    expect(m.vcount).toBe(before + 3);
    // the three ripped vertices now belong only to faces above the row
    for (let v = before; v < m.vcount; v++) for (const f of m.faces) if (f.verts.includes(v)) expect(m.faceCenter(f)[1]).toBeGreaterThan(0);
  });

  it('packs islands inside the unit square', () => {
    const { m } = cubeEdit();
    packIslands(m, m.faces.map((_, i) => [i]), 0.01);
    for (const f of m.faces)
      for (const u of f.uvs) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
      }
  });
});
