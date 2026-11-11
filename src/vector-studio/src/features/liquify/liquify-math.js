/**
 * Liquify deformations: brush-based distortions of path geometry (Warp,
 * Twirl, Pucker, Bloat, Scallop, Crystallize, Wrinkle).
 *
 * The brush is an ellipse { cx, cy, w, h, angle (deg) } in document units.
 * A point's influence falls off smoothly from 1 at the center to 0 at the
 * rim, so deformations blend into the untouched geometry. Paths are first
 * densified where the brush reaches them (more anchors for a higher
 * Detail), then each anchor and its two handles move as independent points,
 * which keeps curves smooth through the distortion.
 */
import { segmentPoints, segmentCount, split, isLine, cubicLength, flattenPath } from '../../model/bezier.js';

/** Elliptical distance of (x, y) from the brush center: 0 at the center, 1 on the rim. */
export function brushDistance(brush, x, y) {
  // Angles turn counterclockwise on screen (the document's y axis points down).
  const a = ((brush.angle || 0) * Math.PI) / 180;
  const dx = x - brush.cx;
  const dy = y - brush.cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  const rx = Math.max(1e-6, brush.w / 2);
  const ry = Math.max(1e-6, brush.h / 2);
  return Math.hypot(lx / rx, ly / ry);
}

/** Smooth falloff weight in [0, 1]. */
export function falloff(brush, x, y) {
  const r = brushDistance(brush, x, y);
  if (r >= 1) return 0;
  const t = 1 - r * r;
  return t * t;
}

function brushBox(brush) {
  const r = Math.max(brush.w, brush.h) / 2;
  return { x: brush.cx - r, y: brush.cy - r, w: 2 * r, h: 2 * r };
}

function cubicNearBox(c, box) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < 8; i += 2) {
    x0 = Math.min(x0, c[i]);
    x1 = Math.max(x1, c[i]);
    y0 = Math.min(y0, c[i + 1]);
    y1 = Math.max(y1, c[i + 1]);
  }
  return x1 >= box.x && x0 <= box.x + box.w && y1 >= box.y && y0 <= box.y + box.h;
}

/** Whether any part of the path's control polygon reaches the brush. */
export function pathTouchesBrush(anchors, closed, brush) {
  const box = brushBox(brush);
  if (anchors.length === 1) return falloff(brush, anchors[0].x, anchors[0].y) > 0;
  const n = segmentCount(anchors, closed);
  for (let i = 0; i < n; i++) if (cubicNearBox(segmentPoints(anchors, i), box)) return true;
  return false;
}

/**
 * Split the segments the brush reaches so none is longer than `maxLen`.
 * Untouched segments keep their anchors. Returns a new anchor list.
 */
export function densify(anchors, closed, brush, maxLen) {
  const n = segmentCount(anchors, closed);
  if (!n || !(maxLen > 0)) return anchors;
  const box = brushBox(brush);
  const out = [];
  let carryIn = null; // in-handle for the next anchor produced by a split
  for (let i = 0; i < anchors.length; i++) {
    const a = carryIn ? { ...anchors[i], ix: carryIn.x, iy: carryIn.y } : { ...anchors[i] };
    carryIn = null;
    if (i >= n) {
      out.push(a);
      continue;
    }
    let c = segmentPoints(anchors, i);
    if (!cubicNearBox(c, box)) {
      out.push(a);
      continue;
    }
    const len = isLine(c) ? Math.hypot(c[6] - c[0], c[7] - c[1]) : cubicLength(c, 0.5);
    const pieces = Math.min(64, Math.ceil(len / maxLen));
    if (pieces <= 1) {
      out.push(a);
      continue;
    }
    if (isLine(c)) {
      // Straight segments split evenly into straight cubics whose handles lie
      // along the line (a third of a piece), so a distortion bends them smoothly.
      const ux = (c[6] - c[0]) / pieces / 3;
      const uy = (c[7] - c[1]) / pieces / 3;
      out.push({ ...a, ox: a.x + ux, oy: a.y + uy });
      for (let k = 1; k < pieces; k++) {
        const x = c[0] + ((c[6] - c[0]) * k) / pieces;
        const y = c[1] + ((c[7] - c[1]) * k) / pieces;
        out.push({ x, y, ix: x - ux, iy: y - uy, ox: x + ux, oy: y + uy });
      }
      carryIn = { x: c[6] - ux, y: c[7] - uy };
      continue;
    }
    // Split off equal-parameter pieces from the front of the segment.
    let cur = a;
    for (let k = pieces; k > 1; k--) {
      const [left, right] = split(c, 1 / k);
      cur.ox = left[2];
      cur.oy = left[3];
      out.push(cur);
      cur = { x: left[6], y: left[7], ix: left[4], iy: left[5], ox: right[2], oy: right[3] };
      c = right;
    }
    cur.ox = c[2];
    cur.oy = c[3];
    out.push(cur);
    carryIn = { x: c[4], y: c[5] };
  }
  if (carryIn) {
    // The closing segment's split changed the first anchor's in-handle.
    out[0] = { ...out[0], ix: carryIn.x, iy: carryIn.y };
  }
  return out;
}

