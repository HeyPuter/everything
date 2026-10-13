// Depth Blur: estimate a depth map from a single photo, then blur by depth
// with a lens aperture (bokeh shape and highlight brightness as in Lens Blur),
// plus optional haze, warmth and grain.
//
// The depth estimate combines classic monocular cues at a working size:
// - a ground-plane prior: lower in the frame is usually nearer;
// - aerial perspective from the dark channel prior (He, Sun and Tang,
//   "Single Image Haze Removal Using Dark Channel Prior", CVPR 2009): haze
//   grows with distance, so -ln(transmission) is a relative depth;
// - defocus: areas whose fine detail is weak compared with their coarse
//   contrast are likely out of focus, so away from the focal plane;
// - the main subject (classic segmentation) is placed near.
// The blend is snapped to image edges with guided filtering.
// The blur is layered: a few aperture convolutions of increasing radius are
// mixed per pixel by its blur radius. Each layer is a normalized convolution
// that ignores pixels sharper than the layer, so a sharp subject does not
// bleed a halo into the blurred background.
import { aperture, apertureConvolve } from '../filters/blur';
import { guidedFilterGray } from '../segment/filters';
import { selectSubject } from '../segment/subject';
import type { Mask8, Progress, RGBA8 } from '../types';
import { checkCancelled } from '../types';
import { boxMean, clamp, fitSize, gaussian, hash01, lumaOf, minMax, planeToMask, resizePlane, resizeRGBA, type Plane } from './util';

export type DepthCues = { subject: boolean };

function percentile(p: Plane, q: number, mask?: Plane): number {
  const vals: number[] = [];
  for (let i = 0; i < p.length; i += 2) if (!mask || mask[i] > 0.5) vals.push(p[i]);
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.max(0, Math.floor(q * (vals.length - 1))))];
}
function normalize(p: Plane): Plane {
  const lo = percentile(p, 0.02), hi = percentile(p, 0.98);
  const out = new Float32Array(p.length), k = hi - lo > 1e-6 ? 1 / (hi - lo) : 0;
  for (let i = 0; i < p.length; i++) out[i] = clamp((p[i] - lo) * k, 0, 1);
  return out;
}

/** Relative haze thickness from the dark channel (0 = clear, 1 = thickest). */
export function hazeCue(img: RGBA8): Plane {
  const { width: w, height: h, data: d } = img, n = w * h;
  const dark = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) dark[i] = Math.min(d[j], d[j + 1], d[j + 2]) / 255;
  const r = Math.max(1, Math.round(Math.min(w, h) * 0.02));
  const dc = minMax(dark, w, h, r, false);
  // Atmospheric light: the brightest 0.2 % of the dark channel.
  const t = percentile(dc, 0.998);
  let ar = 0, ag = 0, ab = 0, c = 0;
  for (let i = 0; i < n; i++) if (dc[i] >= t) (ar += d[i * 4]), (ag += d[i * 4 + 1]), (ab += d[i * 4 + 2]), c++;
  const A = [Math.max(1, ar / Math.max(1, c)), Math.max(1, ag / Math.max(1, c)), Math.max(1, ab / Math.max(1, c))];
  const norm = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) norm[i] = Math.min(d[j] / A[0], d[j + 1] / A[1], d[j + 2] / A[2]);
  const dn = minMax(norm, w, h, r, false);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = -Math.log(clamp(1 - 0.95 * dn[i], 0.05, 1));
  return normalize(out);
}

/** Relative defocus (0 = crisp detail, 1 = soft) where the image has contrast. */
export function defocusCue(img: RGBA8): { blur: Plane; confidence: Plane } {
  const { width: w, height: h } = img, n = w * h;
  const Y = lumaOf(img);
  const g1 = gaussian(Y, w, h, 1), g4 = gaussian(Y, w, h, 4);
  const fine = new Float32Array(n), coarse = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    fine[i] = Math.abs(Y[i] - g1[i]);
    coarse[i] = Math.abs(Y[i] - g4[i]);
  }
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const mf = boxMean(fine, w, h, r), mc = boxMean(coarse, w, h, r);
  const blur = new Float32Array(n), confidence = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ratio = mf[i] / (mc[i] + 0.5);
    blur[i] = clamp(1 - ratio * 2.2, 0, 1);
    confidence[i] = clamp((mc[i] - 1.5) / 6, 0, 1);
  }
  return { blur, confidence };
}

