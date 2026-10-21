/**
 * Cutting openings out of roof faces: an opening may lie inside one face
 * (a hole) or straddle several (each face loses the part it covers).
 */

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

export function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
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

/** Keep the part of a polygon on one side of the line p→q (left: cross > 0). */
export function clipHalf(poly, p, q, left = true) {
  const s = (v) => (left ? 1 : -1) * cross(p, q, v);
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = s(a);
    const sb = s(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** A polygon minus a convex polygon, as pieces (each outside one edge of the cut, inside the earlier ones). */
export function subtractConvex(poly, cut) {
  const c = signedArea(cut) < 0 ? cut.slice().reverse() : cut;
  const pieces = [];
  let rest = poly;
  for (let i = 0; i < c.length && rest.length >= 3; i++) {
    const p = c[i];
    const q = c[(i + 1) % c.length];
    const outside = clipHalf(rest, p, q, false);
    if (outside.length >= 3 && Math.abs(signedArea(outside)) > 1) pieces.push(outside);
    rest = clipHalf(rest, p, q, true);
  }
  return pieces;
}

export function isConvex(poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const c = cross(poly[i], poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]);
    if (Math.abs(c) < 1e-9) continue;
    if (sign && Math.sign(c) !== sign) return false;
    sign = Math.sign(c);
  }
  return true;
}

/** Parameter intervals [t0, t1] of segment a→b that lie inside a polygon. */
export function segmentInside(a, b, poly) {
  const ts = [0, 1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const d1 = [b[0] - a[0], b[1] - a[1]];
    const d2 = [q[0] - p[0], q[1] - p[1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p[0] - a[0]) * d2[1] - (p[1] - a[1]) * d2[0]) / den;
    const u = ((p[0] - a[0]) * d1[1] - (p[1] - a[1]) * d1[0]) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (t1 - t0 < 1e-9) continue;
    const m = (t0 + t1) / 2;
    if (pointInPolygon([a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m], poly)) {
      if (out.length && Math.abs(out.at(-1)[1] - t0) < 1e-9) out.at(-1)[1] = t1;
      else out.push([t0, t1]);
    }
  }
  return out;
}

/** Intervals of a→b outside every one of some polygons. */
export function segmentOutside(a, b, polys) {
  let keep = [[0, 1]];
  for (const poly of polys) {
    const inside = segmentInside(a, b, poly);
    const next = [];
    for (const [k0, k1] of keep) {
      let start = k0;
      for (const [i0, i1] of inside) {
        if (i1 <= start || i0 >= k1) continue;
        if (i0 > start) next.push([start, i0]);
        start = Math.max(start, i1);
      }
      if (start < k1) next.push([start, k1]);
    }
    keep = next;
  }
  return keep.filter(([t0, t1]) => t1 - t0 > 1e-6);
}

/**
 * A roof face with openings taken out: { pieces: [{ outer, holes }], crossing }
 * where `crossing` are the openings that straddle the face's edge.
 */
export function cutFace(face, openings) {
  const inner = [];
  const crossing = [];
  for (const h of openings) {
    const insideCount = h.filter((p) => pointInPolygon(p, face)).length;
    if (insideCount === h.length) inner.push(h);
    else if (insideCount > 0 || face.some((p) => pointInPolygon(p, h)) || h.some((p, i) => segmentInside(p, h[(i + 1) % h.length], face).length)) crossing.push(h);
  }
  let polys = [face];
  for (const h of crossing) {
    const cut = isConvex(h) ? h : hull(h);
    polys = polys.flatMap((p) => subtractConvex(p, cut));
  }
  const pieces = polys.map((outer) => ({ outer, holes: inner.filter((h) => h.every((p) => pointInPolygon(p, outer))) }));
  return { pieces, inner, crossing };
}

function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
