/**
 * Node geometry: bounds (geometric and visual) and transforms.
 *
 * Paths store absolute coordinates, so transforming a path bakes the matrix
 * into its anchors. Text and images keep a
 * matrix because their content is not made of anchors. Groups and compound
 * paths transform their children.
 */
import { pathBounds, transformAnchors } from './bezier.js';
import { apply, applyVector, multiply, decompose, isIdentity, invert, rotate } from '../lib/matrix.js';
import { layoutText } from './text-layout.js';
import { shapeAnchors, isPie } from './shapes.js';
import { liveDef, liveArtwork } from './live.js';
import { geomEffectsOf, effectiveSubpaths, subpathsBounds, geomEffectsOutset } from './geom-effects.js';

const liveBoundsCache = new WeakMap();

/** Bounds of a live object's generated artwork (geometric or visual), cached per result. */
function liveBounds(doc, node, visual) {
  const art = liveArtwork(doc, node);
  let hit = liveBoundsCache.get(art);
  if (!hit) liveBoundsCache.set(art, (hit = {}));
  const key = visual ? 'visual' : 'geometric';
  if (hit[key] !== undefined) return hit[key];
  let b = null;
  for (const n of art.items) if (!n.hidden) b = unionRect(b, visual ? visualBounds(art.vdoc, n) : nodeBounds(art.vdoc, n));
  hit[key] = b;
  return b;
}

/** A path or compound path drawn as live artwork (brush strokes, variable widths). */
function livePathDef(node) {
  return node.type === 'path' || node.type === 'compound' ? liveDef(node) : null;
}

let boundsCache = new WeakMap();
let visualCache = new WeakMap();

/** Forget cached bounds (fonts finished loading, so text measures differently). */
export function clearGeometryCache() {
  boundsCache = new WeakMap();
  visualCache = new WeakMap();
  frameCache = new WeakMap();
}

/**
 * Text that should change its frame instead of its matrix: area type under
 * a positive scale/translate keeps its type size and reflows, and type on a
 * path moves its path. Returns a patch or null.
 */
function textFramePatch(node, m) {
  const t = node.transform || [1, 0, 0, 1, 0, 0];
  const translationOnly = t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1;
  // A turned frame (pure rotation) reflows too when the scale runs along its own axes.
  const rotationOnly = Math.abs(t[0] * t[0] + t[1] * t[1] - 1) < 1e-9 && Math.abs(t[0] - t[3]) < 1e-9 && Math.abs(t[1] + t[2]) < 1e-9;
  if (!translationOnly && !(rotationOnly && node.kind === 'area')) return null;
  const conj = translationOnly ? multiply([1, 0, 0, 1, -t[4], -t[5]], multiply(m, t)) : multiply(invert(t), multiply(m, t));
  if (node.kind === 'path' && node.pathAnchors?.length) return { pathAnchors: transformAnchors(node.pathAnchors, conj) };
  if (node.kind !== 'area' || node.vertical) return null;
  if (Math.abs(conj[1]) > 1e-7 || Math.abs(conj[2]) > 1e-7 || conj[0] <= 0 || conj[3] <= 0) return null;
  if (node.areaPath?.length) {
    const areaPath = transformAnchors(node.areaPath, conj);
    const b = pathBounds(areaPath, true);
    return { areaPath, x: b.x, y: b.y, width: b.w, height: b.h };
  }
  const p0 = apply(conj, node.x, node.y);
  const p1 = apply(conj, node.x + node.width, node.y + node.height);
  return { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), width: Math.abs(p1.x - p0.x), height: Math.abs(p1.y - p0.y) };
}

