// Spatial adjustment kinds: Clarity & Dehaze and Grain. They need neighboring
// pixels or the pixel position, so they cannot become color tables. This is
// the exact CPU reference; src/renderer/filter-shaders.ts runs the same math
// on the GPU for adjustment layers (keep both in step).
//
// Clarity & Dehaze works on a reduced copy of the image (at most WORK pixels
// on the long side, box-averaged by an integer factor): large blurs and the
// haze estimate are smooth, so the reduced copy loses nothing visible and
// keeps the cost independent of the document size.
//   1. Reduce: per block, alpha-weighted luma (L·a, a), the dark channel
//      (smallest of R, G, B over pixels with alpha) and the largest alpha.
//   2. Blur L·a and a with a Gaussian (clarity); min-filter the dark channel,
//      then smooth it with a Gaussian (dehaze). Edges repeat the border.
//   3. Atmospheric light A: the brightest smoothed dark value with content.
//   4. Per pixel, sample the reduced planes bilinearly and combine:
//      dehaze > 0 removes haze as J = (I - A) / max(1 - 0.95·k·dark / A, 0.1) + A;
//      dehaze < 0 mixes toward a haze color; clarity adds the luma detail
//      (L - blurred L), weighted toward midtones.
import { clamp, clamp01, luma } from './color-math';
import type { Adjustment, ClarityDehazeParams, GrainParams } from './model';
import type { RGBA8 } from '../types';
import { normalizeRelight } from '../relight/model';
import { relight } from '../relight/surface';

export const SPATIAL_WORK = 1024;
const fin = (v: number) => (Number.isFinite(v) ? v : 0);

export type SpatialGeometry = {
  // Reduction factor and reduced size.
  factor: number;
  width: number;
  height: number;
  // Gaussian deviation and radius for the clarity blur (reduced pixels).
  sigmaC: number;
  radiusC: number;
  // Dark channel min radius, then its smoothing Gaussian.
  radiusD: number;
  sigmaD: number;
  radiusS: number;
};

/** Reduced-plane geometry for an image of `width` x `height` pixels in a
 * document whose long side is `docMax` (the effect scales with the document). */
export function spatialGeometry(width: number, height: number, docMax = Math.max(width, height)): SpatialGeometry {
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / SPATIAL_WORK));
  const scale = Math.max(1, docMax) / factor;
  const sigmaC = Math.max(1.5, 0.008 * scale);
  const radiusD = Math.max(1, Math.round(0.004 * scale));
  const sigmaD = 1.5 * radiusD;
  return {
    factor,
    width: Math.ceil(width / factor),
    height: Math.ceil(height / factor),
    sigmaC,
    radiusC: Math.ceil(3 * sigmaC),
    radiusD,
    sigmaD,
    radiusS: Math.ceil(3 * sigmaD),
  };
}

/** Slider values as shader amounts: clarity and dehaze fractions in -1..1. */
export function clarityDehazeAmounts(p: ClarityDehazeParams) {
  return { clarity: clamp(fin(p.clarity), -100, 100) / 100, dehaze: clamp(fin(p.dehaze), -100, 100) / 100 };
}

// Separable passes on a planar float image with edge repetition.
function gaussian(src: Float32Array, w: number, h: number, sigma: number, radius: number, horizontal: boolean) {
  const out = new Float32Array(src.length);
  const k = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += k[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const sx = horizontal ? Math.min(w - 1, Math.max(0, x + i)) : x,
          sy = horizontal ? y : Math.min(h - 1, Math.max(0, y + i));
        acc += k[i + radius] * src[sy * w + sx];
      }
      out[y * w + x] = acc / sum;
    }
  return out;
}
function minimum(src: Float32Array, w: number, h: number, radius: number, horizontal: boolean) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = src[y * w + x];
      for (let i = -radius; i <= radius; i++) {
        const sx = horizontal ? Math.min(w - 1, Math.max(0, x + i)) : x,
          sy = horizontal ? y : Math.min(h - 1, Math.max(0, y + i));
        const v = src[sy * w + sx];
        if (v < m) m = v;
      }
      out[y * w + x] = m;
    }
  return out;
}

export type ReducedPlanes = { geometry: SpatialGeometry; la: Float32Array; a: Float32Array; dark: Float32Array; light: number };