/** A seeded pseudo-random generator (mulberry32) returning [0, 1). */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toCenter = (brush, x, y) => ({ x: brush.cx - x, y: brush.cy - y });

/**
 * Move one point by the deformation. `op` is the tool kind, `k` the step
 * strength (intensity times time or drag), `w` the falloff weight.
 */
function movePoint(op, brush, x, y, w, k, params, rand) {
  if (w <= 0) return { x, y };
  switch (op) {
    case 'warp': {
      // The point under the brush center follows the drag exactly; intensity
      // widens (high) or narrows (low) how far the pull reaches around it.
      const f = Math.pow(w, Math.max(0.25, 1.5 - (params.intensity ?? 0.5)));
      return { x: x + params.dx * f, y: y + params.dy * f };
    }
    case 'twirl': {
      const ang = (((params.rate ?? 40) * Math.PI) / 180) * w * k;
      const dx = x - brush.cx;
      const dy = y - brush.cy;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      return { x: brush.cx + dx * c - dy * s, y: brush.cy + dx * s + dy * c };
    }
    case 'pucker': {
      const v = toCenter(brush, x, y);
      const f = Math.min(1, 0.12 * w * k);
      return { x: x + v.x * f, y: y + v.y * f };
    }
    case 'bloat': {
      const v = toCenter(brush, x, y);
      const r = brushDistance(brush, x, y);
      // Push outward, slowing near the rim so points do not fly past the brush.
      const f = 0.12 * w * k * Math.max(0, 1 - r) * 2;
      return { x: x - v.x * f, y: y - v.y * f };
    }
    case 'wrinkle': {
      const amp = (Math.max(brush.w, brush.h) / 2) * 0.06 * w * k;
      return { x: x + (rand() * 2 - 1) * amp * (params.horizontal ?? 0), y: y + (rand() * 2 - 1) * amp * (params.vertical ?? 1) };
    }
    case 'scallop': {
      const v = toCenter(brush, x, y);
      const f = Math.min(1, 0.08 * w * k);
      return { x: x + v.x * f, y: y + v.y * f };
    }
    case 'crystallize': {
      const v = toCenter(brush, x, y);
      const f = 0.1 * w * k * (0.4 + rand());
      return { x: x - v.x * f, y: y - v.y * f };
    }
    default:
      return { x, y };
  }
}

/**
 * Apply one deformation step to an anchor list. Returns a new list (the
 * same array when nothing was in reach).
 *   op       'warp' | 'twirl' | 'pucker' | 'bloat' | 'scallop' | 'crystallize' | 'wrinkle'
 *   brush    { cx, cy, w, h, angle }
 *   k        step strength (0..)
 *   params   { dx, dy } for warp, { rate } for twirl, { horizontal, vertical } (0..1) for wrinkle,
 *            { complexity } for scallop/crystallize/wrinkle,
 *            { anchors, inHandles, outHandles } which points the brush moves
 *            (scallop, crystallize and wrinkle; all three for the other tools)
 *   seed     random seed for this step (wrinkle, crystallize, scallop)
 */
