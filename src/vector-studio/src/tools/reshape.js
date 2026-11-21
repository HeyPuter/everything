/**
 * Redrawing part of a selected path with a freehand stroke (the Pencil and
 * Paintbrush "Edit selected paths" option).
 *
 * A stroke that starts on a selected path changes only the stretch it
 * redraws; the rest of the path keeps its anchors exactly:
 *
 *  - start and end on the path: the stretch between the two points is
 *    replaced (on a closed path, the side of it the stroke runs along);
 *  - start on the path and end away from it: the path is redrawn from the
 *    start point on, toward the end the stroke heads for, and the other
 *    side is kept;
 *  - start at an end of an open path and end away from it: the path is
 *    continued; end at its other end and it is closed (or redrawn whole
 *    when the stroke runs along it rather than across the gap).
 *
 * The stroke's ends are drawn onto the path, so the new stretch starts and
 * ends exactly on it (the pen is rarely exactly on the line), and where the
 * stroke meets the path at a shallow angle it is fitted to carry on in the
 * path's direction, so a redrawn stretch flows into the rest instead of
 * kinking; a stroke meeting it at a steep angle makes a corner.
 *
 * A plan also says where every part of the new path came from, so values
 * stored along the path by length (pen pressure, drawing speed, the width
 * profile) stay with the parts that were kept, follow the new stroke's own
 * values where it has some, and blend across the redrawn stretch where it
 * has none.
 */
import { nearestOnPath, nearestOnCubic, insertAnchor, segmentPoints, derivativeAt, split, cubicLength, pointAt } from '../model/bezier.js';
import { fitStroke } from './corners.js';

const EPS = 1e-6;

/** Joints between a kept stretch and the new one turning by less than this (degrees) are made smooth. */
export const SMOOTH_JOINT_DEG = 35;

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** Nearest point of a path: { u: global position (segment index + t), x, y, d } or null. */
export function locate(anchors, closed, x, y) {
  const n = nearestOnPath(anchors, closed, x, y);
  return n ? { u: n.index + n.t, x: n.x, y: n.y, d: n.d } : null;
}

/** A closed path as an open anchor list ending on a copy of its first anchor (same segments, same positions). */
function unrolled(anchors, times = 1) {
  const out = [];
  for (let k = 0; k < times; k++) for (const a of anchors) out.push({ ...a });
  out.push({ ...anchors[0] });
  return out;
}

/** Segment lengths of an open anchor list. */
function segLengths(list) {
  const out = [];
  for (let i = 0; i + 1 < list.length; i++) out.push(cubicLength(segmentPoints(list, i)));
  return out;
}

/** Length along an open anchor list up to global position u. */
function lengthTo(list, lens, u) {
  const i = Math.min(lens.length - 1, Math.max(0, Math.floor(u)));
  const t = Math.min(1, Math.max(0, u - i));
  let s = 0;
  for (let k = 0; k < i; k++) s += lens[k];
  if (t >= 1 - EPS) return s + lens[i];
  if (t > EPS) s += cubicLength(split(segmentPoints(list, i), t)[0]);
  return s;
}

/**
 * Point and unit tangent (the way the list runs) of an open anchor list at
 * global position u; at an anchor, `side` 'in' takes the direction arriving
 * there and 'out' the one leaving. The tangent is null where there is none.
 */
function frameAt(list, u, side = 'out') {
  const segs = list.length - 1;
  let i = Math.min(segs - 1, Math.max(0, Math.floor(u)));
  if (side === 'in' && i > 0 && u - i <= EPS) i--;
  const t = Math.min(1, Math.max(0, u - i));
  const c = segmentPoints(list, i);
  let d = derivativeAt(c, t);
  if (Math.hypot(d.x, d.y) < EPS) d = { x: c[6] - c[0], y: c[7] - c[1] };
  const len = Math.hypot(d.x, d.y);
  return { p: pointAt(c, t), tan: len > EPS ? { x: d.x / len, y: d.y / len } : null };
}

/**
 * The part of an open anchor list from global position u0 to u1 (u0 <= u1),
 * cut exactly: its first anchor has no in-handle, its last no out-handle.
 */
