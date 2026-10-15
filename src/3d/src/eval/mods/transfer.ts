// Data Transfer: copies vertex, edge, face corner and face data from another mesh, matching
// elements by topology, proximity, interpolation or projection.
import { Matrix4, Vector3 } from 'three';
import type { MeshData, ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier } from '../modifiers';
import { bool, num, objId, str, vgroupFactor } from './common';
import { EdgeQuery, PointQuery, SurfaceQuery, segmentClosest } from './spatial';
import { edgeTopology, faceNormals, vertexFaces } from '../../mesh/mesh';
import { vertexNormals } from '../meshbuild';
import { currentCornerNormals } from './normals';

/** Weighted references into the source mesh for one destination element. */
type Map1 = { idx: number[]; w: number[] } | null;

interface Ctx {
  src: EvalMesh;
  dst: EvalMesh;
  /** source positions in destination space */
  SP: Float32Array;
  maxDist: number;
  surface: () => SurfaceQuery;
  points: () => PointQuery;
  edges: () => EdgeQuery;
}

function lazy<T>(f: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= f());
}

const single = (i: number): Map1 => ({ idx: [i], w: [1] });

/** Map destination vertices to source vertices. */
function mapVerts(c: Ctx, mode: string): Map1[] {
  const { dst, src, SP } = c;
  const nv = dst.positions.length / 3,
    ns = SP.length / 3;
  const out: Map1[] = new Array(nv).fill(null);
  const p = new Vector3();
  if (mode === 'TOPOLOGY') {
    if (ns !== nv) return out;
    for (let i = 0; i < nv; i++) out[i] = single(i);
    return out;
  }
  const dn = mode === 'POLYINTERP_VNORPROJ' ? vertexNormals(dst) : null;
  for (let i = 0; i < nv; i++) {
    p.fromArray(dst.positions, i * 3);
    switch (mode) {
      case 'NEAREST': {
        const r = c.points().nearest(p);
        if (r && r.dist <= c.maxDist) out[i] = single(r.index);
        break;
      }
      case 'EDGE_NEAREST':
      case 'EDGEINTERP_NEAREST': {
        const r = c.edges().nearest(p);
        if (!r || r.dist > c.maxDist) break;
        const a = c.edges().edges[r.edge * 2],
          b = c.edges().edges[r.edge * 2 + 1];
        if (mode === 'EDGEINTERP_NEAREST') out[i] = { idx: [a, b], w: [1 - r.t, r.t] };
        else out[i] = single(r.t < 0.5 ? a : b);
        break;
      }
      case 'POLY_NEAREST':
      case 'POLYINTERP_NEAREST': {
        const h = c.surface().nearest(p, c.maxDist);
        if (!h) break;
        if (mode === 'POLYINTERP_NEAREST') out[i] = { idx: [...h.tri], w: [...h.bary] };
        else {
          // nearest vertex of the nearest face
          let best = -1,
            bd = Infinity;
          for (let k = src.offsets[h.face]; k < src.offsets[h.face + 1]; k++) {
            const v = src.indices[k];
            const d = (SP[v * 3] - p.x) ** 2 + (SP[v * 3 + 1] - p.y) ** 2 + (SP[v * 3 + 2] - p.z) ** 2;
            if (d < bd) {
              bd = d;
              best = v;
            }
          }
          out[i] = single(best);
        }
        break;
      }
      case 'POLYINTERP_VNORPROJ': {
        const d = new Vector3().fromArray(dn!, i * 3);
        const h = projectBoth(c.surface(), p, d, c.maxDist);
        if (h) out[i] = { idx: [...h.tri], w: [...h.bary] };
        break;
      }
    }
  }
  return out;
}

function projectBoth(s: SurfaceQuery, p: Vector3, dir: Vector3, maxDist: number) {
  const a = s.raycast(p, dir, maxDist),
    b = s.raycast(p, dir.clone().negate(), maxDist);
  if (a && b) return a.distance <= b.distance ? a : b;
  return a ?? b;
}

