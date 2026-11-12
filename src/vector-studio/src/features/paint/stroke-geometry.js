/**
 * Stroke geometry for the Stroke panel: arrowheads and corner-aligned
 * dashes.
 *
 * Arrowheads are original shapes defined for a 1 pt stroke in a local frame
 * whose tip is at the origin pointing along +x. `attach` (<= 0) is where the
 * path should meet the arrowhead. With align 'beyond' (extend the tip past
 * the end of the path) the attach point sits on the path end; with 'end'
 * (place the tip at the end of the path) the tip sits on the path end and
 * the stroked path is trimmed back to the attach point so it does not poke
 * through the arrowhead.
 *
 * Arrowhead settings on a node: arrowStart / arrowEnd =
 *   { shape: 'arrow' | ..., scale: 100, align: 'beyond' | 'end' } or null.
 */
import { segmentCount, segmentPoints, derivativeAt, isLine, split, cubicLength, pathLength, anchor } from '../../model/bezier.js';
import { KAPPA } from '../../model/shapes.js';

const poly = (...pts) => ({ pts });
const circle = (cx, cy, r, reverse = false) => ({ circle: { cx, cy, r, reverse } });
const S2 = Math.SQRT1_2;

/** Original arrowhead set: id -> { label, contours, attach }. Units: stroke widths. */
export const ARROWHEADS = {
  arrow: { label: 'Arrow', attach: -3.2, contours: [poly([0, 0], [-5, -2.6], [-3.6, 0], [-5, 2.6])] },
  triangle: { label: 'Triangle', attach: -4, contours: [poly([0, 0], [-4.5, -2.3], [-4.5, 2.3])] },
  'triangle-wide': { label: 'Wide Triangle', attach: -3.5, contours: [poly([0, 0], [-4, -3.5], [-4, 3.5])] },
  barbed: { label: 'Barbed Arrow', attach: -4.2, contours: [poly([0, 0], [-6.5, -3.6], [-4.6, 0], [-6.5, 3.6])] },
  open: {
    label: 'Open Arrow',
    attach: -0.9,
    contours: [poly([S2, 0], [S2 - 3.6, -3.6], [-3.6, -3.6 + S2], [-S2, 0], [-3.6, 3.6 - S2], [S2 - 3.6, 3.6])],
  },
  circle: { label: 'Circle', attach: -2, contours: [circle(-2, 0, 2)] },
  'circle-open': { label: 'Open Circle', attach: -2.6, contours: [circle(-2, 0, 2), circle(-2, 0, 1.25, true)] },
  square: { label: 'Square', attach: -2, contours: [poly([0, -2], [0, 2], [-4, 2], [-4, -2])] },
  diamond: { label: 'Diamond', attach: -2.6, contours: [poly([0, 0], [-2.6, -2.2], [-5.2, 0], [-2.6, 2.2])] },
  bar: { label: 'Bar', attach: -0.5, contours: [poly([0, -3], [0, 3], [-1, 3], [-1, -3])] },
  'half-arrow': { label: 'Half Arrow', attach: -3.6, contours: [poly([0, 0], [-5, -2.8], [-3.6, 0])] },
};

export const ARROWHEAD_IDS = Object.keys(ARROWHEADS);

function contourAnchors(c) {
  if (c.pts) return c.pts.map(([x, y]) => anchor(x, y));
  const { cx, cy, r, reverse } = c.circle;
  const k = r * KAPPA;
  // Clockwise on screen (y down): right, bottom, left, top.
  let a = [
    anchor(cx + r, cy, cx + r, cy - k, cx + r, cy + k),
    anchor(cx, cy + r, cx + k, cy + r, cx - k, cy + r),
    anchor(cx - r, cy, cx - r, cy + k, cx - r, cy - k),
    anchor(cx, cy - r, cx - k, cy - r, cx + k, cy - r),
  ];
  if (reverse) a = a.reverse().map((p) => ({ ...p, ix: p.ox, iy: p.oy, ox: p.ix, oy: p.iy }));
  return a;
}

/** End point and outward unit direction at a path end ('start' | 'end'). */
export function endFrame(anchors, which) {
  const n = segmentCount(anchors, false);
  if (n < 1) return null;
  if (which === 'end') {
    const c = segmentPoints(anchors, n - 1);
    let d = derivativeAt(c, 1);
    if (Math.hypot(d.x, d.y) < 1e-9) d = { x: c[6] - c[0], y: c[7] - c[1] };
    const l = Math.hypot(d.x, d.y);
    if (l < 1e-9) return null;
    return { x: c[6], y: c[7], dx: d.x / l, dy: d.y / l };
  }
  const c = segmentPoints(anchors, 0);
  let d = derivativeAt(c, 0);
  if (Math.hypot(d.x, d.y) < 1e-9) d = { x: c[6] - c[0], y: c[7] - c[1] };
  const l = Math.hypot(d.x, d.y);
  if (l < 1e-9) return null;
  return { x: c[0], y: c[1], dx: -d.x / l, dy: -d.y / l };
}