export function span(list, u0, u1) {
  const segs = list.length - 1;
  const clamp = (u) => Math.min(segs, Math.max(0, u));
  u0 = clamp(u0);
  u1 = clamp(u1);
  // Cut at the later position first so the earlier one keeps its index. When both fall in one
  // segment the earlier cut is found again by its point on the shortened segment (cutting a
  // straight segment changes how its parameter runs, so scaling t would miss it).
  const cut = (lst, u) => {
    const i = Math.min(segs - 1, Math.floor(u));
    const t = u - i;
    if (t <= EPS) return { list: lst, k: i };
    if (t >= 1 - EPS) return { list: lst, k: i + 1 };
    return { list: insertAnchor(lst, false, i, t), k: i + 1 };
  };
  const hi = cut(list, u1);
  const i1 = Math.min(segs - 1, Math.floor(u1));
  const i0 = Math.min(segs - 1, Math.floor(u0));
  const t1 = u1 - i1;
  let lo;
  if (i0 === i1 && t1 > EPS && t1 < 1 - EPS && u0 - i0 > EPS) {
    const p = pointAt(segmentPoints(list, i0), u0 - i0);
    const t = nearestOnCubic(segmentPoints(hi.list, i0), p.x, p.y).t;
    lo = t <= EPS ? { list: hi.list, k: i0 } : t >= 1 - EPS ? { list: hi.list, k: i0 + 1 } : { list: insertAnchor(hi.list, false, i0, t), k: i0 + 1 };
  } else lo = cut(hi.list, u0);
  const kHi = hi.k + (lo.list.length - hi.list.length);
  const out = lo.list.slice(lo.k, kHi + 1).map((a) => ({ ...a }));
  out[0] = { ...out[0], ix: out[0].x, iy: out[0].y };
  out[out.length - 1] = { ...out[out.length - 1], ox: out[out.length - 1].x, oy: out[out.length - 1].y };
  return out;
}

/**
 * Stroke points moved so they start at `from` and end at `to` (either may be
 * null to leave that end), easing the shift out over a short distance so the
 * stroke bends onto the path rather than jumping.
 */
export function drawOnto(points, from, to, reach) {
  const n = points.length;
  if (n < 2) return points.slice();
  const arc = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + dist(points[i - 1], points[i]));
  const L = arc[n - 1];
  const ease = (x) => (x >= 1 ? 0 : 1 - x * x * (3 - 2 * x));
  const out = points.map((p) => ({ ...p }));
  const shift = (target, endIndex, along) => {
    if (!target) return;
    const dx = target.x - points[endIndex].x;
    const dy = target.y - points[endIndex].y;
    const d = Math.hypot(dx, dy);
    if (d < EPS) return;
    const blend = Math.max(EPS, Math.min(L * 0.45, Math.max(reach, d * 4)));
    for (let i = 0; i < n; i++) {
      const w = ease(along(i) / blend);
      if (w <= 0) continue;
      out[i].x += dx * w;
      out[i].y += dy * w;
    }
  };
  shift(from, 0, (i) => arc[i]);
  shift(to, n - 1, (i) => L - arc[i]);
  if (from) out[0] = { ...out[0], x: from.x, y: from.y };
  if (to) out[n - 1] = { ...out[n - 1], x: to.x, y: to.y };
  return out;
}

/** Distance from a point to a polyline. */
function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const l2 = vx * vx + vy * vy;
    const t = l2 > EPS ? Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
    best = Math.min(best, Math.hypot(a.x + vx * t - p.x, a.y + vy * t - p.y));
  }
  return pts.length === 1 ? dist(p, pts[0]) : best;
}

/** Stroke points thinned to at least `step` apart (ends kept), for distance tests. */
function thinned(points, step) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) if (dist(out[out.length - 1], points[i]) >= step) out.push(points[i]);
  if (points.length > 1) out.push(points[points.length - 1]);
  return out;
}

/** How far, on average, the points of a stretch of path (u0..u1 of an open list) lie from the stroke. */
function coverage(list, u0, u1, stroke) {
  const N = 24;
  let sum = 0;
  for (let k = 0; k <= N; k++) sum += distToPolyline(frameAt(list, u0 + ((u1 - u0) * k) / N).p, stroke);
  return sum / (N + 1);
}

/**
 * Plan the redraw of one path by a stroke, or null when the stroke does not
 * edit it (then it makes a new path).
 *
 * path: { anchors, closed }; points: the stroke as drawn; reach: how near
 * the path (document units) the stroke must start or end to count as on
 * it; edit: false allows only continuing an open path from an end (within
 * `endReach`).
 *
 * The plan: { start: distance from the stroke start to the path, both:
 * whether the stroke ends on the path too, kind, closed, chain }. The chain
 * lists the parts of the new path in order: { keep: [u0, u1] } (a stretch of
 * the original, u in the original's global positions; on a closed path u1
 * may run past the end, wrapping round) or { stroke: true, reversed }.
 */
