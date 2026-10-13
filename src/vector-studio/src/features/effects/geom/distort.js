/**
 * Distort & Transform effect geometry: Free Distort, Pucker & Bloat,
 * Roughen, Transform, Tweak, Twist and Zig Zag. Pure functions on subpaths
 * [{ anchors, closed, ... }] in document space; extra subpath fields (paint)
 * are kept.
 *
 * Random effects (Roughen, Tweak, Transform's Random option) draw from a
 * hash of the effect's stored seed and the point's position in the path, so
 * the result never changes between redraws and editing one part of a path
 * leaves the rest of the roughness where it was.
 */
import { segmentCount, segmentPoints, isLine, pointAt, derivativeAt, cubicLength, reverseAnchors } from '../../../model/bezier.js';
import { mapSubpaths } from '../../../model/point-map.js';
import { multiply, translate, rotate, scale, apply } from '../../../lib/matrix.js';

// ---- deterministic randomness ----

/** A 32-bit hash of integers (the seed and a point's indices). */
export function hash32(...nums) {
  let h = 0x811c9dc5;
  for (const n of nums) {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A uniform number in [-1, 1) from a seed and indices. */
export function noise(...nums) {
  return (hash32(...nums) / 4294967296) * 2 - 1;
}

/** A fresh random seed for a new effect. */
export function newSeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}

// ---- helpers ----

/** Tangent of a cubic at t, falling back to its chord where a retracted handle makes it vanish. */
function tangentAt(c, t) {
  const d = derivativeAt(c, t);
  if (Math.hypot(d.x, d.y) > 1e-9) return d;
  const p = pointAt(c, Math.min(1, t + 1e-3));
  const q = pointAt(c, Math.max(0, t - 1e-3));
  if (Math.hypot(p.x - q.x, p.y - q.y) > 1e-12) return { x: p.x - q.x, y: p.y - q.y };
  return { x: c[6] - c[0], y: c[7] - c[1] };
}

const handlesOf = (c) => (isLine(c) ? [c[0] + (c[6] - c[0]) / 3, c[1] + (c[7] - c[1]) / 3, c[6] + (c[0] - c[6]) / 3, c[7] + (c[1] - c[7]) / 3] : [c[2], c[3], c[4], c[5]]);

/**
 * Points along a subpath: every anchor plus `count(c, i)` evenly spaced
 * points inside segment i (by arc length). Each point is { x, y, nx, ny,
 * anchor } with the unit normal (left of travel) at that point.
 */
function samplePoints(anchors, closed, count) {
  const out = [];
  const segs = segmentCount(anchors, closed);
  const norm = (dx, dy) => {
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    // Anchor normal: the average of the incoming and outgoing segment normals.
    let nx = 0;
    let ny = 0;
    const inSeg = i > 0 ? i - 1 : closed ? segs - 1 : -1;
    if (inSeg >= 0 && inSeg < segs) {
      const d = tangentAt(segmentPoints(anchors, inSeg), 1);
      const [x, y] = norm(d.x, d.y);
      nx += x;
      ny += y;
    }
    if (i < segs) {
      const d = tangentAt(segmentPoints(anchors, i), 0);
      const [x, y] = norm(d.x, d.y);
      nx += x;
      ny += y;
    }
    const l = Math.hypot(nx, ny) || 1;
    out.push({ x: a.x, y: a.y, nx: nx / l, ny: ny / l, anchor: true, src: a });
    if (i >= segs) continue;
    const c = segmentPoints(anchors, i);
    const k = count(c, i);
    if (k <= 0) continue;
    // Arc-length parameterization from a fine sampling.
    const N = Math.max(16, k * 8);
    const lens = [0];
    let prev = pointAt(c, 0);
    for (let j = 1; j <= N; j++) {
      const p = pointAt(c, j / N);
      lens.push(lens[j - 1] + Math.hypot(p.x - prev.x, p.y - prev.y));
      prev = p;
    }
    const total = lens[N];
    for (let m = 1; m <= k; m++) {
      const target = (total * m) / (k + 1);
      let j = 1;
      while (j < N && lens[j] < target) j++;
      const f = lens[j] === lens[j - 1] ? 0 : (target - lens[j - 1]) / (lens[j] - lens[j - 1]);
      const t = (j - 1 + f) / N;
      const p = pointAt(c, t);
      const d = tangentAt(c, t);
      const [x, y] = norm(d.x, d.y);
      out.push({ x: p.x, y: p.y, nx: x, ny: y, anchor: false });
    }
  }
  return out;
}

/** Anchors through points: straight segments, or smooth curves (Catmull-Rom tangents). */
function pointsToAnchors(pts, closed, smooth, tension = 1 / 6) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = { x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y };
    if (!smooth || n < 3) return a;
    const prev = pts[i - 1] ?? (closed ? pts[n - 1] : null);
    const next = pts[i + 1] ?? (closed ? pts[0] : null);
    if (!prev || !next) {
      // Open ends aim at their neighbor.
      const o = prev || next;
      const dx = (o.x - p.x) * tension * 2;
      const dy = (o.y - p.y) * tension * 2;
      if (prev) {
        a.ix = p.x + dx;
        a.iy = p.y + dy;
      } else {
        a.ox = p.x + dx;
        a.oy = p.y + dy;
      }
      return a;
    }
    const tx = (next.x - prev.x) * tension;
    const ty = (next.y - prev.y) * tension;
    a.ix = p.x - tx;
    a.iy = p.y - ty;
    a.ox = p.x + tx;
    a.oy = p.y + ty;
    return a;
  });
}

