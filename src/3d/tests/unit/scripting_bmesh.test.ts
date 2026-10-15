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
  ['bevel all vertices', 'const bm = cube(); const r = bmesh.ops.bevel(bm, {geom: [...bm.verts], offset: 0.3, segments: 1, affect: "VERTICES"}); print(cnt(bm), r.faces.length, r.edges.length, r.verts.length, bm.calc_volume(true).toFixed(3))', '24,36,14 8 24 24 7.964'],
  ['bevel all edges', 'const bm = cube(); const r = bmesh.ops.bevel(bm, {geom: [...bm.edges], offset: 0.2, segments: 1, affect: "EDGES"}); print(cnt(bm), r.faces.length, r.verts.length)', '24,48,26 20 24'],
  ['inset_region of part of a solid', 'const bm = cube(); bmesh.ops.inset_region(bm, {faces: [...bm.faces].slice(0, 3), thickness: 0.1, depth: -0.1}); print(cnt(bm), [...bm.edges].every((e) => e.is_manifold && e.is_contiguous))', '16,28,14 true'],
  ['spin faces all around', 'const bm = grid(1, 1); bmesh.ops.spin(bm, {geom: [...bm.faces], cent: [2, 0, 0], axis: [0, 1, 0], angle: 2 * Math.PI, steps: 8, use_merge: true}); print(cnt(bm), [...bm.edges].every((e) => e.is_manifold && e.is_contiguous))', '32,64,32 true'],
  ['grid_fill', 'const bm = cube(); bmesh.ops.delete(bm, {geom: top(bm), context: "FACES_ONLY"}); bmesh.ops.subdivide_edges(bm, {edges: [...bm.edges].filter((e) => e.is_boundary), cuts: 1}); const r = bmesh.ops.grid_fill(bm, {edges: [...bm.edges].filter((e) => e.is_boundary)}); print(cnt(bm), r.faces.length, [...bm.edges].every((e) => e.is_manifold && e.is_contiguous))', '13,20,9 4 true'],
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

