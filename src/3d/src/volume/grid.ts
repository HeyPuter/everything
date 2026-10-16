// Dense voxel grids: construction, sampling, bounds and conversions between meshes, points and
// grids. Pure functions (no app state), unit tested.
import type { GridClass, GridDataType, VolumeGrid } from './types';
import { gridChannels } from './types';

export type Vec3 = [number, number, number];

/** A grid of `dims` voxels of size `voxelSize` whose first voxel centre is at `origin`. */
export function makeGrid(name: string, dims: Vec3, voxelSize: number | Vec3, origin: Vec3, type: GridDataType = 'FLOAT', cls: GridClass = 'FOG_VOLUME', values?: Float32Array): VolumeGrid {
  const s: Vec3 = typeof voxelSize === 'number' ? [voxelSize, voxelSize, voxelSize] : voxelSize;
  const n = dims[0] * dims[1] * dims[2] * gridChannels(type);
  return {
    name,
    data_type: type,
    grid_class: cls,
    dims: [...dims],
    transform: [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, origin[0], origin[1], origin[2], 1],
    values: values ?? new Float32Array(n),
    background: 0,
  };
}

export const voxelCount = (g: Pick<VolumeGrid, 'dims'>) => g.dims[0] * g.dims[1] * g.dims[2];

/** Apply a column-major 4×4 to a point. */
export function xform(m: ArrayLike<number>, x: number, y: number, z: number, out: number[] = [0, 0, 0]): number[] {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

export function mulMat4(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

/** Inverse of an affine column-major 4×4 (identity when singular). */
export function invertAffine(m: ArrayLike<number>): number[] {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-30) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const inv = 1 / det;
  const r = [A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv, B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv, C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv];
  // r is row-major 3×3
  const tx = m[12], ty = m[13], tz = m[14];
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, -(r[0] * tx + r[1] * ty + r[2] * tz), -(r[3] * tx + r[4] * ty + r[5] * tz), -(r[6] * tx + r[7] * ty + r[8] * tz), 1];
}

/** Voxel edge lengths along the grid's index axes. */
export function voxelSize(g: Pick<VolumeGrid, 'transform'>): Vec3 {
  const m = g.transform;
  return [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])];
}

