// Blur menu and the blur-gallery style variable blurs.
import type { Progress, RGBA8 } from '../types';
import {
  bilateralPlane,
  bilateralTaps,
  boxBlurPlane,
  channelPlane,
  clamp,
  copyImage,
  defineOp,
  gaussianPlane,
  isOpaque,
  linearFilterRGBA,
  lumaPlane,
  newImage,
  num,
  point,
  px,
  rangeLut,
  sample,
  separablePlane,
  str,
  sub,
  tick,
  type Plane,
} from './common';

const K121 = new Float32Array([0.25, 0.5, 0.25]);
const K14641 = new Float32Array([1, 4, 6, 4, 1].map((v) => v / 16));

export const gaussianBlur = defineOp({
  id: 'gaussian-blur',
  label: 'Gaussian Blur',
  category: 'Blur',
  support: (p, ctx) => 3 * px(ctx, num(p, 'radius')) + 3,
  params: [{ key: 'radius', label: 'Radius', type: 'number', min: 0.1, max: 1000, step: 0.1, default: 2, unit: 'px' }],
  run(src, p, ctx, progress) {
    const sigma = px(ctx, num(p, 'radius'));
    return linearFilterRGBA(src, (pl, t, w, h, pr) => gaussianPlane(pl, t, w, h, sigma, pr), progress);
  },
});

export const boxBlur = defineOp({
  id: 'box-blur',
  label: 'Box Blur',
  category: 'Blur',
  support: (p, ctx) => px(ctx, num(p, 'radius')) + 1,
  params: [{ key: 'radius', label: 'Radius', type: 'number', min: 1, max: 2000, step: 1, default: 5, unit: 'px' }],
  run(src, p, ctx, progress) {
    const r = Math.round(px(ctx, num(p, 'radius')));
    if (r <= 0) return copyImage(src);
    return linearFilterRGBA(src, (pl, t, w, h, pr) => boxBlurPlane(pl, t, w, h, r, r, pr), progress);
  },
});

export const blur = defineOp({
  id: 'blur',
  label: 'Blur',
  category: 'Blur',
  support: () => 1,
  params: [],
  immediate: true,
  run: (src, _p, _ctx, progress) =>
    linearFilterRGBA(src, (pl, t, w, h, pr) => separablePlane(pl, t, w, h, K121, K121, pr), progress),
});

export const blurMore = defineOp({
  id: 'blur-more',
  label: 'Blur More',
  category: 'Blur',
  support: () => 2,
  params: [],
  immediate: true,
  run: (src, _p, _ctx, progress) =>
    linearFilterRGBA(src, (pl, t, w, h, pr) => separablePlane(pl, t, w, h, K14641, K14641, pr), progress),
});

// dst = (S(p - o) + S(p + o)) / 2 with bilinear taps at a constant offset, so
// the interpolation weights and clamped column indices are computed once.
function tapPair(src: Plane, dst: Plane, w: number, h: number, ox: number, oy: number, progress?: Progress) {
  const ix = Math.floor(ox), fx = ox - ix, iy = Math.floor(oy), fy = oy - iy;
  const jx = Math.floor(-ox), gx = -ox - jx, jy = Math.floor(-oy), gy = -oy - jy;
  const colsA0 = new Int32Array(w), colsA1 = new Int32Array(w), colsB0 = new Int32Array(w), colsB1 = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    colsA0[x] = clamp(x + ix, 0, w - 1); colsA1[x] = clamp(x + ix + 1, 0, w - 1);
    colsB0[x] = clamp(x + jx, 0, w - 1); colsB1[x] = clamp(x + jx + 1, 0, w - 1);
  }
  const a00 = (1 - fx) * (1 - fy) * 0.5, a01 = fx * (1 - fy) * 0.5, a10 = (1 - fx) * fy * 0.5, a11 = fx * fy * 0.5;
  const b00 = (1 - gx) * (1 - gy) * 0.5, b01 = gx * (1 - gy) * 0.5, b10 = (1 - gx) * gy * 0.5, b11 = gx * gy * 0.5;
  for (let y = 0; y < h; y++) {
    tick(progress, y, h);
    const ra0 = clamp(y + iy, 0, h - 1) * w, ra1 = clamp(y + iy + 1, 0, h - 1) * w;
    const rb0 = clamp(y + jy, 0, h - 1) * w, rb1 = clamp(y + jy + 1, 0, h - 1) * w;
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const p0 = colsA0[x], p1 = colsA1[x], q0 = colsB0[x], q1 = colsB1[x];
      dst[o + x] =
        a00 * src[ra0 + p0] + a01 * src[ra0 + p1] + a10 * src[ra1 + p0] + a11 * src[ra1 + p1] +
        b00 * src[rb0 + q0] + b01 * src[rb0 + q1] + b10 * src[rb1 + q0] + b11 * src[rb1 + q1];
    }
  }
}

