// Mesh data transfer between objects: vertex groups, colors, UVs, edge flags, face smoothing.
// Elements are matched by index (topology) or by nearest position in a shared space.
import type { MeshData } from '../data/types';
import { PointGrid } from './nearest';

export type TransferType = 'VGROUP_WEIGHTS' | 'COLOR_VERTEX' | 'UV' | 'COLOR_CORNER' | 'SMOOTH' | 'SEAM' | 'SHARP_EDGE' | 'CREASE';
export type MixMode = 'REPLACE' | 'ABOVE_THRESHOLD' | 'BELOW_THRESHOLD' | 'MIX' | 'ADD' | 'SUB' | 'MUL';

export interface TransferOptions {
  data_type: TransferType;
  /** element matching: index-based or nearest position */
  mapping: 'TOPOLOGY' | 'NEAREST';
  use_create: boolean;
  layers_select_src: 'ACTIVE' | 'ALL';
  layers_select_dst: 'ACTIVE' | 'NAME' | 'INDEX';
  mix_mode: MixMode;
  mix_factor: number;
  /** squared distance limit for nearest matches (Infinity = none) */
  max_distance2: number;
}

export interface TransferSide {
  me: MeshData;
  /** vertex positions in the shared matching space */
  positions: Float32Array;
  activeGroup: number;
}

export const vertexDomain = (t: TransferType) => t === 'VGROUP_WEIGHTS' || t === 'COLOR_VERTEX';
export const cornerDomain = (t: TransferType) => t === 'UV' || t === 'COLOR_CORNER';
export const edgeDomain = (t: TransferType) => t === 'SEAM' || t === 'SHARP_EDGE' || t === 'CREASE';

export function mix(mode: MixMode, factor: number, dst: number, src: number): number {
  switch (mode) {
    case 'REPLACE':
      return src;
    case 'ABOVE_THRESHOLD':
      return dst >= factor ? src : dst;
    case 'BELOW_THRESHOLD':
      return dst <= factor ? src : dst;
    case 'MIX':
      return dst + (src - dst) * factor;
    case 'ADD':
      return dst + src * factor;
    case 'SUB':
      return dst - src * factor;
    case 'MUL':
      return dst * (1 - factor + src * factor);
  }
  return src;
}

function faceOf(me: MeshData): Int32Array {
  const f = new Int32Array(me.indices.length);
  for (let i = 0; i + 1 < me.offsets.length; i++) for (let c = me.offsets[i]; c < me.offsets[i + 1]; c++) f[c] = i;
  return f;
}

function nextCorner(me: MeshData, face: Int32Array, c: number) {
  const f = face[c];
  return c + 1 < me.offsets[f + 1] ? c + 1 : me.offsets[f];
}

function faceCenters(me: MeshData, pos: Float32Array): Float32Array {
  const nf = me.offsets.length - 1;
  const out = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const a = me.offsets[f],
      b = me.offsets[f + 1];
    for (let c = a; c < b; c++) for (let k = 0; k < 3; k++) out[f * 3 + k] += pos[me.indices[c] * 3 + k] / (b - a);
  }
  return out;
}

/** Point used to match a face corner: slightly pulled from its vertex towards the face center. */
function cornerPoints(me: MeshData, pos: Float32Array): Float32Array {
  const face = faceOf(me);
  const fc = faceCenters(me, pos);
  const out = new Float32Array(me.indices.length * 3);
  for (let c = 0; c < me.indices.length; c++) for (let k = 0; k < 3; k++) out[c * 3 + k] = pos[me.indices[c] * 3 + k] * 0.9 + fc[face[c] * 3 + k] * 0.1;
  return out;
}

function edgeMidpoints(me: MeshData, pos: Float32Array): Float32Array {
  const face = faceOf(me);
  const out = new Float32Array(me.indices.length * 3);
  for (let c = 0; c < me.indices.length; c++) {
    const a = me.indices[c],
      b = me.indices[nextCorner(me, face, c)];
    for (let k = 0; k < 3; k++) out[c * 3 + k] = (pos[a * 3 + k] + pos[b * 3 + k]) / 2;
  }
  return out;
}

