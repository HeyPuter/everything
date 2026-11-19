// Develop detail: capture sharpening and noise reduction.
//
// Sharpening is an unsharp mask on luminance (encoded Rec. 709 luma): the
// detail Y - G_sigma * Y is amplified and added to R, G and B equally, so each
// pixel keeps its color differences. Detail limits halos by soft-clipping the
// overshoot beyond the 3 x 3 neighbourhood range (a low margin removes halos,
// a high one lets fine detail through untouched); Masking restricts sharpening
// to edges with a smoothed gradient-magnitude mask so flat areas stay as they
// were.
//
// Luminance noise reduction is a self-guided filter (He, Sun, Tang 2010): in
// every window the output is a linear function of the input whose slope
// a = var / (var + eps) is ~1 across real edges (variance well above eps) and
// ~0 in flat noisy areas, which then get the window mean. It costs a few box
// blurs, O(N) for any radius. Contrast puts back some of the mid-scale local
// contrast that smoothing flattens (an unsharp mask on the smoothed result, so
// the noise does not come back).
//
// Color noise reduction runs a joint guided filter on the chroma planes
// (Cb, Cr), guided by luminance, at reduced resolution so large radii stay
// cheap; color edges that follow luminance edges stay sharp, and pixels whose
// chroma differs from the smoothed chroma by more than a Detail-dependent
// threshold (real color edges rather than noise) keep their own color. The
// coefficients are upsampled and applied at full resolution.
//
// Every average is alpha weighted, so transparent pixels never leak into
// visible ones; alpha itself is never changed.
import type { Mask8, ParamValues, Progress, RGBA8 } from '../../types';
import { checkCancelled, mask8 } from '../../types';
import { num } from '../sampling';

const KR = 0.2126,
  KG = 0.7152,
  KB = 0.0722;
// Rec. 709 color difference scales: Cb = (B - Y) / CB, Cr = (R - Y) / CR.
const CB = 2 * (1 - KB),
  CR = 2 * (1 - KR);

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function detailActive(p: ParamValues): { noise: boolean; sharpen: boolean } {
  return {
    noise: num(p, 'noiseReduction', 0) > 0 || num(p, 'colorNoise', 0) > 0,
    sharpen: num(p, 'sharpenAmount', 0) > 0,
  };
}

// ---------------------------------------------------------------------------
// Plane helpers (also used by the optics and geometry passes).

export function hasTransparency(img: RGBA8): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** Encoded luma 0..255 of every pixel. */
export function lumaPlane(img: RGBA8): Float32Array {
  const d = img.data,
    n = img.width * img.height,
    Y = new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) Y[i] = KR * d[o] + KG * d[o + 1] + KB * d[o + 2];
  return Y;
}

/** Alpha as 0..1 weights. */
export function alphaPlane(img: RGBA8): Float32Array {
  const d = img.data,
    n = img.width * img.height,
    W = new Float32Array(n);
  for (let i = 0; i < n; i++) W[i] = d[i * 4 + 3] / 255;
  return W;
}

/**
 * In-place box blur of a float plane with radius r (window 2r + 1, edges
 * replicated): running sums along each row, then down all columns at once with
 * a small ring of saved rows, so memory is read linearly and the cost does not
 * depend on r. Three passes approximate a Gaussian with sigma^2 = r (r + 1).
 */
