/**
 * Variable speed (time remapping). A clip's speedCurve is a list of control
 * points { t, v, k? } over its timeline length:
 *   t  0..1, fraction of the clip's timeline duration (first 0, last 1)
 *   v  speed multiplier, 0.1..10
 *   k  optional explicit slope of ln(v) per unit t; points without one get
 *      a monotone (Fritsch-Carlson) tangent, ends get a flat one
 * null (or absent) means constant speed (clip.speed).
 *
 * The curve is a cubic Hermite spline in log-speed, so it reads as a smooth
 * curve on the editor's log axis and never overshoots its points. The
 * source position at a local time is the integral of the speed, taken from
 * a cumulative table built once per curve (3-point Gauss-Legendre over 1024
 * cells) and refined inside a cell, so it is accurate to well under a
 * microsecond.
 *
 * Splits and trims slice the curve: the pieces carry explicit tangents
 * where needed so together they play exactly the same source times.
 * A curved clip keeps clip.speed equal to its mean speed, so code that only
 * needs the source span (duration * speed) stays correct.
 *
 * Pure functions; no DOM, no imports from the timeline (it imports this).
 */

export const CURVE_MIN = 0.1;
export const CURVE_MAX = 10;
export const MAX_POINTS = 32;
/** Smallest gap between two points (fraction of the clip). */
export const POINT_GAP = 0.005;

const CELLS = 1024;
// 3-point Gauss-Legendre nodes and weights on [0, 1].
const GL_X = [0.5 - Math.sqrt(0.15), 0.5, 0.5 + Math.sqrt(0.15)];
const GL_W = [5 / 18, 8 / 18, 5 / 18];
const LN_MIN = Math.log(CURVE_MIN);
const LN_MAX = Math.log(CURVE_MAX);

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Clean a stored curve: sorted points, t in 0..1 with ends at 0 and 1,
 * speeds clamped, near-duplicates dropped. Returns null for anything that
 * is not a usable curve (old projects simply have none).
 */
export function normalizeCurve(raw) {
  if (!Array.isArray(raw)) return null;
  let pts = raw
    .filter((p) => p && finite(p.t) && finite(p.v))
    .map((p) => {
      const q = { t: clamp(p.t, 0, 1), v: clamp(p.v, CURVE_MIN, CURVE_MAX) };
      if (finite(p.k)) q.k = clamp(p.k, -200, 200);
      return q;
    })
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  // Drop points closer than a hair to the previous one (keep the first).
  pts = pts.filter((p, i) => i === 0 || p.t - pts[i - 1].t > 1e-9);
  if (pts[0].t > 0) pts.unshift({ t: 0, v: pts[0].v });
  if (pts.at(-1).t < 1) pts.push({ t: 1, v: pts.at(-1).v });
  if (pts.length > MAX_POINTS) pts = [...pts.slice(0, MAX_POINTS - 1), pts.at(-1)];
  return pts;
}

// ---- Spline ------------------------------------------------------------------

/** Automatic tangents (d ln v / dt): monotone inside, flat at the ends. */
function autoTangents(ts, ys) {
  const n = ts.length;
  const m = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const h0 = ts[i] - ts[i - 1];
    const h1 = ts[i + 1] - ts[i];
    const d0 = (ys[i] - ys[i - 1]) / h0;
    const d1 = (ys[i + 1] - ys[i]) / h1;
    if (d0 * d1 <= 0) continue;
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    m[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
  }
  return m;
}