export function deformAnchors(anchors, closed, op, brush, k, params = {}, seed = 1) {
  if (!pathTouchesBrush(anchors, closed, brush)) return anchors;
  const rand = rng(seed);
  const selective = op === 'scallop' || op === 'crystallize' || op === 'wrinkle';
  const moveA = !selective || params.anchors !== false;
  const moveIn = !selective || Boolean(params.inHandles);
  const moveOut = !selective || Boolean(params.outHandles);
  let changed = false;
  const out = anchors.map((a) => {
    const w = falloff(brush, a.x, a.y);
    if (w <= 0) {
      // Handles reaching into the brush still bend with it.
      const wi = moveIn ? falloff(brush, a.ix, a.iy) : 0;
      const wo = moveOut ? falloff(brush, a.ox, a.oy) : 0;
      if (wi <= 0 && wo <= 0) return a;
      changed = true;
      const pi = wi > 0 ? movePoint(op, brush, a.ix, a.iy, wi, k, params, rand) : { x: a.ix, y: a.iy };
      const po = wo > 0 ? movePoint(op, brush, a.ox, a.oy, wo, k, params, rand) : { x: a.ox, y: a.oy };
      return { ...a, ix: pi.x, iy: pi.y, ox: po.x, oy: po.y };
    }
    changed = true;
    const p = moveA ? movePoint(op, brush, a.x, a.y, w, k, params, rand) : { x: a.x, y: a.y };
    let ix = a.ix - a.x + p.x;
    let iy = a.iy - a.y + p.y;
    let ox = a.ox - a.x + p.x;
    let oy = a.oy - a.y + p.y;
    if (op === 'warp' || op === 'twirl' || op === 'pucker' || op === 'bloat') {
      // Smooth tools move each handle by the field at the handle itself.
      const pi = movePoint(op, brush, a.ix, a.iy, falloff(brush, a.ix, a.iy), k, params, rand);
      const po = movePoint(op, brush, a.ox, a.oy, falloff(brush, a.ox, a.oy), k, params, rand);
      ix = pi.x;
      iy = pi.y;
      ox = po.x;
      oy = po.y;
    } else if (op === 'scallop') {
      // Handles fan out away from the center: the segments between anchors bulge into arcs.
      const v = { x: p.x - brush.cx, y: p.y - brush.cy };
      const len = Math.hypot(v.x, v.y) || 1;
      const reach = (Math.max(brush.w, brush.h) / 2) * 0.05 * w * k * (1 + (params.complexity || 0) / 5);
      if (moveIn) {
        ix = a.ix - a.x + p.x + (v.x / len) * reach;
        iy = a.iy - a.y + p.y + (v.y / len) * reach;
      }
      if (moveOut) {
        ox = a.ox - a.x + p.x + (v.x / len) * reach;
        oy = a.oy - a.y + p.y + (v.y / len) * reach;
      }
    } else if (op === 'crystallize') {
      // Spikes: handles pull in toward their anchor so the points stay sharp.
      const pull = Math.min(1, 0.2 * w * k);
      if (moveIn) {
        ix = p.x + (a.ix - a.x) * (1 - pull);
        iy = p.y + (a.iy - a.y) * (1 - pull);
      }
      if (moveOut) {
        ox = p.x + (a.ox - a.x) * (1 - pull);
        oy = p.y + (a.oy - a.y) * (1 - pull);
      }
    } else if (op === 'wrinkle') {
      if (moveIn) {
        const q = movePoint(op, brush, ix, iy, w, k, params, rand);
        ix = q.x;
        iy = q.y;
      }
      if (moveOut) {
        const q = movePoint(op, brush, ox, oy, w, k, params, rand);
        ox = q.x;
        oy = q.y;
      }
    }
    return { x: p.x, y: p.y, ix, iy, ox, oy };
  });
  return changed ? out : anchors;
}

/** Segment length used for densifying: a higher Detail adds more anchors. */
export function detailLength(brush, detail = 2) {
  const r = Math.min(brush.w, brush.h) / 2;
  const d = Math.max(1, Math.min(10, detail));
  return Math.max(0.5, r / (1.5 + d * 1.5));
}

/**
 * Remove redundant anchors within `tolerance` (document units), as the
 * Simplify option does after a stroke: a smooth anchor (or a straight
 * point between two collinear lines) is dropped when one cubic through its
 * neighbors stays within the tolerance of the two segments it replaces.
 * Corners and anchors that shape the path are kept. With a `region`
 * ({ x, y, w, h }, the area a stroke covered) only anchors inside it are
 * removed, so geometry the stroke never reached is not changed.
 */