/** Object-space bounds of the grid's box (voxel boxes, not centres). */
export function gridBounds(g: Pick<VolumeGrid, 'transform' | 'dims'>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p = [0, 0, 0];
  for (let c = 0; c < 8; c++) {
    xform(g.transform, c & 1 ? g.dims[0] - 0.5 : -0.5, c & 2 ? g.dims[1] - 0.5 : -0.5, c & 4 ? g.dims[2] - 0.5 : -0.5, p);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

/** Bounds of several grids (null when there are none). */
export function gridsBounds(grids: Pick<VolumeGrid, 'transform' | 'dims'>[]): { min: Vec3; max: Vec3 } | null {
  let out: { min: Vec3; max: Vec3 } | null = null;
  for (const g of grids) {
    if (!voxelCount(g)) continue;
    const b = gridBounds(g);
    if (!out) out = b;
    else
      for (let k = 0; k < 3; k++) {
        out.min[k] = Math.min(out.min[k], b.min[k]);
        out.max[k] = Math.max(out.max[k], b.max[k]);
      }
  }
  return out;
}

/** Smallest and largest value (vector grids: length). */
export function gridRange(g: VolumeGrid): [number, number] {
  const ch = gridChannels(g.data_type);
  let lo = Infinity,
    hi = -Infinity;
  const v = g.values;
  for (let i = 0; i < v.length; i += ch) {
    const x = ch === 3 ? Math.hypot(v[i], v[i + 1], v[i + 2]) : v[i];
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return lo <= hi ? [lo, hi] : [0, 0];
}

/** Voxels whose value differs from the background (vector grids: any channel). */
export function activeVoxels(g: VolumeGrid, tolerance = 0): number {
  const ch = gridChannels(g.data_type);
  let n = 0;
  for (let i = 0; i < g.values.length; i += ch) {
    let on = false;
    for (let c = 0; c < ch; c++) if (Math.abs(g.values[i + c] - (c === 0 ? g.background : 0)) > tolerance) on = true;
    if (on) n++;
  }
  return n;
}

/** Find a grid by name, falling back to the first float grid. */
export function findGrid(grids: VolumeGrid[], name: string, fallback = true): VolumeGrid | undefined {
  return grids.find((g) => g.name === name) ?? (fallback ? grids.find((g) => g.data_type === 'FLOAT') : undefined);
}

// ---------------------------------------------------------------------------
// Sampling

export type Interpolation = 'LINEAR' | 'CUBIC' | 'CLOSEST';

/** Samples a grid at object-space positions. */
export class GridSampler {
  private inv: number[];
  private ch: number;
  private p = [0, 0, 0];
  constructor(
    readonly grid: VolumeGrid,
    readonly interpolation: Interpolation = 'LINEAR',
  ) {
    this.inv = invertAffine(grid.transform);
    this.ch = gridChannels(grid.data_type);
  }
  /** Value of voxel (i, j, k) (background outside), channel `c`. */
  voxel(i: number, j: number, k: number, c = 0): number {
    const [nx, ny, nz] = this.grid.dims;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return c === 0 ? this.grid.background : 0;
    return this.grid.values[((k * ny + j) * nx + i) * this.ch + c];
  }
  /** Sample at a position given in index space. */
  sampleIndex(x: number, y: number, z: number, c = 0): number {
    if (this.interpolation === 'CLOSEST') return this.voxel(Math.round(x), Math.round(y), Math.round(z), c);
    if (this.interpolation === 'CUBIC') return this.cubic(x, y, z, c);
    const i = Math.floor(x),
      j = Math.floor(y),
      k = Math.floor(z);
    const fx = x - i,
      fy = y - j,
      fz = z - k;
    const v = (a: number, b: number, d: number) => this.voxel(i + a, j + b, k + d, c);
    const x00 = v(0, 0, 0) + (v(1, 0, 0) - v(0, 0, 0)) * fx;
    const x10 = v(0, 1, 0) + (v(1, 1, 0) - v(0, 1, 0)) * fx;
    const x01 = v(0, 0, 1) + (v(1, 0, 1) - v(0, 0, 1)) * fx;
    const x11 = v(0, 1, 1) + (v(1, 1, 1) - v(0, 1, 1)) * fx;
    const y0 = x00 + (x10 - x00) * fy,
      y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
  }
  private cubic(x: number, y: number, z: number, c: number) {
    // Catmull-Rom (interpolating) cubic
    const i = Math.floor(x),
      j = Math.floor(y),
      k = Math.floor(z);
    const wx = crWeights(x - i),
      wy = crWeights(y - j),
      wz = crWeights(z - k);
    let s = 0;
    for (let d = 0; d < 4; d++)
      for (let b = 0; b < 4; b++) {
        const w = wz[d] * wy[b];
        if (!w) continue;
        for (let a = 0; a < 4; a++) s += w * wx[a] * this.voxel(i + a - 1, j + b - 1, k + d - 1, c);
      }
    return s;
  }
  /** Sample at an object-space position. */
  sample(x: number, y: number, z: number, c = 0): number {
    const p = xform(this.inv, x, y, z, this.p);
    return this.sampleIndex(p[0], p[1], p[2], c);
  }
}

function crWeights(t: number): [number, number, number, number] {
  const t2 = t * t,
    t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}

// ---------------------------------------------------------------------------
// Transforms and resampling

/** The grid with `m` (column-major 4×4) applied after its own transform. */
export function transformGrid(g: VolumeGrid, m: ArrayLike<number>): VolumeGrid {
  return { ...g, transform: mulMat4(m, g.transform) };
}

/** Average blocks of `factor`³ voxels (keeps the covered region). */
export function downsampleGrid(g: VolumeGrid, factor: number): VolumeGrid {
  factor = Math.max(1, Math.floor(factor));
  if (factor === 1) return g;
  const ch = gridChannels(g.data_type);
  const [nx, ny, nz] = g.dims;
  const dims: Vec3 = [Math.ceil(nx / factor), Math.ceil(ny / factor), Math.ceil(nz / factor)];
  const out = new Float32Array(dims[0] * dims[1] * dims[2] * ch);
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++)
      for (let i = 0; i < dims[0]; i++) {
        const o = ((k * dims[1] + j) * dims[0] + i) * ch;
        let n = 0;
        for (let c = 0; c < factor; c++)
          for (let b = 0; b < factor; b++)
            for (let a = 0; a < factor; a++) {
              const x = i * factor + a,
                y = j * factor + b,
                z = k * factor + c;
              if (x >= nx || y >= ny || z >= nz) continue;
              const s = ((z * ny + y) * nx + x) * ch;
              for (let q = 0; q < ch; q++) out[o + q] += g.values[s + q];
              n++;
            }
        if (n) for (let q = 0; q < ch; q++) out[o + q] /= n;
      }
  // new voxel i covers old voxels [i·f, i·f + f − 1]: its centre is at old index i·f + (f − 1)/2
  const sh = (factor - 1) / 2;
  const scale = [factor, 0, 0, 0, 0, factor, 0, 0, 0, 0, factor, 0, sh, sh, sh, 1];
  return { ...g, dims, values: out, transform: mulMat4(g.transform, scale) };
}

// ---------------------------------------------------------------------------
// Mesh → grid

/** Triangles of a polygon mesh (fan triangulation) as vertex index triples. */
export function triangulate(offsets: ArrayLike<number>, indices: ArrayLike<number>): Uint32Array {
  let n = 0;
  for (let f = 0; f + 1 < offsets.length; f++) n += Math.max(0, offsets[f + 1] - offsets[f] - 2);
  const out = new Uint32Array(n * 3);
  let w = 0;
  for (let f = 0; f + 1 < offsets.length; f++) {
    const s = offsets[f],
      e = offsets[f + 1];
    for (let c = s + 1; c + 1 < e; c++) {
      out[w++] = indices[s];
      out[w++] = indices[c];
      out[w++] = indices[c + 1];
    }
  }
  return out;
}

/** Squared distance from p to triangle abc (Ericson's closest point on triangle). */
export function pointTriangleDist2(px: number, py: number, pz: number, a: ArrayLike<number>, ia: number, ib: number, ic: number): number {
  const ax = a[ia], ay = a[ia + 1], az = a[ia + 2];
  const abx = a[ib] - ax, aby = a[ib + 1] - ay, abz = a[ib + 2] - az;
  const acx = a[ic] - ax, acy = a[ic + 1] - ay, acz = a[ic + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - a[ib], bpy = py - a[ib + 1], bpz = pz - a[ib + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    qx = ax + abx * v;
    qy = ay + aby * v;
    qz = az + abz * v;
  } else {
    const cpx = px - a[ic], cpy = py - a[ic + 1], cpz = pz - a[ic + 2];
    const d5 = abx * cpx + aby * cpy + abz * cpz,
      d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      qx = ax + acx * w;
      qy = ay + acy * w;
      qz = az + acz * w;
    } else {
      const va = d3 * d6 - d5 * d4;
      if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        qx = a[ib] + (a[ic] - a[ib]) * w;
        qy = a[ib + 1] + (a[ic + 1] - a[ib + 1]) * w;
        qz = a[ib + 2] + (a[ic + 2] - a[ib + 2]) * w;
      } else {
        const denom = 1 / (va + vb + vc);
        const v = vb * denom,
          w = vc * denom;
        qx = ax + abx * v + acx * w;
        qy = ay + aby * v + acy * w;
        qz = az + abz * v + acz * w;
      }
    }
  }
  const dx = px - qx,
    dy = py - qy,
    dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

export interface MeshGridOptions {
  /** voxel edge length (object units) */
  voxelSize: number;
  /** narrow band half width, in object units, kept around the surface */
  bandWidth: number;
  /** extra voxels around the mesh bounds */
  padding?: number;
}

/** Voxel size giving about `amount` voxels across the diagonal of a bounding box. */
export function voxelSizeForAmount(min: ArrayLike<number>, max: ArrayLike<number>, amount: number): number {
  const d = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return d > 0 && amount > 0 ? d / amount : 0;
}

/** Hard cap on generated grids so a tiny voxel size can't exhaust memory. */
export const MAX_GENERATED_VOXELS = 192 ** 3;

/** Clamp a voxel size so the grid for a region stays below the voxel cap. */
export function clampVoxelSize(min: ArrayLike<number>, max: ArrayLike<number>, vs: number, pad = 0, cap = MAX_GENERATED_VOXELS): number {
  const ext = [0, 1, 2].map((k) => Math.max(0, max[k] - min[k]) + 2 * pad);
  const count = (s: number) => ext.reduce((a, e) => a * (Math.ceil(e / s) + 1), 1);
  if (!(vs > 0)) vs = Math.max(...ext, 1e-3) / 32;
  while (count(vs) > cap) vs *= 1.1;
  return vs;
}

/**
 * Signed distance field (level set) of a closed triangle mesh: negative inside. Values are
 * exact within the narrow band and clamped to ±bandWidth outside it.
 */
export function meshToSdf(positions: ArrayLike<number>, tris: ArrayLike<number>, o: MeshGridOptions): VolumeGrid | null {
  const nv = positions.length / 3;
  if (!nv || !tris.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i * 3 + k]);
      max[k] = Math.max(max[k], positions[i * 3 + k]);
    }
  const band = Math.max(0, o.bandWidth);
  let vs = o.voxelSize;
  const pad = band + (o.padding ?? 1) * (vs > 0 ? vs : 0);
  vs = clampVoxelSize(min, max, vs, pad);
  const pad2 = band + (o.padding ?? 1) * vs;
  const origin: Vec3 = [min[0] - pad2, min[1] - pad2, min[2] - pad2];
  const dims: Vec3 = [0, 1, 2].map((k) => Math.max(2, Math.ceil((max[k] - min[k] + 2 * pad2) / vs) + 1)) as Vec3;
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz;
  const dist = new Float32Array(N).fill(Infinity);
  // unsigned distance in the band around every triangle
  const reach = band + vs * 1.5;
  for (let t = 0; t < tris.length; t += 3) {
    const ia = tris[t] * 3,
      ib = tris[t + 1] * 3,
      ic = tris[t + 2] * 3;
    const lo = [0, 0, 0],
      hi = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const a = Math.min(positions[ia + k], positions[ib + k], positions[ic + k]) - reach;
      const b = Math.max(positions[ia + k], positions[ib + k], positions[ic + k]) + reach;
      lo[k] = Math.max(0, Math.floor((a - origin[k]) / vs));
      hi[k] = Math.min(dims[k] - 1, Math.ceil((b - origin[k]) / vs));
    }
    for (let k = lo[2]; k <= hi[2]; k++) {
      const z = origin[2] + k * vs;
      for (let j = lo[1]; j <= hi[1]; j++) {
        const y = origin[1] + j * vs;
        let idx = (k * ny + j) * nx + lo[0];
        for (let i = lo[0]; i <= hi[0]; i++, idx++) {
          const d = pointTriangleDist2(origin[0] + i * vs, y, z, positions, ia, ib, ic);
          if (d < dist[idx]) dist[idx] = d;
        }
      }
    }
  }
  // inside / outside: crossings of rays along +X through every voxel row (slightly offset so
  // rows never run exactly along mesh edges)
  const rows: number[][] = new Array(ny * nz);
  const ey = vs * 1.234567e-4,
    ez = vs * 2.718281e-4;
  for (let t = 0; t < tris.length; t += 3) {
    const ia = tris[t] * 3,
      ib = tris[t + 1] * 3,
      ic = tris[t + 2] * 3;
    const y0 = Math.min(positions[ia + 1], positions[ib + 1], positions[ic + 1]),
      y1 = Math.max(positions[ia + 1], positions[ib + 1], positions[ic + 1]);
    const z0 = Math.min(positions[ia + 2], positions[ib + 2], positions[ic + 2]),
      z1 = Math.max(positions[ia + 2], positions[ib + 2], positions[ic + 2]);
    const j0 = Math.max(0, Math.ceil((y0 - origin[1] - ey) / vs)),
      j1 = Math.min(ny - 1, Math.floor((y1 - origin[1] - ey) / vs));
    const k0 = Math.max(0, Math.ceil((z0 - origin[2] - ez) / vs)),
      k1 = Math.min(nz - 1, Math.floor((z1 - origin[2] - ez) / vs));
    if (j0 > j1 || k0 > k1) continue;
    const ay = positions[ia + 1], az = positions[ia + 2];
    const by = positions[ib + 1], bz = positions[ib + 2];
    const cy = positions[ic + 1], cz = positions[ic + 2];
    const det = (by - ay) * (cz - az) - (cy - ay) * (bz - az);
    if (Math.abs(det) < 1e-20) continue;
    for (let k = k0; k <= k1; k++) {
      const pz = origin[2] + k * vs + ez;
      for (let j = j0; j <= j1; j++) {
        const py = origin[1] + j * vs + ey;
        const u = ((py - ay) * (cz - az) - (cy - ay) * (pz - az)) / det;
        const v = ((by - ay) * (pz - az) - (py - ay) * (bz - az)) / det;
        if (u < 0 || v < 0 || u + v > 1) continue;
        const x = positions[ia] + (positions[ib] - positions[ia]) * u + (positions[ic] - positions[ia]) * v;
        (rows[k * ny + j] ??= []).push(x);
      }
    }
  }
  const sdf = new Float32Array(N);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const xs = rows[k * ny + j]?.sort((a, b) => a - b) ?? [];
      let c = 0;
      let idx = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++, idx++) {
        const x = origin[0] + i * vs;
        while (c < xs.length && xs[c] <= x) c++;
        const inside = (c & 1) === 1 && c < xs.length;
        const d = Math.min(Math.sqrt(dist[idx]), band || vs);
        sdf[idx] = inside ? -d : d;
      }
    }
  const g = makeGrid('distance', dims, vs, origin, 'FLOAT', 'LEVEL_SET', sdf);
  g.background = band || vs;
  return g;
}

