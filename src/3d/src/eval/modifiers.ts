// Modifier stack implementations (independently implemented geometry algorithms).
import { Matrix4, Vector3 } from 'three';
import type { ModifierBase } from '../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from './types';
import { MeshBuilder, appendMesh, weightsOf, groupWeights, vertexNormals } from './meshbuild';
import { edgeTopology, polyNormal, triangulatePoly, vertexFaces } from '../mesh/mesh';
import { skinPositions } from './armature';
import { proceduralTexture } from './textures';
import { simplifySubdivision } from './simplify';

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

export function catmullClark(m: EvalMesh, levels: number, simple = false, useCreases = true): EvalMesh {
  let mesh = m;
  for (let l = 0; l < levels; l++) mesh = subdivideOnce(mesh, simple, useCreases);
  return mesh;
}

function subdivideOnce(m: EvalMesh, simple: boolean, useCreases: boolean): EvalMesh {
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
      if (bcount[v] === 2) for (let k = 0; k < 3; k++) vp[v * 3 + k] = (Bsum[v * 3 + k] + 6 * P[v * 3 + k]) / 8;
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

function bisect(m: EvalMesh, axis: number, keepPositive: boolean, origin: number): EvalMesh {
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
  const eps = 1e-6;
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
    if (bisectAxes[axis]) local = bisect(local, axis, !flipAxes[axis], 0);
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
    if (bool(mod, 'use_mirror_u') || bool(mod, 'use_mirror_v')) {
      const uv = local.uvs.slice();
      for (let i = 0; i < uv.length; i += 2) {
        if (bool(mod, 'use_mirror_u')) uv[i] = 1 - uv[i] + num(mod, 'mirror_offset_u');
        if (bool(mod, 'use_mirror_v')) uv[i + 1] = 1 - uv[i + 1] + num(mod, 'mirror_offset_v');
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

export function weld(m: EvalMesh, threshold: number, onlyLoose = false): EvalMesh {
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
            if ((P[u * 3] - x) ** 2 + (P[u * 3 + 1] - y) ** 2 + (P[u * 3 + 2] - z) ** 2 <= threshold * threshold) {
              found = u;
              break;
            }
        }
    if (found >= 0) target[v] = found;
    else {
      target[v] = v;
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
  if (str(mod, 'fit_type', 'FIXED_COUNT') === 'FIT_LENGTH') {
    const len = off.length() || 1;
    count = Math.max(1, Math.floor(num(mod, 'fit_length', 4) / len) + 1);
  }
  count = Math.min(count, 1000);
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const cur = new Matrix4();
  const v = new Vector3();
  const nv = P.length / 3;
  const uOff = num(mod, 'offset_u'),
    vOff = num(mod, 'offset_v');
  for (let i = 0; i < count; i++) {
    const map = new Int32Array(nv);
    for (let k = 0; k < nv; k++) {
      v.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]).applyMatrix4(cur);
      map[k] = b.addVert(v.x, v.y, v.z, i === 0 ? m.origIndex?.[k] ?? k : -1, weightsOf(m, k));
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
  let out = b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle, instances: m.instances });
  if (bool(mod, 'use_merge_vertices')) out = weld(out, num(mod, 'merge_threshold', 0.01));
  return out;
}

function solidify(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const t = num(mod, 'thickness', 0.01),
    offset = num(mod, 'offset', -1);
  const even = bool(mod, 'use_even_offset');
  const rim = bool(mod, 'use_rim', true),
    rimOnly = bool(mod, 'use_rim_only');
  const vn = vertexNormals(m);
  const P = m.positions,
    nv = P.length / 3;
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const inner = (offset - 1) / 2,
    outer = (offset + 1) / 2;
  const a = new Int32Array(nv),
    c = new Int32Array(nv);
  // even thickness: scale by 1/cos(angle) between vertex normal and adjacent face normals
  let scale: Float32Array | null = null;
  if (even) {
    scale = new Float32Array(nv).fill(1);
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
      if (k) scale[v] = 1 / (sum / k);
    }
  }
  for (let v = 0; v < nv; v++) {
    const s = scale ? scale[v] : 1;
    a[v] = b.addVert(P[v * 3] + vn[v * 3] * t * outer * s, P[v * 3 + 1] + vn[v * 3 + 1] * t * outer * s, P[v * 3 + 2] + vn[v * 3 + 2] * t * outer * s, m.origIndex?.[v] ?? v, weightsOf(m, v));
  }
  for (let v = 0; v < nv; v++) {
    const s = scale ? scale[v] : 1;
    c[v] = b.addVert(P[v * 3] + vn[v * 3] * t * inner * s, P[v * 3 + 1] + vn[v * 3 + 1] * t * inner * s, P[v * 3 + 2] + vn[v * 3 + 2] * t * inner * s, -1, weightsOf(m, v));
  }
  const matOff = Math.round(num(mod, 'material_offset')),
    rimMat = Math.round(num(mod, 'material_offset_rim'));
  if (!rimOnly) {
    appendMesh(b, m, a);
    const shifted = matOff && m.material_index ? { ...m, material_index: m.material_index.map((x) => x + matOff) as Uint16Array } : m;
    appendMesh(b, shifted, c, true);
  }
  if (rim) {
    const et = edgeTopology(m);
    for (let ci = 0; ci < m.indices.length; ci++) {
      const e = et.cornerEdge[ci];
      if (et.faceOffsets[e + 1] - et.faceOffsets[e] !== 1) continue;
      const f = et.cornerFace[ci];
      const s = m.offsets[f],
        en = m.offsets[f + 1];
      const v0 = m.indices[ci],
        v1 = m.indices[ci + 1 < en ? ci + 1 : s];
      b.addFace([a[v1], a[v0], c[v0], c[v1]], [0, 0, 1, 0, 1, 1, 0, 1], m.smooth?.[f] ?? 0, (m.material_index?.[f] ?? 0) + rimMat);
    }
  }
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle });
}

