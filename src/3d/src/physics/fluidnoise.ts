// Gas noise: a higher resolution copy of the smoke with small-scale turbulence added. Each fine cell
// samples the coarse density at a position pushed around by a smooth random vector field, and the
// push is stronger where the coarse flow moves faster (so still smoke stays smooth).
import { gradientNoise } from '../eval/textures';

export interface NoiseParams {
  /** fine cells per coarse cell along each axis */
  scale: number;
  strength: number;
  /** size of the noise features (larger = finer detail) */
  posScale: number;
  /** how fast the noise pattern changes per frame */
  timeAnim: number;
  frame: number;
}

export interface CoarseGas {
  nx: number;
  ny: number;
  nz: number;
  /** RG8 density, flame */
  data: Uint8Array;
  /** velocities xyz per cell as signed bytes, scaled by velScale / 127 */
  vel?: Int8Array;
  velScale?: number;
}

/** Trilinear sample of channel `ch` (stride 2) at coarse cell coordinates (cell centres at +0.5). */
function sample2(d: Uint8Array, ch: number, nx: number, ny: number, nz: number, x: number, y: number, z: number): number {
  x -= 0.5;
  y -= 0.5;
  z -= 0.5;
  if (x < -0.5 || y < -0.5 || z < -0.5 || x > nx - 0.5 || y > ny - 0.5 || z > nz - 0.5) return 0;
  x = Math.min(nx - 1.0001, Math.max(0, x));
  y = Math.min(ny - 1.0001, Math.max(0, y));
  z = Math.min(nz - 1.0001, Math.max(0, z));
  const i = Math.floor(x),
    j = Math.floor(y),
    k = Math.floor(z);
  const fx = x - i,
    fy = y - j,
    fz = z - k;
  const i1 = i + 1 < nx ? 1 : 0,
    j1 = j + 1 < ny ? nx : 0,
    k1 = k + 1 < nz ? nx * ny : 0;
  const o = i + j * nx + k * nx * ny;
  const at = (q: number) => d[q * 2 + ch];
  const c00 = at(o) * (1 - fx) + at(o + i1) * fx;
  const c10 = at(o + j1) * (1 - fx) + at(o + j1 + i1) * fx;
  const c01 = at(o + k1) * (1 - fx) + at(o + k1 + i1) * fx;
  const c11 = at(o + k1 + j1) * (1 - fx) + at(o + k1 + j1 + i1) * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

/** Two octaves of gradient noise (roughly -1..1). */
function turb(x: number, y: number, z: number): number {
  return gradientNoise(x, y, z) * 0.7 + gradientNoise(x * 2.03 + 17.1, y * 2.03 - 5.3, z * 2.03 + 9.7) * 0.35;
}

/** Fine resolution smoke (RG8 density, flame) for a coarse frame. */
export function upresGas(c: CoarseGas, p: NoiseParams): { nx: number; ny: number; nz: number; data: Uint8Array } {
  const s = Math.max(1, Math.min(8, Math.round(p.scale)));
  const NX = c.nx * s,
    NY = c.ny * s,
    NZ = c.nz * s;
  const out = new Uint8Array(NX * NY * NZ * 2);
  const { nx, ny, nz, data } = c;
  // coarse occupancy (any density or flame in the cell or its neighbours) to skip empty space
  const occ = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const o = i + j * nx + k * nx * ny;
        if (!data[o * 2] && !data[o * 2 + 1]) continue;
        for (let dk = -1; dk <= 1; dk++)
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              const a = i + di,
                b = j + dj,
                cc = k + dk;
              if (a >= 0 && b >= 0 && cc >= 0 && a < nx && b < ny && cc < nz) occ[a + b * nx + cc * nx * ny] = 1;
            }
      }
  const vel = c.vel,
    vs = (c.velScale ?? 0) / 127;
  // velocity magnitude relative to the frame's fastest cell drives the turbulence
  const vmax = Math.max(1e-6, c.velScale ?? 0);
  const freq = Math.max(1e-4, p.posScale) / 4;
  const t = p.frame * p.timeAnim;
  const amp = p.strength * 1.5;
  let o = 0;
  for (let K = 0; K < NZ; K++)
    for (let J = 0; J < NY; J++)
      for (let I = 0; I < NX; I++, o++) {
        const x = (I + 0.5) / s,
          y = (J + 0.5) / s,
          z = (K + 0.5) / s;
        const ci = Math.min(nx - 1, Math.floor(x)),
          cj = Math.min(ny - 1, Math.floor(y)),
          ck = Math.min(nz - 1, Math.floor(z));
        const co = ci + cj * nx + ck * nx * ny;
        if (!occ[co]) continue;
        let e = 0.35;
        if (vel) {
          const vx = vel[co * 3] * vs,
            vy = vel[co * 3 + 1] * vs,
            vz = vel[co * 3 + 2] * vs;
          e = Math.min(1, 0.15 + Math.hypot(vx, vy, vz) / vmax);
        }
        const nxp = x * freq,
          nyp = y * freq,
          nzp = z * freq;
        const a = amp * e;
        const dx = turb(nxp + 31.4, nyp + t, nzp) * a,
          dy = turb(nxp, nyp + 47.2 + t, nzp - 12.6) * a,
          dz = turb(nxp - 19.8, nyp + t, nzp + 63.1) * a;
        const dens = sample2(data, 0, nx, ny, nz, x + dx, y + dy, z + dz);
        const fl = sample2(data, 1, nx, ny, nz, x + dx, y + dy, z + dz);
        // fine detail modulates the density a little where the flow is turbulent
        const detail = 1 + 0.4 * p.strength * e * turb(nxp * 4 + 5.5, nyp * 4 - t * 2, nzp * 4);
        out[o * 2] = Math.max(0, Math.min(255, Math.round(dens * detail)));
        out[o * 2 + 1] = Math.max(0, Math.min(255, Math.round(fl * detail)));
      }
  return { nx: NX, ny: NY, nz: NZ, data: out };
}