/** Fog volume from a level set: `density` deep inside, fading to 0 over `interiorBand` at the surface. */
export function sdfToFog(sdf: VolumeGrid, interiorBand: number, density: number, name = 'density'): VolumeGrid {
  const out = new Float32Array(sdf.values.length);
  const ib = Math.max(0, interiorBand);
  for (let i = 0; i < out.length; i++) {
    const d = sdf.values[i];
    if (d >= 0) continue;
    out[i] = density * (ib > 0 ? Math.min(1, -d / ib) : 1);
  }
  return { ...sdf, name, grid_class: 'FOG_VOLUME', values: out, background: 0 };
}

/** Mesh to fog volume (Mesh to Volume): the interior of a closed mesh filled with `density`. */
export function meshToFog(positions: ArrayLike<number>, tris: ArrayLike<number>, voxel: number, interiorBand: number, density: number): VolumeGrid | null {
  const sdf = meshToSdf(positions, tris, { voxelSize: voxel, bandWidth: Math.max(interiorBand, voxel * 1.5), padding: 1 });
  return sdf ? sdfToFog(sdf, interiorBand, density) : null;
}

// ---------------------------------------------------------------------------
// Points → grid

export interface PointsGridOptions {
  voxelSize: number;
  /** points with radius 0 still fill one voxel */
  minRadius?: number;
}

