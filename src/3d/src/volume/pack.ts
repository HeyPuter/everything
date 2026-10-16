// Packing volume grids for the GPU: the grids a volume shader reads are resampled onto the
// density grid's lattice and stored as RGBA8 (density, emission, temperature, unused), each
// channel normalised by its maximum. Shared by the viewport display, the realtime engine and
// the path tracer. Results are cached per grid set and shader.
import type { VolumeGrid } from './types';
import { GridSampler, downsampleGrid, findGrid, mulMat4, voxelCount, xform } from './grid';
import type { VolumeShader } from './shader';

export interface PackedVolume {
  dims: [number, number, number];
  /** index space → object space */
  transform: number[];
  /** RGBA8: density, emission, temperature, 0 */
  data: Uint8Array;
  /** value represented by 255 in each channel */
  scale: [number, number, number];
  /** largest density value (= scale[0]) */
  maxDensity: number;
}

const cache = new WeakMap<object, Map<string, PackedVolume | null>>();

/** Pick the grid driving the density (named one, else the first float grid). */
export function densityGridOf(grids: VolumeGrid[], name: string | null): VolumeGrid | undefined {
  if (name) {
    const g = grids.find((x) => x.name === name);
    if (g) return g;
  }
  return grids.find((x) => x.data_type === 'FLOAT' && x.grid_class !== 'LEVEL_SET') ?? findGrid(grids, name ?? 'density');
}

/**
 * Pack a volume for rendering, downsampled to at most `maxVoxels`. Level sets are converted to a
 * solid fog (inside = 1). Returns null when there is no grid to show.
 */
export function packVolume(grids: VolumeGrid[], shader: VolumeShader, maxVoxels = 128 ** 3): PackedVolume | null {
  if (!grids.length) return null;
  const key = `${shader.densityGrid}|${shader.emissionGrid}|${shader.temperatureGrid}|${maxVoxels}|${grids.map((g) => g.name).join(',')}`;
  let per = cache.get(grids[0].values);
  if (!per) cache.set(grids[0].values, (per = new Map()));
  if (per.has(key)) {
    const hit = per.get(key)!;
    // the cache is keyed by the first grid's values; the others must match too
    if (!hit || (hit as unknown as { src: VolumeGrid[] }).src.every((g, i) => g === grids[i])) return hit;
  }
  const out = build(grids, shader, maxVoxels);
  if (out) Object.defineProperty(out, 'src', { value: [...grids], enumerable: false });
  per.set(key, out);
  return out;
}

function build(grids: VolumeGrid[], shader: VolumeShader, maxVoxels: number): PackedVolume | null {
  let dg = densityGridOf(grids, shader.densityGrid);
  if (!dg && (shader.emissionGrid || shader.temperatureGrid)) dg = grids.find((g) => g.name === shader.emissionGrid || g.name === shader.temperatureGrid);
  if (!dg) dg = grids[0];
  if (!voxelCount(dg)) return null;
  let f = 1;
  while (voxelCount(dg) / f ** 3 > maxVoxels) f++;
  const base = f > 1 ? downsampleGrid(dg, f) : dg;
  const [nx, ny, nz] = base.dims;
  const n = nx * ny * nz;
  const ch = base.data_type === 'VECTOR_FLOAT' ? 3 : 1;
  const dens = new Float32Array(n);
  const level = base.grid_class === 'LEVEL_SET';
  const usesDensityGrid = !!shader.densityGrid && base.name === shader.densityGrid;
  for (let i = 0; i < n; i++) {
    let v = ch === 3 ? Math.hypot(base.values[i * 3], base.values[i * 3 + 1], base.values[i * 3 + 2]) : base.values[i];
    // a level set is solid inside (negative distance)
    if (level) v = v < 0 ? 1 : 0;
    dens[i] = Math.max(0, v);
  }
  // a shader without a density grid fills the whole box evenly
  if (!shader.densityGrid || (!usesDensityGrid && !densityGridOf(grids, shader.densityGrid))) dens.fill(1);
  const sampleOther = (name: string | null): Float32Array | null => {
    if (!name) return null;
    const g = grids.find((x) => x.name === name);
    if (!g) return null;
    if (g === dg && f === 1) return Float32Array.from(dens);
    const s = new GridSampler(g, 'LINEAR');
    const out = new Float32Array(n);
    const p = [0, 0, 0];
    let i = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let a = 0; a < nx; a++, i++) {
          xform(base.transform, a, j, k, p);
          out[i] = Math.max(0, s.sample(p[0], p[1], p[2]));
        }
    return out;
  };
  const em = sampleOther(shader.emissionGrid);
  const te = sampleOther(shader.temperatureGrid);
  const max = (a: Float32Array | null) => {
    let m = 0;
    if (a) for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
    return m;
  };
  const scale: [number, number, number] = [max(dens), max(em), max(te)];
  const data = new Uint8Array(n * 4);
  const q = (v: number, s: number) => (s > 0 ? Math.min(255, Math.round((v / s) * 255)) : 0);
  for (let i = 0; i < n; i++) {
    data[i * 4] = q(dens[i], scale[0]);
    data[i * 4 + 1] = em ? q(em[i], scale[1]) : 0;
    data[i * 4 + 2] = te ? q(te[i], scale[2]) : 0;
  }
  return { dims: [nx, ny, nz], transform: base.transform, data, scale, maxDensity: scale[0] };
}

/** Column-major matrix mapping the unit cube [0,1]³ (texture coordinates) to object space. */
export function uvwToObject(p: Pick<PackedVolume, 'dims' | 'transform'>): number[] {
  const [nx, ny, nz] = p.dims;
  return mulMat4(p.transform, [nx, 0, 0, 0, 0, ny, 0, 0, 0, 0, nz, 0, -0.5, -0.5, -0.5, 1]);
}
