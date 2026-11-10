/**
 * Intersections between primitives (see prims.js).
 *
 * Results are { x, y, ta, tb } where ta / tb are parameters on a / b:
 *   seg  fraction along x1,y1 -> x2,y2 (0..1 unless extended)
 *   inf  signed distance from (x, y) along the unit direction
 *   arc  absolute angle a0 + offset (a0 .. a1 unless extended)
 *   pl   curve parameter (ellipse parametric angle or spline knot parameter)
 *
 * Curve approximations (pl) are refined against the exact ellipse or spline,
 * so intersections with them are accurate to machine precision in the usual
 * transversal case.
 */
import { EPS, TWO_PI, angleInSweep, sweepOffset, dist2 } from './vec.js';
import { ellipsePoint, ellipseDeriv } from './ellipse.js';
import { evalSplineFull } from './spline.js';
import { toPrims } from './prims.js';

/** Largest absolute coordinate or size of a primitive (for tolerances). */
export function primScale(p) {
  switch (p.t) {
    case 'seg':
      return Math.max(Math.abs(p.x1), Math.abs(p.y1), Math.abs(p.x2), Math.abs(p.y2));
    case 'inf':
      return Math.max(Math.abs(p.x), Math.abs(p.y));
    case 'arc':
      return Math.max(Math.abs(p.cx), Math.abs(p.cy)) + p.r;
    case 'pl': {
      if (p._scale !== undefined) return p._scale;
      let m = 0;
      const a = p.pts;
      for (let i = 0; i < a.length; i++) {
        const v = Math.abs(a[i]);
        if (v > m) m = v;
      }
      p._scale = m;
      return m;
    }
    default:
      return 0;
  }
}

/** Extent of a primitive (0 for infinite lines). */
export function primSize(p) {
  switch (p.t) {
    case 'seg':
      return Math.max(Math.abs(p.x2 - p.x1), Math.abs(p.y2 - p.y1));
    case 'arc':
      return p.r;
    case 'pl': {
      const b = plBox(p);
      return Math.max(b[2] - b[0], b[3] - b[1]);
    }
    default:
      return 0;
  }
}

/**
 * Radius within which hits count as duplicates: 1e3 x the tolerance, but
 * relative to the primitives' size so distinct hits on small curves far from
 * the origin stay apart.
 */
export function hitMergeTol(tol, size) {
  return Math.max(tol, Math.min(tol * 1e3, EPS * 1e3 * Math.max(1, size)));
}

/** Point and derivative of the exact curve behind a pl primitive. */
export function curveAt(src, u) {
  if (src.type === 'ellipse') {
    const p = ellipsePoint(src, u);
    const d = ellipseDeriv(src, u);
    return { x: p.x, y: p.y, dx: d.x, dy: d.y };
  }
  return evalSplineFull(src, u);
}

/** Line-like view of a seg or inf primitive: point, direction, parameter range. */
function lineOf(p, ext) {
  if (p.t === 'seg') {
    return { px: p.x1, py: p.y1, dx: p.x2 - p.x1, dy: p.y2 - p.y1, lo: ext ? -Infinity : 0, hi: ext ? Infinity : 1 };
  }
  return { px: p.x, py: p.y, dx: p.dx, dy: p.dy, lo: p.ray && !ext ? 0 : -Infinity, hi: Infinity };
}

function inRange(t, lo, hi, tolT) {
  return t >= lo - tolT && t <= hi + tolT;
}

function hit(out, x, y, ta, tb, swap) {
  out.push(swap ? { x, y, ta: tb, tb: ta } : { x, y, ta, tb });
}

function lineLine(A, B, tol, out, swap) {
  const la = Math.hypot(A.dx, A.dy),
    lb = Math.hypot(B.dx, B.dy);
  if (!(la > 0 && lb > 0)) return;
  const den = A.dx * B.dy - A.dy * B.dx;
  if (Math.abs(den) <= 1e-12 * la * lb) return;
  const wx = B.px - A.px,
    wy = B.py - A.py;
  const ta = (wx * B.dy - wy * B.dx) / den;
  const tb = (wx * A.dy - wy * A.dx) / den;
  if (!inRange(ta, A.lo, A.hi, tol / la) || !inRange(tb, B.lo, B.hi, tol / lb)) return;
  hit(out, A.px + A.dx * ta, A.py + A.dy * ta, ta, tb, swap);
}