/** Map destination edges (from edgeTopology) to source edges (indices into EdgeQuery.edges). */
function mapEdges(c: Ctx, mode: string, dstEdges: Uint32Array, srcEdges: Uint32Array): Map1[] {
  const { dst, SP } = c;
  const ne = dstEdges.length / 2;
  const out: Map1[] = new Array(ne).fill(null);
  if (mode === 'TOPOLOGY') {
    if (srcEdges.length !== dstEdges.length) return out;
    for (let e = 0; e < ne; e++) out[e] = single(e);
    return out;
  }
  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const srcIndex = new Map<string, number>();
  for (let e = 0; e < srcEdges.length / 2; e++) srcIndex.set(key(srcEdges[e * 2], srcEdges[e * 2 + 1]), e);
  const P = dst.positions;
  const pa = new Vector3(),
    pb = new Vector3(),
    mid = new Vector3();
  for (let e = 0; e < ne; e++) {
    pa.fromArray(P, dstEdges[e * 2] * 3);
    pb.fromArray(P, dstEdges[e * 2 + 1] * 3);
    mid.addVectors(pa, pb).multiplyScalar(0.5);
    if (mode === 'VERT_NEAREST') {
      const ra = c.points().nearest(pa),
        rb = c.points().nearest(pb);
      const hit = ra && rb ? srcIndex.get(key(ra.index, rb.index)) : undefined;
      if (hit !== undefined && Math.max(ra!.dist, rb!.dist) <= c.maxDist) {
        out[e] = single(hit);
        continue;
      }
    }
    if (mode === 'POLY_NEAREST') {
      const h = c.surface().nearest(mid, c.maxDist);
      if (!h) continue;
      // the edge of that face nearest to the midpoint
      const s = c.src.offsets[h.face],
        en = c.src.offsets[h.face + 1];
      let best = -1,
        bd = Infinity;
      for (let k = s; k < en; k++) {
        const a = c.src.indices[k],
          b = c.src.indices[k + 1 < en ? k + 1 : s];
        const d = segmentClosest(SP, a, b, mid).d2;
        const id = srcIndex.get(key(a, b));
        if (id !== undefined && d < bd) {
          bd = d;
          best = id;
        }
      }
      if (best >= 0) out[e] = single(best);
      continue;
    }
    const r = c.edges().nearest(mid);
    if (r && r.dist <= c.maxDist) out[e] = single(r.edge);
  }
  return out;
}

/** Map destination face corners to source face corners. */
function mapCorners(c: Ctx, mode: string): Map1[] {
  const { dst, src, SP } = c;
  const nc = dst.indices.length;
  const out: Map1[] = new Array(nc).fill(null);
  if (mode === 'TOPOLOGY') {
    if (src.indices.length !== nc) return out;
    for (let i = 0; i < nc; i++) out[i] = single(i);
    return out;
  }
  const dnf = faceNormals(dst as unknown as MeshData);
  const snf = faceNormals({ ...(src as unknown as MeshData), positions: SP });
  const cornerFace = (m: EvalMesh) => {
    const cf = new Uint32Array(m.indices.length);
    for (let f = 0; f < m.offsets.length - 1; f++) for (let k = m.offsets[f]; k < m.offsets[f + 1]; k++) cf[k] = f;
    return cf;
  };
  const dcf = cornerFace(dst);
  const dcn = mode === 'NEAREST_NORMAL' || mode === 'POLYINTERP_LNORPROJ' ? currentCornerNormals(dst) : null;
  const scn = mode === 'NEAREST_NORMAL' ? currentCornerNormals({ ...src, positions: SP }) : null;
  const svf = mode === 'NEAREST_NORMAL' || mode === 'NEAREST_POLYNOR' ? vertexFaces({ ...src, positions: SP }) : null;
  const p = new Vector3();
  for (let k = 0; k < nc; k++) {
    const v = dst.indices[k],
      f = dcf[k];
    p.fromArray(dst.positions, v * 3);
    if (mode === 'NEAREST_NORMAL' || mode === 'NEAREST_POLYNOR') {
      const r = c.points().nearest(p);
      if (!r || r.dist > c.maxDist) continue;
      let best = -1,
        bd = -Infinity;
      for (let q = svf!.offsets[r.index]; q < svf!.offsets[r.index + 1]; q++) {
        const sc = svf!.corners[q],
          sf = svf!.faces[q];
        const d =
          mode === 'NEAREST_NORMAL'
            ? dcn![k * 3] * scn![sc * 3] + dcn![k * 3 + 1] * scn![sc * 3 + 1] + dcn![k * 3 + 2] * scn![sc * 3 + 2]
            : dnf[f * 3] * snf[sf * 3] + dnf[f * 3 + 1] * snf[sf * 3 + 1] + dnf[f * 3 + 2] * snf[sf * 3 + 2];
        if (d > bd) {
          bd = d;
          best = sc;
        }
      }
      if (best >= 0) out[k] = single(best);
    } else if (mode === 'NEAREST_POLY') {
      // nearest source face to the corner (nudged into its own face so shared vertices pick the
      // face on the same side), then that face's corner nearest to this one
      const cen = new Vector3();
      for (let q = dst.offsets[f]; q < dst.offsets[f + 1]; q++) cen.add(new Vector3().fromArray(dst.positions, dst.indices[q] * 3));
      cen.multiplyScalar(1 / (dst.offsets[f + 1] - dst.offsets[f]));
      const h = c.surface().nearest(p.clone().lerp(cen, 0.1), c.maxDist);
      if (!h) continue;
      let best = -1,
        bd = Infinity;
      for (let q = src.offsets[h.face]; q < src.offsets[h.face + 1]; q++) {
        const sv = src.indices[q];
        const d = (SP[sv * 3] - p.x) ** 2 + (SP[sv * 3 + 1] - p.y) ** 2 + (SP[sv * 3 + 2] - p.z) ** 2;
        if (d < bd) {
          bd = d;
          best = q;
        }
      }
      out[k] = single(best);
    } else if (mode === 'POLYINTERP_NEAREST') {
      const h = c.surface().nearest(p, c.maxDist);
      if (h) out[k] = { idx: [...h.corners], w: [...h.bary] };
    } else if (mode === 'POLYINTERP_LNORPROJ') {
      const h = projectBoth(c.surface(), p, new Vector3().fromArray(dcn!, k * 3), c.maxDist);
      if (h) out[k] = { idx: [...h.corners], w: [...h.bary] };
    }
  }
  return out;
}

