/**
 * Trim and extend.
 *
 * Every trimmable entity is given a one-dimensional parameter model: a
 * domain [lo, hi] (cyclic for closed curves), a mapping from primitive hits to
 * parameters, and a builder for the piece between two parameters. Trimming
 * removes the parameter interval around the pick point bounded by the nearest
 * cutting intersections.
 */
import { TWO_PI, normAngle, ccwSweep, tolFor } from './vec.js';
import { arcFromBulge, BULGE_EPS } from './bulge.js';
import { derive, update, lineFrom, arcFrom, polylineFrom } from './entity.js';
import { toPrims } from './prims.js';
import { intersectPrims, primBox, primScale, plSlack } from './intersect.js';
import { closestOnPrims } from './nearest.js';
import { segmentCount, subPolyline, vertexCount } from './poly.js';
import { isFullEllipse, ellipseSweep } from './ellipse.js';
import { splineDomain, subSpline, joinSplines } from './spline.js';

/** Parameter of a hit on prim p of a polyline: segment index + fraction. */
function polyParam(p, t) {
  if (p.t === 'seg') return p.seg + t;
  let f = (t - p.a0) / (p.a1 - p.a0);
  if (p.rev) f = 1 - f;
  return p.seg + f;
}

/**
 * Parameter model of an entity, or null when it cannot be trimmed:
 * { prims, lo, hi, cyclic, eps, param(prim, t), piece(u0, u1), point(u) }.
 */
export function paramModel(ent) {
  const prims = toPrims(ent);
  if (!prims.length) return null;
  switch (ent.type) {
    case 'line': {
      const dx = ent.x2 - ent.x1,
        dy = ent.y2 - ent.y1;
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) return null;
      const pt = (u) => ({ x: ent.x1 + dx * u, y: ent.y1 + dy * u });
      return {
        prims,
        lo: 0,
        hi: 1,
        cyclic: false,
        eps: tolFor(ent.x1, ent.y1, len) / len,
        param: (p, t) => t,
        point: pt,
        piece: (u0, u1) => {
          const a = pt(u0),
            b = pt(u1);
          return lineFrom(ent, a.x, a.y, b.x, b.y);
        },
      };
    }
    case 'xline':
    case 'ray': {
      const p0 = prims[0];
      const pt = (u) => ({ x: p0.x + p0.dx * u, y: p0.y + p0.dy * u });
      const ray = ent.type === 'ray';
      return {
        prims,
        lo: ray ? 0 : -Infinity,
        hi: Infinity,
        cyclic: false,
        eps: tolFor(ent.x, ent.y),
        param: (p, t) => t,
        point: pt,
        piece: (u0, u1) => {
          if (u0 === -Infinity && u1 === Infinity) return derive(ent, ent.type, { x: ent.x, y: ent.y, dx: p0.dx, dy: p0.dy });
          if (u0 === -Infinity) {
            const b = pt(u1);
            return derive(ent, 'ray', { x: b.x, y: b.y, dx: 0 - p0.dx, dy: 0 - p0.dy });
          }
          const a = pt(u0);
          if (u1 === Infinity) return derive(ent, 'ray', { x: a.x, y: a.y, dx: p0.dx, dy: p0.dy });
          const b = pt(u1);
          return lineFrom(ent, a.x, a.y, b.x, b.y);
        },
      };
    }
    case 'circle':
    case 'arc': {
      const p0 = prims[0];
      const pt = (u) => ({ x: ent.cx + ent.r * Math.cos(u), y: ent.cy + ent.r * Math.sin(u) });
      return {
        prims,
        lo: p0.a0,
        hi: p0.a1,
        cyclic: ent.type === 'circle',
        eps: tolFor(ent.cx, ent.cy, ent.r) / ent.r,
        param: (p, t) => (ent.type === 'circle' ? normAngle(t) : t),
        point: pt,
        piece: (u0, u1) => arcFrom(ent, ent.cx, ent.cy, ent.r, normAngle(u0), normAngle(u1)),
      };
    }
    case 'ellipse': {
      const full = isFullEllipse(ent);
      const t0 = full ? 0 : normAngle(ent.start);
      return {
        prims,
        lo: t0,
        hi: t0 + ellipseSweep(ent),
        cyclic: full,
        eps: 1e-9,
        param: (p, t) => (full ? normAngle(t) : t),
        piece: (u0, u1) => derive(ent, 'ellipse', { cx: ent.cx, cy: ent.cy, mx: ent.mx, my: ent.my, ratio: ent.ratio, start: normAngle(u0), end: normAngle(u1) }),
      };
    }
    case 'polyline': {
      const closed = !!ent.closed;
      const m = segmentCount(ent.pts, closed);
      if (m === 0) return null;
      return {
        prims,
        lo: 0,
        hi: m,
        cyclic: closed,
        eps: 1e-9,
        param: polyParam,
        piece: (u0, u1) => {
          const pts = subPolyline(ent.pts, closed, u0, u1);
          return vertexCount(pts) >= 2 ? polylineFrom(ent, pts, false) : null;
        },
      };
    }
    case 'spline': {
      const [d0, d1] = splineDomain(ent);
      if (!(d1 > d0)) return null;
      const cyclic = !!ent.closed;
      const mk = (s) => (s ? derive(ent, 'spline', { degree: s.degree, ctrl: s.ctrl, knots: s.knots, fit: [], closed: false }) : null);
      return {
        prims,
        lo: d0,
        hi: d1,
        cyclic,
        eps: 1e-9 * (d1 - d0),
        param: (p, t) => t,
        piece: (u0, u1) => {
          const per = d1 - d0;
          if (u1 <= d1 + 1e-12 * per) return mk(subSpline(ent, u0, Math.min(u1, d1)));
          const a = subSpline(ent, u0, d1),
            b = subSpline(ent, d0, u1 - per);
          if (a && b) return mk(joinSplines(a, b));
          return mk(a || b);
        },
      };
    }
    default:
      return null;
  }
}

