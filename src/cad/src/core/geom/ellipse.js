/**
 * Ellipse helpers. An ellipse entity is P(t) = C + M cos t + N sin t where
 * M = (mx, my) is the major semi-axis and N = ratio * (-my, mx) the minor
 * semi-axis. t is the parametric angle; arcs run CCW from start to end.
 */
import { TWO_PI, normAngle, ccwSweep, angleInSweep, sweepOffset, clamp } from './vec.js';

/** Semi-axes { a, b, ux, uy } (ux, uy = unit major direction). */
export function ellipseAxes(e) {
  const a = Math.hypot(e.mx, e.my);
  const ux = a > 0 ? e.mx / a : 1,
    uy = a > 0 ? e.my / a : 0;
  return { a, b: a * Math.abs(e.ratio), ux, uy };
}

/** True when the ellipse is closed (start and end describe a full turn). */
export function isFullEllipse(e) {
  const s = e.start ?? 0,
    t = e.end ?? TWO_PI;
  return Math.abs(t - s) >= TWO_PI - 1e-12 || normAngle(t - s) === 0;
}

/** Parametric sweep of an ellipse in (0, 2PI]. */
export function ellipseSweep(e) {
  return isFullEllipse(e) ? TWO_PI : ccwSweep(e.start, e.end);
}

/** Point at parameter t. */
export function ellipsePoint(e, t) {
  const c = Math.cos(t),
    s = Math.sin(t),
    r = e.ratio;
  return { x: e.cx + e.mx * c - r * e.my * s, y: e.cy + e.my * c + r * e.mx * s };
}

/** Derivative dP/dt at parameter t. */
export function ellipseDeriv(e, t) {
  const c = Math.cos(t),
    s = Math.sin(t),
    r = e.ratio;
  return { x: -e.mx * s - r * e.my * c, y: -e.my * s + r * e.mx * c };
}

/**
 * Parameter of a point: the parametric angle of the point after mapping the
 * ellipse to a unit circle (exact for points on the ellipse).
 */
export function ellipseParamOf(e, x, y) {
  const { a, b, ux, uy } = ellipseAxes(e);
  const dx = x - e.cx,
    dy = y - e.cy;
  const u = (dx * ux + dy * uy) / (a || 1);
  const v = (-dx * uy + dy * ux) / (b || 1);
  return normAngle(Math.atan2(v, u));
}

/**
 * Parameter of the closest point on the full ellipse to (x, y). Solves the
 * normal-foot equation in the axis frame with a safeguarded Newton iteration.
 */
export function ellipseClosestParamFull(e, x, y) {
  const { a, b, ux, uy } = ellipseAxes(e);
  const dx = x - e.cx,
    dy = y - e.cy;
  let u = dx * ux + dy * uy;
  let v = -dx * uy + dy * ux;
  if (!(a > 0)) return 0;
  const su = u < 0 ? -1 : 1,
    sv = v < 0 ? -1 : 1;
  u = Math.abs(u);
  v = Math.abs(v);
  let px, py;
  if (!(b > a * 1e-12)) {
    // Degenerate (flat) ellipse: closest point on the major axis segment.
    const t = Math.acos(clamp((su * u) / a, -1, 1));
    return normAngle(sv < 0 ? -t : t);
  }
  if (v > 0) {
    if (u > 0) {
      // F(t) = (a u / (t + a^2))^2 + (b v / (t + b^2))^2 - 1, decreasing on t > -b^2.
      const a2 = a * a,
        b2 = b * b;
      const au = a * u,
        bv = b * v;
      let lo = -b2 + bv;
      let hi = -b2 + Math.hypot(au, bv);
      let t = hi;
      for (let it = 0; it < 64; it++) {
        const p = au / (t + a2),
          q = bv / (t + b2);
        const f = p * p + q * q - 1;
        if (f > 0) lo = t;
        else hi = t;
        const df = (-2 * p * p) / (t + a2) - (2 * q * q) / (t + b2);
        let tn = df < 0 ? t - f / df : (lo + hi) / 2;
        if (!(tn > lo && tn < hi)) tn = (lo + hi) / 2;
        if (Math.abs(tn - t) <= 1e-15 * Math.max(1, Math.abs(t)) || hi - lo <= 1e-15 * Math.max(1, Math.abs(hi))) {
          t = tn;
          break;
        }
        t = tn;
      }
      px = (a2 * u) / (t + a2);
      py = (b2 * v) / (t + b2);
      if (!(t + b2 > 1e-4 * b2)) {
        // A hair off the major axis the root sits on the pole at -b^2 and py
        // is noise (or 0 / 0): take the point of the ellipse above px unless
        // the computed one is closer.
        const pc = Math.min(1, px / a);
        const qx = a * pc,
          qy = b * Math.sqrt(1 - pc * pc);
        const n = Math.hypot(px / a, py / b);
        const rx = px / n,
          ry = py / n;
        if (!((rx - u) ** 2 + (ry - v) ** 2 <= (qx - u) ** 2 + (qy - v) ** 2)) {
          px = qx;
          py = qy;
        }
      }
    } else {
      px = 0;
      py = b;
    }
  } else {
    const d = a * a - b * b;
    if (a * u < d) {
      px = (a * a * u) / d;
      const r = px / a;
      py = b * Math.sqrt(Math.max(0, 1 - r * r));
    } else {
      px = a;
      py = 0;
    }
  }
  return normAngle(Math.atan2((sv * py) / b, (su * px) / a));
}