export function planReshape(path, points, { reach, endReach = reach, edit = true } = {}) {
  const { anchors, closed } = path;
  if (!anchors || anchors.length < 2 || points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const N = anchors.length;
  if (closed) {
    if (!edit) return null;
    const list = unrolled(anchors);
    const a = locate(list, false, first.x, first.y);
    const b = locate(list, false, last.x, last.y);
    if (!a || a.d > reach || !b || b.d > reach) return null;
    // Two stretches join the points: replace the one the stroke runs along.
    const stroke = thinned(points, reach / 2);
    const fwd = b.u >= a.u ? [a.u, b.u] : [a.u, b.u + N];
    const back = a.u > b.u ? [b.u, a.u] : [b.u, a.u + N];
    const list2 = unrolled(anchors, 2);
    const replaceFwd = coverage(list2, fwd[0], fwd[1], stroke) <= coverage(list2, back[0], back[1], stroke);
    // Keep the other stretch; the stroke runs from the kept stretch's end back to its start.
    const keep = replaceFwd ? back : fwd;
    return { start: a.d, both: true, kind: 'replace', closed: true, a, b, chain: [{ keep }, { stroke: true, reversed: !replaceFwd }] };
  }
  const S = N - 1;
  const endNear = (p, r) => {
    const d0 = dist(p, anchors[0]);
    const d1 = dist(p, anchors[S]);
    if (Math.min(d0, d1) > r) return null;
    return d1 <= d0 ? { end: 'end', d: d1, u: S } : { end: 'start', d: d0, u: 0 };
  };
  const continueFrom = (from, start) =>
    from.end === 'end'
      ? { start, both: false, kind: 'continue', closed: false, chain: [{ keep: [0, S] }, { stroke: true, reversed: false }] }
      : { start, both: false, kind: 'continue', closed: false, chain: [{ stroke: true, reversed: true }, { keep: [0, S] }] };
  if (!edit) {
    const from = endNear(first, endReach);
    return from ? continueFrom(from, from.d) : null;
  }
  const a = locate(anchors, false, first.x, first.y);
  if (!a) return null;
  const startEnd = endNear(first, reach);
  if (a.d > reach && !startEnd) return null;
  const b0 = locate(anchors, false, last.x, last.y);
  const b = b0 && b0.d <= reach ? b0 : null;
  const finishEnd = endNear(last, reach);
  const start = startEnd ? Math.min(a.d, startEnd.d) : a.d;
  // From an end and away from the path (or back round to the same end): continue the path.
  if (startEnd && (!b || finishEnd?.end === startEnd.end)) return continueFrom(startEnd, start);
  if (startEnd && finishEnd && finishEnd.end !== startEnd.end) {
    // End to end: across the gap closes the path, along it redraws the whole path.
    const stroke = thinned(points, reach / 2);
    const gap = [anchors[S], anchors[0]];
    let gapDist = 0;
    for (let k = 0; k <= 24; k++) gapDist += distToPolyline({ x: gap[0].x + ((gap[1].x - gap[0].x) * k) / 24, y: gap[0].y + ((gap[1].y - gap[0].y) * k) / 24 }, stroke);
    gapDist /= 25;
    if (gapDist < coverage(anchors, 0, S, stroke)) {
      return { start, both: true, kind: 'close', closed: true, chain: [{ keep: [0, S] }, { stroke: true, reversed: startEnd.end === 'start' }] };
    }
    const reversed = startEnd.end === 'end';
    return { start, both: true, kind: 'replace', closed: false, chain: [{ keep: [0, 0] }, { stroke: true, reversed }, { keep: [S, S] }] };
  }
  // A stroke starting or ending by an end of the path starts or ends right at it.
  const ua = startEnd ? startEnd.u : a.u;
  if (b) {
    const ub = finishEnd ? finishEnd.u : b.u;
    const [lo, hi] = ua <= ub ? [ua, ub] : [ub, ua];
    return { start, both: true, kind: 'replace', closed: false, chain: [{ keep: [0, lo] }, { stroke: true, reversed: ua > ub }, { keep: [hi, S] }] };
  }
  // From the middle of the path and away from it: redraw toward the end the stroke heads for.
  const forward = headsForward(anchors, points, ua, reach);
  return forward
    ? { start, both: false, kind: 'redraw', closed: false, chain: [{ keep: [0, ua] }, { stroke: true, reversed: false }] }
    : { start, both: false, kind: 'redraw', closed: false, chain: [{ stroke: true, reversed: true }, { keep: [ua, S] }] };
}

/**
 * Whether a stroke leaving an open path at u heads toward the path's last
 * anchor: where it ran along the path before leaving it, else the way it
 * set off compared with the path's direction there, else (straight off the
 * path) toward the shorter side, so the least is redrawn.
 */
function headsForward(anchors, points, u, reach) {
  const lens = segLengths(anchors);
  const at = lengthTo(anchors, lens, u);
  let far = at;
  for (const p of thinned(points, reach / 3)) {
    const q = locate(anchors, false, p.x, p.y);
    if (!q || q.d > reach) break;
    far = lengthTo(anchors, lens, q.u);
  }
  if (Math.abs(far - at) > reach) return far > at;
  const k = points.findIndex((p) => dist(p, points[0]) > reach);
  const off = points[k < 0 ? points.length - 1 : k];
  const dx = off.x - points[0].x;
  const dy = off.y - points[0].y;
  const len = Math.hypot(dx, dy);
  const { tan } = frameAt(anchors, u);
  if (tan && len > EPS) {
    const cos = (dx * tan.x + dy * tan.y) / len;
    if (Math.abs(cos) > 0.3) return cos > 0;
  }
  const total = lens.reduce((s, l) => s + l, 0);
  return total - at < at;
}

/**
 * Carry out a plan: the new anchors and, for remapping values stored along
 * the path, the parts of the new path in order with their lengths.
 *
 * points/corners: the stroke and its corner indices; fit: { error,
 * simplify } for fitting it; reach: for drawing its ends onto the path.
 */
export function applyReshape(path, plan, points, corners, { error, simplify, reach }) {
  const { anchors } = path;
  const N = anchors.length;
  const source = path.closed ? unrolled(anchors, 2) : anchors;
  const lens = segLengths(source);
  const oldLength = path.closed ? lens.slice(0, N).reduce((s, l) => s + l, 0) : lens.reduce((s, l) => s + l, 0);
  const chain = plan.chain;
  const k = chain.findIndex((c) => c.stroke);
  const reversed = chain[k].reversed;
  // The stroke oriented the way the path runs, with its ends drawn onto the kept stretches.
  let pts = reversed ? points.slice().reverse() : points;
  let crn = reversed ? corners.map((i) => points.length - 1 - i).reverse() : corners;
  const prev = chain[k - 1] || (plan.closed ? chain[chain.length - 1] : null);
  const next = chain[k + 1] || (plan.closed ? chain[0] : null);
  const from = prev && frameAt(source, prev.keep[1], 'in');
  const to = next && frameAt(source, next.keep[0], 'out');
  pts = drawOnto(pts, from?.p, to?.p, reach);
  // Where the stroke meets the path at a shallow angle it carries on in the path's direction.
  const tangents = {
    start: from?.tan && shallow(from.tan, departure(pts, reach, 1)) ? from.tan : undefined,
    end: to?.tan && shallow(to.tan, departure(pts, reach, -1)) ? to.tan : undefined,
  };
  let fresh = fitStroke(pts, crn, error, simplify, tangents);
  if (from) fresh[0] = { ...fresh[0], x: from.p.x, y: from.p.y, ix: from.p.x, iy: from.p.y };
  if (to) fresh[fresh.length - 1] = { ...fresh[fresh.length - 1], x: to.p.x, y: to.p.y, ox: to.p.x, oy: to.p.y };
  // The pieces, each starting where the one before ends.
  const lists = chain.map((c) => (c.stroke ? fresh : span(source, c.keep[0], c.keep[1])));
  const out = [];
  lists.forEach((list, i) => {
    if (!out.length) {
      out.push(...list.map((a) => ({ ...a })));
      return;
    }
    const j = out.length - 1;
    const head = list[0];
    const joint = out[j];
    out[j] = { ...joint, ox: head.ox - head.x + joint.x, oy: head.oy - head.y + joint.y };
    for (let m = 1; m < list.length; m++) out.push({ ...list[m] });
  });
  let closed = false;
  if (plan.closed && out.length > 2) {
    const tail = out.pop();
    out[0] = { ...out[0], ix: tail.ix - tail.x + out[0].x, iy: tail.iy - tail.y + out[0].y };
    closed = true;
  }
  // The pieces' lengths in the new path, and where kept pieces were in the old one.
  const pieces = chain.map((c, i) => {
    const len = segLengths(lists[i]).reduce((s, l) => s + l, 0);
    if (c.stroke) return { stroke: true, reversed, len };
    return { keep: true, s0: lengthTo(source, lens, c.keep[0]), s1: lengthTo(source, lens, c.keep[1]), len };
  });
  return { anchors: out, closed, pieces, oldLength, oldClosed: Boolean(path.closed) };
}

/**
 * The direction a stroke sets off in from its first point (dir 1) or arrives
 * at its last (dir -1, still given the way the stroke runs): toward the first
 * point a little way along it.
 */
function departure(points, reach, dir) {
  const n = points.length;
  const at = dir > 0 ? 0 : n - 1;
  const p = points[at];
  let q = points[dir > 0 ? n - 1 : 0];
  for (let i = at + dir; i >= 0 && i < n; i += dir) {
    if (dist(points[i], p) >= reach * 1.5) {
      q = points[i];
      break;
    }
  }
  const v = dir > 0 ? { x: q.x - p.x, y: q.y - p.y } : { x: p.x - q.x, y: p.y - q.y };
  const len = Math.hypot(v.x, v.y);
  return len > EPS ? { x: v.x / len, y: v.y / len } : null;
}

/** Whether two unit directions differ by less than SMOOTH_JOINT_DEG. */
function shallow(a, b) {
  return Boolean(a && b) && a.x * b.x + a.y * b.y > Math.cos((SMOOTH_JOINT_DEG * Math.PI) / 180);
}

/**
 * Values stored along a path by length (rows [t, ...values], t 0..1 of the
 * length) remapped onto a reshaped path: the kept parts keep theirs, the new
 * stretch takes the stroke's own rows (t along the stroke as drawn) when
 * given, else blends from the value where it leaves the old path to the
 * value where it rejoins it. `fallback` stands in for a path with no rows.
 * Returns null when there is nothing to keep.
 */
export function remapAlong(result, rows, strokeRows, fallback) {
  const hasOld = Array.isArray(rows) && rows.length > 0;
  const hasNew = Array.isArray(strokeRows) && strokeRows.length > 0;
  if (!hasOld && !hasNew) return null;
  const old = hasOld ? rows.slice().sort((p, q) => p[0] - q[0]) : [[0, ...fallback], [1, ...fallback]];
  const L = result.oldLength;
  const valueAt = (s) => {
    let t = L > EPS ? s / L : 0;
    if (result.oldClosed) t -= Math.floor(t);
    t = Math.min(1, Math.max(0, t));
    if (t <= old[0][0]) return old[0].slice(1);
    for (let i = 1; i < old.length; i++) {
      if (t <= old[i][0]) {
        const [t0, ...v0] = old[i - 1];
        const [t1, ...v1] = old[i];
        const f = (t - t0) / Math.max(EPS, t1 - t0);
        return v0.map((v, k) => v + (v1[k] - v) * f);
      }
    }
    return old[old.length - 1].slice(1);
  };
  const pieces = result.pieces;
  const total = pieces.reduce((s, p) => s + p.len, 0);
  if (!(total > EPS)) return null;
  const out = [];
  let offset = 0;
  pieces.forEach((p, i) => {
    if (p.keep) {
      out.push([offset, ...valueAt(p.s0)]);
      // Old rows inside the kept stretch (on a closed path also those a lap on).
      for (const lap of result.oldClosed ? [0, L, 2 * L] : [0]) {
        for (const r of old) {
          const s = r[0] * L + lap;
          if (s > p.s0 + EPS && s < p.s1 - EPS) out.push([offset + s - p.s0, ...r.slice(1)]);
        }
      }
      out.push([offset + p.len, ...valueAt(p.s1)]);
    } else if (hasNew) {
      const sorted = strokeRows.slice().sort((x, y) => x[0] - y[0]);
      const rowsHere = p.reversed ? sorted.map((r) => [1 - r[0], ...r.slice(1)]).reverse() : sorted;
      for (const r of rowsHere) out.push([offset + r[0] * p.len, ...r.slice(1)]);
    } else {
      const before = pieces[i - 1] || (result.closed ? pieces[pieces.length - 1] : null);
      const after = pieces[i + 1] || (result.closed ? pieces[0] : null);
      const v0 = before?.keep ? valueAt(before.s1) : after?.keep ? valueAt(after.s0) : fallback;
      const v1 = after?.keep ? valueAt(after.s0) : v0;
      out.push([offset, ...v0], [offset + p.len, ...v1]);
    }
    offset += p.len;
  });
  const rows2 = out.map(([s, ...v]) => [Math.min(1, Math.max(0, s / total)), ...v]);
  // Drop rows that repeat the one before (the joints between pieces).
  return rows2.filter((r, i) => i === 0 || Math.abs(r[0] - rows2[i - 1][0]) > 1e-4 || r.some((v, k) => k > 0 && Math.abs(v - rows2[i - 1][k]) > 1e-4));
}

