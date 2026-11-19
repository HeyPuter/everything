// Develop optics: lens corrections, applied before any tone work.
//
// Positions are normalized by the half-diagonal around the image center, so
// every correction is resolution independent.
// - Vignetting: a radial gain in linear light, 2^(amount * t^2) where t rises
//   from 0 at the midpoint radius to 1 at the corners (positive brightens the
//   corners to undo lens falloff, negative darkens them).
// - Distortion: inverse mapping with the radial polynomial r_s = s r (1 + k r^2)
//   (k < 0 undoes barrel distortion, k > 0 undoes pincushion). The scale s is
//   the largest that still maps every frame edge point inside the source, so
//   the corners are never empty; |k| <= 0.3 keeps the map monotonic.
// - Chromatic aberration (lateral): red and blue are radially scaled copies of
//   green. The scales are estimated on a reduced copy by maximizing the
//   normalized correlation of the radial gradients of R (or B) at scaled
//   positions with those of G at strong edges, refined with a parabola, and
//   both channels are resampled in the same pass as the distortion.
// - Defringe: pixels within a radius of a high-contrast edge whose hue is in
//   the purple (or green) band are desaturated toward their luminance.
import type { ParamValues, Progress, RGBA8 } from '../../types';
import { checkCancelled } from '../../types';
import { resize } from '../resample';
import { SRGB_TO_LINEAR, bool, encodeSRGB, num } from '../sampling';
import { boxBlur, lumaPlane } from './detail';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function opticsActive(p: ParamValues): boolean {
  return (
    num(p, 'lensDistortion', 0) !== 0 ||
    num(p, 'lensVignetting', 0) !== 0 ||
    bool(p, 'removeCA', false) ||
    num(p, 'defringePurple', 0) > 0 ||
    num(p, 'defringeGreen', 0) > 0
  );
}

/** Lens corrections, before any tone work. Returns a new image (or `src` when inactive). */
export function correctLens(src: RGBA8, p: ParamValues, scale: number, progress?: Progress): RGBA8 {
  if (!opticsActive(p)) return src;
  const { width: w, height: h } = src;
  let img: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(src.data) };
  if (!w || !h) return img;
  const s = scale > 0 ? scale : 1;
  const dist = clamp(num(p, 'lensDistortion', 0), -100, 100) / 100,
    vig = clamp(num(p, 'lensVignetting', 0), -100, 100) / 100,
    mid = clamp(num(p, 'lensVignettingMidpoint', 50), 0, 100) / 100,
    ca = bool(p, 'removeCA', false),
    purple = clamp(num(p, 'defringePurple', 0), 0, 20),
    green = clamp(num(p, 'defringeGreen', 0), 0, 20);
  checkCancelled(progress);
  if (vig !== 0) vignette(img, vig, mid);
  progress?.report?.(0.1);
  const shift = ca ? estimateCA(src) : { r: 0, b: 0 };
  if (dist !== 0 || shift.r !== 0 || shift.b !== 0)
    img = warpLens(img, -0.3 * dist, 1 + shift.r, 1 + shift.b, progress);
  progress?.report?.(0.8);
  if (purple > 0 || green > 0) defringe(img, purple, green, s);
  progress?.report?.(1);
  return img;
}

// ---------------------------------------------------------------------------
// Vignetting.

function vignette(img: RGBA8, amount: number, mid: number) {
  const { width: w, height: h, data: d } = img;
  const N = 1024,
    lut = new Float32Array(N + 1),
    r0 = 0.9 * mid;
  for (let i = 0; i <= N; i++) {
    const r = Math.sqrt(i / N),
      t = r > r0 ? (r - r0) / (1 - r0) : 0;
    lut[i] = Math.pow(2, amount * t * t);
  }
  const cx = w / 2,
    cy = h / 2,
    k = 4 / (w * w + h * h);
  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx,
        g = lut[Math.min(N, ((dx * dx + dy * dy) * k * N + 0.5) | 0)];
      if (g === 1) continue;
      const o = (y * w + x) * 4;
      d[o] = encodeSRGB(SRGB_TO_LINEAR[d[o]] * g);
      d[o + 1] = encodeSRGB(SRGB_TO_LINEAR[d[o + 1]] * g);
      d[o + 2] = encodeSRGB(SRGB_TO_LINEAR[d[o + 2]] * g);
    }
  }
}

// ---------------------------------------------------------------------------
// Distortion and chromatic aberration resampling.