function triangulateMeshMod(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const minVerts = Math.max(4, Math.round(num(mod, 'min_vertices', 4)));
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
    triangulatePoly(P, m.indices.subarray(s, e), tmp, 0);
    for (let i = 0; i < tmp.length; i += 3) {
      const cs = [s + tmp[i], s + tmp[i + 1], s + tmp[i + 2]];
      b.addFace(cs.map((c) => m.indices[c]), cs.flatMap((c) => [m.uvs[c * 2], m.uvs[c * 2 + 1]]), m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0);
    }
  }
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle });
}

function screw(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const angle = num(mod, 'angle', Math.PI * 2),
    steps = Math.max(2, Math.round(num(mod, 'steps', 16))),
    height = num(mod, 'screw_offset', 0),
    iterations = Math.max(1, Math.round(num(mod, 'iterations', 1)));
  const axis = ['X', 'Y', 'Z'].indexOf(str(mod, 'axis', 'Z'));
  const ax = new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  const P = m.positions,
    nv = P.length / 3;
  // profile edges: loose edges or boundary edges of the input (use all edges if mesh has no faces)
  const et = edgeTopology(m);
  let pairs: number[] = [];
  if (m.offsets.length - 1 === 0) pairs = Array.from(m.looseEdges ?? []);
  else for (let e = 0; e < et.count; e++) pairs.push(et.verts[e * 2], et.verts[e * 2 + 1]);
  const full = Math.abs(Math.abs(angle) - Math.PI * 2) < 1e-4 && !height;
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
      v.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]).applyMatrix4(rot).addScaledVector(ax, height * iterations * t);
      row.push(b.addVert(v.x, v.y, v.z, r === 0 ? k : -1));
    }
    ids.push(row);
  }
  const smooth = bool(mod, 'use_smooth_shade') ? 1 : 0;
  for (let r = 0; r < total; r++) {
    const a = ids[r],
      c = ids[(r + 1) % rings];
    for (let i = 0; i < pairs.length; i += 2) {
      const p = pairs[i],
        q = pairs[i + 1];
      b.addFace([a[p], a[q], c[q], c[p]], [r / total, 0, r / total, 1, (r + 1) / total, 1, (r + 1) / total, 0], smooth);
    }
  }
  let out = b.build();
  if (bool(mod, 'use_flip')) out = transformMesh(out, new Matrix4().makeScale(1, 1, 1)); // winding handled below
  if (bool(mod, 'use_merge_vertices')) out = weld(out, num(mod, 'merge_threshold', 0.01));
  return out;
}

