// Whole-mesh deformation filters of Sculpt Mode (smooth, inflate, sphere, relax, …). Pure math on
// typed arrays so it can be unit tested; the operator lives in meshfilter.ts.

export type MeshFilterType = 'SMOOTH' | 'SCALE' | 'INFLATE' | 'SPHERE' | 'RANDOM' | 'RELAX' | 'RELAX_FACE_SETS' | 'SURFACE_SMOOTH' | 'SHARPEN' | 'ENHANCE_DETAILS';

export interface FilterMesh {
  /** original (rest) positions */
  orig: Float32Array;
  /** unit vertex normals of the original positions */
  normals: Float32Array;
  nbOffsets: Uint32Array;
  nb: Uint32Array;
  /** per-vertex mask (1 = protected) */
  mask?: Float32Array | null;
  /** per-vertex hidden flags (hidden vertices do not move) */
  hidden?: Uint8Array | null;
  /** per-vertex face set boundary flags (Relax Face Sets) */
  fsBoundary?: Uint8Array | null;
}

export interface FilterParams {
  type: MeshFilterType;
  strength: number;
  /** deform only along these axes (in the frame given by `toFrame`) */
  axes?: [boolean, boolean, boolean];
  /** 3×3 row-major rotation into the deformation frame (identity when omitted) */
  frame?: number[];
  seed?: number;
  /** surface smooth: how much of the original shape is kept / weight of the current displacement */
  shapePreservation?: number;
  currentDisplacement?: number;
  /** sharpen: smoothing of the intensity (unused for now, kept for redo compatibility) */
  sharpenSmoothRatio?: number;
}

function neighborAverage(P: Float32Array, m: FilterMesh, v: number, out: number[]): number {
  const a = m.nbOffsets[v],
    b = m.nbOffsets[v + 1];
  out[0] = out[1] = out[2] = 0;
  if (a === b) return 0;
  for (let k = a; k < b; k++) {
    const u = m.nb[k] * 3;
    out[0] += P[u];
    out[1] += P[u + 1];
    out[2] += P[u + 2];
  }
  const n = b - a;
  out[0] /= n;
  out[1] /= n;
  out[2] /= n;
  return n;
}

/** Laplacian smoothing of all positions by `f` (per vertex factor), returns a new array. */
function smoothOnce(P: Float32Array, m: FilterMesh, fac: Float32Array): Float32Array {
  const out = P.slice();
  const avg = [0, 0, 0];
  const nv = P.length / 3;
  for (let v = 0; v < nv; v++) {
    if (!fac[v] || !neighborAverage(P, m, v, avg)) continue;
    const i = v * 3,
      f = fac[v];
    out[i] = P[i] + (avg[0] - P[i]) * f;
    out[i + 1] = P[i + 1] + (avg[1] - P[i + 1]) * f;
    out[i + 2] = P[i + 2] + (avg[2] - P[i + 2]) * f;
  }
  return out;
}