/** Box of a primitive grown past the intersection tolerance and a curve's chord error. */
function paddedBox(p) {
  const b = primBox(p);
  const pad = 1e-7 * Math.max(1, primScale(p)) + (p.t === 'pl' ? plSlack(p) : 0);
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

/** Sorted, de-duplicated parameters where cutter primitives cross the entity. */
function cutParams(model, cutters, opts) {
  const out = [];
  const per = model.hi - model.lo;
  // A cutter whose box is clear of a piece cannot cross it (extended ones
  // can): skipping those keeps a long polyline among many cutters fast.
  const boxes = opts?.extA || opts?.extB ? null : cutters.map(paddedBox);
  for (const p of model.prims) {
    const pb = boxes && paddedBox(p);
    for (let k = 0; k < cutters.length; k++) {
      const c = cutters[k];
      if (pb) {
        const cb = boxes[k];
        if (cb[0] > pb[2] || cb[2] < pb[0] || cb[1] > pb[3] || cb[3] < pb[1]) continue;
      }
      for (const h of intersectPrims(p, c, opts)) {
        let u = model.param(p, h.ta);
        if (model.cyclic) {
          u = model.lo + ((((u - model.lo) % per) + per) % per);
          if (model.hi - u <= model.eps) u = model.lo;
        }
        out.push(u);
      }
    }
  }
  out.sort((a, b) => a - b);
  const res = [];
  for (const u of out) if (!res.length || u - res[res.length - 1] > model.eps) res.push(u);
  if (model.cyclic && res.length > 1 && res[0] + per - res[res.length - 1] <= model.eps) res.pop();
  return res;
}

/** Parameter of the point of the entity closest to (px, py). */
function pickParam(model, px, py) {
  const c = closestOnPrims(model.prims, px, py);
  return c ? model.param(c.prim, c.t) : null;
}

/**
 * Trim ent with cutting primitives at the pick point (px, py). Returns
 * { remove: true, add: Entity[] } (added entities have no id) or null when
 * nothing would be trimmed.
 */
export function trimEntity(ent, cutters, px, py, opts) {
  const model = paramModel(ent);
  if (!model || !cutters?.length) return null;
  const u = pickParam(model, px, py);
  if (u === null) return null;
  const all = cutParams(model, cutters, opts);
  const { lo, hi, eps } = model;
  if (model.cyclic) {
    if (all.length < 2) return null;
    const per = hi - lo;
    let below = -Infinity,
      above = Infinity;
    for (const c of all) {
      if (c <= u && c > below) below = c;
      if (c > u && c < above) above = c;
    }
    if (below === -Infinity) below = all[all.length - 1] - per;
    if (above === Infinity) above = all[0] + per;
    // A pick past the last cut keeps [first cut, last cut]: shift it back a
    // period so models that only wrap once (splines) see it in their domain.
    const shift = above >= hi ? per : 0;
    const piece = model.piece(above - shift, below + per - shift);
    return { remove: true, add: piece ? [piece] : [] };
  }
  const cuts = all.filter((c) => c > lo + eps && c < hi - eps);
  if (!cuts.length) return null;
  let below = lo,
    above = hi;
  for (const c of cuts) {
    if (c <= u && c > below) below = c;
    if (c > u && c < above) above = c;
  }
  if (below === lo && above === hi) return null;
  const add = [];
  if (below > lo) {
    const p = model.piece(lo, below);
    if (p) add.push(p);
  }
  if (above < hi) {
    const p = model.piece(above, hi);
    if (p) add.push(p);
  }
  return { remove: true, add };
}

/** Nearest boundary parameter beyond `from` in direction dir (+1 / -1). */
function nearestBeyond(params, from, dir, eps, limit = Infinity) {
  let best = null;
  for (const t of params) {
    const d = (t - from) * dir;
    if (d > eps && d < limit && (best === null || d < (best - from) * dir)) best = t;
  }
  return best;
}

/** Hits of an extended primitive against boundaries: list of ta values. */
function extHits(prim, boundaries, opts) {
  const out = [];
  const o = { extA: true, extB: !!opts?.extendBoundaries };
  for (const b of boundaries) for (const h of intersectPrims(prim, b, o)) out.push(h);
  return out;
}

/** Extend the end of a straight or arc piece; returns the new end point info. */
function extendLineEnd(x1, y1, x2, y2, atEnd, boundaries, opts) {
  const prim = { t: 'seg', x1, y1, x2, y2 };
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!(len > 0)) return null;
  const eps = tolFor(x1, y1, len) / len;
  const ts = extHits(prim, boundaries, opts).map((h) => h.ta);
  const t = atEnd ? nearestBeyond(ts, 1, 1, eps) : nearestBeyond(ts, 0, -1, eps);
  if (t === null) return null;
  return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t };
}

