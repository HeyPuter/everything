// Additional modifiers: Bevel, Boolean, Decimate, Remesh, Weighted Normal.
// Bevel reuses the Edit Mode bevel; Remesh reuses the sculpt voxel remesher; Boolean uses the
// MIT-licensed three-bvh-csg library; Decimate and Weighted Normal are implemented here.
import { BufferGeometry, Float32BufferAttribute, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import type { DocumentData, MeshData, ModifierBase } from '../data/types';
import { physicsDoc } from '../physics/state';
import type { EvalMesh, ModifierContext } from './types';
import { registerModifier } from './modifiers';
import { modifierFields } from '../editors/properties/stack';
import { buildMesh, edgeTopology, triangulatePoly, type PolyFace } from '../mesh/mesh';
import { MeshEdit, edgeKey } from '../modes/editmesh/meshedit';
import { bevelEdges } from '../modes/editmesh/bevel';
import { bevelMeshVertices } from './mods/vbevel';
import { voxelRemesh } from '../paint/remesh';
import { unsubdivide } from './mods/multires';
import { currentCornerNormals } from './mods/normals';
import { gridRemesh } from './mods/remesh';

const num = (m: ModifierBase, k: string, d = 0) => (typeof m[k] === 'number' ? (m[k] as number) : d);
const bool = (m: ModifierBase, k: string, d = false) => (typeof m[k] === 'boolean' ? (m[k] as boolean) : d);
const str = (m: ModifierBase, k: string, d = '') => (typeof m[k] === 'string' ? (m[k] as string) : d);
const base = (o: Record<string, unknown>) => () => ({ show_viewport: true, show_render: true, show_in_editmode: false, show_on_cage: false, show_expanded: true, ...o });

// ---------------------------------------------------------------------------
// helpers

/** Triangulate one polygon; returns vertex ids (triangulatePoly itself yields local corner indices). */
function triangleVerts(positions: ArrayLike<number>, verts: number[]): number[] {
  const local: number[] = [];
  triangulatePoly(positions, verts, local, 0);
  return local.map((i) => verts[i]);
}

function toMeshEdit(m: EvalMesh): MeshEdit {
  const fake = {
    positions: m.positions,
    offsets: m.offsets,
    indices: m.indices,
    uvs: m.uvs,
    smooth: m.smooth,
    material_index: m.material_index,
    seams: m.seams,
    sharp: m.sharp,
    creases: m.creases,
    weights: m.weights ?? [],
    shape_keys: [],
    color_attributes: [],
  } as unknown as MeshData;
  return MeshEdit.from(fake);
}

function faceNormal(P: ArrayLike<number>, idx: ArrayLike<number>, s: number, e: number): Vector3 {
  const n = new Vector3();
  for (let c = s; c < e; c++) {
    const a = idx[c] * 3,
      b = idx[c + 1 < e ? c + 1 : s] * 3;
    n.x += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
    n.y += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
    n.z += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Bevel

function bevelMod(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const offsetType = str(mod, 'offset_type', 'OFFSET') as 'OFFSET' | 'WIDTH' | 'DEPTH' | 'PERCENT' | 'ABSOLUTE';
  const width = offsetType === 'PERCENT' ? num(mod, 'width_pct', 0.1) : num(mod, 'width', 0.1);
  if (width <= 0) return m;
  const e = toMeshEdit(m);
  const limit = str(mod, 'limit_method', 'ANGLE');
  const angle = num(mod, 'angle_limit', (30 * Math.PI) / 180);
  const segments = Math.max(1, Math.round(num(mod, 'segments', 1)));
  const profile = num(mod, 'profile', 0.5);
  // vertex group limit: only vertices with weight in the group (or outside it when inverted)
  let inGroup: ((v: number) => boolean) | null = null;
  if (limit === 'VGROUP') {
    const gi = m.vertex_groups?.findIndex((g) => g.name === str(mod, 'vertex_group')) ?? -1;
    const w = gi >= 0 ? m.weights?.[gi] : undefined;
    const inv = bool(mod, 'invert_vertex_group');
    inGroup = (v) => ((w?.[v] ?? 0) > 0) !== inv;
  }
  const before = new Set(e.faces);
  if (str(mod, 'affect', 'EDGES') === 'VERTICES') {
    const off = offsetType === 'PERCENT' ? (width / 100) * averageEdgeLength(m) : width;
    return bevelMeshVertices(m, (v) => !inGroup || inGroup(v), off, segments, profile, Math.round(num(mod, 'material', -1)));
  } else {
    const ef = e.edgeFaces();
    const chosen: [number, number][] = [];
    for (const [a, b] of e.edges()) {
      if (limit === 'ANGLE') {
        const fs = ef.get(edgeKey(a, b)) ?? [];
        if (fs.length !== 2) continue;
        const n0 = new Vector3(...(e.faceNormal(e.faces[fs[0][0]]) as [number, number, number])),
          n1 = new Vector3(...(e.faceNormal(e.faces[fs[1][0]]) as [number, number, number]));
        if (n0.angleTo(n1) < angle) continue;
      } else if (inGroup && !(inGroup(a) && inGroup(b))) continue;
      chosen.push([a, b]);
    }
    if (!chosen.length) return m;
    e.sel = e.sel.map(() => 0);
    for (const [a, b] of chosen) e.sel[a] = e.sel[b] = 1;
    const keys = new Set(chosen.map(([a, b]) => edgeKey(a, b)));
    // restrict the bevel to exactly the chosen edges (not every edge between selected vertices)
    e.selectedEdges = () => e.edges().filter(([a, b]) => keys.has(edgeKey(a, b)));
    const ok = bevelEdges(e, width, segments, profile, {
      offsetType,
      clamp: bool(mod, 'use_clamp_overlap', true),
      markSeam: bool(mod, 'mark_seam'),
      markSharp: bool(mod, 'mark_sharp'),
      harden: bool(mod, 'harden_normals'),
    });
    if (!ok) return m;
  }
  const mat = Math.round(num(mod, 'material', -1));
  if (mat >= 0) for (const f of e.faces) if (!before.has(f)) f.material = mat;
  return fromMeshEditFull(e, m);
}

function averageEdgeLength(m: EvalMesh): number {
  const et = edgeTopology(m);
  let sum = 0;
  for (let e = 0; e < et.count; e++) {
    const a = et.verts[e * 2] * 3,
      b = et.verts[e * 2 + 1] * 3;
    sum += Math.hypot(m.positions[a] - m.positions[b], m.positions[a + 1] - m.positions[b + 1], m.positions[a + 2] - m.positions[b + 2]);
  }
  return et.count ? sum / et.count : 0;
}

/** Convert an edited mesh back, keeping custom normals and seams/sharp flags. */
function fromMeshEditFull(e: MeshEdit, src: EvalMesh): EvalMesh {
  const me = { positions: src.positions, offsets: src.offsets, indices: src.indices, uvs: src.uvs, weights: [], vertex_groups: [], shape_keys: [], color_attributes: [], active_color_index: 0 } as unknown as MeshData;
  e.write(me);
  return {
    positions: me.positions,
    offsets: me.offsets,
    indices: me.indices,
    uvs: me.uvs,
    normals: me.normals,
    smooth: me.smooth,
    material_index: me.material_index,
    seams: me.seams,
    sharp: me.sharp,
    creases: me.creases,
    custom_normals: me.custom_normals,
    weights: me.weights.length ? me.weights : undefined,
    vertex_groups: src.vertex_groups,
    auto_smooth_angle: src.auto_smooth_angle,
  };
}

// ---------------------------------------------------------------------------
// Boolean

function toBrush(m: EvalMesh, matrix?: Matrix4): Brush {
  const pos: number[] = [],
    uv: number[] = [];
  const g = new BufferGeometry();
  const groups: { start: number; count: number; mat: number }[] = [];
  const nf = m.offsets.length - 1;
  const tri: number[] = [];
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    tri.length = 0;
    tri.push(...triangleVerts(m.positions, Array.from(m.indices.subarray(s, e))));
    const mat = m.material_index?.[f] ?? 0;
    for (let t = 0; t < tri.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = tri[t + k];
        // find the corner of this vertex in the face for its UV
        let c = s;
        for (let q = s; q < e; q++) if (m.indices[q] === vi) c = q;
        pos.push(m.positions[vi * 3], m.positions[vi * 3 + 1], m.positions[vi * 3 + 2]);
        uv.push(m.uvs[c * 2] ?? 0, m.uvs[c * 2 + 1] ?? 0);
      }
      const last = groups[groups.length - 1];
      if (last && last.mat === mat) last.count += 3;
      else groups.push({ start: pos.length / 3 - 3, count: 3, mat });
    }
  }
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.mat);
  const mats = Array.from({ length: Math.max(1, ...groups.map((x) => x.mat + 1)) }, () => new MeshBasicMaterial());
  const b = new Brush(g, mats);
  if (matrix) b.applyMatrix4(matrix);
  b.updateMatrixWorld(true);
  return b;
}