function pointsRegion(points: ArrayLike<number>, radius: ArrayLike<number> | number, o: PointsGridOptions) {
  const n = points.length / 3;
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const r = typeof radius === 'number' ? radius : radius[i];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], points[i * 3 + k] - r);
      max[k] = Math.max(max[k], points[i * 3 + k] + r);
    }
  }
  const vs = clampVoxelSize(min, max, o.voxelSize, Math.max(o.voxelSize, 0) * 2);
  const pad = vs * 2;
  const origin: Vec3 = [min[0] - pad, min[1] - pad, min[2] - pad];
  const dims: Vec3 = [0, 1, 2].map((k) => Math.max(2, Math.ceil((max[k] - min[k] + 2 * pad) / vs) + 1)) as Vec3;
  return { vs, origin, dims };
}

/** Signed distance to a union of spheres (Points to SDF Grid). */
export function pointsToSdf(points: ArrayLike<number>, radius: ArrayLike<number> | number, o: PointsGridOptions): VolumeGrid | null {
  const n = points.length / 3;
  if (!n) return null;
  const { vs, origin, dims } = pointsRegion(points, radius, o);
  const [nx, ny, nz] = dims;
  const band = vs * 3;
  const sdf = new Float32Array(nx * ny * nz).fill(band);
  for (let p = 0; p < n; p++) {
    const r = Math.max(typeof radius === 'number' ? radius : radius[p], o.minRadius ?? 0);
    const cx = points[p * 3], cy = points[p * 3 + 1], cz = points[p * 3 + 2];
    const reach = r + band;
    const i0 = Math.max(0, Math.floor((cx - reach - origin[0]) / vs)), i1 = Math.min(nx - 1, Math.ceil((cx + reach - origin[0]) / vs));
    const j0 = Math.max(0, Math.floor((cy - reach - origin[1]) / vs)), j1 = Math.min(ny - 1, Math.ceil((cy + reach - origin[1]) / vs));
    const k0 = Math.max(0, Math.floor((cz - reach - origin[2]) / vs)), k1 = Math.min(nz - 1, Math.ceil((cz + reach - origin[2]) / vs));
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++) {
        let idx = (k * ny + j) * nx + i0;
        for (let i = i0; i <= i1; i++, idx++) {
          const d = Math.hypot(origin[0] + i * vs - cx, origin[1] + j * vs - cy, origin[2] + k * vs - cz) - r;
          if (d < sdf[idx]) sdf[idx] = Math.max(d, -band);
        }
      }
  }
  const g = makeGrid('distance', dims, vs, origin, 'FLOAT', 'LEVEL_SET', sdf);
  g.background = band;
  return g;
}