/** Compiled spline: arrays plus fast evaluation of ln v and its slope. */
function compile(points) {
  const n = points.length;
  const ts = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ts[i] = points[i].t;
    ys[i] = Math.log(points[i].v);
  }
  const auto = autoTangents(ts, ys);
  const ms = new Float64Array(n);
  for (let i = 0; i < n; i++) ms[i] = finite(points[i].k) ? points[i].k : auto[i];
  let seg = 0;
  const find = (t) => {
    // Most lookups move forward a little; start from the last segment.
    if (t < ts[seg] || t > ts[seg + 1]) {
      let lo = 0;
      let hi = n - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ts[mid] <= t) lo = mid;
        else hi = mid - 1;
      }
      seg = lo;
    }
    return seg;
  };
  /** ln v at t (constant past the ends). */
  const lnAt = (t) => {
    if (n === 1 || t <= ts[0]) return ys[0];
    if (t >= ts[n - 1]) return ys[n - 1];
    const i = find(t);
    const h = ts[i + 1] - ts[i];
    const s = (t - ts[i]) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    const y = (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * h * ms[i] + (-2 * s3 + 3 * s2) * ys[i + 1] + (s3 - s2) * h * ms[i + 1];
    return clamp(y, LN_MIN, LN_MAX);
  };
  /** d ln v / dt at t (0 past the ends). */
  const slopeAt = (t) => {
    if (n === 1 || t < ts[0] || t > ts[n - 1]) return 0;
    const i = find(Math.min(t, ts[n - 1]));
    const h = ts[i + 1] - ts[i];
    const s = (t - ts[i]) / h;
    const s2 = s * s;
    return ((6 * s2 - 6 * s) * ys[i]) / h + (3 * s2 - 4 * s + 1) * ms[i] + ((-6 * s2 + 6 * s) * ys[i + 1]) / h + (3 * s2 - 2 * s) * ms[i + 1];
  };
  return { n, ts, ys, ms, auto, lnAt, slopeAt, speed: (t) => Math.exp(lnAt(t)) };
}

/**
 * Cumulative table for a curve: F(x) = integral of v over [0, x] for x in
 * 0..1 (past 1 the end speed continues; before 0 the start speed).
 */
function build(points) {
  const sp = compile(points);
  const v = sp.speed;
  const h = 1 / CELLS;
  const F = new Float64Array(CELLS + 1);
  const V = new Float64Array(CELLS + 1);
  const knots = sp.ts.slice(1, -1);
  const g3 = (a, d) => d * (GL_W[0] * v(a + GL_X[0] * d) + GL_W[1] * v(a + GL_X[1] * d) + GL_W[2] * v(a + GL_X[2] * d));
  /** Integral of v over [a, b] (within a cell), split at the points so each piece is smooth. */
  const gl = (a, b) => {
    let sum = 0;
    let from = a;
    for (const t of knots) {
      if (t <= from) continue;
      if (t >= b) break;
      sum += g3(from, t - from);
      from = t;
    }
    return sum + g3(from, b - from);
  };
  V[0] = v(0);
  for (let k = 0; k < CELLS; k++) {
    V[k + 1] = v((k + 1) * h);
    F[k + 1] = F[k] + gl(k * h, (k + 1) * h);
  }
  const total = F[CELLS];
  let vmax = 0;
  let vmin = Infinity;
  for (let k = 0; k <= CELLS; k++) {
    vmax = Math.max(vmax, V[k]);
    vmin = Math.min(vmin, V[k]);
  }
  for (const p of points) {
    vmax = Math.max(vmax, p.v);
    vmin = Math.min(vmin, p.v);
  }
  const v0 = V[0];
  const v1 = V[CELLS];
  /** Integral of v over [0, x]. */
  const integral = (x) => {
    if (x <= 0) return x * v0;
    if (x >= 1) return total + (x - 1) * v1;
    const k = Math.min(CELLS - 1, Math.floor(x * CELLS));
    const a = k * h;
    if (x <= a) return F[k];
    return F[k] + gl(a, x);
  };
  /** x such that integral(x) = f. */
  const inverse = (f) => {
    if (f <= 0) return f / v0;
    if (f >= total) return 1 + (f - total) / v1;
    let lo = 0;
    let hi = CELLS;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (F[mid] <= f) lo = mid;
      else hi = mid;
    }
    const a = lo * h;
    const b = a + h;
    let x = clamp(a + (f - F[lo]) / Math.max(1e-9, V[lo]), a, b);
    for (let it = 0; it < 6; it++) {
      const err = integral(x) - f;
      if (Math.abs(err) < 1e-13) break;
      x = clamp(x - err / v(x), a, b);
    }
    return x;
  };
  return { spline: sp, speed: v, integral, inverse, total, vmax, vmin, v0, v1 };
}

const cache = new WeakMap();
const sigOf = (points) => {
  let s = '';
  for (const p of points) s += `${p.t},${p.v},${p.k ?? ''};`;
  return s;
};

/**
 * Compiled curve (cached per points array, rebuilt when the points were
 * edited in place). Fields: speed(x), integral(x), inverse(f), total
 * (mean speed), vmax, vmin.
 */
export function curveTable(points) {
  let e = cache.get(points);
  const sig = sigOf(points);
  if (!e || e.sig !== sig) {
    e = { sig, table: build(points) };
    cache.set(points, e);
  }
  return e.table;
}