/** Weld a triangle soup (three.js non-indexed geometry) into an EvalMesh. */
function fromTriangles(g: BufferGeometry, materialOf: (tri: number) => number): EvalMesh {
  const P = g.getAttribute('position'),
    UV = g.getAttribute('uv');
  const map = new Map<string, number>();
  const positions: number[] = [];
  const faces: PolyFace[] = [];
  const q = (v: number) => Math.round(v * 1e5);
  const vid = (i: number) => {
    const x = P.getX(i),
      y = P.getY(i),
      z = P.getZ(i);
    const k = `${q(x)},${q(y)},${q(z)}`;
    let id = map.get(k);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(x, y, z);
      map.set(k, id);
    }
    return id;
  };
  const count = g.index ? g.index.count : P.count;
  const at = (c: number) => (g.index ? g.index.getX(c) : c);
  for (let t = 0; t < count / 3; t++) {
    const c = [at(t * 3), at(t * 3 + 1), at(t * 3 + 2)];
    const verts = c.map(vid);
    if (verts[0] === verts[1] || verts[1] === verts[2] || verts[0] === verts[2]) continue;
    faces.push({ verts, uvs: UV ? c.flatMap((i) => [UV.getX(i), UV.getY(i)]) : undefined, material: materialOf(t) });
  }
  return buildMesh(positions, faces) as EvalMesh;
}

