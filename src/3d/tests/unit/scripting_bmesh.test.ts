// @vitest-environment happy-dom
// bmesh for scripts: building meshes, mesh round trips, operators, Edit Mode, Python access.
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/object';
import '../../src/scripting/bmesh';
import { runJavaScript, output } from '../../src/scripting/runner';
import { pythonAvailable, runPy } from './support/python';
import type { MeshData } from '../../src/data/types';

/** Runs a JavaScript script and returns what it printed; fails the test on an error. */
function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}
const mesh = (name: string) => Object.values(app.doc.meshes).find((m) => m.name === name) as MeshData;
const counts = (me: MeshData) => [me.positions.length / 3, me.offsets.length - 1];

beforeEach(() => setApp(new App(startupDocument())));

describe('bmesh in JavaScript', () => {
  it('builds a mesh from scratch and writes it to an object', () => {
    const out = run(`
      const bm = bmesh.new();
      const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((c) => bm.verts.new(c));
      const f = bm.faces.new(v);
      print(bm.verts.length, bm.edges.length, bm.faces.length, f.normal.z);
      const me = D.meshes.new('Built');
      bm.to_mesh(me);
      bm.free();
      const ob = D.objects.new('Built', me);
      C.collection.objects.link(ob);
      print(me.vertices.length, me.polygons.length)`);
    expect(out).toBe('4 4 1 1\n4 1');
    expect(counts(mesh('Built'))).toEqual([4, 1]);
  });

  it('creates primitives with the expected element counts', () => {
    const out = run(`
      const c = (fn) => { const bm = bmesh.new(); fn(bm); const r = [bm.verts.length, bm.edges.length, bm.faces.length].join(','); bm.free(); return r; };
      print(c((bm) => bmesh.ops.create_cube(bm, {size: 2})));
      print(c((bm) => bmesh.ops.create_grid(bm, {x_segments: 3, y_segments: 3, size: 1})));
      print(c((bm) => bmesh.ops.create_circle(bm, {segments: 8, radius: 1})));
      print(c((bm) => bmesh.ops.create_circle(bm, {cap_ends: true, cap_tris: true, segments: 8, radius: 1})));
      print(c((bm) => bmesh.ops.create_cone(bm, {segments: 8, radius1: 1, radius2: 0, depth: 2})));
      print(c((bm) => bmesh.ops.create_cone(bm, {cap_ends: true, cap_tris: true, segments: 8, radius1: 1, radius2: 1, depth: 2})));
      print(c((bm) => bmesh.ops.create_uvsphere(bm, {u_segments: 32, v_segments: 16, radius: 1})));
      print(c((bm) => bmesh.ops.create_icosphere(bm, {subdivisions: 3, radius: 1})));`);
    expect(out.split('\n')).toEqual(['8,12,6', '16,24,9', '8,8,0', '9,16,8', '9,16,8', '18,40,24', '482,992,512', '162,480,320']);
  });
});

const PRELUDE = `
const cube = () => { const bm = bmesh.new(); bmesh.ops.create_cube(bm, {size: 2}); return bm; };
const grid = (x, y) => { const bm = bmesh.new(); bmesh.ops.create_grid(bm, {x_segments: x, y_segments: y, size: 1}); return bm; };
const top = (bm) => [...bm.faces].filter((f) => f.normal.z > 0.5);
const cnt = (bm) => [bm.verts.length, bm.edges.length, bm.faces.length].join(',');
const all = (bm) => [...bm.verts, ...bm.edges, ...bm.faces];
`;

