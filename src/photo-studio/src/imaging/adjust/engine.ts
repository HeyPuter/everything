// Evaluation of adjustments: the exact CPU reference path, the compiled form
// consumed by the GPU compositor, and a CPU emulation of that GPU path.
//
// Compiled sampling conventions (the GPU must match them):
// - 1D curve tables have N entries; entry i holds f(i / (N - 1)). A value x in
//   [0, 1] is looked up at x * (N - 1) with linear interpolation. The composite
//   `rgb` table is applied first, then `r`, `g`, `b` per channel.
// - The 3D LUT holds size^3 RGBA float entries, red fastest, then green, then
//   blue; grid point (i, j, k) holds f(i, j, k / (size - 1)). Inputs are
//   clamped to [0, 1] and sampled trilinearly at x * (size - 1).
// - Optional `postCurves` (only when requested) are per-channel tables applied
//   after the 3D LUT.
import { cloneRGBA8, checkCancelled, type Mask8, type Progress, type RGBA8 } from '../types';
import { bakeCubeLut, type CubeLut } from './cube';
import type { Fn1 } from './curves';
import { planFor, type PixelFn, type Plan } from './kinds';
import { isSpatialKind, type Adjustment } from './model';
import { applySpatial, type SpatialContext } from './spatial';
import { isIdentityRelight, normalizeRelight } from '../relight/model';

export type CurveTables = { rgb: Float32Array; r: Float32Array; g: Float32Array; b: Float32Array };
export type CompiledAdjustment = {
  curves?: CurveTables;
  lut3d?: { size: number; data: Float32Array };
  postCurves?: { r: Float32Array; g: Float32Array; b: Float32Array };
  // True when the 3D LUT cannot represent a hard edge (Threshold) or a
  // position-dependent effect (Gradient Map dither) exactly.
  approximate?: boolean;
};
export type CompileOptions = {
  lutSize?: number; // 17..65, default 33
  curveSize?: 256 | 4096; // default 4096
  // Emit `postCurves` for kinds that factor into a linear 3D LUT plus a curve
  // (Threshold, Gradient Map), which makes them exact on a pipeline that
  // supports curves after the LUT.
  postCurves?: boolean;
};

const identity: Fn1 = (x) => x;
const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function curveTable(f: Fn1 | undefined, n: number): Float32Array {
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = f ? c01(f(i / (n - 1))) : i / (n - 1);
  return t;
}

// Samples the color function on the size^3 grid in one batch.
function bakeLut(fn: PixelFn, size: number): { size: number; data: Float32Array } {
  const count = size * size * size;
  const inp = new Float64Array(count * 3),
    res = new Float64Array(count * 3);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        inp[i++] = r / (size - 1);
        inp[i++] = g / (size - 1);
        inp[i++] = b / (size - 1);
      }
  fn(inp, res, count);
  const data = new Float32Array(count * 4);
  for (let j = 0, k = 0; j < count * 3; j += 3, k += 4) {
    data[k] = c01(res[j]);
    data[k + 1] = c01(res[j + 1]);
    data[k + 2] = c01(res[j + 2]);
    data[k + 3] = 1;
  }
  return { size, data };
}

export function compileAdjustment(adj: Adjustment, opts: CompileOptions = {}): CompiledAdjustment {
  const plan = planFor(adj);
  const n = opts.curveSize === 256 ? 256 : 4096;
  const size = Math.round(Math.min(65, Math.max(17, opts.lutSize ?? 33)));
  const out: CompiledAdjustment = {};
  if (plan.curves) {
    const c = plan.curves;
    out.curves = { rgb: curveTable(c.rgb, n), r: curveTable(c.r, n), g: curveTable(c.g, n), b: curveTable(c.b, n) };
  }
  if (opts.postCurves && plan.split) {
    out.lut3d = bakeLut(plan.split.pixel, size);
    const p = plan.split.post;
    out.postCurves = { r: curveTable(p.r, n), g: curveTable(p.g, n), b: curveTable(p.b, n) };
    if (plan.dither) out.approximate = true;
  } else if (plan.pixel) {
    out.lut3d = bakeLut(plan.pixel, size);
    if (plan.approximate || plan.dither) out.approximate = true;
  }
  return out;
}

export function isIdentityAdjustment(adj: Adjustment): boolean {
  if (adj.kind === 'clarity-dehaze') return !adj.params.clarity && !adj.params.dehaze;
  if (adj.kind === 'grain') return !adj.params.amount;
  if (adj.kind === 'relight') return isIdentityRelight(normalizeRelight(adj.params));
  const p = planFor(adj);
  return !p.curves && !p.pixel;
}