export function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function rectsIntersect(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function rectContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function inflate(r, d) {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

/** Bounds of a local rect after a matrix. */
export function transformRect(r, m) {
  if (isIdentity(m)) return { ...r };
  const pts = [apply(m, r.x, r.y), apply(m, r.x + r.w, r.y), apply(m, r.x + r.w, r.y + r.h), apply(m, r.x, r.y + r.h)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** The four corners of a node's local box in document space (rotated objects keep their box). */
export function localCorners(r, m) {
  return [apply(m, r.x, r.y), apply(m, r.x + r.w, r.y), apply(m, r.x + r.w, r.y + r.h), apply(m, r.x, r.y + r.h)];
}

/** Geometric bounds (anchors and curves, no stroke) of a node in document space. */
export function nodeBounds(doc, node) {
  if (!node) return null;
  const cached = boundsCache.get(node);
  if (cached !== undefined && node.type !== 'group' && node.type !== 'layer' && node.type !== 'compound') return cached;
  let b = null;
  const lp = livePathDef(node);
  if (lp && lp.bounds !== 'source') return liveBounds(doc, node, false);
  switch (node.type) {
    case 'path':
      b = pathBounds(node.anchors, node.closed);
      boundsCache.set(node, b);
      return b;
    case 'text': {
      const lay = layoutText(node);
      b = transformRect(lay.bounds, node.transform);
      boundsCache.set(node, b);
      return b;
    }
    case 'image':
      b = transformRect({ x: 0, y: 0, w: node.width, h: node.height }, node.transform);
      boundsCache.set(node, b);
      return b;
    case 'group': {
      const live = liveDef(node);
      if (live && live.bounds !== 'source') return liveBounds(doc, node, false);
      if (node.clip && node.children.length) {
        return nodeBounds(doc, doc.get(node.children[node.children.length - 1]));
      }
    }
    // fall through
    case 'layer':
    case 'compound':
    case 'root':
      for (const c of node.children) {
        const cn = doc.get(c);
        if (!cn || (cn.hidden && node.type !== 'compound')) continue;
        b = unionRect(b, nodeBounds(doc, cn));
      }
      return b;
    default:
      // Leaf live objects (symbol instances, ...) measure their generated artwork.
      return liveDef(node) ? liveBounds(doc, node, false) : null;
  }
}

// ---- bounding box frame (accumulated rotation) ----
//
// Every object has a bounding box frame: the angle (degrees, clockwise on
// screen like rotate()) its bounding box is drawn at. Rotating an object
// turns its frame with it, so the box stays aligned to the object; Object >
// Transform > Reset Bounding Box sets it back to 0. Paths bake transforms
// into their anchors, so the angle is kept on the node as `frameAngle`.
// Nodes without one (older files, imports) use the rotation of their
// matrix (text, images) or live-shape angle, else 0.

/** Angle in (-180, 180], with float noise near whole degrees removed. */
export function normAngle(deg) {
  let v = ((deg % 360) + 360) % 360;
  if (v > 180) v -= 360;
  const r = Math.round(v);
  if (Math.abs(v - r) < 1e-7) v = r;
  return v === -180 ? 180 : v === 0 ? 0 : v;
}

/** The angle a frame at `deg` has after matrix m (a reflection mirrors it). */
export function transformFrameAngle(deg, m) {
  const r = (deg * Math.PI) / 180;
  const u = applyVector(m, Math.cos(r), Math.sin(r));
  if (Math.hypot(u.x, u.y) < 1e-12) return normAngle(deg);
  let a = normAngle((Math.atan2(u.y, u.x) * 180) / Math.PI);
  if (m[0] * m[3] - m[1] * m[2] < 0) {
    // A mirrored box is the same box turned by 180 degrees: report the smaller angle.
    const alt = normAngle(a + 180);
    if (Math.abs(alt) < Math.abs(a)) a = alt;
  }
  return a;
}

/** A node's bounding box frame angle. */
export function nodeFrameAngle(node) {
  if (!node) return 0;
  if (typeof node.frameAngle === 'number') return normAngle(node.frameAngle);
  if ((node.type === 'text' || node.type === 'image') && node.transform) return transformFrameAngle(0, node.transform);
  if (node.type === 'path' && node.shape?.angle) return normAngle(node.shape.angle);
  return 0;
}

const isMove = (m) => Math.abs(m[0] - 1) < 1e-12 && Math.abs(m[3] - 1) < 1e-12 && Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12;

/** Patch that turns a node's frame with matrix m ({} when it does not change). */
export function framePatch(node, m) {
  if (isMove(m)) return {};
  const cur = nodeFrameAngle(node);
  const next = transformFrameAngle(cur, m);
  if (node.frameAngle === undefined && Math.abs(next - cur) < 1e-9) return {};
  return { frameAngle: next };
}

let frameCache = new WeakMap();

function cornersBounds(pts) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Bounds of a node in a frame turned by `deg`: the rect in frame
 * coordinates (frame = rotate(-deg) applied to document space).
 */
export function frameBounds(doc, node, deg, visual = false) {
  if (!node) return null;
  if (!deg) return visual ? visualBounds(doc, node) : nodeBounds(doc, node);
  const leaf = node.type === 'path' || node.type === 'text' || node.type === 'image';
  let b = null;
  if (leaf) {
    const c = frameCache.get(node);
    if (c && c.deg === deg) b = c.b;
    else {
      const R = rotate(-deg);
      if (node.type === 'path') b = node.anchors.length ? pathBounds(transformAnchors(node.anchors, R), node.closed) : null;
      else {
        const r = node.type === 'text' ? layoutText(node).bounds : { x: 0, y: 0, w: node.width, h: node.height };
        b = cornersBounds(localCorners(r, multiply(R, node.transform)));
      }
      frameCache.set(node, { deg, b });
    }
    return b && visual ? inflate(b, strokeOutset(node) + effectsOutset(node, b)) : b;
  }
  if (node.type === 'group' && node.clip && node.children.length) return frameBounds(doc, doc.get(node.children[node.children.length - 1]), deg);
  if (!node.children && liveDef(node)) {
    // Leaf live objects (symbol instances, ...) measure their generated artwork in the frame.
    const { items, vdoc } = liveArtwork(doc, node);
    for (const n of items) if (!n.hidden) b = unionRect(b, frameBounds(vdoc, n, deg, visual));
    return b;
  }
  for (const id of node.children || []) {
    const cn = doc.get(id);
    if (!cn || (cn.hidden && node.type !== 'compound')) continue;
    b = unionRect(b, frameBounds(doc, cn, deg, visual && node.type !== 'compound'));
  }
  if (b && visual && (node.type === 'compound' || effectsOutset(node, b))) b = inflate(b, (node.type === 'compound' ? strokeOutset(node) : 0) + effectsOutset(node, b));
  return b;
}

/**
 * The selection's bounding box: { x, y, w, h, angle } where x, y, w, h are in
 * the frame (see frameBounds). Objects that all share a frame angle use it,
 * a mix of angles gets an unrotated box.
 */
export function selectionFrame(doc, ids, visual = false) {
  const nodes = ids.map((id) => doc.get(id)).filter(Boolean);
  if (!nodes.length) return null;
  let angle = nodeFrameAngle(nodes[0]);
  for (const n of nodes) {
    const d = Math.abs(normAngle(nodeFrameAngle(n) - angle));
    if (d > 1e-6) {
      angle = 0;
      break;
    }
  }
  let b = null;
  for (const n of nodes) b = unionRect(b, frameBounds(doc, n, angle, visual));
  return b ? { ...b, angle } : null;
}

/** A frame-space point in document space. */
export function frameToDoc(f, x, y) {
  return f.angle ? apply(rotate(f.angle), x, y) : { x, y };
}

/** A document point in frame space. */
export function docToFrame(f, x, y) {
  return f.angle ? apply(rotate(-f.angle), x, y) : { x, y };
}

/** Matrix that applies frame-space matrix m (e.g. a scale along the frame's axes) in document space. */
export function frameMatrix(f, m) {
  return f.angle ? multiply(rotate(f.angle), multiply(m, rotate(-f.angle))) : m;
}

/** Half of the stroke's reach outside the geometry, for visual (preview) bounds. */
export function strokeOutset(node) {
  if (!node.stroke || !node.strokeWidth) return 0;
  const w = node.strokeWidth;
  const align = node.strokeAlign || 'center';
  let out = align === 'inside' ? 0 : align === 'outside' ? w : w / 2;
  if (node.strokeJoin === 'miter' && node.type !== 'text') out *= Math.min(node.miterLimit || 10, 4);
  if (node.strokeCap === 'square') out = Math.max(out, (w / 2) * Math.SQRT2);
  // Arrowheads reach a few stroke widths past the path ends.
  for (const a of [node.arrowStart, node.arrowEnd]) if (a) out = Math.max(out, w * 8 * ((a.scale ?? 100) / 100));
  return out;
}

/**
 * How far raster effects from feature modules reach past an object:
 * type -> (effect, bounds) -> document units (bounds may be null).
 */
export const effectOutsets = new Map();

function effectsOutset(node, b = null) {
  let d = 0;
  for (const fx of node.effects || []) {
    if (fx.hidden) continue;
    const ext = effectOutsets.get(fx.type);
    if (ext) d = Math.max(d, ext(fx, b) || 0);
    if (fx.type === 'dropShadow') d = Math.max(d, Math.hypot(fx.x || 0, fx.y || 0) + (fx.blur || 0) * 2);
    if (fx.type === 'blur') d = Math.max(d, (fx.radius || 0) * 3);
    if (fx.type === 'outerGlow') d = Math.max(d, (fx.blur ?? 5) * 3);
  }
  return d;
}

/** Visual bounds including stroke and effects (what renders), for culling and export. */
export function visualBounds(doc, node) {
  if (!node) return null;
  if (livePathDef(node)) {
    const b = liveBounds(doc, node, true);
    return b && effectsOutset(node, b) ? inflate(b, effectsOutset(node, b)) : b;
  }
  if ((node.type === 'path' || node.type === 'compound') && geomEffectsOf(node)) {
    // Geometry effects (Roughen, Warp, ...) can reach past the stored anchors.
    const b = subpathsBounds(effectiveSubpaths(doc, node));
    return b ? inflate(b, strokeOutset(node) + effectsOutset(node, b) + geomEffectsOutset(node, b)) : null;
  }
  if (node.type === 'text' && liveDef(node)) {
    // Type with geometry effects reaches as far as its effected outlines.
    const b = liveBounds(doc, node, true);
    return b && effectsOutset(node, b) ? inflate(b, effectsOutset(node, b)) : b;
  }
  if (node.type === 'path' || node.type === 'text' || node.type === 'image') {
    const cached = visualCache.get(node);
    if (cached !== undefined) return cached;
    const b = nodeBounds(doc, node);
    const v = b ? inflate(b, strokeOutset(node) + effectsOutset(node, b)) : null;
    visualCache.set(node, v);
    return v;
  }
  if (node.type === 'compound') {
    const b = nodeBounds(doc, node);
    return b ? inflate(b, strokeOutset(node) + effectsOutset(node, b)) : null;
  }
  if (liveDef(node)) {
    const b = liveBounds(doc, node, true);
    return b && effectsOutset(node, b) ? inflate(b, effectsOutset(node, b)) : b;
  }
  if (node.type === 'group' && node.clip && node.children.length) {
    return nodeBounds(doc, doc.get(node.children[node.children.length - 1]));
  }
  let b = null;
  for (const c of node.children || []) {
    const cn = doc.get(c);
    if (!cn || cn.hidden) continue;
    b = unionRect(b, visualBounds(doc, cn));
  }
  return b && effectsOutset(node, b) ? inflate(b, effectsOutset(node, b)) : b;
}

/** Union of bounds for a list of ids. `visual` adds stroke (Use Preview Bounds). */
export function selectionBounds(doc, ids, visual = false) {
  let b = null;
  for (const id of ids) {
    const n = doc.get(id);
    if (!n) continue;
    b = unionRect(b, visual ? visualBounds(doc, n) : nodeBounds(doc, n));
  }
  return b;
}

/**
 * Transform a paint's gradient geometry with the object. A gradient that
 * still fits the object's bounds (no end points) gets end points from
 * `bounds` (the object's bounds before the transform) unless the matrix is a
 * plain move, so rotating, skewing, reflecting or scaling the object turns,
 * slants and stretches its gradient along with it.
 */
export function transformPaint(paint, m, bounds, opts = {}) {
  // Pattern paints carry their own pattern-to-document matrix; Transform Patterns off leaves it put.
  if (paint?.type === 'pattern') return opts.transformPatterns === false ? paint : { ...paint, transform: multiply(m, paint.transform || [1, 0, 0, 1, 0, 0]) };
  if (!paint || (paint.type !== 'linear' && paint.type !== 'radial')) return paint;
  if (paint.x1 === undefined) {
    const move = Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
    const b = move ? null : typeof bounds === 'function' ? bounds() : bounds;
    if (!b) return paint;
    paint = gradientEnds(paint, b);
  }
  const p1 = apply(m, paint.x1, paint.y1);
  const p2 = apply(m, paint.x2, paint.y2);
  return { ...paint, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

/** The paint with explicit end points equal to its fitted geometry on bounds b. */
export function gradientEnds(paint, b) {
  const g = gradientGeometry(paint, b);
  if (paint.type === 'radial') {
    const a = (-(paint.angle || 0) * Math.PI) / 180;
    return { ...paint, x1: g.x1, y1: g.y1, x2: g.x1 + Math.cos(a) * g.r, y2: g.y1 + Math.sin(a) * g.r };
  }
  return { ...paint, x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 };
}

/** Rotational symmetry of each live shape kind, in degrees. */
const SHAPE_PERIOD = {
  rect: (s) => (s.radii && new Set(s.radii).size > 1 ? 360 : 180),
  ellipse: () => 180,
  polygon: (s) => 360 / Math.max(3, Math.round(s.sides || 3)),
  star: (s) => 360 / Math.max(3, Math.round(s.points || 3)),
};

/**
 * Keep live-shape params when the matrix is a translation, a rotation, a
 * uniform scale, a reflection or an axis-aligned scale of an unrotated
 * shape; otherwise the shape becomes a
 * plain path (like expanding a live shape).
 */
function transformShape(shape, m, opts) {
  const out = transformShapeParams(shape, m, opts);
  return out && isPie(shape) ? retargetPie(shape, out, m) : out;
}

/** Pie angles of a transformed live ellipse: its rim end points mapped into the new ellipse's frame. */
function retargetPie(shape, out, m) {
  const rim = (s, deg) => {
    const t = (deg * Math.PI) / 180;
    return apply(rotate(s.angle || 0, s.cx, s.cy), s.cx + (s.w / 2) * Math.cos(t), s.cy - (s.h / 2) * Math.sin(t));
  };
  const back = rotate(-(out.angle || 0), out.cx, out.cy);
  const angleOf = (p) => {
    const q = apply(back, p.x, p.y);
    const deg = (Math.atan2(-(q.y - out.cy) / (out.h / 2 || 1), (q.x - out.cx) / (out.w / 2 || 1)) * 180) / Math.PI;
    return Math.round(((deg % 360) + 360) % 360 * 1e6) / 1e6;
  };
  const a = angleOf(apply(m, rim(shape, shape.pieStart).x, rim(shape, shape.pieStart).y));
  const b = angleOf(apply(m, rim(shape, shape.pieEnd).x, rim(shape, shape.pieEnd).y));
  // A reflection reverses the arc's direction.
  const flipped = m[0] * m[3] - m[1] * m[2] < 0;
  return { ...out, pieStart: flipped ? b : a, pieEnd: flipped ? a : b };
}

function transformShapeParams(shape, m, opts) {
  if (!shape) return undefined;
  const d = decompose(m);
  const pureMove = Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
  if (shape.kind === 'line') {
    const a = apply(m, shape.x1, shape.y1);
    const b = apply(m, shape.x2, shape.y2);
    return { ...shape, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }
  const c = apply(m, shape.cx, shape.cy);
  if (pureMove) return { ...shape, cx: c.x, cy: c.y };
  const uniform = Math.abs(Math.abs(d.sx) - Math.abs(d.sy)) < 1e-6 * Math.max(1, d.sx) && Math.abs(d.skew) < 1e-6;
  if (uniform && SHAPE_PERIOD[shape.kind]) {
    // Rotation, uniform scale and reflection keep a live shape live, at any angle.
    const k = d.sx;
    const angle0 = shape.angle || 0;
    let angle = angle0 + d.rotation;
    if (d.sy < 0) {
      // A reflection is a rotation of the mirrored shape; the mirror image of each
      // kind is itself turned by its symmetry, so pick the turn nearest the old angle.
      const period = SHAPE_PERIOD[shape.kind](shape);
      angle = d.rotation - angle0 + (shape.kind === 'polygon' || shape.kind === 'star' ? 180 : 0);
      angle -= period * Math.round((angle - angle0) / period);
    }
    angle = ((angle % 360) + 360) % 360;
    if (Math.abs(angle) < 1e-9 || Math.abs(angle - 360) < 1e-9) angle = 0;
    const out = { ...shape, cx: c.x, cy: c.y, angle };
    if (shape.kind === 'rect' || shape.kind === 'ellipse') {
      out.w = shape.w * k;
      out.h = shape.h * k;
      // Mirroring swaps the top and bottom corners (in the shape's own frame).
      const radii = shape.radii && d.sy < 0 ? [shape.radii[3], shape.radii[2], shape.radii[1], shape.radii[0]] : shape.radii;
      if (radii) out.radii = radii.map((r) => r * (opts.scaleCorners ? k : 1));
    } else if (shape.kind === 'polygon') out.r = shape.r * k;
    else {
      out.r1 = shape.r1 * k;
      out.r2 = shape.r2 * k;
    }
    return out;
  }
  // A scale along the shape's own axes (a rotated box's side handles) keeps it live too.
  const sa = shape.angle || 0;
  const L = sa ? multiply(rotate(-sa), multiply([m[0], m[1], m[2], m[3], 0, 0], rotate(sa))) : m;
  const scale = Math.max(Math.abs(L[0]), Math.abs(L[3]), 1e-12);
  if (Math.abs(L[1]) < 1e-9 * scale && Math.abs(L[2]) < 1e-9 * scale) {
    const sx = Math.abs(L[0]);
    const sy = Math.abs(L[3]);
    if (shape.kind === 'rect' || shape.kind === 'ellipse') {
      const scaleR = opts.scaleCorners ? Math.min(sx, sy) : 1;
      let radii = shape.radii;
      // Mirroring along the shape's axes swaps its corners: radii are [tl, tr, br, bl].
      if (radii && L[0] < 0) radii = [radii[1], radii[0], radii[3], radii[2]];
      if (radii && L[3] < 0) radii = [radii[3], radii[2], radii[1], radii[0]];
      return {
        ...shape,
        cx: c.x,
        cy: c.y,
        w: shape.w * sx,
        h: shape.h * sy,
        radii: radii ? radii.map((r) => r * scaleR) : radii,
      };
    }
    if (Math.abs(sx - sy) < 1e-6 && L[0] > 0 && L[3] > 0) {
      if (shape.kind === 'polygon') return { ...shape, cx: c.x, cy: c.y, r: shape.r * sx };
      if (shape.kind === 'star') return { ...shape, cx: c.x, cy: c.y, r1: shape.r1 * sx, r2: shape.r2 * sx };
    }
  }
  return undefined;
}

/**
 * Properties that feature modules keep in step with an object's transform
 * (e.g. a linked opacity mask): fn(node, m, opts, doc) -> patch or null,
 * merged into the node's patch whenever the node itself is transformed
 * (`doc` resolves the node's children as they were before the transform).
 */
export const transformHooks = [];

function hookPatches(node, m, opts, out, doc) {
  for (const fn of transformHooks) {
    const p = fn(node, m, opts, doc);
    if (p) out.set(node.id, { ...out.get(node.id), ...p });
  }
}

/**
 * Patches (id -> patch) that apply matrix m to a node and its descendants.
 * opts.scaleStrokes scales stroke widths and effects with the object;
 * opts.scaleCorners scales live-corner radii.
 */
export function transformPatches(doc, node, m, opts = {}, out = new Map()) {
  if (opts.transformObjects === false) return opts.transformPatterns === false ? out : patternPatches(doc, node, m, out);
  const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const strokePatch = (n) => (opts.scaleStrokes && n.strokeWidth ? { strokeWidth: n.strokeWidth * s } : {});
  switch (node.type) {
    case 'path': {
      let anchors = transformAnchors(node.anchors, m);
      const shape = transformShape(node.shape, m, opts);
      // A live rectangle with corner radii regenerates from its params so the corners keep their shape.
      if (shape && shape.kind === 'rect' && shape.radii?.some((r) => r > 0)) anchors = shapeAnchors(shape) || anchors;
      // Live corners on anchors scale with the object when Scale Corners is on.
      if (opts.scaleCorners && s !== 1) anchors = anchors.map((a) => (a.corner?.r ? { ...a, corner: { ...a.corner, r: a.corner.r * s } } : a));
      const nb = () => nodeBounds(doc, node);
      out.set(node.id, {
        anchors,
        shape,
        fill: transformPaint(node.fill, m, nb, opts),
        stroke: transformPaint(node.stroke, m, nb, opts),
        ...strokePatch(node),
        ...framePatch(node, m),
      });
      break;
    }
    case 'text':
    case 'image':
    case 'instance': {
      const nb = () => nodeBounds(doc, node);
      out.set(node.id, {
        ...((node.type === 'text' && textFramePatch(node, m)) || { transform: multiply(m, node.transform) }),
        ...(node.type === 'text' ? { fill: transformPaint(node.fill, m, nb, opts), stroke: transformPaint(node.stroke, m, nb, opts), ...strokePatch(node) } : {}),
        ...framePatch(node, m),
      });
      break;
    }
    case 'compound': {
      const nb = () => nodeBounds(doc, node);
      out.set(node.id, { fill: transformPaint(node.fill, m, nb, opts), stroke: transformPaint(node.stroke, m, nb, opts), ...strokePatch(node), ...framePatch(node, m) });
      for (const c of node.children) {
        const cn = doc.get(c);
        if (cn) out.set(cn.id, { anchors: transformAnchors(cn.anchors, m), shape: undefined });
      }
      break;
    }
    case 'group':
    case 'layer': {
      const own = node.type === 'group' ? ownSpaceTransform(doc, node, m, opts) : null;
      if (own) {
        if (own.patch) out.set(node.id, own.patch);
        for (const c of node.children) {
          const cn = doc.get(c);
          if (cn) transformPatches(doc, cn, own.matrix, opts, out);
        }
        break;
      }
      const fp = node.type === 'group' ? framePatch(node, m) : {};
      const lp = node.type === 'group' ? liveParamsPatch(node, m, opts) : null;
      if ('frameAngle' in fp || lp) out.set(node.id, { ...fp, ...lp });
      for (const c of node.children) {
        const cn = doc.get(c);
        if (cn) transformPatches(doc, cn, m, opts, out);
      }
      break;
    }
    default: {
      // Leaf live objects with absolute parameters (gradient meshes) move them.
      const lp = liveParamsPatch(node, m, opts);
      if (lp) out.set(node.id, { ...lp, ...framePatch(node, m) });
      break;
    }
  }
  if (transformHooks.length) hookPatches(node, m, opts, out, doc);
  return out;
}

/** Transform only the pattern paints in a subtree (Transform Patterns without Transform Objects). */
function patternPatches(doc, node, m, out) {
  if (!node) return out;
  const patch = {};
  for (const key of ['fill', 'stroke']) if (node[key]?.type === 'pattern') patch[key] = transformPaint(node[key], m, null);
  if (Object.keys(patch).length) out.set(node.id, patch);
  if (node.type === 'group' || node.type === 'layer') for (const c of node.children) patternPatches(doc, doc.get(c), m, out);
  return out;
}

/** True when any object in the subtrees of `ids` is painted with a pattern swatch. */
export function usesPatternPaint(doc, ids) {
  const visit = (n) => n && (n.fill?.type === 'pattern' || n.stroke?.type === 'pattern' || (n.children || []).some((c) => visit(doc.get(c))));
  return ids.some((id) => visit(doc.get(id)));
}

/** Patch keeping a live object's parameters (centers, mesh points) in step with a transform. */
function liveParamsPatch(node, m, opts) {
  const def = liveDef(node);
  return def?.transformParams ? def.transformParams(node, m, opts) || null : null;
}

/**
 * Live objects that keep their contents in their own space (objects in
 * perspective) map a document transform into that space: { patch, matrix }.
 */
function ownSpaceTransform(doc, node, m, opts) {
  const def = liveDef(node);
  return def?.transform ? def.transform(doc, node, m, opts) || null : null;
}

/** Apply a matrix to a set of node ids (inside an open transaction). */
export function transformNodes(doc, ids, m, opts = {}) {
  const patches = new Map();
  for (const id of ids) {
    const n = doc.get(id);
    if (n) transformPatches(doc, n, m, opts, patches);
  }
  for (const [id, patch] of patches) doc.update(id, patch);
}

/** Snapshot-based transform for drags: always transform from the original nodes. */
export function transformFromOriginals(doc, originals, m, opts = {}) {
  const patches = new Map();
  if (opts.transformObjects === false) {
    if (opts.transformPatterns === false) return;
    for (const n of originals.values()) for (const key of ['fill', 'stroke']) if (n[key]?.type === 'pattern') patches.set(n.id, { ...patches.get(n.id), [key]: transformPaint(n[key], m, null) });
    for (const [id, patch] of patches) doc.update(id, patch);
    return;
  }
  // Contents of objects with their own space move by the matrix their object maps m to.
  const inner = new Map();
  const view = { get: (id) => originals.get(id) || doc.get(id), has: (id) => originals.has(id) || doc.has(id), root: doc.root, assets: doc.assets, artboards: doc.artboards };
  for (const n of originals.values()) {
    const mm = inner.get(n.id) || m;
    const own = n.type === 'group' ? ownSpaceTransform(view, n, mm, opts) : null;
    if (n.children && (own || mm !== m)) for (const c of n.children) inner.set(c, own ? own.matrix : mm);
    if (own) {
      if (own.patch) patches.set(n.id, own.patch);
    } else if (n.type === 'path' || n.type === 'text' || n.type === 'image' || n.type === 'instance' || (!n.children && liveDef(n)?.transformParams)) {
      transformPatches(doc, n, mm, opts, patches);
    } else if (n.type === 'compound') {
      // Bounds from the original subpaths: the document already holds the previous drag step.
      const nb = () => n.children.reduce((acc, c) => unionRect(acc, originals.has(c) ? nodeBounds(doc, originals.get(c)) : null), null);
      patches.set(n.id, {
        fill: transformPaint(n.fill, mm, nb, opts),
        stroke: transformPaint(n.stroke, mm, nb, opts),
        ...(opts.scaleStrokes && n.strokeWidth ? { strokeWidth: n.strokeWidth * Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2])) } : {}),
        ...framePatch(n, mm),
      });
    } else if (n.type === 'group') {
      const fp = framePatch(n, mm);
      const lp = liveParamsPatch(n, mm, opts);
      if ('frameAngle' in fp || lp) patches.set(n.id, { ...fp, ...lp });
    }
  }
  if (transformHooks.length) for (const n of originals.values()) hookPatches(n, inner.get(n.id) || m, opts, patches, view);
  // A drag back to a plain move restores the original frame angle a previous step changed.
  for (const n of originals.values()) {
    const p = patches.get(n.id);
    if (p && 'frameAngle' in p) continue;
    if (doc.get(n.id)?.frameAngle === n.frameAngle) continue;
    if (p) p.frameAngle = n.frameAngle;
    else patches.set(n.id, { frameAngle: n.frameAngle });
  }
  for (const [id, patch] of patches) doc.update(id, patch);
}

/** Collect a node plus all descendants into a Map of originals (for drag transforms). */
export function collectOriginals(doc, ids) {
  const out = new Map();
  const add = (n) => {
    if (!n || out.has(n.id)) return;
    out.set(n.id, n);
    for (const c of n.children || []) add(doc.get(c));
  };
  for (const id of ids) add(doc.get(id));
  return out;
}

/**
 * Resolved linear/radial gradient geometry for a paint on a node with
 * bounds b: { x1, y1, x2, y2, r } in document space.
 */
export function gradientGeometry(paint, b) {
  if (paint.x1 !== undefined) {
    return { x1: paint.x1, y1: paint.y1, x2: paint.x2, y2: paint.y2, r: Math.hypot(paint.x2 - paint.x1, paint.y2 - paint.y1) };
  }
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  if (paint.type === 'radial') {
    const r = Math.max(b.w, b.h) / 2;
    return { x1: cx, y1: cy, x2: cx + r, y2: cy, r };
  }
  const a = ((paint.angle || 0) * Math.PI) / 180;
  // Default: the gradient spans the bounds along its angle (y up = positive angle).
  const dx = Math.cos(a);
  const dy = -Math.sin(a);
  const half = (Math.abs(dx) * b.w + Math.abs(dy) * b.h) / 2;
  return { x1: cx - dx * half, y1: cy - dy * half, x2: cx + dx * half, y2: cy + dy * half, r: half * 2 };
}

/**
 * Gradient geometry (document space) moved into a text object's local
 * space: type is drawn inside its transform, while its paint geometry is
 * kept in document space like every other object's.
 */
export function localGradientGeometry(g, m) {
  if (!m || isIdentity(m)) return g;
  const inv = invert(m);
  const a = apply(inv, g.x1, g.y1);
  const b = apply(inv, g.x2, g.y2);
  const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, r: g.r / s };
}