export function boxBlur(p: Float32Array, w: number, h: number, r: number): void {
  r = Math.round(r);
  if (r < 1 || w < 1 || h < 1) return;
  const inv = 1 / (2 * r + 1);
  const pad = new Float32Array(w + 2 * r + 1);
  for (let y = 0; y < h; y++) boxRow(p, y * w, w, r, inv, pad);
  // Vertical: ring of the 2r + 2 most recent original rows.
  const R = 2 * r + 2,
    ring = new Float32Array(R * w),
    acc = new Float64Array(w);
  const save = (j: number) => ring.set(p.subarray(j * w, j * w + w), (j % R) * w);
  for (let j = 0; j <= Math.min(r, h - 1); j++) save(j);
  for (let k = -r; k <= r; k++) {
    const o = (clamp(k, 0, h - 1) % R) * w;
    for (let x = 0; x < w; x++) acc[x] += ring[o + x];
  }
  for (let y = 0; y < h; y++) {
    const j = y + r + 1;
    if (j <= h - 1) save(j);
    const row = y * w,
      ao = (Math.min(j, h - 1) % R) * w,
      ro = (Math.max(y - r, 0) % R) * w;
    for (let x = 0; x < w; x++) {
      p[row + x] = acc[x] * inv;
      acc[x] += ring[ao + x] - ring[ro + x];
    }
  }
}
function boxRow(
  p: Float32Array,
  start: number,
  w: number,
  r: number,
  inv: number,
  pad: Float32Array,
) {
  const first = p[start],
    last = p[start + w - 1];
  for (let k = 0; k < r; k++) pad[k] = first;
  for (let x = 0; x < w; x++) pad[r + x] = p[start + x];
  for (let k = 0; k <= r; k++) pad[r + w + k] = last;
  let acc = 0;
  for (let k = 0; k <= 2 * r; k++) acc += pad[k];
  for (let x = 0; x < w; x++) {
    p[start + x] = acc * inv;
    acc += pad[x + 2 * r + 1] - pad[x];
  }
}

function gaussKernel(sigma: number): Float32Array {
  const k = Math.max(1, Math.ceil(3 * sigma)),
    kern = new Float32Array(2 * k + 1);
  let s = 0;
  for (let t = -k; t <= k; t++) s += kern[t + k] = Math.exp((-t * t) / (2 * sigma * sigma));
  for (let t = 0; t < kern.length; t++) kern[t] /= s;
  return kern;
}

// Separable Gaussian blur streamed row by row: rows are blurred horizontally
// into a ring of 2k + 1 rows and combined vertically for each output row, so
// only O(w k) extra memory is used. `onRow` receives the blurred rows of every
// plane for output row y.
function gaussRows(
  planes: Float32Array[],
  w: number,
  h: number,
  sigma: number,
  onRow: (y: number, rows: Float32Array[]) => void,
  progress?: Progress,
) {
  const kern = gaussKernel(sigma),
    T = kern.length,
    k = T >> 1;
  const rings = planes.map(() => new Float32Array(T * w)),
    outs = planes.map(() => new Float32Array(w)),
    pad = new Float32Array(w + 2 * k);
  let ready = -1;
  for (let y = 0; y < h; y++) {
    if ((y & 63) === 0) {
      checkCancelled(progress);
      progress?.report?.(y / h);
    }
    const need = Math.min(h - 1, y + k);
    for (; ready < need;) {
      ready++;
      for (let pi = 0; pi < planes.length; pi++)
        hBlurRow(planes[pi], ready * w, w, kern, pad, rings[pi], (ready % T) * w);
    }
    for (let pi = 0; pi < planes.length; pi++) {
      const out = outs[pi],
        ring = rings[pi];
      out.fill(0);
      for (let t = 0; t < T; t++) {
        const wt = kern[t],
          o = (clamp(y - k + t, 0, h - 1) % T) * w;
        for (let x = 0; x < w; x++) out[x] += wt * ring[o + x];
      }
    }
    onRow(y, outs);
  }
}
function hBlurRow(
  p: Float32Array,
  start: number,
  w: number,
  kern: Float32Array,
  pad: Float32Array,
  dst: Float32Array,
  o: number,
) {
  const T = kern.length,
    k = T >> 1,
    first = p[start],
    last = p[start + w - 1];
  for (let t = 0; t < k; t++) ((pad[t] = first), (pad[k + w + t] = last));
  for (let x = 0; x < w; x++) pad[k + x] = p[start + x];
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let t = 0; t < T; t++) s += kern[t] * pad[x + t];
    dst[o + x] = s;
  }
}

// ---------------------------------------------------------------------------
// Sharpening.

