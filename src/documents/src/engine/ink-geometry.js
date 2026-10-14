/**
 * Ink stroke geometry, in page pixels (CSS pixels at 100% zoom). Original code written for this
 * editor: an adaptive low-pass filter for pointer samples, a uniform cubic spline through the
 * filtered samples, and a ribbon outline whose half-width follows pen pressure. The outline is a
 * closed polygon, so a stroke saves as an ordinary filled DrawingML path that any reader can show.
 *
 * A stroke is { tool: 'pen' | 'pencil' | 'highlighter', color: 'RRGGBB', width (px), points: [{ x, y, p }] }
 * where p is pressure in [0, 1] (0.5 when the device reports none).
 */

export const PX_PER_MM = 96 / 25.4;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Whether a tool's width follows pressure. Highlighters keep an even band. */
export const usesPressure = tool => tool !== 'highlighter';

/** The ribbon's full width at pressure p: the pen's nominal width at the default pressure of 0.5. */
export function widthAt(width, p, tool = 'pen') {
  if (!usesPressure(tool)) return width;
  return width * clamp(0.45 + 1.1 * clamp(Number.isFinite(p) ? p : 0.5, 0, 1), 0.45, 1.55);
}

/**
 * Smooth raw pointer samples. Each sample moves toward the incoming one by a factor that grows with the
 * distance moved, so slow, shaky movement is steadied while fast strokes keep up without lag. The
 * stroke still ends exactly where the pointer lifted, and samples closer than `minGap` merge.
 */
export function filterPoints(raw, { minGap = 0.6, steady = 0.42 } = {}) {
  const out = [];
  for (const point of raw) {
    const p = Number.isFinite(point.p) ? clamp(point.p, 0, 1) : 0.5;
    const last = out.at(-1);
    if (!last) { out.push({ x: point.x, y: point.y, p }); continue; }
    const moved = Math.hypot(point.x - last.x, point.y - last.y);
    if (moved < minGap * 0.5) { last.p = Math.max(last.p, p); continue; }
    const follow = clamp(steady + moved / 24, steady, 0.92);
    const next = { x: last.x + (point.x - last.x) * follow, y: last.y + (point.y - last.y) * follow, p: last.p + (p - last.p) * 0.5 };
    if (dist(next, last) >= minGap) out.push(next);
  }
  const end = raw.at(-1);
  if (end && out.length > 1) {
    const tail = out.at(-1);
    if (dist(tail, end) >= minGap * 0.5) out.push({ x: end.x, y: end.y, p: tail.p });
    else { tail.x = end.x; tail.y = end.y; }
  }
  return out;
}

/** Samples along a uniform cubic (Catmull-Rom style) spline through the points, about `step` px apart. */
export function splineSamples(points, step = 1.5) {
  if (points.length < 3) {
    if (points.length < 2) return points.map(p => ({ ...p }));
    const [a, b] = points, n = Math.max(1, Math.ceil(dist(a, b) / step)), out = [];
    for (let i = 0; i <= n; i++) { const t = i / n; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p + (b.p - a.p) * t }); }
    return out;
  }
  const out = [{ ...points[0] }];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(dist(p1, p2) / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      // Hermite form with tangents (p2 - p0) / 2 and (p3 - p1) / 2.
      const h1 = 2 * t3 - 3 * t2 + 1, h2 = -2 * t3 + 3 * t2, h3 = t3 - 2 * t2 + t, h4 = t3 - t2;
      const along = axis => h1 * p1[axis] + h2 * p2[axis] + h3 * (p2[axis] - p0[axis]) / 2 + h4 * (p3[axis] - p1[axis]) / 2;
      out.push({ x: along('x'), y: along('y'), p: p1.p + (p2.p - p1.p) * t });
    }
  }
  return out;
}

/** Douglas-Peucker style reduction of an open polyline, keeping its end points. */
export function simplify(points, tolerance) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop(), a = points[first], b = points[last];
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    let worst = -1, at = -1;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      const d = length ? Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / length : dist(p, a);
      // Pressure changes count as distance too, so a tapering stroke keeps its taper.
      const weighted = d + (p.p !== undefined && a.p !== undefined ? Math.abs(p.p - (a.p + (b.p - a.p) * ((i - first) / (last - first)))) * 4 : 0);
      if (weighted > worst) { worst = weighted; at = i; }
    }
    if (worst > tolerance && at > 0) { keep[at] = 1; stack.push([first, at], [at, last]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Polygon points of a round end cap: the arc about `center` from `startAngle` through `sweep` radians, end points excluded. */
function cap(center, radius, startAngle, sweep, segments = 8) {
  const out = [];
  for (let i = 1; i < segments; i++) { const a = startAngle + sweep * i / segments; out.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius }); }
  return out;
}