/** Depth map in [0, 1] (0 = near, 1 = far) at the size of `img`. */
export function estimateDepth(img: RGBA8, cues: DepthCues = { subject: true }, progress?: Progress): Plane {
  const { width: W, height: H } = img;
  const [w, h] = fitSize(W, H, 288);
  const small = resizeRGBA(img, w, h), n = w * h;
  const haze = hazeCue(small);
  checkCancelled(progress);
  const { blur, confidence } = defocusCue(small);
  // Spread the defocus measure from textured areas into flat ones.
  const Yn = lumaOf(small);
  for (let i = 0; i < n; i++) Yn[i] /= 255;
  const wb = new Float32Array(n);
  for (let i = 0; i < n; i++) wb[i] = blur[i] * confidence[i];
  const rr = Math.max(3, Math.round(Math.min(w, h) * 0.08));
  const num = boxMean(wb, w, h, rr), den = boxMean(confidence, w, h, rr);
  const d = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const vertical = 1 - y / Math.max(1, h - 1);
      const defocus = den[i] > 0.02 ? num[i] / den[i] : 0.5;
      d[i] = 0.5 * vertical + 0.3 * haze[i] + 0.2 * defocus;
    }
  progress?.report?.(0.4);
  let base = normalize(d);
  if (cues.subject) {
    const m = selectSubject(small, { workSize: Math.max(w, h) });
    checkCancelled(progress);
    const s = new Float32Array(n);
    let any = 0;
    for (let i = 0; i < n; i++) any += s[i] = m.data[i] / 255;
    if (any > n * 0.01 && any < n * 0.9) {
      const near = percentile(base, 0.15, s) * 0.6;
      for (let i = 0; i < n; i++) base[i] = base[i] * (1 - s[i]) + near * s[i];
    }
  }
  progress?.report?.(0.7);
  base = guidedFilterGray(Yn, base, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.03)), 2e-3);
  const up = resizePlane(base, w, h, W, H);
  const k = W / w;
  if (k > 1.5) {
    const Y = lumaOf(img);
    for (let i = 0; i < Y.length; i++) Y[i] /= 255;
    const refined = guidedFilterGray(Y, up, W, H, Math.max(1, Math.round(k * 1.5)), 1e-3);
    for (let i = 0; i < up.length; i++) up[i] = clamp(refined[i], 0, 1);
  } else for (let i = 0; i < up.length; i++) up[i] = clamp(up[i], 0, 1);
  progress?.report?.(1);
  return up;
}

/** Depth from a gray image (a channel or a layer): white is near unless inverted. */
export function depthFromImage(img: RGBA8, invert: boolean): Plane {
  const Y = lumaOf(img);
  for (let i = 0; i < Y.length; i++) Y[i] = invert ? Y[i] / 255 : 1 - Y[i] / 255;
  return Y;
}
export const depthMask = (p: Plane, w: number, h: number): Mask8 => planeToMask(p, w, h);

export type DepthBlurOptions = {
  // Focal plane depth and the depth range kept sharp around it, 0..1.
  focal: number;
  range: number;
  // Largest blur radius in document pixels, and pixels of `img` per document pixel.
  blur: number;
  scale: number;
  // Aperture blades (0 = circle) and highlight brightness 0..100.
  blades: number;
  brightness: number;
  // 0..100 each; warmth -100..100.
  haze: number;
  warmth: number;
  grain: number;
  seed?: number;
};

const TO_LIN = new Float32Array(256).map((_, i) => (i / 255) ** 2.2);

/** Blur radius (pixels of `img`) for each pixel's depth. */
export function blurRadius(depth: Plane, o: DepthBlurOptions): Plane {
  const R = o.blur * o.scale, half = o.range / 2, ramp = 0.35;
  const out = new Float32Array(depth.length);
  for (let i = 0; i < depth.length; i++) {
    const dd = Math.max(0, Math.abs(depth[i] - o.focal) - half);
    out[i] = R * Math.min(1, dd / ramp);
  }
  return out;
}

