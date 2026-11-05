/**
 * B-spline evaluation, construction and splitting. A spline entity has
 * `degree`, flat control points `ctrl` and a clamped knot vector `knots`
 * (length = ctrl.length / 2 + degree + 1). The parameter domain is
 * [knots[degree], knots[nCtrl]].
 */

/** Effective degree (never more than control points - 1). */
function degreeOf(s) {
  const nc = s.ctrl.length >> 1;
  return Math.max(1, Math.min(s.degree | 0 || 3, nc - 1));
}

/** Clamped uniform knot vector for nc control points and degree p. */
export function clampedUniformKnots(nc, p) {
  const knots = [];
  const inner = nc - p;
  for (let i = 0; i <= p; i++) knots.push(0);
  for (let i = 1; i < inner; i++) knots.push(i / inner);
  for (let i = 0; i <= p; i++) knots.push(1);
  return knots;
}

/** Knot vector of s, rebuilt as clamped uniform when missing or inconsistent. */
function knotsOf(s, p) {
  const nc = s.ctrl.length >> 1;
  const k = s.knots;
  if (k && k.length === nc + p + 1) return k;
  return clampedUniformKnots(nc, p);
}

/** Parameter domain [u0, u1] of a spline. */
export function splineDomain(s) {
  const nc = s.ctrl.length >> 1;
  if (nc < 2) return [0, 0];
  const p = degreeOf(s);
  const U = knotsOf(s, p);
  return [U[p], U[nc]];
}

/** Distinct knot values bounding the non-empty spans, in increasing order. */
export function splineBreaks(s) {
  const nc = s.ctrl.length >> 1;
  if (nc < 2) return [];
  const p = degreeOf(s);
  const U = knotsOf(s, p);
  const out = [U[p]];
  for (let k = p + 1; k <= nc; k++) if (U[k] > out[out.length - 1]) out.push(U[k]);
  return out;
}

/** Knot span index k with U[k] <= u < U[k + 1], restricted to [p, nc - 1]. */
function findSpan(nc, p, u, U) {
  if (u >= U[nc]) {
    let k = nc - 1;
    while (k > p && U[k] >= U[nc]) k--;
    return k;
  }
  if (u <= U[p]) {
    let k = p;
    while (k < nc - 1 && U[k + 1] <= U[p]) k++;
    return k;
  }
  let lo = p,
    hi = nc;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (u < U[mid]) hi = mid;
    else lo = mid;
  }
  return lo;
}

let scratch = new Float64Array(64);

/**
 * Evaluate a spline at parameter t (clamped to the domain) by de Boor's
 * algorithm. Returns { x, y, dx, dy } where (dx, dy) is the derivative.
 */
export function evalSplineFull(s, t) {
  const ctrl = s.ctrl;
  const nc = ctrl.length >> 1;
  if (nc === 0) return { x: 0, y: 0, dx: 0, dy: 0 };
  if (nc === 1) return { x: ctrl[0], y: ctrl[1], dx: 0, dy: 0 };
  const p = degreeOf(s);
  const U = knotsOf(s, p);
  const u = t < U[p] ? U[p] : t > U[nc] ? U[nc] : t;
  const k = findSpan(nc, p, u, U);
  if (scratch.length < 2 * (p + 1)) scratch = new Float64Array(4 * (p + 1));
  const d = scratch;
  for (let j = 0; j <= p; j++) {
    const i = k - p + j;
    d[2 * j] = ctrl[2 * i];
    d[2 * j + 1] = ctrl[2 * i + 1];
  }
  let tx = 0,
    ty = 0;
  for (let r = 1; r <= p; r++) {
    if (r === p) {
      const den = U[k + 1] - U[k];
      const f = den > 0 ? p / den : 0;
      tx = (d[2 * p] - d[2 * p - 2]) * f;
      ty = (d[2 * p + 1] - d[2 * p - 1]) * f;
    }
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const den = U[i + p - r + 1] - U[i];
      const a = den > 0 ? (u - U[i]) / den : 0;
      d[2 * j] = (1 - a) * d[2 * j - 2] + a * d[2 * j];
      d[2 * j + 1] = (1 - a) * d[2 * j - 1] + a * d[2 * j + 1];
    }
  }
  if (p === 0) return { x: d[0], y: d[1], dx: 0, dy: 0 };
  return { x: d[2 * p], y: d[2 * p + 1], dx: tx, dy: ty };
}

/** Point on a spline at parameter t: { x, y }. */
export function evalSpline(s, t) {
  const r = evalSplineFull(s, t);
  return { x: r.x, y: r.y };
}