/** Steps 1-3 above on straight RGBA floats in 0..1 (stride 4). */
export function reducedPlanes(px: Float32Array, width: number, height: number, docMax: number, clarity: boolean, dehaze: boolean): ReducedPlanes {
  const g = spatialGeometry(width, height, docMax);
  const { factor: f, width: w, height: h } = g;
  let la = new Float32Array(w * h),
    a = new Float32Array(w * h),
    dark = new Float32Array(w * h);
  const has = new Uint8Array(w * h);
  for (let by = 0; by < h; by++)
    for (let bx = 0; bx < w; bx++) {
      let sl = 0,
        sa = 0,
        d = 1,
        n = 0;
      const x1 = Math.min(width, bx * f + f),
        y1 = Math.min(height, by * f + f);
      for (let y = by * f; y < y1; y++)
        for (let x = bx * f; x < x1; x++) {
          const i = (y * width + x) * 4;
          const r = px[i],
            gg = px[i + 1],
            b = px[i + 2],
            al = px[i + 3];
          sl += luma(r, gg, b) * al;
          sa += al;
          n++;
          if (al > 0) {
            d = Math.min(d, r, gg, b);
            has[by * w + bx] = 1;
          }
        }
      la[by * w + bx] = sl / n;
      a[by * w + bx] = sa / n;
      dark[by * w + bx] = d;
    }
  if (clarity) {
    la = gaussian(gaussian(la, w, h, g.sigmaC, g.radiusC, true), w, h, g.sigmaC, g.radiusC, false);
    a = gaussian(gaussian(a, w, h, g.sigmaC, g.radiusC, true), w, h, g.sigmaC, g.radiusC, false);
  }
  let light = 1;
  if (dehaze) {
    dark = minimum(minimum(dark, w, h, g.radiusD, true), w, h, g.radiusD, false);
    dark = gaussian(gaussian(dark, w, h, g.sigmaD, g.radiusS, true), w, h, g.sigmaD, g.radiusS, false);
    let m = 0,
      any = false;
    for (let i = 0; i < dark.length; i++)
      if (has[i]) {
        any = true;
        if (dark[i] > m) m = dark[i];
      }
    light = any ? Math.max(m, 0.05) : 1;
  }
  return { geometry: g, la, a, dark, light };
}

/** Bilinear sample of a reduced plane at full-resolution pixel (x, y). */
function upsample(plane: Float32Array, g: SpatialGeometry, x: number, y: number) {
  const qx = (x + 0.5) / g.factor - 0.5,
    qy = (y + 0.5) / g.factor - 0.5;
  const ix = Math.floor(qx),
    iy = Math.floor(qy),
    tx = qx - ix,
    ty = qy - iy;
  const x0 = Math.min(g.width - 1, Math.max(0, ix)),
    x1 = Math.min(g.width - 1, Math.max(0, ix + 1)),
    y0 = Math.min(g.height - 1, Math.max(0, iy)),
    y1 = Math.min(g.height - 1, Math.max(0, iy + 1));
  const w = g.width;
  const top = plane[y0 * w + x0] + (plane[y0 * w + x1] - plane[y0 * w + x0]) * tx;
  const bottom = plane[y1 * w + x0] + (plane[y1 * w + x1] - plane[y1 * w + x0]) * tx;
  return top + (bottom - top) * ty;
}

/** Step 4 for one pixel (straight RGB in `c`, written in place). */
export function clarityDehazePixel(c: Float64Array, la: number, a: number, dark: number, light: number, clarity: number, dehaze: number) {
  const L = clamp01(luma(c[0], c[1], c[2]));
  if (dehaze > 0) {
    const t = Math.max(1 - (0.95 * dehaze * dark) / light, 0.1);
    for (let k = 0; k < 3; k++) c[k] = (c[k] - light) / t + light;
  } else if (dehaze < 0) {
    const fog = Math.max(light, 0.75),
      h = -dehaze * 0.6;
    for (let k = 0; k < 3; k++) c[k] += (fog - c[k]) * h;
  }
  if (clarity && a > 1e-6) {
    const amt = clarity > 0 ? 1.5 * clarity : clarity;
    const d = amt * (L - la / a) * 4 * L * (1 - L);
    for (let k = 0; k < 3; k++) c[k] += d;
  }
}

export type SpatialContext = {
  // Document position of the image's top-left pixel (grain is anchored to the document).
  x?: number;
  y?: number;
  // Document size: the effect radius follows the document, not the crop.
  docWidth?: number;
  docHeight?: number;
};

/** Clarity & Dehaze on straight RGBA floats (stride 4) of a document whose
 * long side is `docMax`. Results are kept at or above 0 and, with
 * `clampTop`, at or below 1 (integer documents). */
export function clarityDehazeFloat(px: Float32Array, width: number, height: number, p: ClarityDehazeParams, docMax = Math.max(width, height), clampTop = true): Float32Array {
  const { clarity, dehaze } = clarityDehazeAmounts(p);
  const out = new Float32Array(px);
  if (!clarity && !dehaze) return out;
  const planes = reducedPlanes(px, width, height, docMax, !!clarity, !!dehaze);
  const g = planes.geometry;
  const c = new Float64Array(3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!(px[i + 3] > 0)) continue;
      c[0] = px[i];
      c[1] = px[i + 1];
      c[2] = px[i + 2];
      clarityDehazePixel(
        c,
        clarity ? upsample(planes.la, g, x, y) : 0,
        clarity ? upsample(planes.a, g, x, y) : 0,
        dehaze ? upsample(planes.dark, g, x, y) : 0,
        planes.light,
        clarity,
        dehaze,
      );
      for (let k = 0; k < 3; k++) out[i + k] = clampTop ? clamp01(c[k]) : Math.max(0, c[k]);
    }
  return out;
}

