// Pure brush math shared by sculpt and paint modes (no DOM / renderer dependencies so it can be
// unit tested): falloff curves, symmetry passes, blend modes, weight normalization, smoothing.

export type Falloff = 'SMOOTH' | 'SPHERE' | 'ROOT' | 'SHARP' | 'LINEAR' | 'CONSTANT' | 'INVERSE_SQUARE';

/**
 * Brush falloff for a normalized distance `t` (0 at the center, 1 at the rim). `hardness` keeps the
 * full strength up to that fraction of the radius and remaps the rest of the curve.
 */
export function falloff(type: Falloff, t: number, hardness = 0): number {
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  if (hardness > 0) {
    if (t < hardness) return 1;
    t = (t - hardness) / (1 - hardness);
  }
  const u = 1 - t;
  switch (type) {
    case 'SMOOTH':
      return u * u * (3 - 2 * u);
    case 'SPHERE':
      return Math.sqrt(Math.max(0, 1 - t * t));
    case 'ROOT':
      return Math.sqrt(u);
    case 'SHARP':
      return u * u;
    case 'LINEAR':
      return u;
    case 'CONSTANT':
      return 1;
    case 'INVERSE_SQUARE':
      // smooth bump that keeps more strength near the center than SMOOTH
      return u * (2 - u);
  }
  return u;
}

/** Sign vectors for every symmetry pass, the original pass first. */
export function symmetryPasses(x: boolean, y: boolean, z: boolean): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let m = 0; m < 8; m++) {
    if ((m & 1 && !x) || (m & 2 && !y) || (m & 4 && !z)) continue;
    out.push([m & 1 ? -1 : 1, m & 2 ? -1 : 1, m & 4 ? -1 : 1]);
  }
  return out;
}

/** Mirror a vector by a symmetry sign vector (component-wise multiply). */
export function mirror(v: ArrayLike<number>, s: ArrayLike<number>, out: number[] = [0, 0, 0]): number[] {
  out[0] = v[0] * s[0];
  out[1] = v[1] * s[1];
  out[2] = v[2] * s[2];
  return out;
}

export type BlendMode = 'MIX' | 'ADD' | 'SUB' | 'MUL' | 'LIGHTEN' | 'DARKEN' | 'ERASE_ALPHA' | 'ADD_ALPHA';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Blend `src` (rgb) into `dst` (rgba) with factor `a`, writing into `out` (rgba). Color values are
 * clamped to 0..1 (vertex colors and byte images are display-range data).
 */
export function blendColor(mode: BlendMode, dst: ArrayLike<number>, src: ArrayLike<number>, a: number, out: number[] = [0, 0, 0, 1]): number[] {
  out[3] = dst[3] ?? 1;
  for (let i = 0; i < 3; i++) {
    const d = dst[i],
      s = src[i];
    let r: number;
    switch (mode) {
      case 'ADD':
        r = d + s * a;
        break;
      case 'SUB':
        r = d - s * a;
        break;
      case 'MUL':
        r = d * (1 + (s - 1) * a);
        break;
      case 'LIGHTEN':
        r = d + (Math.max(d, s) - d) * a;
        break;
      case 'DARKEN':
        r = d + (Math.min(d, s) - d) * a;
        break;
      case 'ERASE_ALPHA':
      case 'ADD_ALPHA':
        r = d;
        break;
      default:
        r = d + (s - d) * a;
    }
    out[i] = clamp01(r);
  }
  if (mode === 'ERASE_ALPHA') out[3] = clamp01(out[3] * (1 - a));
  else if (mode === 'ADD_ALPHA') out[3] = clamp01(out[3] + a);
  else if (mode === 'MIX') out[3] = clamp01(out[3] + (1 - out[3]) * a);
  return out;
}

/** Blend a weight value into an existing vertex group weight. */
export function blendWeight(mode: BlendMode, w: number, value: number, a: number): number {
  switch (mode) {
    case 'ADD':
      return clamp01(w + value * a);
    case 'SUB':
      return clamp01(w - value * a);
    case 'MUL':
      return clamp01(w * (1 + (value - 1) * a));
    case 'LIGHTEN':
      return clamp01(w + (Math.max(w, value) - w) * a);
    case 'DARKEN':
      return clamp01(w + (Math.min(w, value) - w) * a);
    default:
      return clamp01(w + (value - w) * a);
  }
}

/**
 * Auto-normalize the weights of vertex `v` over `groups` so they sum to 1. The `active` group
 * (just painted) and `locked` groups keep their values; the remaining groups are scaled. When the
 * other unlocked groups are all zero nothing can be redistributed and the weights are left as is
 * (unless the active group alone exceeds the available budget, which is then clamped).
 */
