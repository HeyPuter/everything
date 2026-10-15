// Modifier stack implementations (independently implemented geometry algorithms).
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ModifierBase } from '../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from './types';
import { MeshBuilder, appendMesh, weightsOf, groupWeights, vertexNormals } from './meshbuild';
import { edgeTopology, polyNormal, triangulatePoly, vertexFaces } from '../mesh/mesh';
import { armatureDeform } from './mods/skinning';
import { proceduralTexture } from './textures';
import { evalCurve } from '../nodes/curves';
import { SurfaceQuery, PointQuery } from './mods/spatial';

const num = (m: ModifierBase, k: string, d = 0) => (typeof m[k] === 'number' ? (m[k] as number) : d);
const bool = (m: ModifierBase, k: string, d = false) => (typeof m[k] === 'boolean' ? (m[k] as boolean) : d);
const str = (m: ModifierBase, k: string, d = '') => (typeof m[k] === 'string' ? (m[k] as string) : d);

function objectSpaceOf(ctx: ModifierContext, id: unknown): Matrix4 | null {
  const t = typeof id === 'string' ? ctx.graph.get(id) : undefined;
  if (!t) return null;
  const own = ctx.graph.get(ctx.ob.id)!.world;
  return own.clone().invert().multiply(t.world);
}

// ---------------------------------------------------------------------------
// Catmull–Clark subdivision

/** How mesh (or UV) boundaries behave while subdividing. */
export type BoundaryMode = 'SMOOTH' | 'CORNERS' | 'LINEAR';

export interface SubdivOptions {
  /** boundary smoothing: smooth everything, keep corners (vertices with two edges) or keep boundaries linear */
  boundary?: BoundaryMode;
  /** move the final vertices onto the limit surface */
  limit?: boolean;
  /** UV smoothing (NONE keeps UVs linear) */
  uvSmooth?: string;
}

export function catmullClark(m: EvalMesh, levels: number, simple = false, useCreases = true, opts: SubdivOptions = {}): EvalMesh {
  let mesh = m;
  const boundary = opts.boundary ?? 'SMOOTH';
  const uvMode = !simple && opts.uvSmooth && opts.uvSmooth !== 'NONE' ? opts.uvSmooth : null;
  let uvMesh = uvMode && levels > 0 ? uvTopology(m) : null;
  const uvBoundary: BoundaryMode = uvMode === 'SMOOTH_ALL' ? 'SMOOTH' : uvMode === 'PRESERVE_BOUNDARIES' ? 'LINEAR' : 'CORNERS';
  for (let l = 0; l < levels; l++) {
    mesh = subdivideOnce(mesh, simple, useCreases, boundary);
    if (uvMesh) uvMesh = subdivideOnce(uvMesh, false, false, uvBoundary);
  }
  if (levels > 0 && !simple && opts.limit) mesh = { ...mesh, positions: limitPositions(mesh, boundary, useCreases) };
  if (uvMesh) {
    const P = opts.limit ? limitPositions(uvMesh, uvBoundary, false) : uvMesh.positions;
    const uvs = new Float32Array(mesh.indices.length * 2);
    for (let c = 0; c < uvMesh.indices.length; c++) {
      uvs[c * 2] = P[uvMesh.indices[c] * 3];
      uvs[c * 2 + 1] = P[uvMesh.indices[c] * 3 + 1];
    }
    mesh = { ...mesh, uvs };
  }
  return mesh;
}

