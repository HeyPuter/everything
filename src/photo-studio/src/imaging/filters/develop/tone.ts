// Develop tone curves:
// - the Light curve on perceptual luminance (contrast pivoting on middle
//   gray, band-limited highlights/shadows/whites/blacks, a soft shoulder only
//   when an adjustment pushes values out of range);
// - the Curve panel: parametric region adjustments and point curves (a
//   master curve and one per channel) through monotone cubic interpolation,
//   combined into one table per channel on encoded values.
import type { NormPath, ParamValues } from '../../types';
import { num } from '../sampling';

export const PERCEPTUAL = 1 / 2.2;

/** Light curve tabulated over [0, xmax]; `xreach` is the largest input
 * expected in practice and sizes the highlight shoulder. */
export function toneLUT(p: ParamValues, xmax: number, xreach: number, n: number): Float32Array {
  const c = num(p, 'contrast', 0) / 100,
    hl = num(p, 'highlights', 0) / 100,
    sh = num(p, 'shadows', 0) / 100,
    wh = num(p, 'whites', 0) / 100,
    bl = num(p, 'blacks', 0) / 100;
  const g = Math.pow(2, 0.8 * c),
    m = Math.pow(0.18, PERCEPTUAL);
  const lut = new Float32Array(n + 1);
  let hi = -Infinity,
    lo = Infinity;
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * xmax,
      t = Math.min(1, x);
    // Contrast pivots on middle gray with matching slopes on both sides.
    let y =
      x <= m ? m * Math.pow(x / m, g) : x <= 1 ? 1 - (1 - m) * Math.pow((1 - x) / (1 - m), g) : x;
    // Band-limited bumps: zero at both ends, so black and white stay put.
    y += (sh > 0 ? 1.6 : 0.95) * sh * t * (1 - t) ** 3;
    y += (hl > 0 ? 1.6 : 0.95) * hl * t ** 3 * (1 - t);
    y += 0.25 * wh * t ** 4 + 0.25 * bl * (1 - t) ** 4;
    lut[i] = y;
    if (x <= xreach) {
      if (y > hi) hi = y;
      if (y < lo) lo = y;
    }
  }
  // Soft shoulder/toe sized by how far the curve overshoots [0, 1].
  const kh = hi > 1 ? 1 - Math.min(0.3, (hi - 1) * 0.5) : 1,
    kl = lo < 0 ? Math.min(0.3, -lo * 0.5) : 0;
  let prev = 0;
  for (let i = 0; i <= n; i++) {
    let y = lut[i];
    if (y > kh) y = kh + (1 - kh) * Math.tanh((y - kh) / (1 - kh));
    else if (y < kl) y = kl - kl * Math.tanh((kl - y) / kl);
    y = Math.max(prev, Math.min(1, Math.max(0, y)));
    lut[i] = prev = y;
  }
  return lut;
}

/** Valid, sorted points of a point curve (x strictly increasing, at most 16). */
export function curvePoints(v: unknown): { x: number; y: number }[] {
  const raw = Array.isArray(v) && Array.isArray(v[0]) ? (v[0] as NormPath) : [];
  const pts = raw
    .filter((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y))
    .map((q) => ({ x: Math.min(1, Math.max(0, q.x)), y: Math.min(1, Math.max(0, q.y)) }))
    .sort((a, b) => a.x - b.x);
  const out: { x: number; y: number }[] = [];
  for (const q of pts) if (!out.length || q.x - out[out.length - 1].x > 1e-3) out.push(q);
  return out.slice(0, 16);
}

/** Monotone cubic (Fritsch-Carlson) interpolation through points sorted by
 * x; flat beyond the first and last point. Fewer than two points: identity. */
export function splineEval(pts: { x: number; y: number }[]): (x: number) => number {
  const n = pts.length;
  if (n < 2) return (x) => x;
  const d: number[] = [],
    m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i],
      b = m[i + 1] / d[i],
      s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= pts[0].x) return pts[0].y;
    if (x >= pts[n - 1].x) return pts[n - 1].y;
    let i = 0;
    while (i < n - 2 && x > pts[i + 1].x) i++;
    const h = pts[i + 1].x - pts[i].x,
      t = (x - pts[i].x) / h,
      t2 = t * t,
      t3 = t2 * t;
    const y =
      (2 * t3 - 3 * t2 + 1) * pts[i].y +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * pts[i + 1].y +
      (t3 - t2) * h * m[i + 1];
    return Math.min(1, Math.max(0, y));
  };
}

/** Parametric curve: each region slider raises or lowers its band with a
 * smooth bump that is zero at black and white. Region edges come from the
 * three splits. The result is kept non-decreasing. */
export function parametricEval(p: ParamValues): (x: number) => number {
  const s1 = num(p, 'curveSplit1', 25) / 100,
    s2 = Math.max(s1 + 0.02, num(p, 'curveSplit2', 50) / 100),
    s3 = Math.max(s2 + 0.02, num(p, 'curveSplit3', 75) / 100);
  const vals = ['curveShadows', 'curveDarks', 'curveLights', 'curveHighlights'].map(
    (k) => num(p, k, 0) / 100,
  );
  if (vals.every((v) => v === 0)) return (x) => x;
  const centers = [s1 / 2, (s1 + s2) / 2, (s2 + s3) / 2, (s3 + 1) / 2];
  const bumps = centers.map((c, k) => {
    const L = k ? centers[k - 1] : 0,
      R = k < 3 ? centers[k + 1] : 1,
      half = Math.min(c - L, R - c);
    // Amplitude limit keeps a single bump monotonic (slope above -1).
    return { L, R, c, amp: vals[k] * 0.6 * half };
  });
  return (x) => {
    let y = x;
    for (const b of bumps) {
      if (b.amp === 0 || x <= b.L || x >= b.R) continue;
      const t = x < b.c ? (x - b.L) / (b.c - b.L) : (b.R - x) / (b.R - b.c);
      y += b.amp * 0.5 * (1 - Math.cos(Math.PI * t));
    }
    return y;
  };
}

export type CurveTables = {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  n: number;
  active: boolean;
};
/** Per-channel tables on encoded values in [0, 1]: parametric, then the
 * master point curve, then the channel's own point curve. */
export function curveTables(p: ParamValues, n = 1024): CurveTables {
  const param = parametricEval(p);
  const master = splineEval(curvePoints(p.curveRGB)),
    ch = [
      splineEval(curvePoints(p.curveRed)),
      splineEval(curvePoints(p.curveGreen)),
      splineEval(curvePoints(p.curveBlue)),
    ];
  const base = new Float32Array(n + 1);
  let prev = 0;
  for (let i = 0; i <= n; i++) {
    const y = Math.min(1, Math.max(prev, param(i / n)));
    base[i] = prev = y;
  }
  const tabs = ch.map((f) => {
    const t = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) t[i] = f(master(base[i]));
    return t;
  });
  let active = false;
  for (const t of tabs)
    for (let i = 0; i <= n && !active; i++) if (Math.abs(t[i] - i / n) > 1e-5) active = true;
  return { r: tabs[0], g: tabs[1], b: tabs[2], n, active };
}
