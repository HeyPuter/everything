/**
 * Small geometric helpers shared by commands.
 */
import { toPrims, closestPoint } from '../../core/geom/index.js';

export const TAU = Math.PI * 2;
export const norm = (a) => ((a % TAU) + TAU) % TAU;
export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
export const angleOf = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
export const polar = (p, a, d) => ({ x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d });

export const M = {
  translate: (dx, dy) => [1, 0, 0, 1, dx, dy],
  rotate(a, cx, cy) {
    const c = Math.cos(a),
      s = Math.sin(a);
    return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
  },
  scale(k, cx, cy) {
    return [k, 0, 0, k, cx - k * cx, cy - k * cy];
  },
  mirror(p, q) {
    const l = Math.hypot(q.x - p.x, q.y - p.y);
    if (l < 1e-12) return [1, 0, 0, 1, 0, 0];
    const ux = (q.x - p.x) / l,
      uy = (q.y - p.y) / l;
    const a = 2 * ux * ux - 1,
      b = 2 * ux * uy,
      d = 2 * uy * uy - 1;
    return [a, b, b, d, p.x - a * p.x - b * p.y, p.y - b * p.x - d * p.y];
  },
  apply(m, p) {
    return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
  },
};

/** Circle through three points, or null when collinear. */
export function circle3(a, b, c) {
  // Relative to a, so points far from the origin keep their precision.
  const bx = b.x - a.x,
    by = b.y - a.y,
    cx = c.x - a.x,
    cy = c.y - a.y;
  const b2 = bx * bx + by * by,
    c2 = cx * cx + cy * cy;
  const d = 2 * (bx * cy - by * cx);
  if (!(Math.abs(d) > 1e-12 * Math.max(b2, c2))) return null;
  const ux = (cy * b2 - by * c2) / d,
    uy = (bx * c2 - cx * b2) / d;
  return { cx: a.x + ux, cy: a.y + uy, r: Math.hypot(ux, uy) };
}

/** Arc fields {cx, cy, r, start, end} from start, a point on the arc, and end. */
export function arc3(a, b, c) {
  const k = circle3(a, b, c);
  if (!k) return null;
  let s = Math.atan2(a.y - k.cy, a.x - k.cx);
  let e = Math.atan2(c.y - k.cy, c.x - k.cx);
  const m = Math.atan2(b.y - k.cy, b.x - k.cx);
  if (norm(m - s) > norm(e - s)) [s, e] = [e, s];
  return { cx: k.cx, cy: k.cy, r: k.r, start: norm(s), end: norm(e) };
}

/**
 * Bulge for a polyline arc segment that starts at p, leaves in direction
 * (tx, ty) (unit), and ends at q.
 */
export function tangentBulge(p, tx, ty, q) {
  const cx = q.x - p.x,
    cy = q.y - p.y;
  const cl = Math.hypot(cx, cy);
  if (cl < 1e-12) return 0;
  // Angle between the tangent and the chord; the sweep is twice that.
  const cross = tx * cy - ty * cx;
  const dot = tx * cx + ty * cy;
  const half = Math.atan2(cross, dot);
  return Math.tan(half / 2);
}

/** Unit tangent at the end of the last segment of a polyline vertex list [{x, y, b}]. */
export function endTangent(verts) {
  const n = verts.length;
  if (n < 2) return null;
  const a = verts[n - 2],
    b = verts[n - 1];
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-12) return null;
  let ux = dx / l,
    uy = dy / l;
  if (a.b) {
    // Rotate the chord direction by half the sweep to get the end tangent.
    const sweep = 4 * Math.atan(a.b);
    const r = sweep / 2;
    const c = Math.cos(r),
      s = Math.sin(r);
    [ux, uy] = [ux * c - uy * s, ux * s + uy * c];
  }
  return { x: ux, y: uy };
}

/** Points of a regular polygon. */
export function polygonPoints(c, n, r, a0, circumscribed) {
  const R = circumscribed ? r / Math.cos(Math.PI / n) : r;
  const start = circumscribed ? a0 + Math.PI / n : a0;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = start + (i * TAU) / n;
    pts.push(c.x + R * Math.cos(a), c.y + R * Math.sin(a), 0);
  }
  return pts;
}

/**
 * Offset curves used for tangent-tangent-radius circles: a line becomes two
 * parallel lines at distance r, a circle becomes two concentric circles.
 */