export function clarityDehaze(src: RGBA8, p: ClarityDehazeParams, ctx: SpatialContext = {}): RGBA8 {
  const px = new Float32Array(src.data.length);
  for (let i = 0; i < px.length; i++) px[i] = src.data[i] / 255;
  const docMax = Math.max(ctx.docWidth ?? src.width, ctx.docHeight ?? src.height);
  const res = clarityDehazeFloat(px, src.width, src.height, p, docMax);
  const out: RGBA8 = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  for (let i = 0; i < res.length; i++) if ((i & 3) !== 3) out.data[i] = res[i] * 255;
  return out;
}

// ----- Grain -----

// 32-bit integer hash (the same bit operations run in the shaders) to a value in [-1, 1).
export function grainHash(x: number, y: number, seed: number) {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(seed, 0xcb1ab31f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return ((h >>> 8) / 16777216) * 2 - 1;
}
/** Smooth value noise: hashed lattice values with smoothstep interpolation. */
export function grainNoise(x: number, y: number, seed: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const fx = x - ix,
    fy = y - iy;
  const wx = fx * fx * (3 - 2 * fx),
    wy = fy * fy * (3 - 2 * fy);
  const a = grainHash(ix, iy, seed),
    b = grainHash(ix + 1, iy, seed),
    c = grainHash(ix, iy + 1, seed),
    d = grainHash(ix + 1, iy + 1, seed);
  const top = a + (b - a) * wx,
    bottom = c + (d - c) * wx;
  return top + (bottom - top) * wy;
}

/** Shader amounts: strength, cell size in pixels, roughness and color 0..1. */
export function grainAmounts(p: GrainParams) {
  const v = (x: number) => clamp(fin(x), 0, 100) / 100;
  return { strength: v(p.amount) * 0.2, cell: 1 + v(p.size) * 4, roughness: v(p.roughness), color: v(p.color) };
}

/** Grain for one pixel at document pixel (X, Y) (straight RGB in `c`, in place).
 * Roughness mixes in a finer octave; the grain is strongest in midtones. */
export function grainPixel(c: Float64Array, X: number, Y: number, g: ReturnType<typeof grainAmounts>) {
  const qx = X + 0.5,
    qy = Y + 0.5,
    s = g.cell;
  const n = grainNoise(qx / s, qy / s, 1) * (1 - g.roughness) + grainNoise(qx / (s * 0.5), qy / (s * 0.5), 2) * g.roughness;
  const L = clamp01(luma(c[0], c[1], c[2]));
  const wt = 0.35 + 2.6 * L * (1 - L);
  const d = g.strength * n * wt;
  for (let k = 0; k < 3; k++) c[k] += d;
  if (g.color > 0) {
    const kc = g.strength * g.color * wt;
    c[0] += kc * grainNoise(qx / s, qy / s, 3);
    c[1] += kc * grainNoise(qx / s, qy / s, 4);
    c[2] += kc * grainNoise(qx / s, qy / s, 5);
  }
}

/** Grain on straight RGBA floats; (ox, oy) is the document position of the first pixel. */
export function grainFloat(px: Float32Array, width: number, height: number, p: GrainParams, ox = 0, oy = 0, clampTop = true): Float32Array {
  const g = grainAmounts(p);
  const out = new Float32Array(px);
  if (!g.strength) return out;
  const c = new Float64Array(3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!(px[i + 3] > 0)) continue;
      c[0] = px[i];
      c[1] = px[i + 1];
      c[2] = px[i + 2];
      grainPixel(c, ox + x, oy + y, g);
      for (let k = 0; k < 3; k++) out[i + k] = clampTop ? clamp01(c[k]) : Math.max(0, c[k]);
    }
  return out;
}

export function grain(src: RGBA8, p: GrainParams, ctx: SpatialContext = {}): RGBA8 {
  const px = new Float32Array(src.data.length);
  for (let i = 0; i < px.length; i++) px[i] = src.data[i] / 255;
  const res = grainFloat(px, src.width, src.height, p, Math.round(ctx.x ?? 0), Math.round(ctx.y ?? 0));
  const out: RGBA8 = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  for (let i = 0; i < res.length; i++) if ((i & 3) !== 3) out.data[i] = res[i] * 255;
  return out;
}

/** The spatial result of an adjustment, or undefined for color-table kinds. */
export function applySpatial(src: RGBA8, adj: Adjustment, ctx: SpatialContext = {}): RGBA8 | undefined {
  if (adj.kind === 'clarity-dehaze') return clarityDehaze(src, adj.params, ctx);
  if (adj.kind === 'grain') return grain(src, adj.params, ctx);
  if (adj.kind === 'relight') return relight(src, normalizeRelight(adj.params), ctx);
  return undefined;
}