const csg = new Evaluator();
csg.attributes = ['position', 'uv', 'normal'];
csg.useGroups = true;

/** Objects of a collection and its child collections. */
export function collectionObjects(doc: DocumentData | null, id: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (cid: string) => {
    if (seen.has(cid)) return;
    seen.add(cid);
    const c = doc?.collections[cid];
    if (!c) return;
    out.push(...c.objects);
    c.children.forEach(walk);
  };
  if (typeof id === 'string') walk(id);
  return out;
}

function booleanMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const op = str(mod, 'operation', 'DIFFERENCE');
  const operands: { mesh: EvalMesh; matrix: Matrix4 }[] = [];
  const own = ctx.graph.get(ctx.ob.id)?.world;
  if (!own) return m;
  const ownInv = own.clone().invert();
  const add = (id: string) => {
    if (id === ctx.ob.id) return;
    const ev = ctx.graph.get(id);
    if (ev?.mesh && ev.mesh.offsets.length > 1) operands.push({ mesh: ev.mesh, matrix: ownInv.clone().multiply(ev.world) });
  };
  if (str(mod, 'operand_type', 'OBJECT') === 'COLLECTION') {
    for (const id of collectionObjects(ctx.doc, mod.collection)) add(id);
  } else if (typeof mod.object === 'string') add(mod.object);
  if (!operands.length || m.offsets.length < 2) return m;
  const kind = op === 'UNION' ? ADDITION : op === 'INTERSECT' ? INTERSECTION : SUBTRACTION;
  try {
    let result: Brush = toBrush(m);
    for (const o of operands) result = csg.evaluate(result, toBrush(o.mesh, o.matrix), kind) as Brush;
    const g = result.geometry;
    const triMat = new Int32Array(Math.ceil((g.index ? g.index.count : g.getAttribute('position').count) / 3));
    for (const gr of g.groups) for (let t = gr.start / 3; t < (gr.start + gr.count) / 3; t++) triMat[t] = gr.materialIndex ?? 0;
    const out = fromTriangles(g, (t) => triMat[t]);
    // operand faces keep the target's first material (operand materials are not mapped)
    out.smooth = new Uint8Array(out.offsets.length - 1).fill(m.smooth?.[0] ?? 0);
    return out;
  } catch {
    return m;
  }
}

// ---------------------------------------------------------------------------
// Decimate