/** Fog volume of spheres around points (Points to Volume): `density` inside, soft at the edge. */
export function pointsToFog(points: ArrayLike<number>, radius: ArrayLike<number> | number, density: number, o: PointsGridOptions): VolumeGrid | null {
  const sdf = pointsToSdf(points, radius, o);
  if (!sdf) return null;
  const vs = voxelSize(sdf)[0];
  const out = new Float32Array(sdf.values.length);
  // one voxel of anti-aliasing across the sphere surface
  for (let i = 0; i < out.length; i++) out[i] = density * Math.min(1, Math.max(0, 0.5 - sdf.values[i] / vs));
  return { ...sdf, name: 'density', grid_class: 'FOG_VOLUME', values: out, background: 0 };
}

// ---------------------------------------------------------------------------
// Grid → mesh (surface nets: one vertex per cell crossing the iso value, a quad per crossing edge)

export interface GridMesh {
  positions: Float32Array;
  /** quads (4 vertex indices each), wound so normals point out of the "inside" region */
  quads: Uint32Array;
}

/**
 * Extract the iso surface where the grid crosses `threshold`. The inside is where values are
 * above the threshold (fog volumes) or below it when `insideBelow` (level sets). `adaptivity`
 * (0..1) merges vertices in flat regions to reduce the polygon count.
 */