export function depthBlur(img: RGBA8, depth: Plane, o: DepthBlurOptions, progress?: Progress): RGBA8 {
  const { width: w, height: h, data: d } = img, n = w * h;
  const R = o.blur * o.scale;
  const radius = blurRadius(depth, o);
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d) };
  if (R >= 0.6) {
    const K = Math.max(2, Math.min(7, Math.ceil(R / 4) + 1));
    const radii = Array.from({ length: K }, (_, k) => (R * k) / (K - 1));
    const boost = (o.brightness / 100) * 6;
    const lin: Plane[] = [0, 1, 2].map(() => new Float32Array(n));
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = d[j + 3] / 255;
      let g = 1;
      if (boost > 0) {
        const Y = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
        if (Y > 200) g = 1 + boost * ((Y - 200) / 55);
      }
      for (let c = 0; c < 3; c++) lin[c][i] = TO_LIN[d[j + c]] * a * g;
    }
    const alpha = new Float32Array(n);
    for (let i = 0; i < n; i++) alpha[i] = d[i * 4 + 3] / 255;
    // Layer k: normalized aperture convolution over pixels at least about as blurry.
    const layers: Plane[][] = [[lin[0], lin[1], lin[2], alpha]];
    for (let k = 1; k < K; k++) {
      checkCancelled(progress);
      const rk = radii[k];
      const wt = new Float32Array(n);
      for (let i = 0; i < n; i++) wt[i] = clamp((radius[i] - rk * 0.35) / Math.max(0.5, rk * 0.3), 0, 1) * 0.98 + 0.02;
      const conv = (p: Plane) => convolveAperture(p, w, h, rk, o.blades);
      const cw = conv(wt);
      const res: Plane[] = [];
      for (const p of [...lin, alpha]) {
        const pw = new Float32Array(n);
        for (let i = 0; i < n; i++) pw[i] = p[i] * wt[i];
        const cp = conv(pw);
        for (let i = 0; i < n; i++) cp[i] = cp[i] / Math.max(1e-4, cw[i]);
        res.push(cp);
      }
      layers.push(res);
      progress?.report?.((0.9 * k) / (K - 1));
    }
    const o8 = out.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = radius[i];
      const f = clamp((r / R) * (K - 1), 0, K - 1), k0 = Math.floor(f), k1 = Math.min(K - 1, k0 + 1), t = f - k0;
      if (k0 === 0 && t < 1e-3) continue;
      const A = layers[k0][3][i] * (1 - t) + layers[k1][3][i] * t;
      for (let c = 0; c < 3; c++) {
        let v = layers[k0][c][i] * (1 - t) + layers[k1][c][i] * t;
        v = A > 1e-4 ? v / A : 0;
        o8[j + c] = v >= 1 ? 255 : 255 * Math.pow(v, 1 / 2.2);
      }
      o8[j + 3] = A * 255;
    }
  }
  finishLook(out, depth, o);
  progress?.report?.(1);
  return out;
}

function convolveAperture(p: Plane, w: number, h: number, r: number, blades: number): Plane {
  // Large radii run on a reduced copy (the blur hides the difference).
  const f = Math.max(1, Math.floor(r / 10));
  const ap = aperture(r / f, blades, 0.3, 0);
  if (f === 1) {
    const out = new Float32Array(w * h);
    apertureConvolve(p, out, w, h, ap);
    return out;
  }
  const lw = Math.max(1, Math.round(w / f)), lh = Math.max(1, Math.round(h / f));
  const lo = resizePlane(p, w, h, lw, lh), res = new Float32Array(lw * lh);
  apertureConvolve(lo, res, lw, lh, ap);
  return resizePlane(res, lw, lh, w, h);
}

/** Haze (lighter, lower contrast with distance), warmth and grain, in place. */
function finishLook(img: RGBA8, depth: Plane, o: DepthBlurOptions) {
  const { width: w, data: d } = img, n = depth.length;
  const haze = clamp(o.haze / 100, 0, 1), warm = clamp(o.warmth / 100, -1, 1), grain = clamp(o.grain / 100, 0, 1);
  if (!haze && !warm && !grain) return;
  const hazeColor = [222, 228, 236];
  const gr = 1 + 0.14 * warm, gb = 1 - 0.14 * warm, gg = 1 + 0.03 * warm;
  const seed = o.seed ?? 11, s = Math.max(1e-6, o.scale);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let r = d[j], g = d[j + 1], b = d[j + 2];
    if (haze) {
      const t = haze * 0.85 * Math.pow(depth[i], 1.4);
      r += (hazeColor[0] - r) * t;
      g += (hazeColor[1] - g) * t;
      b += (hazeColor[2] - b) * t;
    }
    if (warm) {
      r = 255 * Math.pow(Math.min(1, TO_LIN[clampByte(r)] * gr), 1 / 2.2);
      g = 255 * Math.pow(Math.min(1, TO_LIN[clampByte(g)] * gg), 1 / 2.2);
      b = 255 * Math.pow(Math.min(1, TO_LIN[clampByte(b)] * gb), 1 / 2.2);
    }
    if (grain) {
      // Grain is tied to document positions so previews look like the result.
      const x = i % w, y = (i - x) / w;
      const X = Math.floor(x / s), Y = Math.floor(y / s);
      const nse = (hash01(seed, X, Y) + hash01(seed + 3, X, Y) - 1) * 2;
      const mid = 1 - Math.abs((0.299 * r + 0.587 * g + 0.114 * b) / 127.5 - 1) * 0.6;
      const v = nse * grain * 26 * mid;
      r += v;
      g += v;
      b += v;
    }
    d[j] = r;
    d[j + 1] = g;
    d[j + 2] = b;
  }
}
const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Laplacian energy inside a rectangle (a sharpness measure for tests). */
export function sharpness(img: RGBA8, x0: number, y0: number, x1: number, y1: number): number {
  const { width: w } = img, Y = lumaOf(img);
  let s = 0, c = 0;
  for (let y = Math.max(1, y0); y < Math.min(img.height - 1, y1); y++)
    for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) {
      const i = y * w + x;
      s += Math.abs(4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - w] - Y[i + w]);
      c++;
    }
  return c ? s / c : 0;
}
