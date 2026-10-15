// `mathutils.noise`: deterministic procedural noise and random numbers for scripts.
// Original implementation: hashed-lattice gradient noise, cellular (Voronoi) noise and
// the usual fractal sums on top. Values are roughly in [-1, 1] like the public module;
// exact values are this application's own. `seed_set` only affects the random functions.
import { Vector, toArray, mathError, type VecLike } from './mathutils';

type Basis = 'BLENDER' | 'PERLIN_ORIGINAL' | 'PERLIN_NEW' | 'VORONOI_F1' | 'VORONOI_F2' | 'VORONOI_F3' | 'VORONOI_F4' | 'VORONOI_F2F1' | 'VORONOI_CRACKLE' | 'CELLNOISE';
const BASES = ['BLENDER', 'PERLIN_ORIGINAL', 'PERLIN_NEW', 'VORONOI_F1', 'VORONOI_F2', 'VORONOI_F3', 'VORONOI_F4', 'VORONOI_F2F1', 'VORONOI_CRACKLE', 'CELLNOISE'];
type Metric = 'DISTANCE' | 'DISTANCE_SQUARED' | 'MANHATTAN' | 'CHEBYCHEV' | 'MINKOVSKY_HALF' | 'MINKOVSKY_FOUR' | 'MINKOVSKY';
const METRICS = ['DISTANCE', 'DISTANCE_SQUARED', 'MANHATTAN', 'CHEBYCHEV', 'MINKOVSKY_HALF', 'MINKOVSKY_FOUR', 'MINKOVSKY'];

// ---------------------------------------------------------------------------
// hashing

function mix(h: number) {
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
function hash3(x: number, y: number, z: number, salt: number) {
  return mix(mix(mix(mix(salt) ^ (x | 0)) ^ (y | 0)) ^ (z | 0));
}
/** Hash to [0, 1). */
const unit = (h: number) => h / 4294967296;

// ---------------------------------------------------------------------------
// random numbers (seedable)

let rngState = mix(0x9e3779b9);
function nextRandom() {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// gradient noise

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
// 12 cube-edge gradient directions
const GRAD = [1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1];

function gradDot(ix: number, iy: number, iz: number, fx: number, fy: number, fz: number, salt: number) {
  const g = (hash3(ix, iy, iz, salt) % 12) * 3;
  return GRAD[g] * fx + GRAD[g + 1] * fy + GRAD[g + 2] * fz;
}

function gradient(x: number, y: number, z: number, salt: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  const fx = x - ix,
    fy = y - iy,
    fz = z - iz;
  const u = fade(fx),
    v = fade(fy),
    w = fade(fz);
  const n000 = gradDot(ix, iy, iz, fx, fy, fz, salt),
    n100 = gradDot(ix + 1, iy, iz, fx - 1, fy, fz, salt),
    n010 = gradDot(ix, iy + 1, iz, fx, fy - 1, fz, salt),
    n110 = gradDot(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz, salt),
    n001 = gradDot(ix, iy, iz + 1, fx, fy, fz - 1, salt),
    n101 = gradDot(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1, salt),
    n011 = gradDot(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1, salt),
    n111 = gradDot(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1, salt);
  const r = lerp(lerp(lerp(n000, n100, u), lerp(n010, n110, u), v), lerp(lerp(n001, n101, u), lerp(n011, n111, u), v), w);
  return Math.max(-1, Math.min(1, r));
}

// ---------------------------------------------------------------------------
// cellular noise

function metricFn(metric: Metric, exponent: number): (dx: number, dy: number, dz: number) => number {
  switch (metric) {
    case 'DISTANCE_SQUARED':
      return (x, y, z) => x * x + y * y + z * z;
    case 'MANHATTAN':
      return (x, y, z) => Math.abs(x) + Math.abs(y) + Math.abs(z);
    case 'CHEBYCHEV':
      return (x, y, z) => Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    case 'MINKOVSKY_HALF':
      return (x, y, z) => (Math.sqrt(Math.abs(x)) + Math.sqrt(Math.abs(y)) + Math.sqrt(Math.abs(z))) ** 2;
    case 'MINKOVSKY_FOUR':
      return (x, y, z) => Math.sqrt(Math.sqrt(x ** 4 + y ** 4 + z ** 4));
    case 'MINKOVSKY':
      return (x, y, z) => (Math.abs(x) ** exponent + Math.abs(y) ** exponent + Math.abs(z) ** exponent) ** (1 / exponent);
    default:
      return (x, y, z) => Math.sqrt(x * x + y * y + z * z);
  }
}

const CELL_SALT = 0x51ed27;
/** The four nearest feature points (one jittered point per unit cell): distances and positions. */
function cellular(x: number, y: number, z: number, dist: (dx: number, dy: number, dz: number) => number) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  const d = [Infinity, Infinity, Infinity, Infinity];
  const p: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let a = -1; a <= 1; a++)
    for (let b = -1; b <= 1; b++)
      for (let c = -1; c <= 1; c++) {
        const cx = ix + a,
          cy = iy + b,
          cz = iz + c;
        const h = hash3(cx, cy, cz, CELL_SALT);
        const px = cx + unit(mix(h ^ 1)),
          py = cy + unit(mix(h ^ 2)),
          pz = cz + unit(mix(h ^ 3));
        const dd = dist(px - x, py - y, pz - z);
        if (dd < d[3]) {
          let k = 3;
          while (k > 0 && d[k - 1] > dd) {
            d[k] = d[k - 1];
            p[k] = p[k - 1];
            k--;
          }
          d[k] = dd;
          p[k] = [px, py, pz];
        }
      }
  return { d, p };
}