/** Quadric-error edge collapse on the triangulated mesh until `ratio` of the faces remain. */
export function decimateCollapse(m: EvalMesh, ratio: number): EvalMesh {
  // triangulate
  const tris: number[] = [];
  const triUv: number[] = [];
  const triMat: number[] = [];
  const tmp: number[] = [];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    tmp.length = 0;
    const verts = Array.from(m.indices.subarray(s, e));
    tmp.push(...triangleVerts(m.positions, verts));
    for (let t = 0; t < tmp.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const v = tmp[t + k];
        let c = s;
        for (let q = s; q < e; q++) if (m.indices[q] === v) c = q;
        tris.push(v);
        triUv.push(m.uvs[c * 2] ?? 0, m.uvs[c * 2 + 1] ?? 0);
        if (k === 0) triMat.push(m.material_index?.[f] ?? 0);
      }
  }
  const nv = m.positions.length / 3;
  const P = Array.from(m.positions);
  const nt = tris.length / 3;
  const target = Math.max(2, Math.floor(nt * ratio));
  if (target >= nt) return m;
  // quadrics
  const Q = new Float64Array(nv * 10);
  const addQ = (v: number, q: number[]) => {
    for (let i = 0; i < 10; i++) Q[v * 10 + i] += q[i];
  };
  const triPlane = (t: number) => {
    const a = tris[t * 3],
      b = tris[t * 3 + 1],
      c = tris[t * 3 + 2];
    const A = new Vector3(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]),
      B = new Vector3(P[b * 3], P[b * 3 + 1], P[b * 3 + 2]),
      C = new Vector3(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
    const n = B.sub(A).cross(C.sub(A));
    const area = n.length();
    if (area < 1e-20) return null;
    n.multiplyScalar(1 / area);
    return { n, d: -n.dot(A), area };
  };
  for (let t = 0; t < nt; t++) {
    const pl = triPlane(t);
    if (!pl) continue;
    const { n, d } = pl;
    const q = [n.x * n.x, n.x * n.y, n.x * n.z, n.x * d, n.y * n.y, n.y * d === 0 ? n.y * n.z : n.y * n.z, n.y * d, n.z * n.z, n.z * d, d * d];
    q[5] = n.y * n.z;
    for (let k = 0; k < 3; k++) addQ(tris[t * 3 + k], q);
  }
  // boundary edges get a strong perpendicular plane so borders are preserved
  const edgeCount = new Map<string, number>();
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + k],
        b = tris[t * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  for (let t = 0; t < nt; t++) {
    const pl = triPlane(t);
    if (!pl) continue;
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + k],
        b = tris[t * 3 + ((k + 1) % 3)];
      if (edgeCount.get(a < b ? `${a}:${b}` : `${b}:${a}`) !== 1) continue;
      const A = new Vector3(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]);
      const e = new Vector3(P[b * 3] - A.x, P[b * 3 + 1] - A.y, P[b * 3 + 2] - A.z);
      const n = e.clone().cross(pl.n).normalize();
      const d = -n.dot(A);
      const w = 1000;
      const q = [n.x * n.x, n.x * n.y, n.x * n.z, n.x * d, n.y * n.y, n.y * n.z, n.y * d, n.z * n.z, n.z * d, d * d].map((x) => x * w);
      addQ(a, q);
      addQ(b, q);
    }
  }
  const err = (q: Float64Array | number[], o: number, x: number, y: number, z: number) =>
    q[o] * x * x + 2 * q[o + 1] * x * y + 2 * q[o + 2] * x * z + 2 * q[o + 3] * x + q[o + 4] * y * y + 2 * q[o + 5] * y * z + 2 * q[o + 6] * y + q[o + 7] * z * z + 2 * q[o + 8] * z + q[o + 9];
  // union-find style remap
  const remap = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (v: number): number => {
    while (remap[v] !== v) v = remap[v] = remap[remap[v]];
    return v;
  };
  const alive = new Uint8Array(nt).fill(1);
  let liveCount = nt;
  const vTris: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) vTris[tris[t * 3 + k]].push(t);
  // candidate edges sorted by cost (lazy re-evaluation)
  interface Cand {
    a: number;
    b: number;
    cost: number;
    x: number;
    y: number;
    z: number;
  }
  const evalEdge = (a: number, b: number): Cand => {
    const q = new Float64Array(10);
    for (let i = 0; i < 10; i++) q[i] = Q[a * 10 + i] + Q[b * 10 + i];
    const opts = [
      [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]],
      [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]],
      [(P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 1] + P[b * 3 + 1]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2],
    ];
    let best = opts[0],
      bc = Infinity;
    for (const o of opts) {
      const c = err(q, 0, o[0], o[1], o[2]);
      if (c < bc) {
        bc = c;
        best = o;
      }
    }
    return { a, b, cost: bc, x: best[0], y: best[1], z: best[2] };
  };
  // binary heap
  const heap: Cand[] = [];
  const push = (c: Cand) => {
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].cost <= heap[i].cost) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): Cand | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1,
          r = l + 1;
        let s = i;
        if (l < heap.length && heap[l].cost < heap[s].cost) s = l;
        if (r < heap.length && heap[r].cost < heap[s].cost) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]];
        i = s;
      }
    }
    return top;
  };
  for (const key of edgeCount.keys()) {
    const [a, b] = key.split(':').map(Number);
    push(evalEdge(a, b));
  }
  const version = new Int32Array(nv);
  const stamp = new Map<Cand, [number, number]>();
  void stamp;
  while (liveCount > target && heap.length) {
    const c = pop()!;
    const a = find(c.a),
      b = find(c.b);
    if (a === b) continue;
    if (a !== c.a || b !== c.b) {
      push(evalEdge(a, b));
      continue;
    }
    // reject collapses that flip a surviving triangle
    const np = new Vector3(c.x, c.y, c.z);
    let flips = false;
    for (const v of [a, b])
      for (const t of vTris[v]) {
        if (!alive[t]) continue;
        const vs = [find(tris[t * 3]), find(tris[t * 3 + 1]), find(tris[t * 3 + 2])];
        if (vs.includes(a) && vs.includes(b)) continue;
        const before = vs.map((x) => new Vector3(P[x * 3], P[x * 3 + 1], P[x * 3 + 2]));
        const after = vs.map((x, i) => (x === a || x === b ? np : before[i]));
        const n0 = before[1].clone().sub(before[0]).cross(before[2].clone().sub(before[0]));
        const n1 = after[1].clone().sub(after[0]).cross(after[2].clone().sub(after[0]));
        if (n0.dot(n1) <= 0) flips = true;
      }
    if (flips) continue;
    // collapse b into a
    remap[b] = a;
    P[a * 3] = c.x;
    P[a * 3 + 1] = c.y;
    P[a * 3 + 2] = c.z;
    for (let i = 0; i < 10; i++) Q[a * 10 + i] += Q[b * 10 + i];
    for (const t of vTris[b]) vTris[a].push(t);
    version[a]++;
    const neighbours = new Set<number>();
    for (const t of vTris[a]) {
      if (!alive[t]) continue;
      const vs = [find(tris[t * 3]), find(tris[t * 3 + 1]), find(tris[t * 3 + 2])];
      if (vs[0] === vs[1] || vs[1] === vs[2] || vs[0] === vs[2]) {
        alive[t] = 0;
        liveCount--;
        continue;
      }
      for (const v of vs) if (v !== a) neighbours.add(v);
    }
    for (const n of neighbours) push(evalEdge(a, n));
  }
  // rebuild
  const used = new Int32Array(nv).fill(-1);
  const positions: number[] = [];
  const faces: PolyFace[] = [];
  for (let t = 0; t < nt; t++) {
    if (!alive[t]) continue;
    const vs = [find(tris[t * 3]), find(tris[t * 3 + 1]), find(tris[t * 3 + 2])].map((v) => {
      if (used[v] < 0) {
        used[v] = positions.length / 3;
        positions.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      }
      return used[v];
    });
    faces.push({ verts: vs, uvs: triUv.slice(t * 6, t * 6 + 6), material: triMat[t], smooth: !!m.smooth?.[0] });
  }
  return buildMesh(positions, faces) as EvalMesh;
}

