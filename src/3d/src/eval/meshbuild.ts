// Helpers for building evaluated meshes inside modifiers.
import type { EvalMesh } from './types';
import { polyNormal } from '../mesh/mesh';

/** Incremental mesh builder with per-corner attributes. */
export class MeshBuilder {
  pos: number[] = [];
  orig: number[] = [];
  offsets: number[] = [0];
  indices: number[] = [];
  uvs: number[] = [];
  colors: number[] | null = null;
  smooth: number[] = [];
  mat: number[] = [];
  seams: number[] | null = null;
  sharp: number[] | null = null;
  creases: number[] | null = null;
  weights: number[][] | null = null;

  constructor(groupCount = 0, withColors = false) {
    if (groupCount) this.weights = Array.from({ length: groupCount }, () => []);
    if (withColors) this.colors = [];
  }

  addVert(x: number, y: number, z: number, orig = -1, w?: number[]): number {
    this.pos.push(x, y, z);
    this.orig.push(orig);
    if (this.weights) for (let g = 0; g < this.weights.length; g++) this.weights[g].push(w?.[g] ?? 0);
    return this.orig.length - 1;
  }

  addFace(verts: number[], uvs?: number[], smooth = 0, mat = 0, extra?: { seams?: number[]; sharp?: number[]; creases?: number[]; colors?: number[] }) {
    for (let i = 0; i < verts.length; i++) {
      this.indices.push(verts[i]);
      this.uvs.push(uvs?.[i * 2] ?? 0, uvs?.[i * 2 + 1] ?? 0);
      if (extra?.seams) (this.seams ??= new Array(this.indices.length - 1).fill(0)).push(extra.seams[i] ?? 0);
      else if (this.seams) this.seams.push(0);
      if (extra?.sharp) (this.sharp ??= new Array(this.indices.length - 1).fill(0)).push(extra.sharp[i] ?? 0);
      else if (this.sharp) this.sharp.push(0);
      if (extra?.creases) (this.creases ??= new Array(this.indices.length - 1).fill(0)).push(extra.creases[i] ?? 0);
      else if (this.creases) this.creases.push(0);
      if (this.colors) for (let k = 0; k < 4; k++) this.colors.push(extra?.colors?.[i * 4 + k] ?? 1);
    }
    this.offsets.push(this.indices.length);
    this.smooth.push(smooth);
    this.mat.push(mat);
  }

  build(base?: Partial<EvalMesh>): EvalMesh {
    const positions = new Float32Array(this.pos);
    const offsets = new Uint32Array(this.offsets),
      indices = new Uint32Array(this.indices);
    const normals = new Float32Array(indices.length * 3);
    const n: [number, number, number] = [0, 0, 0];
    for (let f = 0; f < offsets.length - 1; f++) {
      polyNormal(positions, indices.subarray(offsets[f], offsets[f + 1]), n);
      for (let c = offsets[f]; c < offsets[f + 1]; c++) normals.set(n, c * 3);
    }
    return {
      ...base,
      positions,
      offsets,
      indices,
      uvs: new Float32Array(this.uvs),
      normals,
      smooth: new Uint8Array(this.smooth),
      material_index: new Uint16Array(this.mat),
      seams: this.seams ? new Uint32Array(this.seams) : undefined,
      sharp: this.sharp ? new Uint32Array(this.sharp) : undefined,
      creases: this.creases ? new Float32Array(this.creases) : undefined,
      colors: this.colors ? new Float32Array(this.colors) : undefined,
      origIndex: new Int32Array(this.orig),
      weights: this.weights ? this.weights.map((w) => new Float32Array(w)) : base?.weights,
      vertex_groups: base?.vertex_groups,
      auto_smooth_angle: base?.auto_smooth_angle,
      instances: base?.instances,
      looseEdges: undefined,
    };
  }
}

/** Copy all faces of a mesh into a builder with a vertex remap and optional reversal. */
export function appendMesh(b: MeshBuilder, m: EvalMesh, vmap: ArrayLike<number>, reverse = false) {
  const nf = m.offsets.length - 1;
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    const verts: number[] = [],
      uvs: number[] = [],
      seams: number[] = [],
      sharp: number[] = [],
      creases: number[] = [],
      colors: number[] = [];
    const order = reverse ? Array.from({ length: e - s }, (_, i) => e - 1 - i) : Array.from({ length: e - s }, (_, i) => s + i);
    for (const c of order) {
      verts.push(vmap[m.indices[c]]);
      uvs.push(m.uvs[c * 2], m.uvs[c * 2 + 1]);
      if (m.colors) colors.push(m.colors[c * 4], m.colors[c * 4 + 1], m.colors[c * 4 + 2], m.colors[c * 4 + 3]);
    }
    // per-edge flags belong to the edge starting at the corner; when reversed the
    // edge (c → c+1) becomes (c+1 → c), i.e. it starts at the next corner in the new order
    for (let k = 0; k < order.length; k++) {
      const src = reverse ? order[(k + 1) % order.length] : order[k];
      seams.push(m.seams?.[src] ?? 0);
      sharp.push(m.sharp?.[src] ?? 0);
      creases.push(m.creases?.[src] ?? 0);
    }
    b.addFace(verts, uvs, m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0, {
      seams: m.seams ? seams : undefined,
      sharp: m.sharp ? sharp : undefined,
      creases: m.creases ? creases : undefined,
      colors: m.colors ? colors : undefined,
    });
  }
}

export function weightsOf(m: EvalMesh, v: number): number[] | undefined {
  return m.weights?.map((w) => w[v] ?? 0);
}

/** Vertex group weights for a named group (or null when the group does not exist). */
export function groupWeights(m: EvalMesh, name: string | undefined | null): Float32Array | null {
  if (!name || !m.vertex_groups || !m.weights) return null;
  const i = m.vertex_groups.findIndex((g) => g.name === name);
  return i >= 0 ? m.weights[i] ?? null : null;
}

export function cloneWithPositions(m: EvalMesh, positions: Float32Array): EvalMesh {
  return { ...m, positions };
}

/** Vertex normals: the face normals around each vertex weighted by the corner angles. */
export function vertexNormals(m: EvalMesh): Float32Array {
  const out = new Float32Array(m.positions.length);
  const n: [number, number, number] = [0, 0, 0];
  const P = m.positions;
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    polyNormal(P, m.indices.subarray(s, e), n);
    for (let c = s; c < e; c++) {
      const v = m.indices[c] * 3,
        p = m.indices[c > s ? c - 1 : e - 1] * 3,
        q = m.indices[c + 1 < e ? c + 1 : s] * 3;
      const ax = P[p] - P[v],
        ay = P[p + 1] - P[v + 1],
        az = P[p + 2] - P[v + 2];
      const bx = P[q] - P[v],
        by = P[q + 1] - P[v + 1],
        bz = P[q + 2] - P[v + 2];
      const la = Math.hypot(ax, ay, az),
        lb = Math.hypot(bx, by, bz);
      const w = la > 0 && lb > 0 ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb)))) : 0;
      out[v] += n[0] * w;
      out[v + 1] += n[1] * w;
      out[v + 2] += n[2] * w;
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l;
    out[i + 1] /= l;
    out[i + 2] /= l;
  }
  return out;
}