/** Values of the p + 1 nonzero basis functions at u in span k (into N). */
function basisFuns(k, u, p, U, N) {
  const left = new Float64Array(p + 1),
    right = new Float64Array(p + 1);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[k + 1 - j];
    right[j] = U[k + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const tmp = den !== 0 ? N[r] / den : 0;
      N[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    N[j] = saved;
  }
  return N;
}

/** Remove consecutive duplicate points from a flat [x, y, ...] list. */
function dedupeFlat(pts) {
  let scale = 0;
  for (let i = 0; i < pts.length; i++) scale = Math.max(scale, Math.abs(pts[i]));
  const tol = 1e-12 * Math.max(1, scale);
  const out = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const n = out.length;
    if (n && Math.abs(out[n - 2] - pts[i]) <= tol && Math.abs(out[n - 1] - pts[i + 1]) <= tol) continue;
    out.push(pts[i], pts[i + 1]);
  }
  return out;
}

/**
 * Cubic spline through fit points (flat [x, y, ...]) the way AutoCAD builds
 * it: global C2 interpolation with chord-length parameters, interior knots at
 * the fit points and, unless end tangents are given, zero curvature at the
 * ends. startTan / endTan are optional end directions [dx, dy] per unit of
 * chord length. Closed curves repeat the first point at the end and share the
 * tangent across the seam. Returns { degree: 3, ctrl, knots } (knots in
 * [0, 1]) or null when fewer than 2 distinct points.
 */
export function splineFromFitPoints(fit, closed = false, startTan = null, endTan = null) {
  const Q = dedupeFlat(fit);
  if (closed && Q.length >= 6) {
    const n0 = Q.length;
    if (Math.abs(Q[n0 - 2] - Q[0]) + Math.abs(Q[n0 - 1] - Q[1]) > 0) Q.push(Q[0], Q[1]);
  }
  const n = (Q.length >> 1) - 1;
  if (n < 1) return null;
  // Chord-length parameters.
  const u = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    u[i] = u[i - 1] + Math.hypot(Q[2 * i] - Q[2 * i - 2], Q[2 * i + 1] - Q[2 * i - 1]);
  }
  const total = u[n];
  const knots = [0, 0, 0, 0];
  for (let i = 1; i < n; i++) knots.push(u[i] / total);
  knots.push(1, 1, 1, 1);
  // End derivatives with respect to the normalized parameter.
  const tan = (t) => (t && (t[0] || t[1]) ? [t[0] * total, t[1] * total] : null);
  let d0 = tan(startTan);
  let d1 = tan(endTan);
  if (closed && n >= 3 && !d0 && !d1) {
    const h = u[1] + u[n] - u[n - 1];
    d0 = d1 = [((Q[2] - Q[2 * n - 2]) / h) * total, ((Q[3] - Q[2 * n - 1]) / h) * total];
  }
  // Tridiagonal system for control points 1..n+1 (0 and n+2 are the ends):
  // a fixed end derivative, or zero second derivative, then one row per
  // interior fit point.
  const m = n + 1;
  const sub = new Float64Array(m),
    dia = new Float64Array(m),
    sup = new Float64Array(m),
    rx = new Float64Array(m),
    ry = new Float64Array(m);
  const a = knots[4],
    b = knots[5];
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
  const N = new Float64Array(4);
  for (let k = 1; k < n; k++) {
    basisFuns(k + 3, knots[k + 3], 3, knots, N);
    sub[k] = N[0];
    dia[k] = N[1];
    sup[k] = N[2];
    rx[k] = Q[2 * k];
    ry[k] = Q[2 * k + 1];
  }
  const L = knots.length;
  const c = 1 - knots[L - 5],
    d = 1 - knots[L - 6];
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
  // Thomas algorithm.
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

/** Spline from control points with clamped uniform knots: { degree, ctrl, knots }. */
export function splineFromControlPoints(ctrl, degree = 3) {
  const nc = ctrl.length >> 1;
  const p = Math.max(1, Math.min(degree | 0 || 3, nc - 1));
  return { degree: p, ctrl: ctrl.slice(), knots: nc >= 2 ? clampedUniformKnots(nc, p) : [] };
}

/**
 * Sample a spline adaptively so the chord deviation stays within tol.
 * Returns { pts: flat [x, y, ...], us: parameters }.
 */