// A box of length L along a direction is the product of log2(L) symmetric
// two-tap filters with doubling spacing (a comb that the bilinear taps smooth
// into a continuous streak), so cost grows with log(distance), not distance.
export function motionBlurPlane(plane: Plane, tmp: Plane, w: number, h: number, angleDeg: number, length: number, progress?: Progress): Plane {
  if (length < 1) return plane;
  const k = Math.max(1, Math.ceil(Math.log2(length)));
  const d = length / 2 ** k;
  const dx = Math.cos((angleDeg * Math.PI) / 180), dy = -Math.sin((angleDeg * Math.PI) / 180);
  let a = plane, b = tmp;
  for (let j = 0; j < k; j++) {
    const off = d * 2 ** (j - 1);
    tapPair(a, b, w, h, dx * off, dy * off, sub(progress, j / k, (j + 1) / k));
    [a, b] = [b, a];
  }
  return a;
}

export const motionBlur = defineOp({
  id: 'motion-blur',
  label: 'Motion Blur',
  category: 'Blur',
  support: (p, ctx) => px(ctx, num(p, 'distance')) / 2 + 2,
  params: [
    { key: 'angle', label: 'Angle', type: 'number', min: -360, max: 360, step: 1, default: 0, unit: '°' },
    { key: 'distance', label: 'Distance', type: 'number', min: 1, max: 2000, step: 1, default: 10, unit: 'px' },
  ],
  run(src, p, ctx, progress) {
    const angle = num(p, 'angle'), len = px(ctx, num(p, 'distance'));
    return linearFilterRGBA(src, (pl, t, w, h, pr) => motionBlurPlane(pl, t, w, h, angle, len, pr), progress);
  },
});

// Spin and zoom blurs use the same doubling trick: rotations compose by adding
// angles and zooms by multiplying scales, so log2(n) passes of symmetric
// two-tap averages produce an n-sample arc or ray.
function radialPlane(plane: Plane, tmp: Plane, w: number, h: number, spin: boolean, total: number, cx: number, cy: number, passes: number, progress?: Progress): Plane {
  const d = total / 2 ** passes;
  let a = plane, b = tmp;
  for (let j = 0; j < passes; j++) {
    const off = d * 2 ** (j - 1);
    const c = Math.cos(off), s = Math.sin(off), z = Math.exp(off), iz = 1 / z;
    // Both taps are affine maps about the center: p' = M (p - c) + c.
    const A = spin ? [c, -s, s, c] : [z, 0, 0, z], B = spin ? [c, s, -s, c] : [iz, 0, 0, iz];
    affinePair(a, b, w, h, A, B, cx, cy, sub(progress, j / passes, (j + 1) / passes));
    [a, b] = [b, a];
  }
  return a;
}
// dst = average of two bilinear taps at affine positions; coordinates advance
// by constant steps along a row, and interior taps skip the edge clamping.
function affinePair(src: Plane, dst: Plane, w: number, h: number, A: number[], B: number[], cx: number, cy: number, progress?: Progress) {
  const [a0, a1, a2, a3] = A, [b0, b1, b2, b3] = B, xm = w - 1, ym = h - 1;
  for (let y = 0; y < h; y++) {
    tick(progress, y, h);
    const ry = y - cy, rx0 = -cx;
    let ax = cx + a0 * rx0 + a1 * ry, ay = cy + a2 * rx0 + a3 * ry;
    let bx = cx + b0 * rx0 + b1 * ry, by = cy + b2 * rx0 + b3 * ry;
    const o = y * w;
    for (let x = 0; x < w; x++, ax += a0, ay += a2, bx += b0, by += b2) {
      let va: number, vb: number;
      if (ax >= 0 && ay >= 0 && ax < xm && ay < ym) {
        const x0 = ax | 0, y0 = ay | 0, fx = ax - x0, fy = ay - y0, i = y0 * w + x0;
        const t = src[i] + (src[i + 1] - src[i]) * fx, u = src[i + w] + (src[i + w + 1] - src[i + w]) * fx;
        va = t + (u - t) * fy;
      } else va = sample(src, w, h, ax, ay);
      if (bx >= 0 && by >= 0 && bx < xm && by < ym) {
        const x0 = bx | 0, y0 = by | 0, fx = bx - x0, fy = by - y0, i = y0 * w + x0;
        const t = src[i] + (src[i + 1] - src[i]) * fx, u = src[i + w] + (src[i + w + 1] - src[i + w]) * fx;
        vb = t + (u - t) * fy;
      } else vb = sample(src, w, h, bx, by);
      dst[o + x] = (va + vb) * 0.5;
    }
  }
}

