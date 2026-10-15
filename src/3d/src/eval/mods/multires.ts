// Multiresolution: the base mesh is subdivided (Catmull–Clark) `total_levels` times and detail is
// stored as displacements of the finest level, in tangent frames of the subdivided base so they
// follow changes of the base. Lower display levels sample the detailed surface at their vertices
// (every level's vertices are the first vertices of the next level).
import { Vector3 } from 'three';
import type { ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier, catmullClark } from '../modifiers';
import { MeshBuilder, vertexNormals, weightsOf } from '../meshbuild';
import { edgeTopology, vertexFaces, vertexNeighbors } from '../../mesh/mesh';
import { bool, num } from './common';

export const MAX_MULTIRES_LEVEL = 6;

/** Orthonormal frames (rows: tangent, bitangent, normal) for each vertex of a mesh. */
export function multiresFrames(m: EvalMesh): Float64Array {
  const P = m.positions,
    nv = P.length / 3;
  const N = vertexNormals(m);
  const nb = vertexNeighbors(m);
  const F = new Float64Array(nv * 9);
  const n = new Vector3(),
    t = new Vector3(),
    b = new Vector3();
  for (let v = 0; v < nv; v++) {
    n.fromArray(N, v * 3);
    if (n.lengthSq() < 1e-12) n.set(0, 0, 1);
    t.set(0, 0, 0);
    for (let k = nb.offsets[v]; k < nb.offsets[v + 1] && t.lengthSq() < 1e-14; k++) {
      const j = nb.neighbors[k];
      t.set(P[j * 3] - P[v * 3], P[j * 3 + 1] - P[v * 3 + 1], P[j * 3 + 2] - P[v * 3 + 2]);
      t.addScaledVector(n, -t.dot(n));
    }
    if (t.lengthSq() < 1e-14) t.set(1, 0, 0).addScaledVector(n, -n.x);
    if (t.lengthSq() < 1e-14) t.set(0, 1, 0).addScaledVector(n, -n.y);
    t.normalize();
    b.crossVectors(n, t);
    F.set([t.x, t.y, t.z, b.x, b.y, b.z, n.x, n.y, n.z], v * 9);
  }
  return F;
}

/** Displacements (tangent space) taking the subdivided base `top` to `target` positions. */
export function encodeDisps(top: EvalMesh, target: ArrayLike<number>): Float32Array {
  const F = multiresFrames(top);
  const P = top.positions;
  const out = new Float32Array(P.length);
  for (let v = 0; v < P.length / 3; v++) {
    const dx = target[v * 3] - P[v * 3],
      dy = target[v * 3 + 1] - P[v * 3 + 1],
      dz = target[v * 3 + 2] - P[v * 3 + 2];
    for (let r = 0; r < 3; r++) out[v * 3 + r] = F[v * 9 + r * 3] * dx + F[v * 9 + r * 3 + 1] * dy + F[v * 9 + r * 3 + 2] * dz;
  }
  return out;
}

export function decodeDisps(top: EvalMesh, disps: ArrayLike<number>): Float32Array {
  const F = multiresFrames(top);
  const P = top.positions;
  const out = new Float32Array(P.length);
  for (let v = 0; v < P.length / 3; v++) {
    const lx = disps[v * 3],
      ly = disps[v * 3 + 1],
      lz = disps[v * 3 + 2];
    for (let k = 0; k < 3; k++) out[v * 3 + k] = P[v * 3 + k] + F[v * 9 + k] * lx + F[v * 9 + 3 + k] * ly + F[v * 9 + 6 + k] * lz;
  }
  return out;
}

export function multiresTotal(mod: ModifierBase) {
  return Math.max(0, Math.min(MAX_MULTIRES_LEVEL, Math.round(num(mod, 'total_levels', 0))));
}