/** Speed at x (fraction of the clip). */
export const curveSpeedAt = (points, x) => curveTable(points).speed(clamp(x, 0, 1));
/** Integral of the speed over [0, x]. */
export const curveIntegral = (points, x) => curveTable(points).integral(x);
/** x where the integral reaches f (inverse of curveIntegral). */
export const curveInverse = (points, f) => curveTable(points).inverse(f);
/** Mean speed over the clip (source length / timeline length). */
export const meanSpeed = (points) => curveTable(points).total;
/** Timeline length that plays sourceSpan under this curve. */
export const curveDuration = (points, sourceSpan) => sourceSpan / meanSpeed(points);

// ---- Clip helpers ------------------------------------------------------------

/** Whether the clip plays at a varying speed. */
export function hasCurve(clip) {
  return Boolean(clip && !clip.freeze && Array.isArray(clip.speedCurve) && clip.speedCurve.length >= 2);
}

/**
 * Source offset (us after clip.in) played at local time (us after the clip
 * start). Outside the clip it continues at the end speeds (transitions).
 * Constant speed stays the plain product.
 */
export function sourceOffset(clip, local) {
  if (clip.freeze) return 0;
  if (!hasCurve(clip)) return local * (clip.speed || 1);
  const D = clip.duration;
  return D * curveTable(clip.speedCurve).integral(local / D);
}

/** Local time (us) at which the clip reaches a source offset (inverse of sourceOffset). */
export function localAtSource(clip, offset) {
  if (clip.freeze) return 0;
  if (!hasCurve(clip)) return offset / (clip.speed || 1);
  const D = clip.duration;
  return D * curveTable(clip.speedCurve).inverse(offset / D);
}

/** Instantaneous speed at local time (us). */
export function speedAt(clip, local) {
  if (clip.freeze) return 0;
  if (!hasCurve(clip)) return clip.speed || 1;
  return curveTable(clip.speedCurve).speed(clamp(local / clip.duration, 0, 1));
}

/** Source length (us) the clip plays. */
export function sourceSpan(clip) {
  if (clip.freeze) return 0;
  return sourceOffset(clip, clip.duration);
}

/** Fastest speed anywhere in the clip (read-ahead sizing). */
export function maxSpeed(clip) {
  if (!hasCurve(clip)) return clip.speed || 1;
  return curveTable(clip.speedCurve).vmax;
}

/** Start and end speed of the clip (trim extension and limits). */
export function edgeSpeeds(clip) {
  if (!hasCurve(clip)) return [clip.speed || 1, clip.speed || 1];
  const tb = curveTable(clip.speedCurve);
  return [tb.v0, tb.v1];
}

/**
 * Fast mapper for hot loops: local (us) -> source offset (us). Resolves
 * the table once instead of per call.
 */
export function sourceMapper(clip) {
  if (clip.freeze) return () => 0;
  if (!hasCurve(clip)) {
    const sp = clip.speed || 1;
    return (local) => local * sp;
  }
  const D = clip.duration;
  const tb = curveTable(clip.speedCurve);
  return (local) => D * tb.integral(local / D);
}

// ---- Editing -------------------------------------------------------------------

/** Points with explicit tangents dropped where the automatic one matches. */
function tidy(points) {
  const n = points.length;
  const ts = points.map((p) => p.t);
  const ys = points.map((p) => Math.log(p.v));
  const auto = autoTangents(ts, ys);
  return points.map((p, i) => {
    const q = { t: p.t, v: p.v };
    if (finite(p.k) && Math.abs(p.k - auto[i]) > 1e-9 * Math.max(1, Math.abs(p.k)) && n > 1) q.k = p.k;
    return q;
  });
}

/**
 * The part of a curve between fractions a and b (b > a; either may run past
 * 0..1, where the end speeds continue), stretched to 0..1. The result
 * reproduces the original speeds over that part exactly.
 */