export const radialBlur = defineOp({
  id: 'radial-blur',
  label: 'Radial Blur',
  category: 'Blur',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: 1, max: 100, step: 1, default: 10 },
    { key: 'method', label: 'Method', type: 'select', options: [{ value: 'spin', label: 'Spin' }, { value: 'zoom', label: 'Zoom' }], default: 'spin' },
    { key: 'center', label: 'Center', type: 'point', default: { x: 0.5, y: 0.5 } },
    {
      key: 'quality',
      label: 'Quality',
      type: 'select',
      options: [{ value: 'draft', label: 'Draft' }, { value: 'good', label: 'Good' }, { value: 'best', label: 'Best' }],
      default: 'good',
    },
  ],
  run(src, p, _ctx, progress) {
    const { width: w, height: h } = src;
    const amount = num(p, 'amount'), spin = str(p, 'method') === 'spin', c = point(p, 'center');
    const cx = c.x * (w - 1), cy = c.y * (h - 1);
    // Spin: amount in degrees of arc. Zoom: amount/100 of 0.9 in log scale.
    const total = spin ? (amount * Math.PI) / 180 : (amount / 100) * 0.9;
    const rmax = Math.max(Math.hypot(cx, cy), Math.hypot(w - 1 - cx, cy), Math.hypot(cx, h - 1 - cy), Math.hypot(w - 1 - cx, h - 1 - cy), 1);
    const reach = spin ? total * rmax : rmax * 2 * Math.sinh(total / 2);
    const step = { draft: 4, good: 1.5, best: 0.75 }[str(p, 'quality')] ?? 1.5;
    const passes = clamp(Math.ceil(Math.log2(Math.max(1, reach / step))), 1, 16);
    return linearFilterRGBA(src, (pl, t, ww, hh, pr) => radialPlane(pl, t, ww, hh, spin, total, cx, cy, passes, pr), progress);
  },
});

// Per-channel edge-preserving blur with alpha-weighted samples; alpha itself
// is left alone so the shape of a layer does not change.
function bilateralRGBA(src: RGBA8, sigmaS: number, sigmaR: number, progress?: Progress, fine = 1): RGBA8 {
  const { width: w, height: h, data: d } = src;
  const n = w * h, out = newImage(src), o = out.data;
  const wt = isOpaque(src) ? null : channelPlane(src, 3);
  const plane = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    channelPlane(src, c, plane);
    const r = bilateralPlane(plane, wt, w, h, sigmaS, sigmaR, sub(progress, c / 3, (c + 1) / 3), fine);
    for (let i = 0, j = c; i < n; i++, j += 4) o[j] = r[i];
  }
  for (let j = 3; j < o.length; j += 4) o[j] = d[j];
  return out;
}