const sizeOf = (b) => (b.w + b.h) / 2;

// ---- Free Distort ----

/**
 * Free Distort: the bounding box's corners move to `corners` (top-left,
 * top-right, bottom-right, bottom-left), given as fractions of the box so
 * the distortion follows the object when it is resized. The artwork follows
 * a bilinear map of the box.
 */
export function freeDistortMapping(corners, b) {
  const P = corners.map((c) => ({ x: b.x + c.x * b.w, y: b.y + c.y * b.h }));
  const w = b.w || 1e-9;
  const h = b.h || 1e-9;
  return (x, y) => {
    const u = (x - b.x) / w;
    const v = (y - b.y) / h;
    const top = { x: P[0].x + (P[1].x - P[0].x) * u, y: P[0].y + (P[1].y - P[0].y) * u };
    const bot = { x: P[3].x + (P[2].x - P[3].x) * u, y: P[3].y + (P[2].y - P[3].y) * u };
    return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
  };
}

export const SQUARE_CORNERS = Object.freeze([
  Object.freeze({ x: 0, y: 0 }),
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: 1, y: 1 }),
  Object.freeze({ x: 0, y: 1 }),
]);

export function freeDistort(subs, fx, b) {
  const corners = fx.corners?.length === 4 ? fx.corners : SQUARE_CORNERS;
  if (corners.every((c, i) => Math.abs(c.x - SQUARE_CORNERS[i].x) < 1e-9 && Math.abs(c.y - SQUARE_CORNERS[i].y) < 1e-9)) return subs;
  return mapSubpaths(subs, freeDistortMapping(corners, b), { tolerance: 0.05 });
}

// ---- Pucker & Bloat ----

/**
 * Pucker & Bloat: anchors stay; every segment's handles move away from
 * the center (bloat, amount > 0) or toward it (pucker, amount < 0) by
 * `amount` times their distance from it, so edges bulge into lobes or pinch
 * into spikes.
 */
