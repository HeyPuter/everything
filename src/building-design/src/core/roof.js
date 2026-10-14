/**
 * Footprint roofs. Each footprint edge either defines a slope (the roof
 * plane rises inward from that edge) or not (a gable end). The roof's
 * underside is the lowest of the slope planes at every point, which yields
 * hips, valleys and ridges without any special cases: the face of plane i is
 * the part of the footprint where plane i is lowest.
 */
import { clipHalfPlane, signedArea, dot, sub, dist, cleanPolygon } from './geom.js';

/**
 * planes: [{ edge: i, m: inward unit normal, p: point on edge, k: tan(slope), slope }]
 */
export function roofPlanes(boundary, slopes) {
  const ccw = signedArea(boundary) < 0;
  const poly = ccw ? boundary.slice().reverse() : boundary;
  // Slopes follow the original edge order; reversing the loop reverses the
  // edges too (edge i of the reversed loop is original edge n-2-i, mod n).
  const n = poly.length;
  const slopeAt = (i) => {
    if (!ccw) return slopes?.[i];
    return slopes?.[(n - 2 - i + 2 * n) % n];
  };
  const planes = [];
  for (let i = 0; i < n; i++) {
    const s = slopeAt(i);
    if (s == null || !Number.isFinite(+s) || +s <= 0) continue;
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const d = sub(b, a);
    const l = Math.hypot(d[0], d[1]);
    if (l < 1e-6) continue;
    const m = [-d[1] / l, d[0] / l];
    const slope = Math.min(+s, 85);
    planes.push({ edge: i, m, p: a, k: Math.tan((slope * Math.PI) / 180), slope });
  }
  return { poly, planes };
}

export function planeHeight(pl, p) {
  return pl.k * dot(sub(p, pl.p), pl.m);
}

/** Height above the eave of the roof underside at plan point p. */
export function roofHeightAt(planes, p) {
  if (!planes.length) return 0;
  let h = Infinity;
  for (const pl of planes) h = Math.min(h, planeHeight(pl, p));
  return h;
}

/**
 * Faces of the roof: [{ poly, plane }] where plane is null for a flat roof.
 * Also returns ridge/hip/valley lines between faces.
 */
export function roofFaces(boundary, slopes) {
  const { poly, planes } = roofPlanes(ensureLoop(boundary), slopes);
  if (!planes.length) return { poly, planes, faces: [{ poly, plane: null }], ridges: [] };
  const faces = [];
  for (let i = 0; i < planes.length; i++) {
    const A = planes[i];
    let region = poly;
    for (let j = 0; j < planes.length && region.length >= 3; j++) {
      if (j === i) continue;
      const B = planes[j];
      // A(p) <= B(p)  <=>  (kA mA - kB mB) . p <= kA mA.pA - kB mB.pB
      const nx = A.k * A.m[0] - B.k * B.m[0];
      const ny = A.k * A.m[1] - B.k * B.m[1];
      const c = A.k * dot(A.m, A.p) - B.k * dot(B.m, B.p);
      const nl = Math.hypot(nx, ny);
      if (nl < 1e-9) {
        if (c < -1e-6 || (Math.abs(c) <= 1e-6 && j < i)) region = [];
        continue;
      }
      region = clipHalfPlane(region, [nx / nl, ny / nl], c / nl);
    }
    region = cleanPolygon(region, 0.5);
    if (region.length >= 3 && Math.abs(signedArea(region)) > 10) faces.push({ poly: region, plane: A });
  }
  // Ridges: face edges that are not on the footprint boundary.
  const ridges = [];
  const onBoundary = (a, b) => {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      if (distToLine(a, p, q) < 1 && distToLine(b, p, q) < 1) return true;
    }
    return false;
  };
  const seen = [];
  for (const f of faces) {
    for (let i = 0; i < f.poly.length; i++) {
      const a = f.poly[i];
      const b = f.poly[(i + 1) % f.poly.length];
      if (dist(a, b) < 1 || onBoundary(a, b)) continue;
      if (seen.some(([x, y]) => (dist(x, a) < 1 && dist(y, b) < 1) || (dist(x, b) < 1 && dist(y, a) < 1))) continue;
      seen.push([a, b]);
      ridges.push([a, b]);
    }
  }
  return { poly, planes, faces, ridges };
}

function ensureLoop(b) {
  return b.length > 1 && dist(b[0], b.at(-1)) < 1e-6 ? b.slice(0, -1) : b;
}

function distToLine(p, a, b) {
  const d = sub(b, a);
  const l = Math.hypot(d[0], d[1]);
  if (l < 1e-9) return dist(p, a);
  return Math.abs((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]) / l;
}

/** Thickness measured vertically for a plane of given slope. */
export function verticalThickness(thickness, plane) {
  if (!plane) return thickness;
  return thickness / Math.cos((plane.slope * Math.PI) / 180);
}

/**
 * Break points of the roof profile along footprint edge i: sorted points on
 * the edge where the active face changes, including both ends.
 */
export function edgeProfile(faces, a, b) {
  const d = sub(b, a);
  const l = Math.hypot(d[0], d[1]);
  const ts = [0, 1];
  for (const f of faces)
    for (const p of f.poly) {
      if (distToLine(p, a, b) > 1) continue;
      const t = dot(sub(p, a), d) / (l * l);
      if (t > 1e-6 && t < 1 - 1e-6) ts.push(t);
    }
  ts.sort((x, y) => x - y);
  const out = [];
  for (const t of ts) if (!out.length || (t - out.at(-1)) * l > 0.5) out.push(t);
  return out.map((t) => [a[0] + d[0] * t, a[1] + d[1] * t]);
}
