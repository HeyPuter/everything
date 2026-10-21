// Gradient (Perlin) noise in 1–4 dimensions with fractal variants, evaluated on the CPU. Lattice
// corners are hashed with lookup3 (`hash.ts`); the same algorithm runs in the GLSL library
// (`shader/glsl/noise.ts`) so geometry nodes and materials produce the same pattern.
import { hashU1, hashU2, hashU3, hashU4, offset1, offsetN } from './hash';

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function g1(h: number, x: number) {
  const g = 1 + (h & 7);
  return (h & 8 ? -g : g) * x;
}
function g2(h: number, x: number, y: number) {
  const k = h & 7;
  const u = k < 4 ? x : y,
    v = 2 * (k < 4 ? y : x);
  return (k & 1 ? -u : u) + (k & 2 ? -v : v);
}
function g3(h: number, x: number, y: number, z: number) {
  const k = h & 15;
  const u = k < 8 ? x : y;
  const v = k < 4 ? y : k === 12 || k === 14 ? x : z;
  return (k & 1 ? -u : u) + (k & 2 ? -v : v);
}
function g4(h: number, x: number, y: number, z: number, w: number) {
  const k = h & 31;
  const u = k < 24 ? x : y,
    v = k < 16 ? y : z,
    s = k < 8 ? z : w;
  return (k & 1 ? -u : u) + (k & 2 ? -v : v) + (k & 4 ? -s : s);
}

/** Large coordinates lose float precision: wrap them into a smaller range first. */
function wrap(p: number) {
  return Math.abs(p) >= 1000000 ? (p % 100000) + 0.5 : p;
}

export function perlin1(x: number) {
  x = wrap(x);
  const ix = Math.floor(x),
    fx = x - ix;
  return 0.25 * mix(g1(hashU1(ix), fx), g1(hashU1(ix + 1), fx - 1), fade(fx));
}

export function perlin2(x: number, y: number) {
  x = wrap(x);
  y = wrap(y);
  const ix = Math.floor(x),
    iy = Math.floor(y),
    fx = x - ix,
    fy = y - iy;
  const u = fade(fx),
    v = fade(fy);
  const a = g2(hashU2(ix, iy), fx, fy),
    b = g2(hashU2(ix + 1, iy), fx - 1, fy),
    c = g2(hashU2(ix, iy + 1), fx, fy - 1),
    d = g2(hashU2(ix + 1, iy + 1), fx - 1, fy - 1);
  return 0.6616 * mix(mix(a, b, u), mix(c, d, u), v);
}

export function perlin3(x: number, y: number, z: number) {
  x = wrap(x);
  y = wrap(y);
  z = wrap(z);
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  const fx = x - ix,
    fy = y - iy,
    fz = z - iz;
  const u = fade(fx),
    v = fade(fy),
    w = fade(fz);
  const n000 = g3(hashU3(ix, iy, iz), fx, fy, fz);
  const n100 = g3(hashU3(ix + 1, iy, iz), fx - 1, fy, fz);
  const n010 = g3(hashU3(ix, iy + 1, iz), fx, fy - 1, fz);
  const n110 = g3(hashU3(ix + 1, iy + 1, iz), fx - 1, fy - 1, fz);
  const n001 = g3(hashU3(ix, iy, iz + 1), fx, fy, fz - 1);
  const n101 = g3(hashU3(ix + 1, iy, iz + 1), fx - 1, fy, fz - 1);
  const n011 = g3(hashU3(ix, iy + 1, iz + 1), fx, fy - 1, fz - 1);
  const n111 = g3(hashU3(ix + 1, iy + 1, iz + 1), fx - 1, fy - 1, fz - 1);
  return 0.982 * mix(mix(mix(n000, n100, u), mix(n010, n110, u), v), mix(mix(n001, n101, u), mix(n011, n111, u), v), w);
}