// Edge weight 0..1 per pixel from the gradient magnitude of Y, smoothed so the
// mask follows edges as soft bands; a higher Masking needs stronger edges.
function edgeMask(
  Y: Float32Array,
  w: number,
  h: number,
  masking: number,
  scale: number,
): Float32Array {
  const G = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y,
      yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x,
        xp = x < w - 1 ? x + 1 : x;
      const gx = (Y[y * w + xp] - Y[y * w + xm]) * 0.5,
        gy = (Y[yp * w + x] - Y[ym * w + x]) * 0.5;
      G[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  boxBlur(G, w, h, Math.max(1, Math.round(1.5 * scale)));
  const m = clamp(masking, 0, 100) / 100,
    lo = 20 * m,
    hi = lo * 1.8 + 1;
  for (let i = 0; i < G.length; i++) G[i] = smoothstep(lo, hi, G[i]);
  return G;
}

/** Where sharpening applies (255 full, 0 none) from Masking, for a preview while Alt is held. */
export function sharpenMask(img: RGBA8, p: ParamValues, scale: number): Mask8 {
  const { width: w, height: h } = img;
  const masking = num(p, 'sharpenMasking', 0);
  if (!(masking > 0)) return mask8(w, h, 255);
  const G = edgeMask(lumaPlane(img), w, h, masking, scale > 0 ? scale : 1),
    out = mask8(w, h);
  for (let i = 0; i < G.length; i++) out.data[i] = Math.round(G[i] * 255);
  return out;
}

/** Capture sharpening on the finished image (in place allowed; return the result). */
export function sharpen(img: RGBA8, p: ParamValues, scale: number, progress?: Progress): RGBA8 {
  const amount = clamp(num(p, 'sharpenAmount', 0), 0, 150);
  if (!(amount > 0)) return img;
  const { width: w, height: h, data: d } = img;
  if (!w || !h) return img;
  const s = scale > 0 ? scale : 1;
  const sigma = clamp(num(p, 'sharpenRadius', 1), 0.5, 3) * s,
    detail = clamp(num(p, 'sharpenDetail', 25), 0, 100) / 100,
    masking = num(p, 'sharpenMasking', 0);
  const gain = amount * 0.016,
    margin = 1 + 90 * detail * detail;
  const Y = lumaPlane(img);
  const M = masking > 0 ? edgeMask(Y, w, h, masking, s) : null;
  const alpha = hasTransparency(img);
  let planes = [Y];
  if (alpha) {
    const W = alphaPlane(img),
      WY = new Float32Array(Y.length);
    for (let i = 0; i < Y.length; i++) WY[i] = W[i] * Y[i];
    planes = [WY, W];
  }
  gaussRows(
    planes,
    w,
    h,
    sigma,
    (y, rows) => sharpenRow(d, Y, M, rows[0], alpha ? rows[1] : null, w, h, y, gain, margin),
    progress,
  );
  progress?.report?.(1);
  return img;
}

function sharpenRow(
  d: Uint8ClampedArray,
  Y: Float32Array,
  M: Float32Array | null,
  blur: Float32Array,
  wsum: Float32Array | null,
  w: number,
  h: number,
  y: number,
  gain: number,
  margin: number,
) {
  const r0 = (y > 0 ? y - 1 : y) * w,
    r1 = y * w,
    r2 = (y < h - 1 ? y + 1 : y) * w;
  for (let x = 0; x < w; x++) {
    const i = r1 + x,
      o = i * 4;
    if (d[o + 3] === 0) continue;
    const yv = Y[i];
    const b = wsum ? blur[x] / Math.max(wsum[x], 1e-6) : blur[x];
    let v = yv + gain * (yv - b) * (M ? M[i] : 1);
    const xm = x > 0 ? x - 1 : x,
      xp = x < w - 1 ? x + 1 : x;
    let lo = yv,
      hi = yv,
      t: number;
    // 3 x 3 neighbourhood range; overshoot beyond it is what reads as a halo.
    t = Y[r0 + xm];
    if (t < lo) lo = t;
    else if (t > hi) hi = t;
    t = Y[r0 + x];
    if (t < lo) lo = t;
    else if (t > hi) hi = t;
    t = Y[r0 + xp];
    if (t < lo) lo = t;
    else if (t > hi) hi = t;
    t = Y[r1 + xm];
    if (t < lo) lo = t;
    else if (t > hi) hi = t;
    t = Y[r1 + xp];
    if (t < lo) lo = t;
    else if (t > hi) hi = t;
    t = Y[r2 + xm];
    if (t < lo) lo = t;
    else if (t > hi) hi = t;
    t = Y[r2 + x];
    if (t < lo) lo = t;
    else if (t > hi) hi = t;
    t = Y[r2 + xp];
    if (t < lo) lo = t;
    else if (t > hi) hi = t;
    if (v > hi) v = hi + margin * Math.tanh((v - hi) / margin);
    else if (v < lo) v = lo - margin * Math.tanh((lo - v) / margin);
    const dl = v - yv;
    if (dl === 0) continue;
    d[o] = d[o] + dl;
    d[o + 1] = d[o + 1] + dl;
    d[o + 2] = d[o + 2] + dl;
  }
}

// ---------------------------------------------------------------------------
// Noise reduction.

/** Noise reduction before tone work. Returns a new image (or `src` itself when inactive). */
export function reduceNoise(src: RGBA8, p: ParamValues, scale: number, progress?: Progress): RGBA8 {
  const lum = clamp(num(p, 'noiseReduction', 0), 0, 100),
    col = clamp(num(p, 'colorNoise', 0), 0, 100);
  if (!(lum > 0) && !(col > 0)) return src;
  const { width: w, height: h } = src;
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(src.data) };
  if (!w || !h) return out;
  const s = scale > 0 ? scale : 1;
  const sub = (a: number, b: number): Progress | undefined =>
    progress && {
      cancelled: progress.cancelled,
      report: (f) => progress.report?.(a + (b - a) * f),
    };
  const split = lum > 0 && col > 0 ? 0.6 : 1;
  if (lum > 0)
    luminanceNoise(
      out,
      lum / 100,
      clamp(num(p, 'noiseDetail', 50), 0, 100) / 100,
      clamp(num(p, 'noiseContrast', 0), 0, 100) / 100,
      s,
      sub(0, split),
    );
  if (col > 0)
    colorNoise(
      out,
      col / 100,
      clamp(num(p, 'colorNoiseDetail', 50), 0, 100) / 100,
      clamp(num(p, 'colorNoiseSmoothness', 50), 0, 100) / 100,
      s,
      sub(lum > 0 ? split : 0, 1),
    );
  progress?.report?.(1);
  return out;
}