export function gridToMesh(g: VolumeGrid, threshold: number, insideBelow = false, adaptivity = 0): GridMesh {
  const ch = gridChannels(g.data_type);
  const [nx0, ny0, nz0] = g.dims;
  // pad by one background voxel on every side so surfaces close at the grid border
  const nx = nx0 + 2,
    ny = ny0 + 2,
    nz = nz0 + 2;
  const f = new Float32Array(nx * ny * nz);
  const bgIn = insideBelow ? g.background < threshold : g.background > threshold;
  const outsideVal = bgIn ? -1 : 1;
  // f < 0 inside
  f.fill(outsideVal === 1 ? Math.max(1e-6, Math.abs(g.background - threshold)) : -Math.max(1e-6, Math.abs(g.background - threshold)));
  for (let k = 0; k < nz0; k++)
    for (let j = 0; j < ny0; j++)
      for (let i = 0; i < nx0; i++) {
        const v = g.values[((k * ny0 + j) * nx0 + i) * ch];
        let d = insideBelow ? v - threshold : threshold - v;
        if (d === 0) d = 1e-7;
        f[((k + 1) * ny + j + 1) * nx + i + 1] = d;
      }
  const at = (i: number, j: number, k: number) => f[(k * ny + j) * nx + i];
  const cx = nx - 1,
    cy = ny - 1,
    cz = nz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const pos: number[] = [];
  const corner = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ];
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const vals = new Float64Array(8);
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          vals[c] = at(i + corner[c][0], j + corner[c][1], k + corner[c][2]);
          if (vals[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          n = 0;
        for (const [a, b] of edges) {
          const va = vals[a],
            vb = vals[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += corner[a][0] + (corner[b][0] - corner[a][0]) * t;
          sy += corner[a][1] + (corner[b][1] - corner[a][1]) * t;
          sz += corner[a][2] + (corner[b][2] - corner[a][2]) * t;
          n++;
        }
        cellVert[(k * cy + j) * cx + i] = pos.length / 3;
        // index space of the original grid (the padding shifts by one voxel)
        pos.push(i + sx / n - 1, j + sy / n - 1, k + sz / n - 1);
      }
  const quads: number[] = [];
  const cell = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= cx || j >= cy || k >= cz ? -1 : cellVert[(k * cy + j) * cx + i]);
  // every grid edge whose ends differ in sign gets a quad from the 4 cells around it
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = at(i, j, k) < 0,
          b = at(i + 1, j, k) < 0;
        if (a === b) continue;
        const q = [cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k)];
        if (q.some((x) => x < 0)) continue;
        if (a) quads.push(q[0], q[1], q[2], q[3]);
        else quads.push(q[3], q[2], q[1], q[0]);
      }
  for (let k = 1; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const a = at(i, j, k) < 0,
          b = at(i, j + 1, k) < 0;
        if (a === b) continue;
        const q = [cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1)];
        if (q.some((x) => x < 0)) continue;
        if (a) quads.push(q[0], q[1], q[2], q[3]);
        else quads.push(q[3], q[2], q[1], q[0]);
      }
  for (let k = 0; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const a = at(i, j, k) < 0,
          b = at(i, j, k + 1) < 0;
        if (a === b) continue;
        const q = [cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k)];
        if (q.some((x) => x < 0)) continue;
        if (a) quads.push(q[0], q[1], q[2], q[3]);
        else quads.push(q[3], q[2], q[1], q[0]);
      }
  let P: Float32Array = Float32Array.from(pos);
  let Q: Uint32Array = Uint32Array.from(quads);
  if (adaptivity > 0) ({ positions: P, quads: Q } = simplifyFlat(P, Q, adaptivity));
  // to object space
  const out = new Float32Array(P.length);
  const t = [0, 0, 0];
  for (let v = 0; v < P.length; v += 3) {
    xform(g.transform, P[v], P[v + 1], P[v + 2], t);
    out[v] = t[0];
    out[v + 1] = t[1];
    out[v + 2] = t[2];
  }
  // a transform with negative determinant flips the winding
  const m = g.transform;
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (det < 0) for (let q = 0; q < Q.length; q += 4) [Q[q + 1], Q[q + 3]] = [Q[q + 3], Q[q + 1]];
  return { positions: out, quads: Q };
}

