/**
 * Offset curves. offsetEntity(ent, dist, sideX, sideY) builds a new entity
 * parallel to ent at distance dist on the side of the point (sideX, sideY).
 */
import { TWO_PI, normAngle, wrapPi, tolFor } from './vec.js';
import { arcFromBulge, BULGE_EPS } from './bulge.js';
import { derive, polylineFrom } from './entity.js';
import { toPrims, ellipsePrim, splinePrim } from './prims.js';
import { closestOnPrim, closestOnPrims } from './nearest.js';
import { intersectPrims, curveAt, primScale, primSize } from './intersect.js';
import { signedAreaPolyline, pointInPolygon } from './measure.js';
import { segmentCount, subPolyline, polyPointAt } from './poly.js';
import { bulgePolyPoints } from './tessellate.js';
import { isFullEllipse } from './ellipse.js';

/** Signed side of (px, py) relative to a direction: +1 left, -1 right, 0 on. */
function sideOf(x, y, dx, dy, px, py) {
  const c = dx * (py - y) - dy * (px - x);
  const t = 1e-12 * Math.hypot(dx, dy) * Math.max(1, Math.hypot(px - x, py - y));
  return c > t ? 1 : c < -t ? -1 : 0;
}

/** Unit tangent (direction of travel) at the closest point of a primitive. */
function primTangent(p, t) {
  if (p.t === 'seg') {
    const l = Math.hypot(p.x2 - p.x1, p.y2 - p.y1) || 1;
    return { x: (p.x2 - p.x1) / l, y: (p.y2 - p.y1) / l };
  }
  if (p.t === 'inf') return { x: p.dx, y: p.dy };
  if (p.t === 'arc') {
    const s = p.rev ? -1 : 1;
    return { x: -Math.sin(t) * s, y: Math.cos(t) * s };
  }
  const c = curveAt(p.src, t);
  const l = Math.hypot(c.dx, c.dy) || 1;
  return { x: c.dx / l, y: c.dy / l };
}

/** +1 when (px, py) is left of the entity's direction of travel, -1 right, 0 on it. */
function pickSide(prims, px, py) {
  const c = closestOnPrims(prims, px, py);
  if (!c) return 0;
  const tg = primTangent(c.prim, c.t);
  return sideOf(c.x, c.y, tg.x, tg.y, px, py);
}

/**
 * Offset a polyline by signed distance s (positive = left of travel).
 * Returns { pts, closed } or null.
 */
