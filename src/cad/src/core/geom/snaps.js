/**
 * Object snap candidates. Every function returns an array of { x, y }.
 */
import { TWO_PI, HALF_PI, normAngle, ccwSweep, angleInSweep, dedupePoints, tolFor } from './vec.js';
import { arcFromBulge, bulgeMidpoint } from './bulge.js';
import { ellipseAxes, ellipsePoint, ellipseSweep, isFullEllipse } from './ellipse.js';
import { evalSpline, splineDomain } from './spline.js';
import { toPrims } from './prims.js';
import { curveAt, primSize, hitMergeTol } from './intersect.js';
import { centroidPolyline } from './measure.js';

/** Visit every segment of a stride-3 bulged point list. */
function eachBulgeSeg(pts, closed, fn) {
  const n = Math.floor(pts.length / 3);
  if (n < 2) return;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = i * 3,
      b = ((i + 1) % n) * 3;
    fn(pts[a], pts[a + 1], pts[b], pts[b + 1], pts[a + 2], i);
  }
}

function vertices(pts, stride) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i += stride) out.push({ x: pts[i], y: pts[i + 1] });
  return out;
}

/** End points (and polyline / leader vertices). */
export function endpoints(ent) {
  switch (ent.type) {
    case 'line':
      return [
        { x: ent.x1, y: ent.y1 },
        { x: ent.x2, y: ent.y2 },
      ];
    case 'arc':
      return [
        { x: ent.cx + ent.r * Math.cos(ent.start), y: ent.cy + ent.r * Math.sin(ent.start) },
        { x: ent.cx + ent.r * Math.cos(ent.end), y: ent.cy + ent.r * Math.sin(ent.end) },
      ];
    case 'ellipse':
      if (isFullEllipse(ent)) return [];
      return [ellipsePoint(ent, ent.start), ellipsePoint(ent, ent.end)];
    case 'polyline':
      return vertices(ent.pts, 3);
    case 'spline': {
      if (!ent.ctrl || ent.ctrl.length < 4) return [];
      const [u0, u1] = splineDomain(ent);
      const a = evalSpline(ent, u0);
      return ent.closed ? [a] : [a, evalSpline(ent, u1)];
    }
    case 'ray':
      return [{ x: ent.x, y: ent.y }];
    case 'leader':
      return vertices(ent.pts, 2);
    case 'hatch': {
      const out = [];
      for (const l of ent.loops || []) for (const p of vertices(l, 3)) out.push(p);
      return out;
    }
    default:
      return [];
  }
}

/** Midpoints of lines, arcs and each polyline / leader / hatch segment. */
export function midpoints(ent) {
  switch (ent.type) {
    case 'line':
      return [{ x: (ent.x1 + ent.x2) / 2, y: (ent.y1 + ent.y2) / 2 }];
    case 'arc': {
      const a = ent.start + ccwSweep(ent.start, ent.end) / 2;
      return [{ x: ent.cx + ent.r * Math.cos(a), y: ent.cy + ent.r * Math.sin(a) }];
    }
    case 'polyline': {
      const out = [];
      eachBulgeSeg(ent.pts, !!ent.closed, (x1, y1, x2, y2, b) => {
        if (x1 !== x2 || y1 !== y2) out.push(bulgeMidpoint(x1, y1, x2, y2, b));
      });
      return out;
    }
    case 'leader': {
      const out = [];
      const p = ent.pts;
      for (let i = 0; i + 3 < p.length; i += 2) out.push({ x: (p[i] + p[i + 2]) / 2, y: (p[i + 1] + p[i + 3]) / 2 });
      return out;
    }
    case 'hatch': {
      const out = [];
      for (const l of ent.loops || []) eachBulgeSeg(l, true, (x1, y1, x2, y2, b) => out.push(bulgeMidpoint(x1, y1, x2, y2, b)));
      return out;
    }
    default:
      return [];
  }
}

/** Centers of circles, arcs, ellipses and polyline arc segments. */
export function centers(ent) {
  switch (ent.type) {
    case 'circle':
    case 'arc':
    case 'ellipse':
      return [{ x: ent.cx, y: ent.cy }];
    case 'polyline': {
      const out = [];
      eachBulgeSeg(ent.pts, !!ent.closed, (x1, y1, x2, y2, b) => {
        const a = arcFromBulge(x1, y1, x2, y2, b);
        if (a) out.push({ x: a.cx, y: a.cy });
      });
      return dedupePoints(out, tolFor(out[0]?.x ?? 0, out[0]?.y ?? 0));
    }
    default:
      return [];
  }
}

