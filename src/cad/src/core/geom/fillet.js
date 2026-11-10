/**
 * Fillet and chamfer.
 *
 * fillet / chamfer return { e1, e2, arc | line }: e1 and e2 are updated
 * copies (same id) trimmed or extended to the new corner, or null when an
 * entity shrinks to nothing (the caller deletes it); arc / line is the new
 * connecting entity (no id) or null. The functions return null when the
 * operation is not possible.
 */
import { TWO_PI, normAngle, ccwSweep, tolFor, clamp } from './vec.js';
import { BULGE_EPS } from './bulge.js';
import { update, arcFrom, lineFrom } from './entity.js';
import { intersectPrims } from './intersect.js';
import { vertexCount } from './poly.js';

/** Unit direction and length of a line entity. */
function lineDir(e) {
  const dx = e.x2 - e.x1,
    dy = e.y2 - e.y1;
  const l = Math.hypot(dx, dy);
  return l > 0 ? { dx: dx / l, dy: dy / l, l } : null;
}

/**
 * Corner analysis of two lines: intersection X and unit directions v1, v2
 * from X toward the kept (picked) side of each line.
 */
function lineCorner(e1, p1, e2, p2) {
  const a = lineDir(e1),
    b = lineDir(e2);
  if (!a || !b) return null;
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) <= 1e-12) return { parallel: true, a, b };
  const wx = e2.x1 - e1.x1,
    wy = e2.y1 - e1.y1;
  const t = (wx * b.dy - wy * b.dx) / den;
  const X = { x: e1.x1 + a.dx * t, y: e1.y1 + a.dy * t };
  const keep = (e, d, p) => {
    let s = (p.x - X.x) * d.dx + (p.y - X.y) * d.dy;
    if (Math.abs(s) <= tolFor(X.x, X.y)) {
      // Pick at the corner: keep the side holding the farther end point.
      const s1 = (e.x1 - X.x) * d.dx + (e.y1 - X.y) * d.dy,
        s2 = (e.x2 - X.x) * d.dx + (e.y2 - X.y) * d.dy;
      s = Math.abs(s1) > Math.abs(s2) ? s1 : s2;
    }
    return s >= 0 ? { x: d.dx, y: d.dy } : { x: -d.dx, y: -d.dy };
  };
  return { X, v1: keep(e1, a, p1), v2: keep(e2, b, p2) };
}

/**
 * Line from its far end (along v from X) to point T, keeping the original
 * orientation. Returns undefined when the kept side is too short to reach T
 * (the line would flip), null when it would vanish.
 */
function trimLineTo(e, X, v, T, dist) {
  const k1 = (e.x1 - X.x) * v.x + (e.y1 - X.y) * v.y,
    k2 = (e.x2 - X.x) * v.x + (e.y2 - X.y) * v.y;
  const far = Math.max(k1, k2);
  const tol = tolFor(e.x1, e.y1, Math.hypot(e.x2 - e.x1, e.y2 - e.y1));
  if (far < dist - tol) return undefined;
  if (far <= dist + tol) return null;
  return k1 >= k2 ? update(e, { x2: T.x, y2: T.y }) : update(e, { x1: T.x, y1: T.y });
}

function filletParallel(e1, p1, e2, a) {
  const h = (e2.x1 - e1.x1) * -a.dy + (e2.y1 - e1.y1) * a.dx;
  if (!(Math.abs(h) > tolFor(e1.x1, e1.y1, e2.x1))) return null;
  // End of e1 nearest the pick, and the outward direction w there.
  const d1 = Math.hypot(e1.x1 - p1.x, e1.y1 - p1.y),
    d2 = Math.hypot(e1.x2 - p1.x, e1.y2 - p1.y);
  const atEnd = d2 <= d1;
  const E = atEnd ? { x: e1.x2, y: e1.y2 } : { x: e1.x1, y: e1.y1 };
  const w = atEnd ? { x: a.dx, y: a.dy } : { x: -a.dx, y: -a.dy };
  // Foot of E on the second line.
  const t = (E.x - e2.x1) * a.dx + (E.y - e2.y1) * a.dy;
  const F = { x: e2.x1 + a.dx * t, y: e2.y1 + a.dy * t };
  const k1 = (e2.x1 - E.x) * w.x + (e2.y1 - E.y) * w.y,
    k2 = (e2.x2 - E.x) * w.x + (e2.y2 - E.y) * w.y;
  const n2 = k1 >= k2 ? update(e2, { x1: F.x, y1: F.y }) : update(e2, { x2: F.x, y2: F.y });
  const c = { x: (E.x + F.x) / 2, y: (E.y + F.y) / 2 };
  const r = Math.abs(h) / 2;
  const aE = normAngle(Math.atan2(E.y - c.y, E.x - c.x)),
    aF = normAngle(Math.atan2(F.y - c.y, F.x - c.x));
  const aw = Math.atan2(w.y, w.x);
  const ccwFromE = normAngle(aw - aE) < Math.PI;
  const arc = ccwFromE ? arcFrom(e1, c.x, c.y, r, aE, aF) : arcFrom(e1, c.x, c.y, r, aF, aE);
  return { e1: { ...e1 }, e2: n2, arc };
}