function offsetsFor(ent, r) {
  if (ent.type === 'line') {
    const dx = ent.x2 - ent.x1,
      dy = ent.y2 - ent.y1;
    const l = Math.hypot(dx, dy);
    const nx = -dy / l,
      ny = dx / l;
    return [
      { t: 'line', x: ent.x1 + nx * r, y: ent.y1 + ny * r, dx: dx / l, dy: dy / l },
      { t: 'line', x: ent.x1 - nx * r, y: ent.y1 - ny * r, dx: dx / l, dy: dy / l },
    ];
  }
  if (ent.type === 'circle' || ent.type === 'arc') {
    const out = [{ t: 'circle', cx: ent.cx, cy: ent.cy, r: ent.r + r }];
    if (ent.r - r > 1e-12) out.push({ t: 'circle', cx: ent.cx, cy: ent.cy, r: ent.r - r });
    if (r - ent.r > 1e-12) out.push({ t: 'circle', cx: ent.cx, cy: ent.cy, r: r - ent.r });
    return out;
  }
  return [];
}

function intersectAnalytic(a, b) {
  if (a.t === 'line' && b.t === 'line') {
    const den = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(den) < 1e-12) return [];
    const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / den;
    return [{ x: a.x + a.dx * t, y: a.y + a.dy * t }];
  }
  if (a.t === 'circle' && b.t === 'line') return intersectAnalytic(b, a);
  if (a.t === 'line' && b.t === 'circle') {
    const fx = a.x - b.cx,
      fy = a.y - b.cy;
    const B = fx * a.dx + fy * a.dy;
    const C = fx * fx + fy * fy - b.r * b.r;
    const disc = B * B - C;
    if (disc < -1e-12) return [];
    const s = Math.sqrt(Math.max(0, disc));
    return [-B - s, -B + s].map((t) => ({ x: a.x + a.dx * t, y: a.y + a.dy * t }));
  }
  const dx = b.cx - a.cx,
    dy = b.cy - a.cy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-12 || d > a.r + b.r + 1e-9 || d < Math.abs(a.r - b.r) - 1e-9) return [];
  const l = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
  const hh = Math.sqrt(Math.max(0, a.r * a.r - l * l));
  const mx = a.cx + (dx * l) / d,
    my = a.cy + (dy * l) / d;
  return [
    { x: mx + (dy * hh) / d, y: my - (dx * hh) / d },
    { x: mx - (dy * hh) / d, y: my + (dx * hh) / d },
  ];
}

/**
 * Circle of radius r tangent to two lines/circles/arcs, nearest to the pick
 * points p1 and p2. Returns {cx, cy, r} or null.
 */
export function circleTTR(e1, p1, e2, p2, r) {
  let best = null,
    bestD = Infinity;
  for (const a of offsetsFor(e1, r)) {
    for (const b of offsetsFor(e2, r)) {
      for (const c of intersectAnalytic(a, b)) {
        // Prefer the candidate whose tangent points are near the picks.
        let d = 0;
        try {
          const t1 = closestPoint(e1, c.x, c.y),
            t2 = closestPoint(e2, c.x, c.y);
          d = Math.hypot(t1.x - p1.x, t1.y - p1.y) + Math.hypot(t2.x - p2.x, t2.y - p2.y);
        } catch {
          d = Math.hypot(c.x - p1.x, c.y - p1.y) + Math.hypot(c.x - p2.x, c.y - p2.y);
        }
        if (d < bestD) {
          bestD = d;
          best = { cx: c.x, cy: c.y, r };
        }
      }
    }
  }
  return best;
}

/** Copy of an entity with no id (for adding as a new object). */
export function fresh(ent) {
  const { id, ...rest } = ent;
  void id;
  return rest;
}

/** Closed boundary loops (hatch format) from a closed entity, or null. */
export function loopFromEntity(ent) {
  if (ent.type === 'circle') {
    return [ent.cx + ent.r, ent.cy, 1, ent.cx - ent.r, ent.cy, 1];
  }
  if (ent.type === 'polyline' && (ent.closed || closesItself(ent.pts))) {
    const p = ent.pts.slice();
    if (!ent.closed) p.splice(p.length - 3, 3);
    return p;
  }
  if (ent.type === 'ellipse' || ent.type === 'spline') {
    const prims = toPrims(ent);
    const out = [];
    for (const pr of prims) {
      if (pr.t === 'pl') for (let i = 0; i < pr.pts.length; i += 2) out.push(pr.pts[i], pr.pts[i + 1], 0);
    }
    return out.length >= 9 ? out : null;
  }
  return null;
}

function closesItself(p) {
  const n = p.length / 3;
  return n > 2 && Math.hypot(p[0] - p[(n - 1) * 3], p[1] - p[(n - 1) * 3 + 1]) < 1e-9;
}
