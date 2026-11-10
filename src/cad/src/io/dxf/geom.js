/**
 * Geometry helpers shared by the DXF reader and writer: angle normalization,
 * B-spline knot handling and evaluation, fit point interpolation, and the
 * conversion of a projected circle (two conjugate radius vectors) into the
 * ellipse fields used by the drawing schema.
 */
import { TWO_PI } from '../../core/schema.js';

/** Normalize an angle to [0, 2*PI). */
export function normAngle(a) {
  a %= TWO_PI;
  if (a < 0) a += TWO_PI;
  return a;
}

/** Clamped uniform knot vector for `n` control points of `degree`. */
export function uniformKnots(n, degree) {
  const k = [];
  const spans = n - degree;
  for (let i = 0; i <= degree; i++) k.push(0);
  for (let i = 1; i < spans; i++) k.push(i / spans);
  for (let i = 0; i <= degree; i++) k.push(1);
  return k;
}

/** True when the first and last `degree + 1` knots are equal. */
export function isClamped(degree, knots) {
  const m = knots.length;
  const tol = 1e-10 * (Math.abs(knots[m - 1] - knots[0]) || 1);
  for (let i = 1; i <= degree; i++) {
    if (Math.abs(knots[i] - knots[0]) > tol) return false;
    if (Math.abs(knots[m - 1 - i] - knots[m - 1]) > tol) return false;
  }
  return true;
}

/** Insert knot `u` once (Boehm). `P` is flat [x, y, ...]. Returns [U', P']. */
function insertKnot(p, U, P, u) {
  const n = P.length >> 1;
  let k = p;
  while (k < n - 1 && U[k + 1] <= u) k++;
  const Q = new Array((n + 1) * 2);
  for (let i = 0; i <= k - p; i++) {
    Q[i * 2] = P[i * 2];
    Q[i * 2 + 1] = P[i * 2 + 1];
  }
  for (let i = k - p + 1; i <= k; i++) {
    const d = U[i + p] - U[i];
    const a = d > 0 ? (u - U[i]) / d : 0;
    Q[i * 2] = (1 - a) * P[i * 2 - 2] + a * P[i * 2];
    Q[i * 2 + 1] = (1 - a) * P[i * 2 - 1] + a * P[i * 2 + 1];
  }
  for (let i = k + 1; i <= n; i++) {
    Q[i * 2] = P[i * 2 - 2];
    Q[i * 2 + 1] = P[i * 2 - 1];
  }
  const V = U.slice(0, k + 1);
  V.push(u);
  for (let i = k + 1; i < U.length; i++) V.push(U[i]);
  return [V, Q];
}

/** Clamp the start of a spline at its domain start U[p]. */
function clampStart(p, U, P) {
  const a = U[p];
  const tol = 1e-10 * (Math.abs(U[U.length - 1] - U[0]) || 1);
  let s = 0;
  for (const u of U) if (Math.abs(u - a) <= tol) s++;
  if (s <= p) {
    for (let r = s; r < p; r++) [U, P] = insertKnot(p, U, P, a);
    let j = 0;
    while (Math.abs(U[j] - a) > tol) j++;
    const K = new Array(p + 1).fill(a);
    for (let i = j + p; i < U.length; i++) K.push(U[i]);
    return [K, P.slice((j - 1) * 2)];
  }
  let j = 0;
  while (Math.abs(U[j] - a) > tol) j++;
  const drop = j + s - (p + 1);
  return [U.slice(drop), P.slice(drop * 2)];
}

function reverseSpline(U, P) {
  const R = [];
  for (let i = U.length - 1; i >= 0; i--) R.push(-U[i]);
  const Q = [];
  for (let i = P.length - 2; i >= 0; i -= 2) Q.push(P[i], P[i + 1]);
  return [R, Q];
}

/**
 * Convert any valid B-spline (clamped, unclamped or periodic knots) into an
 * equivalent clamped one over the same domain. Returns { knots, ctrl } or
 * null when the knot vector does not match the control point count.
 */
export function clampSpline(degree, knots, ctrl) {
  const n = ctrl.length >> 1;
  if (n < degree + 1 || knots.length !== n + degree + 1) return null;
  for (let i = 1; i < knots.length; i++) if (!(knots[i] >= knots[i - 1])) return null;
  if (isClamped(degree, knots)) return { knots: knots.slice(), ctrl: ctrl.slice() };
  let U = knots.slice();
  let P = ctrl.slice();
  [U, P] = clampStart(degree, U, P);
  [U, P] = reverseSpline(U, P);
  [U, P] = clampStart(degree, U, P);
  [U, P] = reverseSpline(U, P);
  return { knots: U, ctrl: P };
}

/**
 * Evaluate a (optionally rational) B-spline at `u` with de Boor's algorithm.
 * `W` holds one weight per control point or is null. Writes into `out`.
 */
