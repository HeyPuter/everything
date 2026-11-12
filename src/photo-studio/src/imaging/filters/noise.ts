// Noise menu.
import {
  bilateralPlane,
  bool,
  channelPlane,
  clamp,
  copyImage,
  defineOp,
  fillTransparent,
  gaussianPlane,
  mix32,
  isOpaque,
  linearFilterRGBA,
  lumaPlane,
  medianRGBA,
  newImage,
  num,
  px,
  separablePlane,
  str,
  sub,
  tick,
} from './common';
import type { OperationContext, ParamValues } from '../types';

export const addNoise = defineOp({
  id: 'add-noise',
  label: 'Add Noise',
  category: 'Noise',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: 0.1, max: 400, step: 0.1, default: 10, unit: '%' },
    {
      key: 'distribution',
      label: 'Distribution',
      type: 'select',
      options: [{ value: 'uniform', label: 'Uniform' }, { value: 'gaussian', label: 'Gaussian' }],
      default: 'gaussian',
    },
    { key: 'mono', label: 'Monochromatic', type: 'checkbox', default: false },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h, data: d } = src;
    const out = newImage(src), o = out.data;
    const A = (num(p, 'amount') / 100) * 255, gaussian = str(p, 'distribution') === 'gaussian';
    const mono = bool(p, 'mono'), seed = ctx.seed ?? 0;
    // Same variance for both shapes: uniform on [-A/2, A/2] has sigma A/sqrt(12).
    const sigma = A / Math.sqrt(12), inv = 1 / 4294967296;
    const rowSeed = mix32(seed ^ 0x2545f491);
    for (let y = 0; y < h; y++) {
      tick(progress, y, h);
      const ys = mix32(rowSeed + y);
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        // One hash per pixel, then cheap re-mixes for the extra variates.
        const base = mix32(ys ^ Math.imul(x + 1, 0x9e3779b1));
        const u0 = base * inv, u1 = mix32(base + 0x6a09e667) * inv;
        let n0: number, n1: number, n2: number;
        if (gaussian) {
          // Box-Muller: each pair of uniforms yields two independent normals.
          const r0 = sigma * Math.sqrt(-2 * Math.log(1 - u0)), t0 = 2 * Math.PI * u1;
          n0 = r0 * Math.cos(t0);
          n1 = r0 * Math.sin(t0);
          const u2 = mix32(base + 0xbb67ae85) * inv, u3 = mix32(base + 0x3c6ef372) * inv;
          n2 = sigma * Math.sqrt(-2 * Math.log(1 - u2)) * Math.cos(2 * Math.PI * u3);
        } else {
          n0 = (u0 - 0.5) * A;
          n1 = (u1 - 0.5) * A;
          n2 = (mix32(base + 0xbb67ae85) * inv - 0.5) * A;
        }
        if (mono) n1 = n2 = n0;
        o[j] = d[j] + n0;
        o[j + 1] = d[j + 1] + n1;
        o[j + 2] = d[j + 2] + n2;
        o[j + 3] = d[j + 3];
      }
    }
    return out;
  },
});

export const median = defineOp({
  id: 'median',
  label: 'Median',
  category: 'Noise',
  support: (p, ctx) => px(ctx, num(p, 'radius')) + 1,
  params: [{ key: 'radius', label: 'Radius', type: 'number', min: 1, max: 100, step: 1, default: 1, unit: 'px' }],
  run: (src, p, ctx, progress) => medianRGBA(src, Math.round(px(ctx, num(p, 'radius'))), progress),
});

export const dustAndScratches = defineOp({
  id: 'dust-and-scratches',
  label: 'Dust & Scratches',
  category: 'Noise',
  support: (p, ctx) => px(ctx, num(p, 'radius')) + 1,
  params: [
    { key: 'radius', label: 'Radius', type: 'number', min: 1, max: 100, step: 1, default: 1, unit: 'px' },
    { key: 'threshold', label: 'Threshold', type: 'number', min: 0, max: 255, step: 1, default: 0, unit: 'levels' },
  ],
  run(src, p, ctx, progress) {
    const m = medianRGBA(src, Math.round(px(ctx, num(p, 'radius'))), progress);
    const t = num(p, 'threshold'), d = src.data, o = m.data;
    // Only pixels that stand out from their neighborhood are replaced.
    if (t > 0) for (let j = 0; j < o.length; j++) if (Math.abs(o[j] - d[j]) <= t) o[j] = d[j];
    return m;
  },
});

