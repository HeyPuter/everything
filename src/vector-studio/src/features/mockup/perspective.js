/**
 * Projective (four-corner) mapping of the unit square onto a quadrilateral,
 * and the envelope mesh that follows it.
 *
 * Corners are listed clockwise from the top left: [TL, TR, BR, BL] as
 * { x, y }. The square's (u, v) = (0, 0), (1, 0), (1, 1), (0, 1) land on
 * them in that order. Straight lines stay straight and the far side of a
 * receding surface is compressed, as a flat surface seen in a photo is.
 */
import { meshFromSurface } from '../envelope/envelope-model.js';

const EPS = 1e-9;

/**
 * The homography of a quad: { a, b, c, d, e, f, g, h } with
 *   x = (a u + b v + c) / (g u + h v + 1)
 *   y = (d u + e v + f) / (g u + h v + 1)
 * or null when three corners are collinear.
 */
export function quadHomography(q) {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < EPS && Math.abs(sy) < EPS) {
    // A parallelogram: the mapping is affine.
    const H = { a: p1.x - p0.x, b: p3.x - p0.x, c: p0.x, d: p1.y - p0.y, e: p3.y - p0.y, f: p0.y, g: 0, h: 0 };
    return Math.abs(H.a * H.e - H.b * H.d) < EPS ? null : H;
  }
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < EPS) return null;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

/** The point of the quad at (u, v). */
export function mapUV(H, u, v) {
  const w = H.g * u + H.h * v + 1;
  return { x: (H.a * u + H.b * v + H.c) / w, y: (H.d * u + H.e * v + H.f) / w };
}

/** (u, v) of a point of the quad's plane (the inverse mapping), or null on the horizon. */
export function unmapUV(H, x, y) {
  // Solve [a - g x, b - h x; d - g y, e - h y] [u v]' = [x - c, y - f]'.
  const m00 = H.a - H.g * x;
  const m01 = H.b - H.h * x;
  const m10 = H.d - H.g * y;
  const m11 = H.e - H.h * y;
  const det = m00 * m11 - m01 * m10;
  if (Math.abs(det) < EPS) return null;
  const rx = x - H.c;
  const ry = y - H.f;
  return { u: (rx * m11 - m01 * ry) / det, v: (m00 * ry - m10 * rx) / det };
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** True for a convex quad with its corners in order (either winding) and no three collinear. */
export function isConvexQuad(q) {
  if (!Array.isArray(q) || q.length !== 4 || q.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (Math.abs(c) < 1e-6) return false;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** Corners of a rectangle { x, y, w, h }. */
export function rectQuad(r) {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

/** Bounding box of points. */
export function quadBounds(q) {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Corners in the order the mapping wants: the top-left-most first, then
 * clockwise on screen (y points down).
 */
export function orderQuad(points) {
  const c = points.reduce((s, p) => ({ x: s.x + p.x / points.length, y: s.y + p.y / points.length }), { x: 0, y: 0 });
  const sorted = points.slice().sort((p, q) => Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(q.y - c.y, q.x - c.x));
  // atan2 grows clockwise on screen; start at the corner nearest the top left.
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  return [0, 1, 2, 3].map((k) => ({ x: sorted[(start + k) % 4].x, y: sorted[(start + k) % 4].y }));
}

/**
 * How many mesh patches per side follow the perspective closely: one for a
 * parallelogram (exact), more the stronger the foreshortening.
 */
export function perspectiveGrid(H) {
  const k = Math.max(Math.abs(H.g), Math.abs(H.h));
  if (k < 1e-6) return 1;
  return Math.max(4, Math.min(12, Math.ceil(4 + k * 12)));
}

/** An envelope mesh (rows x cols Coons patches) following the quad's perspective, or null. */
export function perspectiveMesh(q, n = null) {
  const H = quadHomography(q);
  if (!H) return null;
  const k = n ?? perspectiveGrid(H);
  return meshFromSurface((u, v) => mapUV(H, u, v), k, k);
}

/** Indices of a mesh's four corner points, [TL, TR, BR, BL]. */
export function meshCornerIndices(mesh) {
  const c = mesh.cols;
  const r = mesh.rows;
  return [0, c, r * (c + 1) + c, r * (c + 1)];
}

/** The four corners of a mesh as { x, y }. */
export function meshQuad(mesh) {
  return meshCornerIndices(mesh).map((k) => ({ x: mesh.points[k].x, y: mesh.points[k].y }));
}