function arcParam(C, x, y) {
  const ang = Math.atan2(y - C.cy, x - C.cx);
  const sw = C.a1 - C.a0;
  return C.a0 + sweepOffset(ang, C.a0, sw);
}

function onArc(C, ext, x, y, tol) {
  if (ext || C.full) return true;
  const sw = C.a1 - C.a0;
  if (sw >= TWO_PI) return true;
  return angleInSweep(Math.atan2(y - C.cy, x - C.cx), C.a0, sw, tol / C.r);
}

function lineArc(L, C, extC, tol, out, swap) {
  const a = L.dx * L.dx + L.dy * L.dy;
  if (!(a > 0) || !(C.r > 0)) return;
  const fx = L.px - C.cx,
    fy = L.py - C.cy;
  const t0 = -(fx * L.dx + fy * L.dy) / a;
  const qx = fx + t0 * L.dx,
    qy = fy + t0 * L.dy;
  const d = Math.hypot(qx, qy);
  const r = C.r;
  if (d > r + tol) return;
  const la = Math.sqrt(a);
  const tolT = tol / la;
  const emit = (t) => {
    if (!inRange(t, L.lo, L.hi, tolT)) return;
    const x = L.px + L.dx * t,
      y = L.py + L.dy * t;
    if (!onArc(C, extC, x, y, tol)) return;
    hit(out, x, y, t, arcParam(C, x, y), swap);
  };
  if (Math.abs(d - r) <= tol) {
    emit(t0);
    return;
  }
  const h = Math.sqrt((r - d) * (r + d)) / la;
  emit(t0 - h);
  emit(t0 + h);
}

function arcArc(A, B, extA, extB, tol, out) {
  const dx = B.cx - A.cx,
    dy = B.cy - A.cy;
  const d = Math.hypot(dx, dy);
  if (d <= tol || !(A.r > 0) || !(B.r > 0)) return;
  const sum = A.r + B.r,
    diff = Math.abs(A.r - B.r);
  if (d > sum + tol || d < diff - tol) return;
  const a = (d * d + A.r * A.r - B.r * B.r) / (2 * d);
  const h2 = A.r * A.r - a * a;
  const tangent = Math.abs(d - sum) <= tol || Math.abs(d - diff) <= tol || h2 <= 0;
  const ux = dx / d,
    uy = dy / d;
  const bx = A.cx + a * ux,
    by = A.cy + a * uy;
  const emit = (x, y) => {
    if (!onArc(A, extA, x, y, tol) || !onArc(B, extB, x, y, tol)) return;
    out.push({ x, y, ta: arcParam(A, x, y), tb: arcParam(B, x, y) });
  };
  if (tangent) {
    emit(bx, by);
    return;
  }
  const h = Math.sqrt(h2);
  emit(bx - h * uy, by + h * ux);
  emit(bx + h * uy, by - h * ux);
}

/** Signed residual of a point against a line (mode 0) or circle (mode 1). */
function resid(mode, o, x, y) {
  if (mode === 0) return ((x - o.px) * o.dy - (y - o.py) * o.dx) / Math.hypot(o.dx, o.dy);
  return Math.hypot(x - o.cx, y - o.cy) - o.r;
}

