// Corrective Smooth: smooths a deformed mesh, then restores the surface detail the same smoothing
// removes from the rest shape, expressed in per-vertex tangent frames so it follows the
// deformation.
import type { ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier } from '../modifiers';
import { bool, num, str, vgroupFactor } from './common';
import { edgeTopology } from '../../mesh/mesh';

/** Unique edges as vertex pairs plus a per-vertex boundary flag. */
export function edgesAndBoundary(m: EvalMesh): { edges: Uint32Array; boundary: Uint8Array } {
  const et = edgeTopology(m);
  const nv = m.positions.length / 3;
  const edges = et.verts.subarray(0, et.count * 2);
  const boundary = new Uint8Array(nv);
  for (let e = 0; e < et.count; e++) if (et.faceOffsets[e + 1] - et.faceOffsets[e] < 2) boundary[edges[e * 2]] = boundary[edges[e * 2 + 1]] = 1;
  if (m.looseEdges) {
    const all = new Uint32Array(edges.length + m.looseEdges.length);
    all.set(edges);
    all.set(m.looseEdges, edges.length);
    return { edges: all, boundary };
  }
  return { edges: Uint32Array.from(edges), boundary };
}

/**
 * Laplacian smoothing used by Corrective Smooth: every iteration moves each vertex towards the
 * (optionally edge-length weighted) average of its neighbours by `factor` × its weight.
 */
export function smoothCoords(co: Float64Array, edges: Uint32Array, iterations: number, factor: number, weights: Float32Array | null, lengthWeighted: boolean) {
  const nv = co.length / 3;
  const sum = new Float64Array(nv * 3),
    tot = new Float64Array(nv);
  // length weighting averages with weights equal to edge lengths and moves by 2/valence of the
  // way (so it stays comparable in strength to the plain average)
  const valence = new Uint32Array(nv);
  if (lengthWeighted)
    for (let e = 0; e < edges.length; e += 2) {
      valence[edges[e]]++;
      valence[edges[e + 1]]++;
    }
  for (let it = 0; it < iterations; it++) {
    sum.fill(0);
    tot.fill(0);
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e],
        b = edges[e + 1];
      let w = 1;
      if (lengthWeighted) {
        w = Math.hypot(co[a * 3] - co[b * 3], co[a * 3 + 1] - co[b * 3 + 1], co[a * 3 + 2] - co[b * 3 + 2]);
      }
      for (let k = 0; k < 3; k++) {
        sum[a * 3 + k] += co[b * 3 + k] * w;
        sum[b * 3 + k] += co[a * 3 + k] * w;
      }
      tot[a] += w;
      tot[b] += w;
    }
    for (let v = 0; v < nv; v++) {
      if (!tot[v]) continue;
      let f = factor * (weights ? weights[v] : 1);
      if (lengthWeighted) f *= 2 / valence[v];
      if (!f) continue;
      for (let k = 0; k < 3; k++) co[v * 3 + k] += (sum[v * 3 + k] / tot[v] - co[v * 3 + k]) * f;
    }
  }
}

/** Per-vertex tangent frames (row-major 3×3: tangent, bitangent, normal) from the faces around it. */
export function tangentFrames(m: EvalMesh, co: Float64Array): Float64Array {
  const nv = co.length / 3;
  const out = new Float64Array(nv * 9);
  // first corner direction per vertex: a fallback tangent when the summed bisectors cancel out
  // (e.g. at the pole of a symmetric fan)
  const first = new Float64Array(nv * 3);
  const count = new Uint32Array(nv);
  const prev = [0, 0, 0],
    next = [0, 0, 0],
    t = [0, 0, 0],
    b = [0, 0, 0],
    n = [0, 0, 0];
  const norm = (v: number[]) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l > 1e-20) for (let k = 0; k < 3; k++) v[k] /= l;
    return l;
  };
  const cross = (a: number[], c: number[], o: number[]) => {
    o[0] = a[1] * c[2] - a[2] * c[1];
    o[1] = a[2] * c[0] - a[0] * c[2];
    o[2] = a[0] * c[1] - a[1] * c[0];
  };
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    for (let c = s; c < e; c++) {
      const v = m.indices[c],
        vp = m.indices[c === s ? e - 1 : c - 1],
        vn = m.indices[c + 1 < e ? c + 1 : s];
      for (let k = 0; k < 3; k++) {
        prev[k] = co[vp * 3 + k] - co[v * 3 + k];
        next[k] = co[v * 3 + k] - co[vn * 3 + k];
      }
      if (norm(prev) < 1e-20 || norm(next) < 1e-20) continue;
      // skip (nearly) straight corners: they define no frame
      const d = prev[0] * next[0] + prev[1] * next[1] + prev[2] * next[2];
      if (Math.abs(d) > 1 - 1e-6) continue;
      
      cross(prev, next, n);
      norm(n);
      for (let k = 0; k < 3; k++) t[k] = prev[k] + next[k];
      norm(t);
      cross(n, t, b);
      if (!count[v]++) for (let k = 0; k < 3; k++) first[v * 3 + k] = prev[k];
      for (let k = 0; k < 3; k++) {
        out[v * 9 + k] += t[k];
        out[v * 9 + 3 + k] += b[k];
        out[v * 9 + 6 + k] += n[k];
      }
    }
  }
  // orthonormalize each frame around its normal
  for (let v = 0; v < nv; v++) {
    const o = v * 9;
    const T = [out[o], out[o + 1], out[o + 2]],
      N = [out[o + 6], out[o + 7], out[o + 8]];
    const tl = norm(T);
    if (norm(N) < 1e-20) {
      out.set([1, 0, 0, 0, 1, 0, 0, 0, 1], o);
      continue;
    }
    if (tl < 1e-3 * count[v]) {
      T[0] = first[v * 3];
      T[1] = first[v * 3 + 1];
      T[2] = first[v * 3 + 2];
    }
    const B = [0, 0, 0];
    cross(N, T, B);
    norm(B);
    cross(B, N, T);
    out.set([T[0], T[1], T[2], B[0], B[1], B[2], N[0], N[1], N[2]], o);
  }
  return out;
}