export function normalizeVertexWeights(weights: Float32Array[], groups: number[], v: number, active: number, locked: ArrayLike<boolean> = []): void {
  let lockedSum = 0,
    rest = 0;
  for (const g of groups) {
    if (g === active) continue;
    if (locked[g]) lockedSum += weights[g][v];
    else rest += weights[g][v];
  }
  const hasActive = active >= 0 && groups.includes(active);
  let a = hasActive ? weights[active][v] : 0;
  const budget = Math.max(0, 1 - lockedSum);
  if (a > budget) {
    a = budget;
    weights[active][v] = a;
  }
  const target = budget - a;
  if (rest <= 1e-12) {
    // nothing to scale; only an active group without others: it may stay as painted
    return;
  }
  const k = target / rest;
  for (const g of groups) if (g !== active && !locked[g]) weights[g][v] *= k;
}

/** Normalize all weights of vertex `v` over `groups` (no active group): scale unlocked ones. */
export function normalizeAllWeights(weights: Float32Array[], groups: number[], v: number, locked: ArrayLike<boolean> = []): void {
  normalizeVertexWeights(weights, groups, v, -1, locked);
}

/** Colours of the weight heat map at 0, .25, .5, .75 and 1 (Preferences ▸ Editing can replace them). */
export const DEFAULT_WEIGHT_RAMP: [number, number, number][] = [
  [0, 0, 1],
  [0, 1, 1],
  [0, 1, 0],
  [1, 1, 0],
  [1, 0, 0],
];
export const weightRamp: [number, number, number][] = DEFAULT_WEIGHT_RAMP.map((c) => [...c] as [number, number, number]);

/** Weight → heat map color (default: blue 0, cyan .25, green .5, yellow .75, red 1). */
export function weightColor(w: number, out: number[] = [0, 0, 0]): number[] {
  w = clamp01(w);
  const stops = weightRamp.map((c, i) => [i / 4, c[0], c[1], c[2]]);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i],
      b = stops[i + 1];
    if (w <= b[0]) {
      const t = (w - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * t;
      out[1] = a[2] + (b[2] - a[2]) * t;
      out[2] = a[3] + (b[3] - a[3]) * t;
      return out;
    }
  }
  const last = weightRamp[weightRamp.length - 1];
  out[0] = last[0];
  out[1] = last[1];
  out[2] = last[2];
  return out;
}

/**
 * One Jacobi Laplacian smoothing step for the vertices in `verts` (count `n`) with per-vertex
 * factors `fac` (0..1): p += (mean(neighbors) - p) * fac. Reads from `pos` and writes the result
 * into `pos` after all averages are computed (so the order of vertices does not matter).
 */
export function laplacianSmooth(pos: Float32Array, nbOffsets: Uint32Array, nb: Uint32Array, verts: ArrayLike<number>, fac: ArrayLike<number>, n: number, tmp: Float32Array): void {
  for (let k = 0; k < n; k++) {
    const v = verts[k];
    const s = nbOffsets[v],
      e = nbOffsets[v + 1];
    if (e === s) {
      tmp[k * 3] = pos[v * 3];
      tmp[k * 3 + 1] = pos[v * 3 + 1];
      tmp[k * 3 + 2] = pos[v * 3 + 2];
      continue;
    }
    let x = 0,
      y = 0,
      z = 0;
    for (let j = s; j < e; j++) {
      const u = nb[j] * 3;
      x += pos[u];
      y += pos[u + 1];
      z += pos[u + 2];
    }
    const inv = 1 / (e - s);
    const f = fac[k];
    tmp[k * 3] = pos[v * 3] + (x * inv - pos[v * 3]) * f;
    tmp[k * 3 + 1] = pos[v * 3 + 1] + (y * inv - pos[v * 3 + 1]) * f;
    tmp[k * 3 + 2] = pos[v * 3 + 2] + (z * inv - pos[v * 3 + 2]) * f;
  }
  for (let k = 0; k < n; k++) {
    const v = verts[k] * 3;
    pos[v] = tmp[k * 3];
    pos[v + 1] = tmp[k * 3 + 1];
    pos[v + 2] = tmp[k * 3 + 2];
  }
}

/** Signed distance of point p from the plane through c with unit normal n. */
export function planeDistance(p: ArrayLike<number>, c: ArrayLike<number>, n: ArrayLike<number>): number {
  return (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2];
}

/** Linear ↔ sRGB transfer for 0..1 values. */
export function linearToSrgb(x: number): number {
  x = clamp01(x);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}
export function srgbToLinear(x: number): number {
  x = clamp01(x);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
