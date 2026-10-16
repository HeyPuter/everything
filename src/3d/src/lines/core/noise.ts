// Small deterministic noise functions for stroke styling (hash based value / gradient noise).

/** Hash of integer coordinates and a seed to [0, 1). */
export function hash(seed: number, x: number, y = 0): number {
  let h = (seed * 374761393 + x * 668265263 + y * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** 1D gradient noise in about [-1, 1]. */
export function noise1(seed: number, x: number): number {
  const i = Math.floor(x),
    f = x - i;
  const g0 = hash(seed, i) * 2 - 1,
    g1 = hash(seed, i + 1) * 2 - 1;
  const u = fade(f);
  return 2 * (g0 * f * (1 - u) + g1 * (f - 1) * u);
}

/** 2D gradient noise in about [-1, 1]. */
export function noise2(seed: number, x: number, y: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const fx = x - ix,
    fy = y - iy;
  const grad = (gx: number, gy: number, dx: number, dy: number) => {
    const a = hash(seed, gx, gy) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = fade(fx),
    v = fade(fy);
  const n00 = grad(ix, iy, fx, fy),
    n10 = grad(ix + 1, iy, fx - 1, fy),
    n01 = grad(ix, iy + 1, fx, fy - 1),
    n11 = grad(ix + 1, iy + 1, fx - 1, fy - 1);
  return 1.4 * (n00 * (1 - u) * (1 - v) + n10 * u * (1 - v) + n01 * (1 - u) * v + n11 * u * v);
}

/** Fractal sums (octaves halve the amplitude and double the frequency). */
export function fbm1(seed: number, x: number, octaves: number): number {
  let s = 0,
    a = 1,
    norm = 0;
  for (let o = 0; o < Math.max(1, octaves); o++) {
    s += noise1(seed + o * 131, x) * a;
    norm += a;
    x *= 2;
    a *= 0.5;
  }
  return s / norm;
}

export function fbm2(seed: number, x: number, y: number, octaves: number): number {
  let s = 0,
    a = 1,
    norm = 0;
  for (let o = 0; o < Math.max(1, octaves); o++) {
    s += noise2(seed + o * 131, x, y) * a;
    norm += a;
    x *= 2;
    y *= 2;
    a *= 0.5;
  }
  return s / norm;
}

/** Seeded pseudo random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