export function sliceCurve(points, a, b) {
  const sp = compile(points);
  const w = b - a;
  const eps = 1e-7;
  const at = (x) => {
    const xc = clamp(x, 0, 1);
    // Past an end the speed is flat.
    const k = x < 0 || x > 1 ? 0 : sp.slopeAt(xc);
    return { v: Math.exp(sp.lnAt(xc)), k };
  };
  const out = [];
  const head = at(a);
  out.push({ t: 0, v: head.v, k: head.k * w });
  for (let i = 0; i < sp.n; i++) {
    const t = sp.ts[i];
    if (t <= a + eps || t >= b - eps) continue;
    out.push({ t: (t - a) / w, v: points[i].v, k: sp.ms[i] * w });
    // An end of the original that the slice runs past: the speed is flat from there on, but the
    // end point keeps the slope it arrived with. A twin point right next to it carries the flat
    // tangent; without it the slope carried on into the added part and the speed bulged.
    const g = 1e-6;
    if (i === sp.n - 1 && b > 1 && sp.ms[i] !== 0) out.push({ t: (t - a) / w + g, v: points[i].v, k: 0 });
    if (i === 0 && a < 0 && sp.ms[i] !== 0) {
      const p = out.pop();
      out.push({ t: p.t - g, v: p.v, k: 0 }, p);
    }
  }
  const tail = at(b);
  out.push({ t: 1, v: tail.v, k: tail.k * w });
  return tidy(out);
}

/** The curve played backwards (for reversed clips). Automatic tangents mirror on their own. */
export function mirrorCurve(points) {
  return [...points].reverse().map((p) => {
    const q = { t: 1 - p.t, v: p.v };
    if (finite(p.k)) q.k = -p.k;
    return q;
  });
}

/** A curve that plays at one speed throughout. */
export const flatCurve = (v) => [{ t: 0, v: clamp(v, CURVE_MIN, CURVE_MAX) }, { t: 1, v: clamp(v, CURVE_MIN, CURVE_MAX) }];

/** Whether every point sits at (about) the same speed with no explicit slope. */
export function isFlatCurve(points) {
  return points.every((p) => Math.abs(p.v - points[0].v) < 1e-6 && !(finite(p.k) && Math.abs(p.k) > 1e-9));
}

/** Two curves with the same points (presets are matched this way). */
export function sameCurve(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p.t - b[i].t) < 1e-6 && Math.abs(p.v - b[i].v) < 1e-6 && (p.k ?? null) === (b[i].k ?? null));
}

/**
 * Remap clip-local key times from an old timing to a new one through the
 * source position, so keys stay on the same moment of the footage.
 * map(t) -> new t. Keys landing on the same time keep the later one.
 */
export function remapKeyframes(keyframes, map, duration) {
  const out = {};
  for (const [prop, keys] of Object.entries(keyframes || {})) {
    const moved = [];
    for (const k of keys) {
      const t = clamp(Math.round(map(k.t)), 0, duration);
      if (moved.length && moved.at(-1).t === t) moved.pop();
      moved.push({ ...k, t });
    }
    out[prop] = moved;
  }
  return out;
}

// ---- Presets -------------------------------------------------------------------

const P = (pairs) => pairs.map(([t, v]) => ({ t, v }));

/** Built-in curve shapes. Original names and shapes. */
export const CURVE_PRESETS = [
  { id: 'ramp-up', label: 'Ramp up', points: P([[0, 0.4], [1, 3]]) },
  { id: 'ramp-down', label: 'Ramp down', points: P([[0, 3], [1, 0.4]]) },
  { id: 'ease', label: 'Ease in-out', points: P([[0, 0.5], [0.5, 2], [1, 0.5]]) },
  { id: 'slow-middle', label: 'Slow middle', points: P([[0, 2], [0.3, 2], [0.45, 0.3], [0.55, 0.3], [0.7, 2], [1, 2]]) },
  { id: 'fast-middle', label: 'Fast middle', points: P([[0, 0.7], [0.3, 0.7], [0.5, 5], [0.7, 0.7], [1, 0.7]]) },
  { id: 'pulse', label: 'Pulse', points: P([[0, 1], [0.25, 3], [0.5, 1], [0.75, 3], [1, 1]]) },
  { id: 'stutter', label: 'Stutter', points: P([[0, 3], [0.125, 0.35], [0.25, 3], [0.375, 0.35], [0.5, 3], [0.625, 0.35], [0.75, 3], [0.875, 0.35], [1, 3]]) },
  { id: 'smash-cut', label: 'Smash cut', points: P([[0, 0.4], [0.42, 0.4], [0.5, 8], [0.58, 0.4], [1, 0.4]]) },
];

/** Preset id whose points the curve matches, or null (custom). */
export function presetOf(points) {
  if (!points) return null;
  return CURVE_PRESETS.find((p) => sameCurve(p.points, points))?.id || null;
}

/** A fresh, editable copy of a preset's points. */
export function presetPoints(id) {
  const p = CURVE_PRESETS.find((x) => x.id === id);
  return p ? p.points.map((q) => ({ ...q })) : null;
}