/** Planar decimation: merge neighbouring faces whose normals differ by less than the angle limit. */
export function decimateDissolve(m: EvalMesh, angle: number, delimit: string[] = ['MATERIAL']): EvalMesh {
  const nf = m.offsets.length - 1;
  const et = edgeTopology(m);
  const normals = Array.from({ length: nf }, (_, f) => faceNormal(m.positions, m.indices, m.offsets[f], m.offsets[f + 1]).normalize());
  const parent = Int32Array.from({ length: nf }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  // per-edge flags from the per-corner arrays
  const flagged = (arr: Uint32Array | undefined) => {
    const out = new Uint8Array(et.count);
    if (arr) for (let c = 0; c < m.indices.length; c++) if (arr[c]) out[et.cornerEdge[c]] = 1;
    return out;
  };
  const seamE = delimit.includes('SEAM') ? flagged(m.seams) : null,
    sharpE = delimit.includes('SHARP') ? flagged(m.sharp) : null;
  const edgeFlag = (arr: Uint32Array | undefined, e: number) => (arr === m.seams ? seamE : sharpE)?.[e] === 1;
  for (let e = 0; e < et.count; e++) {
    const s = et.faceOffsets[e],
      t = et.faceOffsets[e + 1];
    if (t - s !== 2) continue;
    const f0 = et.faces[s],
      f1 = et.faces[s + 1];
    if (delimit.includes('MATERIAL') && (m.material_index?.[f0] ?? 0) !== (m.material_index?.[f1] ?? 0)) continue;
    if (delimit.includes('SEAM') && edgeFlag(m.seams, e)) continue;
    if (delimit.includes('SHARP') && edgeFlag(m.sharp, e)) continue;
    if (delimit.includes('SMOOTH') && (m.smooth?.[f0] ?? 0) !== (m.smooth?.[f1] ?? 0)) continue;
    if (normals[f0].angleTo(normals[f1]) <= angle) parent[find(f0)] = find(f1);
  }
  // group faces, then trace each region's boundary as one polygon (regions with holes stay split)
  const regions = new Map<number, number[]>();
  for (let f = 0; f < nf; f++) {
    const r = find(f);
    (regions.get(r) ?? regions.set(r, []).get(r)!).push(f);
  }
  const faces: PolyFace[] = [];
  for (const fs of regions.values()) {
    if (fs.length === 1) {
      const f = fs[0];
      faces.push({ verts: Array.from(m.indices.subarray(m.offsets[f], m.offsets[f + 1])), uvs: Array.from(m.uvs.subarray(m.offsets[f] * 2, m.offsets[f + 1] * 2)), material: m.material_index?.[f] ?? 0, smooth: !!m.smooth?.[f] });
      continue;
    }
    // directed boundary edges: those whose reverse is not in the region
    const directed = new Map<string, [number, number, number]>(); // key a>b -> [a,b,corner]
    for (const f of fs)
      for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
        const a = m.indices[c],
          b = m.indices[c + 1 < m.offsets[f + 1] ? c + 1 : m.offsets[f]];
        directed.set(`${a}>${b}`, [a, b, c]);
      }
    const next = new Map<number, [number, number]>();
    let ok = true;
    for (const [k, [a, b, c]] of directed) {
      if (directed.has(`${b}>${a}`)) continue;
      if (next.has(a)) ok = false;
      next.set(a, [b, c]);
      void k;
    }
    const start = next.keys().next().value as number | undefined;
    const loop: number[] = [],
      uvs: number[] = [];
    if (ok && start !== undefined) {
      let v = start,
        guard = 0;
      do {
        const [nb, c] = next.get(v)!;
        loop.push(v);
        uvs.push(m.uvs[c * 2] ?? 0, m.uvs[c * 2 + 1] ?? 0);
        v = nb;
      } while (v !== start && next.has(v) && guard++ < 100000);
      ok = v === start && loop.length === next.size;
    }
    if (!ok || loop.length < 3) {
      for (const f of fs) faces.push({ verts: Array.from(m.indices.subarray(m.offsets[f], m.offsets[f + 1])), uvs: Array.from(m.uvs.subarray(m.offsets[f] * 2, m.offsets[f + 1] * 2)), material: m.material_index?.[f] ?? 0, smooth: !!m.smooth?.[f] });
      continue;
    }
    // drop collinear boundary vertices (dissolve verts on straight edges)
    const keep: number[] = [],
      keepUv: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      const p = loop[(i + loop.length - 1) % loop.length],
        v = loop[i],
        n = loop[(i + 1) % loop.length];
      const a = new Vector3(m.positions[v * 3] - m.positions[p * 3], m.positions[v * 3 + 1] - m.positions[p * 3 + 1], m.positions[v * 3 + 2] - m.positions[p * 3 + 2]);
      const b = new Vector3(m.positions[n * 3] - m.positions[v * 3], m.positions[n * 3 + 1] - m.positions[v * 3 + 1], m.positions[n * 3 + 2] - m.positions[v * 3 + 2]);
      if (a.angleTo(b) > 1e-3) {
        keep.push(v);
        keepUv.push(uvs[i * 2], uvs[i * 2 + 1]);
      }
    }
    faces.push({ verts: keep.length >= 3 ? keep : loop, uvs: keep.length >= 3 ? keepUv : uvs, material: m.material_index?.[fs[0]] ?? 0, smooth: !!m.smooth?.[fs[0]] });
  }
  // compact unused vertices
  const used = new Int32Array(m.positions.length / 3).fill(-1);
  const positions: number[] = [];
  for (const f of faces)
    f.verts = f.verts.map((v) => {
      if (used[v] < 0) {
        used[v] = positions.length / 3;
        positions.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
      }
      return used[v];
    });
  return buildMesh(positions, faces) as EvalMesh;
}