const euclid = metricFn('DISTANCE', 2);

function basisValue(x: number, y: number, z: number, basis: Basis): number {
  switch (basis) {
    case 'BLENDER':
      return gradient(x, y, z, 0x1b873593);
    case 'PERLIN_NEW':
      return gradient(x, y, z, 0x2c1b3c6d);
    case 'CELLNOISE':
      return unit(hash3(Math.floor(x), Math.floor(y), Math.floor(z), 0x3c6ef372)) * 2 - 1;
    case 'VORONOI_F1':
    case 'VORONOI_F2':
    case 'VORONOI_F3':
    case 'VORONOI_F4':
    case 'VORONOI_F2F1':
    case 'VORONOI_CRACKLE': {
      const { d } = cellular(x, y, z, euclid);
      let v: number;
      if (basis === 'VORONOI_F2F1') v = d[1] - d[0];
      else if (basis === 'VORONOI_CRACKLE') v = Math.min(1, 10 * (d[1] - d[0]));
      else v = d[Number(basis[basis.length - 1]) - 1];
      return Math.max(-1, Math.min(1, 2 * v - 1));
    }
    default:
      return gradient(x, y, z, 0x0);
  }
}

// ---------------------------------------------------------------------------
// argument helpers

function pos(v: VecLike): [number, number, number] {
  const a = toArray(v);
  if (a.length < 2) throw mathError('ValueError', 'noise: expected a 2D or 3D position');
  return [a[0], a[1], a[2] ?? 0];
}
function basisArg(b: unknown): Basis {
  const s = b === undefined || b === null ? 'PERLIN_ORIGINAL' : String(b);
  if (!BASES.includes(s)) throw mathError('ValueError', `noise: unknown noise_basis '${s}', expected one of ${BASES.join(', ')}`);
  return s as Basis;
}
const VEC_OFFSETS = [
  [0, 0, 0],
  [17.13, -3.71, 29.41],
  [-41.27, 23.93, -7.17],
];

function noise3(x: number, y: number, z: number, basis: Basis) {
  return basisValue(x, y, z, basis);
}
function noiseVec(x: number, y: number, z: number, basis: Basis): [number, number, number] {
  return VEC_OFFSETS.map((o) => basisValue(x + o[0], y + o[1], z + o[2], basis)) as [number, number, number];
}

function octaveLoop(octaves: number, step: (i: number, weight: number) => void) {
  const full = Math.floor(octaves);
  for (let i = 0; i < full; i++) step(i, 1);
  const rem = octaves - full;
  if (rem > 1e-9) step(full, rem);
}

// ---------------------------------------------------------------------------

