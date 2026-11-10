/**
 * Decomposition of entities into primitives for intersection, trimming and
 * snapping:
 *
 *   { t: 'seg', x1, y1, x2, y2 }
 *   { t: 'arc', cx, cy, r, a0, a1, full }   CCW from a0 to a1, a0 in [0, 2PI),
 *                                           a1 = a0 + sweep (may exceed 2PI);
 *                                           full circles have a0 = 0, a1 = 2PI
 *   { t: 'inf', x, y, dx, dy, ray }         xline (ray = false) or ray
 *   { t: 'pl', pts, us, src, dev }          flat polyline approximation of an
 *                                           ellipse or spline; us[i] is the curve
 *                                           parameter of vertex i, src the entity
 *                                           and dev the chord tolerance it was
 *                                           sampled with
 *
 * Primitives from polylines, leaders and hatch loops carry `seg` (index of the
 * source segment); bulge arcs traversed clockwise also carry `rev: true`.
 * Hatch primitives carry `loop` (loop index).
 */
import { TWO_PI, normAngle, ccwSweep } from './vec.js';
import { arcFromBulge, BULGE_EPS } from './bulge.js';
import { ellipseAxes, ellipseSweep, isFullEllipse } from './ellipse.js';
import { appendEllipse, ellipseSegments } from './tessellate.js';
import { sampleSpline } from './spline.js';

/** Relative tolerance used for curve approximations inside primitives. */
export const PL_REL_TOL = 1e-4;

/** Push the primitive of one bulged segment (skips zero-length ones). */
export function bulgeSegPrim(out, x1, y1, x2, y2, b, seg) {
  if (x1 === x2 && y1 === y2) return out;
  if (!(Math.abs(b) > BULGE_EPS)) {
    out.push({ t: 'seg', x1, y1, x2, y2, seg });
    return out;
  }
  const a = arcFromBulge(x1, y1, x2, y2, b);
  if (a.sweep > 0) {
    const a0 = normAngle(a.a0);
    out.push({ t: 'arc', cx: a.cx, cy: a.cy, r: a.r, a0, a1: a0 + a.sweep, full: false, seg });
  } else {
    const a0 = normAngle(a.a1);
    out.push({ t: 'arc', cx: a.cx, cy: a.cy, r: a.r, a0, a1: a0 - a.sweep, full: false, seg, rev: true });
  }
  return out;
}

function bulgeListPrims(out, pts, closed, loop) {
  const n = Math.floor(pts.length / 3);
  if (n < 2) return out;
  const segs = closed ? n : n - 1;
  const start = out.length;
  for (let i = 0; i < segs; i++) {
    const a = i * 3,
      b = ((i + 1) % n) * 3;
    bulgeSegPrim(out, pts[a], pts[a + 1], pts[b], pts[b + 1], pts[a + 2], i);
  }
  if (loop !== undefined) for (let i = start; i < out.length; i++) out[i].loop = loop;
  return out;
}

/** Flat polyline primitive for an ellipse (us = parametric angles). */
export function ellipsePrim(e, relTol = PL_REL_TOL) {
  const { a } = ellipseAxes(e);
  const full = isFullEllipse(e);
  const sw = ellipseSweep(e);
  const t0 = full ? 0 : normAngle(e.start);
  const n = Math.max(full ? 16 : 4, ellipseSegments(e, sw, a * relTol));
  const pts = appendEllipse([], e, t0, sw, n);
  const us = new Array(n + 1);
  for (let i = 0; i <= n; i++) us[i] = t0 + (sw * i) / n;
  return { t: 'pl', pts, us, src: e, dev: a * relTol };
}

/** Flat polyline primitive for a spline (us = knot parameters). */
export function splinePrim(s, relTol = PL_REL_TOL) {
  const c = s.ctrl;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i + 1 < c.length; i += 2) {
    if (c[i] < x0) x0 = c[i];
    if (c[i] > x1) x1 = c[i];
    if (c[i + 1] < y0) y0 = c[i + 1];
    if (c[i + 1] > y1) y1 = c[i + 1];
  }
  const size = Math.max(x1 - x0, y1 - y0);
  const dev = size > 0 ? size * relTol : 1e-9;
  const { pts, us } = sampleSpline(s, dev);
  return { t: 'pl', pts, us, src: s, dev };
}

/** Decompose an entity into primitives (see module comment). */
export function toPrims(ent) {
  switch (ent.type) {
    case 'line':
      return [{ t: 'seg', x1: ent.x1, y1: ent.y1, x2: ent.x2, y2: ent.y2 }];
    case 'xline':
    case 'ray': {
      const l = Math.hypot(ent.dx, ent.dy);
      if (!(l > 0)) return [];
      return [{ t: 'inf', x: ent.x, y: ent.y, dx: ent.dx / l, dy: ent.dy / l, ray: ent.type === 'ray' }];
    }
    case 'circle':
      return ent.r > 0 ? [{ t: 'arc', cx: ent.cx, cy: ent.cy, r: ent.r, a0: 0, a1: TWO_PI, full: true }] : [];
    case 'arc': {
      if (!(ent.r > 0)) return [];
      const a0 = normAngle(ent.start);
      return [{ t: 'arc', cx: ent.cx, cy: ent.cy, r: ent.r, a0, a1: a0 + ccwSweep(ent.start, ent.end), full: false }];
    }
    case 'ellipse':
      return ellipseAxes(ent).a > 0 ? [ellipsePrim(ent)] : [];
    case 'spline':
      return ent.ctrl && ent.ctrl.length >= 4 ? [splinePrim(ent)] : [];
    case 'polyline':
      return bulgeListPrims([], ent.pts, !!ent.closed);
    case 'leader': {
      const out = [];
      const p = ent.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        if (p[i] === p[i + 2] && p[i + 1] === p[i + 3]) continue;
        out.push({ t: 'seg', x1: p[i], y1: p[i + 1], x2: p[i + 2], y2: p[i + 3], seg: i >> 1 });
      }
      return out;
    }
    case 'hatch': {
      const out = [];
      const loops = ent.loops || [];
      for (let k = 0; k < loops.length; k++) bulgeListPrims(out, loops[k], true, k);
      return out;
    }
    default:
      return [];
  }
}