export function sampleSpline(s, tol) {
  const ctrl = s.ctrl;
  const nc = ctrl.length >> 1;
  const pts = [],
    us = [];
  if (nc < 2) {
    if (nc === 1) {
      pts.push(ctrl[0], ctrl[1]);
      us.push(0);
    }
    return { pts, us };
  }
  const p = degreeOf(s);
  const U = knotsOf(s, p);
  if (!(tol > 0)) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0; i < ctrl.length; i += 2) {
      x0 = Math.min(x0, ctrl[i]);
      x1 = Math.max(x1, ctrl[i]);
      y0 = Math.min(y0, ctrl[i + 1]);
      y1 = Math.max(y1, ctrl[i + 1]);
    }
    tol = Math.max(x1 - x0, y1 - y0) * 1e-3 || 1e-6;
  }
  const MAX = 65536;
  const first = evalSplineFull(s, U[p]);
  pts.push(first.x, first.y);
  us.push(U[p]);
  if (p === 1) {
    for (let k = p + 1; k <= nc; k++) {
      if (U[k] <= U[k - 1]) continue;
      const q = evalSplineFull(s, U[k]);
      pts.push(q.x, q.y);
      us.push(U[k]);
    }
    return { pts, us };
  }
  const sub = (ua, ax, ay, ub, bx, by, depth) => {
    const um = (ua + ub) / 2;
    const m = evalSplineFull(s, um);
    const cx = bx - ax,
      cy = by - ay;
    const cl = Math.hypot(cx, cy);
    const dev = cl > 0 ? Math.abs(cx * (m.y - ay) - cy * (m.x - ax)) / cl : Math.hypot(m.x - ax, m.y - ay);
    if (depth < 18 && dev > tol && pts.length < 2 * MAX) {
      sub(ua, ax, ay, um, m.x, m.y, depth + 1);
      sub(um, m.x, m.y, ub, bx, by, depth + 1);
    } else {
      pts.push(bx, by);
      us.push(ub);
    }
  };
  const INIT = 4;
  for (let k = p; k < nc; k++) {
    const ua = U[k],
      ub = U[k + 1];
    if (!(ub > ua)) continue;
    let px = pts[pts.length - 2],
      py = pts[pts.length - 1],
      pu = ua;
    for (let i = 1; i <= INIT; i++) {
      const uu = i === INIT ? ub : ua + ((ub - ua) * i) / INIT;
      const q = evalSplineFull(s, uu);
      sub(pu, px, py, uu, q.x, q.y, 0);
      px = q.x;
      py = q.y;
      pu = uu;
    }
  }
  return { pts, us };
}

/** Flat [x, y, ...] polyline approximating a spline within tol. */
export function tessellateSpline(s, tol) {
  return sampleSpline(s, tol).pts;
}

/** Insert knot u (domain interior) until its multiplicity is `times` more. */
function insertKnot(p, U, P, u, times) {
  for (let r = 0; r < times; r++) {
    const nc = P.length >> 1;
    const k = findSpan(nc, p, u, U);
    const Q = new Array(P.length + 2);
    for (let i = 0; i <= k - p; i++) {
      Q[2 * i] = P[2 * i];
      Q[2 * i + 1] = P[2 * i + 1];
    }
    for (let i = k - p + 1; i <= k; i++) {
      const den = U[i + p] - U[i];
      const a = den > 0 ? (u - U[i]) / den : 0;
      Q[2 * i] = a * P[2 * i] + (1 - a) * P[2 * i - 2];
      Q[2 * i + 1] = a * P[2 * i + 1] + (1 - a) * P[2 * i - 1];
    }
    for (let i = k + 1; i <= nc; i++) {
      Q[2 * i] = P[2 * i - 2];
      Q[2 * i + 1] = P[2 * i - 1];
    }
    U.splice(k + 1, 0, u);
    P = Q;
  }
  return P;
}

/**
 * Split a spline at parameter u. Returns [left, right] as { degree, ctrl,
 * knots }, with null for a side that would be empty.
 */
export function splitSpline(s, u) {
  const nc = s.ctrl.length >> 1;
  if (nc < 2) return [null, null];
  const p = degreeOf(s);
  const U = knotsOf(s, p).slice();
  const [d0, d1] = [U[p], U[nc]];
  const tol = 1e-12 * Math.max(1, Math.abs(d0), Math.abs(d1));
  const whole = { degree: p, ctrl: s.ctrl.slice(), knots: U.slice() };
  if (u <= d0 + tol) return [null, whole];
  if (u >= d1 - tol) return [whole, null];
  let mult = 0;
  for (const k of U) if (Math.abs(k - u) <= tol) mult++;
  let P = s.ctrl.slice();
  if (mult < p) P = insertKnot(p, U, P, u, p - mult);
  // First index f of u in U.
  let f = 0;
  while (f < U.length && !(Math.abs(U[f] - u) <= tol)) f++;
  const left = { degree: p, ctrl: P.slice(0, 2 * f), knots: U.slice(0, f + p).concat([u]) };
  const right = { degree: p, ctrl: P.slice(2 * (f - 1)), knots: [u].concat(U.slice(f)) };
  return [left, right];
}

/** Part of a spline between parameters u0 < u1, or null. */
export function subSpline(s, u0, u1) {
  if (!(u1 > u0)) return null;
  const [, right] = splitSpline(s, u0);
  if (!right) return null;
  const [left] = splitSpline(right, u1);
  return left;
}

/** Join spline b after spline a (b must start where a ends; same degree). */
export function joinSplines(a, b) {
  const p = a.degree;
  const aEnd = a.knots[a.knots.length - 1];
  const shift = aEnd - b.knots[0];
  const knots = a.knots.slice(0, a.knots.length - 1);
  for (let i = p + 1; i < b.knots.length; i++) knots.push(b.knots[i] + shift);
  return { degree: p, ctrl: a.ctrl.concat(b.ctrl.slice(2)), knots };
}
