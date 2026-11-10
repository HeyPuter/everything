/**
 * Nearest points on primitives and entities.
 */
import { TWO_PI, angleInSweep, sweepOffset, clamp } from './vec.js';
import { ellipseClosestParam, ellipsePoint, ellipseAxes } from './ellipse.js';
import { toPrims } from './prims.js';
import { curveAt } from './intersect.js';

/**
 * Closest point on a primitive: { x, y, d2, t } with t in the primitive's
 * parameter convention (see intersect.js).
 */
export function closestOnPrim(p, x, y) {
  switch (p.t) {
    case 'seg': {
      const dx = p.x2 - p.x1,
        dy = p.y2 - p.y1;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? clamp(((x - p.x1) * dx + (y - p.y1) * dy) / l2, 0, 1) : 0;
      const qx = p.x1 + dx * t,
        qy = p.y1 + dy * t;
      return { x: qx, y: qy, d2: (qx - x) ** 2 + (qy - y) ** 2, t };
    }
    case 'inf': {
      let t = (x - p.x) * p.dx + (y - p.y) * p.dy;
      if (p.ray && t < 0) t = 0;
      const qx = p.x + p.dx * t,
        qy = p.y + p.dy * t;
      return { x: qx, y: qy, d2: (qx - x) ** 2 + (qy - y) ** 2, t };
    }
    case 'arc': {
      const sw = p.a1 - p.a0;
      const vx = x - p.cx,
        vy = y - p.cy;
      let ang = vx === 0 && vy === 0 ? p.a0 : Math.atan2(vy, vx);
      if (!(p.full || sw >= TWO_PI) && !angleInSweep(ang, p.a0, sw)) {
        const ex = p.cx + p.r * Math.cos(p.a1),
          ey = p.cy + p.r * Math.sin(p.a1);
        const sx = p.cx + p.r * Math.cos(p.a0),
          sy = p.cy + p.r * Math.sin(p.a0);
        const ds = (sx - x) ** 2 + (sy - y) ** 2,
          de = (ex - x) ** 2 + (ey - y) ** 2;
        return ds <= de ? { x: sx, y: sy, d2: ds, t: p.a0 } : { x: ex, y: ey, d2: de, t: p.a1 };
      }
      const qx = p.cx + p.r * Math.cos(ang),
        qy = p.cy + p.r * Math.sin(ang);
      return { x: qx, y: qy, d2: (qx - x) ** 2 + (qy - y) ** 2, t: p.a0 + sweepOffset(ang, p.a0, sw) };
    }
    case 'pl':
      return closestOnPl(p, x, y);
    default:
      return null;
  }
}

/** Closest point on a curve approximation, refined on the exact curve. */
function closestOnPl(p, x, y) {
  const src = p.src;
  if (src.type === 'ellipse') {
    const t = ellipseClosestParam(src, x, y);
    const q = ellipsePoint(src, t);
    let u = t;
    const u0 = p.us[0];
    while (u < u0 - 1e-12) u += TWO_PI;
    while (u > u0 + TWO_PI + 1e-12) u -= TWO_PI;
    return { x: q.x, y: q.y, d2: (q.x - x) ** 2 + (q.y - y) ** 2, t: u };
  }
  const pts = p.pts,
    us = p.us;
  const n = (pts.length >> 1) - 1;
  if (n < 1) return { x: pts[0], y: pts[1], d2: (pts[0] - x) ** 2 + (pts[1] - y) ** 2, t: us[0] };
  let best = 0,
    bestS = 0,
    bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const x1 = pts[2 * i],
      y1 = pts[2 * i + 1];
    const dx = pts[2 * i + 2] - x1,
      dy = pts[2 * i + 3] - y1;
    const l2 = dx * dx + dy * dy;
    const s = l2 > 0 ? clamp(((x - x1) * dx + (y - y1) * dy) / l2, 0, 1) : 0;
    const d = (x1 + dx * s - x) ** 2 + (y1 + dy * s - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
      bestS = s;
    }
  }
  const lo = us[Math.max(0, best - 1)],
    hi = us[Math.min(n, best + 2)];
  const u0 = us[best] + (us[best + 1] - us[best]) * bestS;
  let u = u0;
  // Solve g(u) = (C(u) - P) . C'(u) = 0 near u (Gauss-Newton, kept in [lo, hi]).
  for (let it = 0; it < 30; it++) {
    const c = curveAt(src, u);
    const g = (c.x - x) * c.dx + (c.y - y) * c.dy;
    const h = c.dx * c.dx + c.dy * c.dy;
    if (!(h > 0)) break;
    let un = u - g / h;
    if (un < lo) un = lo;
    if (un > hi) un = hi;
    if (Math.abs(un - u) <= 1e-14 * Math.max(1, Math.abs(u))) {
      u = un;
      break;
    }
    u = un;
  }
  const c = curveAt(src, u);
  const d = (c.x - x) ** 2 + (c.y - y) ** 2;
  // Should that diverge, fall back to the curve (not the chord, which can be
  // closer to the point than the curve is) at the starting parameter.
  const c0 = curveAt(src, u0);
  const d0 = (c0.x - x) ** 2 + (c0.y - y) ** 2;
  if (d <= d0) return { x: c.x, y: c.y, d2: d, t: u };
  return { x: c0.x, y: c0.y, d2: d0, t: u0 };
}

/** Closest point among a list of primitives: { x, y, d2, t, prim }. */
export function closestOnPrims(prims, x, y) {
  let best = null;
  for (const p of prims) {
    const c = closestOnPrim(p, x, y);
    if (c && (!best || c.d2 < best.d2)) {
      best = c;
      best.prim = p;
    }
  }
  return best;
}

/**
 * Nearest point on an entity: { x, y, d, t, prim } or null for entities
 * without geometry here (text, mtext, dimension, insert).
 */
export function closestPoint(ent, x, y) {
  if (ent.type === 'point') return { x: ent.x, y: ent.y, d: Math.hypot(ent.x - x, ent.y - y), t: 0, prim: null };
  if (ent.type === 'ellipse') {
    if (!(ellipseAxes(ent).a > 0)) return { x: ent.cx, y: ent.cy, d: Math.hypot(ent.cx - x, ent.cy - y), t: 0, prim: null };
    const t = ellipseClosestParam(ent, x, y);
    const q = ellipsePoint(ent, t);
    return { x: q.x, y: q.y, d: Math.hypot(q.x - x, q.y - y), t, prim: null };
  }
  const prims = toPrims(ent);
  if (!prims.length) {
    if (ent.type === 'circle' || ent.type === 'arc') return { x: ent.cx, y: ent.cy, d: Math.hypot(ent.cx - x, ent.cy - y), t: 0, prim: null };
    if (ent.type === 'polyline' && ent.pts.length >= 2) {
      return { x: ent.pts[0], y: ent.pts[1], d: Math.hypot(ent.pts[0] - x, ent.pts[1] - y), t: 0, prim: null };
    }
    return null;
  }
  const b = closestOnPrims(prims, x, y);
  if (!b) return null;
  return { x: b.x, y: b.y, d: Math.sqrt(b.d2), t: b.t, prim: b.prim };
}

/** Distance from (x, y) to an entity (Infinity when it has no geometry). */
export function distanceTo(ent, x, y) {
  const c = closestPoint(ent, x, y);
  return c ? c.d : Infinity;
}
