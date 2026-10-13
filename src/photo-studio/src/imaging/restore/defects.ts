// Photo Restoration: dust and scratch detection with inpainting, noise
// reduction, faded color and contrast repair, and print-dot (halftone) removal.
//
// Detection follows the classic morphological approach to film and print
// defects: white and black top-hat transforms (the image minus its opening,
// its closing minus the image) respond to features thinner than the
// structuring element, such as dust specks and scratches, but not to larger
// structure. Responses are compared with the local activity of the image so
// textured areas are not taken for defects, and connected candidates are
// kept when they are small (dust) or long and thin (scratches).
// Defects are filled from their surroundings with a push-pull pyramid
// (Gortler et al., "The Lumigraph", 1996) plus matched grain, so the repair
// does not look smoother than the photograph around it.
import { denoise, estimateNoise } from '../filters/restore';
import { minMaxPlane } from '../filters/common';
import type { Mask8, Progress, RGBA8 } from '../types';
import { boxMean, clamp, clamp255, dilate, fromYCC, gaussian, hash01, labelComponents, lumaOf, pushPull, toYCC } from './util';

export type DefectOptions = {
  // 0..100 sensitivity for small specks and for long thin lines.
  dust: number;
  scratches: number;
  // Largest defect width in pixels of the image being processed.
  size: number;
};

/** Map of detected dust and scratches (255 = defect). */
export function detectDefects(img: RGBA8, o: DefectOptions): Mask8 {
  const { width: w, height: h } = img, n = w * h;
  const out = new Uint8Array(n);
  if ((o.dust <= 0 && o.scratches <= 0) || w < 4 || h < 4) return { width: w, height: h, data: out };
  const Yf = lumaOf(img);
  const Y = new Uint8Array(n);
  for (let i = 0; i < n; i++) Y[i] = Yf[i];
  const r = Math.max(1, Math.round(o.size / 2));
  const open = minMaxPlane(minMaxPlane(Y, w, h, r, false, true), w, h, r, true, true);
  const close = minMaxPlane(minMaxPlane(Y, w, h, r, true, true), w, h, r, false, true);
  const hp = new Float32Array(n);
  for (let i = 0; i < n; i++) hp[i] = Math.max(Y[i] - open[i], close[i] - Y[i]);
  // Texture: the typical top-hat response around each pixel.
  const act = boxMean(hp, w, h, Math.max(3, r * 4 + 2));
  const noise = estimateNoise(Yf, w, h);
  const thr = (s: number) => 6 + 2.5 * noise + (1 - s / 100) * 46;
  const tDust = o.dust > 0 ? thr(o.dust) : Infinity, tScratch = o.scratches > 0 ? thr(o.scratches) : Infinity;
  const tMin = Math.min(tDust, tScratch);
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (hp[i] > tMin + 1.6 * act[i]) cand[i] = 1;
  const { labels, sizes, boxes } = labelComponents(cand, w, h);
  // Mean response of each candidate region above its local texture.
  const score = new Float64Array(sizes.length);
  for (let i = 0; i < n; i++) if (labels[i] >= 0) score[labels[i]] += hp[i] - 1.6 * act[i];
  const dustArea = Math.PI * (r + 1) * (r + 1) * 2.5;
  const keep = sizes.map((s, k) => {
    const m = score[k] / s;
    const [x0, y0, x1, y1] = boxes[k];
    const len = Math.max(x1 - x0 + 1, y1 - y0 + 1, Math.hypot(x1 - x0 + 1, y1 - y0 + 1) * 0.7);
    const thick = s / len;
    const dust = s <= dustArea && m > tDust - tMin;
    const scratch = len >= 6 * Math.max(1, thick) && thick <= 2 * r + 1.5 && m > tScratch - tMin;
    return dust || scratch;
  });
  for (let i = 0; i < n; i++) if (labels[i] >= 0 && keep[labels[i]]) out[i] = 1;
  // Grow by a pixel so the soft edge of each defect is covered too.
  const grown = dilate(out, w, h, 1);
  for (let i = 0; i < n; i++) out[i] = grown[i] ? 255 : 0;
  return { width: w, height: h, data: out };
}

/** Fill masked pixels from their surroundings, adding grain like the area around. */
export function inpaint(img: RGBA8, mask: Mask8, seed = 7): RGBA8 {
  const { width: w, height: h, data: d } = img, n = w * h;
  const known = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    known[i] = mask.data[i] >= 128 ? 0 : 1;
    if (!known[i]) any = true;
  }
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d) };
  if (!any) return out;
  const Y = lumaOf(img);
  // Grain level: high-pass standard deviation of the untouched pixels.
  const low = gaussian(Y, w, h, 1.2);
  let s2 = 0, c = 0;
  for (let i = 0; i < n; i += 3) if (known[i]) (s2 += (Y[i] - low[i]) ** 2), c++;
  const grain = c ? Math.min(12, Math.sqrt(s2 / c)) : 0;
  for (let ch = 0; ch < 4; ch++) {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = d[i * 4 + ch];
    const filled = pushPull(v, known, w, h);
    for (let i = 0; i < n; i++) if (!known[i]) out.data[i * 4 + ch] = filled[i];
  }
  if (grain > 0.5)
    for (let i = 0; i < n; i++) {
      if (known[i]) continue;
      const x = i % w, y = (i - x) / w;
      const g = (hash01(seed, x, y) + hash01(seed + 1, x, y) + hash01(seed + 2, x, y) - 1.5) * 2 * grain;
      for (let ch = 0; ch < 3; ch++) out.data[i * 4 + ch] = clamp255(out.data[i * 4 + ch] + g);
    }
  return out;
}

