/**
 * Geometry for scripts, in document coordinates (the coordinates of anchors
 * and artboards): bounds, filled area and a label point for paths, compound
 * paths and groups. The geometry engine resolves each object's fill rule
 * first (overlapping subpaths, holes), so a compound path's holes are
 * subtracted and a group counts the area its paths cover together.
 */
import { OP, runGeom } from '../geometry/engine/index.js';
import { geometryLeaves, shapeOf } from '../geometry/nodes-io.js';
import { flattenPath } from '../../model/bezier.js';
import { nodeBounds, visualBounds } from '../../model/geometry.js';

/** Flattening tolerance (points) for area and label points. */
const TOL = 0.05;
/** Geometry the engine resolves per call (the rest wait for the next call, so other work can run between). */
const CHUNK = 500;

/** Engine shapes making up a node's filled area (every path counts as filled). */
function areaShapes(doc, node) {
  let leaves = [];
  if (node.type === 'path' || node.type === 'compound') leaves = [node];
  else if (node.type === 'group' || node.type === 'layer') {
    leaves = geometryLeaves(doc, [node.id], { skipLocked: false, intoLive: false });
  }
  return leaves
    .map((n) => ({ ...shapeOf(doc, n), filled: true, string: false }))
    .filter((s) => s.subpaths.length);
}

const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The filled regions of `nodes`: for each, an array of rings (closed
 * polygons, [{ x, y }]) that do not overlap, so a point is inside when an
 * odd number of rings contain it; null for objects without area (text,
 * images, empty paths).
 */
export async function regions(doc, nodes) {
  const out = nodes.map(() => null);
  const single = [];
  const multi = [];
  nodes.forEach((n, i) => {
    const shapes = n ? areaShapes(doc, n) : [];
    if (shapes.length === 1) single.push({ i, shape: shapes[0] });
    else if (shapes.length > 1) multi.push({ i, shapes });
  });
  const rings = (rec) =>
    (rec?.subpaths || [])
      .map((sp) => flattenPath(sp.anchors, true, TOL))
      .filter((pts) => pts.length >= 3);
  for (let k = 0; k < single.length; k += CHUNK) {
    const part = single.slice(k, k + CHUNK);
    const records = await runGeom(
      OP.NORMALIZE,
      part.map((s) => s.shape),
      [],
      { tol: 0.01 },
    );
    for (const rec of records) {
      const s = part[rec.owner];
      if (s) out[s.i] = rings(rec);
    }
    for (const s of part) if (!out[s.i]) out[s.i] = [];
  }
  for (const m of multi) {
    const records = await runGeom(OP.UNITE, m.shapes, [], { tol: 0.01 });
    out[m.i] = records.flatMap(rings);
  }
  return out;
}

/** Signed area of a ring (shoelace). */
function ringArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return s / 2;
}

/** Whether a point is inside a ring (even-odd). */
function ringContainsPoint(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Area of non-overlapping rings: outlines add, holes (rings inside an odd
 * number of others) subtract, whatever their winding direction.
 */
export function ringsArea(rings) {
  if (!rings?.length) return 0;
  if (rings.length === 1) return Math.abs(ringArea(rings[0]));
  // Bounding boxes keep the containment tests to rings that can contain each other.
  const boxes = rings.map((r) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of r) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1 };
  });
  let total = 0;
  rings.forEach((r, i) => {
    const p = r[0];
    let depth = 0;
    rings.forEach((o, j) => {
      if (i === j) return;
      const b = boxes[j];
      if (p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1) return;
      if (ringContainsPoint(o, p.x, p.y)) depth++;
    });
    total += (depth % 2 ? -1 : 1) * Math.abs(ringArea(r));
  });
  return Math.max(0, total);
}