export const noise = {
  /** Seed the random functions (random, random_unit_vector, random_vector). */
  seed_set(seed: number) {
    rngState = mix(Math.floor(Number(seed)) ^ 0x9e3779b9);
  },
  /** A random number in [0, 1). */
  random(): number {
    return nextRandom();
  },
  /** A random direction of unit length (size 2 to 4). */
  random_unit_vector(size = 3): Vector {
    if (size < 2 || size > 4) throw mathError('ValueError', 'random_unit_vector(): size must be between 2 and 4');
    for (;;) {
      const v = Array.from({ length: size }, () => nextRandom() * 2 - 1);
      const l = Math.hypot(...v);
      if (l > 1e-6 && l <= 1) return new Vector(v.map((c) => c / l));
    }
  },
  /** A random vector with components in [-1, 1]. */
  random_vector(size = 3): Vector {
    if (size < 2 || size > 4) throw mathError('ValueError', 'random_vector(): size must be between 2 and 4');
    return new Vector(Array.from({ length: size }, () => nextRandom() * 2 - 1));
  },
  /** Noise value (about -1 to 1) at a position. */
  noise(position: VecLike, noise_basis: Basis = 'PERLIN_ORIGINAL'): number {
    const [x, y, z] = pos(position);
    return noise3(x, y, z, basisArg(noise_basis));
  },
  noise_vector(position: VecLike, noise_basis: Basis = 'PERLIN_ORIGINAL'): Vector {
    const [x, y, z] = pos(position);
    return new Vector(noiseVec(x, y, z, basisArg(noise_basis)));
  },
  /** Sum of octaves of noise (absolute values when `hard`). */
  turbulence(position: VecLike, octaves: number, hard: boolean, noise_basis: Basis = 'PERLIN_ORIGINAL', amplitude_scale = 0.5, frequency_scale = 2.0): number {
    const [x, y, z] = pos(position);
    const b = basisArg(noise_basis);
    let amp = 1,
      freq = 1,
      sum = 0;
    for (let i = 0; i < Math.floor(octaves); i++) {
      const n = noise3(x * freq, y * freq, z * freq, b);
      sum += amp * (hard ? Math.abs(n) : n);
      amp *= amplitude_scale;
      freq *= frequency_scale;
    }
    return sum;
  },
  turbulence_vector(position: VecLike, octaves: number, hard: boolean, noise_basis: Basis = 'PERLIN_ORIGINAL', amplitude_scale = 0.5, frequency_scale = 2.0): Vector {
    const [x, y, z] = pos(position);
    const b = basisArg(noise_basis);
    let amp = 1,
      freq = 1;
    const sum = [0, 0, 0];
    for (let i = 0; i < Math.floor(octaves); i++) {
      const n = noiseVec(x * freq, y * freq, z * freq, b);
      for (let k = 0; k < 3; k++) sum[k] += amp * (hard ? Math.abs(n[k]) : n[k]);
      amp *= amplitude_scale;
      freq *= frequency_scale;
    }
    return new Vector(sum);
  },
  /** Fractal Brownian motion: octaves weighted by lacunarity^(-H·octave). */
  fractal(position: VecLike, H: number, lacunarity: number, octaves: number, noise_basis: Basis = 'PERLIN_ORIGINAL'): number {
    let [x, y, z] = pos(position);
    const b = basisArg(noise_basis);
    const step = Math.pow(lacunarity, -H);
    let pw = 1,
      value = 0;
    octaveLoop(octaves, (_, wgt) => {
      value += noise3(x, y, z, b) * pw * wgt;
      pw *= step;
      x *= lacunarity;
      y *= lacunarity;
      z *= lacunarity;
    });
    return value;
  },
  /** Multiplicative fractal (values around 1). */
  multi_fractal(position: VecLike, H: number, lacunarity: number, octaves: number, noise_basis: Basis = 'PERLIN_ORIGINAL'): number {
    let [x, y, z] = pos(position);
    const b = basisArg(noise_basis);
    const step = Math.pow(lacunarity, -H);
    let pw = 1,
      value = 1;
    octaveLoop(octaves, (_, wgt) => {
      value *= wgt * pw * noise3(x, y, z, b) + 1;
      pw *= step;
      x *= lacunarity;
      y *= lacunarity;
      z *= lacunarity;
    });
    return value;
  },
  /** Terrain-like fractal whose detail grows with height. */
  hetero_terrain(position: VecLike, H: number, lacunarity: number, octaves: number, offset: number, noise_basis: Basis = 'PERLIN_ORIGINAL'): number {
    let [x, y, z] = pos(position);
    const b = basisArg(noise_basis);
    const step = Math.pow(lacunarity, -H);
    let value = offset + noise3(x, y, z, b);
    let pw = step;
    x *= lacunarity;
    y *= lacunarity;
    z *= lacunarity;
    octaveLoop(octaves - 1, (_, wgt) => {
      value += wgt * (noise3(x, y, z, b) + offset) * pw * value;
      pw *= step;
      x *= lacunarity;
      y *= lacunarity;
      z *= lacunarity;
    });
    return value;
  },
  /** Fractal mixing additive and multiplicative octaves (smooth valleys, rough peaks). */
  hybrid_multi_fractal(position: VecLike, H: number, lacunarity: number, octaves: number, offset: number, gain: number, noise_basis: Basis = 'PERLIN_ORIGINAL'): number {
    let [x, y, z] = pos(position);
    const b = basisArg(noise_basis);
    const step = Math.pow(lacunarity, -H);
    let result = noise3(x, y, z, b) + offset;
    let weight = gain * result;
    let pw = step;
    x *= lacunarity;
    y *= lacunarity;
    z *= lacunarity;
    octaveLoop(octaves - 1, (_, wgt) => {
      if (weight > 1) weight = 1;
      const signal = (noise3(x, y, z, b) + offset) * pw;
      result += wgt * weight * signal;
      weight *= gain * signal;
      pw *= step;
      x *= lacunarity;
      y *= lacunarity;
      z *= lacunarity;
    });
    return result;
  },
  /** Fractal of sharp ridges. */
  ridged_multi_fractal(position: VecLike, H: number, lacunarity: number, octaves: number, offset: number, gain: number, noise_basis: Basis = 'PERLIN_ORIGINAL'): number {
    let [x, y, z] = pos(position);
    const b = basisArg(noise_basis);
    const step = Math.pow(lacunarity, -H);
    let signal = offset - Math.abs(noise3(x, y, z, b));
    signal *= signal;
    let result = signal;
    let pw = step;
    for (let i = 1; i < Math.floor(octaves); i++) {
      x *= lacunarity;
      y *= lacunarity;
      z *= lacunarity;
      const weight = Math.max(0, Math.min(1, signal * gain));
      signal = offset - Math.abs(noise3(x, y, z, b));
      signal *= signal * weight;
      result += signal * pw;
      pw *= step;
    }
    return result;
  },
  /** Noise of one basis whose domain is distorted by another. */
  variable_lacunarity(position: VecLike, distortion: number, noise_type1: Basis = 'PERLIN_ORIGINAL', noise_type2: Basis = 'PERLIN_ORIGINAL'): number {
    const [x, y, z] = pos(position);
    const b1 = basisArg(noise_type1),
      b2 = basisArg(noise_type2);
    const d = noiseVec(x + 13.5, y + 13.5, z + 13.5, b1);
    return noise3(x + d[0] * distortion, y + d[1] * distortion, z + d[2] * distortion, b2);
  },
  /** Cell noise: one random value (-1 to 1) per unit cell. */
  cell(position: VecLike): number {
    const [x, y, z] = pos(position);
    return basisValue(x, y, z, 'CELLNOISE');
  },
  cell_vector(position: VecLike): Vector {
    const [x, y, z] = pos(position);
    const ix = Math.floor(x),
      iy = Math.floor(y),
      iz = Math.floor(z);
    return new Vector([1, 2, 3].map((k) => unit(hash3(ix, iy, iz, 0x3c6ef372 + k * 7919)) * 2 - 1));
  },
  /** Distances to the four nearest feature points and their positions: [[d1, d2, d3, d4], [p1, p2, p3, p4]]. */
  voronoi(position: VecLike, distance_metric: Metric = 'DISTANCE', exponent = 2.5): [number[], Vector[]] {
    const [x, y, z] = pos(position);
    const m = distance_metric ?? 'DISTANCE';
    if (!METRICS.includes(m)) throw mathError('ValueError', `voronoi(): unknown distance_metric '${m}', expected one of ${METRICS.join(', ')}`);
    const { d, p } = cellular(x, y, z, metricFn(m, exponent));
    return [d, p.map((q) => new Vector(q))];
  },
};