function decimateMod(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const type = str(mod, 'decimate_type', 'COLLAPSE');
  if (type === 'DISSOLVE') return decimateDissolve(m, num(mod, 'angle_limit', (5 * Math.PI) / 180), (mod.delimit as string[] | undefined) ?? []);
  if (type === 'UNSUBDIV') {
    // undo regular subdivision steps (as long as the mesh is a subdivided quad mesh)
    let out = m;
    for (let i = 0; i < Math.max(0, Math.round(num(mod, 'iterations', 0))); i++) {
      const r = unsubdivide(out);
      if (!r) break;
      out = r.coarse;
    }
    return out;
  }
  const ratio = Math.max(0, Math.min(1, num(mod, 'ratio', 1)));
  if (ratio >= 1) return m;
  const out = decimateCollapse(m, ratio);
  return bool(mod, 'use_collapse_triangulate') ? out : quadsFromTriangles(out);
}

/** Join flat neighbouring triangle pairs back into quads. */
function quadsFromTriangles(m: EvalMesh): EvalMesh {
  const nf = m.offsets.length - 1;
  const used = new Uint8Array(nf);
  const et = edgeTopology(m);
  const fn = Array.from({ length: nf }, (_, f) => faceNormal(m.positions, m.indices, m.offsets[f], m.offsets[f + 1]).normalize());
  const faces: PolyFace[] = [];
  for (let f = 0; f < nf; f++) {
    if (used[f]) continue;
    const s = m.offsets[f];
    let merged = false;
    if (m.offsets[f + 1] - s === 3)
      for (let k = 0; k < 3 && !merged; k++) {
        const e = et.cornerEdge[s + k];
        if (et.faceOffsets[e + 1] - et.faceOffsets[e] !== 2) continue;
        const g = et.faces[et.faceOffsets[e]] === f ? et.faces[et.faceOffsets[e] + 1] : et.faces[et.faceOffsets[e]];
        if (used[g] || m.offsets[g + 1] - m.offsets[g] !== 3 || fn[f].dot(fn[g]) < 0.9995) continue;
        const a = m.indices[s + k],
          b = m.indices[s + ((k + 1) % 3)],
          c = m.indices[s + ((k + 2) % 3)];
        const gs = m.offsets[g];
        let o = -1,
          oc = -1;
        for (let q = gs; q < gs + 3; q++) if (m.indices[q] !== a && m.indices[q] !== b) (o = m.indices[q]), (oc = q);
        if (o < 0) continue;
        const uv = (corner: number) => [m.uvs[corner * 2], m.uvs[corner * 2 + 1]];
        faces.push({ verts: [a, o, b, c], uvs: [...uv(s + k), ...uv(oc), ...uv(s + ((k + 1) % 3)), ...uv(s + ((k + 2) % 3))], material: m.material_index?.[f] ?? 0, smooth: !!m.smooth?.[f] });
        used[f] = used[g] = 1;
        merged = true;
      }
    if (!merged) {
      used[f] = 1;
      faces.push({ verts: Array.from(m.indices.subarray(s, m.offsets[f + 1])), uvs: Array.from(m.uvs.subarray(s * 2, m.offsets[f + 1] * 2)), material: m.material_index?.[f] ?? 0, smooth: !!m.smooth?.[f] });
    }
  }
  return buildMesh(Array.from(m.positions), faces) as EvalMesh;
}

// ---------------------------------------------------------------------------
// Remesh (voxel)

function remeshMod(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const mode = str(mod, 'mode', 'VOXEL');
  if (mode === 'BLOCKS' || mode === 'SMOOTH' || mode === 'SHARP')
    return gridRemesh(m, {
      mode,
      depth: num(mod, 'octree_depth', 4),
      scale: num(mod, 'scale', 0.9),
      removeDisconnected: bool(mod, 'use_remove_disconnected', true),
      threshold: num(mod, 'threshold', 1),
      smooth: bool(mod, 'use_smooth_shade'),
    });
  const voxel = Math.max(1e-4, num(mod, 'voxel_size', 0.1));
  const tri: number[] = [];
  const tmp: number[] = [];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    tmp.length = 0;
    tmp.push(...triangleVerts(m.positions, Array.from(m.indices.subarray(m.offsets[f], m.offsets[f + 1]))));
    tri.push(...tmp);
  }
  if (!tri.length) return m;
  let res;
  try {
    res = voxelRemesh(m.positions, Uint32Array.from(tri), voxel, 4e6);
  } catch {
    return m;
  }
  const faces: PolyFace[] = [];
  const smooth = bool(mod, 'use_smooth_shade');
  for (let i = 0; i < res.quads.length; i += 4) faces.push({ verts: [res.quads[i], res.quads[i + 1], res.quads[i + 2], res.quads[i + 3]], smooth });
  return buildMesh(res.positions, faces) as EvalMesh;
}