export function offsetPolylinePts(pts, closed, s) {
  const n = Math.floor(pts.length / 3);
  if (n < 2) return null;
  const segCount = closed ? n : n - 1;
  let scale = 0;
  for (let i = 0; i < n * 3; i += 3) scale = Math.max(scale, Math.abs(pts[i]), Math.abs(pts[i + 1]));
  const tol = tolFor(scale, s);
  // Raw offset segments.
  const raw = [];
  for (let i = 0; i < segCount; i++) {
    const a = i * 3,
      b = ((i + 1) % n) * 3;
    const x1 = pts[a],
      y1 = pts[a + 1],
      x2 = pts[b],
      y2 = pts[b + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (!(len > tol)) continue;
    const bulge = pts[a + 2];
    if (Math.abs(bulge) > BULGE_EPS) {
      const arc = arcFromBulge(x1, y1, x2, y2, bulge);
      const r = arc.ccw ? arc.r - s : arc.r + s;
      if (!(r > tol)) continue;
      raw.push({
        arc: true,
        cx: arc.cx,
        cy: arc.cy,
        r,
        sweep: arc.sweep,
        a0: arc.a0,
        a1: arc.a0 + arc.sweep,
        x1: arc.cx + r * Math.cos(arc.a0),
        y1: arc.cy + r * Math.sin(arc.a0),
        x2: arc.cx + r * Math.cos(arc.a1),
        y2: arc.cy + r * Math.sin(arc.a1),
        vx: x2,
        vy: y2,
      });
    } else {
      const ux = (x2 - x1) / len,
        uy = (y2 - y1) / len;
      const ox = -uy * s,
        oy = ux * s;
      raw.push({ arc: false, ux, uy, x1: x1 + ox, y1: y1 + oy, x2: x2 + ox, y2: y2 + oy, vx: x2, vy: y2 });
    }
  }
  const m0 = raw.length;
  if (m0 === 0) return null;
  // Segments that collapse (reverse once trimmed to their neighbours) are
  // removed and their neighbours re-joined, round after round. Only segments
  // next to a removal change, so each round revisits just those.
  const res = raw.map((g) => ({ g, x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, join: 0, sweep: 0 }));
  for (let k = 0; k < m0; k++) {
    res[k].prev = closed || k > 0 ? res[(k + m0 - 1) % m0] : null;
    res[k].next = closed || k < m0 - 1 ? res[(k + 1) % m0] : null;
    res[k].dead = false;
  }
  for (const r of res) if (r.next) joinSegs(r, r.next, s, tol);
  const rejoin = (A, B) => {
    A.x2 = A.g.x2;
    A.y2 = A.g.y2;
    A.join = 0;
    B.x1 = B.g.x1;
    B.y1 = B.g.y1;
    joinSegs(A, B, s, tol);
  };
  // Validity: segments must keep their direction after trimming.
  const isBad = (r) => {
    if (r.g.arc) {
      const ds = wrapPi(Math.atan2(r.y1 - r.g.cy, r.x1 - r.g.cx) - r.g.a0);
      const de = wrapPi(Math.atan2(r.y2 - r.g.cy, r.x2 - r.g.cx) - r.g.a1);
      r.sweep = r.g.sweep - ds + de;
      return r.sweep * r.g.sweep <= 0 || Math.abs(r.sweep) >= TWO_PI;
    }
    const along = (r.x2 - r.x1) * r.g.ux + (r.y2 - r.y1) * r.g.uy;
    return !(along > tol);
  };
  let live = m0;
  let check = res;
  while (!(closed && live === 1)) {
    const bad = check.filter(isBad);
    if (!bad.length) break;
    if (bad.length === live) return null;
    for (const r of bad) r.dead = true;
    live -= bad.length;
    const near = new Set();
    for (const r of bad) {
      const p = r.prev,
        q = r.next;
      if (p) p.next = q;
      if (q) q.prev = p;
      if (p && !p.dead) near.add(p);
      if (q && !q.dead) near.add(q);
    }
    const next = new Set();
    for (const c of near) {
      if (c.prev) rejoin(c.prev, c);
      else {
        c.x1 = c.g.x1;
        c.y1 = c.g.y1;
      }
      if (c.next) rejoin(c, c.next);
      else {
        c.x2 = c.g.x2;
        c.y2 = c.g.y2;
        c.join = 0;
      }
      next.add(c);
      if (c.prev) next.add(c.prev);
      if (c.next) next.add(c.next);
    }
    check = [...next];
  }
  // Emit vertices, starting from the first surviving segment.
  let r = res.find((g) => !g.dead);
  if (closed && live === 1) isBad(r);
  const out = [];
  for (let k = 0; k < live; k++, r = r.next) {
    out.push(r.x1, r.y1, r.g.arc ? Math.tan(r.sweep / 4) : 0);
    if (r.join) out.push(r.x2, r.y2, r.join);
    if (!r.next) out.push(r.x2, r.y2, 0);
  }
  return { pts: out, closed };
}

/** Unit tangent of a bulge segment at its start (at = 0) or end (at = 1). */
function bulgeTangent(x1, y1, x2, y2, b, at) {
  const dx = x2 - x1,
    dy = y2 - y1;
  const l = Math.hypot(dx, dy) || 1;
  // A bulge b arc leaves at 2 atan(b) clockwise from the chord and arrives as
  // far the other way.
  const t = (at ? 2 : -2) * Math.atan(b);
  const c = Math.cos(t),
    sn = Math.sin(t);
  return { x: (dx * c - dy * sn) / l, y: (dx * sn + dy * c) / l };
}

/**
 * Raw offset loop of a closed polyline by signed distance s that keeps every
 * segment: convex corners get a sharp corner (or a round one when the sharp
 * one is out of reach), concave ones are trimmed where the neighbours cross
 * or linked by a chord inside the offset band when they don't, and arcs
 * that collapse become chords through their centre. Every point of the true
 * offset lies on this loop and its pieces only change between valid and
 * invalid where it crosses itself (or enters a sharp corner's wedge).
 * Returns { pts, wedges } with wedges the flat polygons that sharp corners
 * add beyond round ones.
 */
export function rawOffsetLoop(pts, s, tol) {
  const n = Math.floor(pts.length / 3);
  const segs = [];
  for (let i = 0; i < n; i++) {
    const a = i * 3,
      b = ((i + 1) % n) * 3;
    const x1 = pts[a],
      y1 = pts[a + 1],
      x2 = pts[b],
      y2 = pts[b + 1];
    if (!(Math.hypot(x2 - x1, y2 - y1) > tol)) continue;
    const bulge = pts[a + 2];
    const t0 = bulgeTangent(x1, y1, x2, y2, bulge, 0),
      t1 = bulgeTangent(x1, y1, x2, y2, bulge, 1);
    const g = { t0, t1, vx: x2, vy: y2, arc: false };
    const arc = Math.abs(bulge) > BULGE_EPS ? arcFromBulge(x1, y1, x2, y2, bulge) : null;
    if (arc) {
      const r = arc.ccw ? arc.r - s : arc.r + s;
      const a1 = arc.a0 + arc.sweep;
      // Past the centre the offset of the arc is a chord between its reflected ends.
      const rr = r > tol ? r : Math.min(r, 0);
      g.x1 = arc.cx + rr * Math.cos(arc.a0);
      g.y1 = arc.cy + rr * Math.sin(arc.a0);
      g.x2 = arc.cx + rr * Math.cos(a1);
      g.y2 = arc.cy + rr * Math.sin(a1);
      if (r > tol) Object.assign(g, { arc: true, cx: arc.cx, cy: arc.cy, r, sweep: arc.sweep });
      if (r > tol) Object.assign(g, { a0: arc.a0, a1 });
    } else {
      g.x1 = x1 - t0.y * s;
      g.y1 = y1 + t0.x * s;
      g.x2 = x2 - t0.y * s;
      g.y2 = y2 + t0.x * s;
    }
    if (!g.arc) {
      const l = Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
      g.ux = l > 0 ? (g.x2 - g.x1) / l : 0;
      g.uy = l > 0 ? (g.y2 - g.y1) / l : 0;
    }
    segs.push(g);
  }
  const m = segs.length;
  if (!m) return null;
  const res = segs.map((g) => ({
    g,
    x1: g.x1,
    y1: g.y1,
    x2: g.x2,
    y2: g.y2,
    join: null,
    trim: false,
  }));
  const wedges = [];
  const extPrim = (g) =>
    g.arc
      ? { t: 'arc', cx: g.cx, cy: g.cy, r: g.r, a0: 0, a1: TWO_PI, full: true }
      : { t: 'seg', x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 };
  const ownPrim = (g) => {
    if (!g.arc) return { t: 'seg', x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 };
    const a0 = normAngle(g.sweep > 0 ? g.a0 : g.a1);
    return { t: 'arc', cx: g.cx, cy: g.cy, r: g.r, a0, a1: a0 + Math.abs(g.sweep), full: false };
  };
  // Direction of travel of an offset segment at a point on it (or its extension).
  const dirAt = (g, x, y) => {
    if (!g.arc) return { x: g.ux, y: g.uy };
    const k = g.sweep > 0 ? 1 : -1;
    return { x: (-(y - g.cy) / g.r) * k, y: ((x - g.cx) / g.r) * k };
  };
  // The offset curve as the outer boundary of a wedge, seen from the vertex.
  const bound = (g, x, y, vx, vy) => {
    if (!g.arc) {
      const l = Math.hypot(x - vx, y - vy) || 1;
      return { x, y, nx: (x - vx) / l, ny: (y - vy) / l };
    }
    return { cx: g.cx, cy: g.cy, r: g.r, out: g.r > Math.hypot(vx - g.cx, vy - g.cy) };
  };
  const arcPts = (g, xa, ya, xb, yb, out) => {
    // Points strictly between two points of an offset arc, along its travel.
    const aa = Math.atan2(ya - g.cy, xa - g.cx);
    const sw = wrapPi(Math.atan2(yb - g.cy, xb - g.cx) - aa);
    for (let k = 1; k < 6; k++)
      out.push(g.cx + g.r * Math.cos(aa + (sw * k) / 6), g.cy + g.r * Math.sin(aa + (sw * k) / 6));
  };
  for (let k = 0; k < m; k++) {
    const A = res[k],
      B = res[(k + 1) % m];
    const ex = A.g.x2,
      ey = A.g.y2,
      sx = B.g.x1,
      sy = B.g.y1;
    if (Math.hypot(ex - sx, ey - sy) <= tol * 10) {
      A.x2 = B.x1 = (ex + sx) / 2;
      A.y2 = B.y1 = (ey + sy) / 2;
      continue;
    }
    const vx = A.g.vx,
      vy = A.g.vy;
    // Round join from A's end to B's start around the vertex, turning away
    // from the offset side; it is the short way round at convex corners.
    let sw = normAngle(Math.atan2(sy - vy, sx - vx) - Math.atan2(ey - vy, ex - vx));
    if (s > 0) sw -= TWO_PI;
    if (Math.abs(sw) <= Math.PI + 1e-9) {
      let best = null,
        bd = Infinity;
      for (const h of intersectPrims(extPrim(A.g), extPrim(B.g), { extA: true, extB: true })) {
        const dd = Math.hypot(h.x - vx, h.y - vy);
        if (dd < bd) {
          bd = dd;
          best = h;
        }
      }
      if (best && bd <= Math.abs(s) * 1e3) {
        // The corner must lie ahead of A's end and behind B's start.
        const da = dirAt(A.g, ex, ey),
          db = dirAt(B.g, sx, sy);
        const ahead = (best.x - ex) * da.x + (best.y - ey) * da.y,
          behind = (sx - best.x) * db.x + (sy - best.y) * db.y;
        const ea = A.g.arc
          ? Math.abs(wrapPi(Math.atan2(best.y - A.g.cy, best.x - A.g.cx) - A.g.a1))
          : 0;
        const eb = B.g.arc
          ? Math.abs(wrapPi(Math.atan2(best.y - B.g.cy, best.x - B.g.cx) - B.g.a0))
          : 0;
        if (ahead >= -tol && behind >= -tol && ea < Math.PI / 2 && eb < Math.PI / 2) {
          const box = [vx, vy, ex, ey, best.x, best.y, sx, sy];
          if (A.g.arc) arcPts(A.g, ex, ey, best.x, best.y, box);
          if (B.g.arc) arcPts(B.g, best.x, best.y, sx, sy, box);
          wedges.push({
            vx,
            vy,
            ta: A.g.t1,
            tb: B.g.t0,
            a: bound(A.g, ex, ey, vx, vy),
            b: bound(B.g, sx, sy, vx, vy),
            box,
          });
          A.x2 = B.x1 = best.x;
          A.y2 = B.y1 = best.y;
          continue;
        }
      }
      A.join = Math.tan(sw / 4);
      continue;
    }
    let best = null,
      bd = Infinity;
    for (const h of intersectPrims(ownPrim(A.g), ownPrim(B.g))) {
      const dd = Math.hypot(h.x - vx, h.y - vy);
      if (dd < bd) {
        bd = dd;
        best = h;
      }
    }
    if (best) {
      A.x2 = B.x1 = best.x;
      A.y2 = B.y1 = best.y;
      A.trim = true;
    } else A.join = 0;
  }
  // A segment trimmed from both ends may turn around: link its neighbours
  // with chords instead (that only lengthens segments).
  const sweepOf = (r) => {
    const ds = wrapPi(Math.atan2(r.y1 - r.g.cy, r.x1 - r.g.cx) - r.g.a0);
    const de = wrapPi(Math.atan2(r.y2 - r.g.cy, r.x2 - r.g.cx) - r.g.a1);
    return r.g.sweep - ds + de;
  };
  const reversed = (r) => {
    if (r.g.arc) {
      const sw = sweepOf(r);
      return sw * r.g.sweep <= 0 || Math.abs(sw) >= TWO_PI;
    }
    return (r.x2 - r.x1) * r.g.ux + (r.y2 - r.y1) * r.g.uy < -tol;
  };
  const untrim = (A, B) => {
    if (!A.trim) return;
    A.trim = false;
    A.x2 = A.g.x2;
    A.y2 = A.g.y2;
    B.x1 = B.g.x1;
    B.y1 = B.g.y1;
    A.join = 0;
  };
  for (let k = 0; k < m; k++) {
    const r = res[k];
    if (!reversed(r)) continue;
    untrim(res[(k + m - 1) % m], r);
    untrim(r, res[(k + 1) % m]);
  }
  const out = [];
  for (const r of res) {
    out.push(r.x1, r.y1, r.g.arc ? Math.tan(sweepOf(r) / 4) : 0);
    if (r.join !== null) out.push(r.x2, r.y2, r.join);
  }
  return { pts: out, wedges };
}

/** Primitive of a raw offset segment, used to intersect neighbours. */
function segPrim(g) {
  if (!g.arc) return { t: 'seg', x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 };
  return { t: 'arc', cx: g.cx, cy: g.cy, r: g.r, a0: 0, a1: TWO_PI, full: true };
}

/** Connect the end of A to the start of B (extend / trim or round join). */
function joinSegs(A, B, s, tol) {
  const ex = A.x2,
    ey = A.y2,
    sx = B.x1,
    sy = B.y1;
  if (Math.hypot(ex - sx, ey - sy) <= tol * 10) {
    const mx = (ex + sx) / 2,
      my = (ey + sy) / 2;
    A.x2 = B.x1 = mx;
    A.y2 = B.y1 = my;
    return;
  }
  const hits = intersectPrims(segPrim(A.g), segPrim(B.g), { extA: true, extB: true });
  // Reference: the original vertex the two segments met at.
  const rx = A.g.vx,
    ry = A.g.vy;
  let best = null,
    bd = Infinity;
  for (const h of hits) {
    const d = Math.hypot(h.x - rx, h.y - ry);
    if (d < bd) {
      bd = d;
      best = h;
    }
  }
  // Accept the corner when it is not absurdly far compared to the offset.
  if (best && bd <= Math.abs(s) * 1e3) {
    A.x2 = B.x1 = best.x;
    A.y2 = B.y1 = best.y;
    return;
  }
  // Round join around the original vertex.
  const a0 = Math.atan2(ey - ry, ex - rx),
    a1 = Math.atan2(sy - ry, sx - rx);
  let sw = normAngle(a1 - a0);
  if (s > 0) sw -= TWO_PI;
  if (sw === 0 || Math.abs(sw) >= TWO_PI) return;
  A.join = Math.tan(sw / 4);
}

/** Polyline parameter (segment index + fraction) of a hit on a bulge-list primitive. */
function hitParam(p, t) {
  if (p.t === 'seg') return p.seg + t;
  const f = (t - p.a0) / (p.a1 - p.a0);
  return p.seg + (p.rev ? 1 - f : f);
}

/** Pairs of primitives with overlapping boxes (sweep along x). */
function overlappingPairs(prims, fn) {
  const boxes = prims.map((p) =>
    p.t === 'seg'
      ? [Math.min(p.x1, p.x2), Math.min(p.y1, p.y2), Math.max(p.x1, p.x2), Math.max(p.y1, p.y2)]
      : [p.cx - p.r, p.cy - p.r, p.cx + p.r, p.cy + p.r],
  );
  const order = prims.map((_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0]);
  for (let k = 0; k < order.length; k++) {
    const a = boxes[order[k]];
    for (let l = k + 1; l < order.length; l++) {
      const b = boxes[order[l]];
      if (b[0] > a[2]) break;
      if (b[1] <= a[3] && b[3] >= a[1]) fn(prims[order[k]], prims[order[l]]);
    }
  }
}

/** Drop vertices of a closed stride-3 list between two collinear straight segments. */
function dropCollinear(pts, tol) {
  const out = [];
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) {
    const p = ((i + n - 1) % n) * 3,
      c = i * 3,
      q = ((i + 1) % n) * 3;
    if (n - i + out.length / 3 > 3 && !pts[p + 2] && !pts[c + 2]) {
      const ax = pts[c] - pts[p],
        ay = pts[c + 1] - pts[p + 1],
        bx = pts[q] - pts[c],
        by = pts[q + 1] - pts[c + 1];
      const la = Math.hypot(ax, ay),
        lb = Math.hypot(bx, by);
      if (Math.abs(ax * by - ay * bx) <= tol * (la + lb) && ax * bx + ay * by > 0) continue;
    }
    out.push(pts[c], pts[c + 1], pts[c + 2]);
  }
  return out;
}

