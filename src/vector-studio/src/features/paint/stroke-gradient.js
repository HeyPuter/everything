/**
 * Gradients applied along or across a stroke.
 *
 * A linear or radial gradient on a stroke normally fills the stroke area
 * like any shape ("within"). With `paint.strokeApply`:
 *
 *   'along'   the colors follow the path: the first stop at the start of
 *             each subpath, the last at its end
 *   'across'  the colors run across the stroke's width: the first stop on
 *             the left edge (seen along the path), the last on the right
 *
 * Such strokes are live artwork (model/live.js): the path draws its fill,
 * then the stroke as bands of solid color, each a strip polygon along the
 * flattened path (miter-joined offsets). Rendering, hit testing, export and
 * Expand Appearance follow from that. Caps: butt, square (the strip
 * reaches past the ends) and round (a half disc in the end color along the
 * path; bands ending in a curve across it), at the ends of open paths and
 * of every dash. Dashes, and inside or outside alignment on closed paths,
 * follow the stroke's settings. Arrowheads take the color at their end of
 * the path.
 */
import { registerLive, virtualId, liveExpansion } from '../../model/live.js';
import { effectiveSubpaths, isGeomEffectType, geomEffectsOf } from '../../model/geom-effects.js';
import { flattenPath, pathLength } from '../../model/bezier.js';
import { hasAppearanceStack } from '../../model/appearance.js';
import { isGradient, sampleStops, sortedStops } from '../../model/gradients.js';
import { DEFAULT_STYLE } from '../../model/nodes.js';
import { nodeArrowheads, arrowTrim, trimAnchors } from './stroke-geometry.js';
import { dashRanges } from '../brushes/generate.js';
import { drawHooks } from '../../render/draw.js';

export const STROKE_APPLY = ['within', 'along', 'across'];

/** How a stroke paint applies its gradient: 'within' | 'along' | 'across'. */
export function strokeApplyOf(paint) {
  return isGradient(paint) && (paint.strokeApply === 'along' || paint.strokeApply === 'across') ? paint.strokeApply : 'within';
}

/** Set how a gradient applies to a stroke. */
export function setStrokeApply(paint, mode) {
  if (!isGradient(paint)) return paint;
  const out = { ...paint };
  if (mode === 'along' || mode === 'across') out.strokeApply = mode;
  else delete out.strokeApply;
  return out;
}

const isShape = (n) => n.type === 'path' || n.type === 'compound';

/** Whether a node strokes with a gradient along or across its path. */
export function hasStrokeGradient(node) {
  return Boolean(node && isShape(node) && node.strokeWidth > 0 && strokeApplyOf(node.stroke) !== 'within' && !node.brush?.id && !hasAppearanceStack(node));
}

// ---- geometry ----

/** Flattened subpaths: [{ pts, closed }] with repeated points removed. */
function polylines(subpaths, tol) {
  const out = [];
  for (const sp of subpaths) {
    if (!sp.anchors?.length) continue;
    const raw = flattenPath(sp.anchors, sp.closed, tol);
    const pts = [];
    for (const p of raw) {
      const q = pts[pts.length - 1];
      if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) pts.push({ x: p.x, y: p.y });
    }
    if (sp.closed && pts.length > 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) pts.pop();
    }
    if (pts.length >= 2) out.push({ pts, closed: Boolean(sp.closed) && pts.length > 2 });
  }
  return out;
}

/**
 * A polyline ready for strips: points, their distances along it, and the
 * miter-scaled unit normals at each point (left of the direction of travel
 * in a y-down document is +normal).
 */
function prepare(line, miterLimit) {
  const { pts, closed } = line;
  const n = pts.length;
  const segN = [];
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    segN.push({ x: -(b.y - a.y) / l, y: (b.x - a.x) / l });
  }
  const limit = Math.max(1, Math.min(miterLimit || 4, 8));
  const normals = pts.map((_, i) => {
    const prev = closed ? segN[(i - 1 + segCount) % segCount] : segN[i - 1];
    const next = closed ? segN[i % segCount] : segN[i];
    if (!prev) return next;
    if (!next) return prev;
    let mx = prev.x + next.x;
    let my = prev.y + next.y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) return next;
    mx /= ml;
    my /= ml;
    const k = Math.min(limit, 1 / Math.max(1e-3, mx * next.x + my * next.y));
    return { x: mx * k, y: my * k };
  });
  const dist = [0];
  for (let i = 1; i < n; i++) dist.push(dist[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  let length = dist[n - 1];
  if (closed) length += Math.hypot(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y);
  return { pts, normals, segN, dist, length, closed };
}

/**
 * Point and normal at distance s along a prepared polyline (closed lines
 * wrap): the miter normal at a vertex, the segment's own normal between
 * vertices (so dash and band ends are square to the path).
 */
function at(L, s) {
  const { pts, normals, dist, length, closed } = L;
  const n = pts.length;
  if (closed) {
    s = ((s % length) + length) % length;
    if (s >= dist[n - 1]) {
      const t = (s - dist[n - 1]) / Math.max(1e-9, length - dist[n - 1]);
      return lerpPN(L, n - 1, 0, t);
    }
  }
  if (s <= 0) return { x: pts[0].x, y: pts[0].y, nx: normals[0].x, ny: normals[0].y };
  if (s >= dist[n - 1]) return { x: pts[n - 1].x, y: pts[n - 1].y, nx: normals[n - 1].x, ny: normals[n - 1].y };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= s) lo = mid;
    else hi = mid;
  }
  const t = (s - dist[lo]) / Math.max(1e-9, dist[hi] - dist[lo]);
  return lerpPN(L, lo, hi, t);
}