/** Map destination faces to source faces. */
function mapFaces(c: Ctx, mode: string): Map1[] {
  const { dst, src } = c;
  const nf = dst.offsets.length - 1;
  const out: Map1[] = new Array(nf).fill(null);
  if (mode === 'TOPOLOGY') {
    if (src.offsets.length - 1 !== nf) return out;
    for (let f = 0; f < nf; f++) out[f] = single(f);
    return out;
  }
  const dnf = faceNormals(dst as unknown as MeshData);
  for (let f = 0; f < nf; f++) {
    const cen = new Vector3();
    for (let q = dst.offsets[f]; q < dst.offsets[f + 1]; q++) cen.add(new Vector3().fromArray(dst.positions, dst.indices[q] * 3));
    cen.multiplyScalar(1 / (dst.offsets[f + 1] - dst.offsets[f]));
    const h = mode === 'POLYINTERP_PNORPROJ' ? projectBoth(c.surface(), cen, new Vector3(dnf[f * 3], dnf[f * 3 + 1], dnf[f * 3 + 2]), c.maxDist) : c.surface().nearest(cen, c.maxDist);
    if (h) out[f] = single(h.face);
  }
  return out;
}

// ---------------------------------------------------------------------------
// mixing

/** Combine a destination and a source value; `f` is both the blend factor and the threshold. */
export function mixValue(dst: number, src: number, mode: string, f: number): number {
  let v: number;
  switch (mode) {
    case 'ABOVE_THRESHOLD':
      v = dst >= f ? src : dst;
      break;
    case 'BELOW_THRESHOLD':
      v = dst <= f ? src : dst;
      break;
    case 'MIX':
      v = dst + (src - dst) * f;
      break;
    case 'ADD':
      v = dst + src;
      break;
    case 'SUB':
      v = dst - src;
      break;
    case 'MUL':
      v = dst * src;
      break;
    default:
      v = src;
  }
  return dst + (v - dst) * f;
}

function mixFlag(dst: number, src: number, mode: string, f: number): number {
  if (f <= 0) return dst;
  switch (mode) {
    case 'ABOVE_THRESHOLD':
    case 'ADD':
      return dst || src ? 1 : 0;
    case 'BELOW_THRESHOLD':
    case 'MUL':
      return dst && src ? 1 : 0;
    case 'SUB':
      return dst && !src ? 1 : 0;
    case 'MIX':
      return f >= 0.5 ? src : dst;
  }
  return src;
}

