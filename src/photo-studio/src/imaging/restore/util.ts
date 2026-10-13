// Shared helpers for the Portrait & Restore filters: planes, color spaces,
// resampling and mixing. Pure functions on typed arrays (worker and tests).
//
// Global estimates (skin regions, depth, colorization, defect statistics)
// run at a working size relative to the image, never at a fixed pixel scale,
// so a small preview and the full-resolution result agree.
import { SRGB8_TO_LINEAR, linearToSrgbFast } from '../adjust/color-math';
import { boxMean, resizePlane } from '../segment/filters';
import type { Mask8, RGBA8 } from '../types';

export { boxMean, resizePlane };
export type Plane = Float32Array;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Work size whose longer side is at most `max` (never larger than the image). */
export function fitSize(w: number, h: number, max: number): [number, number] {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** Rec. 601 luma of encoded values, 0..255. */
export function lumaOf(img: RGBA8, out = new Float32Array(img.width * img.height)): Plane {
  const d = img.data;
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return out;
}
export function channel(img: RGBA8, c: number, out = new Float32Array(img.width * img.height)): Plane {
  const d = img.data;
  for (let i = 0, j = c; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}

// YCbCr (BT.601, full range): luma plus two color-difference channels around 0.
export function toYCC(img: RGBA8): [Plane, Plane, Plane] {
  const n = img.width * img.height, d = img.data;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return [Y, Cb, Cr];
}
/** Write YCbCr planes back into `out` (alpha copied from `alphaFrom`). */
export function fromYCC(Y: Plane, Cb: Plane, Cr: Plane, alphaFrom: RGBA8, out: RGBA8 = { width: alphaFrom.width, height: alphaFrom.height, data: new Uint8ClampedArray(alphaFrom.data.length) }): RGBA8 {
  const o = out.data, a = alphaFrom.data;
  for (let i = 0, j = 0; i < Y.length; i++, j += 4) {
    const y = Y[i], cb = Cb[i], cr = Cr[i];
    o[j] = y + 1.402 * cr;
    o[j + 1] = y - 0.344136 * cb - 0.714136 * cr;
    o[j + 2] = y + 1.772 * cb;
    o[j + 3] = a[j + 3];
  }
  return out;
}

// CIE L*a*b* (D65) from 8-bit sRGB through a linearization table.
const LAB_E = 216 / 24389, LAB_K = 24389 / 27;
const Xn = 0.95045592705, Zn = 1.08905775076;
const f = (t: number) => (t > LAB_E ? Math.cbrt(t) : (LAB_K * t + 16) / 116);
const fi = (t: number) => (t * t * t > LAB_E ? t * t * t : (116 * t - 16) / LAB_K);
export function rgb8ToLab(r: number, g: number, b: number, out: number[] | Float32Array): void {
  const lr = SRGB8_TO_LINEAR[r | 0], lg = SRGB8_TO_LINEAR[g | 0], lb = SRGB8_TO_LINEAR[b | 0];
  const X = 0.4123908 * lr + 0.3575843 * lg + 0.1804808 * lb;
  const Y = 0.212639 * lr + 0.7151687 * lg + 0.0721923 * lb;
  const Z = 0.0193308 * lr + 0.1191948 * lg + 0.9505322 * lb;
  const fx = f(X / Xn), fy = f(Y), fz = f(Z / Zn);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
}
/** Lab to encoded sRGB 0..255 (clamped). */
export function labToRgb8(L: number, a: number, b: number, out: number[] | Float32Array): void {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = fi(fx) * Xn, Y = L > LAB_K * LAB_E ? fy * fy * fy : L / LAB_K, Z = fi(fz) * Zn;
  out[0] = 255 * linearToSrgbFast(3.2409699 * X - 1.5373832 * Y - 0.4986108 * Z);
  out[1] = 255 * linearToSrgbFast(-0.9692436 * X + 1.8759675 * Y + 0.0415551 * Z);
  out[2] = 255 * linearToSrgbFast(0.0556301 * X - 0.203977 * Y + 1.0569715 * Z);
}

/** Lab to sRGB keeping L*: out-of-gamut colors lose chroma (not lightness). */
export function labToRgb8Fit(L: number, a: number, b: number, out: number[] | Float32Array): void {
  const lin = (l: number, aa: number, bb: number, o: number[]) => {
    const fy = (l + 16) / 116, fx = fy + aa / 500, fz = fy - bb / 200;
    const X = fi(fx) * Xn, Y = l > LAB_K * LAB_E ? fy * fy * fy : l / LAB_K, Z = fi(fz) * Zn;
    o[0] = 3.2409699 * X - 1.5373832 * Y - 0.4986108 * Z;
    o[1] = -0.9692436 * X + 1.8759675 * Y + 0.0415551 * Z;
    o[2] = 0.0556301 * X - 0.203977 * Y + 1.0569715 * Z;
    return o[0] >= -1e-4 && o[1] >= -1e-4 && o[2] >= -1e-4 && o[0] <= 1.0001 && o[1] <= 1.0001 && o[2] <= 1.0001;
  };
  const o = [0, 0, 0];
  if (!lin(L, a, b, o)) {
    let lo = 0, hi = 1;
    for (let k = 0; k < 8; k++) {
      const m = (lo + hi) / 2;
      if (lin(L, a * m, b * m, o)) lo = m;
      else hi = m;
    }
    lin(L, a * lo, b * lo, o);
  }
  out[0] = 255 * linearToSrgbFast(o[0]);
  out[1] = 255 * linearToSrgbFast(o[1]);
  out[2] = 255 * linearToSrgbFast(o[2]);
}

/** Bilinear resize of an RGBA image (premultiplied; for upsampling small results). */
export function resizeRGBA(img: RGBA8, tw: number, th: number): RGBA8 {
  if (img.width === tw && img.height === th) return { width: tw, height: th, data: new Uint8ClampedArray(img.data) };
  if (tw <= img.width && th <= img.height) return areaDown(img, tw, th);
  const { width: w, height: h, data: d } = img;
  const out = new Uint8ClampedArray(tw * th * 4), sx = w / tw, sy = h / th;
  for (let y = 0; y < th; y++) {
    const fy = clamp((y + 0.5) * sy - 0.5, 0, h - 1), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < tw; x++) {
      const fx = clamp((x + 0.5) * sx - 0.5, 0, w - 1), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4, i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      const w00 = (1 - tx) * (1 - ty) * d[i00 + 3], w01 = tx * (1 - ty) * d[i01 + 3], w10 = (1 - tx) * ty * d[i10 + 3], w11 = tx * ty * d[i11 + 3];
      const a = w00 + w01 + w10 + w11, o = (y * tw + x) * 4;
      if (a > 0) for (let c = 0; c < 3; c++) out[o + c] = (d[i00 + c] * w00 + d[i01 + c] * w01 + d[i10 + c] * w10 + d[i11 + c] * w11) / a;
      out[o + 3] = a;
    }
  }
  return { width: tw, height: th, data: out };
}
function areaDown(img: RGBA8, tw: number, th: number): RGBA8 {
  const { width: w, height: h, data: d } = img;
  const acc = new Float64Array(tw * th * 4), cnt = new Float64Array(tw * th);
  for (let y = 0; y < h; y++) {
    const ry = Math.min(th - 1, Math.floor(((y + 0.5) * th) / h)) * tw;
    for (let x = 0; x < w; x++) {
      const c = ry + Math.min(tw - 1, Math.floor(((x + 0.5) * tw) / w)), i = (y * w + x) * 4, a = d[i + 3], o = c * 4;
      acc[o] += d[i] * a;
      acc[o + 1] += d[i + 1] * a;
      acc[o + 2] += d[i + 2] * a;
      acc[o + 3] += a;
      cnt[c]++;
    }
  }
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let c = 0, o = 0; c < cnt.length; c++, o += 4) {
    const a = acc[o + 3];
    if (a > 0) for (let k = 0; k < 3; k++) out[o + k] = acc[o + k] / a;
    out[o + 3] = cnt[c] ? a / cnt[c] : 0;
  }
  return { width: tw, height: th, data: out };
}
/** Bilinear resize of a mask. */
export function resizeMask(m: Mask8, tw: number, th: number): Mask8 {
  if (m.width === tw && m.height === th) return m;
  const p = new Float32Array(m.data.length);
  for (let i = 0; i < p.length; i++) p[i] = m.data[i];
  return planeToMask(resizePlane(p, m.width, m.height, tw, th), tw, th, 1);
}
export function planeToMask(p: Plane, w: number, h: number, scale = 255): Mask8 {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = clamp255(Math.round(p[i] * scale));
  return { width: w, height: h, data: out };
}
export function maskToPlane(m: Mask8): Plane {
  const p = new Float32Array(m.data.length);
  for (let i = 0; i < p.length; i++) p[i] = m.data[i] / 255;
  return p;
}