// Applies the whole adjustment to one color (floats in 0..255), e.g. for the
// Info panel's after-values. No dithering.
export function evaluateAdjustment(adj: Adjustment, r: number, g: number, b: number): [number, number, number] {
  return evaluatePlan(planFor(adj), r, g, b);
}
// Same, prepared once for many colors.
export function adjustmentEvaluator(adj: Adjustment): (r: number, g: number, b: number) => [number, number, number] {
  const plan = planFor(adj);
  return (r, g, b) => evaluatePlan(plan, r, g, b);
}

function evaluatePlan(plan: Plan, r: number, g: number, b: number): [number, number, number] {
  const c = plan.curves;
  const inp = new Float64Array([compose(c?.rgb, c?.r)(r / 255), compose(c?.rgb, c?.g)(g / 255), compose(c?.rgb, c?.b)(b / 255)]);
  if (plan.pixel) plan.pixel(inp, inp, 1);
  return [c01(inp[0]) * 255, c01(inp[1]) * 255, c01(inp[2]) * 255];
}

// Bakes the whole adjustment (curves included) into a .cube-ready 3D LUT.
export function adjustmentToCubeLut(adj: Adjustment, size = 33, title = ''): CubeLut {
  const plan = planFor(adj);
  return bakeCubeLut(
    (r, g, b, o) => {
      const v = evaluatePlan(plan, r * 255, g * 255, b * 255);
      (o[0] = v[0] / 255), (o[1] = v[1] / 255), (o[2] = v[2] / 255);
    },
    size,
    title,
  );
}

function compose(a: Fn1 | undefined, b: Fn1 | undefined): Fn1 {
  if (!a && !b) return identity;
  if (!b) return (x) => c01(a!(x));
  if (!a) return (x) => c01(b(x));
  return (x) => c01(b(c01(a(x))));
}

// 8x8 ordered dither thresholds centered on zero, in code values. Bayer index
// = bit-reverse(interleave(x xor y, y)); building v from the low bits up does
// the reversal.
const BAYER = (() => {
  const m = new Float32Array(64);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let v = 0;
      for (let bit = 0; bit < 3; bit++) {
        v = (v << 1) | (((x ^ y) >> bit) & 1);
        v = (v << 1) | ((y >> bit) & 1);
      }
      m[y * 8 + x] = (v + 0.5) / 64 - 0.5;
    }
  return m;
})();

const CACHE_BITS = 16,
  CACHE_SHIFT = 32 - CACHE_BITS;
let cache: { keys: Int32Array; vals: Float32Array } | undefined;
function colorCache() {
  cache ??= { keys: new Int32Array(1 << CACHE_BITS), vals: new Float32Array(3 << CACHE_BITS) };
  cache.keys.fill(-1);
  return cache;
}

// Exact reference path. Separable kinds use 8-bit tables computed from the
// float maps; others evaluate the color function on each row. Alpha is kept.
// Spatial kinds (see spatial.ts) take the image's document placement in `ctx`.
export function applyAdjustment(src: RGBA8, adj: Adjustment, selection?: Mask8, progress?: Progress, ctx?: SpatialContext): RGBA8 {
  if (!isSpatialKind(adj.kind)) return applyPlan(src, planFor(adj), selection, progress);
  if (selection && (selection.width !== src.width || selection.height !== src.height))
    throw new Error('Selection size does not match the image.');
  checkCancelled(progress);
  const out = applySpatial(src, adj, ctx)!;
  if (selection) {
    const s = src.data,
      d = out.data,
      m = selection.data;
    for (let p = 0; p < m.length; p++) {
      const k = m[p] / 255;
      if (k >= 1) continue;
      for (let c = 0; c < 3; c++) d[p * 4 + c] = s[p * 4 + c] + (d[p * 4 + c] - s[p * 4 + c]) * k;
    }
  }
  return out;
}

export function applyPlan(src: RGBA8, plan: Plan, selection?: Mask8, progress?: Progress): RGBA8 {
  const out = cloneRGBA8(src);
  if (!plan.curves && !plan.pixel) return out;
  if (selection && (selection.width !== src.width || selection.height !== src.height))
    throw new Error('Selection size does not match the image.');
  const c = plan.curves;
  const fr = compose(c?.rgb, c?.r),
    fg = compose(c?.rgb, c?.g),
    fb = compose(c?.rgb, c?.b);
  const tr = new Float32Array(256),
    tg = new Float32Array(256),
    tb = new Float32Array(256);
  for (let v = 0; v < 256; v++) (tr[v] = fr(v / 255)), (tg[v] = fg(v / 255)), (tb[v] = fb(v / 255));
  if (plan.pixel) applyPixelPath(src, out, plan.pixel, tr, tg, tb, !!plan.dither, selection?.data, progress);
  else applyCurvePath(src, out, tr, tg, tb, selection?.data, progress);
  return out;
}