// Edge-Preserving Blur at small radii: one range weight per tap from the luminance
// difference, shared by all channels (a cross/joint bilateral), which is three
// times cheaper than per-channel weights and never shifts hue at edges.
function lumaBilateral(src: RGBA8, sigmaS: number, sigmaR: number, progress?: Progress): RGBA8 {
  const { width: w, height: h, data: d } = src;
  const { lim, n, TX, TY, TW, TO } = bilateralTaps(sigmaS, w);
  const lut = rangeLut(sigmaR), L = lumaPlane(src);
  const out = newImage(src), o = out.data;
  const pixel = (x: number, y: number, inner: boolean) => {
    const i0 = y * w + x, c = L[i0];
    let r = 0, g = 0, b = 0, norm = 0;
    for (let t = 0; t < n; t++) {
      const idx = inner ? i0 + TO[t] : clamp(y + TY[t], 0, h - 1) * w + clamp(x + TX[t], 0, w - 1);
      const j = idx * 4;
      const k = TW[t] * lut[Math.min(1024, Math.abs(L[idx] - c) * 4) | 0] * d[j + 3];
      r += d[j] * k; g += d[j + 1] * k; b += d[j + 2] * k; norm += k;
    }
    const q = i0 * 4;
    if (norm > 1e-6) { o[q] = r / norm; o[q + 1] = g / norm; o[q + 2] = b / norm; }
    else { o[q] = d[q]; o[q + 1] = d[q + 1]; o[q + 2] = d[q + 2]; }
    o[q + 3] = d[q + 3];
  };
  for (let y = 0; y < h; y++) {
    tick(progress, y, h);
    if (y < lim || y >= h - lim || w <= 2 * lim) {
      for (let x = 0; x < w; x++) pixel(x, y, false);
      continue;
    }
    for (let x = 0; x < lim; x++) pixel(x, y, false);
    for (let x = w - lim; x < w; x++) pixel(x, y, false);
    lumaBilateralSpan(d, L, o, y * w + lim, w - 2 * lim, n, TO, TW, lut);
  }
  return out;
}
function lumaBilateralSpan(d: Uint8ClampedArray, L: Plane, o: Uint8ClampedArray, start: number, count: number, n: number, TO: Int32Array, TW: Float32Array, lut: Float32Array) {
  for (let i0 = start; i0 < start + count; i0++) {
    const c = L[i0];
    let r = 0, g = 0, b = 0, norm = 0;
    for (let t = 0; t < n; t++) {
      const idx = i0 + TO[t], j = idx * 4;
      const k = TW[t] * lut[Math.min(1024, Math.abs(L[idx] - c) * 4) | 0] * d[j + 3];
      r += d[j] * k; g += d[j + 1] * k; b += d[j + 2] * k; norm += k;
    }
    const q = i0 * 4;
    if (norm > 1e-6) { o[q] = r / norm; o[q + 1] = g / norm; o[q + 2] = b / norm; }
    else { o[q] = d[q]; o[q + 1] = d[q + 1]; o[q + 2] = d[q + 2]; }
    o[q + 3] = d[q + 3];
  }
}

export const surfaceBlur = defineOp({
  id: 'surface-blur',
  label: 'Surface Blur',
  category: 'Blur',
  support: (p, ctx) => 3 * px(ctx, num(p, 'radius')) + 8,
  params: [
    { key: 'radius', label: 'Radius', type: 'number', min: 1, max: 100, step: 1, default: 5, unit: 'px' },
    { key: 'threshold', label: 'Threshold', type: 'number', min: 2, max: 255, step: 1, default: 15, unit: 'levels' },
  ],
  run(src, p, ctx, progress) {
    // Gaussian equivalents of a box window and a tent-shaped range weight.
    return bilateralRGBA(src, 0.6 * px(ctx, num(p, 'radius')), num(p, 'threshold'), progress);
  },
});