export function perlin4(x: number, y: number, z: number, w: number) {
  x = wrap(x);
  y = wrap(y);
  z = wrap(z);
  w = wrap(w);
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z),
    iw = Math.floor(w);
  const fx = x - ix,
    fy = y - iy,
    fz = z - iz,
    fw = w - iw;
  const u = fade(fx),
    v = fade(fy),
    t = fade(fz),
    s = fade(fw);
  const layer = (dw: number) => {
    const W = iw + dw,
      F = fw - dw;
    const n0000 = g4(hashU4(ix, iy, iz, W), fx, fy, fz, F);
    const n1000 = g4(hashU4(ix + 1, iy, iz, W), fx - 1, fy, fz, F);
    const n0100 = g4(hashU4(ix, iy + 1, iz, W), fx, fy - 1, fz, F);
    const n1100 = g4(hashU4(ix + 1, iy + 1, iz, W), fx - 1, fy - 1, fz, F);
    const n0010 = g4(hashU4(ix, iy, iz + 1, W), fx, fy, fz - 1, F);
    const n1010 = g4(hashU4(ix + 1, iy, iz + 1, W), fx - 1, fy, fz - 1, F);
    const n0110 = g4(hashU4(ix, iy + 1, iz + 1, W), fx, fy - 1, fz - 1, F);
    const n1110 = g4(hashU4(ix + 1, iy + 1, iz + 1, W), fx - 1, fy - 1, fz - 1, F);
    return mix(mix(mix(n0000, n1000, u), mix(n0100, n1100, u), v), mix(mix(n0010, n1010, u), mix(n0110, n1110, u), v), t);
  };
  return 0.8344 * mix(layer(0), layer(1), s);
}

/** Signed noise of a 1–4 component point. */
export function snoise(p: ArrayLike<number>, n = p.length): number {
  switch (n) {
    case 1:
      return perlin1(p[0]);
    case 2:
      return perlin2(p[0], p[1]);
    case 3:
      return perlin3(p[0], p[1], p[2]);
    default:
      return perlin4(p[0], p[1], p[2], p[3]);
  }
}
/** Unsigned noise in [0, 1]. */
export const unoise = (p: ArrayLike<number>, n = p.length) => 0.5 * snoise(p, n) + 0.5;

// ---------------------------------------------------------------------------
// Fractals (each samples `snoise` at scaled copies of the point)

export type NoiseType = 'MULTIFRACTAL' | 'RIDGED_MULTIFRACTAL' | 'HYBRID_MULTIFRACTAL' | 'FBM' | 'HETERO_TERRAIN';

/** Signed noise of `p` scaled by `s` (no allocation). */
function sn(p: ArrayLike<number>, n: number, s: number): number {
  switch (n) {
    case 1:
      return perlin1(p[0] * s);
    case 2:
      return perlin2(p[0] * s, p[1] * s);
    case 3:
      return perlin3(p[0] * s, p[1] * s, p[2] * s);
    default:
      return perlin4(p[0] * s, p[1] * s, p[2] * s, p[3] * s);
  }
}

export function fbm(p: ArrayLike<number>, n: number, detail: number, rough: number, lac: number, norm: boolean): number {
  let fs = 1,
    amp = 1,
    maxAmp = 0,
    sum = 0;
  const oct = Math.floor(detail);
  for (let i = 0; i <= oct; i++) {
    sum += sn(p, n, fs) * amp;
    maxAmp += amp;
    amp *= rough;
    fs *= lac;
  }
  const rmd = detail - oct;
  if (rmd !== 0) {
    const sum2 = sum + sn(p, n, fs) * amp;
    return norm ? mix((0.5 * sum) / maxAmp + 0.5, (0.5 * sum2) / (maxAmp + amp) + 0.5, rmd) : mix(sum, sum2, rmd);
  }
  return norm ? (0.5 * sum) / maxAmp + 0.5 : sum;
}

function multifractal(p: ArrayLike<number>, n: number, detail: number, rough: number, lac: number) {
  let v = 1,
    pwr = 1,
    fs = 1;
  const oct = Math.floor(detail);
  for (let i = 0; i <= oct; i++) {
    v *= pwr * sn(p, n, fs) + 1;
    pwr *= rough;
    fs *= lac;
  }
  const rmd = detail - oct;
  if (rmd !== 0) v *= rmd * pwr * sn(p, n, fs) + 1;
  return v;
}

function hetero(p: ArrayLike<number>, n: number, detail: number, rough: number, lac: number, offset: number) {
  let pwr = rough,
    fs = lac;
  let v = offset + sn(p, n, 1);
  const oct = Math.floor(detail);
  for (let i = 1; i <= oct; i++) {
    v += (sn(p, n, fs) + offset) * pwr * v;
    pwr *= rough;
    fs *= lac;
  }
  const rmd = detail - oct;
  if (rmd !== 0) v += rmd * ((sn(p, n, fs) + offset) * pwr * v);
  return v;
}