/**
 * Merge vertices of nearly flat regions: vertices are clustered on a coarser lattice whose cell
 * size grows with `adaptivity`, but only where the surrounding face normals agree.
 */
function simplifyFlat(P: Float32Array, Q: Uint32Array, adaptivity: number): { positions: Float32Array; quads: Uint32Array } {
  const nv = P.length / 3;
  const nq = Q.length / 4;
  const vn = new Float32Array(nv * 3);
  const fn = new Float32Array(nq * 3);
  for (let q = 0; q < nq; q++) {
    const a = Q[q * 4] * 3, b = Q[q * 4 + 1] * 3, c = Q[q * 4 + 2] * 3, d = Q[q * 4 + 3] * 3;
    const ux = P[c] - P[a], uy = P[c + 1] - P[a + 1], uz = P[c + 2] - P[a + 2];
    const wx = P[d] - P[b], wy = P[d + 1] - P[b + 1], wz = P[d + 2] - P[b + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    fn.set([nx / l, ny / l, nz / l], q * 3);
    for (const v of [a, b, c, d]) {
      vn[v] += nx / l;
      vn[v + 1] += ny / l;
      vn[v + 2] += nz / l;
    }
  }
  // flatness per vertex: 1 = all faces agree
  const flat = new Float32Array(nv);
  const cnt = new Uint16Array(nv);
  for (let q = 0; q < nq; q++)
    for (let k = 0; k < 4; k++) {
      const v = Q[q * 4 + k];
      const l = Math.hypot(vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]) || 1;
      flat[v] += (fn[q * 3] * vn[v * 3] + fn[q * 3 + 1] * vn[v * 3 + 1] + fn[q * 3 + 2] * vn[v * 3 + 2]) / l;
      cnt[v]++;
    }
  const cellSize = 1 + adaptivity * 4;
  const limit = 1 - adaptivity * 0.05;
  const key = new Map<string, number>();
  const remap = new Int32Array(nv);
  const acc: number[] = [];
  const accN: number[] = [];
  for (let v = 0; v < nv; v++) {
    const f = cnt[v] ? flat[v] / cnt[v] : 1;
    let k: string;
    if (f >= limit) {
      const l = Math.hypot(vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]) || 1;
      // cluster by lattice cell and dominant normal direction
      const dir = `${Math.round((vn[v * 3] / l) * 2)},${Math.round((vn[v * 3 + 1] / l) * 2)},${Math.round((vn[v * 3 + 2] / l) * 2)}`;
      k = `${Math.floor(P[v * 3] / cellSize)},${Math.floor(P[v * 3 + 1] / cellSize)},${Math.floor(P[v * 3 + 2] / cellSize)}|${dir}`;
    } else k = `v${v}`;
    let id = key.get(k);
    if (id === undefined) {
      id = acc.length / 3;
      key.set(k, id);
      acc.push(0, 0, 0);
      accN.push(0);
    }
    remap[v] = id;
    acc[id * 3] += P[v * 3];
    acc[id * 3 + 1] += P[v * 3 + 1];
    acc[id * 3 + 2] += P[v * 3 + 2];
    accN[id]++;
  }
  for (let i = 0; i < accN.length; i++) for (let c = 0; c < 3; c++) acc[i * 3 + c] /= accN[i];
  const outQ: number[] = [];
  for (let q = 0; q < nq; q++) {
    const vs = [remap[Q[q * 4]], remap[Q[q * 4 + 1]], remap[Q[q * 4 + 2]], remap[Q[q * 4 + 3]]];
    const uniq = vs.filter((x, i) => vs.indexOf(x) === i);
    if (uniq.length === 4) outQ.push(...vs);
    else if (uniq.length === 3) {
      // keep the triangle as a degenerate quad (last index repeated)
      const tri = vs.filter((x, i) => vs[(i + 3) % 4] !== x);
      if (tri.length === 3) outQ.push(tri[0], tri[1], tri[2], tri[2]);
    }
  }
  return { positions: Float32Array.from(acc), quads: Uint32Array.from(outQ) };
}