/** The finest level with its displacement applied. */
const topCache = new WeakMap<ModifierBase, { key: string; base: Float32Array; disps: unknown; mesh: EvalMesh }>();
export function displacedTop(base: EvalMesh, mod: ModifierBase): EvalMesh {
  const total = multiresTotal(mod);
  const key = `${total}:${bool(mod, 'use_creases', true)}`;
  const c = topCache.get(mod);
  if (c && c.key === key && c.base === base.positions && c.disps === mod._disps) return c.mesh;
  const top = catmullClark(base, total, false, bool(mod, 'use_creases', true));
  const d = mod._disps as Float32Array | undefined;
  const mesh = d && d.length === top.positions.length ? { ...top, positions: decodeDisps(top, d) } : top;
  topCache.set(mod, { key, base: base.positions, disps: mod._disps, mesh });
  return mesh;
}

/** The mesh shown at `level` (0 = base). */
export function multiresAtLevel(base: EvalMesh, mod: ModifierBase, level: number): EvalMesh {
  const total = multiresTotal(mod);
  const L = Math.max(0, Math.min(total, level));
  if (L === 0 || total === 0) return base;
  const top = displacedTop(base, mod);
  if (L === total) return top;
  const low = catmullClark(base, L, false, bool(mod, 'use_creases', true));
  const P = Float32Array.from(top.positions.subarray(0, low.positions.length));
  return { ...low, positions: P };
}

function multiresMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  // while sculpting, the mesh itself already is the sculpt level
  if (mod._sculpt_base) return m;
  const level = ctx.render ? num(mod, 'render_levels', 0) : ctx.editMode ? 0 : num(mod, 'levels', 0);
  return multiresAtLevel(m, mod, Math.round(level));
}

// ---------------------------------------------------------------------------
// subdivision of the stored detail

/** One level of plain linear subdivision (same vertex order as Catmull–Clark). */
export function linearSubdivide(m: EvalMesh): Float32Array {
  return catmullClark(m, 1, true, false).positions;
}

/**
 * New displacements after adding a level: the detailed surface subdivided with `mode`
 * (CATMULL_CLARK smooths the detail, SIMPLE / LINEAR keep it as is).
 */
export function subdivideDisps(base: EvalMesh, mod: ModifierBase, mode: string): Float32Array {
  const total = multiresTotal(mod);
  const top = displacedTop(base, mod);
  const finer = mode === 'CATMULL_CLARK' ? catmullClark(top, 1, false, bool(mod, 'use_creases', true)).positions : linearSubdivide(top);
  const newTop = catmullClark(base, total + 1, false, bool(mod, 'use_creases', true));
  return encodeDisps(newTop, finer);
}

// ---------------------------------------------------------------------------
// unsubdivide: recover a coarse quad mesh whose subdivision has the same topology

/**
 * Detect a mesh that is one level of Catmull–Clark subdivision of a coarser mesh. Returns the
 * coarse mesh (vertices at their current positions) and, for every vertex of the fine mesh, its
 * index in the subdivision of the coarse mesh.
 */
