/**
 * Mask geometry shared by the rasterizer and the on-canvas editor. Shapes are
 * built in mask-local pixels (origin at the mask center, before rotation, y
 * down) for a source frame of SW x SH pixels, then mapped to the source frame
 * and from there onto the project canvas through the clip's crop, flip and
 * transform.
 */

import { boxPoint, boxLocal } from '../lib/geometry.js';

const TAU = Math.PI * 2;

/** Regular star with n points and inner radius ratio, unit outer radius, first point up. */
export function starPoints(n, inner) {
  const out = [];
  const count = Math.max(3, Math.round(n));
  for (let i = 0; i < count * 2; i++) {
    const r = i % 2 ? inner : 1;
    const a = -Math.PI / 2 + (i * Math.PI) / count;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}

/** Regular polygon with n sides, unit radius, first corner up. */
export function polygonPoints(n) {
  const out = [];
  const count = Math.max(3, Math.round(n));
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * TAU) / count;
    out.push([Math.cos(a), Math.sin(a)]);
  }
  return out;
}

/** Unit ellipse (circle) outline. */
export function ellipsePoints(samples = 96) {
  const out = [];
  for (let i = 0; i < samples; i++) {
    const a = (i * TAU) / samples;
    out.push([Math.cos(a), Math.sin(a)]);
  }
  return out;
}

let heartCache = null;
/**
 * Heart outline filling the box -1..1 (lobes up, point down). Built from a
 * classic trigonometric heart curve, normalized to its bounds.
 */
export function heartPoints(samples = 96) {
  if (heartCache && heartCache.length === samples) return heartCache;
  const raw = [];
  for (let i = 0; i < samples; i++) {
    const t = (i * TAU) / samples;
    const x = 16 * Math.sin(t) ** 3;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    raw.push([x, y]);
  }
  const xs = raw.map((p) => p[0]);
  const ys = raw.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  heartCache = raw.map(([x, y]) => [((x - x0) / (x1 - x0)) * 2 - 1, ((y - y0) / (y1 - y0)) * 2 - 1]);
  return heartCache;
}

/** Rounded rectangle outline with half sizes a, b and corner radius r (clamped). */
export function roundedRectPoints(a, b, r, perCorner = 10) {
  const rr = Math.max(0, Math.min(r, a, b));
  if (rr <= 1e-6) return [[-a, -b], [a, -b], [a, b], [-a, b]];
  const out = [];
  const corners = [[a - rr, -b + rr, -Math.PI / 2], [a - rr, b - rr, 0], [-a + rr, b - rr, Math.PI / 2], [-a + rr, -b + rr, Math.PI]];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= perCorner; i++) {
      const ang = start + (i / perCorner) * (Math.PI / 2);
      out.push([cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr]);
    }
  }
  return out;
}

/** Signed distance from (px, py) to a rounded rectangle centered at 0 (negative inside). */
export function roundedRectSdf(px, py, a, b, r) {
  const rr = Math.max(0, Math.min(r, a, b));
  const qx = Math.abs(px) - a + rr;
  const qy = Math.abs(py) - b + rr;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
}

/** Point on a cubic bezier. */
export function cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

const hasHandles = (p) => p.ix || p.iy || p.ox || p.oy;

/** Control points of segment i (from point i to the next) of a pen path. */
export function pathSegment(path, i) {
  const a = path[i];
  const b = path[(i + 1) % path.length];
  return [[a.x, a.y], [a.x + (a.ox || 0), a.y + (a.oy || 0)], [b.x + (b.ix || 0), b.y + (b.iy || 0)], [b.x, b.y]];
}

/**
 * Sample a closed pen path ({ x, y, ix, iy, ox, oy } points; handles are
 * offsets from their point) into a polygon. Straight segments add only
 * their start point. Returns [[x, y], ...] plus, per vertex, the segment and
 * t it came from (for inserting points on the path).
 */
export function samplePath(path, steps = 16) {
  const pts = [];
  const at = [];
  const n = path.length;
  if (n < 2) return { pts: path.map((p) => [p.x, p.y]), at: path.map((_, i) => ({ seg: i, t: 0 })) };
  for (let i = 0; i < n; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    const curved = (a.ox || a.oy) || (b.ix || b.iy);
    if (!curved) {
      pts.push([a.x, a.y]);
      at.push({ seg: i, t: 0 });
      continue;
    }
    const [p0, p1, p2, p3] = pathSegment(path, i);
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      pts.push(cubicAt(p0, p1, p2, p3, t));
      at.push({ seg: i, t });
    }
  }
  return { pts, at };
}

/**
 * Insert a point on segment seg at parameter t without changing the shape
 * (de Casteljau split). Returns a new path.
 */
export function insertPathPoint(path, seg, t) {
  const n = path.length;
  const a = path[seg];
  const b = path[(seg + 1) % n];
  const [p0, p1, p2, p3] = pathSegment(path, seg);
  const lerp = (u, v, k) => [u[0] + (v[0] - u[0]) * k, u[1] + (v[1] - u[1]) * k];
  const q0 = lerp(p0, p1, t);
  const q1 = lerp(p1, p2, t);
  const q2 = lerp(p2, p3, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const s = lerp(r0, r1, t);
  const curved = hasHandles({ ox: a.ox, oy: a.oy }) || hasHandles({ ix: b.ix, iy: b.iy });
  const out = path.map((p) => ({ ...p }));
  const mid = { x: s[0], y: s[1], ix: 0, iy: 0, ox: 0, oy: 0 };
  if (curved) {
    out[seg].ox = q0[0] - p0[0];
    out[seg].oy = q0[1] - p0[1];
    mid.ix = r0[0] - s[0];
    mid.iy = r0[1] - s[1];
    mid.ox = r1[0] - s[0];
    mid.oy = r1[1] - s[1];
    const bi = (seg + 1) % n;
    out[bi].ix = q2[0] - p3[0];
    out[bi].iy = q2[1] - p3[1];
  }
  out.splice(seg + 1, 0, mid);
  return out;
}

/** Nearest point on a polyline (closed) to p: { dist, index, t } where index is the vertex starting the edge. */
export function nearestOnPolygon(pts, p) {
  let best = { dist: Infinity, index: -1, t: 0 };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    const d = Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
    if (d < best.dist) best = { dist: d, index: i, t };
  }
  return best;
}