/** Refine the curve parameter of a hit near segment i of pl (fraction s). */
function refineCurve(pl, i, s, mode, o) {
  const src = pl.src,
    us = pl.us,
    pts = pl.pts;
  let a = us[i],
    b = us[i + 1];
  let fa = resid(mode, o, pts[2 * i], pts[2 * i + 1]);
  let fb = resid(mode, o, pts[2 * i + 2], pts[2 * i + 3]);
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (fa * fb < 0) {
    let side = 0,
      u = a + (b - a) * s;
    for (let it = 0; it < 60; it++) {
      u = (a * fb - b * fa) / (fb - fa);
      const c = curveAt(src, u);
      const fu = resid(mode, o, c.x, c.y);
      if (fu === 0) return u;
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
    return u;
  }
  // No sign change (near tangency): a few damped Newton steps.
  let u = a + (b - a) * s;
  const lo = us[Math.max(0, i - 1)],
    hi = us[Math.min(us.length - 1, i + 2)];
  for (let it = 0; it < 20; it++) {
    const c = curveAt(src, u);
    const f = resid(mode, o, c.x, c.y);
    let df;
    if (mode === 0) df = (c.dx * o.dy - c.dy * o.dx) / Math.hypot(o.dx, o.dy);
    else {
      const rr = Math.hypot(c.x - o.cx, c.y - o.cy) || 1;
      df = ((c.x - o.cx) * c.dx + (c.y - o.cy) * c.dy) / rr;
    }
    if (!(Math.abs(df) > 0)) break;
    let un = u - f / df;
    if (un < lo) un = lo;
    if (un > hi) un = hi;
    if (Math.abs(un - u) <= 1e-15 * Math.max(1, Math.abs(u))) break;
    u = un;
  }
  return u;
}

/** Bounding box of segment i of a flat point list. */
function segBox(pts, i, box) {
  const x1 = pts[2 * i],
    y1 = pts[2 * i + 1],
    x2 = pts[2 * i + 2],
    y2 = pts[2 * i + 3];
  box[0] = x1 < x2 ? x1 : x2;
  box[1] = y1 < y2 ? y1 : y2;
  box[2] = x1 < x2 ? x2 : x1;
  box[3] = y1 < y2 ? y2 : y1;
  return box;
}

function plBox(pl) {
  if (pl._box) return pl._box;
  const p = pl.pts;
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < p.length; i += 2) {
    if (p[i] < b[0]) b[0] = p[i];
    if (p[i + 1] < b[1]) b[1] = p[i + 1];
    if (p[i] > b[2]) b[2] = p[i];
    if (p[i + 1] > b[3]) b[3] = p[i + 1];
  }
  pl._box = b;
  return b;
}

/** Hits of a pl primitive against a seg / inf / arc primitive. */
function plOther(pl, o, extO, tol, out, plIsA) {
  const pts = pl.pts,
    us = pl.us;
  const nseg = (pts.length >> 1) - 1;
  const tmp = [];
  const L = o.t === 'arc' ? null : lineOf(o, extO);
  const mode = L ? 0 : 1;
  const ref = L ?? o;
  const sbox = [0, 0, 0, 0];
  // Quick reject against an arc's circle box or a bounded segment's box.
  let ob = null;
  if (o.t === 'arc') ob = [o.cx - o.r - tol, o.cy - o.r - tol, o.cx + o.r + tol, o.cy + o.r + tol];
  else if (o.t === 'seg' && !extO) {
    ob = [Math.min(o.x1, o.x2) - tol, Math.min(o.y1, o.y2) - tol, Math.max(o.x1, o.x2) + tol, Math.max(o.y1, o.y2) + tol];
  }
  if (ob) {
    const pb = plBox(pl);
    if (pb[0] > ob[2] || pb[2] < ob[0] || pb[1] > ob[3] || pb[3] < ob[1]) return;
  }
  for (let i = 0; i < nseg; i++) {
    if (ob) {
      segBox(pts, i, sbox);
      if (sbox[0] > ob[2] || sbox[2] < ob[0] || sbox[1] > ob[3] || sbox[3] < ob[1]) continue;
    }
    const S = { px: pts[2 * i], py: pts[2 * i + 1], dx: pts[2 * i + 2] - pts[2 * i], dy: pts[2 * i + 3] - pts[2 * i + 1], lo: 0, hi: 1 };
    tmp.length = 0;
    if (L) lineLine(S, L, tol, tmp, false);
    else lineArc(S, o, extO, tol, tmp, false);
    for (const h of tmp) {
      const u = refineCurve(pl, i, Math.min(1, Math.max(0, h.ta)), mode, ref);
      const c = curveAt(pl.src, u);
      let to;
      if (L) {
        const l2 = L.dx * L.dx + L.dy * L.dy;
        to = ((c.x - L.px) * L.dx + (c.y - L.py) * L.dy) / l2;
        if (!inRange(to, L.lo, L.hi, tol / Math.sqrt(l2))) continue;
      } else {
        if (!onArc(o, extO, c.x, c.y, tol * 10)) continue;
        to = arcParam(o, c.x, c.y);
      }
      hit(out, c.x, c.y, u, to, !plIsA);
    }
  }
}

