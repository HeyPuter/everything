/**
 * 2D geometry on plain [x, y] arrays (millimetres). Small, allocation-light
 * helpers used by the model, plan graphics, snapping and picking.
 */
import earcut from 'earcut';

export const EPS = 1e-6;

export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const scale = (a, s) => [a[0] * s, a[1] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const perp = (a) => [-a[1], a[0]];
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const eq = (a, b, tol = 1e-3) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

export function norm(a) {
  const l = Math.hypot(a[0], a[1]);
  return l > EPS ? [a[0] / l, a[1] / l] : [0, 0];
}

export function rotate(p, ang, c = [0, 0]) {
  const s = Math.sin(ang);
  const k = Math.cos(ang);
  const x = p[0] - c[0];
  const y = p[1] - c[1];
  return [c[0] + x * k - y * s, c[1] + x * s + y * k];
}

export function angleOf(v) {
  return Math.atan2(v[1], v[0]);
}

/** Normalize an angle to [0, 2pi). */
export function normAngle(a) {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

/** Reflect point p across the line through a and b. */
export function reflect(p, a, b) {
  const d = norm(sub(b, a));
  const v = sub(p, a);
  const along = scale(d, dot(v, d));
  const perpV = sub(v, along);
  return sub(add(a, along), perpV);
}

/** Closest point on segment ab to p, with its parameter t in [0, 1]. */
export function closestOnSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  let t = l2 > EPS ? dot(sub(p, a), ab) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { point: [a[0] + ab[0] * t, a[1] + ab[1] * t], t };
}

/** Closest point on the infinite line through a and b. */
export function closestOnLine(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > EPS ? dot(sub(p, a), ab) / l2 : 0;
  return { point: [a[0] + ab[0] * t, a[1] + ab[1] * t], t };
}

export function distToSegment(p, a, b) {
  return dist(p, closestOnSegment(p, a, b).point);
}

/**
 * Intersection of the infinite lines p + t r and q + u s. Returns
 * { point, t, u } or null when parallel.
 */
export function lineIntersect(p, r, q, s) {
  const d = cross(r, s);
  if (Math.abs(d) < 1e-12 * (len(r) * len(s) || 1)) return null;
  const qp = sub(q, p);
  const t = cross(qp, s) / d;
  const u = cross(qp, r) / d;
  return { point: [p[0] + r[0] * t, p[1] + r[1] * t], t, u };
}

/** Segment-segment intersection (with a small tolerance on the parameters). */
export function segmentIntersect(a, b, c, d, tol = 1e-9) {
  const r = lineIntersect(a, sub(b, a), c, sub(d, c));
  if (!r) return null;
  if (r.t < -tol || r.t > 1 + tol || r.u < -tol || r.u > 1 + tol) return null;
  return r;
}

/** Signed area, positive for counterclockwise. */
export function signedArea(poly) {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function area(poly) {
  return Math.abs(signedArea(poly));
}

export function perimeter(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += dist(poly[i], poly[(i + 1) % poly.length]);
  return s;
}

export function centroid(poly) {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < EPS) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function ensureCCW(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

export function ensureCW(poly) {
  return signedArea(poly) > 0 ? poly.slice().reverse() : poly;
}

export function bbox(points) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return { x0, y0, x1, y1 };
}

export function bboxUnion(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function bboxIntersects(a, b) {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

export function bboxContains(outer, inner) {
  return inner.x0 >= outer.x0 && inner.x1 <= outer.x1 && inner.y0 >= outer.y0 && inner.y1 <= outer.y1;
}

/** Drop consecutive duplicate points and collinear points from a closed polygon. */
export function cleanPolygon(poly, tol = 0.01) {
  let out = [];
  for (const p of poly) if (!out.length || !eq(out.at(-1), p, tol)) out.push(p);
  if (out.length > 1 && eq(out[0], out.at(-1), tol)) out.pop();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const ab = sub(b, a);
      const bc = sub(c, b);
      const lab = len(ab);
      const lbc = len(bc);
      if (lab < tol || lbc < tol || (Math.abs(cross(ab, bc)) / (lab * lbc) < 1e-7 && dot(ab, bc) > 0)) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Offset a simple polygon by d (positive grows a counterclockwise polygon).
 * Mitered corners, with a miter limit that bevels very sharp corners.
 */
export function offsetPolygon(poly, d) {
  const p = ensureCCW(poly);
  const n = p.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n];
    const b = p[i];
    const c = p[(i + 1) % n];
    const n1 = norm(perp(sub(b, a)));
    const n2 = norm(perp(sub(c, b)));
    // Outward normals of a CCW polygon point to the right of travel.
    const o1 = [n1[1], -n1[0]];
    const o2 = [n2[1], -n2[0]];
    const l1a = add(a, scale(o1, d));
    const l2a = add(b, scale(o2, d));
    const hit = lineIntersect(l1a, sub(b, a), l2a, sub(c, b));
    if (!hit) {
      out.push(add(b, scale(o1, d)));
      continue;
    }
    const miter = dist(hit.point, b);
    if (miter > Math.abs(d) * 4) {
      out.push(add(b, scale(o1, d)), add(b, scale(o2, d)));
    } else out.push(hit.point);
  }
  return out;
}

/**
 * Clip a polygon by the half-plane { p : dot(nrm, p) <= c }
 * (Sutherland-Hodgman against one edge).
 */
export function clipHalfPlane(poly, nrm, c) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const da = dot(nrm, a) - c;
    const db = dot(nrm, b) - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push(lerp(a, b, t));
    }
  }
  return out;
}