function maskMesh(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const w = groupWeights(m, str(mod, 'vertex_group'));
  if (!w) return m;
  const thr = num(mod, 'threshold', 0),
    invert = bool(mod, 'invert_vertex_group');
  const keep = (v: number) => (w[v] > thr) !== invert;
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
  // Builds a square tube along every edge (simplified, closed per edge).
  const t = num(mod, 'thickness', 0.02) / 2;
  const et = edgeTopology(m);
  const P = m.positions;
  const b = new MeshBuilder();
  const up = new Vector3(),
    side = new Vector3(),
    dir = new Vector3();
  const vn = vertexNormals(m);
  for (let e = 0; e < et.count; e++) {
    const a = et.verts[e * 2],
      c = et.verts[e * 2 + 1];
    const pa = new Vector3(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]),
      pc = new Vector3(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
    dir.subVectors(pc, pa).normalize();
    up.set(vn[a * 3] + vn[c * 3], vn[a * 3 + 1] + vn[c * 3 + 1], vn[a * 3 + 2] + vn[c * 3 + 2]).normalize();
    if (up.lengthSq() < 1e-6 || Math.abs(up.dot(dir)) > 0.99) up.set(0, 0, 1);
    side.crossVectors(dir, up).normalize();
    up.crossVectors(side, dir).normalize();
    const ring = (p: Vector3) =>
      [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ].map(([sx, sy]) => {
        const q = p.clone().addScaledVector(side, sx * t).addScaledVector(up, sy * t).addScaledVector(dir, 0);
        return b.addVert(q.x, q.y, q.z);
      });
    const ra = ring(pa.clone().addScaledVector(dir, -t)),
      rc = ring(pc.clone().addScaledVector(dir, t));
    for (let k = 0; k < 4; k++) b.addFace([ra[k], ra[(k + 1) % 4], rc[(k + 1) % 4], rc[k]]);
    b.addFace([...ra].reverse());
    b.addFace(rc);
  }
  return b.build();
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
      const f = factor * (w ? w[v] : 1);
      for (let k = 0; k < 3; k++) if (axes[k]) out[v * 3 + k] = P[v * 3 + k] + (sum[v * 3 + k] / cnt[v] - P[v * 3 + k]) * f;
    }
    P = out;
  }
  return { ...m, positions: P };
}

function laplacianSmooth(m: EvalMesh, mod: ModifierBase): EvalMesh {
  // volume-preserving variant: smooth then restore average displacement magnitude
  const smoothed = smoothMesh(m, { ...mod, factor: num(mod, 'lambda_factor', 0.5), iterations: num(mod, 'iterations', 1) });
  if (!bool(mod, 'use_volume_preserve', true)) return smoothed;
  const P = m.positions,
    S = smoothed.positions;
  const center = [0, 0, 0];
  for (let i = 0; i < P.length; i++) center[i % 3] += P[i] / (P.length / 3);
  const sc = [0, 0, 0];
  for (let i = 0; i < S.length; i++) sc[i % 3] += S[i] / (S.length / 3);
  let r0 = 0,
    r1 = 0;
  for (let i = 0; i < P.length; i += 3) {
    r0 += Math.hypot(P[i] - center[0], P[i + 1] - center[1], P[i + 2] - center[2]);
    r1 += Math.hypot(S[i] - sc[0], S[i + 1] - sc[1], S[i + 2] - sc[2]);
  }
  const k = r1 > 0 ? r0 / r1 : 1;
  const out = new Float32Array(S.length);
  for (let i = 0; i < S.length; i++) out[i] = sc[i % 3] + (S[i] - sc[i % 3]) * k + (center[i % 3] - sc[i % 3]);
  return { ...m, positions: out };
}

