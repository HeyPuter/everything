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

// ---------------------------------------------------------------------------
// Distributions: where n emission points go (Jittered, Random or Grid)

export interface DistributionSettings {
  emit_from?: 'VERT' | 'FACE' | 'VOLUME';
  distribution?: 'JIT' | 'RAND' | 'GRID';
  /** emit in random order (else face by face / vertex by vertex) */
  use_emit_random?: boolean;
  /** spread by area (else every face gets the same share) */
  use_even_distribution?: boolean;
  /** jittered: points per face (0: automatic) and how far they wander from their cell */
  userjit?: number;
  jitter_factor?: number;
  grid_resolution?: number;
  grid_random?: number;
  hexagonal_grid?: boolean;
  invert_grid?: boolean;
}

export function distributionKey(s: DistributionSettings): string {
  return JSON.stringify([s.emit_from, s.distribution, s.use_emit_random, s.use_even_distribution, s.userjit, s.jitter_factor, s.grid_resolution, s.grid_random, s.hexagonal_grid, s.invert_grid]);
}

/** Radical inverse in base 2 (van der Corput), for evenly spread points. */
function radical2(i: number): number {
  let b = i >>> 0;
  b = ((b << 16) | (b >>> 16)) >>> 0;
  b = (((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1)) >>> 0;
  b = (((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2)) >>> 0;
  b = (((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4)) >>> 0;
  b = (((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8)) >>> 0;
  return b / 4294967296;
}

/** Deterministic permutation of 0..n-1. */
function permutation(n: number, seed: number): Int32Array {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand01(seed, i, 17) * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  return p;
}

/**
 * Emission points for n particles following the distribution settings. Grid distributions decide
 * their own count (one point per grid cell on the surface or inside the volume).
 */
export function planSamples(sampler: MeshSampler, s: DistributionSettings, seed: number, n: number): Sample[] {
  const from = s.emit_from ?? 'FACE';
  const dist = s.distribution ?? 'JIT';
  const out: Sample[] = [];
  const order = s.use_emit_random !== false;
  if (from === 'VERT' || !sampler.cdf.length) {
    const nv = sampler.vertCount;
    if (!nv || n <= 0) return out;
    // vertex by vertex (or in random order), weighted by the density group when there is one
    if (sampler.vcdf) {
      for (let i = 0; i < n; i++) {
        const sm = newSample();
        if (!sampler.sample('VERT', seed, i, sm)) continue;
        out.push(sm);
      }
      return out;
    }
    const perm = order ? permutation(nv, seed) : null;
    for (let i = 0; i < n; i++) {
      const sm = newSample();
      sampler.evalVert(perm ? perm[i % nv] : i % nv, sm);
      out.push(sm);
    }
    return out;
  }
  if (dist === 'GRID') return gridSamples(sampler, s, seed, from);
  if (from === 'VOLUME' || (dist === 'RAND' && s.use_even_distribution !== false)) {
    for (let i = 0; i < n; i++) {
      const sm = newSample();
      if (sampler.sample(from, seed, i, sm)) out.push(sm);
      else out.push({ ...sm, px: NaN });
    }
    return out;
  }
  const nt = sampler.cdf.length;
  // share of the particles per face: by area (even) or the same for every face
  const area = (t: number) => sampler.cdf[t] - (t ? sampler.cdf[t - 1] : 0);
  const total = s.use_even_distribution === false ? nt : sampler.total;
  const counts = new Int32Array(nt);
  if (dist === 'RAND') {
    // uneven random: a random face, each face equally likely
    for (let i = 0; i < n; i++) {
      const sm = newSample();
      const t = Math.min(nt - 1, Math.floor(rand01(seed, i, 14) * nt));
      let u = rand01(seed, i, 12),
        v = rand01(seed, i, 13);
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      sampler.evalTri(t, u, v, sm);
      out.push(sm);
    }
    return out;
  }
  // jittered: faces get their share (largest remainder), points spread evenly inside each face
  const share = (t: number) => (s.use_even_distribution === false ? 1 : area(t));
  const exact = new Float64Array(nt);
  let assigned = 0;
  for (let t = 0; t < nt; t++) {
    exact[t] = total > 0 ? (share(t) / total) * n : 0;
    counts[t] = Math.floor(exact[t]);
    assigned += counts[t];
  }
  const rest = Array.from({ length: nt }, (_, t) => t).sort((a, b) => exact[b] - Math.floor(exact[b]) - (exact[a] - Math.floor(exact[a])) || a - b);
  for (let r = 0; assigned < n && r < rest.length; r++, assigned++) counts[rest[r]]++;
  const jit = Math.max(0, Math.min(2, s.jitter_factor ?? 1));
  const fixed = Math.max(0, Math.round(s.userjit ?? 0));
  for (let t = 0; t < nt; t++) {
    const k = counts[t];
    // the jitter pattern has `cells` places; with Particles/Face set they are picked from it
    const cells = fixed > 0 ? Math.max(fixed, k) : k;
    for (let j = 0; j < k; j++) {
      const cell = fixed > 0 ? Math.floor((j * cells) / Math.max(1, k)) : j;
      let a = (cell + 0.5 + (rand01(seed, t, j, 15) - 0.5) * jit) / cells;
      let b = radical2(cell + 1) + (rand01(seed, t, j, 16) - 0.5) * jit / Math.max(1, Math.sqrt(cells));
      a = Math.max(0, Math.min(1, a));
      b = ((b % 1) + 1) % 1;
      // square → triangle
      const sa = Math.sqrt(a);
      const u = sa * (1 - b),
        v = sa * b;
      const sm = newSample();
      sampler.evalTri(t, u, v, sm);
      out.push(sm);
    }
  }
  if (order) {
    const perm = permutation(out.length, seed);
    return Array.from(perm, (p) => out[p]);
  }
  return out;
}

/** Grid points on the surface (faces) or inside (volume) of the mesh's bounding box grid. */
function gridSamples(sampler: MeshSampler, s: DistributionSettings, seed: number, from: 'FACE' | 'VOLUME'): Sample[] {
  const res = Math.max(1, Math.min(250, Math.round(s.grid_resolution ?? 10)));
  const mn = sampler.min,
    mx = sampler.max;
  const size = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  const d = size / res;
  const nx = Math.max(1, Math.round((mx[0] - mn[0]) / d) + 1),
    ny = Math.max(1, Math.round((mx[1] - mn[1]) / d) + 1),
    nz = Math.max(1, Math.round((mx[2] - mn[2]) / d) + 1);
  const rnd = Math.max(0, Math.min(1, s.grid_random ?? 0));
  const out: Sample[] = [];
  const P = sampler.mesh.positions;
  const T = sampler.tris;
  const w = [0, 0, 0];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        // hexagonal grids shift every other row by half a cell
        const hx = s.hexagonal_grid && (j + k) % 2 ? d / 2 : 0;
        const x = mn[0] + i * d + hx,
          y = mn[1] + j * d,
          z = mn[2] + k * d;
        const id = i + j * nx + k * nx * ny;
        const jx = (rand01(seed, id, 31) - 0.5) * d * rnd,
          jy = (rand01(seed, id, 32) - 0.5) * d * rnd,
          jz = (rand01(seed, id, 33) - 0.5) * d * rnd;
        if (from === 'VOLUME') {
          const inside = sampler.inside(x + jx, y + jy, z + jz);
          if (inside === !!s.invert_grid) continue;
          const sm = newSample();
          sm.px = x + jx;
          sm.py = y + jy;
          sm.pz = z + jz;
          out.push(sm);
          continue;
        }
        // faces: the closest surface point when it is within half a cell
        let best = Infinity,
          bt = -1,
          bu = 0,
          bv = 0;
        for (let t = 0; t < T.length; t += 3) {
          closestBary(P, T[t] * 3, T[t + 1] * 3, T[t + 2] * 3, x, y, z, w);
          const qx = P[T[t] * 3] * w[0] + P[T[t + 1] * 3] * w[1] + P[T[t + 2] * 3] * w[2],
            qy = P[T[t] * 3 + 1] * w[0] + P[T[t + 1] * 3 + 1] * w[1] + P[T[t + 2] * 3 + 1] * w[2],
            qz = P[T[t] * 3 + 2] * w[0] + P[T[t + 1] * 3 + 2] * w[1] + P[T[t + 2] * 3 + 2] * w[2];
          const dd = (qx - x) ** 2 + (qy - y) ** 2 + (qz - z) ** 2;
          if (dd < best) {
            best = dd;
            bt = t / 3;
            bu = w[1];
            bv = w[2];
          }
        }
        if (bt < 0 || Math.sqrt(best) > d * 0.5) continue;
        const sm = newSample();
        sampler.evalTri(bt, bu, bv, sm);
        sm.px += jx;
        sm.py += jy;
        sm.pz += jz;
        out.push(sm);
      }
  return out;
}

/** Barycentric weights of the closest point on triangle (a, b, c) (offsets into P). */
function closestBary(P: ArrayLike<number>, a: number, b: number, c: number, px: number, py: number, pz: number, w: number[]) {
  const abx = P[b] - P[a],
    aby = P[b + 1] - P[a + 1],
    abz = P[b + 2] - P[a + 2];
  const acx = P[c] - P[a],
    acy = P[c + 1] - P[a + 1],
    acz = P[c + 2] - P[a + 2];
  const apx = px - P[a],
    apy = py - P[a + 1],
    apz = pz - P[a + 2];
  const d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  const set = (x: number, y: number, z: number) => {
    w[0] = x;
    w[1] = y;
    w[2] = z;
  };
  if (d1 <= 0 && d2 <= 0) return set(1, 0, 0);
  const bpx = px - P[b],
    bpy = py - P[b + 1],
    bpz = pz - P[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(0, 1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return set(1 - v, v, 0);
  }
  const cpx = px - P[c],
    cpy = py - P[c + 1],
    cpz = pz - P[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz,
    d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(0, 0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const ww = d2 / (d2 - d6);
    return set(1 - ww, 0, ww);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const ww = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(0, 1 - ww, ww);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den,
    ww = vc * den;
  return set(1 - v - ww, v, ww);
}