/** A circle polygon for a dot. */
function dot(center, radius, segments = 16) {
  return Array.from({ length: segments }, (_, i) => ({ x: center.x + Math.cos(2 * Math.PI * i / segments) * radius, y: center.y + Math.sin(2 * Math.PI * i / segments) * radius }));
}

/**
 * The closed outline of a stroke, as a list of polygon points. The centre line is the spline through
 * the stroke's points; each side is offset by half the pressure width; the ends are round.
 */
export function strokeOutline(stroke, { tolerance = 0.18 } = {}) {
  const centre = splineSamples(stroke.points, 1.25);
  const half = p => widthAt(stroke.width, p, stroke.tool) / 2;
  if (!centre.length) return [];
  const span = centre.reduce((n, p, i) => n + (i ? dist(p, centre[i - 1]) : 0), 0);
  if (centre.length < 2 || span < 0.5) return dot(centre[0], Math.max(0.4, half(centre[0].p)));
  const left = [], right = [];
  for (let i = 0; i < centre.length; i++) {
    const a = centre[Math.max(0, i - 1)], b = centre[Math.min(centre.length - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y; const length = Math.hypot(tx, ty) || 1; tx /= length; ty /= length;
    const r = half(centre[i].p), c = centre[i];
    left.push({ x: c.x - ty * r, y: c.y + tx * r, p: c.p });
    right.push({ x: c.x + ty * r, y: c.y - tx * r, p: c.p });
  }
  const l = simplify(left, tolerance), rr = simplify(right, tolerance);
  const first = centre[0], last = centre.at(-1);
  const angle = (from, c) => Math.atan2(from.y - c.y, from.x - c.x);
  // Each side sits a quarter turn from the direction of travel, so a half turn from the left side
  // (decreasing angle) passes the stroke's forward direction at the end and its backward one at the start.
  const outline = [...l.map(({ x, y }) => ({ x, y })),
    ...cap(last, half(last.p), angle(l.at(-1), last), -Math.PI),
    ...rr.slice().reverse().map(({ x, y }) => ({ x, y })),
    ...cap(first, half(first.p), angle(rr[0], first), -Math.PI)];
  return outline;
}

/** The smallest box around a stroke's ink, including its half-width. */
export function strokeBounds(stroke) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of stroke.points) {
    const r = widthAt(stroke.width, p.p, stroke.tool) / 2;
    left = Math.min(left, p.x - r); top = Math.min(top, p.y - r); right = Math.max(right, p.x + r); bottom = Math.max(bottom, p.y + r);
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
export function unionBounds(boxes) {
  const list = boxes.filter(Boolean);
  if (!list.length) return null;
  const left = Math.min(...list.map(b => b.left)), top = Math.min(...list.map(b => b.top)), right = Math.max(...list.map(b => b.right)), bottom = Math.max(...list.map(b => b.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Distance from a point to the segment a–b, and the segment parameter of the nearest point. */
export function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
  const t = length2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length2, 0, 1) : 0;
  return { distance: Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy), t };
}

/** Whether a circle of `radius` at p touches the stroke's ink. */
export function strokeHit(stroke, p, radius = 0) {
  const pts = stroke.points;
  if (pts.length === 1) return dist(pts[0], p) <= radius + widthAt(stroke.width, pts[0].p, stroke.tool) / 2;
  for (let i = 1; i < pts.length; i++) {
    const { distance, t } = segmentDistance(p, pts[i - 1], pts[i]);
    const r = widthAt(stroke.width, pts[i - 1].p + (pts[i].p - pts[i - 1].p) * t, stroke.tool) / 2;
    if (distance <= radius + r) return true;
  }
  return false;
}

/** Whether the segment from a to b passes within `radius` of the stroke (an eraser sweep). */
export function sweepHits(stroke, a, b, radius) {
  const length = dist(a, b), steps = Math.max(1, Math.ceil(length / Math.max(1, radius / 2)));
  for (let i = 0; i <= steps; i++) if (strokeHit(stroke, { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }, radius)) return true;
  return false;
}

/**
 * Erase the part of a stroke under a circular eraser of `radius` at p. Returns the pieces that remain
 * (none when the whole stroke is erased, the stroke itself when nothing was touched). Segments are
 * subdivided first so a long straight segment loses only the part under the eraser.
 */
export function eraseFromStroke(stroke, p, radius) {
  if (!strokeHit(stroke, p, radius)) return [stroke];
  const dense = [];
  stroke.points.forEach((q, i) => {
    if (i) {
      const a = stroke.points[i - 1], n = Math.ceil(dist(a, q) / Math.max(0.75, radius / 3));
      for (let k = 1; k < n; k++) dense.push({ x: a.x + (q.x - a.x) * k / n, y: a.y + (q.y - a.y) * k / n, p: a.p + (q.p - a.p) * k / n });
    }
    dense.push({ ...q });
  });
  const pieces = []; let run = [];
  for (const q of dense) {
    const r = widthAt(stroke.width, q.p, stroke.tool) / 2;
    if (dist(q, p) <= radius + r * 0.5) { if (run.length) pieces.push(run); run = []; }
    else run.push(q);
  }
  if (run.length) pieces.push(run);
  return pieces.filter(points => points.length > 1 || points.length === 1 && stroke.points.length === 1)
    .map(points => ({ ...stroke, points: simplify(points, 0.25) }));
}

/** Even-odd point in polygon. */
export function pointInPolygon(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether a lasso loop takes in a stroke: most of its points lie inside the loop. */
export function lassoContains(polygon, stroke, share = 0.6) {
  if (polygon.length < 3 || !stroke.points.length) return false;
  const inside = stroke.points.filter(p => pointInPolygon(p, polygon)).length;
  return inside / stroke.points.length >= share;
}

/** Move a stroke by (dx, dy). */
export const translateStroke = (stroke, dx, dy) => ({ ...stroke, points: stroke.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) });

/**
 * A ruler: a straight edge through (x, y) at `angle` radians, `length` long and `thickness` wide.
 * Returns the edge line a stroke starting within `reach` of either long edge should follow, or null.
 */
export function rulerEdge(ruler, p, reach = 24) {
  const cos = Math.cos(ruler.angle), sin = Math.sin(ruler.angle);
  const along = (p.x - ruler.x) * cos + (p.y - ruler.y) * sin, across = -(p.x - ruler.x) * sin + (p.y - ruler.y) * cos;
  if (Math.abs(along) > ruler.length / 2 + reach) return null;
  const half = ruler.thickness / 2;
  for (const side of [-1, 1]) {
    const offset = across - side * half;
    // Only the outside of an edge: a stroke starting on the ruler itself moves the ruler instead.
    if (offset * side >= -2 && Math.abs(offset) <= reach) return { x: ruler.x - sin * side * half, y: ruler.y + cos * side * half, angle: ruler.angle, side };
  }
  return null;
}

/** Project a stroke's points onto a ruler edge, keeping their order and pressure. */
export function snapToEdge(points, edge, inset = 0) {
  const cos = Math.cos(edge.angle), sin = Math.sin(edge.angle);
  // The pen's centre sits half its width outside the edge, as a pen against a straightedge does.
  const ox = -sin * edge.side * inset, oy = cos * edge.side * inset;
  return points.map(p => {
    const along = (p.x - edge.x) * cos + (p.y - edge.y) * sin;
    return { x: edge.x + along * cos + ox, y: edge.y + along * sin + oy, p: p.p };
  });
}

/** Collapse a snapped stroke to its extent along the edge: two end points (plus pressure). */
export function straightenAlongEdge(points, edge) {
  if (points.length < 2) return points;
  const cos = Math.cos(edge.angle), sin = Math.sin(edge.angle);
  const along = p => (p.x - edge.x) * cos + (p.y - edge.y) * sin;
  let min = points[0], max = points[0];
  for (const p of points) { if (along(p) < along(min)) min = p; if (along(p) > along(max)) max = p; }
  const first = along(points[0]) <= along(points.at(-1)) ? [min, max] : [max, min];
  const average = points.reduce((n, p) => n + p.p, 0) / points.length;
  return first.map(p => ({ x: p.x, y: p.y, p: average }));
}

/** The total length of a polyline. */
export const pathLength = points => points.reduce((n, p, i) => n + (i ? dist(p, points[i - 1]) : 0), 0);