function cast(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const f = num(mod, 'factor', 0.5),
    type = str(mod, 'cast_type', 'SPHERE');
  const use = [bool(mod, 'use_x', true), bool(mod, 'use_y', true), bool(mod, 'use_z', true)];
  const P = m.positions;
  let r = num(mod, 'radius', 0);
  if (!r) {
    let sum = 0;
    for (let i = 0; i < P.length; i += 3) sum += type === 'CYLINDER' ? Math.hypot(P[i], P[i + 1]) : Math.hypot(P[i], P[i + 1], P[i + 2]);
    r = sum / (P.length / 3 || 1);
  }
  return deform(m, mod, (p) => {
    let target: Vector3;
    if (type === 'SPHERE') target = p.clone().normalize().multiplyScalar(r);
    else if (type === 'CYLINDER') {
      const l = Math.hypot(p.x, p.y) || 1;
      target = new Vector3((p.x / l) * r, (p.y / l) * r, p.z);
    } else {
      const s = r / Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z), 1e-9);
      target = p.clone().multiplyScalar(s);
    }
    if (use[0]) p.x += (target.x - p.x) * f;
    if (use[1]) p.y += (target.y - p.y) * f;
    if (use[2]) p.z += (target.z - p.z) * f;
  });
}

function simpleDeform(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const method = str(mod, 'deform_method', 'TWIST'),
    angle = num(mod, 'angle', (45 * Math.PI) / 180),
    factor = num(mod, 'factor', 0.785398);
  const axis = ['X', 'Y', 'Z'].indexOf(str(mod, 'deform_axis', 'Z'));
  const limits = (mod.limits as number[]) ?? [0, 1];
  const origin = mod.origin ? objectSpaceOf(ctx, mod.origin) : null;
  const P = m.positions;
  let lo = Infinity,
    hi = -Infinity;
  for (let i = axis; i < P.length; i += 3) {
    lo = Math.min(lo, P[i]);
    hi = Math.max(hi, P[i]);
  }
  const lmin = lo + (hi - lo) * limits[0],
    lmax = lo + (hi - lo) * limits[1];
  const toO = origin ? origin.clone().invert() : null;
  const out = deform(m, mod, (p) => {
    if (toO) p.applyMatrix4(toO);
    const c = [p.x, p.y, p.z];
    const a = axis,
      b = (axis + 1) % 3,
      d = (axis + 2) % 3;
    const h = Math.max(lmin, Math.min(lmax, c[a]));
    if (method === 'TWIST') {
      const th = (angle * h) / (hi - lo || 1);
      const x = c[b] * Math.cos(th) - c[d] * Math.sin(th),
        y = c[b] * Math.sin(th) + c[d] * Math.cos(th);
      c[b] = x;
      c[d] = y;
    } else if (method === 'BEND') {
      // bend around axis `a`: points along b-axis bend in b/d plane
      const th = (angle * c[b]) / (hi - lo || 1);
      if (Math.abs(angle) > 1e-6) {
        const R = (hi - lo || 1) / angle;
        const x = Math.sin(th) * (R - c[d]),
          y = R - Math.cos(th) * (R - c[d]);
        c[b] = x;
        c[d] = y;
      }
    } else if (method === 'TAPER') {
      const s = 1 + h * factor;
      c[b] *= s;
      c[d] *= s;
    } else if (method === 'STRETCH') {
      const s = 1 + factor;
      c[a] = c[a] * s;
      const sv = 1 / Math.sqrt(Math.max(1e-6, s));
      c[b] *= sv;
      c[d] *= sv;
    }
    p.set(c[0], c[1], c[2]);
    if (origin) p.applyMatrix4(origin);
  });
  return out;
}

function wave(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const height = num(mod, 'height', 0.5),
    width = num(mod, 'width', 1.5),
    speed = num(mod, 'speed', 0.25),
    narrow = num(mod, 'narrowness', 1.5);
  const start = num(mod, 'time_offset', 0);
  const useX = bool(mod, 'use_x', true),
    useY = bool(mod, 'use_y', true);
  const t = (ctx.frame - start) * speed;
  const vn = bool(mod, 'use_normal') ? vertexNormals(m) : null;
  return deform(m, mod, (p, i) => {
    let d = 0;
    if (useX && useY) d = Math.hypot(p.x, p.y);
    else if (useX) d = Math.abs(p.x);
    else if (useY) d = Math.abs(p.y);
    const x = (d - t) / width;
    const amp = height * Math.exp(-narrow * x * x) * Math.cos(x * Math.PI * 2);
    if (vn) p.addScaledVector(new Vector3(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]), amp);
    else p.z += amp;
  });
}