/**
 * Uniform grid over boxes [x0, y0, x1, y1]; visit(x0, y0, x1, y1, fn) calls
 * fn(index) for the boxes in the cells a query box touches (possibly more
 * than once) until fn returns true, and returns whether it did.
 */
function boxGrid(boxes, cell) {
  let gx0 = Infinity,
    gy0 = Infinity,
    gx1 = -Infinity,
    gy1 = -Infinity;
  for (const b of boxes) {
    gx0 = Math.min(gx0, b[0]);
    gy0 = Math.min(gy0, b[1]);
    gx1 = Math.max(gx1, b[2]);
    gy1 = Math.max(gy1, b[3]);
  }
  // At most ~4 cells per box on average and a bounded total.
  const area = Math.max((gx1 - gx0) * (gy1 - gy0), 1e-300);
  const h = Math.max(cell, Math.sqrt(area / Math.max(1, boxes.length * 4)), 1e-300);
  const nx = Math.min(4096, Math.floor((gx1 - gx0) / h) + 1),
    ny = Math.min(4096, Math.floor((gy1 - gy0) / h) + 1);
  const hx = (gx1 - gx0) / nx || h,
    hy = (gy1 - gy0) / ny || h;
  const ix = (x) => Math.max(0, Math.min(nx - 1, Math.floor((x - gx0) / hx)));
  const iy = (y) => Math.max(0, Math.min(ny - 1, Math.floor((y - gy0) / hy)));
  const cells = new Map();
  boxes.forEach((b, k) => {
    for (let j = iy(b[1]); j <= iy(b[3]); j++) {
      for (let i = ix(b[0]); i <= ix(b[2]); i++) {
        const key = j * nx + i;
        const c = cells.get(key);
        if (c) c.push(k);
        else cells.set(key, [k]);
      }
    }
  });
  return (x0, y0, x1, y1, fn) => {
    if (x1 < gx0 || y1 < gy0 || x0 > gx1 || y0 > gy1) return false;
    // The middle cell first: point queries usually end there.
    const mc = cells.get(iy((y0 + y1) / 2) * nx + ix((x0 + x1) / 2));
    if (mc) for (const k of mc) if (fn(k)) return true;
    for (let j = iy(y0); j <= iy(y1); j++) {
      for (let i = ix(x0); i <= ix(x1); i++) {
        const c = cells.get(j * nx + i);
        if (c) for (const k of c) if (fn(k)) return true;
      }
    }
    return false;
  };
}