export function unsubdivide(m: EvalMesh): { coarse: EvalMesh; map: Int32Array } | null {
  const nf = m.offsets.length - 1,
    nv = m.positions.length / 3;
  if (!nf) return null;
  for (let f = 0; f < nf; f++) if (m.offsets[f + 1] - m.offsets[f] !== 4) return null;
  const vf = vertexFaces(m);
  // seeds: vertices whose valence is not 4 must be original vertices (or boundary verts…)
  const et = edgeTopology(m);
  const valence = new Uint32Array(nv),
    boundary = new Uint8Array(nv);
  for (let e = 0; e < et.count; e++) {
    valence[et.verts[e * 2]]++;
    valence[et.verts[e * 2 + 1]]++;
    if (et.faceOffsets[e + 1] - et.faceOffsets[e] === 1) boundary[et.verts[e * 2]] = boundary[et.verts[e * 2 + 1]] = 1;
  }
  // try labelings: O (0) original, E (1) edge point, F (2) face point
  const tryLabel = (seed: number): Int8Array | null => {
    const lab = new Int8Array(nv).fill(-1);
    lab[seed] = 0;
    const queue = [seed];
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi];
      for (let k = vf.offsets[v]; k < vf.offsets[v + 1]; k++) {
        const f = vf.faces[k],
          s = m.offsets[f];
        const c = vf.corners[k] - s;
        const L = lab[v];
        let pattern: number[] | null = null;
        if (L === 0) pattern = [0, 1, 2, 1];
        else if (L === 2) pattern = [2, 1, 0, 1];
        else {
          // an edge point: one of its neighbours in this quad must already be known
          const nxt = lab[m.indices[s + ((c + 1) % 4)]],
            prv = lab[m.indices[s + ((c + 3) % 4)]];
          // corners of an edge point's quad: E, (O|F), E, (F|O)
          if (nxt === 0 || nxt === 2) pattern = [1, nxt, 1, 2 - nxt];
          else if (prv === 0 || prv === 2) pattern = [1, 2 - prv, 1, prv];
          else continue;
        }
        for (let i = 0; i < 4; i++) {
          const w = m.indices[s + ((c + i) % 4)];
          const want = pattern[i];
          if (lab[w] < 0) {
            lab[w] = want;
            queue.push(w);
          } else if (lab[w] !== want) return null;
        }
      }
    }
    for (let v = 0; v < nv; v++) if (lab[v] < 0 && vf.offsets[v + 1] > vf.offsets[v]) return null;
    // structural checks: face points are interior with valence = their coarse face size >= 3,
    // interior edge points have valence 4, boundary edge points valence 3
    for (let v = 0; v < nv; v++) {
      if (lab[v] === 2 && (boundary[v] || valence[v] < 3)) return null;
      if (lab[v] === 1 && valence[v] !== (boundary[v] ? 3 : 4)) return null;
    }
    return lab;
  };
  const seeds: number[] = [];
  for (let v = 0; v < nv && seeds.length < 1; v++) if (valence[v] !== 4 && !boundary[v]) seeds.push(v);
  for (let v = 0; v < nv && seeds.length < 2; v++) if (boundary[v] && valence[v] === 2) seeds.push(v);
  // regular grids (torus-like): any corner of the first quad might be an original vertex
  for (let i = 0; i < 4; i++) seeds.push(m.indices[i]);
  let lab: Int8Array | null = null;
  for (const s of seeds) if ((lab = tryLabel(s))) break;
  if (!lab) return null;
  // coarse vertices
  const coarseIndex = new Int32Array(nv).fill(-1);
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const P = m.positions;
  for (let v = 0; v < nv; v++) if (lab[v] === 0) coarseIndex[v] = b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m.origIndex?.[v] ?? v, weightsOf(m, v));
  // coarse faces: walk the fan of quads around each face point
  const faceOfF = new Int32Array(nv).fill(-1);
  let coarseFaces = 0;
  for (let v = 0; v < nv; v++) {
    if (lab[v] !== 2) continue;
    const quads: { f: number; c: number }[] = [];
    for (let k = vf.offsets[v]; k < vf.offsets[v + 1]; k++) quads.push({ f: vf.faces[k], c: vf.corners[k] - m.offsets[vf.faces[k]] });
    const at = (q: { f: number; c: number }, i: number) => m.indices[m.offsets[q.f] + ((q.c + i) % 4)];
    const order = [quads[0]];
    const used = new Set([0]);
    while (order.length < quads.length) {
      const cur = order[order.length - 1];
      const b3 = at(cur, 3); // quad is F, a, O, b
      const ni = quads.findIndex((q, i) => !used.has(i) && at(q, 1) === b3);
      if (ni < 0) return null;
      used.add(ni);
      order.push(quads[ni]);
    }
    const verts = order.map((q) => coarseIndex[at(q, 2)]);
    const uvs = order.flatMap((q) => {
      const corner = m.offsets[q.f] + ((q.c + 2) % 4);
      return [m.uvs[corner * 2], m.uvs[corner * 2 + 1]];
    });
    const colors = m.colors ? order.flatMap((q) => Array.from(m.colors!.subarray((m.offsets[q.f] + ((q.c + 2) % 4)) * 4, (m.offsets[q.f] + ((q.c + 2) % 4)) * 4 + 4))) : undefined;
    const f0 = order[0].f;
    b.addFace(verts, uvs, m.smooth?.[f0] ?? 0, m.material_index?.[f0] ?? 0, { colors });
    faceOfF[v] = coarseFaces++;
  }
  const coarse = b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle });
  // fine vertex → index in the subdivided coarse mesh (verts, then edges, then faces)
  const cet = edgeTopology(coarse);
  const ckey = new Map<string, number>();
  for (let e = 0; e < cet.count; e++) ckey.set(`${cet.verts[e * 2]}:${cet.verts[e * 2 + 1]}`, e);
  const ncv = coarse.positions.length / 3,
    nce = cet.count;
  const map = new Int32Array(nv).fill(-1);
  const nbs = vertexNeighbors(m);
  for (let v = 0; v < nv; v++) {
    if (lab[v] === 0) map[v] = coarseIndex[v];
    else if (lab[v] === 2) map[v] = ncv + nce + faceOfF[v];
    else if (lab[v] === 1) {
      const os: number[] = [];
      for (let k = nbs.offsets[v]; k < nbs.offsets[v + 1]; k++) if (lab[nbs.neighbors[k]] === 0) os.push(coarseIndex[nbs.neighbors[k]]);
      if (os.length !== 2) return null;
      const a = Math.min(os[0], os[1]),
        c = Math.max(os[0], os[1]);
      const e = ckey.get(`${a}:${c}`);
      if (e === undefined) return null;
      map[v] = ncv + e;
    }
  }
  return { coarse, map };
}