let tapAlpha = 0;
// Bilinear sample of channel ch at continuous (x, y) with replicated edges and
// alpha weights; the summed alpha is left in tapAlpha.
function tap(d: Uint8ClampedArray, w: number, h: number, x: number, y: number, ch: number): number {
  x -= 0.5;
  y -= 0.5;
  const xf = Math.floor(x),
    yf = Math.floor(y),
    fx = x - xf,
    fy = y - yf;
  const xa = xf < 0 ? 0 : xf >= w ? w - 1 : xf,
    xb = xf + 1 < 0 ? 0 : xf + 1 >= w ? w - 1 : xf + 1,
    ya = yf < 0 ? 0 : yf >= h ? h - 1 : yf,
    yb = yf + 1 < 0 ? 0 : yf + 1 >= h ? h - 1 : yf + 1;
  const i00 = (ya * w + xa) * 4,
    i10 = (ya * w + xb) * 4,
    i01 = (yb * w + xa) * 4,
    i11 = (yb * w + xb) * 4;
  const a00 = (1 - fx) * (1 - fy) * d[i00 + 3],
    a10 = fx * (1 - fy) * d[i10 + 3],
    a01 = (1 - fx) * fy * d[i01 + 3],
    a11 = fx * fy * d[i11 + 3],
    a = a00 + a10 + a01 + a11;
  tapAlpha = a;
  if (a <= 1e-6) return 0;
  return (a00 * d[i00 + ch] + a10 * d[i10 + ch] + a01 * d[i01 + ch] + a11 * d[i11 + ch]) / a;
}

function warpLens(src: RGBA8, k: number, sR: number, sB: number, progress?: Progress): RGBA8 {
  const { width: w, height: h, data: sd } = src;
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) },
    od = out.data;
  const cx = w / 2,
    cy = h / 2,
    hd = Math.hypot(w, h) / 2,
    inv2 = 1 / (hd * hd),
    rmin = Math.min(w, h) / (2 * hd);
  // Largest scale that keeps every edge point of the frame inside the source.
  const s = 1 / Math.max(1 + k * rmin * rmin, 1 + k);
  for (let y = 0; y < h; y++) {
    if ((y & 63) === 0) {
      checkCancelled(progress);
      progress?.report?.(0.1 + (0.7 * y) / h);
    }
    const py = y + 0.5 - cy;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - cx,
        f = s * (1 + k * (px * px + py * py) * inv2),
        o = (y * w + x) * 4;
      const g = tap(sd, w, h, cx + px * f, cy + py * f, 1),
        a = tapAlpha;
      od[o + 1] = g;
      od[o + 3] = a;
      if (a <= 1e-6) continue;
      od[o] =
        sR === 1
          ? tap(sd, w, h, cx + px * f, cy + py * f, 0)
          : tap(sd, w, h, cx + px * f * sR, cy + py * f * sR, 0);
      od[o + 2] =
        sB === 1
          ? tap(sd, w, h, cx + px * f, cy + py * f, 2)
          : tap(sd, w, h, cx + px * f * sB, cy + py * f * sB, 2);
    }
  }
  return out;
}

/**
 * Lateral chromatic aberration as radial scales of red and blue relative to
 * green (r = 0.002 means red is magnified by 0.2%). Resolution independent:
 * analyzed on a copy reduced to at most 1000 px on the long side.
 */