function hash01(i: number, seed: number) {
  let x = Math.imul(i ^ Math.imul(seed + 1, 0x27d4eb2d), 0x9e3779b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return ((x >>> 0) % 100000) / 100000;
}

/** Average edge length (scale reference for inflate / random). */
export function averageEdgeLength(P: Float32Array, m: FilterMesh): number {
  let s = 0,
    n = 0;
  const nv = P.length / 3;
  for (let v = 0; v < nv; v++)
    for (let k = m.nbOffsets[v]; k < m.nbOffsets[v + 1]; k++) {
      const u = m.nb[k];
      if (u < v) continue;
      s += Math.hypot(P[u * 3] - P[v * 3], P[u * 3 + 1] - P[v * 3 + 1], P[u * 3 + 2] - P[v * 3 + 2]);
      n++;
    }
  return n ? s / n : 1;
}

/**
 * Apply a filter to the original positions with the given strength. Large strengths of the
 * iterative filters run several bounded steps so the result keeps growing smoothly.
 */
export function applyMeshFilter(m: FilterMesh, p: FilterParams): Float32Array {
  const O = m.orig;
  const nv = O.length / 3;
  const fac = new Float32Array(nv);
  for (let v = 0; v < nv; v++) fac[v] = m.hidden?.[v] ? 0 : 1 - (m.mask ? m.mask[v] : 0);
  const st = p.strength;
  let P: Float32Array = O.slice();
  const iterative = p.type === 'SMOOTH' || p.type === 'RELAX' || p.type === 'RELAX_FACE_SETS' || p.type === 'SURFACE_SMOOTH' || p.type === 'SHARPEN' || p.type === 'ENHANCE_DETAILS';
  const steps = iterative ? Math.max(1, Math.ceil(Math.abs(st) * 4)) : 1;
  const k = iterative ? st / steps : st;
  const avg = [0, 0, 0];
  const edge = p.type === 'INFLATE' || p.type === 'RANDOM' ? averageEdgeLength(O, m) : 1;
  let cx = 0,
    cy = 0,
    cz = 0,
    radius = 0;
  if (p.type === 'SPHERE') {
    // sphere centered at the bounds center with the average distance as radius
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (let v = 0; v < nv; v++) {
      minX = Math.min(minX, O[v * 3]);
      maxX = Math.max(maxX, O[v * 3]);
      minY = Math.min(minY, O[v * 3 + 1]);
      maxY = Math.max(maxY, O[v * 3 + 1]);
      minZ = Math.min(minZ, O[v * 3 + 2]);
      maxZ = Math.max(maxZ, O[v * 3 + 2]);
    }
    cx = (minX + maxX) / 2;
    cy = (minY + maxY) / 2;
    cz = (minZ + maxZ) / 2;
    for (let v = 0; v < nv; v++) radius += Math.hypot(O[v * 3] - cx, O[v * 3 + 1] - cy, O[v * 3 + 2] - cz);
    radius /= nv || 1;
  }
  for (let it = 0; it < steps; it++) {
    const src = P;
    const out = src.slice();
    switch (p.type) {
      case 'SMOOTH': {
        const f = new Float32Array(nv);
        for (let v = 0; v < nv; v++) f[v] = fac[v] * Math.max(-1, Math.min(1, k));
        P = smoothOnce(src, m, f);
        continue;
      }
      case 'SHARPEN':
      case 'ENHANCE_DETAILS': {
        // push away from the neighbour average (sharpen: local, enhance: relative to a smoothed copy)
        const f = new Float32Array(nv).fill(1);
        const smooth = p.type === 'SHARPEN' ? null : smoothOnce(smoothOnce(src, m, f), m, f);
        for (let v = 0; v < nv; v++) {
          if (!fac[v]) continue;
          const i = v * 3;
          if (smooth) {
            for (let c = 0; c < 3; c++) out[i + c] = src[i + c] + (src[i + c] - smooth[i + c]) * k * 0.5 * fac[v];
          } else if (neighborAverage(src, m, v, avg)) {
            for (let c = 0; c < 3; c++) out[i + c] = src[i + c] - (avg[c] - src[i + c]) * k * 0.5 * fac[v];
          }
        }
        break;
      }
      case 'RELAX':
      case 'RELAX_FACE_SETS': {
        const N = m.normals;
        const fsOnly = p.type === 'RELAX_FACE_SETS';
        for (let v = 0; v < nv; v++) {
          if (!fac[v]) continue;
          if (fsOnly && !m.fsBoundary?.[v]) continue;
          // relax along the surface (tangent part of the laplacian); face set borders only follow border neighbours
          const a = m.nbOffsets[v],
            b = m.nbOffsets[v + 1];
          let n = 0;
          avg[0] = avg[1] = avg[2] = 0;
          for (let j = a; j < b; j++) {
            const u = m.nb[j];
            if (fsOnly && !m.fsBoundary?.[u]) continue;
            avg[0] += src[u * 3];
            avg[1] += src[u * 3 + 1];
            avg[2] += src[u * 3 + 2];
            n++;
          }
          if (!n) continue;
          const i = v * 3;
          let dx = avg[0] / n - src[i],
            dy = avg[1] / n - src[i + 1],
            dz = avg[2] / n - src[i + 2];
          const dn = dx * N[i] + dy * N[i + 1] + dz * N[i + 2];
          dx -= N[i] * dn;
          dy -= N[i + 1] * dn;
          dz -= N[i + 2] * dn;
          const f = Math.max(-1, Math.min(1, k)) * fac[v];
          out[i] = src[i] + dx * f;
          out[i + 1] = src[i + 1] + dy * f;
          out[i + 2] = src[i + 2] + dz * f;
        }
        break;
      }
      case 'SURFACE_SMOOTH': {
        // shape-preserving (HC) smoothing: laplacian step, then pull back by the averaged displacement
        const alpha = p.shapePreservation ?? 0.5,
          beta = p.currentDisplacement ?? 0.5;
        const f = new Float32Array(nv);
        for (let v = 0; v < nv; v++) f[v] = fac[v] * Math.max(0, Math.min(1, k));
        const L = smoothOnce(src, m, f);
        const B = new Float32Array(nv * 3);
        for (let i = 0; i < nv * 3; i++) B[i] = L[i] - (alpha * O[i] + (1 - alpha) * src[i]);
        for (let v = 0; v < nv; v++) {
          const i = v * 3;
          if (!f[v]) {
            out[i] = src[i];
            out[i + 1] = src[i + 1];
            out[i + 2] = src[i + 2];
            continue;
          }
          const n = neighborAverage(B, m, v, avg);
          for (let c = 0; c < 3; c++) out[i + c] = L[i + c] - (beta * B[i + c] + (1 - beta) * (n ? avg[c] : B[i + c])) * f[v];
        }
        break;
      }
      case 'SCALE':
        for (let v = 0; v < nv; v++) {
          const s = 1 + k * 0.5 * fac[v];
          for (let c = 0; c < 3; c++) out[v * 3 + c] = src[v * 3 + c] * s;
        }
        break;
      case 'INFLATE': {
        const N = m.normals;
        for (let v = 0; v < nv; v++) for (let c = 0; c < 3; c++) out[v * 3 + c] = src[v * 3 + c] + N[v * 3 + c] * k * edge * 2 * fac[v];
        break;
      }
      case 'RANDOM': {
        const N = m.normals;
        const seed = p.seed ?? 0;
        for (let v = 0; v < nv; v++) {
          const r = (hash01(v, seed) * 2 - 1) * k * edge * fac[v];
          for (let c = 0; c < 3; c++) out[v * 3 + c] = src[v * 3 + c] + N[v * 3 + c] * r;
        }
        break;
      }
      case 'SPHERE':
        for (let v = 0; v < nv; v++) {
          const i = v * 3;
          const dx = src[i] - cx,
            dy = src[i + 1] - cy,
            dz = src[i + 2] - cz;
          const l = Math.hypot(dx, dy, dz) || 1;
          const t = Math.max(-1, Math.min(1, k)) * fac[v];
          out[i] = src[i] + (cx + (dx / l) * radius - src[i]) * t;
          out[i + 1] = src[i + 1] + (cy + (dy / l) * radius - src[i + 1]) * t;
          out[i + 2] = src[i + 2] + (cz + (dz / l) * radius - src[i + 2]) * t;
        }
        break;
    }
    P = out;
  }
  // restrict the displacement to the enabled axes of the deformation frame
  const ax = p.axes ?? [true, true, true];
  if (!ax[0] || !ax[1] || !ax[2]) {
    const F = p.frame ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let v = 0; v < nv; v++) {
      const i = v * 3;
      const d = [P[i] - O[i], P[i + 1] - O[i + 1], P[i + 2] - O[i + 2]];
      // into the frame (rows of F), drop disabled axes, back (columns of F)
      const l = [0, 1, 2].map((r) => (ax[r] ? F[r * 3] * d[0] + F[r * 3 + 1] * d[1] + F[r * 3 + 2] * d[2] : 0));
      for (let c = 0; c < 3; c++) P[i + c] = O[i + c] + F[c] * l[0] + F[3 + c] * l[1] + F[6 + c] * l[2];
    }
  }
  return P;
}
