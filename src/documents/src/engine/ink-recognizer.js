/**
 * Ink to Shape: recognise a hand-drawn stroke (or a pair of strokes) as a line, an arrow, a
 * rectangle, an ellipse or a triangle. Original heuristics written for this editor:
 *
 * - open strokes are lines when they stay close to their chord, and arrows when a straight shaft is
 *   followed by a short barb that turns back toward it (or a separate V stroke caps a line);
 * - closed strokes are compared with their convex hull's smallest enclosing rectangle (how much of it
 *   they fill), the number of corners left after simplifying the loop, and how well an ellipse on the
 *   loop's principal axes fits it.
 *
 * Geometry is in page pixels. Results:
 *   { kind: 'line' | 'arrow', from: {x, y}, to: {x, y} }
 *   { kind: 'rect', cx, cy, width, height, angle }        angle in radians, snapped to 0 near the axes
 *   { kind: 'ellipse', cx, cy, width, height, angle }
 *   { kind: 'triangle', vertices: [{x, y} × 3] }
 */
import { pathLength, simplify } from './ink-geometry.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const SNAP = 10 * Math.PI / 180;

/** Points spaced evenly along the path, `count` of them. */
export function resample(points, count = 64) {
  if (points.length < 2) return points.map(p => ({ x: p.x, y: p.y }));
  const total = pathLength(points), step = total / (count - 1), out = [{ x: points[0].x, y: points[0].y }];
  if (!total) return out;
  let carried = 0;
  for (let i = 1; i < points.length && out.length < count; i++) {
    let a = { x: points[i - 1].x, y: points[i - 1].y }; const b = points[i];
    let segment = dist(a, b);
    while (carried + segment >= step && out.length < count) {
      const t = (step - carried) / segment, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(p); a = p; segment = dist(a, b); carried = 0;
    }
    carried += segment;
  }
  while (out.length < count) out.push({ x: points.at(-1).x, y: points.at(-1).y });
  return out;
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
/** Convex hull (monotone chain), counter-clockwise in a y-up frame. */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
export const polygonArea = poly => Math.abs(poly.reduce((n, p, i) => { const q = poly[(i + 1) % poly.length]; return n + p.x * q.y - q.x * p.y; }, 0)) / 2;

/** The smallest-area rectangle around a convex polygon, trying each edge direction. */
export function minimumRectangle(hull) {
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length], angle = Math.atan2(b.y - a.y, b.x - a.x);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) { const u = p.x * cos + p.y * sin, v = -p.x * sin + p.y * cos; minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const u = (minU + maxU) / 2, v = (minV + maxV) / 2;
      best = { area, angle, width: maxU - minU, height: maxV - minV, cx: u * cos - v * sin, cy: u * sin + v * cos };
    }
  }
  return best;
}

/** Fold an angle to the rectangle-equivalent range (-45°, 45°], swapping width and height as needed. */
function normalizeBox(box) {
  let { angle, width, height } = box;
  while (angle > Math.PI / 4) { angle -= Math.PI / 2; [width, height] = [height, width]; }
  while (angle <= -Math.PI / 4) { angle += Math.PI / 2; [width, height] = [height, width]; }
  if (Math.abs(angle) < SNAP) angle = 0;
  return { ...box, angle, width, height };
}

/** Corners of a closed loop: simplify it, then drop vertices where the outline barely turns. */
export function loopCorners(points, tolerance) {
  if (points.length < 4) return points.slice();
  let far = 0;
  for (let i = 1; i < points.length; i++) if (dist(points[i], points[0]) > dist(points[far], points[0])) far = i;
  const first = simplify(points.slice(0, far + 1).map(p => ({ x: p.x, y: p.y })), tolerance);
  const second = simplify([...points.slice(far), points[0]].map(p => ({ x: p.x, y: p.y })), tolerance);
  let corners = [...first, ...second.slice(1, -1)];
  // Remove near-straight vertices (including the arbitrary start point) until every corner turns.
  for (let changed = true; changed && corners.length > 3;) {
    changed = false;
    let flattest = -1, flattestTurn = Infinity;
    corners.forEach((p, i) => {
      const a = corners[(i - 1 + corners.length) % corners.length], b = corners[(i + 1) % corners.length];
      const turn = Math.abs(Math.atan2(cross(a, p, b), (p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y)));
      const short = Math.min(dist(a, p), dist(p, b)) < tolerance * 0.75;
      const score = short ? -1 : turn;
      if (score < flattestTurn) { flattestTurn = score; flattest = i; }
    });
    if (flattestTurn < 0.45) { corners.splice(flattest, 1); changed = true; }
  }
  return corners;
}

/** How far a loop is from the ellipse on its principal axes: mean |r(θ) − 1| for normalised radii. */
export function ellipseFit(points) {
  const n = points.length, cx0 = points.reduce((s, p) => s + p.x, 0) / n, cy0 = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of points) { const dx = p.x - cx0, dy = p.y - cy0; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy), cos = Math.cos(angle), sin = Math.sin(angle);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  const local = points.map(p => { const u = (p.x - cx0) * cos + (p.y - cy0) * sin, v = -(p.x - cx0) * sin + (p.y - cy0) * cos; minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); return { u, v }; });
  const rx = (maxU - minU) / 2 || 1, ry = (maxV - minV) / 2 || 1, cu = (maxU + minU) / 2, cv = (maxV + minV) / 2;
  const error = local.reduce((s, { u, v }) => s + Math.abs(Math.hypot((u - cu) / rx, (v - cv) / ry) - 1), 0) / n;
  return { error, cx: cx0 + cu * cos - cv * sin, cy: cy0 + cu * sin + cv * cos, width: rx * 2, height: ry * 2, angle };
}