// Weighted box mean: blurs W * v and divides by the blurred W (passed in Wm).
function weightedMean(
  v: Float32Array,
  W: Float32Array | null,
  Wm: Float32Array | null,
  w: number,
  h: number,
  r: number,
) {
  if (W) for (let i = 0; i < v.length; i++) v[i] *= W[i];
  boxBlur(v, w, h, r);
  if (Wm) for (let i = 0; i < v.length; i++) v[i] = Wm[i] > 1e-6 ? v[i] / Wm[i] : 0;
}

// Self-guided filter of I (unchanged) with optional 0..1 weights; returns q.
function guidedSelf(
  I: Float32Array,
  W: Float32Array | null,
  w: number,
  h: number,
  r: number,
  eps: number,
  progress?: Progress,
): Float32Array {
  const n = I.length,
    P1 = new Float32Array(I),
    P2 = new Float32Array(n);
  for (let i = 0; i < n; i++) P2[i] = I[i] * I[i];
  let Wm: Float32Array | null = null;
  if (W) {
    Wm = new Float32Array(W);
    boxBlur(Wm, w, h, r);
  }
  weightedMean(P1, W, Wm, w, h, r);
  checkCancelled(progress);
  progress?.report?.(0.25);
  weightedMean(P2, W, Wm, w, h, r);
  checkCancelled(progress);
  progress?.report?.(0.45);
  for (let i = 0; i < n; i++) {
    if (Wm && Wm[i] <= 1e-6) {
      // No visible pixel nearby: leave the value alone.
      P1[i] = 1;
      P2[i] = 0;
      continue;
    }
    const m = P1[i],
      v = P2[i] - m * m,
      a = v > 0 ? v / (v + eps) : 0;
    P1[i] = a;
    P2[i] = m - a * m;
  }
  weightedMean(P1, W, Wm, w, h, r);
  checkCancelled(progress);
  progress?.report?.(0.65);
  weightedMean(P2, W, Wm, w, h, r);
  checkCancelled(progress);
  progress?.report?.(0.85);
  for (let i = 0; i < n; i++) P1[i] = Wm && Wm[i] <= 1e-6 ? I[i] : P1[i] * I[i] + P2[i];
  return P1;
}