/** Faded color and contrast repair: each channel is stretched between low and
 * high percentiles (which also removes a color cast from uneven fading), and
 * color saturation lost to fading is partly restored. */
export function repairFade(img: RGBA8, amount: number): RGBA8 {
  const { width: w, height: h, data: d } = img, n = w * h;
  const t = clamp(amount / 100, 0, 1);
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d) };
  if (t <= 0) return out;
  const lo = [0, 0, 0], hi = [255, 255, 255];
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    let count = 0;
    for (let i = 0; i < n; i++) if (d[i * 4 + 3] > 0) hist[d[i * 4 + c]]++, count++;
    if (!count) return out;
    const cut = count * 0.004;
    let acc = 0, k = 0;
    for (; k < 255 && acc + hist[k] <= cut; k++) acc += hist[k];
    lo[c] = k;
    acc = 0;
    k = 255;
    for (; k > 0 && acc + hist[k] <= cut; k--) acc += hist[k];
    hi[c] = Math.max(lo[c] + 16, k);
  }
  const lut = [0, 1, 2].map((c) => Uint8ClampedArray.from({ length: 256 }, (_, v) => v + ((255 * (v - lo[c])) / (hi[c] - lo[c]) - v) * t));
  for (let i = 0; i < d.length; i += 4) {
    out.data[i] = lut[0][d[i]];
    out.data[i + 1] = lut[1][d[i + 1]];
    out.data[i + 2] = lut[2][d[i + 2]];
  }
  const [Y, Cb, Cr] = toYCC(out);
  const sat = 1 + 0.35 * t;
  for (let i = 0; i < n; i++) {
    Cb[i] *= sat;
    Cr[i] *= sat;
  }
  return fromYCC(Y, Cb, Cr, img);
}

/** Period in pixels of a regular print screen (halftone dots), or 0 when none is found. */
export function halftonePeriod(img: RGBA8): number {
  const { width: w, height: h } = img;
  if (w < 64 || h < 16) return 0;
  const Y = lumaOf(img), low = gaussian(Y, w, h, 3);
  const maxLag = Math.min(24, Math.floor(w / 4));
  const ac = new Float64Array(maxLag + 1);
  const rows = Math.min(h, 160), step = Math.max(1, Math.floor(h / rows));
  for (let y = 0; y < h; y += step) {
    const o = y * w;
    for (let lag = 0; lag <= maxLag; lag++) {
      let s = 0;
      for (let x = 0; x + lag < w; x += 2) s += (Y[o + x] - low[o + x]) * (Y[o + x + lag] - low[o + x + lag]);
      ac[lag] += s;
    }
  }
  if (ac[0] <= 0) return 0;
  for (let lag = 3; lag < maxLag; lag++) if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1] && ac[lag] > 0.25 * ac[0]) return lag;
  return 0;
}

/** Remove a print screen: low-pass below the screen frequency, then restore
 * some edge contrast with a wide unsharp mask. */
export function removeHalftone(img: RGBA8, strength: number, period = halftonePeriod(img)): RGBA8 {
  const { width: w, height: h, data: d } = img, n = w * h;
  const t = clamp(strength / 100, 0, 1);
  const p = period || 4;
  const sigma = 0.55 * p * (0.6 + 0.4 * t);
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d) };
  if (t <= 0 || sigma < 0.4) return out;
  for (let c = 0; c < 3; c++) {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = d[i * 4 + c];
    const lp = gaussian(v, w, h, sigma);
    const wide = gaussian(lp, w, h, sigma * 3);
    for (let i = 0; i < n; i++) {
      const sharp = lp[i] + (lp[i] - wide[i]) * 0.5;
      out.data[i * 4 + c] = d[i * 4 + c] + (sharp - d[i * 4 + c]) * t;
    }
  }
  return out;
}

export type RestoreOptions = DefectOptions & {
  // 0..100 each.
  denoise: number;
  fade: number;
  halftone: number;
  seed?: number;
};
export type RestoreResult = { image: RGBA8; defects: Mask8 };

/** The whole restoration pass: halftone, defects, noise, then fading. */
export function restorePhoto(img: RGBA8, o: RestoreOptions, progress?: Progress): RestoreResult {
  let cur = img;
  if (o.halftone > 0) cur = removeHalftone(cur, o.halftone);
  progress?.report?.(0.15);
  const defects = detectDefects(cur, o);
  progress?.report?.(0.35);
  cur = inpaint(cur, defects, o.seed ?? 7);
  progress?.report?.(0.45);
  if (o.denoise > 0) cur = denoise(cur, { strength: o.denoise / 100, color: Math.min(1, (o.denoise / 100) * 1.2), detail: 0.35 });
  progress?.report?.(0.85);
  if (o.fade > 0) cur = repairFade(cur, o.fade);
  progress?.report?.(1);
  return { image: cur === img ? { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) } : cur, defects };
}

/** Fraction of a mask's pixels that are set (for tests and summaries). */
export const coverage = (m: Mask8) => m.data.reduce((s, v) => s + (v >= 128 ? 1 : 0), 0) / Math.max(1, m.data.length);