/** Coordinates of d in the (possibly skewed) frame with axes at rows o, o+3, o+6. */
function solveFrame(F: Float64Array, o: number, dx: number, dy: number, dz: number): [number, number, number] {
  // columns of A are the axes: A·l = d
  const a = F[o], b = F[o + 3], c = F[o + 6];
  const d = F[o + 1], e = F[o + 4], f = F[o + 7];
  const g = F[o + 2], h = F[o + 5], i = F[o + 8];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-20) return [F[o] * dx + F[o + 1] * dy + F[o + 2] * dz, F[o + 3] * dx + F[o + 4] * dy + F[o + 5] * dz, F[o + 6] * dx + F[o + 7] * dy + F[o + 8] * dz];
  const inv = 1 / det;
  return [
    (A * dx + -(b * i - c * h) * dy + (b * f - c * e) * dz) * inv,
    (B * dx + (a * i - c * g) * dy + -(a * f - c * d) * dz) * inv,
    (C * dx + -(a * h - b * g) * dy + (a * e - b * d) * dz) * inv,
  ];
}

export interface CorrectiveParams {
  iterations: number;
  factor: number;
  scale: number;
  lengthWeighted: boolean;
  pinBoundary: boolean;
  onlySmooth: boolean;
  weights: Float32Array | null;
}

/** Smooth `def`, then add back the detail the same smoothing removes from `rest`. */
export function correctiveSmooth(m: EvalMesh, def: Float32Array, rest: ArrayLike<number> | null, p: CorrectiveParams): Float32Array {
  const nv = def.length / 3;
  const { edges, boundary } = edgesAndBoundary(m);
  let w = p.weights;
  if (p.pinBoundary) {
    const pinned = new Float32Array(nv);
    for (let i = 0; i < nv; i++) pinned[i] = boundary[i] ? 0 : w ? w[i] : 1;
    w = pinned;
  }
  const sd = Float64Array.from(def);
  smoothCoords(sd, edges, p.iterations, p.factor, w, p.lengthWeighted);
  const out = new Float32Array(nv * 3);
  if (p.onlySmooth || !rest || rest.length !== def.length) {
    for (let i = 0; i < out.length; i++) out[i] = sd[i];
    return out;
  }
  const sr = Float64Array.from(rest);
  smoothCoords(sr, edges, p.iterations, p.factor, w, p.lengthWeighted);
  const fr = tangentFrames(m, sr),
    fd = tangentFrames(m, sd);
  for (let v = 0; v < nv; v++) {
    const dx = rest[v * 3] - sr[v * 3],
      dy = rest[v * 3 + 1] - sr[v * 3 + 1],
      dz = rest[v * 3 + 2] - sr[v * 3 + 2];
    const o = v * 9;
    // delta in the rest frame: solve F^T · l = d (the frame's rows are its axes)
    const [lx, ly, lz] = solveFrame(fr, o, dx, dy, dz);
    for (let k = 0; k < 3; k++) out[v * 3 + k] = sd[v * 3 + k] + (fd[o + k] * lx + fd[o + 3 + k] * ly + fd[o + 6 + k] * lz) * p.scale;
  }
  return out;
}

function correctiveSmoothMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const useBind = str(mod, 'rest_source', 'ORCO') === 'BIND';
  let rest: ArrayLike<number> | null = null;
  if (useBind) {
    const b = mod._bind_coords as Float32Array | undefined;
    if (!b) throw new Error('Bind data required');
    if (b.length !== m.positions.length) throw new Error('Bind vertex count mismatch');
    rest = b;
  } else {
    const src = ctx.source?.positions;
    rest = src && src.length === m.positions.length ? src : null;
    if (!rest && !bool(mod, 'use_only_smooth')) throw new Error('Original vertex count mismatch: use Bind');
  }
  const positions = correctiveSmooth(m, m.positions, rest, {
    iterations: Math.max(0, Math.round(num(mod, 'iterations', 5))),
    factor: num(mod, 'factor', 0.5),
    scale: num(mod, 'scale', 1),
    lengthWeighted: str(mod, 'smooth_type', 'SIMPLE') === 'LENGTH_WEIGHTED',
    pinBoundary: bool(mod, 'use_pin_boundary'),
    onlySmooth: bool(mod, 'use_only_smooth'),
    weights: vgroupFactor(m, mod),
  });
  return { ...m, positions };
}

export const smoothModifiers: ModifierType[] = [
  {
    type: 'CORRECTIVE_SMOOTH',
    label: 'Smooth Corrective',
    category: 'DEFORM',
    icon: 'mod_corrective_smooth',
    deformOnly: true,
    defaults: () => ({ factor: 0.5, iterations: 5, scale: 1, smooth_type: 'SIMPLE', use_only_smooth: false, use_pin_boundary: false, rest_source: 'ORCO', vertex_group: '', invert_vertex_group: false }),
    apply: correctiveSmoothMod,
  },
];

for (const t of smoothModifiers) registerModifier(t);
