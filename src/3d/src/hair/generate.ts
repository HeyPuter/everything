// Procedural strands on a surface: evenly spread roots (area weighted, with a minimum spacing),
// straight along the surface normal, optionally bent by noise and frizz.
import type { Surface } from './surface';
import type { CurveInput } from './data';
import { rng } from './data';
import { PointHash } from './brushmath';

export interface GrowOptions {
  count: number;
  length: number;
  radius: number;
  points: number;
  seed?: number;
  /** random length variation 0..1 */
  lengthRandom?: number;
  /** low-frequency bending relative to the length */
  noise?: number;
  /** high-frequency kinks relative to the length */
  frizz?: number;
}

/** Smooth 3D value noise in [-1, 1] (hashed lattice, trilinear with smoothstep). */
export function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    zi = Math.floor(z);
  const fx = x - xi,
    fy = y - yi,
    fz = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(fx),
    v = s(fy),
    w = s(fz);
  const h = (i: number, j: number, k: number) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647) ^ Math.imul(seed, 144665);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (((n ^ (n >>> 16)) >>> 0) / 4294967295) * 2 - 1;
  };
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

/** Strands grown out of a surface (in the surface's object space). */
export function growStrands(surface: Surface, o: GrowOptions): CurveInput[] {
  const rand = rng(o.seed ?? 0);
  const out: CurveInput[] = [];
  const n = Math.max(0, Math.floor(o.count));
  if (!n || !surface.triCount) return out;
  // spacing that keeps roots from clumping (a fraction of the mean spacing)
  const spacing = Math.sqrt(surface.area / n) * 0.45;
  const hash = new PointHash(Math.max(spacing, 1e-6));
  const pts = Math.max(2, Math.round(o.points));
  const seed = (o.seed ?? 0) + 17;
  for (let tries = 0; out.length < n && tries < n * 6; tries++) {
    const hit = surface.randomPoint(rand);
    if (!hit) break;
    const p = hit.point,
      nrm = hit.normal;
    if (spacing > 0 && hash.near(p.x, p.y, p.z, spacing)) continue;
    hash.add(p.x, p.y, p.z);
    const len = o.length * (1 - (o.lengthRandom ?? 0) * rand());
    const points = new Float32Array(pts * 3);
    for (let k = 0; k < pts; k++) {
      const t = k / (pts - 1);
      let x = p.x + nrm.x * len * t,
        y = p.y + nrm.y * len * t,
        z = p.z + nrm.z * len * t;
      if (o.noise) {
        const f = 2 / Math.max(1e-4, o.length);
        const amp = o.noise * len * t * t;
        x += noise3(p.x * f, p.y * f, p.z * f + t, seed) * amp;
        y += noise3(p.x * f + 31.7, p.y * f, p.z * f + t, seed) * amp;
        z += noise3(p.x * f, p.y * f + 57.1, p.z * f + t, seed) * amp * 0.5;
      }
      if (o.frizz) {
        const amp = o.frizz * len * 0.15 * t;
        x += (rand() * 2 - 1) * amp;
        y += (rand() * 2 - 1) * amp;
        z += (rand() * 2 - 1) * amp;
      }
      points[k * 3] = x;
      points[k * 3 + 1] = y;
      points[k * 3 + 2] = z;
    }
    out.push({ points, radius: o.radius, uv: hit.uv ?? undefined });
  }
  return out;
}