function filletLines(e1, p1, e2, p2, r) {
  const c = lineCorner(e1, p1, e2, p2);
  if (!c) return null;
  if (c.parallel) return r > 0 || r === undefined ? filletParallel(e1, p1, e2, c.a) : null;
  const { X, v1, v2 } = c;
  let T1 = X,
    T2 = X,
    t = 0,
    arc = null;
  if (r > 0) {
    const th = Math.acos(clamp(v1.x * v2.x + v1.y * v2.y, -1, 1));
    if (!(th > 1e-12) || !(th < Math.PI - 1e-12)) return null;
    t = r / Math.tan(th / 2);
    T1 = { x: X.x + v1.x * t, y: X.y + v1.y * t };
    T2 = { x: X.x + v2.x * t, y: X.y + v2.y * t };
    let bx = v1.x + v2.x,
      by = v1.y + v2.y;
    const bl = Math.hypot(bx, by);
    bx /= bl;
    by /= bl;
    const cd = r / Math.sin(th / 2);
    const C = { x: X.x + bx * cd, y: X.y + by * cd };
    const a1 = normAngle(Math.atan2(T1.y - C.y, T1.x - C.x)),
      a2 = normAngle(Math.atan2(T2.y - C.y, T2.x - C.x));
    const left = v1.x * v2.y - v1.y * v2.x > 0;
    arc = left ? arcFrom(e1, C.x, C.y, r, a2, a1) : arcFrom(e1, C.x, C.y, r, a1, a2);
  }
  const n1 = trimLineTo(e1, X, v1, T1, t),
    n2 = trimLineTo(e2, X, v2, T2, t);
  if (n1 === undefined || n2 === undefined) return null;
  return { e1: n1, e2: n2, arc };
}

/** Infinite / full-circle primitive of a line or arc entity. */
function curvePrim(e) {
  if (e.type === 'line') return { t: 'seg', x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 };
  return { t: 'arc', cx: e.cx, cy: e.cy, r: e.r, a0: 0, a1: TWO_PI, full: true };
}

/** Offsets of a line or circle by +-r (as extended primitives). */
function offsetPrims(e, r) {
  if (e.type === 'line') {
    const d = lineDir(e);
    const ox = -d.dy * r,
      oy = d.dx * r;
    return [
      { t: 'seg', x1: e.x1 + ox, y1: e.y1 + oy, x2: e.x2 + ox, y2: e.y2 + oy },
      { t: 'seg', x1: e.x1 - ox, y1: e.y1 - oy, x2: e.x2 - ox, y2: e.y2 - oy },
    ];
  }
  const out = [{ t: 'arc', cx: e.cx, cy: e.cy, r: e.r + r, a0: 0, a1: TWO_PI, full: true }];
  if (Math.abs(e.r - r) > tolFor(e.r)) out.push({ t: 'arc', cx: e.cx, cy: e.cy, r: Math.abs(e.r - r), a0: 0, a1: TWO_PI, full: true });
  return out;
}

/** Tangent point on entity e of a circle of radius r and centre C tangent to it. */
function footOn(e, C, r) {
  if (e.type === 'line') {
    const d = lineDir(e);
    const t = (C.x - e.x1) * d.dx + (C.y - e.y1) * d.dy;
    return { x: e.x1 + d.dx * t, y: e.y1 + d.dy * t };
  }
  const dx = C.x - e.cx,
    dy = C.y - e.cy;
  const l = Math.hypot(dx, dy) || 1;
  // A larger circle around the arc's circle touches it on the far side of
  // the arc's centre; outside it or inside it, on the near side.
  const k = r > e.r && l < r ? -e.r / l : e.r / l;
  return { x: e.cx + dx * k, y: e.cy + dy * k };
}