function displace(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const strength = num(mod, 'strength', 1),
    mid = num(mod, 'mid_level', 0.5),
    dir = str(mod, 'direction', 'NORMAL');
  const vn = dir === 'NORMAL' ? vertexNormals(m) : null;
  const tex = (mod.texture as Record<string, unknown> | null) ?? null;
  const coords = str(mod, 'texture_coords', 'LOCAL');
  return deform(m, mod, (p, i) => {
    let value = 1;
    if (tex) {
      let q = p;
      if (coords === 'GLOBAL') q = p.clone().applyMatrix4(ctx.graph.get(ctx.ob.id)!.world);
      value = proceduralTexture(tex, q.x, q.y, q.z);
    }
    const d = (value - mid) * strength;
    if (vn) p.addScaledVector(new Vector3(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]), d);
    else if (dir === 'X') p.x += d;
    else if (dir === 'Y') p.y += d;
    else if (dir === 'Z') p.z += d;
  });
}

function armatureMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const armOb = typeof mod.object === 'string' ? ctx.graph.get(mod.object) : undefined;
  if (!armOb?.pose || !m.vertex_groups || !m.weights) return m;
  const own = ctx.graph.get(ctx.ob.id)!.world;
  const meshToArm = armOb.world.clone().invert().multiply(own);
  const armToMesh = meshToArm.clone().invert();
  const positions = skinPositions(m.positions, m.vertex_groups, m.weights, armOb.pose, meshToArm, armToMesh, bool(mod, 'use_deform_preserve_volume'));
  return { ...m, positions };
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
  return deform(m, mod, (p) => {
    p.applyMatrix4(toLat);
    // trilinear interpolation of displacement from rest grid
    const fu = U > 1 ? Math.max(0, Math.min(U - 1.0001, (p.x + 0.5) * (U - 1))) : 0,
      fv = V > 1 ? Math.max(0, Math.min(V - 1.0001, (p.y + 0.5) * (V - 1))) : 0,
      fw = W > 1 ? Math.max(0, Math.min(W - 1.0001, (p.z + 0.5) * (W - 1))) : 0;
    const iu = Math.floor(fu),
      iv = Math.floor(fv),
      iw = Math.floor(fw),
      tu = fu - iu,
      tv = fv - iv,
      tw = fw - iw;
    const d = new Vector3();
    for (let a = 0; a < 2; a++)
      for (let b = 0; b < 2; b++)
        for (let c = 0; c < 2; c++) {
          const u = Math.min(U - 1, iu + a),
            v = Math.min(V - 1, iv + b),
            w = Math.min(W - 1, iw + c);
          const idx = ((w * V + v) * U + u) * 3;
          const wt = (a ? tu : 1 - tu) * (b ? tv : 1 - tv) * (c ? tw : 1 - tw);
          d.x += (points[idx] - rest(u, U)) * wt;
          d.y += (points[idx + 1] - rest(v, V)) * wt;
          d.z += (points[idx + 2] - rest(w, W)) * wt;
        }
    p.addScaledVector(d, strength);
    p.applyMatrix4(back);
  });
}

function hookMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const target = typeof mod.object === 'string' ? ctx.graph.get(mod.object) : undefined;
  if (!target) return m;
  const own = ctx.graph.get(ctx.ob.id)!.world;
  const inv = new Matrix4().fromArray((mod.matrix_inverse as number[]) ?? new Matrix4().elements);
  const mat = own.clone().invert().multiply(target.world).multiply(inv).multiply(own);
  const strength = num(mod, 'strength', 1),
    falloff = num(mod, 'falloff_radius', 0);
  const center = new Vector3(...((mod.center as number[]) ?? [0, 0, 0]));
  const verts = new Set((mod.vertex_indices as number[]) ?? []);
  const hasGroup = !!groupWeights(m, str(mod, 'vertex_group'));
  return deform(m, mod, (p, i) => {
    const orig = m.origIndex ? m.origIndex[i] : i;
    if (!hasGroup && verts.size && !verts.has(orig)) return;
    const q = p.clone().applyMatrix4(mat);
    let f = strength;
    if (falloff > 0) f *= Math.max(0, 1 - p.distanceTo(center) / falloff);
    p.lerp(q, f);
  });
}

function warpMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const from = typeof mod.object_from === 'string' ? ctx.graph.get(mod.object_from) : undefined,
    to = typeof mod.object_to === 'string' ? ctx.graph.get(mod.object_to) : undefined;
  if (!from || !to) return m;
  const own = ctx.graph.get(ctx.ob.id)!.world,
    inv = own.clone().invert();
  const pf = new Vector3().setFromMatrixPosition(from.world).applyMatrix4(inv),
    pt = new Vector3().setFromMatrixPosition(to.world).applyMatrix4(inv);
  const radius = num(mod, 'falloff_radius', 1),
    strength = num(mod, 'strength', 1);
  const delta = pt.clone().sub(pf);
  return deform(m, mod, (p) => {
    const d = p.distanceTo(pf);
    const f = d < radius ? (1 - d / radius) ** 2 * (3 - 2 * (1 - d / radius)) : 0;
    p.addScaledVector(delta, f * strength);
  });
}

function shrinkwrapMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const target = typeof mod.target === 'string' ? ctx.graph.get(mod.target) : undefined;
  if (!target?.mesh) return m;
  const own = ctx.graph.get(ctx.ob.id)!.world;
  const toT = target.world.clone().invert().multiply(own),
    back = toT.clone().invert();
  const TP = target.mesh.positions;
  const offset = num(mod, 'offset', 0);
  // nearest point on triangles (brute force with a coarse spatial hash)
  const tri: number[] = [];
  for (let f = 0; f < target.mesh.offsets.length - 1; f++) {
    const s = target.mesh.offsets[f],
      e = target.mesh.offsets[f + 1];
    for (let c = s + 1; c < e - 1; c++) tri.push(target.mesh.indices[s], target.mesh.indices[c], target.mesh.indices[c + 1]);
  }
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3(),
    best = new Vector3(),
    tmp = new Vector3();
  return deform(m, mod, (p) => {
    p.applyMatrix4(toT);
    let bd = Infinity;
    for (let i = 0; i < tri.length; i += 3) {
      a.fromArray(TP, tri[i] * 3);
      b.fromArray(TP, tri[i + 1] * 3);
      c.fromArray(TP, tri[i + 2] * 3);
      closestPointOnTriangle(p, a, b, c, tmp);
      const d = tmp.distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best.copy(tmp);
      }
    }
    if (bd < Infinity) {
      if (offset) {
        const dir = p.clone().sub(best);
        if (dir.lengthSq() > 0) best.addScaledVector(dir.normalize(), offset);
      }
      p.copy(best);
    }
    p.applyMatrix4(back);
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
  // sample the first spline into an arc-length table in mesh space
  // (imported lazily to avoid a circular dependency)
  const own = ctx.graph.get(ctx.ob.id)!.world;
  const toMesh = own.clone().invert().multiply(t.world);
  const pts = curvePolyline(cu).map((p) => new Vector3(...p).applyMatrix4(toMesh));
  if (pts.length < 2) return m;
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = lens[lens.length - 1] || 1;
  const axis = ['POS_X', 'POS_Y', 'POS_Z', 'NEG_X', 'NEG_Y', 'NEG_Z'].indexOf(str(mod, 'deform_axis', 'POS_X'));
  const ai = axis % 3,
    sign = axis >= 3 ? -1 : 1;
  return deform(m, mod, (p) => {
    const c = [p.x, p.y, p.z];
    const s = c[ai] * sign;
    const d = Math.max(0, Math.min(total, s));
    let i = 1;
    while (i < lens.length - 1 && lens[i] < d) i++;
    const k = (d - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
    const pos = pts[i - 1].clone().lerp(pts[i], k);
    const tan = pts[i].clone().sub(pts[i - 1]).normalize();
    const up = Math.abs(tan.z) < 0.99 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
    const side = new Vector3().crossVectors(up, tan).normalize();
    const nup = new Vector3().crossVectors(tan, side);
    const o1 = c[(ai + 1) % 3],
      o2 = c[(ai + 2) % 3];
    const extra = s - d; // beyond the end: continue straight
    pos.addScaledVector(tan, extra).addScaledVector(side, ai === 0 ? -o1 : o1).addScaledVector(nup, o2);
    p.copy(pos);
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
    defaults: base({ count: 2, fit_type: 'FIXED_COUNT', fit_length: 4, use_relative_offset: true, relative_offset_displace: [1, 0, 0], use_constant_offset: false, constant_offset_displace: [0.1, 0, 0], use_object_offset: false, offset_object: null, use_merge_vertices: false, merge_threshold: 0.01, offset_u: 0, offset_v: 0 }),
    deps: (m) => [m.offset_object as string],
    apply: arrayMesh,
  },
  BUILD: { type: 'BUILD', label: 'Build', category: 'GENERATE', icon: 'mod_build', defaults: base({ frame_start: 1, frame_duration: 100, use_random_order: false, seed: 0, use_reverse: false }), timeDependent: () => true, apply: build },
  EDGE_SPLIT: { type: 'EDGE_SPLIT', label: 'Edge Split', category: 'GENERATE', icon: 'mod_edgesplit', defaults: base({ use_edge_angle: true, split_angle: (30 * Math.PI) / 180, use_edge_sharp: true }), apply: edgeSplit },
  MASK: { type: 'MASK', label: 'Mask', category: 'GENERATE', icon: 'mod_mask', defaults: base({ mode: 'VERTEX_GROUP', vertex_group: '', invert_vertex_group: false, threshold: 0 }), apply: maskMesh },
  MIRROR: {
    type: 'MIRROR',
    label: 'Mirror',
    category: 'GENERATE',
    icon: 'mod_mirror',
    defaults: base({ use_axis: [true, false, false], use_bisect_axis: [false, false, false], use_bisect_flip_axis: [false, false, false], mirror_object: null, use_clip: false, use_mirror_merge: true, merge_threshold: 0.001, use_mirror_u: false, use_mirror_v: false, mirror_offset_u: 0, mirror_offset_v: 0, use_mirror_vertex_groups: true }),
    deps: (m) => [m.mirror_object as string],
    supportsEditMode: true,
    apply: mirrorMesh,
  },
  SCREW: { type: 'SCREW', label: 'Screw', category: 'GENERATE', icon: 'mod_screw', defaults: base({ angle: Math.PI * 2, steps: 16, render_steps: 16, screw_offset: 0, iterations: 1, axis: 'Z', use_merge_vertices: false, merge_threshold: 0.01, use_smooth_shade: true, use_flip: false }), apply: screw },
  SOLIDIFY: { type: 'SOLIDIFY', label: 'Solidify', category: 'GENERATE', icon: 'mod_solidify', defaults: base({ thickness: 0.01, offset: -1, use_even_offset: false, use_rim: true, use_rim_only: false, material_offset: 0, material_offset_rim: 0, vertex_group: '' }), apply: solidify },
  SUBSURF: {
    type: 'SUBSURF',
    label: 'Subdivision Surface',
    category: 'GENERATE',
    icon: 'mod_subsurf',
    defaults: base({ subdivision_type: 'CATMULL_CLARK', levels: 1, render_levels: 2, quality: 3, use_creases: true, use_limit_surface: true, uv_smooth: 'PRESERVE_BOUNDARIES', boundary_smooth: 'ALL' }),
    supportsEditMode: true,
    apply: (m, mod, ctx) => catmullClark(m, Math.min(6, simplifySubdivision(ctx.doc, ctx.render), Math.round(ctx.render ? num(mod, 'render_levels', 2) : num(mod, 'levels', 1))), str(mod, 'subdivision_type') === 'SIMPLE', bool(mod, 'use_creases', true)),
  },
  TRIANGULATE: { type: 'TRIANGULATE', label: 'Triangulate', category: 'GENERATE', icon: 'mod_triangulate', defaults: base({ quad_method: 'BEAUTY', ngon_method: 'BEAUTY', min_vertices: 4 }), apply: triangulateMeshMod },
  WELD: { type: 'WELD', label: 'Weld', category: 'GENERATE', icon: 'automerge_off', defaults: base({ merge_threshold: 0.001, mode: 'ALL' }), apply: (m, mod) => weld(m, num(mod, 'merge_threshold', 0.001), str(mod, 'mode') === 'CONNECTED') },
  WIREFRAME: { type: 'WIREFRAME', label: 'Wireframe', category: 'GENERATE', icon: 'mod_wireframe', defaults: base({ thickness: 0.02, use_replace: true }), apply: wireframe },
  // Deform
  ARMATURE: { type: 'ARMATURE', label: 'Armature', category: 'DEFORM', icon: 'mod_armature', deformOnly: true, defaults: base({ object: null, use_vertex_groups: true, use_bone_envelopes: false, use_deform_preserve_volume: false }), deps: (m) => [m.object as string], apply: armatureMod },
  CAST: { type: 'CAST', label: 'Cast', category: 'DEFORM', icon: 'mod_cast', deformOnly: true, defaults: base({ cast_type: 'SPHERE', factor: 0.5, radius: 0, use_x: true, use_y: true, use_z: true, vertex_group: '' }), apply: cast },
  CURVE: { type: 'CURVE', label: 'Curve', category: 'DEFORM', icon: 'mod_curve', deformOnly: true, defaults: base({ object: null, deform_axis: 'POS_X', vertex_group: '' }), deps: (m) => [m.object as string], apply: curveMod },
  DISPLACE: {
    type: 'DISPLACE',
    label: 'Displace',
    category: 'DEFORM',
    icon: 'mod_displace',
    deformOnly: true,
    defaults: base({ strength: 1, mid_level: 0.5, direction: 'NORMAL', texture_coords: 'LOCAL', vertex_group: '', texture: { type: 'CLOUDS', noise_scale: 0.25, noise_depth: 2, contrast: 1, brightness: 1 } }),
    apply: displace,
  },
  HOOK: { type: 'HOOK', label: 'Hook', category: 'DEFORM', icon: 'hook', deformOnly: true, defaults: base({ object: null, strength: 1, falloff_radius: 0, center: [0, 0, 0], vertex_indices: [], matrix_inverse: new Matrix4().toArray(), vertex_group: '' }), deps: (m) => [m.object as string], apply: hookMod },
  LAPLACIANSMOOTH: { type: 'LAPLACIANSMOOTH', label: 'Smooth Laplacian', category: 'DEFORM', icon: 'mod_smooth', deformOnly: true, defaults: base({ iterations: 1, lambda_factor: 0.5, use_volume_preserve: true, vertex_group: '' }), apply: laplacianSmooth },
  LATTICE: { type: 'LATTICE', label: 'Lattice', category: 'DEFORM', icon: 'mod_lattice', deformOnly: true, defaults: base({ object: null, strength: 1, vertex_group: '' }), deps: (m) => [m.object as string], apply: latticeMod },
  SHRINKWRAP: { type: 'SHRINKWRAP', label: 'Shrinkwrap', category: 'DEFORM', icon: 'mod_shrinkwrap', deformOnly: true, defaults: base({ target: null, wrap_method: 'NEAREST_SURFACEPOINT', offset: 0, vertex_group: '' }), deps: (m) => [m.target as string], apply: shrinkwrapMod },
  SIMPLE_DEFORM: { type: 'SIMPLE_DEFORM', label: 'Simple Deform', category: 'DEFORM', icon: 'mod_simpledeform', deformOnly: true, defaults: base({ deform_method: 'TWIST', angle: (45 * Math.PI) / 180, factor: 0.785398, deform_axis: 'Z', origin: null, limits: [0, 1], vertex_group: '' }), deps: (m) => [m.origin as string], apply: simpleDeform },
  SMOOTH: { type: 'SMOOTH', label: 'Smooth', category: 'DEFORM', icon: 'mod_smooth', deformOnly: true, defaults: base({ factor: 0.5, iterations: 1, use_x: true, use_y: true, use_z: true, vertex_group: '' }), apply: smoothMesh },
  WARP: { type: 'WARP', label: 'Warp', category: 'DEFORM', icon: 'mod_warp', deformOnly: true, defaults: base({ object_from: null, object_to: null, strength: 1, falloff_radius: 1, vertex_group: '' }), deps: (m) => [m.object_from as string, m.object_to as string], apply: warpMod },
  WAVE: { type: 'WAVE', label: 'Wave', category: 'DEFORM', icon: 'mod_wave', deformOnly: true, defaults: base({ use_x: true, use_y: true, use_normal: false, time_offset: 0, height: 0.5, width: 1.5, narrowness: 1.5, speed: 0.25, vertex_group: '' }), timeDependent: () => true, apply: wave },
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
