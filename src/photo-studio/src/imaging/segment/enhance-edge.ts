// Enhance Edge: one-click refinement of a mask's edge from the image it
// masks, with no settings. Three passes, all limited to a band around the
// mask's 50% contour (pixels farther away keep their exact values):
// 1. Color-line matting (`refineEdge`): each band pixel's coverage is its
//    position between the local foreground and background colors, which
//    finds hair and fur and moves a misplaced edge onto the image's edge.
// 2. A color-guided filter (He, Sun and Tang): coverage is made locally a
//    linear function of the RGB color, the closed-form matting model, which
//    recovers strands whose color differs from the background in chroma only,
//    removes speckle left by step 1 and keeps a hard edge one pixel wide.
// 3. Values within 2% of fully hidden or shown are snapped, so the band adds
//    no faint haze around the subject.
// The band width comes from the image size and from how soft the mask's edge
// already is.
import { mask8, type Mask8, type Progress, type RGBA8 } from '../types';
import { guidedFilterColor } from './filters';
import { edtSquared } from './mask-ops';
import { refineEdge } from './refine';

export type EnhanceEdgeOptions = {
  // Band half-width in pixels; chosen automatically when omitted.
  radius?: number;
  // Size of the whole canvas (the image may be a crop of it), for the automatic radius.
  canvas?: { width: number; height: number };
};

/** The automatic band half-width: larger for larger canvases, and at least
 * one and a half times the mask's current soft edge. */
export function autoEdgeRadius(
  mask: Mask8,
  canvas = { width: mask.width, height: mask.height },
): number {
  const { width: w, height: h, data } = mask;
  let boundary = 0,
    soft = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x,
        v = data[i];
      if (v > 0 && v < 255) soft++;
      const a = v >= 128;
      if ((x + 1 < w && data[i + 1] >= 128 !== a) || (y + 1 < h && data[i + w] >= 128 !== a))
        boundary++;
    }
  const base = Math.min(20, Math.max(4, 0.01 * Math.sqrt(canvas.width * canvas.height)));
  const softWidth = boundary ? soft / boundary : 0;
  return Math.round(Math.min(32, Math.max(2, base, 1.5 * softWidth)));
}

/** Weights in [0, 1] of the band within `radius` of the mask's 50% contour
 * (1 inside, fading over the last pixel), or null when the mask has no contour. */
export function contourBand(mask: Mask8, radius: number): Float32Array | null {
  const { width: w, height: h, data } = mask,
    n = w * h;
  const fin = new Uint8Array(n),
    fout = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    fin[i] = data[i] >= 128 ? 1 : 0;
    fout[i] = 1 - fin[i];
  }
  for (let y = 0; y < h && !any; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((x + 1 < w && fin[i + 1] !== fin[i]) || (y + 1 < h && fin[i + w] !== fin[i])) {
        any = true;
        break;
      }
    }
  if (!any) return null;
  const dIn = edtSquared(fout, w, h),
    dOut = edtSquared(fin, w, h);
  const band = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(fin[i] ? dIn[i] : dOut[i]);
    band[i] = Math.min(1, Math.max(0, radius + 1 - d));
  }
  return band;
}

export function enhanceEdge(
  img: RGBA8,
  mask: Mask8,
  opts: EnhanceEdgeOptions = {},
  progress?: Progress,
): { mask: Mask8; radius: number } {
  const { width: w, height: h } = mask,
    n = w * h;
  if (img.width !== w || img.height !== h) throw new Error('Image and mask sizes differ.');
  const radius = Math.max(1, Math.round(opts.radius ?? autoEdgeRadius(mask, opts.canvas)));
  const band = contourBand(mask, radius);
  if (!band) return { mask: { width: w, height: h, data: mask.data.slice() }, radius };
  progress?.report?.(0.05);
  // 1. Color-line matting over the band.
  const matted = refineEdge(img, mask, { radius }).mask;
  progress?.report?.(0.6);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = matted.data[i] / 255;
  // 2. Color-guided filter over the band's bounding box.
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (band[y * w + x] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  const r = Math.max(2, Math.round(radius / 2));
  x0 = Math.max(0, x0 - r);
  y0 = Math.max(0, y0 - r);
  x1 = Math.min(w - 1, x1 + r);
  y1 = Math.min(h - 1, y1 + r);
  const bw = x1 - x0 + 1,
    bh = y1 - y0 + 1;
  const crop: RGBA8 = { width: bw, height: bh, data: new Uint8ClampedArray(bw * bh * 4) };
  const p = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    crop.data.set(
      img.data.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x0 + bw) * 4),
      y * bw * 4,
    );
    p.set(a.subarray((y + y0) * w + x0, (y + y0) * w + x0 + bw), y * bw);
  }
  const q = guidedFilterColor(crop, p, r, 2e-4);
  progress?.report?.(0.9);
  // 3. Write the band back, snapping near-empty and near-full coverage.
  const out = mask8(w, h);
  out.data.set(mask.data);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const i = (y + y0) * w + x + x0,
        t = band[i];
      if (!(t > 0)) continue;
      let v = Math.min(1, Math.max(0, q[y * bw + x]));
      if (v < 0.02) v = 0;
      else if (v > 0.98) v = 1;
      out.data[i] = Math.round(255 * (mask.data[i] / 255 + (v - mask.data[i] / 255) * t));
    }
  progress?.report?.(1);
  return { mask: out, radius };
}