// element counts after operators (verified against an independent implementation of the same API)
const OPS: [string, string, string][] = [
  ['extrude_face_region (faces only: the originals stay, flipped)', 'const bm = cube(); const r = bmesh.ops.extrude_face_region(bm, {geom: top(bm)}); print(cnt(bm), r.geom.length)', '12,20,11 9'],
  ['extrude_face_region with edges (originals removed)', 'const bm = cube(); const t = top(bm)[0]; bmesh.ops.extrude_face_region(bm, {geom: [t, ...t.edges]}); print(cnt(bm), t.is_valid)', '12,20,10 false'],
  ['extrude_face_region of a closed mesh', 'const bm = cube(); const r = bmesh.ops.extrude_face_region(bm, {geom: [...bm.faces]}); print(cnt(bm), r.geom.length)', '16,24,12 26'],
  ['extrude_face_region of a plane', 'const bm = grid(1, 1); bmesh.ops.extrude_face_region(bm, {geom: [...bm.faces]}); print(cnt(bm))', '8,12,6'],
  ['extrude_face_region of part of a grid', 'const bm = grid(2, 2); bmesh.ops.extrude_face_region(bm, {geom: [...bm.faces].slice(0, 3)}); print(cnt(bm))', '17,30,15'],
  ['extrude_edge_only', 'const bm = cube(); const r = bmesh.ops.extrude_edge_only(bm, {edges: top(bm)[0].edges}); print(cnt(bm), r.geom.length)', '12,20,10 12'],
  ['extrude_vert_indiv', 'const bm = cube(); const r = bmesh.ops.extrude_vert_indiv(bm, {verts: [...bm.verts]}); print(cnt(bm), r.verts.length, r.edges.length)', '16,20,6 8 8'],
  ['extrude_discrete_faces', 'const bm = cube(); const r = bmesh.ops.extrude_discrete_faces(bm, {faces: [...bm.faces]}); print(cnt(bm), r.faces.length)', '32,60,30 6'],
  ['delete VERTS', 'const bm = cube(); bmesh.ops.delete(bm, {geom: [[...bm.verts][0]], context: "VERTS"}); print(cnt(bm))', '7,9,3'],
  ['delete EDGES', 'const bm = cube(); bmesh.ops.delete(bm, {geom: [top(bm)[0].edges[0]], context: "EDGES"}); print(cnt(bm))', '8,11,4'],
  ['delete EDGES of a wire', 'const bm = bmesh.new(); const v = [0, 1, 2].map((x) => bm.verts.new([x, 0, 0])); const e = bm.edges.new([v[0], v[1]]); bm.edges.new([v[1], v[2]]); bmesh.ops.delete(bm, {geom: [e], context: "EDGES"}); print(cnt(bm))', '2,1,0'],
  ['delete FACES_ONLY', 'const bm = cube(); bmesh.ops.delete(bm, {geom: top(bm), context: "FACES_ONLY"}); print(cnt(bm))', '8,12,5'],
  ['delete FACES', 'const bm = grid(2, 2); bmesh.ops.delete(bm, {geom: [...bm.faces].slice(0, 1), context: "FACES"}); print(cnt(bm))', '8,10,3'],
  ['delete FACES (all)', 'const bm = grid(2, 2); bmesh.ops.delete(bm, {geom: [...bm.faces], context: "FACES"}); print(cnt(bm))', '0,0,0'],
  ['delete FACES_KEEP_BOUNDARY', 'const bm = grid(2, 2); bmesh.ops.delete(bm, {geom: [...bm.faces], context: "FACES_KEEP_BOUNDARY"}); print(cnt(bm))', '8,8,0'],
  ['delete TAGGED_ONLY', 'const bm = cube(); bmesh.ops.delete(bm, {geom: [top(bm)[0].edges[0]], context: "TAGGED_ONLY"}); print(cnt(bm))', '8,11,4'],
  ['duplicate', 'const bm = cube(); const r = bmesh.ops.duplicate(bm, {geom: top(bm)}); print(cnt(bm), r.geom.length, r.vert_map.size, r.face_map.size)', '12,16,7 9 8 2'],
  ['split', 'const bm = cube(); const r = bmesh.ops.split(bm, {geom: top(bm)}); print(cnt(bm), r.geom.length)', '12,16,6 9'],
  ['remove_doubles', 'const bm = cube(); bmesh.ops.duplicate(bm, {geom: all(bm)}); print(cnt(bm)); bmesh.ops.remove_doubles(bm, {verts: [...bm.verts], dist: 0.001}); print(cnt(bm))', '16,24,12\n8,12,6'],
  ['find_doubles', 'const bm = cube(); print(bmesh.ops.find_doubles(bm, {verts: [...bm.verts], dist: 3}).targetmap.size)', '6'],
  ['subdivide_edges with grid fill', 'const bm = cube(); bmesh.ops.subdivide_edges(bm, {edges: [...bm.edges], cuts: 1, use_grid_fill: true}); print(cnt(bm))', '26,48,24'],
  ['subdivide_edges, 2 cuts', 'const bm = cube(); bmesh.ops.subdivide_edges(bm, {edges: [...bm.edges], cuts: 2, use_grid_fill: true}); print(cnt(bm))', '56,108,54'],
  ['subdivide_edges without grid fill', 'const bm = cube(); bmesh.ops.subdivide_edges(bm, {edges: [...bm.edges], cuts: 1}); print(cnt(bm))', '20,24,6'],
  ['subdivide_edges, opposite sides', 'const bm = cube(); const e = top(bm)[0].edges; bmesh.ops.subdivide_edges(bm, {edges: [e[0], e[2]], cuts: 2}); print(cnt(bm))', '12,18,8'],
  ['subdivide_edges, adjacent sides', 'const bm = cube(); const e = top(bm)[0].edges; bmesh.ops.subdivide_edges(bm, {edges: [e[0], e[1]], cuts: 1}); print(cnt(bm))', '10,15,7'],
  ['subdivide_edges of an icosahedron (triangle grid)', 'const bm = bmesh.new(); bmesh.ops.create_icosphere(bm, {subdivisions: 1, radius: 1}); bmesh.ops.subdivide_edges(bm, {edges: [...bm.edges], cuts: 1, use_grid_fill: true}); print(cnt(bm))', '42,120,80'],
  ['triangulate', 'const bm = cube(); const r = bmesh.ops.triangulate(bm, {faces: [...bm.faces]}); print(cnt(bm), r.faces.length, r.edges.length, r.face_map.size)', '8,18,12 12 6 12'],
  ['poke', 'const bm = cube(); const r = bmesh.ops.poke(bm, {faces: [...bm.faces]}); print(cnt(bm), r.verts.length, r.faces.length)', '14,36,24 6 24'],
  ['inset_individual', 'const bm = cube(); const r = bmesh.ops.inset_individual(bm, {faces: top(bm), thickness: 0.2, depth: 0.1}); print(cnt(bm), r.faces.length, r.faces[0].calc_area().toFixed(3))', '12,20,10 4 0.322'],
  ['inset_region', 'const bm = cube(); const r = bmesh.ops.inset_region(bm, {faces: top(bm), thickness: 0.2, depth: 0.1}); print(cnt(bm), r.faces.length, [...bm.verts].filter((v) => Math.abs(v.co.z - 1.1) < 1e-6).length)', '12,20,10 4 4'],
  ['inset_region of a closed mesh', 'const bm = cube(); const r = bmesh.ops.inset_region(bm, {faces: [...bm.faces], thickness: 0.2}); print(cnt(bm), r.faces.length)', '8,12,6 0'],
  ['bevel one edge', 'const bm = cube(); const r = bmesh.ops.bevel(bm, {geom: [[...bm.edges][0]], offset: 0.2, segments: 1, affect: "EDGES"}); print(cnt(bm), r.faces.length, r.verts.length)', '10,15,7 1 4'],
  ['bevel one edge, 3 segments', 'const bm = cube(); const r = bmesh.ops.bevel(bm, {geom: [[...bm.edges][0]], offset: 0.2, segments: 3, affect: "EDGES"}); print(cnt(bm), r.faces.length)', '14,21,9 3'],
  ['bevel a vertex', 'const bm = cube(); const r = bmesh.ops.bevel(bm, {geom: [[...bm.verts][0]], offset: 0.2, segments: 1, affect: "VERTICES"}); print(cnt(bm), r.faces.length)', '10,15,7 1'],
  ['bridge_loops', 'const bm = bmesh.new(); bmesh.ops.create_circle(bm, {segments: 8, radius: 1}); bmesh.ops.create_circle(bm, {segments: 8, radius: 1, matrix: mathutils.Matrix.Translation([0, 0, 2])}); const r = bmesh.ops.bridge_loops(bm, {edges: [...bm.edges]}); print(cnt(bm), r.faces.length, r.edges.length)', '16,24,8 8 8'],
  ['holes_fill', 'const bm = cube(); bmesh.ops.delete(bm, {geom: top(bm), context: "FACES_ONLY"}); const r = bmesh.ops.holes_fill(bm, {edges: [...bm.edges], sides: 4}); print(cnt(bm), r.faces[0].normal.z)', '8,12,6 1'],
  ['holes_fill (too many sides)', 'const bm = cube(); bmesh.ops.delete(bm, {geom: top(bm), context: "FACES_ONLY"}); print(bmesh.ops.holes_fill(bm, {edges: [...bm.edges], sides: 3}).faces.length)', '0'],
  ['contextual_create closes a hole', 'const bm = cube(); bmesh.ops.delete(bm, {geom: top(bm), context: "FACES_ONLY"}); const r = bmesh.ops.contextual_create(bm, {geom: [...bm.verts].filter((v) => v.co.z > 0)}); print(cnt(bm), r.faces[0].normal.z)', '8,12,6 1'],
  ['contextual_create from loose verts', 'const bm = bmesh.new(); const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((c) => bm.verts.new(c)); bmesh.ops.contextual_create(bm, {geom: v}); print(cnt(bm))', '4,4,1'],
  ['contextual_create makes an edge', 'const bm = bmesh.new(); const v = [[0, 0, 0], [1, 0, 0]].map((c) => bm.verts.new(c)); print(bmesh.ops.contextual_create(bm, {geom: v}).edges.length, cnt(bm))', '1 2,1,0'],
  ['dissolve_faces', 'const bm = cube(); bmesh.ops.dissolve_faces(bm, {faces: [...bm.faces].filter((f) => f.normal.z > 0.5 || f.normal.x > 0.5)}); print(cnt(bm))', '8,11,5'],
  ['dissolve_faces of a grid', 'const bm = grid(2, 2); bmesh.ops.dissolve_faces(bm, {faces: [...bm.faces]}); print(cnt(bm))', '8,8,1'],
  ['dissolve_faces with use_verts', 'const bm = grid(2, 2); bmesh.ops.dissolve_faces(bm, {faces: [...bm.faces], use_verts: true}); print(cnt(bm))', '4,4,1'],
  ['dissolve_verts (inner)', 'const bm = grid(2, 2); bmesh.ops.dissolve_verts(bm, {verts: [...bm.verts].filter((v) => v.co.length < 0.01)}); print(cnt(bm))', '8,8,1'],
  ['dissolve_verts (boundary)', 'const bm = grid(2, 2); bmesh.ops.dissolve_verts(bm, {verts: [...bm.verts].filter((v) => Math.abs(v.co.x) < 0.01 && v.co.y < -0.5)}); print(cnt(bm))', '8,10,3'],
  ['dissolve_edges', 'const bm = grid(2, 2); bmesh.ops.dissolve_edges(bm, {edges: [...bm.edges].filter((e) => !e.is_boundary)}); print(cnt(bm))', '8,8,1'],
  ['dissolve_edges with use_verts', 'const bm = grid(2, 2); bmesh.ops.dissolve_edges(bm, {edges: [...bm.edges].filter((e) => !e.is_boundary), use_verts: true}); print(cnt(bm))', '4,4,1'],
  ['dissolve_limit', 'const bm = cube(); bmesh.ops.subdivide_edges(bm, {edges: [...bm.edges], cuts: 1, use_grid_fill: true}); bmesh.ops.dissolve_limit(bm, {angle_limit: 0.1, verts: [...bm.verts], edges: [...bm.edges]}); print(cnt(bm))', '8,12,6'],
  ['join_triangles', 'const bm = cube(); bmesh.ops.triangulate(bm, {faces: [...bm.faces]}); bmesh.ops.join_triangles(bm, {faces: [...bm.faces], angle_face_threshold: 0.1, angle_shape_threshold: 3.14}); print(cnt(bm))', '8,12,6'],
  ['convex_hull', 'const bm = cube(); const r = bmesh.ops.convex_hull(bm, {input: [...bm.verts], use_existing_faces: false}); print(cnt(bm), r.geom.length)', '8,18,18 38'],
  ['solidify', 'const bm = grid(1, 1); const r = bmesh.ops.solidify(bm, {geom: [...bm.faces], thickness: 0.1}); print(cnt(bm), r.geom.length, [...bm.verts].filter((v) => Math.abs(v.co.z + 0.1) < 1e-6).length)', '8,12,6 9 4'],
  ['split_edges', 'const bm = cube(); const r = bmesh.ops.split_edges(bm, {edges: top(bm)[0].edges}); print(cnt(bm), r.edges.length)', '12,16,6 8'],
  ['split_edges (one edge)', 'const bm = cube(); const r = bmesh.ops.split_edges(bm, {edges: [top(bm)[0].edges[0]]}); print(cnt(bm), r.edges.length)', '8,12,6 1'],
  ['connect_verts', 'const bm = cube(); const t = top(bm)[0]; const r = bmesh.ops.connect_verts(bm, {verts: [t.verts[0], t.verts[2]]}); print(cnt(bm), r.edges.length)', '8,13,7 1'],
  ['bisect_plane', 'const bm = cube(); const r = bmesh.ops.bisect_plane(bm, {geom: all(bm), plane_co: [0, 0, 0], plane_no: [0, 0, 1]}); print(cnt(bm), r.geom_cut.length)', '12,20,10 8'],
  ['bisect_plane clearing one side', 'const bm = cube(); bmesh.ops.bisect_plane(bm, {geom: all(bm), plane_co: [0, 0, 0], plane_no: [0, 0, 1], clear_inner: true}); print(cnt(bm))', '8,12,5'],
  ['collapse', 'const bm = cube(); bmesh.ops.collapse(bm, {edges: [top(bm)[0].edges[0]]}); print(cnt(bm))', '7,11,6'],
  ['pointmerge', 'const bm = cube(); bmesh.ops.pointmerge(bm, {verts: top(bm)[0].verts, merge_co: [0, 0, 1]}); print(cnt(bm))', '5,8,5'],
  ['rotate_edges', 'const bm = cube(); const r = bmesh.ops.rotate_edges(bm, {edges: [[...bm.edges][0]]}); print(cnt(bm), r.edges.length)', '8,12,6 1'],
  ['spin edges', 'const bm = cube(); const e = top(bm)[0].edges[0]; const r = bmesh.ops.spin(bm, {geom: [e, ...e.verts], cent: [0, 0, 0], axis: [0, 0, 1], angle: Math.PI, steps: 4}); print(cnt(bm), r.geom_last.length)', '16,24,10 3'],
  ['spin a ring into a torus', 'const bm = bmesh.new(); bmesh.ops.create_circle(bm, {segments: 8, radius: 1}); bmesh.ops.rotate(bm, {verts: [...bm.verts], cent: [0, 0, 0], matrix: mathutils.Matrix.Rotation(Math.PI / 2, 3, "X")}); bmesh.ops.translate(bm, {verts: [...bm.verts], vec: [2, 0, 0]}); bmesh.ops.spin(bm, {geom: [...bm.verts, ...bm.edges], cent: [0, 0, 0], axis: [0, 0, 1], angle: 2 * Math.PI, steps: 12, use_merge: true}); print(cnt(bm))', '96,192,96'],
  ['spin with duplicates', 'const bm = bmesh.new(); bmesh.ops.create_circle(bm, {segments: 8, radius: 1}); bmesh.ops.translate(bm, {verts: [...bm.verts], vec: [2, 0, 0]}); const r = bmesh.ops.spin(bm, {geom: [...bm.verts, ...bm.edges], cent: [0, 0, 0], axis: [0, 0, 1], angle: Math.PI, steps: 3, use_duplicate: true}); print(cnt(bm), r.geom_last.length)', '32,32,0 16'],
  ['spin faces', 'const bm = grid(1, 1); const r = bmesh.ops.spin(bm, {geom: [...bm.faces], cent: [2, 0, 0], axis: [0, 1, 0], angle: Math.PI, steps: 4}); print(cnt(bm), r.geom_last.length)', '20,36,18 9'],
  ['mirror', 'const bm = cube(); bmesh.ops.translate(bm, {verts: [...bm.verts], vec: [1, 0, 0]}); bmesh.ops.mirror(bm, {geom: all(bm), axis: "X", merge_dist: 0.001}); print(cnt(bm))', '12,20,11'],
];

describe('bmesh.ops', () => {
  for (const [name, code, expected] of OPS) it(name, () => expect(run(PRELUDE + code)).toBe(expected));
});

describe('bmesh in Python', () => {
  let ok = false;
  beforeAll(async () => {
    ok = await pythonAvailable();
  }, 60000);

  it('hashes elements and checks types', () => {
    if (!ok) return;
    const out = runPy(`
      import bmesh
      bm = bmesh.new()
      bmesh.ops.create_cube(bm, size=2)
      idx = {v: i for i, v in enumerate(bm.verts)}
      print(len(idx), len(set(bm.edges)), isinstance(bm.verts[:][0], bmesh.types.BMVert), isinstance(bm, bmesh.types.BMesh))
      bm.verts.ensure_lookup_table()
      print(idx[bm.verts[3]], bm.verts[3] in bm.verts, repr(bm.verts[0])[:15])
    `);
    expect(out).toBe('8 12 True True\n3 True <BMVert(index=0');
  });
});
