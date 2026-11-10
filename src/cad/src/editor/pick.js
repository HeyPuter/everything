/**
 * Hit testing against what is actually drawn: entities are emitted through
 * the display-list pipeline into small sinks that measure distance to a
 * point or test overlap with a rectangle. This keeps picking consistent
 * with the screen for text, dimensions, hatches and block references.
 */
import { emitEntity, makeContext } from '../core/tessellate.js';

function segPointDist2(ax, ay, bx, by, px, py) {
  const dx = bx - ax,
    dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t - px,
    y = ay + dy * t - py;
  return x * x + y * y;
}

function pointInRings(rings, px, py) {
  let inside = false;
  for (const r of rings) {
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[i * 2],
        yi = r[i * 2 + 1],
        xj = r[j * 2],
        yj = r[j * 2 + 1];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

class DistanceSink {
  constructor(px, py) {
    this.px = px;
    this.py = py;
    this.d2 = Infinity;
  }
  line(p, closed) {
    const n = p.length >> 1;
    if (n === 1) {
      this.d2 = Math.min(this.d2, (p[0] - this.px) ** 2 + (p[1] - this.py) ** 2);
      return;
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const d = segPointDist2(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], this.px, this.py);
      if (d < this.d2) this.d2 = d;
    }
  }
  segs(s) {
    for (let i = 0; i < s.length; i += 4) {
      const d = segPointDist2(s[i], s[i + 1], s[i + 2], s[i + 3], this.px, this.py);
      if (d < this.d2) this.d2 = d;
    }
  }
  fill(rings) {
    if (pointInRings(rings, this.px, this.py)) this.inFill = true;
  }
}

function segIntersectsRect(ax, ay, bx, by, r) {
  const [x0, y0, x1, y1] = r;
  if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) return false;
  if (ax >= x0 && ax <= x1 && ay >= y0 && ay <= y1) return true;
  if (bx >= x0 && bx <= x1 && by >= y0 && by <= y1) return true;
  // Liang-Barsky style clip.
  let t0 = 0,
    t1 = 1;
  const dx = bx - ax,
    dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1;
}

class RectSink {
  constructor(rect) {
    this.rect = rect;
    this.hit = false;
  }
  line(p, closed) {
    if (this.hit) return;
    const n = p.length >> 1;
    if (n === 1) {
      const [x0, y0, x1, y1] = this.rect;
      this.hit = p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
      return;
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs && !this.hit; i++) {
      const j = (i + 1) % n;
      if (segIntersectsRect(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], this.rect)) this.hit = true;
    }
  }
  segs(s) {
    for (let i = 0; i < s.length && !this.hit; i += 4) if (segIntersectsRect(s[i], s[i + 1], s[i + 2], s[i + 3], this.rect)) this.hit = true;
  }
  fill(rings) {
    if (this.hit) return;
    for (const r of rings) {
      this.line(r, true);
      if (this.hit) return;
    }
    const [x0, y0, x1, y1] = this.rect;
    if (pointInRings(rings, (x0 + x1) / 2, (y0 + y1) / 2)) this.hit = true;
  }
}

/** Distance from (px, py) to the entity's strokes, and whether the point is inside one of its fills. */
function measure(drawing, ent, px, py, tol) {
  const sink = new DistanceSink(px, py);
  emitEntity(ent, sink, makeContext(drawing, { tol, view: [px - 1e6, py - 1e6, px + 1e6, py + 1e6], pointSize: tol * 20 }));
  return { d: Math.sqrt(sink.d2), inFill: !!sink.inFill };
}

/** Distance from (px, py) to the entity as drawn, in world units (0 inside fills). */
export function entityDistance(drawing, ent, px, py, tol) {
  const m = measure(drawing, ent, px, py, tol);
  return m.inFill ? 0 : m.d;
}

/** True when any drawn part of the entity touches the rectangle. */
export function entityCrossesRect(drawing, ent, rect, tol) {
  const sink = new RectSink(rect);
  emitEntity(ent, sink, makeContext(drawing, { tol, view: rect, pointSize: tol * 20 }));
  return sink.hit;
}

/**
 * Pick the topmost entity within `radius` of (px, py).
 * `candidates` are ids from the spatial index; the object drawn later (on
 * top) wins ties. Returns { id, d } or null.
 */
export function pickEntity(drawing, candidates, px, py, radius, filter) {
  let best = null;
  let fillHit = null;
  const tol = radius / 4;
  // Place in the draw order, which DRAWORDER changes without changing ids.
  const above = (a, b) => (drawing.orderKey?.get(a) ?? a) > (drawing.orderKey?.get(b) ?? b);
  for (const id of candidates) {
    const ent = drawing.entities.get(id);
    if (!ent || (filter && !filter(ent))) continue;
    const m = measure(drawing, ent, px, py, tol);
    // Lines and edges near the cursor win over filled areas under it.
    if (m.d <= radius) {
      if (!best || m.d < best.d || (m.d === best.d && above(id, best.id))) best = { id, d: m.d };
    } else if (m.inFill && (!fillHit || above(id, fillHit.id))) fillHit = { id, d: 0 };
  }
  return best ?? fillHit;
}