/** Interpolate `stride` values of a source array through a mapping. */
function sample(arr: ArrayLike<number>, mp: NonNullable<Map1>, stride: number, k: number) {
  let s = 0;
  for (let i = 0; i < mp.idx.length; i++) s += (arr[mp.idx[i] * stride + k] ?? 0) * mp.w[i];
  return s;
}

/** Source groups and the destination groups they write to. */
function groupPairs(c: Ctx, mod: ModifierBase, ctx: ModifierContext, srcOb: { vertex_group_active_index?: number }): [number, number][] {
  const sg = c.src.vertex_groups ?? [],
    dg = c.dst.vertex_groups ?? [];
  const selSrc = str(mod, 'layers_vgroup_select_src', 'ALL'),
    selDst = str(mod, 'layers_vgroup_select_dst', 'NAME');
  const srcIdx = selSrc === 'ACTIVE' ? [srcOb.vertex_group_active_index ?? 0].filter((i) => i >= 0 && i < sg.length) : sg.map((_, i) => i);
  const pairs: [number, number][] = [];
  for (const s of srcIdx) {
    let d = -1;
    if (selDst === 'ACTIVE') d = ctx.ob.vertex_group_active_index ?? 0;
    else if (selDst === 'INDEX') d = s;
    else d = dg.findIndex((g) => g.name === sg[s].name);
    if (d >= 0 && d < dg.length && c.src.weights?.[s] && c.dst.weights?.[d]) pairs.push([s, d]);
  }
  return pairs;
}

/** Destination groups the modifier would need that do not exist yet (for "Generate Data Layers"). */
export function missingGroups(src: { name: string }[], dst: { name: string }[], mod: ModifierBase, activeSrc: number): string[] {
  const selSrc = str(mod, 'layers_vgroup_select_src', 'ALL');
  const names = selSrc === 'ACTIVE' ? [src[activeSrc]?.name].filter(Boolean) : src.map((g) => g.name);
  return names.filter((n) => !dst.some((g) => g.name === n)) as string[];
}