/** For every destination element, the matching source element (or -1). */
export function matchElements(src: Float32Array, dst: Float32Array, mapping: 'TOPOLOGY' | 'NEAREST', maxD2 = Infinity): Int32Array {
  const n = dst.length / 3;
  const out = new Int32Array(n).fill(-1);
  if (mapping === 'TOPOLOGY') {
    if (src.length !== dst.length) return out;
    for (let i = 0; i < n; i++) out[i] = i;
    return out;
  }
  const grid = new PointGrid(src);
  for (let i = 0; i < n; i++) {
    const [j, d] = grid.nearest(dst[i * 3], dst[i * 3 + 1], dst[i * 3 + 2]);
    out[i] = d <= maxD2 ? j : -1;
  }
  return out;
}

function elementPoints(t: TransferType, side: TransferSide): Float32Array {
  if (vertexDomain(t)) return side.positions;
  if (cornerDomain(t)) return cornerPoints(side.me, side.positions);
  if (edgeDomain(t)) return edgeMidpoints(side.me, side.positions);
  return faceCenters(side.me, side.positions);
}

/** Copy data from `src` to `dst` (mutates `dst.me`, replacing arrays). Returns how many layers changed. */
export function transferData(src: TransferSide, dst: TransferSide, o: TransferOptions): number {
  const t = o.data_type;
  const map = matchElements(elementPoints(t, src), elementPoints(t, dst), o.mapping, o.max_distance2);
  const blend = (d: number, s: number) => mix(o.mix_mode, o.mix_factor, d, s);
  const S = src.me,
    D = dst.me;
  if (t === 'VGROUP_WEIGHTS') {
    const srcGroups = o.layers_select_src === 'ALL' ? S.vertex_groups.map((_, i) => i) : S.vertex_groups.length ? [Math.min(src.activeGroup, S.vertex_groups.length - 1)] : [];
    const nv = D.positions.length / 3;
    let changed = 0;
    for (const sg of srcGroups) {
      let dg = -1;
      if (o.layers_select_dst === 'ACTIVE' && srcGroups.length === 1) dg = D.vertex_groups.length ? Math.min(dst.activeGroup, D.vertex_groups.length - 1) : -1;
      else if (o.layers_select_dst === 'INDEX') dg = sg < D.vertex_groups.length ? sg : -1;
      else dg = D.vertex_groups.findIndex((g) => g.name === S.vertex_groups[sg].name);
      if (dg < 0) {
        if (!o.use_create) continue;
        D.vertex_groups = [...D.vertex_groups, { name: S.vertex_groups[sg].name }];
        D.weights = [...D.weights, new Float32Array(nv)];
        dg = D.vertex_groups.length - 1;
      }
      if (D.vertex_groups[dg].lock_weight) continue;
      const w = new Float32Array(D.weights[dg]);
      const sw = S.weights[sg];
      for (let v = 0; v < nv; v++) if (map[v] >= 0) w[v] = Math.min(1, Math.max(0, blend(w[v], sw[map[v]])));
      D.weights = D.weights.map((x, i) => (i === dg ? w : x));
      changed++;
    }
    return changed;
  }
  if (t === 'COLOR_VERTEX' || t === 'COLOR_CORNER') {
    const domain = t === 'COLOR_VERTEX' ? 'POINT' : 'CORNER';
    const sc = S.color_attributes[S.active_color_index];
    if (!sc) return 0;
    const n = domain === 'POINT' ? D.positions.length / 3 : D.indices.length;
    // source values in the requested domain
    const sv = new Float32Array((domain === 'POINT' ? S.positions.length / 3 : S.indices.length) * 4);
    if (sc.domain === domain) sv.set(sc.data);
    else if (domain === 'CORNER') for (let c = 0; c < S.indices.length; c++) sv.set(sc.data.subarray(S.indices[c] * 4, S.indices[c] * 4 + 4), c * 4);
    else {
      const cnt = new Float32Array(S.positions.length / 3);
      for (let c = 0; c < S.indices.length; c++) {
        const v = S.indices[c];
        cnt[v]++;
        for (let k = 0; k < 4; k++) sv[v * 4 + k] += sc.data[c * 4 + k];
      }
      for (let v = 0; v < cnt.length; v++) if (cnt[v]) for (let k = 0; k < 4; k++) sv[v * 4 + k] /= cnt[v];
    }
    let di = D.color_attributes.findIndex((c) => c.name === sc.name && c.domain === domain);
    if (o.layers_select_dst === 'ACTIVE' && D.color_attributes[D.active_color_index]?.domain === domain) di = D.active_color_index;
    if (di < 0) {
      if (!o.use_create) return 0;
      D.color_attributes = [...D.color_attributes, { name: sc.name, domain, data: new Float32Array(n * 4).fill(1) }];
      di = D.color_attributes.length - 1;
    }
    const out = new Float32Array(D.color_attributes[di].data);
    for (let i = 0; i < n; i++) if (map[i] >= 0) for (let k = 0; k < 4; k++) out[i * 4 + k] = blend(out[i * 4 + k], sv[map[i] * 4 + k]);
    D.color_attributes = D.color_attributes.map((c, i) => (i === di ? { ...c, data: out } : c));
    return 1;
  }
  if (t === 'UV') {
    const out = new Float32Array(D.uvs.length ? D.uvs : new Float32Array(D.indices.length * 2));
    for (let c = 0; c < D.indices.length; c++) if (map[c] >= 0) for (let k = 0; k < 2; k++) out[c * 2 + k] = blend(out[c * 2 + k], S.uvs[map[c] * 2 + k] ?? 0);
    D.uvs = out;
    return 1;
  }
  if (t === 'SMOOTH') {
    const nf = D.offsets.length - 1;
    const out = new Uint8Array(D.smooth ?? new Uint8Array(nf));
    for (let f = 0; f < nf; f++) if (map[f] >= 0) out[f] = blend(out[f], S.smooth?.[map[f]] ?? 0) >= 0.5 ? 1 : 0;
    D.smooth = out;
    return 1;
  }
  // edge flags stored per corner
  const key = t === 'SEAM' ? 'seams' : t === 'SHARP_EDGE' ? 'sharp' : 'creases';
  const srcArr = S[key];
  if (key === 'creases') {
    const out = new Float32Array(D.creases ?? new Float32Array(D.indices.length));
    for (let c = 0; c < out.length; c++) if (map[c] >= 0) out[c] = Math.min(1, Math.max(0, blend(out[c], srcArr?.[map[c]] ?? 0)));
    D.creases = out;
  } else {
    const out = new Uint32Array(D[key] ?? new Uint32Array(D.indices.length));
    for (let c = 0; c < out.length; c++) if (map[c] >= 0) out[c] = blend(out[c], srcArr?.[map[c]] ? 1 : 0) >= 0.5 ? 1 : 0;
    D[key] = out;
  }
  return 1;
}