/** Bounding box of a seg or arc primitive (whole circle for arcs). */
function primBox(p) {
  if (p.t === 'seg') {
    return [Math.min(p.x1, p.x2), Math.min(p.y1, p.y2), Math.max(p.x1, p.x2), Math.max(p.y1, p.y2)];
  }
  return [p.cx - p.r, p.cy - p.r, p.cx + p.r, p.cy + p.r];
}

/** Test for points closer than dmin to any of the (seg / arc) primitives. */
function nearTester(prims, dmin) {
  const visit = boxGrid(prims.map(primBox), dmin);
  const d2 = dmin * dmin;
  return (x, y) =>
    visit(x - dmin, y - dmin, x + dmin, y + dmin, (k) => {
      const p = prims[k];
      if (p.t === 'seg') {
        const dx = p.x2 - p.x1,
          dy = p.y2 - p.y1;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - p.x1) * dx + (y - p.y1) * dy) / l2)) : 0;
        return (p.x1 + dx * t - x) ** 2 + (p.y1 + dy * t - y) ** 2 < d2;
      }
      const c = closestOnPrim(p, x, y);
      return !!c && c.d2 < d2;
    });
}

/**
 * Test for points strictly inside (by more than eps) any sharp-corner wedge:
 * past the normal at the end of the first segment, before the normal at the
 * start of the second, and inside both offset curves.
 */