// ---------------------------------------------------------------------------
// Weighted Normal

function weightedNormalMod(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const mode = str(mod, 'mode', 'FACE_AREA');
  const weight = Math.max(1, Math.min(100, num(mod, 'weight', 50)));
  const keepSharp = bool(mod, 'keep_sharp');
  const nf = m.offsets.length - 1,
    nv = m.positions.length / 3;
  const P = m.positions;
  // per corner contribution: face normal × (area and/or corner angle), weighted by the "weight" exponent
  const fn: Vector3[] = [],
    area: number[] = [];
  for (let f = 0; f < nf; f++) {
    const n = faceNormal(P, m.indices, m.offsets[f], m.offsets[f + 1]);
    area.push(n.length() / 2);
    fn.push(n.normalize());
  }
  const cornerAngle = (c: number, f: number) => {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    const v = m.indices[c],
      p = m.indices[c === s ? e - 1 : c - 1],
      n = m.indices[c + 1 < e ? c + 1 : s];
    const a = new Vector3(P[p * 3] - P[v * 3], P[p * 3 + 1] - P[v * 3 + 1], P[p * 3 + 2] - P[v * 3 + 2]);
    const b = new Vector3(P[n * 3] - P[v * 3], P[n * 3 + 1] - P[v * 3 + 1], P[n * 3 + 2] - P[v * 3 + 2]);
    return a.angleTo(b);
  };
  // the dominant faces win: weights are ranked and scaled by (weight/50)^rank
  const value = (f: number, c: number) => (mode === 'CORNER_ANGLE' ? cornerAngle(c, f) : mode === 'FACE_AREA_WITH_ANGLE' ? area[f] * cornerAngle(c, f) : area[f]);
  const cornersOf: number[][] = Array.from({ length: nv }, () => []);
  const cornerFace = new Int32Array(m.indices.length);
  for (let f = 0; f < nf; f++)
    for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
      cornersOf[m.indices[c]].push(c);
      cornerFace[c] = f;
    }
  // sharp edge fans: corners around a vertex separated by sharp edges keep separate normals
  const sharpSet = new Set<string>();
  if (keepSharp && m.sharp)
    for (let f = 0; f < nf; f++)
      for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++)
        if (m.sharp[c]) {
          const a = m.indices[c],
            b = m.indices[c + 1 < m.offsets[f + 1] ? c + 1 : m.offsets[f]];
          sharpSet.add(a < b ? `${a}:${b}` : `${b}:${a}`);
        }
  const out = new Float32Array(m.indices.length * 3);
  const thresh = num(mod, 'thresh', 0.01);
  const exponent = weight / 50;
  for (let v = 0; v < nv; v++) {
    const cs = cornersOf[v];
    if (!cs.length) continue;
    // fan grouping (only when keeping sharp edges)
    const groups: number[][] = keepSharp && sharpSet.size ? fanGroups(m, v, cs, cornerFace, sharpSet) : [cs];
    for (const gAll of groups) {
      // face influence: only the strongest faces around the vertex count
      let g = gAll;
      if (bool(mod, 'use_face_influence') && m.face_strength) {
        const top = Math.max(...gAll.map((c) => m.face_strength![cornerFace[c]] ?? 1));
        g = gAll.filter((c) => (m.face_strength![cornerFace[c]] ?? 1) === top);
      }
      const vals = g.map((c) => value(cornerFace[c], c));
      const max = Math.max(...vals) || 1;
      const n = new Vector3();
      g.forEach((c, i) => {
        // rank faces into tiers by relative value; higher tiers dominate when weight > 50
        const rel = vals[i] / max;
        const tier = Math.round((1 - rel) / Math.max(1e-6, thresh)) * thresh;
        n.addScaledVector(fn[cornerFace[c]], vals[i] * Math.pow(exponent, -tier * 10));
      });
      n.normalize();
      for (const c of gAll) out.set([n.x, n.y, n.z], c * 3);
    }
  }
  // a vertex group limits the effect: other vertices keep their current normals
  const gi = m.vertex_groups?.findIndex((g) => g.name === str(mod, 'vertex_group')) ?? -1;
  const gw = gi >= 0 ? m.weights?.[gi] : undefined;
  if (gw) {
    const inv = bool(mod, 'invert_vertex_group');
    const orig = currentCornerNormals(m);
    for (let c = 0; c < m.indices.length; c++) if ((gw[m.indices[c]] > 0) === inv) out.set(orig.subarray(c * 3, c * 3 + 3), c * 3);
  }
  return { ...m, smooth: new Uint8Array(nf).fill(1), custom_normals: out } as EvalMesh;
}