/** Trim or extend a line or arc to point T, keeping the side containing pick p. */
function trimTo(e, T, p) {
  if (e.type === 'line') {
    const d = lineDir(e);
    const tT = (T.x - e.x1) * d.dx + (T.y - e.y1) * d.dy;
    const tp = (p.x - e.x1) * d.dx + (p.y - e.y1) * d.dy;
    if (tp < tT) {
      return Math.abs(tT) <= tolFor(e.x1, e.y1, d.l) ? null : update(e, { x2: T.x, y2: T.y });
    }
    return Math.abs(d.l - tT) <= tolFor(e.x1, e.y1, d.l) ? null : update(e, { x1: T.x, y1: T.y });
  }
  const sw = ccwSweep(e.start, e.end);
  const aT = Math.atan2(T.y - e.cy, T.x - e.cx);
  const uT = normAngle(aT - e.start);
  const up = normAngle(Math.atan2(p.y - e.cy, p.x - e.cx) - e.start);
  let keepStart;
  if (uT <= sw) keepStart = up < uT;
  else keepStart = uT - sw < TWO_PI - uT;
  const tol = tolFor(e.r) / e.r;
  if (keepStart) return uT <= tol ? null : update(e, { end: normAngle(aT) });
  return Math.abs(sw - uT) <= tol ? null : update(e, { start: normAngle(aT) });
}

function filletGeneral(e1, p1, e2, p2, r) {
  if (!(r > 0)) {
    const hits = intersectPrims(curvePrim(e1), curvePrim(e2), { extA: true, extB: true });
    let best = null,
      bs = Infinity;
    for (const h of hits) {
      const s = Math.hypot(h.x - p1.x, h.y - p1.y) + Math.hypot(h.x - p2.x, h.y - p2.y);
      if (s < bs) {
        bs = s;
        best = h;
      }
    }
    if (!best) return null;
    return { e1: trimTo(e1, best, p1), e2: trimTo(e2, best, p2), arc: null };
  }
  let best = null,
    bs = Infinity;
  for (const a of offsetPrims(e1, r)) {
    for (const b of offsetPrims(e2, r)) {
      for (const h of intersectPrims(a, b, { extA: true, extB: true })) {
        const T1 = footOn(e1, h, r),
          T2 = footOn(e2, h, r);
        const s = Math.hypot(T1.x - p1.x, T1.y - p1.y) + Math.hypot(T2.x - p2.x, T2.y - p2.y);
        if (s < bs) {
          bs = s;
          best = { C: h, T1, T2 };
        }
      }
    }
  }
  if (!best) return null;
  const { C, T1, T2 } = best;
  const a1 = normAngle(Math.atan2(T1.y - C.y, T1.x - C.x)),
    a2 = normAngle(Math.atan2(T2.y - C.y, T2.x - C.x));
  const arc = normAngle(a2 - a1) <= Math.PI ? arcFrom(e1, C.x, C.y, r, a1, a2) : arcFrom(e1, C.x, C.y, r, a2, a1);
  return { e1: trimTo(e1, T1, p1), e2: trimTo(e2, T2, p2), arc };
}

/**
 * Fillet two lines and / or arcs with radius r. p1 and p2 ({ x, y }) are
 * pick points on the parts to keep. r = 0 trims or extends both to a sharp
 * corner. Parallel lines get a half circle at the end of e1 nearest p1.
 */
export function fillet(e1, p1, e2, p2, r) {
  if (!e1 || !e2 || e1 === e2) return null;
  const ok = (e) => (e.type === 'line' && lineDir(e)) || (e.type === 'arc' && e.r > 0);
  if (!ok(e1) || !ok(e2)) return null;
  if (e1.type === 'line' && e2.type === 'line') return filletLines(e1, p1, e2, p2, r);
  return filletGeneral(e1, p1, e2, p2, r);
}

/**
 * Chamfer two lines: distance d1 along e1 and d2 along e2 from their
 * intersection. Returns { e1, e2, line } or null.
 */