function wedgeTester(wedges, eps) {
  if (!wedges.length) return () => false;
  const boxes = wedges.map(({ box }) => {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < box.length; i += 2) {
      b[0] = Math.min(b[0], box[i]);
      b[1] = Math.min(b[1], box[i + 1]);
      b[2] = Math.max(b[2], box[i]);
      b[3] = Math.max(b[3], box[i + 1]);
    }
    return b;
  });
  const inside = (c, x, y) => {
    if (c.nx !== undefined) return (x - c.x) * c.nx + (y - c.y) * c.ny < -eps;
    const r = Math.hypot(x - c.cx, y - c.cy);
    return c.out ? r < c.r - eps : r > c.r + eps;
  };
  const visit = boxGrid(boxes, 0);
  return (x, y) =>
    visit(x, y, x, y, (k) => {
      const b = boxes[k];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
      const w = wedges[k];
      const dx = x - w.vx,
        dy = y - w.vy;
      if (!(dx * w.ta.x + dy * w.ta.y > eps && dx * w.tb.x + dy * w.tb.y < -eps)) return false;
      return inside(w.a, x, y) && inside(w.b, x, y);
    });
}

/**
 * Remove the invalid parts of a closed raw offset: split it at its
 * self-intersections, drop the pieces that come closer than d to the source
 * primitives, lie inside a sharp corner's wedge or leave the side accepted by
 * onSide (optional), and stitch the rest into closed loops. Returns a list of
 * stride-3 point lists (empty when nothing is valid).
 */