function circleQuads(out, cx, cy, r, a0, sweep) {
  for (let q = 0; q < 4; q++) {
    const a = q * HALF_PI;
    if (sweep >= TWO_PI || angleInSweep(a, normAngle(a0), sweep, 1e-12)) out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/** Quadrant points (0, 90, 180, 270 degrees) that lie on the curve. */
export function quadrants(ent) {
  switch (ent.type) {
    case 'circle':
      return circleQuads([], ent.cx, ent.cy, ent.r, 0, TWO_PI);
    case 'arc':
      return circleQuads([], ent.cx, ent.cy, ent.r, ent.start, ccwSweep(ent.start, ent.end));
    case 'ellipse': {
      const out = [];
      const full = isFullEllipse(ent);
      const sw = ellipseSweep(ent);
      for (let q = 0; q < 4; q++) {
        const t = q * HALF_PI;
        if (full || angleInSweep(t, normAngle(ent.start), sw, 1e-12)) out.push(ellipsePoint(ent, t));
      }
      return out;
    }
    case 'polyline': {
      const out = [];
      eachBulgeSeg(ent.pts, !!ent.closed, (x1, y1, x2, y2, b) => {
        const a = arcFromBulge(x1, y1, x2, y2, b);
        if (!a) return;
        if (a.sweep > 0) circleQuads(out, a.cx, a.cy, a.r, a.a0, a.sweep);
        else circleQuads(out, a.cx, a.cy, a.r, a.a1, -a.sweep);
      });
      return out;
    }
    default:
      return [];
  }
}

/** Node points (point entities). */
export function nodes(ent) {
  return ent.type === 'point' ? [{ x: ent.x, y: ent.y }] : [];
}

/** Critical points of the distance from (bx, by) on a curve primitive. */
function plFeet(p, bx, by, out) {
  const us = p.us,
    src = p.src;
  const n = us.length;
  const g = (c) => (c.x - bx) * c.dx + (c.y - by) * c.dy;
  let prev = curveAt(src, us[0]);
  let gp = g(prev);
  for (let i = 1; i < n; i++) {
    const cur = curveAt(src, us[i]);
    const gc = g(cur);
    if (gc === 0) out.push({ x: cur.x, y: cur.y });
    else if (gp * gc < 0) {
      let a = us[i - 1],
        b = us[i],
        fa = gp,
        fb = gc,
        side = 0,
        u = a;
      for (let it = 0; it < 60; it++) {
        u = (a * fb - b * fa) / (fb - fa);
        const fu = g(curveAt(src, u));
        if (fu === 0) break;
        if (fu * fb > 0) {
          b = u;
          fb = fu;
          if (side === -1) fa /= 2;
          side = -1;
        } else {
          a = u;
          fa = fu;
          if (side === 1) fb /= 2;
          side = 1;
        }
        if (Math.abs(b - a) <= 1e-15 * Math.max(1, Math.abs(u))) break;
      }
      const c = curveAt(src, u);
      out.push({ x: c.x, y: c.y });
    }
    prev = cur;
    gp = gc;
  }
}

/**
 * Feet of perpendiculars from (bx, by) that lie on the entity itself (lines
 * are not extended).
 */
export function perpendicularFrom(ent, bx, by) {
  const out = [];
  let size = 0;
  for (const p of toPrims(ent)) {
    size = Math.max(size, primSize(p));
    if (p.t === 'seg') {
      const dx = p.x2 - p.x1,
        dy = p.y2 - p.y1;
      const l2 = dx * dx + dy * dy;
      if (!(l2 > 0)) continue;
      const t = ((bx - p.x1) * dx + (by - p.y1) * dy) / l2;
      const e = 1e-12;
      if (t >= -e && t <= 1 + e) out.push({ x: p.x1 + dx * t, y: p.y1 + dy * t });
    } else if (p.t === 'inf') {
      const t = (bx - p.x) * p.dx + (by - p.y) * p.dy;
      if (!p.ray || t >= 0) out.push({ x: p.x + p.dx * t, y: p.y + p.dy * t });
    } else if (p.t === 'arc') {
      const vx = bx - p.cx,
        vy = by - p.cy;
      if (vx === 0 && vy === 0) continue;
      const a = Math.atan2(vy, vx);
      const sw = p.a1 - p.a0;
      for (const ang of [a, a + Math.PI]) {
        if (p.full || angleInSweep(ang, p.a0, sw, 1e-12)) out.push({ x: p.cx + p.r * Math.cos(ang), y: p.cy + p.r * Math.sin(ang) });
      }
    } else if (p.t === 'pl') plFeet(p, bx, by, out);
  }
  return dedupePoints(out, hitMergeTol(tolFor(bx, by), size));
}

function circleTangents(out, cx, cy, r, a0, sweep, full, bx, by) {
  const vx = bx - cx,
    vy = by - cy;
  const d = Math.hypot(vx, vy);
  if (!(d > r * (1 + 1e-12))) return;
  const phi = Math.atan2(vy, vx);
  const al = Math.acos(r / d);
  for (const ang of [phi - al, phi + al]) {
    if (full || angleInSweep(ang, a0, sweep, 1e-12)) out.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
  }
}

/** Points where a line through (bx, by) touches a circle, arc or ellipse. */
export function tangentsFrom(ent, bx, by) {
  const out = [];
  if (ent.type === 'ellipse') {
    const { a, b, ux, uy } = ellipseAxes(ent);
    if (!(a > 0 && b > 0)) return out;
    const dx = bx - ent.cx,
      dy = by - ent.cy;
    const u = (dx * ux + dy * uy) / a,
      v = (-dx * uy + dy * ux) / b;
    const d = Math.hypot(u, v);
    if (!(d > 1 + 1e-12)) return out;
    const phi = Math.atan2(v, u),
      al = Math.acos(1 / d);
    const full = isFullEllipse(ent),
      sw = ellipseSweep(ent);
    for (const t of [phi - al, phi + al]) {
      if (full || angleInSweep(t, normAngle(ent.start), sw, 1e-12)) out.push(ellipsePoint(ent, t));
    }
    return out;
  }
  for (const p of toPrims(ent)) {
    if (p.t === 'arc') circleTangents(out, p.cx, p.cy, p.r, p.a0, p.a1 - p.a0, p.full, bx, by);
  }
  return out;
}

/**
 * Geometric center: area centroid of a closed polyline, center of a circle
 * or full ellipse. Null otherwise.
 */
export function geometricCenter(ent) {
  if (ent.type === 'polyline' && ent.closed && ent.pts.length >= 6) {
    const c = centroidPolyline(ent.pts);
    return c ? { x: c.x, y: c.y } : null;
  }
  if (ent.type === 'circle' || (ent.type === 'ellipse' && isFullEllipse(ent))) return { x: ent.cx, y: ent.cy };
  return null;
}