export function simplifyAnchors(anchors, closed, tolerance, region = null) {
  if (anchors.length < 3 || !(tolerance > 0)) return anchors;
  const total = anchors.length;
  // Sample points of every original segment, so each merge is checked
  // against the geometry it replaces, not against earlier merges.
  const samples = [];
  for (let i = 0; i < segmentCount(anchors, closed); i++) {
    const c = segmentPoints(anchors, i);
    const list = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const mt = 1 - t;
      list.push({ x: mt ** 3 * c[0] + 3 * mt * mt * t * c[2] + 3 * mt * t * t * c[4] + t ** 3 * c[6], y: mt ** 3 * c[1] + 3 * mt * mt * t * c[3] + 3 * mt * t * t * c[5] + t ** 3 * c[7] });
    }
    samples.push(list);
  }
  const between = (from, to) => {
    const out = [];
    for (let i = from; i !== to; i = (i + 1) % total) out.push(...samples[i]);
    return out;
  };
  let pts = anchors.map((a, idx) => ({ a, idx }));
  let changed = false;
  for (let pass = 0; pass < 8; pass++) {
    let removed = false;
    for (let i = closed ? 0 : 1; i < (closed ? pts.length : pts.length - 1) && pts.length > (closed ? 3 : 2); i++) {
      const n = pts.length;
      const P = pts[(i - 1 + n) % n];
      const A = pts[i];
      const Q = pts[(i + 1) % n];
      if (region && !(A.a.x >= region.x && A.a.x <= region.x + region.w && A.a.y >= region.y && A.a.y <= region.y + region.h)) continue;
      const merged = mergeAt(P.a, A.a, Q.a, tolerance, between(P.idx, Q.idx));
      if (!merged) continue;
      pts[(i - 1 + n) % n] = { a: merged.p, idx: P.idx };
      pts[(i + 1) % n] = { a: merged.q, idx: Q.idx };
      pts.splice(i, 1);
      i--;
      removed = changed = true;
    }
    if (!removed) break;
  }
  return changed ? pts.map((p) => p.a) : anchors;
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

/** One cubic replacing segments p→a→q, or null when it would not fit. */
function mergeAt(p, a, q, tol, original) {
  const inX = a.x - a.ix;
  const inY = a.y - a.iy;
  const outX = a.ox - a.x;
  const outY = a.oy - a.y;
  const li = Math.hypot(inX, inY);
  const lo = Math.hypot(outX, outY);
  const c1 = [p.x, p.y, p.ox, p.oy, a.ix, a.iy, a.x, a.y];
  const c2 = [a.x, a.y, a.ox, a.oy, q.ix, q.iy, q.x, q.y];
  const L1 = isLine(c1) ? Math.hypot(a.x - p.x, a.y - p.y) : cubicLength(c1, tol / 4);
  const L2 = isLine(c2) ? Math.hypot(q.x - a.x, q.y - a.y) : cubicLength(c2, tol / 4);
  if (L1 < 1e-9 || L2 < 1e-9) return { p, q };
  let np = p;
  let nq = q;
  if (li < 1e-9 && lo < 1e-9) {
    // A straight point: removable only between two lines.
    if (!isLine(c1) || !isLine(c2)) return null;
  } else {
    // A corner (handles not collinear) is kept.
    if (li < 1e-9 || lo < 1e-9 || Math.abs(cross(inX / li, inY / li, outX / lo, outY / lo)) > 0.05 || inX * outX + inY * outY < 0) return null;
    // Scale the outer handles so the merged curve spans both segments.
    const s1 = (L1 + L2) / L1;
    const s2 = (L1 + L2) / L2;
    np = { ...p, ox: p.x + (p.ox - p.x) * s1, oy: p.y + (p.oy - p.y) * s1 };
    nq = { ...q, ix: q.x + (q.ix - q.x) * s2, iy: q.y + (q.iy - q.y) * s2 };
  }
  const cand = flattenPath([np, nq], false, tol / 4);
  const near = (x, y) => {
    let best = Infinity;
    for (let k = 1; k < cand.length; k++) {
      const u = cand[k - 1];
      const v = cand[k];
      const dx = v.x - u.x;
      const dy = v.y - u.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - u.x) * dx + (y - u.y) * dy) / len2));
      best = Math.min(best, Math.hypot(x - u.x - t * dx, y - u.y - t * dy));
    }
    return best;
  };
  for (const pt of original) if (near(pt.x, pt.y) > tol) return null;
  return { p: np, q: nq };
}