function clipClosedOffset(pts, srcPrims, d, onSide, wedges) {
  const m = segmentCount(pts, true);
  const prims = toPrims({ type: 'polyline', pts, closed: true });
  let scale = 0,
    size = 0;
  for (const p of prims) {
    scale = Math.max(scale, primScale(p));
    size = Math.max(size, primSize(p));
  }
  const tol = tolFor(scale, d);
  const joinTol = Math.max(tol * 10, 1e-9 * size);
  // Arc length along the loop at a parameter.
  const acc = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = i * 3,
      b = ((i + 1) % m) * 3;
    const c = Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1]);
    const h = 2 * Math.atan(Math.abs(pts[a + 2]));
    acc[i + 1] = acc[i] + (h > 1e-9 ? (c * h) / Math.sin(h) : c);
  }
  const lenAt = (u) => {
    const i = Math.min(m - 1, Math.floor(u));
    return acc[i] + (acc[i + 1] - acc[i]) * (u - i);
  };
  const cuts = [];
  overlappingPairs(prims, (a, b) => {
    for (const h of intersectPrims(a, b)) {
      const ua = hitParam(a, h.ta),
        ub = hitParam(b, h.tb);
      // A shared vertex of consecutive segments has the same parameter on
      // both; hits a tiny stretch of the loop apart only touch.
      const du = Math.abs(lenAt(ua) - lenAt(ub));
      if (Math.min(du, acc[m] - du) <= joinTol * 10) continue;
      cuts.push(ua, ub);
    }
  });
  const minD = d - Math.max(d * 1e-6, tol);
  const inWedge = wedgeTester(wedges, Math.max(d * 1e-6, tol * 100));
  let tooNear = null;
  const valid = (u0, u1) => {
    tooNear ??= nearTester(srcPrims, minD);
    for (const f of [0.5, 0.25, 0.75]) {
      const q = polyPointAt(pts, true, u0 + (u1 - u0) * f);
      if (tooNear(q.x, q.y) || (onSide && !onSide(q.x, q.y)) || inWedge(q.x, q.y)) return false;
    }
    return true;
  };
  if (!cuts.length) return valid(0, m) ? [pts] : [];
  const us = Float64Array.from(cuts, (u) => ((u % m) + m) % m).sort();
  const cut = [];
  for (const u of us) if (!cut.length || u - cut[cut.length - 1] > 1e-9 * m) cut.push(u);
  if (cut.length > 1 && cut[0] + m - cut[cut.length - 1] <= 1e-9 * m) cut.pop();
  const pieces = [];
  for (let k = 0; k < cut.length; k++) {
    const u0 = cut[k],
      u1 = k + 1 < cut.length ? cut[k + 1] : cut[0] + m;
    if (!valid(u0, u1)) continue;
    const p = subPolyline(pts, true, u0, u1);
    if (p.length >= 6) pieces.push(p);
  }
  // Stitch pieces end to start. Overlapping pieces (collinear offsets) are
  // kept once when they run the same way and cancel when they run opposite.
  const near = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by) <= joinTol;
  const used = new Array(pieces.length).fill(false);
  const mids = pieces.map((p) => polyPointAt(p, false, segmentCount(p, false) / 2));
  const ends = pieces.map((p) => [p[0], p[1], p[p.length - 3], p[p.length - 2]]);
  for (let i = 0; i < pieces.length; i++) {
    const [ax, ay, bx, by] = ends[i];
    for (let j = i + 1; j < pieces.length && !used[i]; j++) {
      if (used[j] || !near(mids[i].x, mids[i].y, mids[j].x, mids[j].y)) continue;
      const [cx, cy, dx, dy] = ends[j];
      if (near(ax, ay, cx, cy) && near(bx, by, dx, dy)) used[j] = true;
      else if (near(ax, ay, dx, dy) && near(bx, by, cx, cy)) used[i] = used[j] = true;
    }
  }
  const loops = [];
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = [pieces[i]];
    for (;;) {
      const last = chain[chain.length - 1];
      const ex = last[last.length - 3],
        ey = last[last.length - 2];
      // Closed when back at the start of a piece of the chain; pieces before
      // that one led into the loop from a stray end and are dropped.
      const k = chain.findIndex((p) => near(ex, ey, p[0], p[1]));
      if (k >= 0) {
        chain = chain.slice(k);
        break;
      }
      let best = -1,
        bd = joinTol;
      for (let j = 0; j < pieces.length; j++) {
        if (used[j]) continue;
        const dj = Math.hypot(pieces[j][0] - ex, pieces[j][1] - ey);
        if (dj <= bd) {
          bd = dj;
          best = j;
        }
      }
      if (best < 0) {
        // A stray piece (misjudged at a near-tangency): drop it.
        chain = null;
        break;
      }
      used[best] = true;
      chain.push(pieces[best]);
    }
    if (!chain) continue;
    const loop = [];
    for (const p of chain) for (let j = 0; j < p.length - 3; j++) loop.push(p[j]);
    const area = Math.abs(signedAreaPolyline(loop, true));
    if (area > joinTol * size) loops.push(dropCollinear(loop, tol));
  }
  return loops;
}