export function puckerBloat(subs, fx, b) {
  const a = fx.amount || 0;
  if (!a) return subs;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const move = (x, y) => [x + (x - cx) * a, y + (y - cy) * a];
  return subs.map((s) => {
    const src = s.anchors;
    const out = src.map((p) => ({ ...p }));
    const segs = segmentCount(src, s.closed);
    for (let i = 0; i < segs; i++) {
      const c = segmentPoints(src, i);
      const [h1x, h1y, h2x, h2y] = handlesOf(c);
      const [ox, oy] = move(h1x, h1y);
      const [ix, iy] = move(h2x, h2y);
      out[i].ox = ox;
      out[i].oy = oy;
      const j = (i + 1) % src.length;
      out[j].ix = ix;
      out[j].iy = iy;
    }
    return { ...s, anchors: out };
  });
}

// ---- Roughen ----

/**
 * Roughen: points are added along every segment (`detail` per inch) and
 * every point is moved by up to `size` in x and y (a fraction of the
 * object's size when `relative`), joined by smooth curves or corners.
 */
export function roughen(subs, fx, b) {
  const size = fx.relative ? (fx.size || 0) * sizeOf(b) : fx.size || 0;
  if (!size) return subs;
  const perPt = Math.max(0, fx.detail || 0) / 72;
  const seed = fx.seed | 0;
  return subs.map((s, si) => {
    const pts = samplePoints(s.anchors, s.closed, (c) => Math.min(400, Math.floor(cubicLength(c, 0.5) * perPt)));
    const moved = pts.map((p, i) => ({ x: p.x + noise(seed, si, i, 1) * size, y: p.y + noise(seed, si, i, 2) * size }));
    return { ...s, anchors: pointsToAnchors(moved, s.closed, fx.smooth) };
  });
}

// ---- Zig Zag ----

/**
 * Zig Zag: `ridges` points are added inside every segment and all points
 * alternate `size` to the left and right of the path, joined by smooth
 * curves (waves) or corners (zigzags).
 */
export function zigzag(subs, fx, b) {
  const size = fx.relative ? (fx.size || 0) * sizeOf(b) : fx.size || 0;
  if (!size) return subs;
  const ridges = Math.max(0, Math.round(fx.ridges || 0));
  return subs.map((s) => {
    const pts = samplePoints(s.anchors, s.closed, () => ridges);
    const moved = pts.map((p, i) => {
      const d = i % 2 ? -size : size;
      return { x: p.x + p.nx * d, y: p.y + p.ny * d };
    });
    return { ...s, anchors: pointsToAnchors(moved, s.closed, fx.smooth, 1 / 5) };
  });
}

// ---- Tweak ----

/**
 * Tweak: anchors and/or their handles move by random amounts up to
 * `h` horizontally and `v` vertically (fractions of the object's width and
 * height when `relative`). A moved anchor takes its handles along.
 */
export function tweak(subs, fx, b) {
  const H = fx.relative ? (fx.h || 0) * b.w : fx.h || 0;
  const V = fx.relative ? (fx.v || 0) * b.h : fx.v || 0;
  if ((!H && !V) || (!fx.anchors && !fx.inHandles && !fx.outHandles)) return subs;
  const seed = fx.seed | 0;
  return subs.map((s, si) => {
    // Straight segments get real handles so moving them can curve the edge.
    const src = s.anchors;
    const segs = segmentCount(src, s.closed);
    const base = src.map((p) => ({ ...p }));
    if (fx.inHandles || fx.outHandles) {
      for (let i = 0; i < segs; i++) {
        const c = segmentPoints(src, i);
        if (!isLine(c)) continue;
        const [h1x, h1y, h2x, h2y] = handlesOf(c);
        const j = (i + 1) % src.length;
        if (fx.outHandles) {
          base[i].ox = h1x;
          base[i].oy = h1y;
        }
        if (fx.inHandles) {
          base[j].ix = h2x;
          base[j].iy = h2y;
        }
      }
    }
    const anchors = base.map((p, i) => {
      const q = { ...p };
      if (fx.anchors) {
        const dx = noise(seed, si, i, 1) * H;
        const dy = noise(seed, si, i, 2) * V;
        q.x += dx;
        q.y += dy;
        q.ix += dx;
        q.iy += dy;
        q.ox += dx;
        q.oy += dy;
      }
      if (fx.inHandles && (q.ix !== q.x || q.iy !== q.y)) {
        q.ix += noise(seed, si, i, 3) * H;
        q.iy += noise(seed, si, i, 4) * V;
      }
      if (fx.outHandles && (q.ox !== q.x || q.oy !== q.y)) {
        q.ox += noise(seed, si, i, 5) * H;
        q.oy += noise(seed, si, i, 6) * V;
      }
      return q;
    });
    return { ...s, anchors };
  });
}