/** New angular extension (radians, > 0) for an arc end, or null. */
function extendArcAngle(cx, cy, r, endAngle, ccwDir, sweepAbs, boundaries, opts) {
  const prim = { t: 'arc', cx, cy, r, a0: 0, a1: TWO_PI, full: true };
  const eps = tolFor(cx, cy, r) / r;
  let best = null;
  for (const h of extHits(prim, boundaries, opts)) {
    const d = ccwDir ? normAngle(h.ta - endAngle) : normAngle(endAngle - h.ta);
    if (d > eps && d < TWO_PI - sweepAbs - eps && (best === null || d < best)) best = d;
  }
  return best;
}

/**
 * Extend the end of ent nearest the pick point to the nearest boundary
 * intersection. Supports line, arc, ray and open polyline (first / last
 * segment, straight or arc). Returns an updated copy (same id) or null.
 * opts.extendBoundaries treats boundary edges as extended.
 */
export function extendEntity(ent, boundaries, px, py, opts) {
  if (!boundaries?.length) return null;
  switch (ent.type) {
    case 'line': {
      const dx = ent.x2 - ent.x1,
        dy = ent.y2 - ent.y1;
      const l2 = dx * dx + dy * dy;
      if (!(l2 > 0)) return null;
      const t = ((px - ent.x1) * dx + (py - ent.y1) * dy) / l2;
      const atEnd = t >= 0.5;
      const p = extendLineEnd(ent.x1, ent.y1, ent.x2, ent.y2, atEnd, boundaries, opts);
      if (!p) return null;
      return atEnd ? update(ent, { x2: p.x, y2: p.y }) : update(ent, { x1: p.x, y1: p.y });
    }
    case 'ray': {
      const p = extendLineEnd(ent.x, ent.y, ent.x + ent.dx, ent.y + ent.dy, false, boundaries, opts);
      return p ? update(ent, { x: p.x, y: p.y }) : null;
    }
    case 'arc': {
      const sw = ccwSweep(ent.start, ent.end);
      const a = Math.atan2(py - ent.cy, px - ent.cx);
      const off = normAngle(a - ent.start);
      // Pick in the second half of the sweep (or past its end) extends the end.
      const atEnd = off <= sw ? off >= sw / 2 : off - sw < TWO_PI - off;
      const d = extendArcAngle(ent.cx, ent.cy, ent.r, atEnd ? ent.end : ent.start, atEnd, sw, boundaries, opts);
      if (d === null) return null;
      return atEnd ? update(ent, { end: normAngle(ent.end + d) }) : update(ent, { start: normAngle(ent.start - d) });
    }
    case 'polyline': {
      if (ent.closed) return null;
      const pts = ent.pts;
      const n = vertexCount(pts);
      if (n < 2) return null;
      const model = paramModel(ent);
      if (!model) return null;
      const u = pickParam(model, px, py);
      const atEnd = u >= (n - 1) / 2;
      const i = atEnd ? n - 2 : 0;
      const a = i * 3,
        b = a + 3;
      const x1 = pts[a],
        y1 = pts[a + 1],
        x2 = pts[b],
        y2 = pts[b + 1],
        bulge = pts[a + 2];
      const out = pts.slice();
      if (!(Math.abs(bulge) > BULGE_EPS)) {
        const p = extendLineEnd(x1, y1, x2, y2, atEnd, boundaries, opts);
        if (!p) return null;
        const k = atEnd ? b : a;
        out[k] = p.x;
        out[k + 1] = p.y;
        return update(ent, { pts: out });
      }
      const arc = arcFromBulge(x1, y1, x2, y2, bulge);
      const ccw = arc.sweep > 0;
      const sweepAbs = Math.abs(arc.sweep);
      // At the end, the arc continues in its own direction; at the start, against it.
      const dirCcw = atEnd ? ccw : !ccw;
      const d = extendArcAngle(arc.cx, arc.cy, arc.r, atEnd ? arc.a1 : arc.a0, dirCcw, sweepAbs, boundaries, opts);
      if (d === null) return null;
      const ns = arc.sweep + (ccw ? d : -d);
      const ang = atEnd ? arc.a1 + (dirCcw ? d : -d) : arc.a0 + (dirCcw ? d : -d);
      const k = atEnd ? b : a;
      out[k] = arc.cx + arc.r * Math.cos(ang);
      out[k + 1] = arc.cy + arc.r * Math.sin(ang);
      out[a + 2] = Math.tan(ns / 4);
      return update(ent, { pts: out });
    }
    default:
      return null;
  }
}