/** Half sizes of a mask's box in source pixels. */
export function maskHalf(m, SW, SH) {
  return { a: (Math.abs(m.w) * SW) / 2, b: (Math.abs(m.h) * SH) / 2 };
}

/**
 * Closed outline of a box-shaped mask in mask-local pixels, or null for
 * shapes that are not a single closed outline (split, band, text, brush).
 */
export function maskOutline(m, SW, SH) {
  const { a, b } = maskHalf(m, SW, SH);
  const scale = (pts) => pts.map(([x, y]) => [x * a, y * b]);
  switch (m.type) {
    case 'ellipse': return scale(ellipsePoints(96));
    case 'rectangle': return roundedRectPoints(a, b, ((m.roundness || 0) / 100) * Math.min(a, b));
    case 'star': return scale(starPoints(m.count || 5, m.inner ?? 0.45));
    case 'polygon': return scale(polygonPoints(m.count || 6));
    case 'heart': return scale(heartPoints(96));
    case 'pen': {
      if (!m.path?.length) return null;
      return samplePath(m.path).pts.map(([x, y]) => [x * 2 * a, y * 2 * b]);
    }
    default: return null;
  }
}

/** Mask-local pixels to source pixels (rotation clockwise, y down). */
export function maskToSource(m, SW, SH, lx, ly) {
  const r = ((m.rotation || 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [(0.5 + m.x) * SW + lx * c - ly * s, (0.5 + m.y) * SH + lx * s + ly * c];
}

/** Source pixels to mask-local pixels. */
export function sourceToMask(m, SW, SH, sx, sy) {
  const r = ((m.rotation || 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = sx - (0.5 + m.x) * SW;
  const dy = sy - (0.5 + m.y) * SH;
  return [dx * c + dy * s, -dx * s + dy * c];
}

/**
 * Source pixels to project pixels for a layer drawn in box (from
 * Compositor.layerBox): crop, flip, then the layer's rotation.
 */
export function sourceToProject(layer, box, SW, SH, sx, sy) {
  const crop = layer.crop || { l: 0, t: 0, r: 0, b: 0 };
  let qx = (sx / SW - crop.l) / Math.max(1e-6, 1 - crop.l - crop.r);
  let qy = (sy / SH - crop.t) / Math.max(1e-6, 1 - crop.t - crop.b);
  if (layer.flipH) qx = 1 - qx;
  if (layer.flipV) qy = 1 - qy;
  return boxPoint(box, layer.rotation || 0, qx - 0.5, qy - 0.5);
}

/** Project pixels to source pixels (inverse of sourceToProject). */
export function projectToSource(layer, box, SW, SH, px, py) {
  const crop = layer.crop || { l: 0, t: 0, r: 0, b: 0 };
  const [u, v] = boxLocal(box, layer.rotation || 0, px, py);
  let qx = u + 0.5, qy = v + 0.5;
  if (layer.flipH) qx = 1 - qx;
  if (layer.flipV) qy = 1 - qy;
  return [(crop.l + qx * (1 - crop.l - crop.r)) * SW, (crop.t + qy * (1 - crop.t - crop.b)) * SH];
}

/**
 * Clip the infinite line through p along direction d to the rectangle
 * [x0, x1] x [y0, y1]. Returns [[x, y], [x, y]] or null.
 */
export function clipLine(p, d, x0, y0, x1, y1) {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (const [pc, dc, lo, hi] of [[p[0], d[0], x0, x1], [p[1], d[1], y0, y1]]) {
    if (Math.abs(dc) < 1e-12) {
      if (pc < lo || pc > hi) return null;
      continue;
    }
    let a = (lo - pc) / dc;
    let b = (hi - pc) / dc;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
  }
  if (t0 > t1) return null;
  return [[p[0] + d[0] * t0, p[1] + d[1] * t0], [p[0] + d[0] * t1, p[1] + d[1] * t1]];
}

/** Whether a point is inside a polygon (even-odd). */
export function pointInPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Hard-edged coverage (0 or 1) of a mask at a source pixel; used by tests and hit testing. */
export function maskContains(m, SW, SH, sx, sy) {
  const [lx, ly] = sourceToMask(m, SW, SH, sx, sy);
  const { a, b } = maskHalf(m, SW, SH);
  switch (m.type) {
    case 'split': return ly >= 0;
    case 'band': return Math.abs(ly) <= b;
    case 'ellipse': return (lx / a) ** 2 + (ly / b) ** 2 <= 1;
    case 'rectangle': return roundedRectSdf(lx, ly, a, b, ((m.roundness || 0) / 100) * Math.min(a, b)) <= 0;
    case 'text':
    case 'brush': return Math.abs(lx) <= a && Math.abs(ly) <= b;
    default: {
      const poly = maskOutline(m, SW, SH);
      return poly ? pointInPolygon(poly, lx, ly) : false;
    }
  }
}