/** Arrowhead contours in document space for one end: [{ anchors, closed: true }]. */
export function arrowheadContours(anchors, which, spec, strokeWidth) {
  const def = spec && ARROWHEADS[spec.shape];
  if (!def) return [];
  const f = endFrame(anchors, which);
  if (!f) return [];
  const s = Math.max(strokeWidth, 0.0001) * ((spec.scale ?? 100) / 100);
  const shift = spec.align === 'end' ? 0 : -def.attach;
  const nx = -f.dy;
  const ny = f.dx;
  const map = (lx, ly) => {
    const u = (lx + shift) * s;
    const v = ly * s;
    return { x: f.x + f.dx * u + nx * v, y: f.y + f.dy * u + ny * v };
  };
  return def.contours.map((c) => ({
    closed: true,
    anchors: contourAnchors(c).map((a) => {
      const p = map(a.x, a.y);
      const i = map(a.ix, a.iy);
      const o = map(a.ox, a.oy);
      return { x: p.x, y: p.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y };
    }),
  }));
}

/** All arrowhead contours of an open path node. */
export function nodeArrowheads(node) {
  if (node.type !== 'path' || node.closed || node.anchors.length < 2 || !(node.strokeWidth > 0) || !node.stroke) return [];
  return [...arrowheadContours(node.anchors, 'start', node.arrowStart, node.strokeWidth), ...arrowheadContours(node.anchors, 'end', node.arrowEnd, node.strokeWidth)];
}

/** How far to trim each end of the stroked path (document units). */
export function arrowTrim(node) {
  const t = { start: 0, end: 0 };
  for (const [which, spec] of [['start', node.arrowStart], ['end', node.arrowEnd]]) {
    const def = spec && ARROWHEADS[spec.shape];
    if (!def || spec.align !== 'end') continue;
    t[which] = -def.attach * node.strokeWidth * ((spec.scale ?? 100) / 100);
  }
  return t;
}

/** Shorten an open anchor list by distances at its start and end. */
export function trimAnchors(anchors, startD, endD) {
  let a = anchors.map((p) => ({ ...p }));
  if (endD > 0) a = trimEnd(a, endD);
  if (startD > 0 && a.length >= 2) {
    const rev = a.slice().reverse().map((p) => ({ ...p, ix: p.ox, iy: p.oy, ox: p.ix, oy: p.iy }));
    a = trimEnd(rev, startD)
      .reverse()
      .map((p) => ({ ...p, ix: p.ox, iy: p.oy, ox: p.ix, oy: p.iy }));
  }
  return a;
}

function trimEnd(a, d) {
  let left = d;
  while (a.length >= 2) {
    const c = segmentPoints(a, a.length - 2);
    const len = cubicLength(c);
    if (len > left + 1e-9) {
      if (isLine(c)) {
        // Straight segments: move the end point along the chord (Bezier parameters are not uniform here).
        const f = (len - left) / len;
        const x = c[0] + (c[6] - c[0]) * f;
        const y = c[1] + (c[7] - c[1]) * f;
        a[a.length - 1] = { ...a[a.length - 1], x, y, ix: x, iy: y, ox: x, oy: y };
        return a;
      }
      const t = paramAtLength(c, len - left);
      const [l] = split(c, t);
      const p = a[a.length - 2];
      a[a.length - 2] = { ...p, ox: l[2], oy: l[3] };
      a[a.length - 1] = { ...a[a.length - 1], x: l[6], y: l[7], ix: l[4], iy: l[5], ox: l[6], oy: l[7] };
      return a;
    }
    // The whole last segment is consumed.
    left -= len;
    a.pop();
    if (a.length < 2) break;
    const last = a[a.length - 1];
    a[a.length - 1] = { ...last, ox: last.x, oy: last.y };
  }
  return a;
}