/** Hits between two pl primitives (2D Newton refinement on both curves). */
function plPl(A, B, tol, out) {
  const ba = plBox(A),
    bb = plBox(B);
  if (ba[0] > bb[2] + tol || ba[2] < bb[0] - tol || ba[1] > bb[3] + tol || ba[3] < bb[1] - tol) return;
  const pa = A.pts,
    pb = B.pts;
  const na = (pa.length >> 1) - 1,
    nb = (pb.length >> 1) - 1;
  const boxA = [0, 0, 0, 0],
    boxB = [0, 0, 0, 0];
  const tmp = [];
  for (let i = 0; i < na; i++) {
    segBox(pa, i, boxA);
    if (boxA[0] > bb[2] + tol || boxA[2] < bb[0] - tol || boxA[1] > bb[3] + tol || boxA[3] < bb[1] - tol) continue;
    const S = { px: pa[2 * i], py: pa[2 * i + 1], dx: pa[2 * i + 2] - pa[2 * i], dy: pa[2 * i + 3] - pa[2 * i + 1], lo: 0, hi: 1 };
    for (let j = 0; j < nb; j++) {
      segBox(pb, j, boxB);
      if (boxA[0] > boxB[2] + tol || boxA[2] < boxB[0] - tol || boxA[1] > boxB[3] + tol || boxA[3] < boxB[1] - tol) continue;
      const T = { px: pb[2 * j], py: pb[2 * j + 1], dx: pb[2 * j + 2] - pb[2 * j], dy: pb[2 * j + 3] - pb[2 * j + 1], lo: 0, hi: 1 };
      tmp.length = 0;
      lineLine(S, T, tol, tmp, false);
      if (!tmp.length) continue;
      const h = tmp[0];
      let u = A.us[i] + (A.us[i + 1] - A.us[i]) * h.ta;
      let v = B.us[j] + (B.us[j + 1] - B.us[j]) * h.tb;
      const ulo = A.us[0],
        uhi = A.us[A.us.length - 1],
        vlo = B.us[0],
        vhi = B.us[B.us.length - 1];
      let ok = false,
        cx = h.x,
        cy = h.y;
      for (let it = 0; it < 16; it++) {
        const ca = curveAt(A.src, u),
          cb = curveAt(B.src, v);
        const fx = ca.x - cb.x,
          fy = ca.y - cb.y;
        if (Math.abs(fx) + Math.abs(fy) <= tol * 1e-3) {
          ok = true;
          cx = ca.x;
          cy = ca.y;
          break;
        }
        const a = ca.dx,
          b = -cb.dx,
          c = ca.dy,
          d = -cb.dy;
        const det = a * d - b * c;
        if (!(Math.abs(det) > 0)) break;
        u += (-fx * d + b * fy) / det;
        v += (-a * fy + c * fx) / det;
        if (u < ulo) u = ulo;
        if (u > uhi) u = uhi;
        if (v < vlo) v = vlo;
        if (v > vhi) v = vhi;
        if (it === 15) {
          const ca2 = curveAt(A.src, u),
            cb2 = curveAt(B.src, v);
          if (Math.hypot(ca2.x - cb2.x, ca2.y - cb2.y) <= tol) {
            ok = true;
            cx = ca2.x;
            cy = ca2.y;
          }
        }
      }
      if (!ok) {
        u = A.us[i] + (A.us[i + 1] - A.us[i]) * h.ta;
        v = B.us[j] + (B.us[j + 1] - B.us[j]) * h.tb;
      }
      out.push({ x: cx, y: cy, ta: u, tb: v });
    }
  }
}

/** Remove hits closer than tol to an earlier hit. */
function dedupeHits(hits, tol) {
  if (hits.length < 2) return hits;
  const t2 = tol * tol;
  const out = [];
  outer: for (const h of hits) {
    for (const q of out) if (dist2(h.x, h.y, q.x, q.y) <= t2) continue outer;
    out.push(h);
  }
  return out;
}

/**
 * Intersections of two primitives. opts.extA / opts.extB treat a seg as an
 * infinite line, an arc as its full circle and a ray as a full line.
 * opts.tol overrides the absolute tolerance.
 */