/** Signed distance from a point to the edges of the rings: positive inside, negative outside. */
function signedDistance(rings, x, y) {
  let inside = false;
  let best = Infinity;
  for (const pts of rings) {
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x)
        inside = !inside;
      let px = b.x;
      let py = b.y;
      let dx = a.x - px;
      let dy = a.y - py;
      if (dx !== 0 || dy !== 0) {
        const t = ((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy);
        if (t > 1) {
          px = a.x;
          py = a.y;
        } else if (t > 0) {
          px += dx * t;
          py += dy * t;
        }
      }
      dx = x - px;
      dy = y - py;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(best);
}

/** A max-heap of cells by their best possible distance. */
class CellQueue {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(c) {
    const a = this.items;
    a.push(c);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].max >= c.max) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = c;
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mv = last.max;
        if (l < a.length && a[l].max > mv) {
          m = l;
          mv = a[l].max;
        }
        if (r < a.length && a[r].max > mv) m = r;
        if (m === i) break;
        a[i] = a[m];
        i = m;
      }
      a[i] = last;
    }
    return top;
  }
}

/** Most cells a label point search looks at (a cap for very detailed outlines). */
const MAX_CELLS = 4000;

/**
 * The pole of inaccessibility of filled rings: the point inside farthest
 * from every edge, where a label reads best, and that distance (the radius
 * of the largest circle that fits there). A quadtree search over the
 * bounding box stops once no cell can beat the best point by `precision`.
 * Returns { x, y, radius }, or null for no area.
 */
export function poleOfInaccessibility(rings, precision) {
  if (!rings?.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rings) {
    for (const p of r) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const size = Math.min(w, h);
  if (!(size > 0)) return { x: x0 + w / 2, y: y0 + h / 2, radius: 0 };
  const eps = precision > 0 ? precision : Math.max(size / 100, 1e-4);
  const cell = (x, y, half) => {
    const d = signedDistance(rings, x, y);
    return { x, y, half, d, max: d + half * Math.SQRT2 };
  };
  // Start from the area-weighted centroid (often good already) and the box center.
  let cx = 0;
  let cy = 0;
  let total = 0;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i];
      const b = r[j];
      const f = a.x * b.y - b.x * a.y;
      cx += (a.x + b.x) * f;
      cy += (a.y + b.y) * f;
      total += f * 3;
    }
  }
  let best = total ? cell(cx / total, cy / total, 0) : cell(x0 + w / 2, y0 + h / 2, 0);
  const center = cell(x0 + w / 2, y0 + h / 2, 0);
  if (center.d > best.d) best = center;
  const queue = new CellQueue();
  const half = size / 2;
  for (let x = x0; x < x1; x += size) {
    for (let y = y0; y < y1; y += size) queue.push(cell(x + half, y + half, half));
  }
  let seen = 0;
  while (queue.size && seen < MAX_CELLS) {
    const c = queue.pop();
    seen++;
    if (c.d > best.d) best = c;
    if (c.max - best.d <= eps) continue;
    const q = c.half / 2;
    queue.push(cell(c.x - q, c.y - q, q));
    queue.push(cell(c.x + q, c.y - q, q));
    queue.push(cell(c.x - q, c.y + q, q));
    queue.push(cell(c.x + q, c.y + q, q));
  }
  return { x: best.x, y: best.y, radius: Math.max(0, best.d) };
}

/** Bounds { x, y, w, h } of a node in document coordinates (`visual` includes strokes and effects). */
export function boundsOf(doc, node, visual = false) {
  const b = visual ? visualBounds(doc, node) : nodeBounds(doc, node);
  return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
}

/** Filled areas of nodes (null for objects without area). */
export async function areasOf(doc, nodes) {
  const regs = await regions(doc, nodes);
  return regs.map((r) => (r ? ringsArea(r) : null));
}

/**
 * Label points of nodes: { x, y, radius } (null for objects without area).
 * The search yields to the app now and then, so thousands of shapes do
 * not hold up drawing and input.
 */
export async function labelPointsOf(doc, nodes, { precision } = {}) {
  const regs = await regions(doc, nodes);
  const out = [];
  let since = Date.now();
  for (const r of regs) {
    out.push(r && r.length ? poleOfInaccessibility(r, precision) : null);
    if (Date.now() - since > 12) {
      await yieldToUI();
      since = Date.now();
    }
  }
  return out;
}