/**
 * Offset an entity by dist toward the side of (sideX, sideY). Supports line,
 * xline, ray, circle, arc, polyline (open / closed, with bulges), ellipse and
 * spline (approximated by a polyline). Returns a new entity or null.
 */
export function offsetEntity(ent, dist, sideX, sideY, opts) {
  const d = Math.abs(dist);
  if (!(d > 0)) return null;
  switch (ent.type) {
    case 'line': {
      const dx = ent.x2 - ent.x1,
        dy = ent.y2 - ent.y1;
      const l = Math.hypot(dx, dy);
      if (!(l > 0)) return null;
      const side = sideOf(ent.x1, ent.y1, dx, dy, sideX, sideY);
      if (!side) return null;
      const ox = (-dy / l) * d * side,
        oy = (dx / l) * d * side;
      return derive(ent, 'line', { x1: ent.x1 + ox, y1: ent.y1 + oy, x2: ent.x2 + ox, y2: ent.y2 + oy });
    }
    case 'xline':
    case 'ray': {
      const l = Math.hypot(ent.dx, ent.dy);
      if (!(l > 0)) return null;
      const side = sideOf(ent.x, ent.y, ent.dx, ent.dy, sideX, sideY);
      if (!side) return null;
      return derive(ent, ent.type, { x: ent.x + (-ent.dy / l) * d * side, y: ent.y + (ent.dx / l) * d * side, dx: ent.dx, dy: ent.dy });
    }
    case 'circle':
    case 'arc': {
      const ds = Math.hypot(sideX - ent.cx, sideY - ent.cy);
      const r = ds < ent.r ? ent.r - d : ent.r + d;
      if (!(r > tolFor(ent.r))) return null;
      return ent.type === 'circle'
        ? derive(ent, 'circle', { cx: ent.cx, cy: ent.cy, r })
        : derive(ent, 'arc', { cx: ent.cx, cy: ent.cy, r, start: ent.start, end: ent.end });
    }
    case 'polyline': {
      const closed = !!ent.closed;
      let side;
      let onSide = null;
      const area = closed ? signedAreaPolyline(ent.pts, true) : 0;
      if (closed && Math.abs(area) > 0) {
        const size = Math.sqrt(Math.abs(area));
        const ring = bulgePolyPoints(ent.pts, true, size * 1e-4);
        const inside = pointInPolygon(sideX, sideY, ring);
        side = (inside ? 1 : -1) * (area > 0 ? 1 : -1);
        // Valid offset points lie on the picked side, at least d from the edges.
        let fine = null;
        onSide = (x, y) => {
          fine ??= bulgePolyPoints(ent.pts, true, Math.min(size * 1e-4, d * 0.05));
          return pointInPolygon(x, y, fine) === inside;
        };
      } else side = pickSide(toPrims(ent), sideX, sideY);
      if (!side) return null;
      if (!closed) {
        const r = offsetPolylinePts(ent.pts, false, d * side);
        return r ? polylineFrom(ent, r.pts, false) : null;
      }
      let scale = 0;
      for (let i = 0; i + 1 < ent.pts.length; i += 3) {
        scale = Math.max(scale, Math.abs(ent.pts[i]), Math.abs(ent.pts[i + 1]));
      }
      const raw = rawOffsetLoop(ent.pts, d * side, tolFor(scale, d));
      if (!raw) return null;
      const loops = clipClosedOffset(raw.pts, toPrims(ent), d, onSide, raw.wedges);
      if (!loops.length) return null;
      const out = loops.map((pts) => polylineFrom(ent, pts, true));
      return out.length === 1 ? out[0] : out;
    }
    case 'ellipse':
    case 'spline':
      return offsetCurve(ent, d, sideX, sideY, opts?.relTol ?? 2e-5);
    default:
      return null;
  }
}