/** Make the destination have the same layers (vertex groups, color attributes) as the source. */
export function transferLayout(S: MeshData, D: MeshData, t: TransferType, useDelete: boolean): number {
  let n = 0;
  if (t === 'VGROUP_WEIGHTS') {
    const nv = D.positions.length / 3;
    const names = new Set(S.vertex_groups.map((g) => g.name));
    if (useDelete) {
      const keep = D.vertex_groups.map((g) => names.has(g.name));
      n += keep.filter((k) => !k).length;
      D.vertex_groups = D.vertex_groups.filter((_, i) => keep[i]);
      D.weights = D.weights.filter((_, i) => keep[i]);
    }
    for (const g of S.vertex_groups)
      if (!D.vertex_groups.some((x) => x.name === g.name)) {
        D.vertex_groups = [...D.vertex_groups, { name: g.name }];
        D.weights = [...D.weights, new Float32Array(nv)];
        n++;
      }
  } else if (t === 'COLOR_VERTEX' || t === 'COLOR_CORNER') {
    const domain = t === 'COLOR_VERTEX' ? 'POINT' : 'CORNER';
    const want = S.color_attributes.filter((c) => c.domain === domain);
    if (useDelete) {
      const before = D.color_attributes.length;
      D.color_attributes = D.color_attributes.filter((c) => c.domain !== domain || want.some((w) => w.name === c.name));
      n += before - D.color_attributes.length;
      D.active_color_index = Math.min(D.active_color_index, Math.max(0, D.color_attributes.length - 1));
    }
    for (const c of want)
      if (!D.color_attributes.some((x) => x.name === c.name && x.domain === domain)) {
        const count = domain === 'POINT' ? D.positions.length / 3 : D.indices.length;
        D.color_attributes = [...D.color_attributes, { name: c.name, domain, data: new Float32Array(count * 4).fill(1) }];
        n++;
      }
  }
  return n;
}