/** Vertex map between the subdivisions of two meshes that are the same up to a vertex map. */
export function subdividedMap(A: EvalMesh, B: EvalMesh, vmap: Int32Array, levels: number): Int32Array {
  let a = A,
    b = B,
    map = vmap;
  for (let l = 0; l < levels; l++) {
    const ea = edgeTopology(a),
      eb = edgeTopology(b);
    const nva = a.positions.length / 3,
      nvb = b.positions.length / 3;
    const ekey = new Map<string, number>();
    for (let e = 0; e < eb.count; e++) ekey.set(`${eb.verts[e * 2]}:${eb.verts[e * 2 + 1]}`, e);
    const fkey = new Map<string, number>();
    for (let f = 0; f < b.offsets.length - 1; f++) fkey.set(Array.from(b.indices.subarray(b.offsets[f], b.offsets[f + 1])).sort((x, y) => x - y).join(','), f);
    const next = new Int32Array(nva + ea.count + a.offsets.length - 1);
    for (let v = 0; v < nva; v++) next[v] = map[v];
    for (let e = 0; e < ea.count; e++) {
      const x = map[ea.verts[e * 2]],
        y = map[ea.verts[e * 2 + 1]];
      next[nva + e] = nvb + (ekey.get(`${Math.min(x, y)}:${Math.max(x, y)}`) ?? 0);
    }
    for (let f = 0; f < a.offsets.length - 1; f++) {
      const key = Array.from(a.indices.subarray(a.offsets[f], a.offsets[f + 1]), (v) => map[v]).sort((x, y) => x - y).join(',');
      next[nva + ea.count + f] = nvb + eb.count + (fkey.get(key) ?? 0);
    }
    if (l + 1 < levels) {
      a = catmullClark(a, 1, true, false);
      b = catmullClark(b, 1, true, false);
    }
    map = next;
  }
  return map;
}

export const multiresModifiers: ModifierType[] = [
  {
    type: 'MULTIRES',
    label: 'Multiresolution',
    category: 'GENERATE',
    icon: 'mod_multires',
    defaults: () => ({ levels: 0, sculpt_levels: 0, render_levels: 0, total_levels: 0, quality: 4, uv_smooth: 'PRESERVE_BOUNDARIES', boundary_smooth: 'ALL', use_creases: true, use_custom_normals: false, show_only_control_edges: true, use_sculpt_base_mesh: false }),
    apply: multiresMod,
  },
];

for (const t of multiresModifiers) registerModifier(t);