/** Parameter t where the arc length from the segment start reaches `target`. */
function paramAtLength(c, target) {
  if (isLine(c)) {
    const len = Math.hypot(c[6] - c[0], c[7] - c[1]);
    return len > 0 ? target / len : 0;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const [l] = split(c, mid);
    if (cubicLength(l, 0.02) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Dashes aligned to corners and path ends (approximation): the dash pattern
 * is stretched so a whole number of repeats fits the path, and offset by
 * half a dash so dashes are centered on the path's start (and, for closed
 * paths with equal sides, on every corner).
 */
export function alignedDash(dash, length, closed) {
  if (!dash || !dash.length || !(length > 0)) return null;
  const pattern = dash.length % 2 ? [...dash, ...dash] : dash;
  const P = pattern.reduce((a, b) => a + b, 0);
  if (!(P > 0)) return null;
  // Open paths: the pattern starts and ends with half a dash.
  const usable = closed ? length : length + pattern[0];
  const n = Math.max(1, Math.round(usable / P));
  const k = usable / (n * P);
  const scaled = pattern.map((v) => v * k);
  return { dash: scaled, offset: scaled[0] / 2 };
}

/** Unit tangent of cubic `c` at t (0 or 1), falling back to the chord for degenerate handles. */
function tangent(c, t) {
  let d = derivativeAt(c, t);
  if (Math.hypot(d.x, d.y) < 1e-9) d = { x: c[6] - c[0], y: c[7] - c[1] };
  const l = Math.hypot(d.x, d.y);
  return l < 1e-9 ? null : { x: d.x / l, y: d.y / l };
}

/**
 * Dashes aligned to the corners and ends of a path: each stretch between
 * corners (anchors where the direction turns) gets its own whole number of
 * repeats, stretched to fit, with half a dash at both ends, so a dash is
 * centered on every corner and path end and turns the corner as one dash.
 * Smooth anchors do not break a stretch, and a path without corners fits
 * its repeats around its whole length. Returns { dash, offset } for the
 * whole path, or null.
 */
export function cornerAlignedDash(dash, anchors, closed) {
  if (!dash || !dash.length || !anchors || anchors.length < 2) return null;
  const pattern = dash.length % 2 ? [...dash, ...dash] : dash;
  const P = pattern.reduce((a, b) => a + b, 0);
  if (!(P > 0) || !pattern.every((v) => v >= 0 && Number.isFinite(v))) return null;
  const n = segmentCount(anchors, closed);
  const segs = [];
  for (let i = 0; i < n; i++) {
    const c = segmentPoints(anchors, i);
    const len = cubicLength(c);
    if (len > 1e-9) segs.push({ len, t0: tangent(c, 0), t1: tangent(c, 1) });
  }
  const total = segs.reduce((a, g) => a + g.len, 0);
  if (!(total > 0)) return null;
  // A corner between consecutive segments turns by more than about a degree.
  const corner = (a, b) => !a.t1 || !b.t0 || a.t1.x * b.t0.x + a.t1.y * b.t0.y < 0.9998;
  const breaks = [];
  for (let i = closed ? 0 : 1; i < segs.length; i++) {
    if (corner(segs[(i - 1 + segs.length) % segs.length], segs[i])) breaks.push(i);
  }
  if (closed && !breaks.length) return alignedDash(dash, total, true);
  // Stretch lengths from the first break (an open path starts at its start).
  const first = closed ? breaks[0] : 0;
  const starts = closed ? breaks : [0, ...breaks];
  const runs = [];
  for (let b = 0; b < starts.length; b++) {
    const from = starts[b];
    const to =
      b + 1 < starts.length ? starts[b + 1] : closed ? starts[0] + segs.length : segs.length;
    let len = 0;
    for (let i = from; i < to; i++) len += segs[i % segs.length].len;
    runs.push(len);
  }
  // Each stretch: half a dash, the pattern repeated, and the other half of the first dash.
  const out = [];
  for (const len of runs) {
    const reps = Math.max(1, Math.round(len / P));
    const k = len / (reps * P);
    const half = (pattern[0] * k) / 2;
    if (out.length) out[out.length - 1] += half;
    else out.push(half);
    for (let r = 0; r < reps; r++) {
      for (let j = 1; j < pattern.length; j++) out.push(pattern[j] * k);
      out.push(r === reps - 1 ? half : pattern[0] * k);
    }
  }
  if (!closed) {
    out.push(0);
    return { dash: out, offset: 0 };
  }
  // Closed: the last half dash joins the first one at the first corner.
  const lead = out.pop();
  out[0] += lead;
  let at = 0;
  for (let i = 0; i < first; i++) at += segs[i].len;
  return { dash: out, offset: (((lead - at) % total) + total) % total };
}

export { pathLength };