/** Point t of the way along the segment from vertex i to vertex j. */
function lerpPN(L, i, j, t) {
  const a = L.pts[i];
  const b = L.pts[j];
  const nr = t <= 1e-9 ? L.normals[i] : t >= 1 - 1e-9 ? L.normals[j] : L.segN[i];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: nr.x, ny: nr.y };
}

/** The polyline's vertices strictly between distances s0 and s1, with the ends interpolated. */
function samples(L, s0, s1) {
  const { pts, normals, dist, closed, length } = L;
  const inner = [];
  if (closed) {
    // Vertex distances repeat every lap around a closed line.
    for (let lap = Math.floor(s0 / length); lap <= Math.floor(s1 / length); lap++) {
      for (let i = 0; i < pts.length; i++) {
        const d = dist[i] + lap * length;
        if (d > s0 && d < s1) inner.push({ x: pts[i].x, y: pts[i].y, nx: normals[i].x, ny: normals[i].y, d });
      }
    }
    inner.sort((a, b) => a.d - b.d);
  } else {
    for (let i = 0; i < pts.length; i++) if (dist[i] > s0 && dist[i] < s1) inner.push({ x: pts[i].x, y: pts[i].y, nx: normals[i].x, ny: normals[i].y });
  }
  return [at(L, s0), ...inner, at(L, s1)];
}

/** Strip polygon between distances s0..s1 and normal offsets o0..o1 (end extensions e0/e1 along the tangent). */
function strip(L, s0, s1, o0, o1, { ext0 = [0, 0], ext1 = [0, 0] } = {}) {
  const pts = samples(L, s0, s1);
  const left = pts.map((p) => ({ x: p.x + p.nx * o0, y: p.y + p.ny * o0 }));
  const right = pts.map((p) => ({ x: p.x + p.nx * o1, y: p.y + p.ny * o1 }));
  // End extensions (square and round caps): along the tangent, outward.
  const tangent = (p) => ({ x: p.ny, y: -p.nx });
  if (ext0[0] || ext0[1]) {
    const p = pts[0];
    const t = tangent(p);
    const len = Math.hypot(t.x, t.y) || 1;
    left.unshift({ x: left[0].x - (t.x / len) * ext0[0], y: left[0].y - (t.y / len) * ext0[0] });
    right.unshift({ x: right[0].x - (t.x / len) * ext0[1], y: right[0].y - (t.y / len) * ext0[1] });
  }
  if (ext1[0] || ext1[1]) {
    const p = pts[pts.length - 1];
    const t = tangent(p);
    const len = Math.hypot(t.x, t.y) || 1;
    left.push({ x: left[left.length - 1].x + (t.x / len) * ext1[0], y: left[left.length - 1].y + (t.y / len) * ext1[0] });
    right.push({ x: right[right.length - 1].x + (t.x / len) * ext1[1], y: right[right.length - 1].y + (t.y / len) * ext1[1] });
  }
  return [...left, ...right.reverse()];
}

/**
 * A round cap closing an end (dir -1 at the start, +1 at the end): the part
 * of the disc of radius r around the path point between normal offsets lo
 * and hi (a half disc for a centered stroke, a quarter for an aligned one).
 */