export function dataTransfer(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const sid = objId(mod, 'object');
  const sev = sid && sid !== ctx.ob.id ? ctx.graph?.get(sid) : undefined;
  if (!sev?.mesh) return m;
  const src = sev.mesh;
  let toDst: Matrix4 | null = null;
  if (bool(mod, 'use_object_transform', true)) {
    const own = ctx.graph.get(ctx.ob.id)?.world ?? new Matrix4();
    toDst = own.clone().invert().multiply(sev.world);
  }
  const SP = new Float32Array(src.positions);
  if (toDst) {
    const v = new Vector3();
    for (let i = 0; i < SP.length; i += 3) {
      v.fromArray(SP, i).applyMatrix4(toDst);
      SP[i] = v.x;
      SP[i + 1] = v.y;
      SP[i + 2] = v.z;
    }
  }
  const srcLocal: EvalMesh = { ...src, positions: SP };
  const maxDist = bool(mod, 'use_max_distance') ? num(mod, 'max_distance', 1) : Infinity;
  const c: Ctx = {
    src: srcLocal,
    dst: m,
    SP,
    maxDist,
    surface: lazy(() => new SurfaceQuery(srcLocal)),
    points: lazy(() => new PointQuery(SP)),
    edges: lazy(() => new EdgeQuery(SP, srcLocal)),
  };
  const mixMode = str(mod, 'mix_mode', 'REPLACE');
  const factor = num(mod, 'mix_factor', 1);
  const vw = vgroupFactor(m, mod);
  const fv = (v: number) => factor * (vw ? vw[v] : 1);
  const out: EvalMesh = { ...m };
  const srcOb = ctx.doc?.objects?.[sid!] ?? {};

  // vertex data
  if (bool(mod, 'use_vert_data')) {
    const types = (mod.data_types_verts as string[] | undefined) ?? [];
    if (types.length) {
      const vm = mapVerts(c, str(mod, 'vert_mapping', 'NEAREST'));
      if (types.includes('VGROUP_WEIGHTS') && m.weights) {
        const weights = m.weights.slice();
        for (const [s, d] of groupPairs(c, mod, ctx, srcOb)) {
          const W = Float32Array.from(weights[d]);
          const S = src.weights![s];
          for (let v = 0; v < W.length; v++) {
            const mp = vm[v];
            if (!mp) continue;
            W[v] = Math.max(0, Math.min(1, mixValue(W[v], sample(S, mp, 1, 0), mixMode, fv(v))));
          }
          weights[d] = W;
        }
        out.weights = weights;
      }
      if (types.includes('COLOR_VERTEX') && m.colors && src.colors) {
        // vertex colors: average the source corner colors per vertex
        const ns = SP.length / 3;
        const sv = new Float32Array(ns * 4),
          cnt = new Float32Array(ns);
        for (let k = 0; k < src.indices.length; k++) {
          const v = src.indices[k];
          for (let a = 0; a < 4; a++) sv[v * 4 + a] += src.colors[k * 4 + a];
          cnt[v]++;
        }
        for (let v = 0; v < ns; v++) for (let a = 0; a < 4; a++) sv[v * 4 + a] /= cnt[v] || 1;
        const colors = Float32Array.from(out.colors ?? m.colors);
        for (let k = 0; k < m.indices.length; k++) {
          const v = m.indices[k],
            mp = vm[v];
          if (!mp) continue;
          for (let a = 0; a < 4; a++) colors[k * 4 + a] = mixValue(colors[k * 4 + a], sample(sv, mp, 4, a), mixMode, fv(v));
        }
        out.colors = colors;
      }
    }
  }

  // edge data (stored per corner on the edge that starts at the corner)
  if (bool(mod, 'use_edge_data')) {
    const types = (mod.data_types_edges as string[] | undefined) ?? [];
    const layers: [string, 'sharp' | 'seams' | 'creases'][] = [
      ['SHARP_EDGE', 'sharp'],
      ['SEAM', 'seams'],
      ['CREASE', 'creases'],
    ];
    const wanted = layers.filter(([t]) => types.includes(t));
    if (wanted.length) {
      const det = edgeTopology(m);
      const dEdges = det.verts.subarray(0, det.count * 2);
      const srcEdges = c.edges().edges;
      const em = mapEdges(c, str(mod, 'edge_mapping', 'NEAREST'), dEdges, srcEdges);
      // per source edge values from its corners
      const set = edgeTopology(srcLocal);
      const sKey = new Map<string, number>();
      for (let e = 0; e < srcEdges.length / 2; e++) {
        const a = srcEdges[e * 2],
          b = srcEdges[e * 2 + 1];
        sKey.set(a < b ? `${a}:${b}` : `${b}:${a}`, e);
      }
      for (const [, key] of wanted) {
        const sv = new Float32Array(srcEdges.length / 2);
        const sa = src[key];
        if (sa)
          for (let k = 0; k < src.indices.length; k++) {
            const e = set.cornerEdge[k];
            const a = set.verts[e * 2],
              b = set.verts[e * 2 + 1];
            const id = sKey.get(a < b ? `${a}:${b}` : `${b}:${a}`);
            if (id !== undefined) sv[id] = Math.max(sv[id], sa[k]);
          }
        const isFlag = key !== 'creases';
        const cur = m[key];
        const arr = key === 'creases' ? new Float32Array(m.indices.length) : new Uint32Array(m.indices.length);
        if (cur) arr.set(cur);
        for (let k = 0; k < m.indices.length; k++) {
          const e = det.cornerEdge[k];
          const mp = em[e];
          if (!mp) continue;
          const v = m.indices[k];
          const s = sv[mp.idx[0]];
          arr[k] = isFlag ? mixFlag(arr[k], s ? 1 : 0, mixMode, fv(v)) : Math.max(0, Math.min(1, mixValue(arr[k], s, mixMode, fv(v))));
        }
        (out as unknown as Record<string, unknown>)[key] = arr;
      }
    }
  }

  // face corner data
  if (bool(mod, 'use_loop_data')) {
    const types = (mod.data_types_loops as string[] | undefined) ?? [];
    if (types.length) {
      const cm = mapCorners(c, str(mod, 'loop_mapping', 'NEAREST_POLYNOR'));
      if (types.includes('UV')) {
        const uvs = Float32Array.from(m.uvs);
        for (let k = 0; k < m.indices.length; k++) {
          const mp = cm[k];
          if (!mp) continue;
          const f = fv(m.indices[k]);
          for (let a = 0; a < 2; a++) uvs[k * 2 + a] = mixValue(uvs[k * 2 + a], sample(src.uvs, mp, 2, a), mixMode, f);
        }
        out.uvs = uvs;
      }
      if (types.includes('COLOR_CORNER') && m.colors && src.colors) {
        const colors = Float32Array.from(out.colors ?? m.colors);
        for (let k = 0; k < m.indices.length; k++) {
          const mp = cm[k];
          if (!mp) continue;
          const f = fv(m.indices[k]);
          for (let a = 0; a < 4; a++) colors[k * 4 + a] = mixValue(colors[k * 4 + a], sample(src.colors, mp, 4, a), mixMode, f);
        }
        out.colors = colors;
      }
      if (types.includes('CUSTOM_NORMAL')) {
        const sn = currentCornerNormals(srcLocal);
        // source normals rotate with the source object
        const nm = toDst ? new Matrix4().copy(toDst).invert().transpose() : null;
        const base = currentCornerNormals(m);
        const normals = Float32Array.from(base);
        const n = new Vector3();
        for (let k = 0; k < m.indices.length; k++) {
          const mp = cm[k];
          if (!mp) continue;
          n.set(sample(sn, mp, 3, 0), sample(sn, mp, 3, 1), sample(sn, mp, 3, 2));
          if (nm) n.applyMatrix4(nm);
          n.normalize();
          const f = fv(m.indices[k]);
          for (let a = 0; a < 3; a++) normals[k * 3 + a] = mixValue(base[k * 3 + a], n.getComponent(a), mixMode, f);
          n.fromArray(normals, k * 3).normalize();
          normals.set([n.x, n.y, n.z], k * 3);
        }
        out.custom_normals = normals;
        out.smooth = new Uint8Array(m.offsets.length - 1).fill(1);
      }
    }
  }

  // face data
  if (bool(mod, 'use_poly_data')) {
    const types = (mod.data_types_polys as string[] | undefined) ?? [];
    if (types.includes('SMOOTH')) {
      const fm = mapFaces(c, str(mod, 'poly_mapping', 'NEAREST'));
      const smooth = new Uint8Array(m.offsets.length - 1);
      if (out.smooth) smooth.set(out.smooth);
      for (let f = 0; f < smooth.length; f++) {
        const mp = fm[f];
        if (!mp) continue;
        smooth[f] = mixFlag(smooth[f], src.smooth?.[mp.idx[0]] ? 1 : 0, mixMode, fv(m.indices[m.offsets[f]]));
      }
      out.smooth = smooth;
    }
  }
  return out;
}