export function intersectPrims(a, b, opts) {
  const extA = !!opts?.extA,
    extB = !!opts?.extB;
  const tol = opts?.tol ?? EPS * Math.max(1, primScale(a), primScale(b));
  const out = [];
  const ta = a.t,
    tb = b.t;
  const lineA = ta === 'seg' || ta === 'inf',
    lineB = tb === 'seg' || tb === 'inf';
  if (lineA && lineB) lineLine(lineOf(a, extA), lineOf(b, extB), tol, out, false);
  else if (lineA && tb === 'arc') lineArc(lineOf(a, extA), b, extB, tol, out, false);
  else if (ta === 'arc' && lineB) lineArc(lineOf(b, extB), a, extA, tol, out, true);
  else if (ta === 'arc' && tb === 'arc') arcArc(a, b, extA, extB, tol, out);
  else if (ta === 'pl' && tb === 'pl') plPl(a, b, tol, out);
  else if (ta === 'pl') plOther(a, b, extB, tol, out, true);
  else if (tb === 'pl') plOther(b, a, extA, tol, out, false);
  if (out.length < 2) return out;
  return dedupeHits(out, hitMergeTol(tol, Math.max(primSize(a), primSize(b))));
}

/** Intersection points { x, y } between two entities. */
export function intersectEntities(e1, e2, opts) {
  const pa = toPrims(e1),
    pb = toPrims(e2);
  const out = [];
  let scale = 1,
    size = 0;
  for (const p of pa) for (const q of pb) for (const h of intersectPrims(p, q, opts)) {
    out.push({ x: h.x, y: h.y });
    scale = Math.max(scale, Math.abs(h.x), Math.abs(h.y));
    size = Math.max(size, primSize(p), primSize(q));
  }
  return dedupeHits(out, hitMergeTol(EPS * scale, size));
}

/**
 * Self-intersections of a polyline: crossings between segments other than
 * neighbours meeting at their shared vertex. Returns [{ x, y, i, j }] with the two segment indices.
 */
export function selfIntersections(poly) {
  const prims = toPrims(poly);
  const n = prims.length;
  const out = [];
  if (n < 2) return out;
  const pts = poly.pts;
  const boxes = prims.map(primBox);
  const nv = Math.floor(pts.length / 3);
  let scale = 0;
  for (let k = 0; k < nv * 3; k += 3) {
    scale = Math.max(scale, Math.abs(pts[k]), Math.abs(pts[k + 1]));
  }
  const tol2 = (EPS * 100 * Math.max(1, scale)) ** 2;
  // Neighbours meet at their shared vertex; only other hits count.
  const atVertex = (h, v) => dist2(h.x, h.y, pts[v * 3], pts[v * 3 + 1]) <= tol2;
  for (let i = 0; i < n; i++) {
    const A = prims[i];
    const bi = boxes[i];
    for (let j = i + 1; j < n; j++) {
      const B = prims[j];
      const bj = boxes[j];
      if (bi[0] > bj[2] || bi[2] < bj[0] || bi[1] > bj[3] || bi[3] < bj[1]) continue;
      // Consecutive primitives (zero-length segments are skipped) and the
      // last and first of a closed polyline.
      const next = j === i + 1;
      const wrap = poly.closed && i === 0 && j === n - 1;
      for (const h of intersectPrims(A, B)) {
        if (next && atVertex(h, B.seg)) continue;
        if (wrap && atVertex(h, A.seg)) continue;
        out.push({ x: h.x, y: h.y, i: A.seg, j: B.seg });
      }
    }
  }
  return out;
}

/** Box [minX, minY, maxX, maxY] of a primitive: an arc's whole circle, a curve's chords. */
export function primBox(p) {
  if (p.t === 'seg') return [Math.min(p.x1, p.x2), Math.min(p.y1, p.y2), Math.max(p.x1, p.x2), Math.max(p.y1, p.y2)];
  if (p.t === 'arc') return [p.cx - p.r, p.cy - p.r, p.cx + p.r, p.cy + p.r];
  if (p.t === 'pl') return plBox(p);
  return [-Infinity, -Infinity, Infinity, Infinity];
}