export function chamfer(e1, p1, e2, p2, d1, d2 = d1) {
  if (!e1 || !e2 || e1.type !== 'line' || e2.type !== 'line') return null;
  const c = lineCorner(e1, p1, e2, p2);
  if (!c || c.parallel) return null;
  const { X, v1, v2 } = c;
  const C1 = { x: X.x + v1.x * d1, y: X.y + v1.y * d1 },
    C2 = { x: X.x + v2.x * d2, y: X.y + v2.y * d2 };
  const n1 = trimLineTo(e1, X, v1, C1, d1),
    n2 = trimLineTo(e2, X, v2, C2, d2);
  if (n1 === undefined || n2 === undefined) return null;
  const line = Math.hypot(C2.x - C1.x, C2.y - C1.y) > tolFor(X.x, X.y) ? lineFrom(e1, C1.x, C1.y, C2.x, C2.y) : null;
  return { e1: n1, e2: n2, line };
}

/**
 * Apply a corner operation at every vertex of a polyline whose two adjacent
 * segments are straight. corner(din, dout, len) returns { tin, tout, bulge }
 * (distances back along the incoming and forward along the outgoing segment)
 * or null to skip.
 */
function cornerPolyline(poly, corner) {
  const pts = poly.pts;
  const closed = !!poly.closed;
  const n = vertexCount(pts);
  if (n < 3) return null;
  const segs = closed ? n : n - 1;
  const len = new Float64Array(segs);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    len[i] = Math.hypot(pts[j * 3] - pts[i * 3], pts[j * 3 + 1] - pts[i * 3 + 1]);
  }
  const res = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const ip = (i - 1 + n) % n,
      inx = (i + 1) % n;
    if (Math.abs(pts[ip * 3 + 2]) > BULGE_EPS || Math.abs(pts[i * 3 + 2]) > BULGE_EPS) continue;
    const lin = len[ip],
      lout = len[i];
    if (!(lin > 0 && lout > 0)) continue;
    const din = { x: (pts[i * 3] - pts[ip * 3]) / lin, y: (pts[i * 3 + 1] - pts[ip * 3 + 1]) / lin };
    const dout = { x: (pts[inx * 3] - pts[i * 3]) / lout, y: (pts[inx * 3 + 1] - pts[i * 3 + 1]) / lout };
    res[i] = corner(din, dout);
  }
  // Each segment must hold the cut-backs at both of its ends.
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const a = res[i]?.tout ?? 0,
      b = res[j]?.tin ?? 0;
    if (a + b > len[i] * (1 + 1e-12)) {
      res[i] = null;
      res[j] = null;
    }
  }
  const out = [];
  let count = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3],
      y = pts[i * 3 + 1],
      b = pts[i * 3 + 2];
    const c = res[i];
    if (!c) {
      out.push(x, y, b);
      continue;
    }
    count++;
    const ip = (i - 1 + n) % n,
      inx = (i + 1) % n;
    const lin = len[ip],
      lout = len[i];
    const ix = x - ((x - pts[ip * 3]) / lin) * c.tin,
      iy = y - ((y - pts[ip * 3 + 1]) / lin) * c.tin;
    const ox = x + ((pts[inx * 3] - x) / lout) * c.tout,
      oy = y + ((pts[inx * 3 + 1] - y) / lout) * c.tout;
    out.push(ix, iy, c.bulge);
    out.push(ox, oy, b);
  }
  if (!count) return null;
  return update(poly, { pts: out });
}

/** Fillet every straight-straight vertex of a polyline with radius r. */
export function filletPolyline(poly, r) {
  if (!(r > 0) || poly.type !== 'polyline') return null;
  return cornerPolyline(poly, (din, dout) => {
    const turn = din.x * dout.y - din.y * dout.x;
    const phi = Math.atan2(Math.abs(turn), din.x * dout.x + din.y * dout.y);
    if (!(phi > 1e-9) || !(phi < Math.PI - 1e-9)) return null;
    const t = r * Math.tan(phi / 2);
    return { tin: t, tout: t, bulge: Math.sign(turn) * Math.tan(phi / 4) };
  });
}

/** Chamfer every straight-straight vertex of a polyline. */
export function chamferPolyline(poly, d1, d2 = d1) {
  if (!(d1 >= 0 && d2 >= 0) || !(d1 + d2 > 0) || poly.type !== 'polyline') return null;
  return cornerPolyline(poly, (din, dout) => {
    const turn = din.x * dout.y - din.y * dout.x;
    const phi = Math.atan2(Math.abs(turn), din.x * dout.x + din.y * dout.y);
    if (!(phi > 1e-9) || !(phi < Math.PI - 1e-9)) return null;
    return { tin: d1, tout: d2, bulge: 0 };
  });
}