export const edgePreservingBlur = defineOp({
  id: 'edge-preserving-blur',
  label: 'Edge-Preserving Blur',
  category: 'Blur',
  support: (p, ctx) => 3 * px(ctx, num(p, 'radius')) + 8,
  params: [
    { key: 'radius', label: 'Radius', type: 'number', min: 0.1, max: 100, step: 0.1, default: 3, unit: 'px' },
    { key: 'threshold', label: 'Threshold', type: 'number', min: 0.1, max: 100, step: 0.1, default: 25 },
    {
      key: 'quality',
      label: 'Quality',
      type: 'select',
      options: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }],
      default: 'medium',
    },
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      options: [{ value: 'normal', label: 'Normal' }, { value: 'edge', label: 'Edge Only' }, { value: 'overlay', label: 'Overlay Edge' }],
      default: 'normal',
    },
  ],
  run(src, p, ctx, progress) {
    const t = num(p, 'threshold'), mode = str(p, 'mode');
    const fine = { low: 1, medium: 1.5, high: 2 }[str(p, 'quality')] ?? 1.5;
    // A narrower range weight than Surface Blur approximates the hard
    // "blur only below the threshold" cutoff.
    const sigmaS = 0.6 * px(ctx, num(p, 'radius')), pr = sub(progress, 0, mode === 'normal' ? 1 : 0.8);
    const smooth = sigmaS < 3 ? lumaBilateral(src, Math.max(0.3, sigmaS), t / 2, pr) : bilateralRGBA(src, sigmaS, t / 2, pr, fine);
    if (mode === 'normal') return smooth;
    const { width: w, height: h } = src;
    const L = lumaPlane(smooth), o = smooth.data, d = src.data;
    // Edges are luminance steps above the threshold to a neighbor of the
    // smoothed image. Medium and High quality also compare the diagonal
    // neighbors (per pixel of distance), so a soft diagonal edge is found at
    // the same contrast as a level or upright one.
    const diagonal = str(p, 'quality') !== 'low', k = Math.SQRT1_2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, v = L[i];
        let m = 0;
        if (x + 1 < w) m = Math.max(m, Math.abs(L[i + 1] - v));
        if (y + 1 < h) m = Math.max(m, Math.abs(L[i + w] - v));
        if (x > 0) m = Math.max(m, Math.abs(L[i - 1] - v));
        if (y > 0) m = Math.max(m, Math.abs(L[i - w] - v));
        if (diagonal) {
          if (y + 1 < h && x + 1 < w) m = Math.max(m, Math.abs(L[i + w + 1] - v) * k);
          if (y + 1 < h && x > 0) m = Math.max(m, Math.abs(L[i + w - 1] - v) * k);
          if (y > 0 && x + 1 < w) m = Math.max(m, Math.abs(L[i - w + 1] - v) * k);
          if (y > 0 && x > 0) m = Math.max(m, Math.abs(L[i - w - 1] - v) * k);
        }
        const edge = m > t, j = i * 4;
        if (mode === 'edge') {
          const e = edge ? 255 : 0;
          o[j] = e; o[j + 1] = e; o[j + 2] = e;
        } else if (edge) {
          o[j] = 255; o[j + 1] = 255; o[j + 2] = 255;
        }
        o[j + 3] = d[j + 3];
      }
    }
    return smooth;
  },
});

// ---------------------------------------------------------------------------
// Lens blur: convolution with a polygonal aperture in linear light. Each row
// of the aperture is a horizontal span, evaluated with per-row prefix sums, so
// cost is O(radius) per pixel; very large radii run on a downsampled copy.

type Aperture = { r: number; spans: Int32Array; area: number };
export function aperture(radius: number, blades: number, curvature: number, rotationDeg: number): Aperture {
  const r = Math.max(0, Math.floor(radius));
  const spans = new Int32Array((2 * r + 1) * 2);
  let area = 0;
  const rot = (rotationDeg * Math.PI) / 180, R = radius + 0.5;
  const sector = blades >= 3 ? (2 * Math.PI) / blades : 0;
  const inside = (x: number, y: number) => {
    const rho = Math.hypot(x, y);
    if (rho <= 0.5) return true;
    if (!sector) return rho <= R;
    // Distance to the polygon edge along this direction, blended toward a circle.
    let phi = Math.atan2(y, x) - rot;
    phi = ((phi % sector) + sector) % sector - sector / 2;
    const edge = (R * Math.cos(sector / 2)) / Math.cos(phi);
    return rho <= edge + (R - edge) * curvature;
  };
  for (let dy = -r; dy <= r; dy++) {
    let lo = 1, hi = 0;
    for (let x = -r; x <= r; x++) if (inside(x, dy)) { if (lo > hi) lo = x; hi = x; }
    spans[(dy + r) * 2] = lo;
    spans[(dy + r) * 2 + 1] = hi;
    if (hi >= lo) area += hi - lo + 1;
  }
  return { r, spans, area };
}