function luminanceNoise(
  img: RGBA8,
  s: number,
  detail: number,
  contrast: number,
  scale: number,
  progress?: Progress,
) {
  const { width: w, height: h, data: d } = img;
  const Y = lumaPlane(img),
    W = hasTransparency(img) ? alphaPlane(img) : null;
  const r = Math.max(1, Math.round((1 + 3 * s) * scale)),
    t = (4 + 36 * s) * (1.6 - 1.2 * detail),
    q = guidedSelf(Y, W, w, h, r, t * t, progress);
  if (contrast > 0) {
    // Local contrast of the smoothed result at a scale well above the noise.
    const B = new Float32Array(q),
      R = Math.max(2, Math.round(8 * scale));
    let Wm: Float32Array | null = null;
    if (W) {
      Wm = new Float32Array(W);
      boxBlur(Wm, w, h, R);
    }
    weightedMean(B, W, Wm, w, h, R);
    const k = 0.8 * contrast;
    for (let i = 0; i < q.length; i++) q[i] += k * (q[i] - B[i]);
  }
  for (let i = 0, o = 0; i < Y.length; i++, o += 4) {
    if (d[o + 3] === 0) continue;
    const dl = q[i] - Y[i];
    d[o] = d[o] + dl;
    d[o + 1] = d[o + 1] + dl;
    d[o + 2] = d[o + 2] + dl;
  }
  progress?.report?.(1);
}

// Bilinear sampling of a low-resolution plane whose cell (i, j) covers full
// pixels [i f, (i + 1) f) x [j f, (j + 1) f), one full row at a time.
type Up = { lw: number; lh: number; f: number; col: Int32Array; frac: Float32Array };
function upsampler(lw: number, lh: number, f: number, w: number): Up {
  const col = new Int32Array(w),
    frac = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const u = clamp((x + 0.5) / f - 0.5, 0, lw - 1),
      i = Math.min(Math.max(lw - 2, 0), u | 0);
    col[x] = i;
    frac[x] = lw > 1 ? u - i : 0;
  }
  return { lw, lh, f, col, frac };
}
function upRow(u: Up, p: Float32Array, y: number, out: Float32Array) {
  const { lw, lh, col, frac } = u;
  const v = clamp((y + 0.5) / u.f - 0.5, 0, lh - 1),
    j = Math.min(Math.max(lh - 2, 0), v | 0),
    b = lh > 1 ? v - j : 0,
    r0 = j * lw,
    r1 = lh > 1 ? r0 + lw : r0,
    dx = lw > 1 ? 1 : 0;
  for (let x = 0; x < out.length; x++) {
    const i = col[x],
      a = frac[x];
    const top = p[r0 + i] + (p[r0 + i + dx] - p[r0 + i]) * a,
      bot = p[r1 + i] + (p[r1 + i + dx] - p[r1 + i]) * a;
    out[x] = top + (bot - top) * b;
  }
}