describe('bmesh and mesh data-blocks', () => {
  it('round-trips a mesh keeping UVs, materials, smooth flags, seams, creases and vertex groups', () => {
    const me = mesh('Cube');
    me.uvs = Float32Array.from(me.uvs, (_, i) => (i % 7) / 10);
    me.material_index = Uint16Array.from({ length: 6 }, (_, i) => i % 3);
    me.smooth = Uint8Array.from({ length: 6 }, (_, i) => i & 1);
    me.seams = Uint32Array.from(me.indices, (_, i) => (i < 4 ? 1 : 0));
    me.vertex_groups = [{ name: 'Top' }];
    me.weights = [Float32Array.from({ length: 8 }, (_, i) => (me.positions[i * 3 + 2] > 0 ? 0.75 : 0))];
    me.color_attributes = [{ name: 'Col', domain: 'CORNER', data: Float32Array.from({ length: me.indices.length * 4 }, (_, i) => (i % 4) / 4) }];
    const before = structuredClone({ uvs: me.uvs, mat: me.material_index, smooth: me.smooth, idx: me.indices, w: me.weights[0], col: me.color_attributes[0].data });
    const out = run(`
      const me = D.meshes['Cube'];
      const bm = bmesh.new();
      bm.from_mesh(me);
      const dl = bm.verts.layers.deform.active;
      print(bm.verts.length, bm.faces.length, bm.loops.layers.uv.active.name, [...bm.edges].filter((e) => e.seam).length, [...bm.verts].filter((v) => v.getItem(dl).get(0) === 0.75).length);
      bm.to_mesh(me);
      bm.free();`);
    expect(out).toBe('8 6 UVMap 4 4');
    expect(Array.from(me.uvs)).toEqual(Array.from(before.uvs));
    expect(Array.from(me.material_index!)).toEqual(Array.from(before.mat));
    expect(Array.from(me.smooth!)).toEqual(Array.from(before.smooth));
    expect(Array.from(me.indices)).toEqual(Array.from(before.idx));
    expect(Array.from(me.weights[0])).toEqual(Array.from(before.w));
    expect(Array.from(me.color_attributes[0].data)).toEqual(Array.from(before.col));
    expect(Array.from(me.seams!).filter(Boolean).length).toBeGreaterThanOrEqual(4);
  });

  it('carries UVs and materials through operators', () => {
    const out = run(`
      const me = D.meshes['Cube'];
      const bm = bmesh.new();
      bm.from_mesh(me);
      const uv = bm.loops.layers.uv.active;
      for (const f of bm.faces) { f.material_index = 2; for (const l of f.loops) l.getItem(uv).uv = [0.25, 0.5]; }
      bmesh.ops.subdivide_edges(bm, {edges: [...bm.edges], cuts: 2, use_grid_fill: true});
      bmesh.ops.triangulate(bm, {faces: [...bm.faces]});
      const uvs = new Set(); for (const f of bm.faces) for (const l of f.loops) uvs.add(l[uv].uv.toArray().map((x) => x.toFixed(3)).join(','));
      print(bm.faces.length, [...bm.faces].every((f) => f.material_index === 2), [...uvs].join(' '));
      bm.to_mesh(me);`);
    expect(out).toBe('108 true 0.250,0.500');
    expect(counts(mesh('Cube'))).toEqual([56, 108]);
  });

  it('reads the evaluated mesh of an object', () => {
    const out = run(`
      const ob = D.objects['Cube'];
      const m = ob.modifiers.new('Sub', 'SUBSURF'); m.levels = 1;
      const bm = bmesh.new();
      bm.from_object(ob, C.evaluated_depsgraph_get());
      print(bm.verts.length, bm.faces.length);`);
    expect(out).toBe('26 24');
  });

  it('builds closed solids with outward normals', () => {
    const out = run(`
      const vol = (fn) => { const bm = bmesh.new(); fn(bm); const r = bm.calc_volume(true).toFixed(3); bm.free(); return r; };
      print(vol((bm) => bmesh.ops.create_cube(bm, {size: 2})));
      print(vol((bm) => bmesh.ops.create_uvsphere(bm, {u_segments: 32, v_segments: 16, radius: 1})));
      print(vol((bm) => bmesh.ops.create_icosphere(bm, {subdivisions: 3, radius: 1})));
      print(vol((bm) => bmesh.ops.create_cone(bm, {cap_ends: true, segments: 32, radius1: 1, radius2: 0.5, depth: 2})));
      print(vol((bm) => { bmesh.ops.create_cube(bm, {size: 2}); const t = [...bm.faces].filter((f) => f.normal.z > 0.5); const r = bmesh.ops.extrude_face_region(bm, {geom: t}); bmesh.ops.translate(bm, {vec: [0, 0, 1], verts: r.geom.filter((x) => x instanceof bmesh.types.BMVert)}); bmesh.ops.delete(bm, {geom: t, context: 'FACES'}); }));
      print(vol((bm) => { bmesh.ops.create_cube(bm, {size: 2}); bmesh.ops.reverse_faces(bm, {faces: [...bm.faces].slice(0, 3)}); bmesh.ops.recalc_face_normals(bm, {faces: [...bm.faces]}); }));`);
    expect(out.split('\n')).toEqual(['8.000', '4.122', '4.047', '3.642', '12.000', '8.000']);
  });
});