const ROWS = 32;

function applyCurvePath(
  src: RGBA8,
  out: RGBA8,
  tr: Float32Array,
  tg: Float32Array,
  tb: Float32Array,
  sel: Uint8Array | undefined,
  progress?: Progress,
) {
  const { width, height } = src;
  const s = src.data,
    d = out.data;
  // Uint8ClampedArray rounds and clamps on store.
  const lr = Uint8ClampedArray.from(tr, (v) => v * 255),
    lg = Uint8ClampedArray.from(tg, (v) => v * 255),
    lb = Uint8ClampedArray.from(tb, (v) => v * 255);
  for (let y0 = 0; y0 < height; y0 += ROWS) {
    checkCancelled(progress);
    const end = Math.min(height, y0 + ROWS) * width;
    for (let p = y0 * width, i = p * 4; p < end; p++, i += 4) {
      const m = sel ? sel[p] : 255;
      if (m === 0) continue;
      const R = s[i],
        G = s[i + 1],
        B = s[i + 2];
      d[i] = lr[R];
      d[i + 1] = lg[G];
      d[i + 2] = lb[B];
      if (m !== 255) {
        // Blend the quantized result so partial coverage matches full coverage.
        const k = m / 255;
        d[i] = R + (d[i] - R) * k;
        d[i + 1] = G + (d[i + 1] - G) * k;
        d[i + 2] = B + (d[i + 2] - B) * k;
      }
    }
    progress?.report?.(end / (width * height));
  }
}

function applyPixelPath(
  src: RGBA8,
  out: RGBA8,
  px: PixelFn,
  tr: Float32Array,
  tg: Float32Array,
  tb: Float32Array,
  dither: boolean,
  sel: Uint8Array | undefined,
  progress?: Progress,
) {
  const { width, height } = src;
  const s = src.data,
    d = out.data;
  // Photos repeat colors heavily, so results are memoized in a direct-mapped
  // cache keyed by the 24-bit input color; misses are gathered per row and
  // evaluated in one call. Random-looking content would only pay for cache
  // traffic, so the cache is dropped after the first block if it rarely hits.
  const { keys, vals } = colorCache();
  let useCache = true,
    hits = 0;
  const res = new Float64Array(width * 3),
    inp = new Float64Array(width * 3),
    got = new Float64Array(width * 3);
  const missX = new Int32Array(width),
    missSlot = new Int32Array(width),
    missKey = new Int32Array(width);
  for (let y0 = 0; y0 < height; y0 += ROWS) {
    checkCancelled(progress);
    if (useCache && y0 === ROWS && hits < 0.25 * ROWS * width) useCache = false;
    const y1 = Math.min(height, y0 + ROWS);
    for (let y = y0; y < y1; y++) {
      const row = y * width;
      if (!useCache) {
        // Straight path: gather, evaluate, write.
        let n = 0;
        for (let x = 0; x < width; x++) {
          if (sel && sel[row + x] === 0) continue;
          const i = (row + x) * 4,
            q = n * 3;
          (inp[q] = tr[s[i]]), (inp[q + 1] = tg[s[i + 1]]), (inp[q + 2] = tb[s[i + 2]]);
          missX[n++] = x;
        }
        if (n) px(inp, got, n);
        for (let k = 0; k < n; k++) {
          const x = missX[k],
            i = (row + x) * 4,
            q = k * 3;
          const t = dither ? BAYER[((y & 7) << 3) | (x & 7)] : 0;
          d[i] = got[q] * 255 + t;
          d[i + 1] = got[q + 1] * 255 + t;
          d[i + 2] = got[q + 2] * 255 + t;
          const m = sel ? sel[row + x] : 255;
          if (m !== 255) {
            const f = m / 255;
            d[i] = s[i] + (d[i] - s[i]) * f;
            d[i + 1] = s[i + 1] + (d[i + 1] - s[i + 1]) * f;
            d[i + 2] = s[i + 2] + (d[i + 2] - s[i + 2]) * f;
          }
        }
        continue;
      }
      let misses = 0;
      for (let x = 0; x < width; x++) {
        if (sel && sel[row + x] === 0) continue;
        const i = (row + x) * 4;
        const R = s[i],
          G = s[i + 1],
          B = s[i + 2];
        const key = (R << 16) | (G << 8) | B,
          slot = Math.imul(key, 0x9e3779b1) >>> CACHE_SHIFT;
        if (keys[slot] === key) {
          hits++;
          const j = slot * 3;
          (res[x * 3] = vals[j]), (res[x * 3 + 1] = vals[j + 1]), (res[x * 3 + 2] = vals[j + 2]);
          continue;
        }
        // The key is stored with its value after evaluation, so a repeat
        // later in this row cannot read a stale slot.
        missSlot[misses] = slot;
        missKey[misses] = key;
        const q = misses * 3;
        (inp[q] = tr[R]), (inp[q + 1] = tg[G]), (inp[q + 2] = tb[B]);
        missX[misses++] = x;
      }
      if (misses) {
        px(inp, got, misses);
        for (let k = 0; k < misses; k++) {
          const q = k * 3,
            x3 = missX[k] * 3;
          const r = got[q] * 255,
            g = got[q + 1] * 255,
            b = got[q + 2] * 255;
          (res[x3] = r), (res[x3 + 1] = g), (res[x3 + 2] = b);
          keys[missSlot[k]] = missKey[k];
          const j = missSlot[k] * 3;
          (vals[j] = r), (vals[j + 1] = g), (vals[j + 2] = b);
        }
      }
      for (let x = 0; x < width; x++) {
        const m = sel ? sel[row + x] : 255;
        if (m === 0) continue;
        const i = (row + x) * 4,
          x3 = x * 3;
        const t = dither ? BAYER[((y & 7) << 3) | (x & 7)] : 0;
        d[i] = res[x3] + t;
        d[i + 1] = res[x3 + 1] + t;
        d[i + 2] = res[x3 + 2] + t;
        if (m !== 255) {
          const k = m / 255;
          d[i] = s[i] + (d[i] - s[i]) * k;
          d[i + 1] = s[i + 1] + (d[i + 1] - s[i + 1]) * k;
          d[i + 2] = s[i + 2] + (d[i + 2] - s[i + 2]) * k;
        }
      }
    }
    progress?.report?.(y1 / height);
  }
}