function roundCap(L, s, lo, hi, r, dir) {
  const p = at(L, s);
  const nl = Math.hypot(p.nx, p.ny) || 1;
  const nx = p.nx / nl;
  const ny = p.ny / nl;
  const tx = ny * dir;
  const ty = -nx * dir;
  const a0 = Math.acos(Math.max(-1, Math.min(1, hi / r)));
  const a1 = Math.acos(Math.max(-1, Math.min(1, lo / r)));
  const out = [];
  if (hi < r) out.push({ x: p.x + nx * hi, y: p.y + ny * hi });
  for (let k = 0; k <= 12; k++) {
    const a = a0 + ((a1 - a0) * k) / 12;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    out.push({ x: p.x + nx * r * c + tx * r * sn, y: p.y + ny * r * c + ty * r * sn });
  }
  if (lo > -r) out.push({ x: p.x + nx * lo, y: p.y + ny * lo });
  return out;
}

/** Whether a point is inside the rings (closed polylines) under a fill rule. */
function insideRings(lines, x, y, fillRule) {
  let w = 0;
  for (const { pts } of lines) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const side = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
      if (a.y <= y) {
        if (b.y > y && side > 0) w++;
      } else if (b.y <= y && side < 0) w--;
    }
  }
  return fillRule === 'evenodd' ? w % 2 !== 0 : w !== 0;
}

/** +1 when the filled side of a closed line is along its +normals, else -1. */
function filledSide(L, lines, fillRule) {
  const { pts } = L;
  let best = 0;
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > len) {
      len = l;
      best = i;
    }
  }
  const a = pts[best];
  const b = pts[(best + 1) % pts.length];
  const e = len * 1e-4;
  const x = (a.x + b.x) / 2 - ((b.y - a.y) / len) * e;
  const y = (a.y + b.y) / 2 + ((b.x - a.x) / len) * e;
  return insideRings(lines, x, y, fillRule) ? 1 : -1;
}

const corner = (p) => ({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y });

/**
 * The colored shapes of a stroke gradient: [{ points, color, opacity }]
 * for subpaths in document space. `paint` is the gradient; `style` has
 * strokeWidth, strokeCap, miterLimit.
 */
export function strokeGradientShapes(subpaths, paint, style) {
  const mode = strokeApplyOf(paint);
  const h = (style.strokeWidth || 0) / 2;
  if (!(h > 0) || mode === 'within') return [];
  const stops = sortedStops(paint.stops || []);
  if (!stops.length) return [];
  const opaque = stops.every((s) => (s.opacity ?? 1) >= 1);
  const cap = style.strokeCap || 'butt';
  const align = style.strokeAlign || 'center';
  const dash = style.dash?.length ? style.dash : null;
  const out = [];
  const color = (t) => sampleStops(stops, Math.max(0, Math.min(1, t)));
  const push = (points, t) => {
    const c = color(t);
    out.push({ points, color: c.color, opacity: c.opacity });
  };
  const lines = polylines(subpaths, Math.max(0.05, Math.min(0.5, h / 8)));
  for (const line of lines) {
    const L = prepare(line, style.miterLimit);
    if (!(L.length > 1e-6)) continue;
    // Normal offsets the stroke covers: centered, or its whole width on one side of a closed line.
    let lo = -h;
    let hi = h;
    let r = h;
    if (L.closed && align !== 'center') {
      const inward = filledSide(L, lines, style.fillRule) * (align === 'inside' ? 1 : -1);
      [lo, hi] = inward > 0 ? [0, 2 * h] : [-2 * h, 0];
      r = 2 * h;
    }
    // Dashes, each with its own caps; without them open lines have caps at their ends.
    const ranges = dash ? dashRanges(L.length, dash, style.dashOffset || 0) : [[0, L.length]];
    const capped = Boolean(dash) || !L.closed;
    const square = capped && cap === 'square' ? r : 0;
    const round = capped && cap === 'round';
    if (mode === 'along') {
      // Bands of about 1.5 units (or fewer for long paths), each slightly overlapping the next to hide seams.
      const count = Math.max(2, Math.min(256, Math.ceil(L.length / 1.5)));
      const step = L.length / count;
      const lap = opaque ? Math.min(step * 0.5, 0.25) : 0;
      for (const [a, b] of ranges) {
        const k0 = Math.min(count - 1, Math.floor(a / step));
        const k1 = Math.max(k0, Math.min(count - 1, Math.ceil(b / step) - 1));
        for (let k = k0; k <= k1; k++) {
          const s0 = Math.max(a, k * step);
          const s1 = Math.min(b, (k + 1) * step + (k < k1 ? lap : 0));
          if (!(s1 > s0)) continue;
          const e0 = k === k0 ? [square, square] : [0, 0];
          const e1 = k === k1 ? [square, square] : [0, 0];
          push(strip(L, s0, s1, lo, hi, { ext0: e0, ext1: e1 }), (k + 0.5) / count);
        }
        if (round) {
          push(roundCap(L, a, lo, hi, r, -1), a / L.length);
          push(roundCap(L, b, lo, hi, r, 1), b / L.length);
        }
      }
    } else {
      // Across: bands from the left edge (offset lo) to the right edge (hi), fewer for many dashes.
      const most = Math.min(64, Math.ceil(8192 / ranges.length));
      const count = Math.max(2, Math.min(most, Math.ceil((hi - lo) / 0.5)));
      const band = (hi - lo) / count;
      const lap = opaque ? Math.min(band * 0.5, 0.1) : 0;
      for (let k = 0; k < count; k++) {
        const o0 = lo + k * band;
        const o1 = Math.min(hi, o0 + band + (k < count - 1 ? lap : 0));
        // Round caps: each band ends where the cap's circle crosses it.
        const reach = (o) => (round ? Math.sqrt(Math.max(0, r * r - o * o)) : square);
        const ext = [reach(o0), reach(o1)];
        const ends = capped ? { ext0: ext, ext1: ext } : {};
        for (const [a, b] of ranges) push(strip(L, a, b, o0, o1, ends), (k + 0.5) / count);
      }
    }
  }
  return out;
}