/** Separable Gaussian blur of a plane (three box passes; any sigma, O(n)). */
export function gaussian(src: Plane, w: number, h: number, sigma: number): Plane {
  if (sigma < 0.3) return new Float32Array(src);
  // Box widths for three passes approximating the Gaussian (Kovesi).
  const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  let cur: Plane = new Float32Array(src);
  for (let k = 0; k < n; k++) cur = boxMean(cur, w, h, ((k < m ? wl : wu) - 1) / 2);
  return cur;
}

/** Mix `after` toward `before` by a coverage mask (0 keeps before), in place on `after`. */
export function mixMask(before: RGBA8, after: RGBA8, m: Mask8 | Plane, scale = m instanceof Float32Array ? 1 : 255): RGBA8 {
  const b = before.data, o = after.data, k = (m as Mask8).data ?? (m as Plane);
  for (let i = 0, j = 0; i < k.length; i++, j += 4) {
    const t = k[i] / scale;
    if (t >= 1) continue;
    if (t <= 0) {
      o[j] = b[j];
      o[j + 1] = b[j + 1];
      o[j + 2] = b[j + 2];
      o[j + 3] = b[j + 3];
      continue;
    }
    o[j] = b[j] + (o[j] - b[j]) * t;
    o[j + 1] = b[j + 1] + (o[j + 1] - b[j + 1]) * t;
    o[j + 2] = b[j + 2] + (o[j + 2] - b[j + 2]) * t;
    o[j + 3] = b[j + 3] + (o[j + 3] - b[j + 3]) * t;
  }
  return after;
}
/** Linear mix of two same-size images (t = 0 gives `a`). */
export function mixImages(a: RGBA8, b: RGBA8, t: number): RGBA8 {
  const out = new Uint8ClampedArray(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = a.data[i] + (b.data[i] - a.data[i]) * t;
  return { width: a.width, height: a.height, data: out };
}
export function copyRGBA(img: RGBA8): RGBA8 {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

// Deterministic PRNG (mulberry32) and a Gaussian sample from it.
export function rng(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Hash of integer coordinates to [0, 1): position-stable noise. */
export function hash01(seed: number, x: number, y: number) {
  let h = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Fill the holes of a plane (where `known` is 0) from its surroundings with a
 * push-pull pyramid: averages of known values propagate down a pyramid and
 * back up, giving a smooth membrane-like fill in O(n). */
export function pushPull(val: Plane, known: Float32Array, w: number, h: number): Plane {
  if (w <= 1 && h <= 1) return new Float32Array(val);
  const W = Math.max(1, Math.ceil(w / 2)), H = Math.max(1, Math.ceil(h / 2));
  const lv = new Float32Array(W * H), lk = new Float32Array(W * H);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = (y >> 1) * W + (x >> 1), k = known[i];
      lv[o] += val[i] * k;
      lk[o] += k;
    }
  for (let i = 0; i < lv.length; i++) {
    if (lk[i] > 0) lv[i] /= lk[i];
    lk[i] = Math.min(1, lk[i]);
  }
  const coarse = lk.some((k) => k < 1) && (W > 1 || H > 1) ? pushPull(lv, lk, W, H) : lv;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = clamp((y + 0.5) / 2 - 0.5, 0, H - 1), y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, k = known[i];
      const fx = clamp((x + 0.5) / 2 - 0.5, 0, W - 1), x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), tx = fx - x0;
      const c = (coarse[y0 * W + x0] * (1 - tx) + coarse[y0 * W + x1] * tx) * (1 - ty) + (coarse[y1 * W + x0] * (1 - tx) + coarse[y1 * W + x1] * tx) * ty;
      out[i] = k >= 1 ? val[i] : val[i] * k + c * (1 - k);
    }
  }
  return out;
}