export function apertureConvolve(src: Plane, dst: Plane, w: number, h: number, ap: Aperture, progress?: Progress) {
  // Prefix sums per row with a leading zero: P[y][x + 1] = sum src[y][0..x].
  const W = w + 1, P = new Float32Array(W * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) P[y * W + x + 1] = s += src[y * w + x];
  }
  const { r, spans, area } = ap, inv = 1 / area;
  for (let y = 0; y < h; y++) {
    tick(progress, y, h);
    const o = y * w;
    dst.fill(0, o, o + w);
    for (let dy = -r; dy <= r; dy++) {
      const lo = spans[(dy + r) * 2], hi = spans[(dy + r) * 2 + 1];
      if (hi < lo) continue;
      const row = clamp(y + dy, 0, h - 1), base = row * W, first = src[row * w], last = src[row * w + w - 1];
      // Interior: the span lies inside the row.
      const x0 = Math.min(w, Math.max(0, -lo)), x1 = Math.max(x0, Math.min(w, w - 1 - hi + 1));
      for (let x = x0; x < x1; x++) dst[o + x] += P[base + x + hi + 1] - P[base + x + lo];
      for (let x = 0; x < w; x++) {
        if (x === x0) x = x1;
        if (x >= w) break;
        let a = x + lo, b = x + hi, s = 0;
        // Clamp to edge: out-of-range taps repeat the edge pixel.
        if (b < 0) s = (b - a + 1) * first;
        else if (a > w - 1) s = (b - a + 1) * last;
        else {
          if (a < 0) { s += -a * first; a = 0; }
          if (b > w - 1) { s += (b - w + 1) * last; b = w - 1; }
          s += P[base + b + 1] - P[base + a];
        }
        dst[o + x] += s;
      }
    }
    for (let x = 0; x < w; x++) dst[o + x] *= inv;
  }
}

function downsample(src: Plane, w: number, h: number, f: number): [Plane, number, number] {
  const W = Math.ceil(w / f), H = Math.ceil(h / f), out = new Float32Array(W * H);
  for (let Y = 0; Y < H; Y++)
    for (let X = 0; X < W; X++) {
      let s = 0, c = 0;
      for (let y = Y * f; y < Math.min(h, (Y + 1) * f); y++)
        for (let x = X * f; x < Math.min(w, (X + 1) * f); x++) { s += src[y * w + x]; c++; }
      out[Y * W + X] = s / c;
    }
  return [out, W, H];
}
function upsample(src: Plane, W: number, H: number, dst: Plane, w: number, h: number, f: number) {
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) / f - 0.5;
    for (let x = 0; x < w; x++) dst[y * w + x] = sample(src, W, H, (x + 0.5) / f - 0.5, sy);
  }
}

const toLinear = new Float32Array(256).map((_, i) => (i / 255) ** 2.2);

