// Render passes derived from the geometry guide buffer (pure, unit tested).
import { mistFactor } from './units';
import type { PassName } from './result';

/**
 * Data passes from the normal/depth guide buffer (top-down): Depth (view distance along
 * the camera axis, 1e10 for background), world Normal and Mist (camera distance mapped
 * through the world mist range).
 */
export function passesFromGuide(guide: Float32Array, W: number, H: number, invProj: number[], ortho: boolean, mist: { start: number; depth: number; falloff?: 'QUADRATIC' | 'LINEAR' | 'INVERSE_QUADRATIC' }, want: { z: boolean; normal: boolean; mist: boolean }) {
  const out: Partial<Record<PassName, Float32Array>> = {};
  const n = W * H;
  const Z = want.z || want.mist ? new Float32Array(n) : null;
  const N = want.normal ? new Float32Array(n * 4) : null;
  const M = want.mist ? new Float32Array(n) : null;
  const e = invProj;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = guide[i * 4 + 3];
      const bg = !(d > 0);
      if (Z) Z[i] = bg ? 1e10 : d;
      if (N) {
        N[i * 4] = bg ? 0 : guide[i * 4];
        N[i * 4 + 1] = bg ? 0 : guide[i * 4 + 1];
        N[i * 4 + 2] = bg ? 0 : guide[i * 4 + 2];
        N[i * 4 + 3] = bg ? 0 : 1;
      }
      if (M) {
        if (bg) M[i] = 1;
        else {
          let dist = d;
          if (!ortho) {
            // view ray through the pixel centre: inverse projection of the NDC point on the near plane
            const nx = ((x + 0.5) / W) * 2 - 1,
              ny = 1 - ((y + 0.5) / H) * 2;
            const vx = e[0] * nx + e[4] * ny + e[8] * -1 + e[12],
              vy = e[1] * nx + e[5] * ny + e[9] * -1 + e[13],
              vz = e[2] * nx + e[6] * ny + e[10] * -1 + e[14];
            const len = Math.hypot(vx, vy, vz);
            const cz = len > 0 ? -vz / len : 1;
            dist = d / Math.max(1e-6, cz);
          }
          M[i] = mistFactor(dist, mist.start, mist.depth, mist.falloff);
        }
      }
    }
  if (want.z && Z) out.Depth = Z;
  if (N) out.Normal = N;
  if (M) out.Mist = M;
  return out;
}