function hybrid(p: ArrayLike<number>, n: number, detail: number, rough: number, lac: number, offset: number, gain: number) {
  let pwr = 1,
    v = 0,
    weight = 1,
    fs = 1;
  const oct = Math.floor(detail);
  for (let i = 0; weight > 0.001 && i <= oct; i++) {
    if (weight > 1) weight = 1;
    const signal = (sn(p, n, fs) + offset) * pwr;
    pwr *= rough;
    v += weight * signal;
    weight *= gain * signal;
    fs *= lac;
  }
  const rmd = detail - oct;
  if (rmd !== 0 && weight > 0.001) {
    if (weight > 1) weight = 1;
    v += rmd * weight * ((sn(p, n, fs) + offset) * pwr);
  }
  return v;
}

function ridged(p: ArrayLike<number>, n: number, detail: number, rough: number, lac: number, offset: number, gain: number) {
  let pwr = rough,
    fs = 1;
  let signal = offset - Math.abs(sn(p, n, 1));
  signal *= signal;
  let v = signal;
  const oct = Math.floor(detail);
  for (let i = 1; i <= oct; i++) {
    fs *= lac;
    const weight = Math.max(0, Math.min(1, signal * gain));
    signal = offset - Math.abs(sn(p, n, fs));
    signal *= signal;
    signal *= weight;
    v += signal * pwr;
    pwr *= rough;
  }
  return v;
}

export function fractal(type: NoiseType, p: ArrayLike<number>, n: number, detail: number, rough: number, lac: number, offset: number, gain: number, norm: boolean): number {
  detail = Math.max(0, Math.min(15, detail));
  rough = Math.max(0, rough);
  switch (type) {
    case 'MULTIFRACTAL':
      return multifractal(p, n, detail, rough, lac);
    case 'RIDGED_MULTIFRACTAL':
      return ridged(p, n, detail, rough, lac, offset, gain);
    case 'HYBRID_MULTIFRACTAL':
      return hybrid(p, n, detail, rough, lac, offset, gain);
    case 'HETERO_TERRAIN':
      return hetero(p, n, detail, rough, lac, offset);
    default:
      return fbm(p, n, detail, rough, lac, norm);
  }
}

export interface NoiseParams {
  detail: number;
  roughness: number;
  lacunarity: number;
  offset: number;
  gain: number;
  distortion: number;
  type: NoiseType;
  normalize: boolean;
}

/** Offset vectors per dimension count: seed → [n components] (cached). */
const offsetCache: number[][][] = [[], [], [], [], []];
function offsetVec(seed: number, n: number): number[] {
  const c = offsetCache[n];
  let v = c[seed];
  if (!v) {
    v = n === 1 ? [offset1(seed)] : Array.from({ length: n }, (_, i) => offsetN(seed, i));
    c[seed] = v;
  }
  return v;
}

const q4 = [0, 0, 0, 0],
  t4 = [0, 0, 0, 0],
  d4 = [0, 0, 0, 0];

/**
 * Noise Texture: `p` holds `n` (1–4) already scaled coordinates. Writes [factor, r, g, b] to `out`
 * (color channels only when `color` is set).
 */
export function noiseTexture(p: ArrayLike<number>, n: number, o: NoiseParams, color: boolean, out: number[] | Float32Array, at = 0) {
  const q = q4;
  for (let i = 0; i < 4; i++) q[i] = p[i] ?? 0;
  if (o.distortion !== 0) {
    for (let a = 0; a < n; a++) {
      const off = offsetVec(a, n);
      for (let i = 0; i < n; i++) t4[i] = q[i] + off[i];
      d4[a] = snoise(t4, n) * o.distortion;
    }
    for (let a = 0; a < n; a++) q[a] += d4[a];
  }
  const f = fractal(o.type, q, n, o.detail, o.roughness, o.lacunarity, o.offset, o.gain, o.normalize);
  out[at] = f;
  if (color) {
    out[at + 1] = f;
    for (let c = 0; c < 2; c++) {
      const off = offsetVec(n + c, n);
      for (let i = 0; i < n; i++) t4[i] = q[i] + off[i];
      out[at + 2 + c] = fractal(o.type, t4, n, o.detail, o.roughness, o.lacunarity, o.offset, o.gain, o.normalize);
    }
  }
  return out;
}