export const transferModifiers: ModifierType[] = [
  {
    type: 'DATA_TRANSFER',
    label: 'Data Transfer',
    category: 'EDIT',
    icon: 'mod_datatransfer',
    defaults: () => ({
      object: null,
      use_object_transform: true,
      mix_mode: 'REPLACE',
      mix_factor: 1,
      vertex_group: '',
      invert_vertex_group: false,
      use_vert_data: false,
      data_types_verts: [],
      vert_mapping: 'NEAREST',
      layers_vgroup_select_src: 'ALL',
      layers_vgroup_select_dst: 'NAME',
      layers_vcol_vert_select_src: 'ALL',
      layers_vcol_vert_select_dst: 'NAME',
      use_edge_data: false,
      data_types_edges: [],
      edge_mapping: 'NEAREST',
      use_loop_data: false,
      data_types_loops: [],
      loop_mapping: 'NEAREST_POLYNOR',
      layers_vcol_loop_select_src: 'ALL',
      layers_vcol_loop_select_dst: 'NAME',
      layers_uv_select_src: 'ALL',
      layers_uv_select_dst: 'NAME',
      islands_precision: 0,
      use_poly_data: false,
      data_types_polys: [],
      poly_mapping: 'NEAREST',
      use_max_distance: false,
      max_distance: 1,
      ray_radius: 0,
    }),
    deps: (m) => [m.object as string],
    supportsEditMode: true,
    apply: dataTransfer,
  },
];

for (const t of transferModifiers) registerModifier(t);