export function estimateCA(src: RGBA8): { r: number; b: number } {
  const L = 1000,
    f = Math.min(1, L / Math.max(src.width, src.height));
  const img =
    f < 1 ? resize(src, Math.round(src.width * f), Math.round(src.height * f), 'bilinear') : src;
  const { width: w, height: h, data: d } = img;
  if (w < 16 || h < 16) return { r: 0, b: 0 };
  const n = w * h,
    cx = w / 2,
    cy = h / 2,
    hd = Math.hypot(w, h) / 2;
  // Radial gradient of each channel (gradient projected on the outward direction).
  const ux = new Float32Array(n),
    uy = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx,
        dy = y + 0.5 - cy,
        ir = 1 / (Math.hypot(dx, dy) || 1);
      ux[y * w + x] = dx * ir;
      uy[y * w + x] = dy * ir;
    }
  const radial = (ch: number) => {
    const g = new Float32Array(n),
      row = w * 4;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1, i = y * w + 1, o = i * 4 + ch; x < w - 1; x++, i++, o += 4)
        g[i] = ((d[o + 4] - d[o - 4]) * ux[i] + (d[o + row] - d[o - row]) * uy[i]) * 0.5;
    return g;
  };
  const gG = radial(1);
  // Strong radial edges away from the center (where the shift is negligible).
  let pts: number[] = [];
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (Math.abs(gG[i]) < 8 || d[i * 4 + 3] < 255) continue;
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < 0.04 * hd * hd) continue;
      pts.push(i);
    }
  if (pts.length < 20) return { r: 0, b: 0 };
  const MAXP = 16000;
  if (pts.length > MAXP) {
    const step = pts.length / MAXP;
    pts = Array.from({ length: MAXP }, (_, k) => pts[Math.floor(k * step)]);
  }
  const sample = (g: Float32Array, x: number, y: number) => {
    const xf = Math.floor(x),
      yf = Math.floor(y),
      fx = x - xf,
      fy = y - yf;
    const xa = clamp(xf, 0, w - 1),
      xb = clamp(xf + 1, 0, w - 1),
      ya = clamp(yf, 0, h - 1),
      yb = clamp(yf + 1, 0, h - 1);
    const top = g[ya * w + xa] + (g[ya * w + xb] - g[ya * w + xa]) * fx,
      bot = g[yb * w + xa] + (g[yb * w + xb] - g[yb * w + xa]) * fx;
    return top + (bot - top) * fy;
  };
  let gg = 0;
  for (const i of pts) gg += gG[i] * gG[i];
  const solve = (ch: number) => {
    const gC = radial(ch),
      STEP = 0.0005,
      K = 24;
    const score = (s: number) => {
      let gc = 0,
        cc = 0;
      for (const i of pts) {
        const x = (i % w) + 0.5,
          y = (i / w) | 0;
        const v = sample(gC, cx + (x - cx) * (1 + s) - 0.5, cy + (y + 0.5 - cy) * (1 + s) - 0.5);
        gc += gG[i] * v;
        cc += v * v;
      }
      return cc > 0 ? gc / Math.sqrt(gg * cc) : 0;
    };
    // Coarse pass every 4th step, then every step around the coarse peak.
    const sc = new Float64Array(2 * K + 1).fill(NaN),
      at = (k: number) => (sc[k] === sc[k] ? sc[k] : (sc[k] = score((k - K) * STEP)));
    let best = K;
    for (let k = 0; k <= 2 * K; k += 4) if (at(k) > at(best)) best = k;
    const coarse = best;
    for (let k = Math.max(0, coarse - 3); k <= Math.min(2 * K, coarse + 3); k++)
      if (at(k) > at(best)) best = k;
    if (best > 0) at(best - 1);
    if (best < 2 * K) at(best + 1);
    // A flat or weak correlation means there is nothing reliable to align.
    if (sc[best] < 0.3 || sc[best] - sc[K] < 1e-4) return 0;
    let s = (best - K) * STEP;
    if (best > 0 && best < 2 * K) {
      const a = sc[best - 1],
        b = sc[best],
        c = sc[best + 1],
        den = a - 2 * b + c;
      if (den < 0) s += clamp((0.5 * (a - c)) / den, -0.5, 0.5) * STEP;
    }
    return s;
  };
  return { r: solve(0), b: solve(2) };
}

// ---------------------------------------------------------------------------
// Defringe.

// Raised-cosine membership of hue h (degrees) in a band around c.
function hueBand(h: number, c: number, half: number): number {
  let dh = Math.abs(h - c);
  if (dh > 180) dh = 360 - dh;
  return dh >= half ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * dh) / half);
}

function defringe(img: RGBA8, purple: number, green: number, scale: number) {
  const { width: w, height: h, data: d } = img;
  const n = w * h,
    Y = lumaPlane(img),
    E = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y,
      yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x,
        xp = x < w - 1 ? x + 1 : x;
      const gx = (Y[y * w + xp] - Y[y * w + xm]) * 0.5,
        gy = (Y[yp * w + x] - Y[ym * w + x]) * 0.5;
      E[y * w + x] = smoothstep(10, 40, Math.sqrt(gx * gx + gy * gy));
    }
  }
  // "Near an edge": any edge within the radius (box mean rescaled so a thin
  // edge line anywhere in the window counts fully).
  const near = (amount: number) => {
    if (!(amount > 0)) return null;
    const r = Math.max(1, Math.round((1 + 0.4 * amount) * scale)),
      p = new Float32Array(E);
    boxBlur(p, w, h, r);
    const k = 2 * r + 1;
    for (let i = 0; i < n; i++) p[i] = Math.min(1, p[i] * k);
    return p;
  };
  const Ep = near(purple),
    Eg = near(green);
  const sp = Math.min(1, 0.25 + purple / 8),
    sg = Math.min(1, 0.25 + green / 8);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    if (d[o + 3] === 0) continue;
    const ep = Ep ? Ep[i] : 0,
      eg = Eg ? Eg[i] : 0;
    if (ep === 0 && eg === 0) continue;
    const r = d[o],
      g = d[o + 1],
      b = d[o + 2],
      mx = Math.max(r, g, b),
      mn = Math.min(r, g, b),
      c = mx - mn;
    if (c < 6) continue;
    let hue: number;
    if (mx === r) hue = ((g - b) / c) * 60;
    else if (mx === g) hue = ((b - r) / c + 2) * 60;
    else hue = ((r - g) / c + 4) * 60;
    if (hue < 0) hue += 360;
    const sat = smoothstep(6, 30, c);
    const wgt = sat * Math.max(sp * ep * hueBand(hue, 285, 50), sg * eg * hueBand(hue, 120, 45));
    if (wgt <= 0) continue;
    const yv = Y[i],
      keep = 1 - wgt;
    d[o] = yv + (r - yv) * keep;
    d[o + 1] = yv + (g - yv) * keep;
    d[o + 2] = yv + (b - yv) * keep;
  }
}
