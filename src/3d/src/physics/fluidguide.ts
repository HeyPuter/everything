// Fluid guiding: velocities that steer a domain's flow, either from moving Guide effectors or from
// the simulated velocities of another (guide parent) domain. Grid units: cells per second.
import { Matrix4, Vector3 } from 'three';
import type { ObjectData } from '../data/types';
import type { SimContext } from './common';
import type { GridFrame, Voxels } from './liquid';
import type { FluidEffectorSettings, FluidModifier } from './fluid';

/** Velocity field of a domain's cached frame, dequantized (grid units of that domain). */
export interface VelocitySource {
  G: GridFrame;
  vel: Int8Array;
  scale: number;
}

type Participant = { ob: ObjectData; m: FluidModifier };
type Voxelize = (ctx: SimContext, ob: ObjectData, frame: number, G: GridFrame, surface: number, volume: number, wantNormals: boolean) => Voxels | null;

/**
 * Combine the velocities of the guide effectors into one field: xyz velocity + weight per cell
 * (weight 0 where no guide reaches). Each guide's mode decides how it merges with the earlier ones.
 */
export function effectorGuides(ctx: SimContext, guides: Participant[], G: GridFrame, frame: number, voxelize: Voxelize): Float32Array | null {
  const n = G.nx * G.ny * G.nz;
  let out: Float32Array | null = null;
  let count: Uint16Array | null = null;
  for (const g of guides) {
    const es = g.m.effector_settings as FluidEffectorSettings;
    if (!es.use_effector) continue;
    const vx = voxelize(ctx, g.ob, frame, G, 0.75 + (es.surface_distance ?? 0), es.use_plane_init ? 0 : 1, false);
    if (!vx) continue;
    const f = es.velocity_factor ?? 1;
    const v = vx.vel ?? [0, 0, 0];
    out ??= new Float32Array(n * 4);
    count ??= new Uint16Array(n);
    const mode = es.guide_mode ?? 'OVERRIDE';
    for (let o = 0; o < n; o++) {
      if (vx.w[o] <= 0.5) continue;
      const p = o * 4;
      const nv = [v[0] * f, v[1] * f, v[2] * f];
      if (out[p + 3] === 0 || mode === 'OVERRIDE') {
        out[p] = nv[0];
        out[p + 1] = nv[1];
        out[p + 2] = nv[2];
        count[o] = 1;
      } else if (mode === 'MAXIMUM') for (let c = 0; c < 3; c++) out[p + c] = Math.max(out[p + c], nv[c]);
      else if (mode === 'MINIMUM') for (let c = 0; c < 3; c++) out[p + c] = Math.min(out[p + c], nv[c]);
      else {
        // running average of all guides covering the cell
        const k = ++count[o];
        for (let c = 0; c < 3; c++) out[p + c] += (nv[c] - out[p + c]) / k;
      }
      out[p + 3] = 1;
    }
  }
  return out;
}

/** Guide field sampled from another domain's velocities (both grids given with their world placement). */
export function domainGuides(src: VelocitySource, srcWorld: Matrix4, G: GridFrame, world: Matrix4): Float32Array {
  const { nx, ny, nz } = G;
  const out = new Float32Array(nx * ny * nz * 4);
  // grid → world → source grid, and the linear part for converting velocities
  const toSrc = new Matrix4().multiplyMatrices(src.G.toGrid, srcWorld.clone().invert()).multiply(world).multiply(G.toGrid.clone().invert());
  const back = toSrc.clone().setPosition(0, 0, 0).invert();
  const p = new Vector3(),
    v = new Vector3();
  const S = src.G;
  for (let k = 0, o = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, o++) {
        p.set(i + 0.5, j + 0.5, k + 0.5).applyMatrix4(toSrc);
        const si = Math.floor(p.x),
          sj = Math.floor(p.y),
          sk = Math.floor(p.z);
        if (si < 0 || sj < 0 || sk < 0 || si >= S.nx || sj >= S.ny || sk >= S.nz) continue;
        const so = (si + sj * S.nx + sk * S.nx * S.ny) * 3;
        v.set(src.vel[so], src.vel[so + 1], src.vel[so + 2]).multiplyScalar(src.scale / 127).applyMatrix4(back);
        out[o * 4] = v.x;
        out[o * 4 + 1] = v.y;
        out[o * 4 + 2] = v.z;
        out[o * 4 + 3] = 1;
      }
  return out;
}

/** Spread the guide weights over `size` cells (separable box blur of the weighted velocities). */
export function blurGuides(field: Float32Array, G: GridFrame, size: number): Float32Array {
  const r = Math.max(0, Math.round((size - 1) / 2));
  if (r === 0) return field;
  const { nx, ny, nz } = G;
  let a = field;
  const strides = [1, nx, nx * ny],
    dims = [nx, ny, nz];
  for (let axis = 0; axis < 3; axis++) {
    const b = new Float32Array(a.length);
    const st = strides[axis],
      dim = dims[axis];
    for (let k = 0, o = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++, o++) {
          const idx = [i, j, k][axis];
          let sw = 0,
            sx = 0,
            sy = 0,
            sz = 0,
            cnt = 0;
          for (let d = -r; d <= r; d++) {
            const q = idx + d;
            if (q < 0 || q >= dim) continue;
            const qo = (o + d * st) * 4;
            const wt = a[qo + 3];
            sx += a[qo] * wt;
            sy += a[qo + 1] * wt;
            sz += a[qo + 2] * wt;
            sw += wt;
            cnt++;
          }
          if (sw > 0) {
            b[o * 4] = sx / sw;
            b[o * 4 + 1] = sy / sw;
            b[o * 4 + 2] = sz / sw;
            b[o * 4 + 3] = sw / cnt;
          }
        }
    a = b;
  }
  return a;
}

/**
 * Pull the velocities towards the guide field: `weight` is how quickly (per second) the flow
 * follows its guide, `factor` scales the guide velocities.
 */
export function applyGuides(u: Float32Array, v: Float32Array, w: Float32Array, field: Float32Array, weight: number, factor: number, dt: number) {
  const n = u.length;
  const rate = 1 - Math.exp(-Math.max(0, weight) * 5 * dt);
  for (let o = 0; o < n; o++) {
    const gw = field[o * 4 + 3];
    if (gw <= 0) continue;
    const t = rate * Math.min(1, gw);
    u[o] += (field[o * 4] * factor - u[o]) * t;
    v[o] += (field[o * 4 + 1] * factor - v[o]) * t;
    w[o] += (field[o * 4 + 2] * factor - w[o]) * t;
  }
}

/** Quantize a velocity field to signed bytes with one scale (for caching per frame). */
export function quantizeVelocity(u: Float32Array, v: Float32Array, w: Float32Array): { vel: Int8Array; scale: number } {
  const n = u.length;
  let m = 1e-6;
  for (let o = 0; o < n; o++) m = Math.max(m, Math.abs(u[o]), Math.abs(v[o]), Math.abs(w[o]));
  const out = new Int8Array(n * 3);
  const s = 127 / m;
  for (let o = 0; o < n; o++) {
    out[o * 3] = Math.round(u[o] * s);
    out[o * 3 + 1] = Math.round(v[o] * s);
    out[o * 3 + 2] = Math.round(w[o] * s);
  }
  return { vel: out, scale: m };
}
