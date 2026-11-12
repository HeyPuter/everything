// Sharpen menu: unsharp masking variants. Blurs are alpha-weighted so the
// straight color they compare against is never darkened by transparency, and
// alpha is left unchanged so sharpening does not ring the layer's edges.
import type { OperationContext, ParamValues, Progress, RGBA8 } from '../types';
import { aperture, apertureConvolve, motionBlurPlane } from './blur';
import {
  clamp,
  defineOp,
  fillTransparent,
  filterChannels,
  gaussianPlane,
  lumaPlane,
  newImage,
  num,
  px,
  separablePlane,
  str,
  sub,
  type PlaneFilter,
} from './common';

// out = c + amount * (c - blur(c)) wherever |c - blur(c)| exceeds `threshold`.
export function unsharp(src: RGBA8, blur: PlaneFilter, amount: number, threshold: number, progress?: Progress): RGBA8 {
  const d = src.data, out = newImage(src), o = out.data, n = src.width * src.height;
  for (let j = 3; j < o.length; j += 4) o[j] = d[j];
  if (amount === 0) {
    o.set(d);
    return out;
  }
  filterChannels(
    src,
    blur,
    (c, b) => {
      if (c === 3) return;
      for (let i = 0, j = c; i < n; i++, j += 4) {
        const v = d[j], diff = v - b[i];
        o[j] = threshold > 0 && Math.abs(diff) <= threshold ? v : v + amount * diff;
      }
    },
    progress,
  );
  return out;
}

const gauss = (sigma: number): PlaneFilter => (p, t, w, h, pr) => gaussianPlane(p, t, w, h, sigma, pr);
const K121 = new Float32Array([0.25, 0.5, 0.25]);
const k121: PlaneFilter = (p, t, w, h, pr) => separablePlane(p, t, w, h, K121, K121, pr);

export const unsharpMask = defineOp({
  id: 'unsharp-mask',
  label: 'Unsharp Mask',
  category: 'Sharpen',
  support: (p, ctx) => 3 * px(ctx, num(p, 'radius')) + 3,
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: 0, max: 500, step: 1, default: 100, unit: '%' },
    { key: 'radius', label: 'Radius', type: 'number', min: 0.1, max: 1000, step: 0.1, default: 1, unit: 'px' },
    { key: 'threshold', label: 'Threshold', type: 'number', min: 0, max: 255, step: 1, default: 0, unit: 'levels' },
  ],
  run: (src, p, ctx, progress) =>
    unsharp(src, gauss(px(ctx, num(p, 'radius'))), num(p, 'amount') / 100, num(p, 'threshold'), progress),
});

export const sharpen = defineOp({
  id: 'sharpen',
  label: 'Sharpen',
  category: 'Sharpen',
  support: () => 1,
  params: [],
  immediate: true,
  run: (src, _p, _ctx, progress) => unsharp(src, k121, 0.6, 0, progress),
});

export const sharpenMore = defineOp({
  id: 'sharpen-more',
  label: 'Sharpen More',
  category: 'Sharpen',
  support: () => 1,
  params: [],
  immediate: true,
  run: (src, _p, _ctx, progress) => unsharp(src, k121, 1.6, 0, progress),
});

// Only differences above a threshold are boosted, so flat areas stay smooth.
export const sharpenEdges = defineOp({
  id: 'sharpen-edges',
  label: 'Sharpen Edges',
  category: 'Sharpen',
  support: (_p, ctx) => 3 * px(ctx, 1) + 3,
  params: [],
  immediate: true,
  run: (src, _p, ctx, progress) => unsharp(src, gauss(px(ctx, 1)), 1, 6, progress),
});

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

const sharpenReach = (p: ParamValues, ctx: OperationContext) => 3 * px(ctx, num(p, 'radius')) + 4;

// Sharpens luminance only (no color fringes), with a choice of blur model to
// undo, a soft noise threshold on the detail and tonal fades.
export const advancedSharpen = defineOp({
  id: 'advanced-sharpen',
  label: 'Advanced Sharpen',
  category: 'Sharpen',
  support: sharpenReach,
  fillReach: sharpenReach,
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: 0, max: 500, step: 1, default: 150, unit: '%' },
    { key: 'radius', label: 'Radius', type: 'number', min: 0.1, max: 64, step: 0.1, default: 1, unit: 'px' },
    { key: 'noise', label: 'Reduce Noise', type: 'number', min: 0, max: 100, step: 1, default: 10, unit: '%' },
    {
      key: 'remove',
      label: 'Remove',
      type: 'select',
      options: [
        { value: 'gaussian', label: 'Gaussian Blur' },
        { value: 'lens', label: 'Lens Blur' },
        { value: 'motion', label: 'Motion Blur' },
      ],
      default: 'lens',
    },
    { key: 'angle', label: 'Motion Angle', type: 'number', min: -180, max: 180, step: 1, default: 0, unit: '°' },
    { key: 'shadowFade', label: 'Shadows Fade', type: 'number', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    { key: 'highlightFade', label: 'Highlights Fade', type: 'number', min: 0, max: 100, step: 1, default: 0, unit: '%' },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h, data: d } = src;
    const n = w * h, amount = num(p, 'amount') / 100;
    const out = newImage(src), o = out.data;
    o.set(d);
    if (amount === 0) return out;
    const r = px(ctx, num(p, 'radius'));
    const L = lumaPlane(fillTransparent(src, sharpenReach(p, ctx)));
    const B = Float32Array.from(L), tmp = new Float32Array(n);
    const remove = str(p, 'remove');
    let blurred: Float32Array;
    if (remove === 'gaussian') blurred = gaussianPlane(B, tmp, w, h, r, sub(progress, 0, 0.8));
    else if (remove === 'motion') blurred = motionBlurPlane(B, tmp, w, h, num(p, 'angle'), 2 * r + 1, sub(progress, 0, 0.8));
    else {
      apertureConvolve(B, tmp, w, h, aperture(Math.max(1, r), 0, 1, 0), sub(progress, 0, 0.8));
      blurred = tmp;
    }
    const t = (num(p, 'noise') / 100) * 6;
    const sf = num(p, 'shadowFade') / 100, hf = num(p, 'highlightFade') / 100;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const l = L[i];
      let det = l - blurred[i];
      // Soft threshold: small, noise-like detail is attenuated rather than boosted.
      det = det > t ? det - t : det < -t ? det + t : 0;
      const lt = l / 255;
      const gain = amount * (1 - sf * (1 - smooth01(lt / 0.35))) * (1 - hf * smooth01((lt - 0.65) / 0.35));
      const add = det * gain;
      o[j] = clamp(d[j] + add, 0, 255);
      o[j + 1] = clamp(d[j + 1] + add, 0, 255);
      o[j + 2] = clamp(d[j + 2] + add, 0, 255);
    }
    return out;
  },
});