function fanGroups(m: EvalMesh, v: number, cs: number[], cornerFace: Int32Array, sharp: Set<string>): number[][] {
  // connect corners of faces sharing a non-sharp edge at v
  const parent = new Map(cs.map((c) => [c, c]));
  const find = (c: number): number => {
    while (parent.get(c) !== c) c = parent.get(c)!;
    return c;
  };
  const edgesOf = (c: number) => {
    const f = cornerFace[c];
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    const p = m.indices[c === s ? e - 1 : c - 1],
      n = m.indices[c + 1 < e ? c + 1 : s];
    return [p, n];
  };
  for (let i = 0; i < cs.length; i++)
    for (let j = i + 1; j < cs.length; j++) {
      const shared = edgesOf(cs[i]).filter((x) => edgesOf(cs[j]).includes(x));
      for (const o of shared) {
        const key = v < o ? `${v}:${o}` : `${o}:${v}`;
        if (!sharp.has(key)) parent.set(find(cs[i]), find(cs[j]));
      }
    }
  const groups = new Map<number, number[]>();
  for (const c of cs) (groups.get(find(c)) ?? groups.set(find(c), []).get(find(c))!).push(c);
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// registration

registerModifier({
  type: 'BEVEL',
  label: 'Bevel',
  category: 'GENERATE',
  icon: 'mod_bevel',
  defaults: base({ affect: 'EDGES', offset_type: 'OFFSET', width: 0.1, width_pct: 0.1, segments: 1, limit_method: 'ANGLE', angle_limit: (30 * Math.PI) / 180, vertex_group: '', invert_vertex_group: false, profile_type: 'SUPERELLIPSE', profile: 0.5, use_clamp_overlap: true, harden_normals: false, mark_seam: false, mark_sharp: false, material: -1 }),
  apply: bevelMod,
});
registerModifier({
  type: 'BOOLEAN',
  label: 'Boolean',
  category: 'GENERATE',
  icon: 'mod_boolean',
  defaults: base({ operation: 'DIFFERENCE', operand_type: 'OBJECT', object: null, collection: null, solver: 'EXACT' }),
  deps: (m) => (m.operand_type === 'COLLECTION' ? collectionObjects(physicsDoc(), m.collection) : [m.object as string]),
  apply: booleanMod,
});
registerModifier({
  type: 'DECIMATE',
  label: 'Decimate',
  category: 'GENERATE',
  icon: 'mod_decim',
  defaults: base({ decimate_type: 'COLLAPSE', ratio: 1, use_collapse_triangulate: false, iterations: 0, angle_limit: (5 * Math.PI) / 180, delimit: [] }),
  apply: decimateMod,
});
registerModifier({
  type: 'REMESH',
  label: 'Remesh',
  category: 'GENERATE',
  icon: 'mod_remesh',
  defaults: base({ mode: 'VOXEL', voxel_size: 0.1, octree_depth: 4, scale: 0.9, use_remove_disconnected: true, threshold: 1, use_smooth_shade: false }),
  apply: remeshMod,
});
registerModifier({
  type: 'WEIGHTED_NORMAL',
  label: 'Weighted Normal',
  category: 'NORMALS',
  icon: 'mod_normaledit',
  defaults: base({ mode: 'FACE_AREA', weight: 50, thresh: 0.01, keep_sharp: false, use_face_influence: false, vertex_group: '', invert_vertex_group: false }),
  apply: weightedNormalMod,
});

modifierFields.BEVEL = [
  ['affect', 'Affect', 'enum', [['EDGES', 'Edges']]],
  ['width', 'Amount', 'dist'],
  ['segments', 'Segments', 'int', { min: 1, max: 100 }],
  ['limit_method', 'Limit Method', 'enum', [['NONE', 'None'], ['ANGLE', 'Angle']]],
  ['angle_limit', 'Angle', 'angle'],
  ['profile', 'Shape', 'factor'],
  ['harden_normals', 'Harden Normals', 'bool'],
];
modifierFields.BOOLEAN = [
  ['operation', 'Operation', 'enum', [['INTERSECT', 'Intersect'], ['UNION', 'Union'], ['DIFFERENCE', 'Difference']]],
  ['operand_type', 'Operand Type', 'enum', [['OBJECT', 'Object'], ['COLLECTION', 'Collection']]],
  ['object', 'Object', 'object'],
];
modifierFields.DECIMATE = [];
modifierFields.REMESH = [];
modifierFields.WEIGHTED_NORMAL = [
  ['mode', 'Weighting Mode', 'enum', [['FACE_AREA', 'Face Area'], ['CORNER_ANGLE', 'Corner Angle'], ['FACE_AREA_WITH_ANGLE', 'Face Area and Angle']]],
  ['weight', 'Weight', 'int', { min: 1, max: 100 }],
  ['thresh', 'Threshold', 'num'],
  ['keep_sharp', 'Keep Sharp', 'bool'],
  ['use_face_influence', 'Face Influence', 'bool'],
  ['vertex_group', 'Vertex Group', 'vgroup'],
];

void Mesh;