// ---- live artwork ----

const BASE = { ...DEFAULT_STYLE, name: '', hidden: false, locked: false, dash: [], effects: [], arrowStart: null, arrowEnd: null };

function generate(doc, node) {
  const extra = new Map();
  const items = [];
  const geomFx = (node.effects || []).filter((e) => isGeomEffectType(e.type));
  if (node.fill) {
    const v = { ...node, id: virtualId(node.id), source: node.id, stroke: null, strokeWidth: 0, opacity: 1, blendMode: 'normal', effects: geomFx, arrowStart: null, arrowEnd: null };
    extra.set(v.id, v);
    items.push(v.id);
  }
  let subpaths = effectiveSubpaths(doc, node);
  let arrows = [];
  if (node.type === 'path' && !node.closed && (node.arrowStart || node.arrowEnd) && subpaths.length === 1 && !geomEffectsOf(node)) {
    const t = arrowTrim(node);
    if (t.start || t.end) subpaths = [{ anchors: trimAnchors(node.anchors, t.start, t.end), closed: false }];
    arrows = nodeArrowheads(node);
  }
  // Dashes aligned to corners have their own pattern (Stroke panel).
  const dp = node.dash?.length ? drawHooks.dashPattern?.(node) : null;
  const style = dp ? { ...node, dash: dp.dash, dashOffset: dp.offset } : node;
  const shapes = strokeGradientShapes(subpaths, node.stroke, style);
  for (const sh of shapes) {
    const v = { ...BASE, id: virtualId(node.id), type: 'path', source: node.id, anchors: sh.points.map(corner), closed: true, fill: { type: 'solid', color: sh.color, ...(sh.opacity < 1 ? { opacity: sh.opacity } : {}) }, stroke: null, strokeWidth: 0 };
    extra.set(v.id, v);
    items.push(v.id);
  }
  if (arrows.length) {
    const stops = sortedStops(node.stroke.stops || []);
    const along = strokeApplyOf(node.stroke) === 'along';
    const len = node.type === 'path' ? pathLength(node.anchors, false) : 0;
    for (const a of arrows) {
      // Arrowheads near the start of the path take the start color.
      const nearStart = along && len > 0 && Math.hypot(a.anchors[0].x - node.anchors[0].x, a.anchors[0].y - node.anchors[0].y) < Math.hypot(a.anchors[0].x - node.anchors[node.anchors.length - 1].x, a.anchors[0].y - node.anchors[node.anchors.length - 1].y);
      const c = sampleStops(stops, along ? (nearStart ? 0 : 1) : 0.5);
      const v = { ...BASE, id: virtualId(node.id), type: 'path', source: node.id, anchors: a.anchors, closed: a.closed, fill: { type: 'solid', color: c.color, ...(c.opacity < 1 ? { opacity: c.opacity } : {}) }, stroke: null, strokeWidth: 0 };
      extra.set(v.id, v);
      items.push(v.id);
    }
  }
  return { items, extra };
}

/** Expand: the fill and the stroke bands grouped (Object > Expand, Expand Appearance). */
function expand(doc, node) {
  const sub = liveExpansion(doc, node);
  const parent = doc.get(node.parent);
  const index = parent ? parent.children.indexOf(node.id) : Infinity;
  doc.remove(node.id);
  return doc.importSubtree(sub, node.parent, index);
}

let installed = false;
export function installStrokeGradients() {
  if (installed) return;
  installed = true;
  registerLive('strokeGradient', { bounds: 'source', test: hasStrokeGradient, generate, expand });
}