/** Binary dilation by a square of radius r (separable running max). */
export function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    // Two sweeps: the nearest set pixel to the left and to the right within r.
    let prev = -1e9;
    for (let x = 0; x < w; x++) {
      if (m[y * w + x]) prev = x;
      if (x - prev <= r) tmp[y * w + x] = 1;
    }
    let next = 1e9;
    for (let x = w - 1; x >= 0; x--) {
      if (m[y * w + x]) next = x;
      if (next - x <= r) tmp[y * w + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let prev = -1e9;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) prev = y;
      if (y - prev <= r) out[y * w + x] = 1;
    }
    let next = 1e9;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) next = y;
      if (next - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Connected components (4-neighborhood) of a binary image: labels and sizes. */
export function labelComponents(bin: Uint8Array, w: number, h: number): { labels: Int32Array; sizes: number[]; boxes: number[][] } {
  const labels = new Int32Array(w * h).fill(-1), sizes: number[] = [], boxes: number[][] = [];
  const stack: number[] = [];
  for (let s = 0; s < bin.length; s++) {
    if (!bin[s] || labels[s] >= 0) continue;
    const id = sizes.length;
    let count = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    labels[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!, x = p % w, y = (p - x) / w;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && bin[p - 1] && labels[p - 1] < 0) (labels[p - 1] = id), stack.push(p - 1);
      if (x < w - 1 && bin[p + 1] && labels[p + 1] < 0) (labels[p + 1] = id), stack.push(p + 1);
      if (y > 0 && bin[p - w] && labels[p - w] < 0) (labels[p - w] = id), stack.push(p - w);
      if (y < h - 1 && bin[p + w] && labels[p + w] < 0) (labels[p + w] = id), stack.push(p + w);
    }
    sizes.push(count);
    boxes.push([x0, y0, x1, y1]);
  }
  return { labels, sizes, boxes };
}

/** Mean absolute difference of two images per pixel (0..255), for affected-area masks. */
export function differenceMask(a: RGBA8, b: RGBA8, gain = 6): Mask8 {
  const n = a.width * a.height, out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const d = Math.abs(a.data[j] - b.data[j]) + Math.abs(a.data[j + 1] - b.data[j + 1]) + Math.abs(a.data[j + 2] - b.data[j + 2]) + Math.abs(a.data[j + 3] - b.data[j + 3]);
    out[i] = clamp255((d / 4) * gain);
  }
  return { width: a.width, height: a.height, data: out };
}

/** Minimum or maximum of a float plane over a (2r+1)² square (separable). */
export function minMax(p: Plane, w: number, h: number, r: number, isMax: boolean): Plane {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const pick = isMax ? Math.max : Math.min;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = p[y * w + x];
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, p[y * w + k]);
      tmp[y * w + x] = v;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x];
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]);
      out[y * w + x] = v;
    }
  return out;
}