function colorNoise(
  img: RGBA8,
  s: number,
  detail: number,
  smooth: number,
  scale: number,
  progress?: Progress,
) {
  const { width: w, height: h, data: d } = img;
  // Blur radius in full-resolution pixels; the guided filter runs on a copy
  // reduced by f so its own radius stays around 3 cells.
  const R = (4 + 28 * smooth) * (0.5 + 0.5 * s) * scale,
    f = Math.max(1, Math.floor(R / 3)),
    lw = Math.ceil(w / f),
    lh = Math.ceil(h / f),
    ln = lw * lh,
    rl = Math.max(1, Math.round(R / f));
  const Wl = new Float32Array(ln),
    cnt = new Float32Array(ln),
    Yl = new Float32Array(ln),
    Bl = new Float32Array(ln),
    Rl = new Float32Array(ln);
  for (let y = 0; y < h; y++) {
    const lrow = ((y / f) | 0) * lw;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4,
        a = d[o + 3] / 255,
        c = lrow + ((x / f) | 0);
      const r = d[o],
        g = d[o + 1],
        b = d[o + 2],
        Y = KR * r + KG * g + KB * b;
      cnt[c]++;
      Wl[c] += a;
      Yl[c] += a * Y;
      Bl[c] += (a * (b - Y)) / CB;
      Rl[c] += (a * (r - Y)) / CR;
    }
  }
  for (let i = 0; i < ln; i++) {
    const inv = Wl[i] > 0 ? 1 / Wl[i] : 0;
    Yl[i] *= inv;
    Bl[i] *= inv;
    Rl[i] *= inv;
    Wl[i] /= cnt[i];
  }
  checkCancelled(progress);
  progress?.report?.(0.3);
  // Joint guided filter, weighted by coverage: C ~ a Y + b in every window.
  const eps = (2 + 40 * (1 - detail)) ** 2;
  const Wm = new Float32Array(Wl);
  boxBlur(Wm, lw, lh, rl);
  const mean = (fn: (i: number) => number) => {
    const v = new Float32Array(ln);
    for (let i = 0; i < ln; i++) v[i] = fn(i);
    weightedMean(v, Wl, Wm, lw, lh, rl);
    return v;
  };
  const mY = mean((i) => Yl[i]),
    mYY = mean((i) => Yl[i] * Yl[i]),
    coef: Float32Array[] = [];
  for (const C of [Bl, Rl]) {
    const mC = mean((i) => C[i]),
      mYC = mean((i) => Yl[i] * C[i]);
    for (let i = 0; i < ln; i++) {
      const v = Math.max(0, mYY[i] - mY[i] * mY[i]),
        a = (mYC[i] - mY[i] * mC[i]) / (v + eps);
      mYC[i] = a;
      mC[i] = mC[i] - a * mY[i];
    }
    weightedMean(mYC, Wl, Wm, lw, lh, rl);
    weightedMean(mC, Wl, Wm, lw, lh, rl);
    coef.push(mYC, mC);
  }
  checkCancelled(progress);
  progress?.report?.(0.5);
  const up = upsampler(lw, lh, f, w),
    rows = coef.map(() => new Float32Array(w));
  const thr = 3 + 30 * (1 - detail),
    mix = Math.min(1, 0.35 + 1.3 * s);
  for (let y = 0; y < h; y++) {
    if ((y & 63) === 0) {
      checkCancelled(progress);
      progress?.report?.(0.5 + (0.5 * y) / h);
    }
    for (let k = 0; k < 4; k++) upRow(up, coef[k], y, rows[k]);
    const [aB, bB, aR, bR] = rows;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (d[o + 3] === 0) continue;
      const r = d[o],
        g = d[o + 1],
        b = d[o + 2],
        Y = KR * r + KG * g + KB * b;
      let cb = (b - Y) / CB,
        cr = (r - Y) / CR;
      const qb = aB[x] * Y + bB[x],
        qr = aR[x] * Y + bR[x];
      // Large departures from the smoothed chroma are color edges: keep them.
      const t = mix * (1 - smoothstep(thr, 2 * thr, Math.hypot(cb - qb, cr - qr)));
      if (t === 0) continue;
      cb += t * (qb - cb);
      cr += t * (qr - cr);
      const nr = Y + CR * cr,
        nb = Y + CB * cb;
      d[o] = nr;
      d[o + 1] = (Y - KR * nr - KB * nb) / KG;
      d[o + 2] = nb;
    }
  }
  progress?.report?.(1);
}
