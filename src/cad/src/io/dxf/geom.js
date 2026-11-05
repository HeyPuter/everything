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

/** Cubic B-spline basis functions at `u` in knot span `span` (into N[0..3]). */
function cubicBasis(span, u, U, N) {
  const left = [0, 0, 0, 0];
  const right = [0, 0, 0, 0];
  N[0] = 1;
  for (let j = 1; j <= 3; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const t = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * t;
      saved = left[j - r] * t;
    }
    N[j] = saved;
  }
}

/**
 * Build the clamped cubic B-spline through fit points (flat [x, y, ...]) the
 * way AutoCAD does: global C2 interpolation with chord-length parameters and
 * interior knots at the fit points. `startTan` / `endTan` are optional end
 * derivatives [dx, dy] per unit of chord length (DXF groups 12 and 13);
 * without them the ends get zero curvature. Closed curves without tangents
 * share the tangent across the seam. Returns { degree: 3, ctrl, knots } with
 * knots in [0, 1], or null for fewer than two distinct points.
 */
export function fitToSpline(fit, closed = false, startTan = null, endTan = null) {
  const Q = [];
  for (let i = 0; i + 1 < fit.length; i += 2) {
    const k = Q.length;
    if (k && Q[k - 2] === fit[i] && Q[k - 1] === fit[i + 1]) continue;
    Q.push(fit[i], fit[i + 1]);
  }
  if (closed && Q.length >= 6 && (Q[0] !== Q[Q.length - 2] || Q[1] !== Q[Q.length - 1])) {
    Q.push(Q[0], Q[1]);
  }
  const n = (Q.length >> 1) - 1; // segments
  if (n < 1) return null;
  const u = [0];
  for (let i = 1; i <= n; i++) {
    u.push(u[i - 1] + Math.hypot(Q[2 * i] - Q[2 * i - 2], Q[2 * i + 1] - Q[2 * i - 1]));
  }
  const total = u[n];
  const knots = [0, 0, 0, 0];
  for (let i = 1; i < n; i++) knots.push(u[i] / total);
  knots.push(1, 1, 1, 1);
  // derivatives with respect to the normalized parameter
  const tan = (t) => (t && (t[0] || t[1]) ? [t[0] * total, t[1] * total] : null);
  let d0 = tan(startTan);
  let d1 = tan(endTan);
  if (closed && n >= 3 && !d0 && !d1) {
    const h = u[1] + u[n] - u[n - 1];
    d0 = d1 = [((Q[2] - Q[2 * n - 2]) / h) * total, ((Q[3] - Q[2 * n - 1]) / h) * total];
  }
  // tridiagonal system for control points 1..n+1 (0 and n+2 are the end points)
  const m = n + 1;
  const sub = new Float64Array(m);
  const dia = new Float64Array(m);
  const sup = new Float64Array(m);
  const rx = new Float64Array(m);
  const ry = new Float64Array(m);
  const a = knots[4];
  const b = knots[5];
  if (d0) {
    dia[0] = 1;
    rx[0] = Q[0] + (a / 3) * d0[0];
    ry[0] = Q[1] + (a / 3) * d0[1];
  } else {
    dia[0] = 1 / a + 1 / b;
    sup[0] = -1 / b;
    rx[0] = Q[0] / a;
    ry[0] = Q[1] / a;
  }
  const N = [0, 0, 0, 0];
  for (let k = 1; k < n; k++) {
    cubicBasis(k + 3, knots[k + 3], knots, N);
    sub[k] = N[0];
    dia[k] = N[1];
    sup[k] = N[2];
    rx[k] = Q[2 * k];
    ry[k] = Q[2 * k + 1];
  }
  const L = knots.length;
  const c = 1 - knots[L - 5];
  const d = 1 - knots[L - 6];
  if (d1) {
    dia[n] = 1;
    rx[n] = Q[2 * n] - (c / 3) * d1[0];
    ry[n] = Q[2 * n + 1] - (c / 3) * d1[1];
  } else {
    dia[n] = 1 / c + 1 / d;
    sub[n] = -1 / d;
    rx[n] = Q[2 * n] / c;
    ry[n] = Q[2 * n + 1] / c;
  }
  for (let j = 1; j < m; j++) {
    const w = sub[j] / dia[j - 1];
    dia[j] -= w * sup[j - 1];
    rx[j] -= w * rx[j - 1];
    ry[j] -= w * ry[j - 1];
  }
  rx[m - 1] /= dia[m - 1];
  ry[m - 1] /= dia[m - 1];
  for (let j = m - 2; j >= 0; j--) {
    rx[j] = (rx[j] - sup[j] * rx[j + 1]) / dia[j];
    ry[j] = (ry[j] - sup[j] * ry[j + 1]) / dia[j];
  }
  const ctrl = [Q[0], Q[1]];
  for (let j = 0; j < m; j++) ctrl.push(rx[j], ry[j]);
  ctrl.push(Q[2 * n], Q[2 * n + 1]);
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