/** Polygon mesh arrays (offsets / indices) from grid quads, dropping repeated corners. */
export function quadsToPolys(quads: Uint32Array): { offsets: Uint32Array; indices: Uint32Array } {
  const offs: number[] = [0];
  const idx: number[] = [];
  for (let q = 0; q < quads.length; q += 4) {
    const a = quads[q], b = quads[q + 1], c = quads[q + 2], d = quads[q + 3];
    if (c === d) idx.push(a, b, c);
    else idx.push(a, b, c, d);
    offs.push(idx.length);
  }
  return { offsets: Uint32Array.from(offs), indices: Uint32Array.from(idx) };
}

// ---------------------------------------------------------------------------
// Displacement

/**
 * Volume Displace: every voxel takes the value found at its position minus a displacement
 * vector `(colour − mid) · strength` read from `texture` (object-space position → RGB). The grid
 * grows by |strength| on every side so displaced density is not cut off.
 */
export function displaceGrid(g: VolumeGrid, texture: (x: number, y: number, z: number) => [number, number, number], strength: number, mid: Vec3): VolumeGrid {
  const ch = gridChannels(g.data_type);
  const vs = voxelSize(g);
  const grow = [0, 1, 2].map((k) => Math.ceil(Math.abs(strength) / Math.max(vs[k], 1e-9)));
  const cap = 160;
  for (let k = 0; k < 3; k++) grow[k] = Math.min(grow[k], cap);
  const dims: Vec3 = [g.dims[0] + 2 * grow[0], g.dims[1] + 2 * grow[1], g.dims[2] + 2 * grow[2]];
  const transform = mulMat4(g.transform, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -grow[0], -grow[1], -grow[2], 1]);
  const out: VolumeGrid = { ...g, dims, transform, values: new Float32Array(dims[0] * dims[1] * dims[2] * ch) };
  const src = new GridSampler(g, 'LINEAR');
  const p = [0, 0, 0];
  let o = 0;
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++)
      for (let i = 0; i < dims[0]; i++) {
        xform(transform, i, j, k, p);
        const c = texture(p[0], p[1], p[2]);
        const x = p[0] - (c[0] - mid[0]) * strength,
          y = p[1] - (c[1] - mid[1]) * strength,
          z = p[2] - (c[2] - mid[2]) * strength;
        for (let q = 0; q < ch; q++) out.values[o++] = src.sample(x, y, z, q);
      }
  return out;
}

/** Fill a grid by evaluating `fn` at every voxel centre (object space). */
export function fillGrid(g: VolumeGrid, fn: (x: number, y: number, z: number, i: number) => number): VolumeGrid {
  const p = [0, 0, 0];
  let i = 0;
  const [nx, ny, nz] = g.dims;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let a = 0; a < nx; a++, i++) {
        xform(g.transform, a, j, k, p);
        g.values[i] = fn(p[0], p[1], p[2], i);
      }
  return g;
}