/** Triangulate a polygon with holes. Returns a flat array of [x, y] triangles' vertex indices into `points`. */
export function triangulate(outer, holes = []) {
  const flat = [];
  const holeIdx = [];
  const points = [];
  for (const p of outer) {
    flat.push(p[0], p[1]);
    points.push(p);
  }
  for (const h of holes) {
    holeIdx.push(points.length);
    for (const p of h) {
      flat.push(p[0], p[1]);
      points.push(p);
    }
  }
  const tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
  return { points, tris };
}

/**
 * Subtract intervals from [0, length]; intervals are [a, b] pairs. Returns
 * the remaining sub-intervals, longer than `minLen`.
 */
export function subtractIntervals(length, cuts, minLen = 0.5) {
  const sorted = cuts
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(length, Math.max(a, b))])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  let cur = 0;
  for (const [a, b] of sorted) {
    if (a > cur + minLen) out.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (length > cur + minLen) out.push([cur, length]);
  return out;
}

/** Points along an arc from a0 to a1 (radians, counterclockwise when a1 > a0). */
export function arcPoints(c, r, a0, a1, maxSeg = Math.PI / 24) {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / maxSeg));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return out;
}

/** Circle through three points, or null if collinear. */
export function circleFrom3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < EPS) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
}

export function rectPolygon(a, b) {
  return [
    [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
    [Math.max(a[0], b[0]), Math.min(a[1], b[1])],
    [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
    [Math.min(a[0], b[0]), Math.max(a[1], b[1])],
  ];
}

/** True when segment ab crosses or lies inside the box. */
export function segmentIntersectsBox(a, b, box) {
  if (Math.max(a[0], b[0]) < box.x0 || Math.min(a[0], b[0]) > box.x1 || Math.max(a[1], b[1]) < box.y0 || Math.min(a[1], b[1]) > box.y1) return false;
  const inside = (p) => p[0] >= box.x0 && p[0] <= box.x1 && p[1] >= box.y0 && p[1] <= box.y1;
  if (inside(a) || inside(b)) return true;
  const c = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ];
  for (let i = 0; i < 4; i++) if (segmentIntersect(a, b, c[i], c[(i + 1) % 4])) return true;
  return false;
}