describe('bmesh elements', () => {
  it('give adjacency, measurements and readable output', () => {
    const out = run(PRELUDE + `
      const bm = cube();
      bm.verts.ensure_lookup_table(); bm.edges.ensure_lookup_table(); bm.faces.ensure_lookup_table();
      const v = bm.verts[0], e = bm.edges[0], f = bm.faces[0], l = f.loops[0];
      print(v.link_edges.length, v.link_faces.length, v.link_loops.length, v.is_manifold, v.is_boundary, v.calc_shell_factor().toFixed(3));
      print(e.calc_length(), e.calc_face_angle().toFixed(4), e.is_convex, e.is_contiguous, e.other_vert(e.verts[0]) === e.verts[1]);
      print(f.calc_area(), f.calc_perimeter(), f.calc_center_median().toArray(), f.normal.toArray());
      print(l.vert === f.verts[0], l.link_loop_next.link_loop_prev === l, l.link_loop_radial_next.edge === l.edge, l.calc_angle().toFixed(4));
      print(String(v), String(bm));`);
    expect(out.split('\n')).toEqual([
      '3 3 3 true false 1.732',
      '2 1.5708 true true true',
      '4 8 [-1, 0, 0] [-1, 0, 0]',
      'true true true 1.5708',
      '<BMVert(index=0, co=(-1, -1, -1))> <BMesh(totvert=8, totedge=12, totface=6, totloop=24)>',
    ]);
  });

  it('raise helpful errors', () => {
    const err = (code: string) => {
      try {
        run(PRELUDE + code);
        return 'no error';
      } catch (e) {
        return String((e as Error).message).split(' (line')[0];
      }
    };
    expect(err('const bm = cube(); bm.verts[0]')).toMatch(/IndexError: BMVertSeq\[index\]: outdated internal index table, run ensure_lookup_table\(\) first/);
    expect(err('const bm = cube(); bm.faces.new([...bm.faces][0].verts)')).toMatch(/ValueError: faces.new\(...\): face already exists/);
    expect(err('const bm = cube(); bm.edges.new([...bm.edges][0].verts)')).toMatch(/ValueError: edges.new\(\): this edge exists/);
    expect(err('const bm = cube(); const v = [...bm.verts][0]; bm.verts.remove(v); v.co')).toMatch(/ReferenceError: BMesh data of type BMVert has been removed/);
    expect(err('const bm = cube(); bmesh.ops.extrude(bm, {})')).toMatch(/AttributeError: bmesh.ops has no operator 'extrude'. Available: .*extrude_face_region/);
    expect(err('const bm = cube(); bmesh.ops.translate(bm, {vector: [1, 0, 0]})')).toMatch(/TypeError: bmesh.ops.translate\(\): unexpected keyword argument 'vector' \(expected: vec, space, verts, use_shape\)/);
    expect(err('const bm = cube(); bm.free(); bm.verts.length')).toMatch(/ReferenceError: BMesh data of type BMesh has been removed/);
  });

  it('keep custom data in layers', () => {
    const out = run(PRELUDE + `
      const bm = cube();
      const uv = bm.loops.layers.uv.new('Map');
      const col = bm.loops.layers.color.verify();
      const dl = bm.verts.layers.deform.verify();
      const fl = bm.verts.layers.float.new('weight');
      const v = [...bm.verts][0], l = [...bm.faces][0].loops[0];
      l[uv].uv = [0.5, 0.25]; l[uv].pin_uv = true;
      l[col] = [1, 0, 0, 1];
      v[dl].setItem(2, 0.5);
      v[fl] = 3.5;
      const c = bm.copy();
      const v2 = [...c.verts][0], l2 = [...c.faces][0].loops[0];
      const uv2 = c.loops.layers.uv.get('Map');
      print(l2[uv2].uv.toArray(), l2[uv2].pin_uv, l2[c.loops.layers.color.active].toArray(), v2[c.verts.layers.deform.active].items(), v2[c.verts.layers.float.get('weight')]);
      print(bm.loops.layers.uv.keys(), bm.loops.layers.uv.active.name, bm.verts.layers.deform.is_singleton);`);
    expect(out).toBe('[0.5, 0.25] true [1, 0, 0, 1] [[2, 0.5]] 3.5\n["Map"] Map true');
  });
});