export function evalSpline(p, U, P, W, u, out) {
  const n = P.length >> 1;
  let k = p;
  while (k < n - 1 && U[k + 1] <= u) k++;
  const dx = new Array(p + 1);
  const dy = new Array(p + 1);
  const dw = new Array(p + 1);
  for (let j = 0; j <= p; j++) {
    const i = k - p + j;
    const w = W ? W[i] ?? 1 : 1;
    dx[j] = P[i * 2] * w;
    dy[j] = P[i * 2 + 1] * w;
    dw[j] = w;
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const d = U[i + p - r + 1] - U[i];
      const a = d > 0 ? (u - U[i]) / d : 0;
      dx[j] = (1 - a) * dx[j - 1] + a * dx[j];
      dy[j] = (1 - a) * dy[j - 1] + a * dy[j];
      dw[j] = (1 - a) * dw[j - 1] + a * dw[j];
    }
  }
  const w = dw[p] || 1;
  out[0] = dx[p] / w;
  out[1] = dy[p] / w;
  return out;
}

/** Sample a B-spline into a flat point list with `segs` segments. */
export function tessellateSpline(p, U, P, W, segs) {
  const n = P.length >> 1;
  const u0 = U[p];
  const u1 = U[n];
  const out = [];
  const pt = [0, 0];
  for (let i = 0; i <= segs; i++) {
    evalSpline(p, U, P, W, u0 + ((u1 - u0) * i) / segs, pt);
    out.push(pt[0], pt[1]);
  }
  return out;
}

/**
 * Non-rational cubic equivalent of a rational B-spline (the drawing model has
 * no weights): a chain of cubic Hermite pieces, `per` per knot span, through
 * points of the curve with its tangents there, so corners at repeated knots
 * stay sharp. Returns { degree: 3, ctrl, knots } with knots in [0, 1].
 */
export function rationalToCubic(p, U, P, W, per = 8) {
  const n = P.length >> 1;
  const u0 = U[p];
  const u1 = U[n];
  if (!(u1 > u0)) return null;
  const at = (u) => evalSpline(p, U, P, W, u, [0, 0]);
  const ctrl = [];
  const knots = [0, 0, 0, 0];
  for (let i = p; i < n; i++) {
    const a = U[i];
    const b = U[i + 1];
    if (!(b > a)) continue;
    const h = (b - a) * 1e-7;
    const step = (b - a) / per;
    for (let k = 0; k < per; k++) {
      const s = a + step * k;
      const t = k === per - 1 ? b : s + step;
      const A = at(s);
      const B = at(t);
      const A1 = at(s + h);
      const B0 = at(t - h);
      const f = step / 3 / h;
      if (!ctrl.length) ctrl.push(A[0], A[1]);
      ctrl.push(A[0] + (A1[0] - A[0]) * f, A[1] + (A1[1] - A[1]) * f);
      ctrl.push(B[0] - (B[0] - B0[0]) * f, B[1] - (B[1] - B0[1]) * f, B[0], B[1]);
      const kn = (t - u0) / (u1 - u0);
      if (t < u1) knots.push(kn, kn, kn);
    }
  }
  knots.push(1, 1, 1, 1);
  return { degree: 3, ctrl, knots };
}

/** Flat points along an ellipse arc from parameter t0 to t1 (inclusive). */
export function ellipsePoints(cx, cy, mx, my, ratio, t0, t1, segs) {
  const out = [];
  const vx = -my * ratio;
  const vy = mx * ratio;
  for (let i = 0; i <= segs; i++) {
    const t = t0 + ((t1 - t0) * i) / segs;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push(cx + c * mx + s * vx, cy + c * my + s * vy);
  }
  return out;
}

/**
 * The curve C + cos(t) U + sin(t) V for t from t0 to t1 (increasing) is an
 * ellipse. Returns its schema fields { cx, cy, mx, my, ratio, start, end,
 * circular } with start/end counter-clockwise, or null when degenerate.
 */
export function conjugateToEllipse(cx, cy, ux, uy, vx, vy, t0, t1) {
  const uu = ux * ux + uy * uy;
  const vv = vx * vx + vy * vy;
  const uv = ux * vx + uy * vy;
  let a = 0.5 * Math.atan2(2 * uv, uu - vv);
  let ax = Math.cos(a) * ux + Math.sin(a) * vx;
  let ay = Math.cos(a) * uy + Math.sin(a) * vy;
  let bx = -Math.sin(a) * ux + Math.cos(a) * vx;
  let by = -Math.sin(a) * uy + Math.cos(a) * vy;
  if (bx * bx + by * by > ax * ax + ay * ay) {
    a += Math.PI / 2;
    const tx = ax;
    const ty = ay;
    ax = bx;
    ay = by;
    bx = -tx;
    by = -ty;
  }
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-12) return null;
  const ratio = Math.min(1, lb / la);
  if (ratio < 1e-9) return null;
  let s = t0 - a;
  let e = t1 - a;
  if (ax * by - ay * bx < 0) {
    const tmp = s;
    s = -e;
    e = -tmp;
  }
  const full = Math.abs(t1 - t0 - TWO_PI) < 1e-9;
  const start = full ? 0 : normAngle(s);
  const end = full ? TWO_PI : start + (e - s);
  return { cx, cy, mx: ax, my: ay, ratio, start, end, circular: ratio > 1 - 1e-9, full };
}