/**
 * Parameter of the closest point on an ellipse or elliptical arc to (x, y).
 * Returns a parameter inside [start, start + sweep] expressed as an absolute
 * parametric angle.
 */
export function ellipseClosestParam(e, x, y) {
  const t = ellipseClosestParamFull(e, x, y);
  if (isFullEllipse(e)) return t;
  const t0 = normAngle(e.start);
  const sw = ellipseSweep(e);
  if (angleInSweep(t, t0, sw, 1e-12)) return t;
  // The global foot is outside the arc: compare the end points and any
  // interior local minimum found by sampling and Newton refinement.
  let best = t0,
    bestD = d2At(e, t0, x, y);
  const te = t0 + sw;
  const de = d2At(e, te, x, y);
  if (de < bestD) {
    best = te;
    bestD = de;
  }
  const N = 32;
  let si = -1,
    sd = Infinity;
  for (let i = 1; i < N; i++) {
    const d = d2At(e, t0 + (sw * i) / N, x, y);
    if (d < sd) {
      sd = d;
      si = i;
    }
  }
  if (si > 0 && sd < bestD) {
    const tr = refineFoot(e, t0 + (sw * si) / N, t0 + (sw * (si - 1)) / N, t0 + (sw * (si + 1)) / N, x, y);
    const dr = d2At(e, tr, x, y);
    if (dr < bestD) best = tr;
  }
  return best;
}

function d2At(e, t, x, y) {
  const p = ellipsePoint(e, t);
  const dx = p.x - x,
    dy = p.y - y;
  return dx * dx + dy * dy;
}

/** Newton iteration on (P(t) - Q) . P'(t) = 0 kept inside [lo, hi]. */
function refineFoot(e, t, lo, hi, x, y) {
  for (let it = 0; it < 30; it++) {
    const p = ellipsePoint(e, t);
    const d = ellipseDeriv(e, t);
    // Second derivative is -(P - C).
    const ddx = -(p.x - e.cx),
      ddy = -(p.y - e.cy);
    const rx = p.x - x,
      ry = p.y - y;
    const g = rx * d.x + ry * d.y;
    const dg = d.x * d.x + d.y * d.y + rx * ddx + ry * ddy;
    if (!(Math.abs(dg) > 0)) break;
    let tn = t - g / dg;
    if (tn < lo) tn = lo;
    if (tn > hi) tn = hi;
    if (Math.abs(tn - t) < 1e-15) {
      t = tn;
      break;
    }
    t = tn;
  }
  return t;
}

/** Offset of parameter t along the arc from start, near-start values negative. */
export function ellipseParamOffset(e, t) {
  return sweepOffset(t, normAngle(e.start), ellipseSweep(e));
}

/** Parametric angle values where x and y reach extremes ([tx, ty]). */
export function ellipseExtremeParams(e) {
  const r = e.ratio;
  // x(t) = cx + mx cos t - r my sin t ; y(t) = cy + my cos t + r mx sin t
  return [Math.atan2(-r * e.my, e.mx), Math.atan2(r * e.mx, e.my)];
}