function sampleTable(t: Float32Array, x: number): number {
  const n = t.length - 1;
  const p = (x <= 0 ? 0 : x >= 1 ? 1 : x) * n;
  const i = p >= n ? n - 1 : p | 0;
  return t[i] + (t[i + 1] - t[i]) * (p - i);
}

// CPU emulation of the GPU path: curves, then 3D LUT, then optional post curves.
export function applyCompiled(src: RGBA8, c: CompiledAdjustment): RGBA8 {
  const out = cloneRGBA8(src);
  const s = src.data,
    d = out.data;
  const tr = new Float32Array(256),
    tg = new Float32Array(256),
    tb = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    if (c.curves) {
      const m = sampleTable(c.curves.rgb, x);
      tr[v] = sampleTable(c.curves.r, m);
      tg[v] = sampleTable(c.curves.g, m);
      tb[v] = sampleTable(c.curves.b, m);
    } else tr[v] = tg[v] = tb[v] = x;
  }
  const lut = c.lut3d,
    post = c.postCurves;
  if (!lut) {
    for (let i = 0; i < s.length; i += 4) {
      d[i] = tr[s[i]] * 255;
      d[i + 1] = tg[s[i + 1]] * 255;
      d[i + 2] = tb[s[i + 2]] * 255;
    }
    return out;
  }
  const L = lut.data,
    n = lut.size,
    n1 = n - 1,
    sg = n * 4,
    sb = n * n * 4;
  for (let i = 0; i < s.length; i += 4) {
    const pr = tr[s[i]] * n1,
      pg = tg[s[i + 1]] * n1,
      pb = tb[s[i + 2]] * n1;
    const r0 = pr >= n1 ? n1 - 1 : pr | 0,
      g0 = pg >= n1 ? n1 - 1 : pg | 0,
      b0 = pb >= n1 ? n1 - 1 : pb | 0;
    const fr = pr - r0,
      fg = pg - g0,
      fb = pb - b0;
    const base = r0 * 4 + g0 * sg + b0 * sb;
    for (let k = 0; k < 3; k++) {
      const j = base + k;
      const c00 = L[j] + (L[j + 4] - L[j]) * fr;
      const c10 = L[j + sg] + (L[j + sg + 4] - L[j + sg]) * fr;
      const c01v = L[j + sb] + (L[j + sb + 4] - L[j + sb]) * fr;
      const c11 = L[j + sb + sg] + (L[j + sb + sg + 4] - L[j + sb + sg]) * fr;
      const c0 = c00 + (c10 - c00) * fg,
        c1 = c01v + (c11 - c01v) * fg;
      let v = c0 + (c1 - c0) * fb;
      if (post) v = sampleTable(k === 0 ? post.r : k === 1 ? post.g : post.b, v);
      d[i + k] = v * 255;
    }
  }
  return out;
}
