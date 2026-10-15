// Deterministic sampling of emission points on a mesh (vertices, faces, volume).
import type { EvalMesh } from '../eval/types';
import { rand01 } from './common';
import { triangulate } from './colliders';
import { vertexNormals } from '../eval/meshbuild';

export interface Sample {
  /** object-space position and normal */
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
  /** source triangle (or -1) and barycentric weights / vertex index for re-evaluation on deformed meshes */
  tri: number;
  u: number;
  v: number;
  vert: number;
}

export class MeshSampler {
  tris: Uint32Array;
  cdf: Float64Array;
  total = 0;
  vnormals: Float32Array;
  min = [0, 0, 0];
  max = [0, 0, 0];

  /** cumulative per-vertex emission weights (vertex emission with a density group) */
  vcdf: Float64Array | null = null;

  constructor(
    public mesh: EvalMesh,
    /** per-vertex density weights (emission favours heavily weighted areas; zero emits nothing) */
    public density: ArrayLike<number> | null = null,
  ) {
    this.tris = triangulate(mesh.positions, mesh.offsets, mesh.indices);
    const P = mesh.positions;
    const nt = this.tris.length / 3;
    this.cdf = new Float64Array(nt);
    let acc = 0;
    for (let t = 0; t < nt; t++) {
      const a = this.tris[t * 3] * 3,
        b = this.tris[t * 3 + 1] * 3,
        c = this.tris[t * 3 + 2] * 3;
      const e1x = P[b] - P[a],
        e1y = P[b + 1] - P[a + 1],
        e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a],
        e2y = P[c + 1] - P[a + 1],
        e2z = P[c + 2] - P[a + 2];
      const area = 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
      const wgt = density ? Math.max(0, ((density[this.tris[t * 3]] ?? 0) + (density[this.tris[t * 3 + 1]] ?? 0) + (density[this.tris[t * 3 + 2]] ?? 0)) / 3) : 1;
      acc += area * wgt;
      this.cdf[t] = acc;
    }
    this.total = acc;
    this.vnormals = vertexNormals(mesh);
    const n = P.length / 3;
    if (density) {
      this.vcdf = new Float64Array(n);
      let va = 0;
      for (let i = 0; i < n; i++) this.vcdf[i] = va += Math.max(0, density[i] ?? 0);
    }
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 3; k++) {
        this.min[k] = Math.min(this.min[k], P[i * 3 + k]);
        this.max[k] = Math.max(this.max[k], P[i * 3 + k]);
      }
  }

  get vertCount() {
    return this.mesh.positions.length / 3;
  }

  private triNormal(t: number, out: Sample) {
    const P = this.mesh.positions;
    const a = this.tris[t * 3] * 3,
      b = this.tris[t * 3 + 1] * 3,
      c = this.tris[t * 3 + 2] * 3;
    const e1x = P[b] - P[a],
      e1y = P[b + 1] - P[a + 1],
      e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a],
      e2y = P[c + 1] - P[a + 1],
      e2z = P[c + 2] - P[a + 2];
    let nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
  }

  /** Evaluate a face sample (triangle + barycentrics) on the mesh. */
  evalTri(t: number, u: number, v: number, out: Sample) {
    const P = this.mesh.positions;
    const a = this.tris[t * 3] * 3,
      b = this.tris[t * 3 + 1] * 3,
      c = this.tris[t * 3 + 2] * 3;
    const w = 1 - u - v;
    out.px = P[a] * w + P[b] * u + P[c] * v;
    out.py = P[a + 1] * w + P[b + 1] * u + P[c + 1] * v;
    out.pz = P[a + 2] * w + P[b + 2] * u + P[c + 2] * v;
    out.tri = t;
    out.u = u;
    out.v = v;
    out.vert = -1;
    this.triNormal(t, out);
  }

  evalVert(i: number, out: Sample) {
    const P = this.mesh.positions,
      N = this.vnormals;
    out.px = P[i * 3];
    out.py = P[i * 3 + 1];
    out.pz = P[i * 3 + 2];
    out.nx = N[i * 3];
    out.ny = N[i * 3 + 1];
    out.nz = N[i * 3 + 2];
    out.vert = i;
    out.tri = -1;
  }

  private faceSample(seed: number, i: number, out: Sample) {
    const nt = this.cdf.length;
    const r = rand01(seed, i, 11) * this.total;
    let lo = 0,
      hi = nt - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    let u = rand01(seed, i, 12),
      v = rand01(seed, i, 13);
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    this.evalTri(lo, u, v, out);
  }

  /** Ray parity inside test along +X. */
  inside(x: number, y: number, z: number): boolean {
    const P = this.mesh.positions,
      T = this.tris;
    let crossings = 0;
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t] * 3,
        b = T[t + 1] * 3,
        c = T[t + 2] * 3;
      // project on YZ plane: point-in-triangle, then x of the intersection
      const ay = P[a + 1] - y,
        az = P[a + 2] - z,
        by = P[b + 1] - y,
        bz = P[b + 2] - z,
        cy = P[c + 1] - y,
        cz = P[c + 2] - z;
      const d1 = ay * bz - az * by,
        d2 = by * cz - bz * cy,
        d3 = cy * az - cz * ay;
      if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
      const s = d1 + d2 + d3;
      if (Math.abs(s) < 1e-14) continue;
      const ix = (P[a] * d2 + P[b] * d3 + P[c] * d1) / s;
      if (ix > x) crossings++;
    }
    return (crossings & 1) === 1;
  }

  /** Sample emission point i deterministically. */
  sample(from: 'VERT' | 'FACE' | 'VOLUME', seed: number, i: number, out: Sample): boolean {
    if (from === 'VERT' || !this.cdf.length) {
      const n = this.vertCount;
      if (!n) return false;
      if (this.vcdf) {
        const tot = this.vcdf[n - 1];
        if (tot <= 0) return false;
        const r = rand01(seed, i, 10) * tot;
        let lo = 0,
          hi = n - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (this.vcdf[mid] < r) lo = mid + 1;
          else hi = mid;
        }
        this.evalVert(lo, out);
        return true;
      }
      this.evalVert(Math.min(n - 1, Math.floor(rand01(seed, i, 10) * n)), out);
      return true;
    }
    if (this.density && this.total <= 0) return false;
    if (from === 'VOLUME') {
      for (let k = 0; k < 24; k++) {
        const x = this.min[0] + (this.max[0] - this.min[0]) * rand01(seed, i, 20 + k * 3);
        const y = this.min[1] + (this.max[1] - this.min[1]) * rand01(seed, i, 21 + k * 3);
        const z = this.min[2] + (this.max[2] - this.min[2]) * rand01(seed, i, 22 + k * 3);
        if (this.inside(x, y, z)) {
          const cx = (this.min[0] + this.max[0]) / 2,
            cy = (this.min[1] + this.max[1]) / 2,
            cz = (this.min[2] + this.max[2]) / 2;
          const l = Math.hypot(x - cx, y - cy, z - cz) || 1;
          out.px = x;
          out.py = y;
          out.pz = z;
          out.nx = (x - cx) / l;
          out.ny = (y - cy) / l;
          out.nz = (z - cz) / l;
          out.tri = -1;
          out.vert = -1;
          return true;
        }
      }
    }
    this.faceSample(seed, i, out);
    return true;
  }
}

/** A per-vertex value (e.g. vertex group weight) at an emission sample. */
export function valueAt(sampler: MeshSampler, w: ArrayLike<number>, s: Sample): number {
  if (s.vert >= 0) return w[s.vert] ?? 0;
  if (s.tri >= 0) {
    const T = sampler.tris;
    return (w[T[s.tri * 3]] ?? 0) * (1 - s.u - s.v) + (w[T[s.tri * 3 + 1]] ?? 0) * s.u + (w[T[s.tri * 3 + 2]] ?? 0) * s.v;
  }
  return 1;
}

export const newSample = (): Sample => ({ px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 1, tri: -1, u: 0, v: 0, vert: -1 });