// ---- Twist ----

/** Twist: the middle turns by `angle` degrees (counterclockwise), easing to no turn at the farthest corner. */
export function twist(subs, fx, b) {
  const ang = (-(fx.angle || 0) * Math.PI) / 180;
  if (!ang) return subs;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const R = Math.hypot(b.w, b.h) / 2 || 1;
  const f = (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const t = Math.max(0, 1 - Math.hypot(dx, dy) / R);
    const a = ang * t;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  };
  return mapSubpaths(subs, f, { tolerance: 0.05 });
}

// ---- Transform ----

/** Reference point of a box for origin fractions (0, 0.5, 1 on each axis). */
function refPoint(b, origin) {
  const [ox, oy] = origin || [0.5, 0.5];
  return { x: b.x + b.w * ox, y: b.y + b.h * oy };
}

/** The matrix of one Transform step (each value scaled by `k` for Random). */
export function transformStep(fx, b, k = [1, 1, 1, 1, 1]) {
  const o = refPoint(b, fx.origin);
  const sx = (1 + ((fx.scaleH ?? 1) - 1) * k[0]) * (fx.reflectX ? -1 : 1);
  const sy = (1 + ((fx.scaleV ?? 1) - 1) * k[1]) * (fx.reflectY ? -1 : 1);
  let m = translate(-o.x, -o.y);
  m = multiply(scale(sx, sy), m);
  // Angles are counterclockwise on screen, like the Rotate dialog.
  m = multiply(rotate(-(fx.angle || 0) * k[4]), m);
  m = multiply(translate(o.x + (fx.moveH || 0) * k[2], o.y + (fx.moveV || 0) * k[3]), m);
  return m;
}

function transformSub(s, m) {
  const anchors = s.anchors.map((a) => {
    const p = apply(m, a.x, a.y);
    const i = apply(m, a.ix, a.iy);
    const o = apply(m, a.ox, a.oy);
    return { x: p.x, y: p.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y };
  });
  // A reflection reverses the winding; keep it so overlapping copies do not punch holes.
  return { ...s, anchors: m[0] * m[3] - m[1] * m[2] < 0 ? reverseAnchors(anchors) : anchors };
}

/**
 * Transform: scale, move, rotate and reflect about a reference point.
 * Without copies the object itself is transformed; with copies the
 * original stays and each copy is transformed once more than the one
 * before (copies become extra outlines). Random draws each step's amounts
 * between none and the full values.
 */
export function transformEffect(subs, fx, b, strokeWidth = 0) {
  const copies = Math.max(0, Math.min(1000, Math.round(fx.copies || 0)));
  const seed = fx.seed | 0;
  const step = (n) => (fx.random ? transformStep(fx, b, [0, 1, 2, 3, 4].map((j) => (noise(seed, n, j) + 1) / 2)) : transformStep(fx, b));
  // Scale Strokes & Effects: each transformed outline's stroke follows its scale.
  const sub = (s, m) => {
    const t = transformSub(s, m);
    if (!fx.scaleStrokes) return t;
    const w = s.paint?.strokeWidth ?? strokeWidth;
    if (!(w > 0)) return t;
    return { ...t, paint: { ...s.paint, strokeWidth: w * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) } };
  };
  if (!copies) return subs.map((s) => sub(s, step(0)));
  const out = [...subs];
  let m = [1, 0, 0, 1, 0, 0];
  for (let n = 1; n <= copies; n++) {
    m = multiply(step(n), m);
    for (const s of subs) out.push(sub(s, m));
  }
  return out;
}