// Blurs everywhere except across edges, which are found from the luminance
// gradient and protected with a soft ramp.
export const despeckle = defineOp({
  id: 'despeckle',
  label: 'Despeckle',
  category: 'Noise',
  // The blur reaches 2 pixels; the gradient reads 1 pixel of a 1-pixel fill.
  support: () => 3,
  params: [],
  immediate: true,
  run(src, _p, _ctx, progress) {
    const { width: w, height: h, data: d } = src;
    const K = new Float32Array([1, 4, 6, 4, 1].map((v) => v / 16));
    const soft = linearFilterRGBA(src, (pl, t, ww, hh, pr) => separablePlane(pl, t, ww, hh, K, K, pr), sub(progress, 0, 0.7));
    // The gradient reads one pixel around each visible one.
    const L = lumaPlane(fillTransparent(src, 1));
    const out = copyImage(src), o = out.data, b = soft.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const xl = x > 0 ? i - 1 : i, xr = x + 1 < w ? i + 1 : i, yu = y > 0 ? i - w : i, yd = y + 1 < h ? i + w : i;
        const g = Math.hypot(L[xr] - L[xl], L[yd] - L[yu]);
        const k = 1 - clamp((g - 12) / 30, 0, 1);
        if (k <= 0) continue;
        const j = i * 4;
        o[j] = d[j] + (b[j] - d[j]) * k;
        o[j + 1] = d[j + 1] + (b[j + 1] - d[j + 1]) * k;
        o[j + 2] = d[j + 2] + (b[j + 2] - d[j + 2]) * k;
      }
    }
    return out;
  },
});

const noiseReach = (p: ParamValues, ctx: OperationContext) => px(ctx, 3 * (0.6 + num(p, 'strength') * 0.25) + 12 * (num(p, 'color') / 100) + 3) + 8;

// Luma is smoothed with an edge-preserving bilateral filter whose range width
// shrinks as "preserve details" grows; chroma (where most sensor noise lives)
// gets a plain blur; optional unsharp masking restores luma detail.
export const reduceNoise = defineOp({
  id: 'reduce-noise',
  label: 'Reduce Noise',
  category: 'Noise',
  support: noiseReach,
  fillReach: noiseReach,
  params: [
    { key: 'strength', label: 'Strength', type: 'number', min: 0, max: 10, step: 1, default: 6 },
    { key: 'preserve', label: 'Preserve Details', type: 'number', min: 0, max: 100, step: 1, default: 60, unit: '%' },
    { key: 'color', label: 'Reduce Color Noise', type: 'number', min: 0, max: 100, step: 1, default: 45, unit: '%' },
    { key: 'sharpen', label: 'Sharpen Details', type: 'number', min: 0, max: 100, step: 1, default: 25, unit: '%' },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h, data: d } = src;
    const n = w * h;
    const strength = num(p, 'strength'), preserve = num(p, 'preserve') / 100;
    const color = num(p, 'color') / 100, sharp = num(p, 'sharpen') / 100;
    const work = fillTransparent(src, noiseReach(p, ctx)), wd = work.data;
    let Y = lumaPlane(work);
    const Cb = new Float32Array(n), Cr = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      Cb[i] = -0.168736 * wd[j] - 0.331264 * wd[j + 1] + 0.5 * wd[j + 2];
      Cr[i] = 0.5 * wd[j] - 0.418688 * wd[j + 1] - 0.081312 * wd[j + 2];
    }
    if (strength > 0) {
      const wt = isOpaque(src) ? null : channelPlane(src, 3);
      const sigmaS = px(ctx, 0.6 + strength * 0.25), sigmaR = 1 + strength * 3 * (1 - 0.8 * preserve);
      Y = bilateralPlane(Y, wt, w, h, sigmaS, sigmaR, sub(progress, 0, 0.6));
    }
    const tmp = new Float32Array(n);
    const cs = px(ctx, color * 4);
    if (cs > 0.3) {
      gaussianPlane(Cb, tmp, w, h, cs, sub(progress, 0.6, 0.75));
      gaussianPlane(Cr, tmp, w, h, cs, sub(progress, 0.75, 0.9));
    }
    if (sharp > 0) {
      const B = gaussianPlane(Float32Array.from(Y), tmp, w, h, px(ctx, 1));
      for (let i = 0; i < n; i++) Y[i] += sharp * 1.5 * (Y[i] - B[i]);
    }
    const out = newImage(src), o = out.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (d[j + 3] === 0) {
        o[j] = d[j]; o[j + 1] = d[j + 1]; o[j + 2] = d[j + 2]; o[j + 3] = 0;
        continue;
      }
      const y = Y[i], cb = Cb[i], cr = Cr[i];
      o[j] = y + 1.402 * cr;
      o[j + 1] = y - 0.344136 * cb - 0.714136 * cr;
      o[j + 2] = y + 1.772 * cb;
      o[j + 3] = d[j + 3];
    }
    return out;
  },
});