export const lensBlur = defineOp({
  id: 'lens-blur',
  label: 'Lens Blur',
  category: 'Blur',
  support: (p, ctx) => 1.2 * px(ctx, num(p, 'radius')) + 8,
  params: [
    { key: 'radius', label: 'Radius', type: 'number', min: 0, max: 100, step: 1, default: 15, unit: 'px' },
    {
      key: 'shape',
      label: 'Iris Shape',
      type: 'select',
      options: [
        { value: '0', label: 'Circle' },
        { value: '3', label: 'Triangle' },
        { value: '4', label: 'Square' },
        { value: '5', label: 'Pentagon' },
        { value: '6', label: 'Hexagon' },
        { value: '7', label: 'Heptagon' },
        { value: '8', label: 'Octagon' },
      ],
      default: '6',
    },
    { key: 'curvature', label: 'Blade Curvature', type: 'number', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    { key: 'rotation', label: 'Rotation', type: 'number', min: 0, max: 360, step: 1, default: 0, unit: '°' },
    { key: 'brightness', label: 'Highlight Brightness', type: 'number', min: 0, max: 100, step: 1, default: 0 },
    { key: 'threshold', label: 'Highlight Threshold', type: 'number', min: 0, max: 255, step: 1, default: 255 },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h, data: d } = src;
    const radius = px(ctx, num(p, 'radius'));
    if (radius < 0.5) return copyImage(src);
    const n = w * h;
    // Work budget of about 3e8 taps; past that, blur a downsampled copy.
    let f = 1;
    while ((n / (f * f)) * (2 * (radius / f) + 1) > 3e8) f++;
    const ap = aperture(radius / f, Number(str(p, 'shape')), num(p, 'curvature') / 100, num(p, 'rotation'));
    const boost = (num(p, 'brightness') / 100) * 8, thr = num(p, 'threshold');
    // Highlights above the threshold get extra linear energy so they bloom
    // into bright aperture shapes.
    const gain = new Float32Array(n).fill(1);
    if (boost > 0) {
      const L = lumaPlane(src);
      for (let i = 0; i < n; i++) if (L[i] >= thr) gain[i] = 1 + boost * (thr >= 255 ? 1 : clamp((L[i] - thr) / (256 - thr), 0, 1) * 0.75 + 0.25);
    }
    const opaque = isOpaque(src);
    const filt = (pl: Plane, pr?: Progress): Plane => {
      if (f === 1) {
        const outp = new Float32Array(n);
        apertureConvolve(pl, outp, w, h, ap, pr);
        return outp;
      }
      const [lo, W, H] = downsample(pl, w, h, f);
      const res = new Float32Array(W * H);
      apertureConvolve(lo, res, W, H, ap, pr);
      const outp = new Float32Array(n);
      upsample(res, W, H, outp, w, h, f);
      return outp;
    };
    const out = newImage(src), o = out.data;
    let alpha: Plane | null = null;
    if (!opaque) {
      alpha = filt(channelPlane(src, 3), sub(progress, 0, 0.25));
      for (let i = 0; i < n; i++) o[i * 4 + 3] = alpha[i];
    } else for (let i = 0; i < n; i++) o[i * 4 + 3] = 255;
    const plane = new Float32Array(n);
    for (let c = 0; c < 3; c++) {
      for (let i = 0, j = 0; i < n; i++, j += 4) plane[i] = toLinear[d[j + c]] * gain[i] * (opaque ? 1 : d[j + 3] / 255);
      const res = filt(plane, sub(progress, opaque ? c / 3 : 0.25 + c / 4, opaque ? (c + 1) / 3 : 0.25 + (c + 1) / 4));
      for (let i = 0, j = c; i < n; i++, j += 4) {
        let v = res[i];
        if (alpha) {
          const a = alpha[i] / 255;
          if (a < 1e-4) { o[j] = d[j]; continue; }
          v /= a;
        }
        o[j] = v >= 1 ? 255 : 255 * Math.pow(v, 1 / 2.2);
      }
    }
    return out;
  },
});