describe('bmesh in Edit Mode', () => {
  it('edits the mesh of the object in Edit Mode and keeps Edit Mode working', () => {
    const out = run(`
      bpy.ops.object.mode_set({mode: 'EDIT'});
      const me = C.object.data;
      const bm = bmesh.from_edit_mesh(me);
      print(bm.verts.length, [...bm.verts].filter((v) => v.select).length, bmesh.from_edit_mesh(me) === bm, [...bm.select_mode]);
      for (const v of bm.verts) v.select = false;
      const t = [...bm.faces].filter((f) => f.normal.z > 0.5);
      const r = bmesh.ops.extrude_face_region(bm, {geom: t});
      const nv = r.geom.filter((x) => x instanceof bmesh.types.BMVert);
      bmesh.ops.translate(bm, {vec: [0, 0, 1], verts: nv});
      bmesh.ops.delete(bm, {geom: t, context: 'FACES'});
      for (const x of r.geom) x.select_set(true);
      bmesh.update_edit_mesh(me);
      print(C.mode, me.vertices.length, me.polygons.length, bmesh.from_edit_mesh(me) === bm);`);
    expect(out).toBe('8 8 true ["VERT"]\nEDIT_MESH 12 10 true');
    const me = mesh('Cube');
    expect(app.doc.mode).toBe('EDIT');
    expect(Array.from(me.select_vert!).filter(Boolean).length).toBe(4);
    expect(Math.max(...Array.from(me.positions).filter((_, i) => i % 3 === 2))).toBeCloseTo(2);
  });

  it('needs the mesh to be in Edit Mode', () => {
    expect(() => run(`bmesh.from_edit_mesh(C.object.data)`)).toThrow(/is not in Edit Mode/);
  });
});

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

  it('runs operators with keyword arguments and returns dicts', () => {
    if (!ok) return;
    const out = runPy(`
      import bpy, bmesh
      from mathutils import Matrix, Vector
      bm = bmesh.new()
      bmesh.ops.create_cube(bm, size=2, matrix=Matrix.Translation((0, 0, 1)))
      top = [f for f in bm.faces if f.normal.z > 0.5]
      ret = bmesh.ops.extrude_face_region(bm, geom=top)
      verts = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
      bmesh.ops.translate(bm, vec=Vector((0, 0, 1)), verts=verts)
      bmesh.ops.delete(bm, geom=top, context='FACES')
      print(type(ret).__name__, sorted(ret.keys()), len(ret.get('geom')), len(bm.verts), len(bm.faces), round(bm.calc_volume(), 3))
      r = bmesh.ops.triangulate(bm, faces=bm.faces[:])
      fm = r['face_map']
      print(type(fm).__name__, len(fm), all(isinstance(k, bmesh.types.BMFace) for k in fm))
      print(bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0001))
      try:
          bmesh.ops.extrude(bm, geom=[])
      except AttributeError as e:
          print('AttributeError', str(e)[:36])
      try:
          bmesh.ops.translate(bm, vector=(1, 0, 0))
      except TypeError as e:
          print('TypeError', str(e)[:60])
      me = bpy.data.meshes.new('Tower')
      bm.to_mesh(me)
      bm.free()
      print(len(me.vertices), len(me.polygons))
    `);
    expect(out.split('\n')).toEqual([
      "dict ['geom'] 9 12 10 12.0",
      'dict 20 True',
      'None',
      "AttributeError bmesh.ops has no operator 'extrude'.",
      "TypeError bmesh.ops.translate(): unexpected keyword argument 'vector' ",
      '12 20',
    ]);
  });

  it('reads and writes layers, vertex groups and the lookup table', () => {
    if (!ok) return;
    const out = runPy(`
      import bmesh
      bm = bmesh.new()
      bmesh.ops.create_grid(bm, x_segments=2, y_segments=2, size=1)
      uv = bm.loops.layers.uv.verify()
      deform = bm.verts.layers.deform.verify()
      for f in bm.faces:
          for l in f.loops:
              l[uv].uv = (l.vert.co.x * 0.5 + 0.5, l.vert.co.y * 0.5 + 0.5)
      for v in bm.verts:
          v[deform][0] = 1.0 if v.co.x > 0 else 0.25
      bm.verts.ensure_lookup_table()
      v = bm.verts[0]
      dv = v[deform]
      print(dict(dv), len(dv), 0 in dv, 1 in dv, dv.get(1, 'none'), list(dv.keys()))
      del dv[0]
      print(len(v[deform]))
      l = bm.faces[:][0].loops[0]
      print(tuple(round(x, 2) for x in l[uv].uv), l[uv].pin_uv, uv.name, bm.loops.layers.uv.active.name)
      bm.verts.sort(key=lambda v: (v.co.y, -v.co.x))
      print([round(v.co.x) for v in bm.verts][:3], [v.index for v in bm.verts][:3])
      try:
          bm.verts[0]
      except IndexError as e:
          print('IndexError', 'ensure_lookup_table' in str(e))
      bm.verts.ensure_lookup_table()
      print(round(bm.verts[0].co.x), bm.verts[-1].co.y)
      e = bm.edges.get((bm.verts[0], bm.verts[1]))
      print(isinstance(e, bmesh.types.BMEdge), bm.edges.get((bm.verts[0], bm.verts[8])))
      bm.select_history.add(bm.verts[4])
      print(len(bm.select_history), bm.select_history.active == bm.verts[4])
    `);
    expect(out.split('\n')).toEqual([
      '{0: 0.25} 1 True False none [0]',
      '0',
      '(0.0, 0.0) False UVMap UVMap',
      '[1, 0, -1] [0, 1, 2]',
      'IndexError True',
      '1 1.0',
      'True None',
      '1 True',
    ]);
  });

  it('supports element methods with keyword arguments, selection and colors', () => {
    if (!ok) return;
    const out = runPy(`
      import bmesh
      bm = bmesh.new()
      bmesh.ops.create_cube(bm, size=2)
      bm.faces.ensure_lookup_table()
      f = bm.faces[0]
      c = f.copy(verts=False, edges=False)
      print(len(bm.faces), len(bm.verts), c.verts[0] == f.verts[0])
      bm.faces.remove(c)
      f.select_set(True)
      print(sum(v.select for v in bm.verts), sum(e.select for e in bm.edges))
      for v in bm.verts:
          v.select = True
      bm.select_flush(True)
      print(all(f.select for f in bm.faces))
      col = bm.loops.layers.color.new('Paint')
      for face in bm.faces:
          for l in face.loops:
              l[col] = (1.0, 0.5, 0.0, 1.0)
      print(tuple(f.loops[0][col]), bm.loops.layers.float_color.active.name)
      e = f.edges[0]
      print(round(e.calc_face_angle(fallback=-1), 4), e.other_vert(e.verts[0]) == e.verts[1], f.verts[0].calc_edge_angle(fallback=-1))
      bm.faces.active = f
      print(bm.faces.active == f, len(bm.calc_loop_triangles()))
    `);
    expect(out.split('\n')).toEqual(['7 8 True', '4 4', 'True', '(1.0, 0.5, 0.0, 1.0) Paint', '1.5708 True -1', 'True 12']);
  });

  it('edits the mesh in Edit Mode and offers utils and geometry', () => {
    if (!ok) return;
    const out = runPy(`
      import bpy, bmesh
      bpy.ops.object.mode_set(mode='EDIT')
      me = bpy.context.object.data
      bm = bmesh.from_edit_mesh(me)
      bm.faces.ensure_lookup_table()
      f = bm.faces[0]
      a, b = f.verts[0], f.verts[2]
      nf, nl = bmesh.utils.face_split(f, a, b)
      print(len(bm.faces), isinstance(nf, bmesh.types.BMFace), isinstance(nl, bmesh.types.BMLoop))
      ne, nv = bmesh.utils.edge_split(nl.edge, a, 0.5)
      print(len(bm.verts), tuple(round(x, 2) for x in nv.co) == tuple(round(x, 2) for x in (a.co + b.co) / 2))
      bm.faces.ensure_lookup_table()
      print(bmesh.geometry.intersect_face_point(bm.faces[1], bm.faces[1].calc_center_median()))
      bmesh.update_edit_mesh(me)
      print(bpy.context.mode, len(me.vertices), len(me.polygons))
    `);
    expect(out.split('\n')).toEqual(['7 True True', '9 True', 'True', 'EDIT_MESH 9 7']);
  });
});