/** Offset of an ellipse or spline approximated as a polyline. */
function offsetCurve(ent, d, sideX, sideY, relTol) {
  if (ent.type === 'spline' && !(ent.ctrl && ent.ctrl.length >= 4)) return null;
  const prim = ent.type === 'ellipse' ? ellipsePrim(ent, relTol) : splinePrim(ent, relTol);
  const side = pickSide([prim], sideX, sideY);
  if (!side) return null;
  const s = d * side;
  const us = prim.us,
    p = prim.pts;
  const out = [];
  const n = us.length;
  for (let i = 0; i < n; i++) {
    const c = curveAt(ent, us[i]);
    let tx = c.dx,
      ty = c.dy;
    let l = Math.hypot(tx, ty);
    if (!(l > 0)) {
      // Zero derivative (cusp or stacked control points): use the chord direction.
      const a = i < n - 1 ? i : i - 1;
      tx = p[2 * a + 2] - p[2 * a];
      ty = p[2 * a + 3] - p[2 * a + 1];
      l = Math.hypot(tx, ty) || 1;
    }
    out.push(c.x - (ty / l) * s, c.y + (tx / l) * s, 0);
  }
  const closed = ent.type === 'ellipse' ? isFullEllipse(ent) : !!ent.closed;
  if (closed && out.length >= 6) {
    const k = out.length;
    if (Math.hypot(out[k - 3] - out[0], out[k - 2] - out[1]) <= tolFor(out[0], out[1]) * 1e3) out.length -= 3;
  }
  return polylineFrom(ent, out, closed);
}