export const average = defineOp({
  id: 'average',
  label: 'Average',
  category: 'Blur',
  params: [],
  immediate: true,
  run(src, _p, ctx) {
    const d = src.data, m = ctx.selection?.data;
    let r = 0, g = 0, b = 0, a = 0, cov = 0;
    for (let i = 0, j = 0; j < d.length; i++, j += 4) {
      const k = m ? m[i] / 255 : 1;
      if (k === 0) continue;
      const wa = d[j + 3] * k;
      r += d[j] * wa; g += d[j + 1] * wa; b += d[j + 2] * wa; a += wa; cov += k;
    }
    const out = newImage(src), o = out.data;
    if (cov === 0) { o.set(d); return out; }
    const fill = a > 0 ? [r / a, g / a, b / a, a / cov] : [0, 0, 0, 0];
    for (let j = 0; j < o.length; j += 4) { o[j] = fill[0]; o[j + 1] = fill[1]; o[j + 2] = fill[2]; o[j + 3] = fill[3]; }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Variable blur: a few Gaussian levels blended per pixel by the wanted sigma.

export function variableBlur(src: RGBA8, sigma: Float32Array, maxSigma: number, progress?: Progress): RGBA8 {
  const { width: w, height: h } = src;
  const n = w * h;
  if (maxSigma < 0.3) return copyImage(src);
  const levels = [0];
  for (let s = maxSigma; s >= 0.5 && levels.length < 8; s /= 2) levels.splice(1, 0, s);
  const L = levels.length;
  const work = new Float32Array(n), scratch = new Float32Array(n);
  const filter = (pl: Plane, tmp: Plane, _w: number, _h: number, pr?: Progress): Plane => {
    tmp.fill(0);
    for (let k = 0; k < L; k++) {
      work.set(pl);
      const b = levels[k] > 0 ? gaussianPlane(work, scratch, w, h, levels[k], sub(pr, k / L, (k + 1) / L)) : work;
      const lo = k > 0 ? levels[k - 1] : 0, mid = levels[k], hi = k + 1 < L ? levels[k + 1] : mid;
      for (let i = 0; i < n; i++) {
        const s = sigma[i];
        let wt = 0;
        if (s <= mid) wt = k === 0 ? 1 : s <= lo ? 0 : (s - lo) / (mid - lo);
        else wt = k === L - 1 ? 1 : s >= hi ? 0 : (hi - s) / (hi - mid);
        if (wt > 0) tmp[i] += wt * b[i];
      }
    }
    return tmp;
  };
  return linearFilterRGBA(src, filter, progress);
}

const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export const tiltShift = defineOp({
  id: 'tilt-shift',
  label: 'Tilt-Shift',
  category: 'Blur Gallery',
  params: [
    { key: 'center', label: 'Center', type: 'point', default: { x: 0.5, y: 0.5 } },
    { key: 'angle', label: 'Angle', type: 'number', min: -90, max: 90, step: 1, default: 0, unit: '°' },
    { key: 'focus', label: 'Focus Width', type: 'number', min: 0, max: 100, step: 1, default: 20, unit: '%' },
    { key: 'transition', label: 'Transition', type: 'number', min: 0, max: 100, step: 1, default: 25, unit: '%' },
    { key: 'blur', label: 'Blur', type: 'number', min: 0, max: 500, step: 1, default: 15, unit: 'px' },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h } = src;
    const c = point(p, 'center'), a = (num(p, 'angle') * Math.PI) / 180, maxS = px(ctx, num(p, 'blur'));
    const cx = c.x * w, cy = c.y * h;
    // Distances are measured as fractions of the image height.
    const nx = Math.sin(a), ny = Math.cos(a);
    const half = (num(p, 'focus') / 200) * h, trans = Math.max(1e-6, (num(p, 'transition') / 100) * h);
    const sigma = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dist = Math.abs((x + 0.5 - cx) * nx + (y + 0.5 - cy) * ny);
        sigma[y * w + x] = maxS * smoothstep((dist - half) / trans);
      }
    return variableBlur(src, sigma, maxS, progress);
  },
});

export const irisBlur = defineOp({
  id: 'iris-blur',
  label: 'Iris Blur',
  category: 'Blur Gallery',
  params: [
    { key: 'center', label: 'Center', type: 'point', default: { x: 0.5, y: 0.5 } },
    { key: 'radius', label: 'Focus Radius', type: 'number', min: 0, max: 100, step: 1, default: 25, unit: '%' },
    { key: 'feather', label: 'Feather', type: 'number', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    { key: 'blur', label: 'Blur', type: 'number', min: 0, max: 500, step: 1, default: 15, unit: 'px' },
  ],
  run(src, p, ctx, progress) {
    const { width: w, height: h } = src;
    const c = point(p, 'center'), maxS = px(ctx, num(p, 'blur'));
    const cx = c.x * w, cy = c.y * h;
    const R = (num(p, 'radius') / 100) * Math.min(w, h), trans = Math.max(1e-6, (num(p, 'feather') / 100) * Math.max(R, 1));
    const sigma = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) sigma[y * w + x] = maxS * smoothstep((Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - R) / trans);
    return variableBlur(src, sigma, maxS, progress);
  },
});