/** The open stroke's best straight reading, or null: its chord and how far the path strays from it. */
function straightness(points) {
  const a = points[0], b = points.at(-1), chord = dist(a, b);
  if (!chord) return { chord, deviation: Infinity, ratio: Infinity };
  const deviation = Math.max(...points.map(p => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / chord));
  return { chord, deviation, ratio: pathLength(points) / chord };
}

/** A V: two short arms meeting at a sharp vertex. Returns { vertex, arms } or null. */
function vee(points) {
  const size = Math.max(...points.map(p => dist(p, points[0])));
  const corners = simplify(points.map(p => ({ x: p.x, y: p.y })), Math.max(2, size * 0.18));
  if (corners.length !== 3) return null;
  const [a, v, b] = corners, angle = Math.acos(Math.max(-1, Math.min(1, ((a.x - v.x) * (b.x - v.x) + (a.y - v.y) * (b.y - v.y)) / (dist(a, v) * dist(b, v) || 1))));
  if (angle < 20 * Math.PI / 180 || angle > 130 * Math.PI / 180) return null;
  return { vertex: v, arms: [a, b], size: Math.max(dist(a, v), dist(b, v)) };
}

/** Recognise one stroke's points. Returns a shape description or null when nothing fits well. */
export function recognizeStroke(rawPoints) {
  if (!rawPoints || rawPoints.length < 2) return null;
  const length = pathLength(rawPoints);
  if (length < 12) return null;
  const pts = resample(rawPoints, 72);
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const gap = dist(pts[0], pts.at(-1));
  const closed = gap < Math.max(0.22 * diag, 10) && length > 1.7 * diag;
  if (!closed) {
    const line = straightness(pts);
    if (line.deviation <= Math.max(0.065 * line.chord, 3) && line.ratio < 1.12) return { kind: 'line', from: { x: pts[0].x, y: pts[0].y }, to: { x: pts.at(-1).x, y: pts.at(-1).y } };
    // A shaft to the farthest point, then a short barb turning back from the tip.
    let tip = 0;
    for (let i = 1; i < pts.length; i++) if (dist(pts[i], pts[0]) > dist(pts[tip], pts[0])) tip = i;
    const shaft = pts.slice(0, tip + 1), head = pts.slice(tip), shaftLength = dist(pts[0], pts[tip]);
    if (shaft.length > 4 && head.length > 2) {
      const s = straightness(shaft), headReach = Math.max(...head.map(p => dist(p, pts[tip])));
      const back = { x: pts[0].x - pts[tip].x, y: pts[0].y - pts[tip].y };
      const far = head.reduce((best, p) => dist(p, pts[tip]) > dist(best, pts[tip]) ? p : best, head[0]);
      const barb = Math.acos(Math.max(-1, Math.min(1, ((far.x - pts[tip].x) * back.x + (far.y - pts[tip].y) * back.y) / ((dist(far, pts[tip]) * Math.hypot(back.x, back.y)) || 1))));
      if (s.deviation <= Math.max(0.07 * shaftLength, 3) && headReach > 0.06 * shaftLength && headReach < 0.5 * shaftLength && barb > 8 * Math.PI / 180 && barb < 80 * Math.PI / 180)
        return { kind: 'arrow', from: { x: pts[0].x, y: pts[0].y }, to: { x: pts[tip].x, y: pts[tip].y } };
    }
    return null;
  }
  const hull = convexHull(pts), hullArea = polygonArea(hull);
  if (hullArea < 30) return null;
  const box = minimumRectangle(hull), fill = hullArea / box.area;
  const corners = loopCorners(pts, Math.max(3, diag * 0.075));
  const ellipse = ellipseFit(pts);
  if (corners.length === 3 && fill > 0.35 && fill < 0.75) return { kind: 'triangle', vertices: corners.map(p => ({ x: p.x, y: p.y })) };
  if (corners.length === 4 && fill > 0.8) return { kind: 'rect', ...normalizeBox(box) };
  if (ellipse.error < 0.14 && fill > 0.68 && fill < 0.9 && corners.length !== 4) {
    let { width, height } = ellipse;
    const shape = normalizeBox({ cx: ellipse.cx, cy: ellipse.cy, width, height, angle: ellipse.angle });
    if (Math.abs(shape.width - shape.height) / Math.max(shape.width, shape.height) < 0.12) { width = height = (shape.width + shape.height) / 2; return { kind: 'ellipse', ...shape, width, height, angle: 0 }; }
    return { kind: 'ellipse', ...shape };
  }
  if (fill > 0.88) return { kind: 'rect', ...normalizeBox(box) };
  if (corners.length === 3) return { kind: 'triangle', vertices: corners.map(p => ({ x: p.x, y: p.y })) };
  return null;
}

/** Recognise strokes together: a single stroke, or a line capped by a separate V (an arrow). */
export function recognizeStrokes(strokes) {
  if (strokes.length === 1) return recognizeStroke(strokes[0].points);
  if (strokes.length === 2) {
    for (const [lineStroke, headStroke] of [strokes, [...strokes].reverse()]) {
      const line = recognizeStroke(lineStroke.points);
      if (line?.kind !== 'line') continue;
      const v = vee(resample(headStroke.points, 32));
      if (!v) continue;
      const span = dist(line.from, line.to);
      if (v.size > span * 0.6) continue;
      for (const [from, to] of [[line.from, line.to], [line.to, line.from]]) if (dist(v.vertex, to) < Math.max(14, span * 0.15)) return { kind: 'arrow', from, to };
    }
  }
  return null;
}