/** The UV layout as a mesh: one vertex per distinct (vertex, uv) pair, same faces and corners. */
function uvTopology(m: EvalMesh): EvalMesh {
  const ids = new Map<string, number>();
  const pos: number[] = [];
  const indices = new Uint32Array(m.indices.length);
  for (let c = 0; c < m.indices.length; c++) {
    const u = m.uvs[c * 2] ?? 0,
      v = m.uvs[c * 2 + 1] ?? 0;
    const key = `${m.indices[c]}:${Math.round(u * 1e6)}:${Math.round(v * 1e6)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      pos.push(u, v, 0);
      ids.set(key, id);
    }
    indices[c] = id;
  }
  return { positions: new Float32Array(pos), offsets: m.offsets, indices, uvs: new Float32Array(m.indices.length * 2), normals: new Float32Array(0) };
}

/**
 * Positions on the Catmull–Clark limit surface of an all-quad mesh: interior vertices use the
 * valence-weighted average of edge and diagonal neighbours, boundary (and fully creased) vertices
 * the 1-4-1 rule along their boundary, and corners stay put.
 */
export function limitPositions(m: EvalMesh, boundary: BoundaryMode, useCreases = true): Float32Array {
  const P = m.positions,
    nv = P.length / 3;
  const et = edgeTopology(m);
  const out = new Float32Array(P);
  const sharpEdge = new Uint8Array(et.count);
  for (let e = 0; e < et.count; e++) if (et.faceOffsets[e + 1] - et.faceOffsets[e] !== 2) sharpEdge[e] = 1;
  if (useCreases && m.creases) for (let c = 0; c < m.indices.length; c++) if (m.creases[c] >= 1) sharpEdge[et.cornerEdge[c]] = 1;
  const valence = new Uint32Array(nv),
    sharpN: number[][] = Array.from({ length: nv }, () => []);
  const eSum = new Float64Array(nv * 3);
  for (let e = 0; e < et.count; e++) {
    const a = et.verts[e * 2],
      b = et.verts[e * 2 + 1];
    valence[a]++;
    valence[b]++;
    for (let k = 0; k < 3; k++) {
      eSum[a * 3 + k] += P[b * 3 + k];
      eSum[b * 3 + k] += P[a * 3 + k];
    }
    if (sharpEdge[e]) {
      sharpN[a].push(b);
      sharpN[b].push(a);
    }
  }
  // diagonal (opposite) corners of each vertex's quads
  const fSum = new Float64Array(nv * 3),
    fCount = new Uint32Array(nv),
    allQuads = new Uint8Array(nv).fill(1);
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    for (let c = s; c < e; c++) {
      const v = m.indices[c];
      if (e - s !== 4) {
        allQuads[v] = 0;
        continue;
      }
      const o = m.indices[s + ((c - s + 2) % 4)];
      for (let k = 0; k < 3; k++) fSum[v * 3 + k] += P[o * 3 + k];
      fCount[v]++;
    }
  }
  for (let v = 0; v < nv; v++) {
    const sn = sharpN[v];
    if (sn.length === 0) {
      const n = valence[v];
      if (!n || !allQuads[v] || fCount[v] !== n) continue;
      for (let k = 0; k < 3; k++) out[v * 3 + k] = (n * n * P[v * 3 + k] + 4 * eSum[v * 3 + k] + fSum[v * 3 + k]) / (n * (n + 5));
    } else if (sn.length === 2) {
      // a boundary (or creased) curve through the vertex; boundary corners may stay fixed
      if (boundary === 'LINEAR' || (boundary === 'CORNERS' && valence[v] === 2)) continue;
      for (let k = 0; k < 3; k++) out[v * 3 + k] = (P[sn[0] * 3 + k] + 4 * P[v * 3 + k] + P[sn[1] * 3 + k]) / 6;
    }
  }
  return out;
}

function subdivideOnce(m: EvalMesh, simple: boolean, useCreases: boolean, boundary: BoundaryMode = 'SMOOTH'): EvalMesh {
  const P = m.positions,
    nv = P.length / 3,
    nf = m.offsets.length - 1;
  const et = edgeTopology(m),
    ne = et.count;
  const groups = m.weights?.length ?? 0;
  const b = new MeshBuilder(groups, !!m.colors);
  // face points
  const fp = new Float64Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1],
      k = e - s;
    for (let c = s; c < e; c++) for (let a = 0; a < 3; a++) fp[f * 3 + a] += P[m.indices[c] * 3 + a] / k;
  }
  // edge crease per edge
  const crease = new Float32Array(ne);
  if (useCreases && m.creases) for (let c = 0; c < m.indices.length; c++) crease[et.cornerEdge[c]] = Math.max(crease[et.cornerEdge[c]], m.creases[c]);
  const boundaryEdge = new Uint8Array(ne);
  for (let e = 0; e < ne; e++) if (et.faceOffsets[e + 1] - et.faceOffsets[e] !== 2) boundaryEdge[e] = 1;
  // edge points
  const ep = new Float64Array(ne * 3);
  for (let e = 0; e < ne; e++) {
    const a = et.verts[e * 2],
      bb = et.verts[e * 2 + 1];
    for (let k = 0; k < 3; k++) {
      const mid = (P[a * 3 + k] + P[bb * 3 + k]) / 2;
      if (simple || boundaryEdge[e]) ep[e * 3 + k] = mid;
      else {
        const f0 = et.faces[et.faceOffsets[e]],
          f1 = et.faces[et.faceOffsets[e] + 1];
        const smooth = (P[a * 3 + k] + P[bb * 3 + k] + fp[f0 * 3 + k] + fp[f1 * 3 + k]) / 4;
        ep[e * 3 + k] = smooth + (mid - smooth) * Math.min(1, crease[e]);
      }
    }
  }
  // vertex points
  const vp = new Float64Array(nv * 3);
  const valence = new Uint32Array(nv),
    bcount = new Uint32Array(nv),
    ccount = new Uint32Array(nv);
  const Rsum = new Float64Array(nv * 3),
    Bsum = new Float64Array(nv * 3),
    Csum = new Float64Array(nv * 3),
    creaseSum = new Float32Array(nv);
  for (let e = 0; e < ne; e++) {
    const a = et.verts[e * 2],
      bb = et.verts[e * 2 + 1];
    for (const [v, o] of [
      [a, bb],
      [bb, a],
    ]) {
      valence[v]++;
      for (let k = 0; k < 3; k++) Rsum[v * 3 + k] += (P[v * 3 + k] + P[o * 3 + k]) / 2;
      if (boundaryEdge[e]) {
        bcount[v]++;
        for (let k = 0; k < 3; k++) Bsum[v * 3 + k] += P[o * 3 + k];
      }
      if (crease[e] > 0) {
        ccount[v]++;
        creaseSum[v] += crease[e];
        for (let k = 0; k < 3; k++) Csum[v * 3 + k] += P[o * 3 + k];
      }
    }
  }
  const vf = vertexFaces(m);
  for (let v = 0; v < nv; v++) {
    const n = valence[v];
    if (simple || n === 0) {
      for (let k = 0; k < 3; k++) vp[v * 3 + k] = P[v * 3 + k];
      continue;
    }
    if (bcount[v] >= 2) {
      const keep = bcount[v] !== 2 || boundary === 'LINEAR' || (boundary === 'CORNERS' && n === 2);
      if (!keep) for (let k = 0; k < 3; k++) vp[v * 3 + k] = (Bsum[v * 3 + k] + 6 * P[v * 3 + k]) / 8;
      else for (let k = 0; k < 3; k++) vp[v * 3 + k] = P[v * 3 + k];
      continue;
    }
    const nfv = vf.offsets[v + 1] - vf.offsets[v];
    const Q = [0, 0, 0];
    for (let i = vf.offsets[v]; i < vf.offsets[v + 1]; i++) for (let k = 0; k < 3; k++) Q[k] += fp[vf.faces[i] * 3 + k] / nfv;
    const smooth = [0, 1, 2].map((k) => (Q[k] + 2 * (Rsum[v * 3 + k] / n) + (n - 3) * P[v * 3 + k]) / n);
    let out = smooth;
    if (ccount[v] === 2) {
      const sharp = [0, 1, 2].map((k) => (Csum[v * 3 + k] + 6 * P[v * 3 + k]) / 8);
      const w = Math.min(1, creaseSum[v] / 2);
      out = smooth.map((s, k) => s + (sharp[k] - s) * w);
    } else if (ccount[v] > 2) {
      const w = Math.min(1, creaseSum[v] / ccount[v]);
      out = smooth.map((s, k) => s + (P[v * 3 + k] - s) * w);
    }
    for (let k = 0; k < 3; k++) vp[v * 3 + k] = out[k];
  }
  // emit vertices: original, edge, face
  for (let v = 0; v < nv; v++) b.addVert(vp[v * 3], vp[v * 3 + 1], vp[v * 3 + 2], m.origIndex ? m.origIndex[v] : v, weightsOf(m, v));
  const ebase = nv;
  for (let e = 0; e < ne; e++) {
    const a = et.verts[e * 2],
      bb = et.verts[e * 2 + 1];
    const w = m.weights ? m.weights.map((g) => ((g[a] ?? 0) + (g[bb] ?? 0)) / 2) : undefined;
    b.addVert(ep[e * 3], ep[e * 3 + 1], ep[e * 3 + 2], -1, w);
  }
  const fbase = nv + ne;
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    const w = m.weights ? m.weights.map((g) => {
      let sum = 0;
      for (let c = s; c < e; c++) sum += g[m.indices[c]] ?? 0;
      return sum / (e - s);
    }) : undefined;
    b.addVert(fp[f * 3], fp[f * 3 + 1], fp[f * 3 + 2], -1, w);
  }
  // faces
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1],
      k = e - s;
    let fu = 0,
      fv = 0;
    const fc = [0, 0, 0, 0];
    for (let c = s; c < e; c++) {
      fu += m.uvs[c * 2] / k;
      fv += m.uvs[c * 2 + 1] / k;
      if (m.colors) for (let q = 0; q < 4; q++) fc[q] += m.colors[c * 4 + q] / k;
    }
    for (let i = 0; i < k; i++) {
      const c = s + i,
        cn = s + ((i + 1) % k),
        cp = s + ((i + k - 1) % k);
      const eNext = et.cornerEdge[c],
        ePrev = et.cornerEdge[cp];
      const uv = [
        m.uvs[c * 2],
        m.uvs[c * 2 + 1],
        (m.uvs[c * 2] + m.uvs[cn * 2]) / 2,
        (m.uvs[c * 2 + 1] + m.uvs[cn * 2 + 1]) / 2,
        fu,
        fv,
        (m.uvs[c * 2] + m.uvs[cp * 2]) / 2,
        (m.uvs[c * 2 + 1] + m.uvs[cp * 2 + 1]) / 2,
      ];
      let colors: number[] | undefined;
      if (m.colors) {
        const col = (cc: number) => [0, 1, 2, 3].map((q) => m.colors![cc * 4 + q]);
        const a = col(c),
          nx = col(cn),
          pv = col(cp);
        colors = [...a, ...a.map((x, q) => (x + nx[q]) / 2), ...fc, ...a.map((x, q) => (x + pv[q]) / 2)];
      }
      // carry seams/sharp/creases onto the halves of original edges
      const seam = m.seams ? [m.seams[c], 0, 0, m.seams[cp]] : undefined;
      const sharp = m.sharp ? [m.sharp[c], 0, 0, m.sharp[cp]] : undefined;
      const creases = m.creases ? [Math.max(0, m.creases[c] - 1), 0, 0, Math.max(0, m.creases[cp] - 1)] : undefined;
      b.addFace([m.indices[c], ebase + eNext, fbase + f, ebase + ePrev], uv, m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0, { seams: seam, sharp, creases, colors });
    }
  }
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle, instances: m.instances });
}

// ---------------------------------------------------------------------------
// Mirror (with optional bisect and merge)

function bisect(m: EvalMesh, axis: number, keepPositive: boolean, origin: number, threshold = 1e-6): EvalMesh {
  const P = m.positions,
    nf = m.offsets.length - 1;
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const side = (v: number) => (P[v * 3 + axis] - origin) * (keepPositive ? 1 : -1);
  const vmap = new Int32Array(P.length / 3).fill(-1);
  const edgeVert = new Map<string, number>();
  const getVert = (v: number) => {
    if (vmap[v] < 0) vmap[v] = b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m.origIndex ? m.origIndex[v] : v, weightsOf(m, v));
    return vmap[v];
  };
  const cut = (a: number, c: number) => {
    const key = a < c ? `${a}_${c}` : `${c}_${a}`;
    let id = edgeVert.get(key);
    if (id === undefined) {
      const sa = side(a),
        sc = side(c),
        t = sa / (sa - sc);
      const p = [0, 1, 2].map((k) => P[a * 3 + k] + (P[c * 3 + k] - P[a * 3 + k]) * t);
      p[axis] = origin;
      const w = m.weights?.map((g) => (g[a] ?? 0) + ((g[c] ?? 0) - (g[a] ?? 0)) * t);
      id = b.addVert(p[0], p[1], p[2], -1, w);
      edgeVert.set(key, id);
    }
    return id;
  };
  const eps = Math.max(1e-7, threshold);
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1],
      k = e - s;
    const verts: number[] = [],
      uvs: number[] = [];
    let anyIn = false,
      allIn = true;
    for (let c = s; c < e; c++) {
      const sd = side(m.indices[c]);
      if (sd > -eps) anyIn = true;
      if (sd < -eps) allIn = false;
    }
    if (!anyIn) continue;
    for (let i = 0; i < k; i++) {
      const c = s + i,
        cn = s + ((i + 1) % k);
      const v = m.indices[c],
        vn = m.indices[cn];
      const sv = side(v),
        sn = side(vn);
      if (sv >= -eps) {
        verts.push(getVert(v));
        uvs.push(m.uvs[c * 2], m.uvs[c * 2 + 1]);
      }
      if (!allIn && ((sv > eps && sn < -eps) || (sv < -eps && sn > eps))) {
        const t = sv / (sv - sn);
        verts.push(cut(v, vn));
        uvs.push(m.uvs[c * 2] + (m.uvs[cn * 2] - m.uvs[c * 2]) * t, m.uvs[c * 2 + 1] + (m.uvs[cn * 2 + 1] - m.uvs[c * 2 + 1]) * t);
      }
    }
    // remove consecutive duplicates
    const vv: number[] = [],
      uu: number[] = [];
    verts.forEach((v, i) => {
      if (vv.length && vv[vv.length - 1] === v) return;
      vv.push(v);
      uu.push(uvs[i * 2], uvs[i * 2 + 1]);
    });
    if (vv.length > 1 && vv[0] === vv[vv.length - 1]) {
      vv.pop();
      uu.length -= 2;
    }
    if (vv.length >= 3) b.addFace(vv, uu, m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0);
  }
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle });
}

function mirrorMesh(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const axes = (mod.use_axis as boolean[]) ?? [true, false, false];
  const bisectAxes = (mod.use_bisect_axis as boolean[]) ?? [false, false, false];
  const flipAxes = (mod.use_bisect_flip_axis as boolean[]) ?? [false, false, false];
  const merge = bool(mod, 'use_mirror_merge', true),
    tol = num(mod, 'merge_threshold', 0.001);
  const mirrorOb = mod.mirror_object ? objectSpaceOf(ctx, mod.mirror_object) : null;
  let mesh = m;
  for (let axis = 0; axis < 3; axis++) {
    if (!axes[axis]) continue;
    // transform into mirror object space when present
    const toMirror = mirrorOb ? mirrorOb.clone().invert() : null;
    let local = mesh;
    if (toMirror) local = transformMesh(mesh, toMirror);
    if (bisectAxes[axis]) local = bisect(local, axis, !flipAxes[axis], 0, num(mod, 'bisect_threshold', 0.001));
    const P = local.positions,
      nv = P.length / 3;
    const b = new MeshBuilder(local.weights?.length ?? 0, !!local.colors);
    const ident = new Int32Array(nv);
    for (let v = 0; v < nv; v++) ident[v] = b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], local.origIndex ? local.origIndex[v] : v, weightsOf(local, v));
    const mapB = new Int32Array(nv);
    // vertex group name mirroring (".L" ↔ ".R")
    const flipW = local.vertex_groups && bool(mod, 'use_mirror_vertex_groups', true) ? mirrorGroupMap(local.vertex_groups.map((g) => g.name)) : null;
    for (let v = 0; v < nv; v++) {
      if (merge && Math.abs(P[v * 3 + axis]) <= tol) {
        mapB[v] = ident[v];
        continue;
      }
      const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      p[axis] = -p[axis];
      let w = weightsOf(local, v);
      if (w && flipW) w = flipW.map((src) => w![src]);
      mapB[v] = b.addVert(p[0], p[1], p[2], -1, w);
    }
    appendMesh(b, local, ident);
    const mirrored = { ...local, uvs: local.uvs };
    const ou = num(mod, 'offset_u'),
      ov = num(mod, 'offset_v');
    if (bool(mod, 'use_mirror_u') || bool(mod, 'use_mirror_v') || ou || ov) {
      const uv = local.uvs.slice();
      for (let i = 0; i < uv.length; i += 2) {
        if (bool(mod, 'use_mirror_u')) uv[i] = 1 - uv[i] + num(mod, 'mirror_offset_u');
        if (bool(mod, 'use_mirror_v')) uv[i + 1] = 1 - uv[i + 1] + num(mod, 'mirror_offset_v');
        uv[i] += ou;
        uv[i + 1] += ov;
      }
      mirrored.uvs = uv;
    }
    appendMesh(b, mirrored, mapB, true);
    let result = b.build({ vertex_groups: local.vertex_groups, auto_smooth_angle: local.auto_smooth_angle, instances: local.instances });
    if (toMirror) result = transformMesh(result, mirrorOb!);
    // drop faces that collapsed (all verts on plane mirrored onto themselves)
    mesh = removeDegenerate(result);
  }
  return mesh;
}

function mirrorGroupMap(names: string[]): number[] {
  const swap = (n: string) =>
    n.replace(/([._-])([LlRr])$/, (_, s, c) => s + ({ L: 'R', R: 'L', l: 'r', r: 'l' } as Record<string, string>)[c]).replace(/(Left|left|Right|right)/, (x) => ({ Left: 'Right', left: 'right', Right: 'Left', right: 'left' } as Record<string, string>)[x]);
  return names.map((n) => {
    const i = names.indexOf(swap(n));
    return i >= 0 ? i : names.indexOf(n);
  });
}

export function transformMesh(m: EvalMesh, mat: Matrix4): EvalMesh {
  const P = new Float32Array(m.positions.length),
    v = new Vector3();
  for (let i = 0; i < P.length; i += 3) {
    v.set(m.positions[i], m.positions[i + 1], m.positions[i + 2]).applyMatrix4(mat);
    P[i] = v.x;
    P[i + 1] = v.y;
    P[i + 2] = v.z;
  }
  const flip = mat.determinant() < 0;
  if (!flip) return { ...m, positions: P };
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  for (let i = 0; i < P.length / 3; i++) b.addVert(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], m.origIndex ? m.origIndex[i] : i, weightsOf(m, i));
  appendMesh(b, m, Array.from({ length: P.length / 3 }, (_, i) => i), true);
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle, instances: m.instances });
}

function removeDegenerate(m: EvalMesh): EvalMesh {
  const nf = m.offsets.length - 1;
  let bad = false;
  for (let f = 0; f < nf && !bad; f++) {
    const s = new Set<number>();
    for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) s.add(m.indices[c]);
    if (s.size < 3) bad = true;
  }
  if (!bad) return m;
  const b = new MeshBuilder(m.weights?.length ?? 0);
  const P = m.positions;
  for (let v = 0; v < P.length / 3; v++) b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m.origIndex?.[v] ?? v, weightsOf(m, v));
  for (let f = 0; f < nf; f++) {
    const verts: number[] = [],
      uvs: number[] = [];
    for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
      const v = m.indices[c];
      if (verts.length && verts[verts.length - 1] === v) continue;
      verts.push(v);
      uvs.push(m.uvs[c * 2], m.uvs[c * 2 + 1]);
    }
    if (verts.length > 1 && verts[0] === verts[verts.length - 1]) verts.pop();
    if (new Set(verts).size >= 3) b.addFace(verts, uvs, m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0);
  }
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle });
}

// ---------------------------------------------------------------------------
// Merge by distance (weld)

export function weld(m: EvalMesh, threshold: number, onlyLoose = false, canMerge?: (u: number, v: number) => boolean): EvalMesh {
  const P = m.positions,
    nv = P.length / 3;
  const cell = Math.max(threshold, 1e-9);
  const grid = new Map<string, number[]>();
  const target = new Int32Array(nv).fill(-1);
  let isBoundary: Uint8Array | null = null;
  if (onlyLoose) {
    const et = edgeTopology(m);
    isBoundary = new Uint8Array(nv);
    for (let e = 0; e < et.count; e++) if (et.faceOffsets[e + 1] - et.faceOffsets[e] < 2) isBoundary[et.verts[e * 2]] = isBoundary[et.verts[e * 2 + 1]] = 1;
  }
  for (let v = 0; v < nv; v++) {
    if (isBoundary && !isBoundary[v]) {
      target[v] = v;
      continue;
    }
    const x = P[v * 3],
      y = P[v * 3 + 1],
      z = P[v * 3 + 2];
    const gx = Math.floor(x / cell),
      gy = Math.floor(y / cell),
      gz = Math.floor(z / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const list = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (!list) continue;
          for (const u of list)
            if ((P[u * 3] - x) ** 2 + (P[u * 3 + 1] - y) ** 2 + (P[u * 3 + 2] - z) ** 2 <= threshold * threshold && (!canMerge || canMerge(u, v))) {
              found = u;
              break;
            }
        }
    if (found >= 0) target[v] = target[found];
    else target[v] = v;
    // with a merge rule, merged vertices stay candidates so chains (copy 0 ← 1 ← 2) resolve
    if (found < 0 || canMerge) {
      const key = `${gx},${gy},${gz}`;
      const list = grid.get(key);
      if (list) list.push(v);
      else grid.set(key, [v]);
    }
  }
  let changed = false;
  for (let v = 0; v < nv; v++) if (target[v] !== v) changed = true;
  if (!changed) return m;
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const remap = new Int32Array(nv).fill(-1);
  for (let v = 0; v < nv; v++)
    if (target[v] === v) remap[v] = b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m.origIndex?.[v] ?? v, weightsOf(m, v));
  for (let v = 0; v < nv; v++) if (target[v] !== v) remap[v] = remap[target[v]];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const verts: number[] = [],
      uvs: number[] = [];
    for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
      const v = remap[m.indices[c]];
      if (verts.includes(v)) continue;
      verts.push(v);
      uvs.push(m.uvs[c * 2], m.uvs[c * 2 + 1]);
    }
    if (verts.length >= 3) b.addFace(verts, uvs, m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0);
  }
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle, instances: m.instances });
}

// ---------------------------------------------------------------------------

/** Weld: merge all close vertices, or only the ends of short edges ("connected"). */
function weldMod(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const thr = num(mod, 'merge_threshold', 0.001);
  const gw = groupWeights(m, str(mod, 'vertex_group'));
  const inv = bool(mod, 'invert_vertex_group');
  const allowed = gw ? (v: number) => (gw[v] > 0) !== inv : () => true;
  if (str(mod, 'mode', 'ALL') !== 'CONNECTED') return weld(m, thr, false, gw ? (u, v) => allowed(u) && allowed(v) : undefined);
  // connected: collapse edges shorter than the distance (only loose edges on request)
  const P = m.positions,
    nv = P.length / 3;
  const parent = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const tryEdge = (a: number, b: number) => {
    if (!allowed(a) || !allowed(b)) return;
    if ((P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2 > thr * thr) return;
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  if (!bool(mod, 'loose_edges')) {
    const et = edgeTopology(m);
    for (let e = 0; e < et.count; e++) tryEdge(et.verts[e * 2], et.verts[e * 2 + 1]);
  }
  if (m.looseEdges) for (let i = 0; i + 1 < m.looseEdges.length; i += 2) tryEdge(m.looseEdges[i], m.looseEdges[i + 1]);
  let changed = false;
  for (let v = 0; v < nv; v++) if (find(v) !== v) changed = true;
  if (!changed) return m;
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const remap = new Int32Array(nv).fill(-1);
  for (let v = 0; v < nv; v++) if (find(v) === v) remap[v] = b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m.origIndex?.[v] ?? v, weightsOf(m, v));
  for (let v = 0; v < nv; v++) remap[v] = remap[find(v)];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const verts: number[] = [],
      uvs: number[] = [];
    for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
      const v = remap[m.indices[c]];
      if (verts.includes(v)) continue;
      verts.push(v);
      uvs.push(m.uvs[c * 2], m.uvs[c * 2 + 1]);
    }
    if (verts.length >= 3) b.addFace(verts, uvs, m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0);
  }
  const out = b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle, instances: m.instances });
  if (m.looseEdges) {
    const le: number[] = [];
    for (let i = 0; i + 1 < m.looseEdges.length; i += 2) {
      const a = remap[m.looseEdges[i]],
        c = remap[m.looseEdges[i + 1]];
      if (a !== c) le.push(a, c);
    }
    if (le.length) out.looseEdges = Uint32Array.from(le);
  }
  return out;
}

function arrayMesh(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  let count = Math.max(1, Math.round(num(mod, 'count', 2)));
  const rel = (mod.relative_offset_displace as number[]) ?? [1, 0, 0];
  const cst = (mod.constant_offset_displace as number[]) ?? [0, 0, 0];
  const useRel = bool(mod, 'use_relative_offset', true),
    useCst = bool(mod, 'use_constant_offset'),
    useObj = bool(mod, 'use_object_offset');
  const P = m.positions;
  let min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], P[i + a]);
      max[a] = Math.max(max[a], P[i + a]);
    }
  if (min[0] === Infinity) min = max = [0, 0, 0];
  const step = new Matrix4();
  const off = new Vector3();
  if (useRel) off.add(new Vector3(rel[0] * (max[0] - min[0]), rel[1] * (max[1] - min[1]), rel[2] * (max[2] - min[2])));
  if (useCst) off.add(new Vector3(cst[0], cst[1], cst[2]));
  step.makeTranslation(off.x, off.y, off.z);
  if (useObj && mod.offset_object) {
    const om = objectSpaceOf(ctx, mod.offset_object);
    if (om) step.premultiply(om);
  }
  const fit = str(mod, 'fit_type', 'FIXED_COUNT');
  if (fit === 'FIT_LENGTH' || fit === 'FIT_CURVE') {
    const len = off.length() || 1;
    let target = num(mod, 'fit_length', 4);
    if (fit === 'FIT_CURVE') {
      const cid = typeof mod.curve === 'string' ? mod.curve : null;
      const cob = cid ? ctx.doc.objects[cid] : undefined;
      const cu = cob?.data ? ctx.doc.curves[cob.data] : undefined;
      target = 0;
      for (const sp of cu?.splines ?? []) {
        const pts = sampleSpline(sp, cu!.resolution_u).points;
        for (let i = 1; i < pts.length; i++) target += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
      }
    }
    count = Math.max(1, Math.floor(target / len + 1e-6) + 1);
  }
  count = Math.min(count, 1000);
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const cur = new Matrix4();
  const v = new Vector3();
  const nv = P.length / 3;
  const uOff = num(mod, 'offset_u'),
    vOff = num(mod, 'offset_v');
  const copyOf: number[] = [];
  for (let i = 0; i < count; i++) {
    const map = new Int32Array(nv);
    for (let k = 0; k < nv; k++) {
      v.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]).applyMatrix4(cur);
      map[k] = b.addVert(v.x, v.y, v.z, i === 0 ? m.origIndex?.[k] ?? k : -1, weightsOf(m, k));
      copyOf.push(i);
    }
    let src = m;
    if (uOff || vOff) {
      const uv = m.uvs.slice();
      for (let q = 0; q < uv.length; q += 2) {
        uv[q] += uOff * i;
        uv[q + 1] += vOff * i;
      }
      src = { ...m, uvs: uv };
    }
    appendMesh(b, src, map);
    cur.premultiply(step);
  }
  // caps: another object's mesh (in its own local coordinates) one step before the first copy
  // and one step after the last
  const cap = (id: unknown, mat: Matrix4, slot: number) => {
    const ev = typeof id === 'string' && id !== ctx.ob.id ? ctx.graph.get(id) : undefined;
    const cm = ev?.mesh;
    if (!cm || cm.offsets.length < 2) return;
    const cmap = new Int32Array(cm.positions.length / 3);
    for (let k = 0; k < cmap.length; k++) {
      v.fromArray(cm.positions, k * 3).applyMatrix4(mat);
      cmap[k] = b.addVert(v.x, v.y, v.z, -1);
      copyOf.push(slot);
    }
    appendMesh(b, { ...cm, colors: m.colors && cm.colors ? cm.colors : undefined }, cmap);
  };
  cap(mod.start_cap, step.clone().invert(), -1);
  cap(mod.end_cap, cur, count);
  let out = b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle, instances: m.instances });
  if (bool(mod, 'use_merge_vertices')) {
    // merge neighbouring copies (and caps with the copies they touch); first and last on request
    const firstLast = bool(mod, 'use_merge_vertices_cap') && count > 2;
    out = weld(out, num(mod, 'merge_threshold', 0.01), false, (u, w) => {
      const a = copyOf[u],
        c = copyOf[w];
      return Math.abs(a - c) === 1 || (firstLast && ((a === 0 && c === count - 1) || (c === 0 && a === count - 1)));
    });
  }
  return out;
}

function solidify(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const t = num(mod, 'thickness', 0.01),
    offset = num(mod, 'offset', -1);
  const even = bool(mod, 'use_even_offset');
  const rim = bool(mod, 'use_rim', true),
    rimOnly = bool(mod, 'use_rim_only');
  const flip = bool(mod, 'use_flip_normals');
  const vn = vertexNormals(m);
  const P = m.positions,
    nv = P.length / 3;
  const groups = m.weights?.length ?? 0;
  const b = new MeshBuilder(groups, !!m.colors);
  const inner = (offset - 1) / 2,
    outer = (offset + 1) / 2;
  const a = new Int32Array(nv),
    c = new Int32Array(nv);
  // per-vertex thickness: vertex group (with the factor used at zero weight) and clamping
  const scale = new Float32Array(nv).fill(1);
  const gw = groupWeights(m, str(mod, 'vertex_group'));
  if (gw) {
    const f = num(mod, 'thickness_vertex_group', 0),
      inv = bool(mod, 'invert_vertex_group');
    for (let v = 0; v < nv; v++) {
      const w = inv ? 1 - gw[v] : gw[v];
      scale[v] = f + (1 - f) * w;
    }
  }
  if (even) {
    // even thickness: scale by 1/cos(angle) between vertex normal and adjacent face normals
    const vf = vertexFaces(m);
    const n: [number, number, number] = [0, 0, 0];
    for (let v = 0; v < nv; v++) {
      let sum = 0,
        k = 0;
      for (let i = vf.offsets[v]; i < vf.offsets[v + 1]; i++) {
        const f = vf.faces[i];
        polyNormal(P, m.indices.subarray(m.offsets[f], m.offsets[f + 1]), n);
        sum += Math.max(0.2, n[0] * vn[v * 3] + n[1] * vn[v * 3 + 1] + n[2] * vn[v * 3 + 2]);
        k++;
      }
      if (k) scale[v] /= sum / k;
    }
  }
  const clamp = num(mod, 'thickness_clamp', 0);
  if (clamp > 0) {
    const et = edgeTopology(m);
    const minLen = new Float32Array(nv).fill(Infinity);
    for (let e = 0; e < et.count; e++) {
      const x = et.verts[e * 2],
        y = et.verts[e * 2 + 1];
      const l = Math.hypot(P[x * 3] - P[y * 3], P[x * 3 + 1] - P[y * 3 + 1], P[x * 3 + 2] - P[y * 3 + 2]);
      minLen[x] = Math.min(minLen[x], l);
      minLen[y] = Math.min(minLen[y], l);
    }
    for (let v = 0; v < nv; v++) if (Number.isFinite(minLen[v]) && Math.abs(t * scale[v]) > minLen[v] * clamp) scale[v] = (Math.sign(scale[v]) * minLen[v] * clamp) / Math.abs(t || 1);
  }
  const shellG = (m.vertex_groups ?? []).findIndex((g) => g.name === str(mod, 'shell_vertex_group') && !!g.name);
  const rimG = (m.vertex_groups ?? []).findIndex((g) => g.name === str(mod, 'rim_vertex_group') && !!g.name);
  const wOf = (v: number, shell: boolean) => {
    const w = weightsOf(m, v);
    if (w && shell && shellG >= 0) w[shellG] = 1;
    return w;
  };
  for (let v = 0; v < nv; v++) {
    const s = scale[v];
    a[v] = b.addVert(P[v * 3] + vn[v * 3] * t * outer * s, P[v * 3 + 1] + vn[v * 3 + 1] * t * outer * s, P[v * 3 + 2] + vn[v * 3 + 2] * t * outer * s, m.origIndex?.[v] ?? v, wOf(v, false));
  }
  for (let v = 0; v < nv; v++) {
    const s = scale[v];
    c[v] = b.addVert(P[v * 3] + vn[v * 3] * t * inner * s, P[v * 3 + 1] + vn[v * 3 + 1] * t * inner * s, P[v * 3 + 2] + vn[v * 3 + 2] * t * inner * s, -1, wOf(v, true));
  }
  const matOff = Math.round(num(mod, 'material_offset')),
    rimMat = Math.round(num(mod, 'material_offset_rim'));
  if (!rimOnly) {
    appendMesh(b, m, a, flip);
    const shifted = matOff && m.material_index ? { ...m, material_index: m.material_index.map((x) => x + matOff) as Uint16Array } : m;
    appendMesh(b, shifted, c, !flip);
  }
  if (rim) {
    const et = edgeTopology(m);
    const cOuter = num(mod, 'edge_crease_outer'),
      cInner = num(mod, 'edge_crease_inner'),
      cRim = num(mod, 'edge_crease_rim');
    const creased = cOuter > 0 || cInner > 0 || cRim > 0;
    for (let ci = 0; ci < m.indices.length; ci++) {
      const e = et.cornerEdge[ci];
      if (et.faceOffsets[e + 1] - et.faceOffsets[e] !== 1) continue;
      const f = et.cornerFace[ci];
      const s = m.offsets[f],
        en = m.offsets[f + 1];
      const v0 = m.indices[ci],
        v1 = m.indices[ci + 1 < en ? ci + 1 : s];
      const quad = [a[v1], a[v0], c[v0], c[v1]];
      // edges: outer (a1-a0), rim (a0-c0), inner (c0-c1), rim (c1-a1)
      let creases = creased ? [cOuter, cRim, cInner, cRim] : undefined;
      if (flip) {
        quad.reverse();
        if (creases) creases = [cInner, cRim, cOuter, cRim];
      }
      b.addFace(quad, [0, 0, 1, 0, 1, 1, 0, 1], m.smooth?.[f] ?? 0, (m.material_index?.[f] ?? 0) + rimMat, { creases });
      if (rimG >= 0 && b.weights) for (const q of quad) b.weights[rimG][q] = 1;
    }
  }
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle });
}

/** Split a quad into two triangles (local corner indices) by the chosen rule. */
function quadSplit(P: ArrayLike<number>, q: ArrayLike<number>, method: string, face: number, out: number[]) {
  const d = (a: number, b: number) => Math.hypot(P[q[a] * 3] - P[q[b] * 3], P[q[a] * 3 + 1] - P[q[b] * 3 + 1], P[q[a] * 3 + 2] - P[q[b] * 3 + 2]);
  let use02 = true;
  if (method === 'SHORTEST_DIAGONAL') use02 = d(0, 2) <= d(1, 3);
  else if (method === 'LONGEST_DIAGONAL') use02 = d(0, 2) > d(1, 3);
  else if (method === 'FIXED_ALTERNATE') use02 = false;
  else if (method === 'BEAUTY') {
    // the split whose triangles are closest to equilateral (largest smallest angle)
    const minAngle = (a: number, b: number, c: number) => {
      const ab = d(a, b),
        bc = d(b, c),
        ca = d(c, a);
      const ang = (x: number, y: number, z: number) => Math.acos(Math.max(-1, Math.min(1, (x * x + y * y - z * z) / Math.max(1e-12, 2 * x * y))));
      return Math.min(ang(ab, ca, bc), ang(ab, bc, ca), ang(bc, ca, ab));
    };
    use02 = Math.min(minAngle(0, 1, 2), minAngle(0, 2, 3)) >= Math.min(minAngle(0, 1, 3), minAngle(1, 2, 3));
  }
  void face;
  if (use02) out.push(0, 1, 2, 0, 2, 3);
  else out.push(0, 1, 3, 1, 2, 3);
}

function triangulateMeshMod(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const minVerts = Math.max(4, Math.round(num(mod, 'min_vertices', 4)));
  const quadMethod = str(mod, 'quad_method', 'SHORTEST_DIAGONAL');
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const P = m.positions;
  for (let v = 0; v < P.length / 3; v++) b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m.origIndex?.[v] ?? v, weightsOf(m, v));
  const tmp: number[] = [];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    if (e - s < minVerts) {
      b.addFace(Array.from(m.indices.subarray(s, e)), Array.from(m.uvs.subarray(s * 2, e * 2)), m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0);
      continue;
    }
    tmp.length = 0;
    if (e - s === 4) quadSplit(P, m.indices.subarray(s, e), quadMethod, f, tmp);
    else triangulatePoly(P, m.indices.subarray(s, e), tmp, 0);
    for (let i = 0; i < tmp.length; i += 3) {
      const cs = [s + tmp[i], s + tmp[i + 1], s + tmp[i + 2]];
      b.addFace(cs.map((c) => m.indices[c]), cs.flatMap((c) => [m.uvs[c * 2], m.uvs[c * 2 + 1]]), m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0);
    }
  }
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle });
}

function screw(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const angle = num(mod, 'angle', Math.PI * 2),
    steps = Math.max(1, Math.round(ctx?.render ? num(mod, 'render_steps', 16) : num(mod, 'steps', 16))),
    iterations = Math.max(1, Math.round(num(mod, 'iterations', 1)));
  let height = num(mod, 'screw_offset', 0);
  const axis = ['X', 'Y', 'Z'].indexOf(str(mod, 'axis', 'Z'));
  const ax = new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  // an axis object sets the pivot and direction (its own axis), and optionally the screw offset
  const om = mod.object ? objectSpaceOf(ctx, mod.object) : null;
  const pivot = new Vector3();
  if (om) {
    pivot.setFromMatrixPosition(om);
    ax.transformDirection(om);
    if (bool(mod, 'use_object_screw_offset')) height = pivot.dot(ax);
  }
  const P = m.positions,
    nv = P.length / 3;
  // profile edges: loose edges or the edges of the input
  const et = edgeTopology(m);
  let pairs: number[] = [];
  if (m.offsets.length - 1 === 0) pairs = Array.from(m.looseEdges ?? []);
  else for (let e = 0; e < et.count; e++) pairs.push(et.verts[e * 2], et.verts[e * 2 + 1]);
  // a full turn without offset closes on itself
  const full = Math.abs(Math.abs(angle) - Math.PI * 2) < 1e-4 && !height && iterations === 1;
  const total = steps * iterations;
  const rings = full ? total : total + 1;
  const b = new MeshBuilder();
  const v = new Vector3();
  const ids: number[][] = [];
  for (let r = 0; r < rings; r++) {
    const t = r / total;
    const rot = new Matrix4().makeRotationAxis(ax, angle * iterations * t);
    const row: number[] = [];
    for (let k = 0; k < nv; k++) {
      v.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]).sub(pivot).applyMatrix4(rot).add(pivot).addScaledVector(ax, height * iterations * t);
      row.push(b.addVert(v.x, v.y, v.z, r === 0 ? k : -1));
    }
    ids.push(row);
  }
  const smooth = bool(mod, 'use_smooth_shade', true) ? 1 : 0;
  const flip = bool(mod, 'use_normal_flip') || bool(mod, 'use_flip'); // (older files used use_flip)
  const su = bool(mod, 'use_stretch_u'),
    sv = bool(mod, 'use_stretch_v');
  for (let i = 0; i < pairs.length; i += 2)
    for (let r = 0; r < total; r++) {
      const a = ids[r],
        c = ids[(r + 1) % rings];
      const p = pairs[i],
        q = pairs[i + 1];
      const u0 = su ? r / total : r / steps,
        u1 = su ? (r + 1) / total : (r + 1) / steps;
      const v0 = sv ? i / pairs.length : 0,
        v1 = sv ? (i + 2) / pairs.length : 1;
      const face = [a[p], a[q], c[q], c[p]];
      const uv = [u0, v0, u0, v1, u1, v1, u1, v0];
      if (flip) b.addFace([face[3], face[2], face[1], face[0]], [uv[6], uv[7], uv[4], uv[5], uv[2], uv[3], uv[0], uv[1]], smooth);
      else b.addFace(face, uv, smooth);
    }
  let out = b.build();
  if (bool(mod, 'use_merge_vertices')) out = weld(out, num(mod, 'merge_threshold', 0.01));
  return out;
}

function maskMesh(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  let w = groupWeights(m, str(mod, 'vertex_group'));
  if (str(mod, 'mode', 'VERTEX_GROUP') === 'ARMATURE') {
    // keep the vertices of the groups named after the armature's selected bones
    const arm = typeof mod.armature === 'string' ? ctx.doc.objects[mod.armature] : undefined;
    const ad = arm?.type === 'ARMATURE' && arm.data ? ctx.doc.armatures[arm.data] : undefined;
    if (!ad || !m.weights || !m.vertex_groups) return m;
    const names = new Set(ad.bones.filter((b) => b.select).map((b) => b.name));
    const groups = m.vertex_groups.map((g, i) => (names.has(g.name) ? m.weights![i] : null)).filter(Boolean) as Float32Array[];
    w = new Float32Array(m.positions.length / 3);
    for (const g of groups) for (let v = 0; v < w.length; v++) w[v] = Math.max(w[v], g[v]);
  }
  if (!w) return m;
  const thr = num(mod, 'threshold', 0),
    invert = bool(mod, 'invert_vertex_group');
  const keep = (v: number) => (w![v] > thr) !== invert;
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const P = m.positions,
    map = new Int32Array(P.length / 3).fill(-1);
  for (let v = 0; v < P.length / 3; v++) if (keep(v)) map[v] = b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m.origIndex?.[v] ?? v, weightsOf(m, v));
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    let ok = true;
    for (let c = s; c < e; c++) if (map[m.indices[c]] < 0) ok = false;
    if (ok) b.addFace(Array.from(m.indices.subarray(s, e), (v) => map[v]), Array.from(m.uvs.subarray(s * 2, e * 2)), m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0);
  }
  return b.build({ vertex_groups: m.vertex_groups });
}

function build(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const start = num(mod, 'frame_start', 1),
    len = Math.max(1, num(mod, 'frame_duration', 100));
  const nf = m.offsets.length - 1;
  let t = (ctx.frame - start) / len;
  if (bool(mod, 'use_reverse')) t = 1 - t;
  const count = Math.max(0, Math.min(nf, Math.floor(t * nf)));
  const order = Array.from({ length: nf }, (_, i) => i);
  if (bool(mod, 'use_random_order')) {
    let seed = num(mod, 'seed', 0) + 1;
    for (let i = nf - 1; i > 0; i--) {
      seed = (seed * 16807) % 2147483647;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  const keep = new Set(order.slice(0, count));
  const b = new MeshBuilder(m.weights?.length ?? 0);
  const P = m.positions;
  for (let v = 0; v < P.length / 3; v++) b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m.origIndex?.[v] ?? v, weightsOf(m, v));
  for (let f = 0; f < nf; f++) {
    if (!keep.has(f)) continue;
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    b.addFace(Array.from(m.indices.subarray(s, e)), Array.from(m.uvs.subarray(s * 2, e * 2)), m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0);
  }
  return b.build({ vertex_groups: m.vertex_groups });
}

function edgeSplit(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const useAngle = bool(mod, 'use_edge_angle', true),
    angle = num(mod, 'split_angle', (30 * Math.PI) / 180),
    useSharp = bool(mod, 'use_edge_sharp', true);
  const et = edgeTopology(m);
  const nf = m.offsets.length - 1;
  const fn = new Float32Array(nf * 3),
    n: [number, number, number] = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    polyNormal(m.positions, m.indices.subarray(m.offsets[f], m.offsets[f + 1]), n);
    fn.set(n, f * 3);
  }
  const split = new Uint8Array(et.count);
  const cosA = Math.cos(angle);
  for (let e = 0; e < et.count; e++) {
    const a = et.faceOffsets[e],
      b2 = et.faceOffsets[e + 1];
    if (b2 - a !== 2) continue;
    const f0 = et.faces[a],
      f1 = et.faces[a + 1];
    if (useAngle && fn[f0 * 3] * fn[f1 * 3] + fn[f0 * 3 + 1] * fn[f1 * 3 + 1] + fn[f0 * 3 + 2] * fn[f1 * 3 + 2] < cosA) split[e] = 1;
  }
  if (useSharp && m.sharp) for (let c = 0; c < m.indices.length; c++) if (m.sharp[c]) split[et.cornerEdge[c]] = 1;
  // union corners around each vertex across non-split edges
  const nc = m.indices.length;
  const parent = new Int32Array(nc).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const vf = vertexFaces(m);
  for (let e = 0; e < et.count; e++) {
    if (split[e] || et.faceOffsets[e + 1] - et.faceOffsets[e] !== 2) continue;
    const f0 = et.faces[et.faceOffsets[e]],
      f1 = et.faces[et.faceOffsets[e] + 1];
    for (const v of [et.verts[e * 2], et.verts[e * 2 + 1]]) {
      let c0 = -1,
        c1 = -1;
      for (let k = vf.offsets[v]; k < vf.offsets[v + 1]; k++) {
        if (vf.faces[k] === f0) c0 = vf.corners[k];
        if (vf.faces[k] === f1) c1 = vf.corners[k];
      }
      if (c0 >= 0 && c1 >= 0) parent[find(c0)] = find(c1);
    }
  }
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const rootVert = new Map<number, number>();
  const P = m.positions;
  const cornerVert = new Int32Array(nc);
  for (let c = 0; c < nc; c++) {
    const r = find(c);
    let id = rootVert.get(r);
    if (id === undefined) {
      const v = m.indices[c];
      id = b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m.origIndex?.[v] ?? v, weightsOf(m, v));
      rootVert.set(r, id);
    }
    cornerVert[c] = id;
  }
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    b.addFace(Array.from(cornerVert.subarray(s, e)), Array.from(m.uvs.subarray(s * 2, e * 2)), m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0);
  }
  return b.build({ vertex_groups: m.vertex_groups });
}

function wireframe(m: EvalMesh, mod: ModifierBase): EvalMesh {
  // Every face edge becomes a thin square tube: a pair of vertices above/below each vertex and an
  // inset point per face corner; each edge gets one quad on each side of its face.
  const P = m.positions,
    nv = P.length / 3,
    nf = m.offsets.length - 1;
  const t = num(mod, 'thickness', 0.02),
    o = num(mod, 'offset', 0);
  const vn = vertexNormals(m);
  const scale = new Float32Array(nv).fill(1);
  const gw = groupWeights(m, str(mod, 'vertex_group'));
  if (gw) {
    const f = num(mod, 'thickness_vertex_group', 0),
      inv = bool(mod, 'invert_vertex_group');
    for (let v = 0; v < nv; v++) scale[v] = f + (1 - f) * (inv ? 1 - gw[v] : gw[v]);
  }
  const even = bool(mod, 'use_even_offset', true);
  const replace = bool(mod, 'use_replace', true);
  const matOff = Math.round(num(mod, 'material_offset', 0));
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const keep = new Int32Array(nv);
  if (!replace) for (let v = 0; v < nv; v++) keep[v] = b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m.origIndex?.[v] ?? v, weightsOf(m, v));
  const top = new Int32Array(nv),
    bot = new Int32Array(nv);
  for (let v = 0; v < nv; v++) {
    const up = t * (o + 1) * 0.5 * scale[v],
      dn = t * (o - 1) * 0.5 * scale[v];
    bot[v] = b.addVert(P[v * 3] + vn[v * 3] * dn, P[v * 3 + 1] + vn[v * 3 + 1] * dn, P[v * 3 + 2] + vn[v * 3 + 2] * dn, replace ? m.origIndex?.[v] ?? v : -1, weightsOf(m, v));
    top[v] = b.addVert(P[v * 3] + vn[v * 3] * up, P[v * 3 + 1] + vn[v * 3 + 1] * up, P[v * 3 + 2] + vn[v * 3 + 2] * up, -1, weightsOf(m, v));
  }
  const et = bool(mod, 'use_boundary') ? edgeTopology(m) : null;
  const pa = new Vector3(),
    pp = new Vector3(),
    pn = new Vector3();
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1],
      k = e - s;
    const inset: number[] = [];
    const outer: number[] = [];
    // the inset ring sits between the top and bottom vertices (it follows the offset)
    const fnrm: [number, number, number] = [0, 0, 0];
    polyNormal(P, m.indices.subarray(s, e), fnrm);
    const lift = (t * o) / 2;
    for (let i = 0; i < k; i++) {
      const v = m.indices[s + i],
        vp = m.indices[s + ((i + k - 1) % k)],
        vx = m.indices[s + ((i + 1) % k)];
      pa.fromArray(P, v * 3);
      pp.fromArray(P, vp * 3).sub(pa);
      pn.fromArray(P, vx * 3).sub(pa);
      const lp = pp.length(),
        ln = pn.length();
      pp.normalize();
      pn.normalize();
      const bis = pp.clone().add(pn);
      const half = pp.angleTo(pn) / 2;
      // even: keep the wire width constant at any corner angle; otherwise a fixed step along the
      // bisector (exact for right angles)
      const d = Math.min(((t / 2) * scale[v]) / (even ? Math.max(0.05, Math.sin(half)) : Math.SQRT1_2), (0.5 * Math.min(lp, ln)) / Math.max(0.05, Math.cos(half)));
      if (bis.lengthSq() < 1e-12) bis.set(0, 0, 0);
      else bis.normalize();
      const q = pa.clone().addScaledVector(bis, d).add(new Vector3(fnrm[0], fnrm[1], fnrm[2]).multiplyScalar(lift * scale[v]));
      inset.push(b.addVert(q.x, q.y, q.z, -1, weightsOf(m, v)));
      if (et) {
        const r = pa.clone().addScaledVector(bis, -d).add(new Vector3(fnrm[0], fnrm[1], fnrm[2]).multiplyScalar(lift * scale[v]));
        outer.push(b.addVert(r.x, r.y, r.z, -1, weightsOf(m, v)));
      }
    }
    const mat = (m.material_index?.[f] ?? 0) + matOff;
    const smooth = m.smooth?.[f] ?? 0;
    for (let i = 0; i < k; i++) {
      const a = m.indices[s + i],
        c = m.indices[s + ((i + 1) % k)];
      const ia = inset[i],
        ic = inset[(i + 1) % k];
      b.addFace([ia, ic, bot[c], bot[a]], undefined, smooth, mat);
      b.addFace([ic, ia, top[a], top[c]], undefined, smooth, mat);
      if (et) {
        const edge = et.cornerEdge[s + i];
        if (et.faceOffsets[edge + 1] - et.faceOffsets[edge] === 1) {
          const oa = outer[i],
            oc = outer[(i + 1) % k];
          b.addFace([oc, oa, bot[a], bot[c]], undefined, smooth, mat);
          b.addFace([oa, oc, top[c], top[a]], undefined, smooth, mat);
        }
      }
    }
  }
  if (!replace) appendMesh(b, m, keep);
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle });
}

// ---------------------------------------------------------------------------
// Deform modifiers

function deform(m: EvalMesh, mod: ModifierBase, fn: (p: Vector3, i: number) => void): EvalMesh {
  const P = m.positions,
    out = new Float32Array(P.length);
  const w = groupWeights(m, str(mod, 'vertex_group'));
  const inv = bool(mod, 'invert_vertex_group');
  const v = new Vector3();
  for (let i = 0; i < P.length / 3; i++) {
    v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    const ox = v.x,
      oy = v.y,
      oz = v.z;
    fn(v, i);
    let f = 1;
    if (w) f = inv ? 1 - w[i] : w[i];
    out[i * 3] = ox + (v.x - ox) * f;
    out[i * 3 + 1] = oy + (v.y - oy) * f;
    out[i * 3 + 2] = oz + (v.z - oz) * f;
  }
  return { ...m, positions: out };
}

function smoothMesh(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const factor = num(mod, 'factor', 0.5),
    iters = Math.max(0, Math.round(num(mod, 'iterations', 1)));
  const axes = [bool(mod, 'use_x', true), bool(mod, 'use_y', true), bool(mod, 'use_z', true)];
  const et = edgeTopology(m);
  let P = m.positions;
  const nv = P.length / 3;
  const w = groupWeights(m, str(mod, 'vertex_group'));
  const inv = bool(mod, 'invert_vertex_group');
  for (let it = 0; it < iters; it++) {
    const sum = new Float64Array(nv * 3),
      cnt = new Uint32Array(nv);
    for (let e = 0; e < et.count; e++) {
      const a = et.verts[e * 2],
        b = et.verts[e * 2 + 1];
      for (let k = 0; k < 3; k++) {
        sum[a * 3 + k] += P[b * 3 + k];
        sum[b * 3 + k] += P[a * 3 + k];
      }
      cnt[a]++;
      cnt[b]++;
    }
    const out = new Float32Array(P);
    for (let v = 0; v < nv; v++) {
      if (!cnt[v]) continue;
      // towards the average of the edge midpoints (half way to the neighbours' average)
      const f = factor * 0.5 * (w ? (inv ? 1 - w[v] : w[v]) : 1);
      for (let k = 0; k < 3; k++) if (axes[k]) out[v * 3 + k] = P[v * 3 + k] + (sum[v * 3 + k] / cnt[v] - P[v * 3 + k]) * f;
    }
    P = out;
  }
  return { ...m, positions: P };
}

/** Cotangent weights of every edge (summed over the triangles of the faces around it). */
function cotangentWeights(m: EvalMesh, P: ArrayLike<number>): Map<number, number>[] {
  const nv = P.length / 3;
  const W: Map<number, number>[] = Array.from({ length: nv }, () => new Map());
  const add = (a: number, b: number, w: number) => {
    W[a].set(b, (W[a].get(b) ?? 0) + w);
    W[b].set(a, (W[b].get(a) ?? 0) + w);
  };
  const tmp: number[] = [];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const verts = m.indices.subarray(m.offsets[f], m.offsets[f + 1]);
    tmp.length = 0;
    triangulatePoly(P, verts, tmp, 0);
    const tris = tmp.length / 3;
    for (let t = 0; t < tmp.length; t += 3) {
      const tri = [verts[tmp[t]], verts[tmp[t + 1]], verts[tmp[t + 2]]];
      for (let k = 0; k < 3; k++) {
        const i = tri[k],
          j = tri[(k + 1) % 3],
          o = tri[(k + 2) % 3];
        const ux = P[i * 3] - P[o * 3],
          uy = P[i * 3 + 1] - P[o * 3 + 1],
          uz = P[i * 3 + 2] - P[o * 3 + 2];
        const vx = P[j * 3] - P[o * 3],
          vy = P[j * 3 + 1] - P[o * 3 + 1],
          vz = P[j * 3 + 2] - P[o * 3 + 2];
        const cx = uy * vz - uz * vy,
          cy = uz * vx - ux * vz,
          cz = ux * vy - uy * vx;
        const cot = (ux * vx + uy * vy + uz * vz) / Math.max(1e-12, Math.hypot(cx, cy, cz));
        add(i, j, cot / Math.max(1, tris - 1));
      }
    }
  }
  return W;
}

function signedVolume(m: EvalMesh, P: ArrayLike<number>): number {
  let v = 0;
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    const a = m.indices[s] * 3;
    for (let c = s + 1; c < e - 1; c++) {
      const b = m.indices[c] * 3,
        d = m.indices[c + 1] * 3;
      v += (P[a] * (P[b + 1] * P[d + 2] - P[b + 2] * P[d + 1]) - P[a + 1] * (P[b] * P[d + 2] - P[b + 2] * P[d]) + P[a + 2] * (P[b] * P[d + 1] - P[b + 1] * P[d])) / 6;
    }
  }
  return v;
}

/**
 * Laplacian smoothing: each repeat solves (I + λL) x' = x implicitly with cotangent weights
 * (normalized per vertex, or raw), border vertices using their own λ; optionally restoring the
 * volume afterwards.
 */
function laplacianSmooth(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const iters = Math.max(0, Math.round(num(mod, 'iterations', 1)));
  if (!iters || m.offsets.length < 2) return m;
  const lam = num(mod, 'lambda_factor', 0.01),
    lamB = num(mod, 'lambda_border', 0.01);
  const axes = [bool(mod, 'use_x', true), bool(mod, 'use_y', true), bool(mod, 'use_z', true)];
  const normalized = bool(mod, 'use_normalized', true);
  const nv = m.positions.length / 3;
  const et = edgeTopology(m);
  const border = new Uint8Array(nv);
  for (let e = 0; e < et.count; e++) if (et.faceOffsets[e + 1] - et.faceOffsets[e] < 2) border[et.verts[e * 2]] = border[et.verts[e * 2 + 1]] = 1;
  const gw = groupWeights(m, str(mod, 'vertex_group'));
  const inv = bool(mod, 'invert_vertex_group');
  const vol0 = signedVolume(m, m.positions);
  let x = Float64Array.from(m.positions);
  for (let it = 0; it < iters; it++) {
    const W = cotangentWeights(m, x);
    // vertex areas (a third of the adjacent triangles) scale raw weights when not normalizing
    const area = new Float64Array(nv);
    if (!normalized) {
      const tmp: number[] = [];
      for (let f = 0; f < m.offsets.length - 1; f++) {
        const vs = m.indices.subarray(m.offsets[f], m.offsets[f + 1]);
        tmp.length = 0;
        triangulatePoly(x, vs, tmp, 0);
        for (let t = 0; t < tmp.length; t += 3) {
          const a = vs[tmp[t]] * 3,
            b = vs[tmp[t + 1]] * 3,
            c = vs[tmp[t + 2]] * 3;
          const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
          const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
          const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
          area[a / 3] += ar / 3;
          area[b / 3] += ar / 3;
          area[c / 3] += ar / 3;
        }
      }
    }
    const rhs = Float64Array.from(x);
    const y = Float64Array.from(x);
    const lamOf = new Float64Array(nv);
    const sums = new Float64Array(nv);
    for (let v = 0; v < nv; v++) {
      let l = border[v] ? lamB : lam;
      if (gw) l *= inv ? 1 - gw[v] : gw[v];
      lamOf[v] = l;
      let s = 0;
      for (const w of W[v].values()) s += w;
      sums[v] = s;
    }
    // Gauss–Seidel sweeps of (1 + λΣw) y_i - λ Σ w_ij y_j = x_i
    for (let sweep = 0; sweep < 200; sweep++) {
      let change = 0;
      for (let v = 0; v < nv; v++) {
        const l = lamOf[v];
        if (!l || !sums[v]) continue;
        // raw weights are divided by (a multiple of) the vertex area so the step stays scale independent
        const norm = normalized ? 1 / sums[v] : 1 / Math.max(1e-9, 8 * area[v]);
        for (let k = 0; k < 3; k++) {
          if (!axes[k]) continue;
          let acc = 0;
          for (const [j, w] of W[v]) acc += w * norm * y[j * 3 + k];
          const nvx = (rhs[v * 3 + k] + l * acc) / (1 + l * sums[v] * norm);
          change = Math.max(change, Math.abs(nvx - y[v * 3 + k]));
          y[v * 3 + k] = nvx;
        }
      }
      if (change < 1e-9) break;
    }
    x = y;
  }
  if (bool(mod, 'use_volume_preserve', true)) {
    const vol1 = signedVolume(m, x);
    if (Math.abs(vol1) > 1e-12 && Math.abs(vol0) > 1e-12 && Math.sign(vol0) === Math.sign(vol1)) {
      const c = [0, 0, 0];
      for (let i = 0; i < x.length; i++) c[i % 3] += x[i] / nv;
      const k = Math.cbrt(vol0 / vol1);
      for (let i = 0; i < x.length; i++) x[i] = c[i % 3] + (x[i] - c[i % 3]) * k;
    }
  }
  return { ...m, positions: Float32Array.from(x) };
}

function cast(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const f = num(mod, 'factor', 0.5),
    type = str(mod, 'cast_type', 'SPHERE');
  const use = [bool(mod, 'use_x', true), bool(mod, 'use_y', true), bool(mod, 'use_z', true)];
  const radius = num(mod, 'radius', 0);
  // an object (e.g. an empty) can be the center and orientation of the effect
  const space = mod.object ? objectSpaceOf(ctx, mod.object) : null;
  const toS = space ? space.clone().invert() : null;
  const P0 = m.positions;
  const P = toS ? transformMesh(m, toS).positions : P0;
  const nv = P.length / 3;
  let size = bool(mod, 'use_radius_as_size', true) ? radius : num(mod, 'size', 0);
  // without a size: the average distance from the center (per axis extents for cuboids)
  const ext = [0, 0, 0];
  if (!size) {
    let sum = 0;
    for (let i = 0; i < P.length; i += 3) {
      sum += Math.hypot(P[i], P[i + 1], P[i + 2]);
      for (let k = 0; k < 3; k++) ext[k] = Math.max(ext[k], Math.abs(P[i + k]));
    }
    size = sum / (nv || 1);
  } else ext.fill(size);
  const out = deform({ ...m, positions: P }, mod, (p) => {
    if (radius > 0 && p.length() > radius) return;
    let target: Vector3;
    if (type === 'SPHERE') target = p.clone().normalize().multiplyScalar(size);
    else if (type === 'CYLINDER') {
      const l = Math.hypot(p.x, p.y) || 1;
      target = new Vector3((p.x / l) * size, (p.y / l) * size, p.z);
    } else {
      const s = 1 / Math.max(ext[0] ? Math.abs(p.x) / ext[0] : 0, ext[1] ? Math.abs(p.y) / ext[1] : 0, ext[2] ? Math.abs(p.z) / ext[2] : 0, 1e-9);
      target = p.clone().multiplyScalar(s);
    }
    if (use[0]) p.x += (target.x - p.x) * f;
    if (use[1]) p.y += (target.y - p.y) * f;
    if (use[2]) p.z += (target.z - p.z) * f;
  });
  return space ? { ...out, positions: transformMesh(out, space).positions } : out;
}

function simpleDeform(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const method = str(mod, 'deform_method', 'TWIST'),
    amount = method === 'TWIST' || method === 'BEND' ? num(mod, 'angle', (45 * Math.PI) / 180) : num(mod, 'factor', 0.785398);
  const axis = ['X', 'Y', 'Z'].indexOf(str(mod, 'deform_axis', 'Z'));
  const limits = (mod.limits as number[]) ?? [0, 1];
  const origin = mod.origin ? objectSpaceOf(ctx, mod.origin) : null;
  const toO = origin ? origin.clone().invert() : null;
  // the coordinate that drives the effect: the deform axis, or for bending the axis the mesh bends along
  const drive = method === 'BEND' ? (axis === 2 ? 0 : 2) : axis;
  const P = m.positions;
  let lo = Infinity,
    hi = -Infinity;
  const q = new Vector3();
  for (let i = 0; i < P.length; i += 3) {
    q.set(P[i], P[i + 1], P[i + 2]);
    if (toO) q.applyMatrix4(toO);
    const c = q.getComponent(drive);
    lo = Math.min(lo, c);
    hi = Math.max(hi, c);
  }
  const lmin = lo + (hi - lo) * Math.min(limits[0], limits[1]),
    lmax = lo + (hi - lo) * Math.max(limits[0], limits[1]);
  const f = amount / Math.max(1e-6, lmax - lmin);
  // the two other axes: twist rotates them, taper/stretch scale them, bend uses (bend, offset)
  const b = (axis + 1) % 3,
    d = (axis + 2) % 3;
  // locked axes keep their coordinate while tapering or stretching
  const scalable = method === 'TAPER' || method === 'STRETCH';
  const lockB = scalable && bool(mod, `lock_${'xyz'[b]}`),
    lockD = scalable && bool(mod, `lock_${'xyz'[d]}`);
  const offAxis = axis === 1 ? 0 : 1; // bend offset axis
  return deform(m, mod, (p) => {
    if (toO) p.applyMatrix4(toO);
    const c = [p.x, p.y, p.z];
    const h = Math.max(lmin, Math.min(lmax, c[drive]));
    if (method === 'TWIST') {
      const th = f * h;
      const x = c[b] * Math.cos(th) - c[d] * Math.sin(th),
        y = c[b] * Math.sin(th) + c[d] * Math.cos(th);
      c[b] = x;
      c[d] = y;
    } else if (method === 'BEND') {
      if (Math.abs(f) > 1e-9) {
        const R = 1 / f;
        const th = h * f;
        const w = c[offAxis];
        // past the limits the mesh continues straight along the tangent
        const extra = c[drive] - h;
        const u = Math.sin(th) * (R - w) + Math.cos(th) * extra,
          v = R - Math.cos(th) * (R - w) + Math.sin(th) * extra;
        c[drive] = u;
        c[offAxis] = v;
      }
    } else if (method === 'TAPER') {
      const k = 1 + h * f;
      if (!lockB) c[b] *= k;
      if (!lockD) c[d] *= k;
    } else if (method === 'STRETCH') {
      const k = h * h * f - f + 1;
      c[axis] = c[axis] * (1 + f);
      if (!lockB) c[b] *= k;
      if (!lockD) c[d] *= k;
    }
    p.set(c[0], c[1], c[2]);
    if (origin) p.applyMatrix4(origin);
  });
}

function wave(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const height = num(mod, 'height', 0.5),
    width = Math.max(1e-6, num(mod, 'width', 1.5)),
    speed = num(mod, 'speed', 0.25),
    narrow = num(mod, 'narrowness', 1.5);
  const offset = num(mod, 'time_offset', 0);
  const useX = bool(mod, 'use_x', true),
    useY = bool(mod, 'use_y', true);
  const cyclic = bool(mod, 'use_cyclic', true);
  const falloff = num(mod, 'falloff_radius', 0);
  // the wave front travels outwards from the start position at `speed` units per frame
  const t = (ctx.frame - offset) * speed;
  // lifetime: after it, the wave fades out over the damping time
  let life = 1;
  const lifetime = num(mod, 'lifetime', 0);
  if (lifetime > 0) {
    const age = ctx.frame - offset;
    if (age > lifetime) life = Math.max(0, 1 - (age - lifetime) / Math.max(1e-6, num(mod, 'damping_time', 10)));
  }
  let sx = num(mod, 'start_position_x', 0),
    sy = num(mod, 'start_position_y', 0);
  if (mod.start_position_object) {
    const om = objectSpaceOf(ctx, mod.start_position_object);
    if (om) {
      const o = new Vector3().setFromMatrixPosition(om);
      sx = o.x;
      sy = o.y;
    }
  }
  const minfac = 1 / Math.exp(width * narrow * width * narrow);
  const vn = bool(mod, 'use_normal') ? vertexNormals(m) : null;
  const nAxes = [bool(mod, 'use_normal_x', true), bool(mod, 'use_normal_y', true), bool(mod, 'use_normal_z', true)];
  return deform(m, mod, (p, i) => {
    const dx = p.x - sx,
      dy = p.y - sy;
    // radial from the start point, or a straight front along one axis
    const dist = useX && useY ? Math.hypot(dx, dy) : useX ? dx : useY ? dy : 0;
    let fall = 1;
    if (falloff > 0) {
      fall = 1 - Math.abs(dist) / falloff;
      if (fall <= 0) return;
    }
    let x = dist - t;
    if (x >= width) return; // the front has not arrived yet
    // behind the front: repeating waves when cyclic
    if (cyclic && x <= -width) x = (((x + width) % (2 * width)) + 2 * width) % (2 * width) - width;
    if (x <= -width) return;
    const a = x * narrow;
    const amp = height * (1 / Math.exp(a * a) - minfac) * life * fall;
    if (vn) {
      if (nAxes[0]) p.x += vn[i * 3] * amp;
      if (nAxes[1]) p.y += vn[i * 3 + 1] * amp;
      if (nAxes[2]) p.z += vn[i * 3 + 2] * amp;
    } else p.z += amp;
  });
}

function displace(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const strength = num(mod, 'strength', 1),
    mid = num(mod, 'mid_level', 0.5),
    dir = str(mod, 'direction', 'NORMAL');
  let vn: Float32Array | null = dir === 'NORMAL' ? vertexNormals(m) : null;
  if (dir === 'CUSTOM_NORMAL') {
    // average the custom corner normals per vertex (plain normals without custom ones)
    vn = vertexNormals(m);
    if (m.custom_normals) {
      const acc = new Float32Array(vn.length);
      for (let c = 0; c < m.indices.length; c++) for (let k = 0; k < 3; k++) acc[m.indices[c] * 3 + k] += m.custom_normals[c * 3 + k];
      for (let v = 0; v < acc.length; v += 3) {
        const l = Math.hypot(acc[v], acc[v + 1], acc[v + 2]);
        if (l > 1e-12) vn.set([acc[v] / l, acc[v + 1] / l, acc[v + 2] / l], v);
      }
    }
  }
  const tex = (mod.texture as Record<string, unknown> | null) ?? null;
  const coords = str(mod, 'texture_coords', 'LOCAL');
  const world = ctx.graph?.get(ctx.ob.id)?.world;
  const objMat = coords === 'OBJECT' && typeof mod.texture_coords_object === 'string' ? objectSpaceOf(ctx, mod.texture_coords_object)?.invert() ?? null : null;
  // per-vertex UVs (first corner of each vertex)
  let vuv: Float32Array | null = null;
  if (tex && coords === 'UV') {
    vuv = new Float32Array((m.positions.length / 3) * 2).fill(NaN);
    for (let c = 0; c < m.indices.length; c++) {
      const v = m.indices[c];
      if (Number.isNaN(vuv[v * 2])) {
        vuv[v * 2] = m.uvs[c * 2] * 2 - 1;
        vuv[v * 2 + 1] = m.uvs[c * 2 + 1] * 2 - 1;
      }
    }
  }
  // X/Y/Z in global space: the world axis expressed in local coordinates
  let axis: Vector3 | null = null;
  if (dir === 'X' || dir === 'Y' || dir === 'Z') {
    axis = new Vector3(dir === 'X' ? 1 : 0, dir === 'Y' ? 1 : 0, dir === 'Z' ? 1 : 0);
    if (str(mod, 'space', 'LOCAL') === 'GLOBAL' && world) axis.transformDirection(world.clone().invert());
  }
  return deform(m, mod, (p, i) => {
    let value = 1;
    if (tex && tex.type) {
      let q = p;
      if (coords === 'GLOBAL' && world) q = p.clone().applyMatrix4(world);
      else if (objMat) q = p.clone().applyMatrix4(objMat);
      else if (vuv) q = new Vector3(vuv[i * 2] || 0, vuv[i * 2 + 1] || 0, 0);
      value = proceduralTexture(tex, q.x, q.y, q.z);
    }
    const d = (value - mid) * strength;
    if (vn) p.addScaledVector(new Vector3(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]), d);
    else if (axis) p.addScaledVector(axis, d);
  });
}

function armatureMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const armOb = typeof mod.object === 'string' ? ctx.graph.get(mod.object) : undefined;
  const arm = armOb?.ob.data ? ctx.doc?.armatures[armOb.ob.data] : undefined;
  if (!armOb?.pose || !arm) return m;
  const useGroups = bool(mod, 'use_vertex_groups', true),
    useEnvelopes = bool(mod, 'use_bone_envelopes');
  if (!useEnvelopes && (!m.vertex_groups || !m.weights)) return m;
  const own = ctx.graph.get(ctx.ob.id)!.world;
  const meshToArm = armOb.world.clone().invert().multiply(own);
  const armToMesh = meshToArm.clone().invert();
  let positions = armatureDeform(m.positions, m.vertex_groups, m.weights, arm.bones, armOb.pose, meshToArm, armToMesh, {
    useGroups,
    useEnvelopes,
    preserveVolume: bool(mod, 'use_deform_preserve_volume'),
  });
  // the modifier's own vertex group limits the influence
  const mask = groupWeights(m, str(mod, 'vertex_group'));
  if (mask) {
    const inv = bool(mod, 'invert_vertex_group');
    positions = Float32Array.from(positions, (x, k) => {
      const w = inv ? 1 - mask[(k / 3) | 0] : mask[(k / 3) | 0];
      return m.positions[k] + (x - m.positions[k]) * w;
    });
  }
  return { ...m, positions };
}

/** Weights of the four neighbouring lattice points around parameter t ∈ [0, 1). */
export function latticeWeights(t: number, type: string, out: number[]) {
  const t2 = t * t,
    t3 = t2 * t;
  if (type === 'KEY_BSPLINE') {
    out[0] = -t3 / 6 + t2 / 2 - t / 2 + 1 / 6;
    out[1] = t3 / 2 - t2 + 2 / 3;
    out[2] = -t3 / 2 + t2 / 2 + t / 2 + 1 / 6;
    out[3] = t3 / 6;
  } else if (type === 'KEY_CARDINAL' || type === 'KEY_CATMULL_ROM') {
    const c = type === 'KEY_CARDINAL' ? 0.71 : 0.5;
    out[0] = -c * t3 + 2 * c * t2 - c * t;
    out[1] = (2 - c) * t3 + (c - 3) * t2 + 1;
    out[2] = (c - 2) * t3 + (3 - 2 * c) * t2 + c * t;
    out[3] = c * t3 - c * t2;
  } else {
    out[0] = 0;
    out[1] = 1 - t;
    out[2] = t;
    out[3] = 0;
  }
}

function latticeMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const lt = typeof mod.object === 'string' ? ctx.graph.get(mod.object) : undefined;
  const lat = lt?.ob.data ? ctx.doc.lattices[lt.ob.data] : undefined;
  if (!lt || !lat) return m;
  const own = ctx.graph.get(ctx.ob.id)!.world;
  const toLat = lt.world.clone().invert().multiply(own);
  const back = toLat.clone().invert();
  const { points_u: U, points_v: V, points_w: W, points } = lat;
  const rest = (i: number, n: number) => (n > 1 ? i / (n - 1) - 0.5 : 0);
  const strength = num(mod, 'strength', 1);
  const type = lat.interpolation ?? 'KEY_BSPLINE';
  const wu = [0, 0, 0, 0],
    wv = [0, 0, 0, 0],
    ww = [0, 0, 0, 0];
  const setup = (x: number, n: number, w: number[]): number => {
    if (n <= 1) {
      w.fill(0);
      w[1] = 1;
      return 0;
    }
    const u = (x + 0.5) * (n - 1);
    const i = Math.floor(u);
    latticeWeights(u - i, type, w);
    return i;
  };
  const clampI = (i: number, n: number) => Math.max(0, Math.min(n - 1, i));
  return deform(m, mod, (p) => {
    p.applyMatrix4(toLat);
    const iu = setup(p.x, U, wu),
      iv = setup(p.y, V, wv),
      iw = setup(p.z, W, ww);
    let dx = 0,
      dy = 0,
      dz = 0;
    for (let c = 0; c < 4; c++) {
      if (!ww[c]) continue;
      const w = clampI(iw + c - 1, W);
      for (let b = 0; b < 4; b++) {
        if (!wv[b]) continue;
        const v = clampI(iv + b - 1, V);
        for (let a = 0; a < 4; a++) {
          if (!wu[a]) continue;
          const u = clampI(iu + a - 1, U);
          const wt = wu[a] * wv[b] * ww[c];
          const idx = ((w * V + v) * U + u) * 3;
          dx += (points[idx] - rest(u, U)) * wt;
          dy += (points[idx + 1] - rest(v, V)) * wt;
          dz += (points[idx + 2] - rest(w, W)) * wt;
        }
      }
    }
    p.x += dx * strength;
    p.y += dy * strength;
    p.z += dz * strength;
    p.applyMatrix4(back);
  });
}

function hookMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  // curve hooks move control points before tessellation (src/modes/curve/hooks.ts)
  if (ctx.ob.type === 'CURVE') return m;
  const target = typeof mod.object === 'string' ? ctx.graph.get(mod.object) : undefined;
  if (!target) return m;
  const own = ctx.graph.get(ctx.ob.id)!.world;
  const inv = new Matrix4().fromArray((mod.matrix_inverse as number[]) ?? new Matrix4().elements);
  const tw = target.world.clone();
  const bone = typeof mod.subtarget === 'string' && mod.subtarget ? target.pose?.bones.get(mod.subtarget) : undefined;
  if (bone) tw.multiply(bone.pose);
  const mat = own.clone().invert().multiply(tw).multiply(inv).multiply(own);
  const strength = num(mod, 'strength', 1),
    falloff = num(mod, 'falloff_radius', 0);
  const center = new Vector3(...((mod.center as number[]) ?? [0, 0, 0]));
  const ftype = str(mod, 'falloff_type', 'SMOOTH');
  // uniform falloff: distances measured in world space (unaffected by the object's scale)
  const uniform = bool(mod, 'use_falloff_uniform');
  const centerW = center.clone().applyMatrix4(own);
  const verts = new Set((mod.vertex_indices as number[]) ?? []);
  const hasGroup = !!groupWeights(m, str(mod, 'vertex_group'));
  return deform(m, mod, (p, i) => {
    const orig = m.origIndex ? m.origIndex[i] : i;
    if (!hasGroup && verts.size && !verts.has(orig)) return;
    const q = p.clone().applyMatrix4(mat);
    let f = strength;
    if (falloff > 0 && ftype !== 'NONE') {
      const d = uniform ? p.clone().applyMatrix4(own).distanceTo(centerW) : p.distanceTo(center);
      f *= falloffFactor(ftype, 1 - d / falloff, mod.falloff_curve);
    }
    p.lerp(q, f);
  });
}

/** Falloff weight for t = 1 - distance / radius (0 outside the radius). */
export function falloffFactor(type: string, t: number, curve?: unknown): number {
  if (type === 'NONE') return 1;
  if (t <= 0) return 0;
  t = Math.min(1, t);
  switch (type) {
    case 'LINEAR':
      return t;
    case 'SHARP':
      return t * t;
    case 'SPHERE':
      return Math.sqrt(2 * t - t * t);
    case 'ROOT':
      return Math.sqrt(t);
    case 'INVERSE_SQUARE':
      return t * (2 - t);
    case 'CONSTANT':
      return 1;
    case 'CURVE': {
      const flat = (curve as Record<string, unknown> | null)?.curve_0;
      if (!Array.isArray(flat)) return t;
      const pts: { x: number; y: number; handle: number }[] = [];
      for (let i = 0; i + 2 < flat.length; i += 3) pts.push({ x: flat[i] as number, y: flat[i + 1] as number, handle: flat[i + 2] as number });
      return evalCurve(pts.sort((a, b) => a.x - b.x), t);
    }
  }
  return t * t * (3 - 2 * t); // SMOOTH
}

function warpMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const from = typeof mod.object_from === 'string' ? ctx.graph.get(mod.object_from) : undefined,
    to = typeof mod.object_to === 'string' ? ctx.graph.get(mod.object_to) : undefined;
  if (!from || !to) return m;
  const own = ctx.graph.get(ctx.ob.id)!.world,
    inv = own.clone().invert();
  const fw = from.world.clone(),
    tw = to.world.clone();
  const bf = typeof mod.bone_from === 'string' && mod.bone_from ? from.pose?.bones.get(mod.bone_from) : undefined;
  if (bf) fw.multiply(bf.pose);
  const bt = typeof mod.bone_to === 'string' && mod.bone_to ? to.pose?.bones.get(mod.bone_to) : undefined;
  if (bt) tw.multiply(bt.pose);
  // the full transform taking "from" to "to", in mesh space
  const T = inv.clone().multiply(tw).multiply(fw.clone().invert()).multiply(own);
  const pf = new Vector3().setFromMatrixPosition(fw).applyMatrix4(inv);
  const radius = num(mod, 'falloff_radius', 1),
    strength = num(mod, 'strength', 1);
  const ftype = str(mod, 'falloff_type', 'SMOOTH');
  const preserve = bool(mod, 'use_volume_preserve');
  const tp = new Vector3(),
    tq = new Quaternion(),
    ts = new Vector3();
  T.decompose(tp, tq, ts);
  const idQ = new Quaternion(),
    one = new Vector3(1, 1, 1),
    zero = new Vector3();
  const tex = mod.texture as Record<string, unknown> | null | undefined;
  return deform(m, mod, (p) => {
    const d = p.distanceTo(pf);
    let f = (radius > 0 ? falloffFactor(ftype, 1 - d / radius, mod.falloff_curve) : 1) * strength;
    if (tex && tex.type) f *= proceduralTexture(tex, p.x, p.y, p.z);
    if (!f) return;
    if (preserve) {
      // interpolate the transform itself (rotations stay rotations)
      const q = idQ.clone().slerp(tq, Math.min(1, Math.max(0, f)));
      const mat = new Matrix4().compose(zero.clone().lerp(tp, f), q, one.clone().lerp(ts, f));
      p.applyMatrix4(mat);
    } else p.lerp(p.clone().applyMatrix4(T), f);
  });
}

function shrinkwrapMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const target = typeof mod.target === 'string' ? ctx.graph.get(mod.target) : undefined;
  if (!target?.mesh) return m;
  const own = ctx.graph.get(ctx.ob.id)!.world;
  // work in the modified object's space: target geometry brought over once
  const toLocal = own.clone().invert().multiply(target.world);
  const query = new SurfaceQuery(target.mesh, toLocal);
  if (query.empty) return m;
  const method = str(mod, 'wrap_method', 'NEAREST_SURFACEPOINT');
  const mode = str(mod, 'wrap_mode', 'ON_SURFACE');
  const offset = num(mod, 'offset', 0);
  const points = method === 'NEAREST_VERTEX' ? new PointQuery(query.positions) : null;
  const tn = new Vector3(),
    a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  const triNormal = (tri: [number, number, number]) => {
    a.fromArray(query.positions, tri[0] * 3);
    b.fromArray(query.positions, tri[1] * 3);
    c.fromArray(query.positions, tri[2] * 3);
    return tn.subVectors(b, a).cross(c.sub(a)).normalize();
  };
  // smooth normals of the target (for "above surface")
  const smoothN = mode === 'ABOVE_SURFACE' ? vertexNormals({ ...target.mesh, positions: query.positions }) : null;
  /** Place p relative to a surface hit according to the snap mode (smooth normal `sn` when known). */
  const snap = (p: Vector3, hit: Vector3, n: Vector3 | null, sn?: Vector3) => {
    const away = p.clone().sub(hit);
    const outside = n ? away.dot(n) >= 0 : true;
    // the line back to the original point, turned to face out of the surface
    const out = away.lengthSq() > 1e-18 ? away.clone().normalize() : n?.clone() ?? new Vector3();
    if (n && out.dot(n) < 0) out.negate();
    switch (mode) {
      case 'INSIDE':
        if (n && !outside && away.length() >= offset) return;
        p.copy(hit).addScaledVector(out, -offset);
        return;
      case 'OUTSIDE':
        if (n && outside && away.length() >= offset) return;
        p.copy(hit).addScaledVector(out, offset);
        return;
      case 'OUTSIDE_SURFACE':
        p.copy(hit).addScaledVector(out, offset);
        return;
      case 'ABOVE_SURFACE':
        p.copy(hit).addScaledVector(sn ?? n ?? out, offset);
        return;
    }
    // on surface: keep the offset along the line back to the original point
    p.copy(hit);
    if (offset) {
      if (away.lengthSq() > 1e-18) p.addScaledVector(away.normalize(), offset);
      else if (n) p.addScaledVector(n, offset);
    }
  };
  if (method === 'PROJECT') {
    const axes = [bool(mod, 'use_project_x'), bool(mod, 'use_project_y'), bool(mod, 'use_project_z')];
    const useAxes = axes.some(Boolean);
    const axis = new Vector3(axes[0] ? 1 : 0, axes[1] ? 1 : 0, axes[2] ? 1 : 0).normalize();
    const vn = useAxes ? null : vertexNormals(m);
    const pos = bool(mod, 'use_positive_direction', true),
      neg = bool(mod, 'use_negative_direction');
    const limit = num(mod, 'project_limit', 0) || Infinity;
    const cull = str(mod, 'cull_face', 'OFF');
    const invCull = bool(mod, 'use_invert_cull');
    const accept = (hit: { tri: [number, number, number] } | null, dir: Vector3) => {
      if (!hit) return false;
      if (cull === 'OFF') return true;
      const front = triNormal(hit.tri).dot(dir) < 0;
      const culled = cull === 'FRONT' ? front : !front;
      return invCull ? culled : !culled;
    };
    return deform(m, mod, (p, i) => {
      const d = vn ? new Vector3(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]) : axis.clone();
      if (d.lengthSq() < 1e-12) return;
      let best: ReturnType<SurfaceQuery['raycast']> = null;
      if (pos) {
        const h = query.raycast(p, d, limit, true);
        if (accept(h, d)) best = h;
      }
      if (neg) {
        const nd = d.clone().negate();
        const h = query.raycast(p, nd, limit, true);
        if (accept(h, nd) && (!best || h!.distance < best.distance)) best = h;
      }
      if (!best) return;
      snap(p, best.point, triNormal(best.tri).clone());
    });
  }
  return deform(m, mod, (p) => {
    if (points) {
      const r = points.nearest(p);
      if (!r) return;
      snap(p, new Vector3().fromArray(query.positions, r.index * 3), null);
      return;
    }
    const h = query.nearest(p);
    if (!h) return;
    let sn: Vector3 | undefined;
    if (smoothN) {
      sn = new Vector3();
      for (let k = 0; k < 3; k++) sn.addScaledVector(new Vector3().fromArray(smoothN, h.tri[k] * 3), h.bary[k]);
      sn.normalize();
    }
    snap(p, h.point, triNormal(h.tri).clone(), sn);
  });
}

export function closestPointOnTriangle(p: Vector3, a: Vector3, b: Vector3, c: Vector3, out: Vector3) {
  const ab = b.clone().sub(a),
    ac = c.clone().sub(a),
    ap = p.clone().sub(a);
  const d1 = ab.dot(ap),
    d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);
  const bp = p.clone().sub(b),
    d3 = ab.dot(bp),
    d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return out.copy(a).addScaledVector(ab, d1 / (d1 - d3));
  const cp = p.clone().sub(c),
    d5 = ab.dot(cp),
    d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return out.copy(a).addScaledVector(ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return out.copy(b).addScaledVector(c.clone().sub(b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const denom = 1 / (va + vb + vc);
  return out.copy(a).addScaledVector(ab, vb * denom).addScaledVector(ac, vc * denom);
}

function curveMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const t = typeof mod.object === 'string' ? ctx.graph.get(mod.object) : undefined;
  const cu = t?.ob.data ? ctx.doc.curves[t.ob.data] : undefined;
  if (!t || !cu?.splines.length) return m;
  // the first spline as an arc-length table; vertices are deformed in the curve's space
  const own = ctx.graph.get(ctx.ob.id)!.world;
  const toMesh = own.clone().invert().multiply(t.world);
  const toCurve = toMesh.clone().invert();
  const pts = curvePolyline(cu).map((p) => new Vector3(...p));
  if (pts.length < 2) return m;
  const n = pts.length;
  const lens = [0];
  for (let i = 1; i < n; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = lens[n - 1] || 1;
  // tangent at each point: the average of the neighbouring segment directions
  const seg = (i: number) => pts[i + 1].clone().sub(pts[i]).normalize();
  const tans = pts.map((_, i) => (i === 0 ? seg(0) : i === n - 1 ? seg(n - 2) : seg(i - 1).add(seg(i)).normalize()));
  const axis = ['POS_X', 'POS_Y', 'POS_Z', 'NEG_X', 'NEG_Y', 'NEG_Z'].indexOf(str(mod, 'deform_axis', 'POS_X'));
  const ai = axis % 3,
    neg = axis >= 3;
  const zUp = new Vector3(0, 0, 1),
    xUp = new Vector3(1, 0, 0);
  return deform(m, mod, (p) => {
    p.applyMatrix4(toCurve);
    const c = [p.x, p.y, p.z];
    const s = neg ? -c[ai] : c[ai];
    const d = Math.max(0, Math.min(total, s));
    let i = 1;
    while (i < n - 1 && lens[i] < d) i++;
    const k = (d - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
    const pos = pts[i - 1].clone().lerp(pts[i], k);
    // turn the tangent smoothly from one point's to the next
    const q = new Quaternion().setFromUnitVectors(tans[i - 1], tans[i]);
    const tan = tans[i - 1].clone().applyQuaternion(new Quaternion().slerp(q, k)).normalize();
    const up = Math.abs(tan.z) < 0.99 ? zUp : xUp;
    const side = new Vector3().crossVectors(up, tan).normalize();
    const nup = new Vector3().crossVectors(tan, side);
    // the other two coordinates become offsets across the curve (mirrored for negative axes)
    const o1 = neg ? -c[(ai + 2) % 3] : c[(ai + 1) % 3],
      o2 = neg ? -c[(ai + 1) % 3] : c[(ai + 2) % 3];
    const extra = s - d; // beyond either end: continue straight
    pos.addScaledVector(tan, extra).addScaledVector(side, o1).addScaledVector(nup, o2);
    p.copy(pos).applyMatrix4(toMesh);
  });
}

import { sampleSpline } from './curve';
function curvePolyline(cu: import('../data/types').CurveData) {
  return sampleSpline(cu.splines[0], cu.resolution_u).points;
}

// ---------------------------------------------------------------------------

const base = (extra: Record<string, unknown>) => () => extra;

export const modifierTypes: Record<string, ModifierType> = {
  ARRAY: {
    type: 'ARRAY',
    label: 'Array',
    category: 'GENERATE',
    icon: 'mod_array',
    defaults: base({ count: 2, fit_type: 'FIXED_COUNT', fit_length: 0, curve: null, start_cap: null, end_cap: null, use_merge_vertices_cap: false, use_relative_offset: true, relative_offset_displace: [1, 0, 0], use_constant_offset: false, constant_offset_displace: [1, 0, 0], use_object_offset: false, offset_object: null, use_merge_vertices: false, merge_threshold: 0.01, offset_u: 0, offset_v: 0 }),
    deps: (m) => [m.offset_object as string, m.start_cap as string, m.end_cap as string, m.curve as string],
    apply: arrayMesh,
  },
  BUILD: { type: 'BUILD', label: 'Build', category: 'GENERATE', icon: 'mod_build', defaults: base({ frame_start: 1, frame_duration: 100, use_random_order: false, seed: 0, use_reverse: false }), timeDependent: () => true, apply: build },
  EDGE_SPLIT: { type: 'EDGE_SPLIT', label: 'Edge Split', category: 'GENERATE', icon: 'mod_edgesplit', defaults: base({ use_edge_angle: true, split_angle: (30 * Math.PI) / 180, use_edge_sharp: true }), apply: edgeSplit },
  MASK: { type: 'MASK', label: 'Mask', category: 'GENERATE', icon: 'mod_mask', defaults: base({ mode: 'VERTEX_GROUP', armature: null, vertex_group: '', invert_vertex_group: false, threshold: 0 }), deps: (m) => [m.armature as string], signature: (m, c) => {
    const arm = typeof m.armature === 'string' ? c.doc.objects[m.armature] : undefined;
    const ad = arm?.data ? c.doc.armatures[arm.data] : undefined;
    return m.mode === 'ARMATURE' && ad ? ad.bones.filter((b) => b.select).map((b) => b.name).join(',') : '';
  }, apply: maskMesh },
  MIRROR: {
    type: 'MIRROR',
    label: 'Mirror',
    category: 'GENERATE',
    icon: 'mod_mirror',
    defaults: base({ use_axis: [true, false, false], use_bisect_axis: [false, false, false], use_bisect_flip_axis: [false, false, false], mirror_object: null, use_clip: false, use_mirror_merge: true, merge_threshold: 0.001, use_mirror_u: false, use_mirror_v: false, mirror_offset_u: 0, mirror_offset_v: 0, offset_u: 0, offset_v: 0, bisect_threshold: 0.001, use_mirror_vertex_groups: true }),
    deps: (m) => [m.mirror_object as string],
    supportsEditMode: true,
    apply: mirrorMesh,
  },
  SCREW: { type: 'SCREW', label: 'Screw', category: 'GENERATE', icon: 'mod_screw', defaults: base({ angle: Math.PI * 2, steps: 16, render_steps: 16, screw_offset: 0, iterations: 1, axis: 'Z', object: null, use_object_screw_offset: false, use_merge_vertices: false, merge_threshold: 0.01, use_smooth_shade: true, use_normal_flip: false, use_stretch_u: false, use_stretch_v: false }), deps: (m) => [m.object as string], apply: screw },
  SOLIDIFY: {
    type: 'SOLIDIFY',
    label: 'Solidify',
    category: 'GENERATE',
    icon: 'mod_solidify',
    defaults: base({ solidify_mode: 'EXTRUDE', thickness: 0.01, offset: -1, use_even_offset: false, use_quality_normals: false, use_rim: true, use_rim_only: false, use_flip_normals: false, thickness_clamp: 0, thickness_vertex_group: 0, material_offset: 0, material_offset_rim: 0, vertex_group: '', invert_vertex_group: false, shell_vertex_group: '', rim_vertex_group: '', edge_crease_inner: 0, edge_crease_outer: 0, edge_crease_rim: 0 }),
    apply: solidify,
  },
  SUBSURF: {
    type: 'SUBSURF',
    label: 'Subdivision Surface',
    category: 'GENERATE',
    icon: 'mod_subsurf',
    defaults: base({ subdivision_type: 'CATMULL_CLARK', levels: 1, render_levels: 2, quality: 3, use_creases: true, use_limit_surface: true, uv_smooth: 'PRESERVE_BOUNDARIES', boundary_smooth: 'ALL' }),
    supportsEditMode: true,
    apply: (m, mod, ctx) =>
      catmullClark(m, Math.min(6, Math.round(ctx.render ? num(mod, 'render_levels', 2) : num(mod, 'levels', 1))), str(mod, 'subdivision_type') === 'SIMPLE', bool(mod, 'use_creases', true), {
        boundary: str(mod, 'boundary_smooth', 'ALL') === 'PRESERVE_CORNERS' ? 'CORNERS' : 'SMOOTH',
        limit: bool(mod, 'use_limit_surface', true),
        uvSmooth: str(mod, 'uv_smooth', 'PRESERVE_BOUNDARIES'),
      }),
  },
  TRIANGULATE: { type: 'TRIANGULATE', label: 'Triangulate', category: 'GENERATE', icon: 'mod_triangulate', defaults: base({ quad_method: 'SHORTEST_DIAGONAL', ngon_method: 'BEAUTY', min_vertices: 4 }), apply: triangulateMeshMod },
  WELD: { type: 'WELD', label: 'Weld', category: 'GENERATE', icon: 'automerge_off', defaults: base({ merge_threshold: 0.001, mode: 'ALL', loose_edges: false, vertex_group: '', invert_vertex_group: false }), apply: weldMod },
  WIREFRAME: { type: 'WIREFRAME', label: 'Wireframe', category: 'GENERATE', icon: 'mod_wireframe', defaults: base({ thickness: 0.02, offset: 0, use_replace: true, use_boundary: false, use_even_offset: true, material_offset: 0, vertex_group: '', invert_vertex_group: false, thickness_vertex_group: 0 }), apply: wireframe },
  // Deform
  ARMATURE: { type: 'ARMATURE', label: 'Armature', category: 'DEFORM', icon: 'mod_armature', deformOnly: true, defaults: base({ object: null, use_vertex_groups: true, use_bone_envelopes: false, use_deform_preserve_volume: false, vertex_group: '', invert_vertex_group: false }), deps: (m) => [m.object as string], apply: armatureMod },
  CAST: { type: 'CAST', label: 'Cast', category: 'DEFORM', icon: 'mod_cast', deformOnly: true, defaults: base({ cast_type: 'SPHERE', factor: 0.5, radius: 0, size: 0, use_radius_as_size: true, object: null, use_x: true, use_y: true, use_z: true, vertex_group: '', invert_vertex_group: false }), deps: (m) => [m.object as string], apply: cast },
  CURVE: { type: 'CURVE', label: 'Curve', category: 'DEFORM', icon: 'mod_curve', deformOnly: true, defaults: base({ object: null, deform_axis: 'POS_X', vertex_group: '', invert_vertex_group: false }), deps: (m) => [m.object as string], apply: curveMod },
  DISPLACE: {
    type: 'DISPLACE',
    label: 'Displace',
    category: 'DEFORM',
    icon: 'mod_displace',
    deformOnly: true,
    defaults: base({ strength: 1, mid_level: 0.5, direction: 'NORMAL', space: 'LOCAL', texture_coords: 'LOCAL', texture_coords_object: null, vertex_group: '', invert_vertex_group: false, texture: null }),
    deps: (m) => [m.texture_coords_object as string],
    apply: displace,
  },
  HOOK: { type: 'HOOK', label: 'Hook', category: 'DEFORM', icon: 'hook', deformOnly: true, defaults: base({ object: null, strength: 1, falloff_type: 'SMOOTH', falloff_radius: 0, use_falloff_uniform: false, center: [0, 0, 0], vertex_indices: [], matrix_inverse: new Matrix4().toArray(), vertex_group: '', invert_vertex_group: false }), deps: (m) => [m.object as string], apply: hookMod },
  LAPLACIANSMOOTH: { type: 'LAPLACIANSMOOTH', label: 'Smooth Laplacian', category: 'DEFORM', icon: 'mod_smooth', deformOnly: true, defaults: base({ iterations: 1, lambda_factor: 0.01, lambda_border: 0.01, use_volume_preserve: true, use_normalized: true, use_x: true, use_y: true, use_z: true, vertex_group: '', invert_vertex_group: false }), apply: laplacianSmooth },
  LATTICE: { type: 'LATTICE', label: 'Lattice', category: 'DEFORM', icon: 'mod_lattice', deformOnly: true, defaults: base({ object: null, strength: 1, vertex_group: '', invert_vertex_group: false }), deps: (m) => [m.object as string], apply: latticeMod },
  SHRINKWRAP: {
    type: 'SHRINKWRAP',
    label: 'Shrinkwrap',
    category: 'DEFORM',
    icon: 'mod_shrinkwrap',
    deformOnly: true,
    defaults: base({ target: null, wrap_method: 'NEAREST_SURFACEPOINT', wrap_mode: 'ON_SURFACE', offset: 0, project_limit: 0, use_project_x: false, use_project_y: false, use_project_z: false, use_negative_direction: false, use_positive_direction: true, cull_face: 'OFF', use_invert_cull: false, vertex_group: '', invert_vertex_group: false }),
    deps: (m) => [m.target as string],
    apply: shrinkwrapMod,
  },
  SIMPLE_DEFORM: { type: 'SIMPLE_DEFORM', label: 'Simple Deform', category: 'DEFORM', icon: 'mod_simpledeform', deformOnly: true, defaults: base({ deform_method: 'TWIST', angle: (45 * Math.PI) / 180, factor: 0.785398, deform_axis: 'Z', origin: null, limits: [0, 1], lock_x: false, lock_y: false, lock_z: false, vertex_group: '', invert_vertex_group: false }), deps: (m) => [m.origin as string], apply: simpleDeform },
  SMOOTH: { type: 'SMOOTH', label: 'Smooth', category: 'DEFORM', icon: 'mod_smooth', deformOnly: true, defaults: base({ factor: 0.5, iterations: 1, use_x: true, use_y: true, use_z: true, vertex_group: '' }), apply: smoothMesh },
  WARP: { type: 'WARP', label: 'Warp', category: 'DEFORM', icon: 'mod_warp', deformOnly: true, defaults: base({ object_from: null, bone_from: '', object_to: null, bone_to: '', strength: 1, falloff_type: 'SMOOTH', falloff_radius: 1, use_volume_preserve: false, texture: null, vertex_group: '', invert_vertex_group: false }), deps: (m) => [m.object_from as string, m.object_to as string], apply: warpMod },
  WAVE: {
    type: 'WAVE',
    label: 'Wave',
    category: 'DEFORM',
    icon: 'mod_wave',
    deformOnly: true,
    defaults: base({ use_x: true, use_y: true, use_cyclic: true, use_normal: false, use_normal_x: true, use_normal_y: true, use_normal_z: true, falloff_radius: 0, height: 0.5, width: 1.5, narrowness: 1.5, start_position_x: 0, start_position_y: 0, start_position_object: null, time_offset: 0, lifetime: 0, damping_time: 10, speed: 0.25, vertex_group: '', invert_vertex_group: false }),
    deps: (m) => [m.start_position_object as string],
    timeDependent: () => true,
    apply: wave,
  },
  // Normals
  SMOOTH_BY_ANGLE: {
    type: 'SMOOTH_BY_ANGLE',
    label: 'Smooth by Angle',
    category: 'NORMALS',
    icon: 'mod_normaledit',
    defaults: base({ angle: (30 * Math.PI) / 180, use_pin_to_last: false }),
    apply: (m, mod) => ({ ...m, smooth: new Uint8Array(m.offsets.length - 1).fill(1), auto_smooth_angle: num(mod, 'angle', (30 * Math.PI) / 180) }),
  },
};

export function registerModifier(t: ModifierType) {
  modifierTypes[t.type] = t;
}

export function newModifier(type: string, id: string, existing: { name: string }[]): ModifierBase {
  const t = modifierTypes[type];
  let name = t?.label ?? type;
  if (existing.some((m) => m.name === name)) {
    let i = 1;
    while (existing.some((m) => m.name === `${name}.${String(i).padStart(3, '0')}`)) i++;
    name = `${name}.${String(i).padStart(3, '0')}`;
  }
  return { id, name, type, show_viewport: true, show_render: true, show_in_editmode: !!t?.supportsEditMode || !!t?.deformOnly, show_on_cage: false, show_expanded: true, ...(t?.defaults() ?? {}) };
}
