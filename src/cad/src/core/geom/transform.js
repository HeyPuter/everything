/**
 * 2D affine transforms. A matrix is [a, b, c, d, e, f]:
 *   x' = a * x + c * y + e
 *   y' = b * x + d * y + f
 */
import { TWO_PI, normAngle, ccwSweep } from './vec.js';
import { arcFromBulge } from './bulge.js';
import { arcSegments } from './tessellate.js';
import { isFullEllipse } from './ellipse.js';
import { DESCENDER } from '../text/font.js';

export function identity() {
  return [1, 0, 0, 1, 0, 0];
}

export function translate(dx, dy) {
  return [1, 0, 0, 1, dx, dy];
}

/** Rotation by angle (radians, CCW) about (cx, cy). */
export function rotate(angle, cx = 0, cy = 0) {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}

/** Scale by s (and sy, default s) about (cx, cy). */
export function scale(s, cx = 0, cy = 0, sy = s) {
  return [s, 0, 0, sy, cx - s * cx, cy - sy * cy];
}

/** Reflection across the line through (x1, y1) and (x2, y2). */
export function mirror(x1, y1, x2, y2) {
  const l = Math.hypot(x2 - x1, y2 - y1);
  if (!(l > 0)) return identity();
  const ux = (x2 - x1) / l,
    uy = (y2 - y1) / l;
  const a = 2 * ux * ux - 1,
    b = 2 * ux * uy,
    d = 2 * uy * uy - 1;
  return [a, b, b, d, x1 - (a * x1 + b * y1), y1 - (b * x1 + d * y1)];
}

/** Product m1 * m2: applies m2 first, then m1. */
export function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Inverse matrix, or null when singular. */
export function invert(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!(Math.abs(det) > 1e-300) || !Number.isFinite(det)) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Apply m to a point. */
export function apply(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Apply m to a flat point list with the given stride (copies other values). */
export function applyFlat(m, pts, stride = 2) {
  const out = pts.slice();
  for (let i = 0; i + 1 < pts.length; i += stride) {
    const x = pts[i],
      y = pts[i + 1];
    out[i] = m[0] * x + m[2] * y + m[4];
    out[i + 1] = m[1] * x + m[3] * y + m[5];
  }
  return out;
}

export function determinant(m) {
  return m[0] * m[3] - m[1] * m[2];
}

/** True when m is a rotation / uniform scale / reflection (plus translation). */
export function isSimilarity(m) {
  const [a, b, c, d] = m;
  const s = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d)) || 1;
  const t = 1e-10 * s;
  return (Math.abs(a - d) <= t && Math.abs(b + c) <= t) || (Math.abs(a + d) <= t && Math.abs(b - c) <= t);
}

/** Uniform scale factor of the linear part (sqrt |det|). */
export function scaleFactor(m) {
  return Math.sqrt(Math.abs(determinant(m)));
}

/** Angle of the direction at angle `ang` after the linear part of m. */
function mapAngle(m, ang) {
  const c = Math.cos(ang),
    s = Math.sin(ang);
  return Math.atan2(m[1] * c + m[3] * s, m[0] * c + m[2] * s);
}

/**
 * Transform an ellipse given by centre, conjugate semi-diameters M and N and
 * a parameter range. Returns ellipse geometry fields in canonical form.
 */
export function transformEllipseGeom(cx, cy, Mx, My, Nx, Ny, start, end, full, m) {
  const c = apply(m, cx, cy);
  const mx = m[0] * Mx + m[2] * My,
    my = m[1] * Mx + m[3] * My;
  const nx = m[0] * Nx + m[2] * Ny,
    ny = m[1] * Nx + m[3] * Ny;
  let shift = 0.5 * Math.atan2(2 * (mx * nx + my * ny), mx * mx + my * my - (nx * nx + ny * ny));
  const cs = Math.cos(shift),
    sn = Math.sin(shift);
  let ax = mx * cs + nx * sn,
    ay = my * cs + ny * sn;
  let bx = -mx * sn + nx * cs,
    by = -my * sn + ny * cs;
  if (Math.hypot(bx, by) > Math.hypot(ax, ay)) {
    const tx = ax,
      ty = ay;
    ax = bx;
    ay = by;
    bx = -tx;
    by = -ty;
    shift += Math.PI / 2;
  }
  const la = Math.hypot(ax, ay),
    lb = Math.hypot(bx, by);
  const ratio = la > 0 ? Math.min(1, lb / la) : 1;
  const orient = ax * by - ay * bx;
  let s0, s1;
  if (full) {
    s0 = 0;
    s1 = TWO_PI;
  } else if (orient >= 0) {
    s0 = normAngle(start - shift);
    s1 = normAngle(end - shift);
  } else {
    s0 = normAngle(shift - end);
    s1 = normAngle(shift - start);
  }
  return { cx: c.x, cy: c.y, mx: ax, my: ay, ratio, start: s0, end: s1 };
}

// A vertical flip mirrors the band between the baseline and the cap height,
// which 'baseline' and 'top' text hang from ('bottom' is moved to its baseline).
const VFLIP = { baseline: 'top', bottom: 'top', top: 'baseline', middle: 'middle' };
const HFLIP = { left: 'right', right: 'left', center: 'center' };
const ROWFLIP = { t: 'b', b: 't', m: 'm' };
const COLFLIP = { l: 'r', r: 'l', c: 'c' };

/**
 * Text frame after a transform: rotation, height scale, width scale and how
 * the alignment must flip so mirrored text stays readable.
 * Returns { rot, hs, ws, flipH, flipV }.
 */
function textFrame(m, rot) {
  const c = Math.cos(rot),
    s = Math.sin(rot);
  const ux = m[0] * c + m[2] * s,
    uy = m[1] * c + m[3] * s;
  const vx = -m[0] * s + m[2] * c,
    vy = -m[1] * s + m[3] * c;
  const lu = Math.hypot(ux, uy) || 1;
  const perp = Math.abs(ux * vy - uy * vx) / lu;
  const det = determinant(m);
  let r = Math.atan2(uy, ux),
    flipH = false,
    flipV = false;
  if (det < 0) {
    // Mirrored: either reverse the baseline (flip horizontally) or keep it
    // and flip the box to the other side of the baseline, whichever keeps the
    // reading direction closest to the original.
    if (ux * c + uy * s < -1e-12) {
      r += Math.PI;
      flipH = true;
    } else flipV = true;
  }
  return { rot: normAngle(r), hs: perp, ws: lu / (perp || 1), flipH, flipV };
}

/** Transform a stride-3 bulged list; non-similar maps flatten arc segments. */
function transformBulgeList(m, pts, closed, similar, mirrored) {
  const n = Math.floor(pts.length / 3);
  if (similar) {
    const out = applyFlat(m, pts, 3);
    if (mirrored) for (let i = 2; i < out.length; i += 3) out[i] = -out[i] || 0;
    return out;
  }
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    const p = apply(m, pts[a], pts[a + 1]);
    out.push(p.x, p.y, 0);
    if (i >= segs) continue;
    const b = ((i + 1) % n) * 3;
    const arc = arcFromBulge(pts[a], pts[a + 1], pts[b], pts[b + 1], pts[a + 2]);
    if (!arc) continue;
    const k = arcSegments(arc.r, arc.sweep, arc.r * 1e-4);
    for (let j = 1; j < k; j++) {
      const ang = arc.a0 + (arc.sweep * j) / k;
      const q = apply(m, arc.cx + arc.r * Math.cos(ang), arc.cy + arc.r * Math.sin(ang));
      out.push(q.x, q.y, 0);
    }
  }
  return out;
}

/**
 * Transformed copy of an entity (the input is not modified; the id is kept).
 * Circles and arcs become ellipses under non-uniform scaling; polyline and
 * hatch arcs are flattened to chords in that case.
 */
export function transformEntity(ent, m) {
  const out = { ...ent };
  const det = determinant(m);
  const mirrored = det < 0;
  const similar = isSimilarity(m);
  const sf = Math.sqrt(Math.abs(det));
  switch (ent.type) {
    case 'line': {
      const p = apply(m, ent.x1, ent.y1),
        q = apply(m, ent.x2, ent.y2);
      out.x1 = p.x;
      out.y1 = p.y;
      out.x2 = q.x;
      out.y2 = q.y;
      break;
    }
    case 'xline':
    case 'ray': {
      const p = apply(m, ent.x, ent.y);
      const dx = m[0] * ent.dx + m[2] * ent.dy,
        dy = m[1] * ent.dx + m[3] * ent.dy;
      const l = Math.hypot(dx, dy) || 1;
      out.x = p.x;
      out.y = p.y;
      out.dx = dx / l;
      out.dy = dy / l;
      break;
    }
    case 'circle': {
      if (similar) {
        const c = apply(m, ent.cx, ent.cy);
        out.cx = c.x;
        out.cy = c.y;
        out.r = ent.r * sf;
        break;
      }
      const g = transformEllipseGeom(ent.cx, ent.cy, ent.r, 0, 0, ent.r, 0, TWO_PI, true, m);
      delete out.r;
      return Object.assign(out, { type: 'ellipse' }, g);
    }
    case 'arc': {
      if (similar) {
        const c = apply(m, ent.cx, ent.cy);
        out.cx = c.x;
        out.cy = c.y;
        out.r = ent.r * sf;
        const s = normAngle(mapAngle(m, ent.start)),
          e = normAngle(mapAngle(m, ent.end));
        out.start = mirrored ? e : s;
        out.end = mirrored ? s : e;
        break;
      }
      const sw = ccwSweep(ent.start, ent.end);
      // An arc of a full turn (equal angles) becomes a full ellipse; as an
      // arc its mapped end would round to a hair past its start.
      const g = transformEllipseGeom(ent.cx, ent.cy, ent.r, 0, 0, ent.r, ent.start, ent.start + sw, sw >= TWO_PI, m);
      delete out.r;
      return Object.assign(out, { type: 'ellipse' }, g);
    }
    case 'ellipse': {
      const r = ent.ratio;
      const g = transformEllipseGeom(ent.cx, ent.cy, ent.mx, ent.my, -r * ent.my, r * ent.mx, ent.start, ent.end, isFullEllipse(ent), m);
      return Object.assign(out, g);
    }
    case 'polyline':
      out.pts = transformBulgeList(m, ent.pts, !!ent.closed, similar, mirrored);
      if (ent.width) out.width = ent.width * sf;
      break;
    case 'spline':
      out.ctrl = applyFlat(m, ent.ctrl, 2);
      if (ent.fit) out.fit = applyFlat(m, ent.fit, 2);
      if (ent.knots) out.knots = ent.knots.slice();
      break;
    case 'point': {
      const p = apply(m, ent.x, ent.y);
      out.x = p.x;
      out.y = p.y;
      break;
    }
    case 'text': {
      const f = textFrame(m, ent.rot || 0);
      let ax = ent.x,
        ay = ent.y;
      if (f.flipV && ent.valign === 'bottom') {
        const rot = ent.rot || 0;
        ax += Math.sin(rot) * DESCENDER * ent.h;
        ay -= Math.cos(rot) * DESCENDER * ent.h;
      }
      const p = apply(m, ax, ay);
      out.x = p.x;
      out.y = p.y;
      out.rot = f.rot;
      out.h = ent.h * f.hs;
      if (!similar) out.widthFactor = (ent.widthFactor || 1) * f.ws;
      if (f.flipH) out.halign = HFLIP[ent.halign] ?? 'right';
      if (f.flipV) out.valign = VFLIP[ent.valign] ?? 'top';
      break;
    }
    case 'mtext': {
      const p = apply(m, ent.x, ent.y);
      const f = textFrame(m, ent.rot || 0);
      out.x = p.x;
      out.y = p.y;
      out.rot = f.rot;
      out.h = ent.h * f.hs;
      if (ent.width) out.width = ent.width * f.hs * f.ws;
      const at = ent.attach || 'tl';
      let row = at[0],
        col = at[1];
      if (f.flipV) row = ROWFLIP[row] ?? row;
      if (f.flipH) col = COLFLIP[col] ?? col;
      out.attach = row + col;
      break;
    }
    case 'dimension': {
      for (const [kx, ky] of [
        ['x1', 'y1'],
        ['x2', 'y2'],
        ['x3', 'y3'],
        ['lx', 'ly'],
      ]) {
        if (ent[kx] === undefined) continue;
        const p = apply(m, ent[kx], ent[ky]);
        out[kx] = p.x;
        out[ky] = p.y;
      }
      if (ent.dimType === 'angular' && ent.x4 !== undefined && (ent.x4 !== 0 || ent.y4 !== 0)) {
        const p = apply(m, ent.x4, ent.y4);
        out.x4 = p.x;
        out.y4 = p.y;
      }
      if (ent.rot !== undefined) out.rot = normAngle(mapAngle(m, ent.rot));
      break;
    }
    case 'leader':
      out.pts = applyFlat(m, ent.pts, 2);
      if (ent.h) out.h = ent.h * sf;
      break;
    case 'hatch':
      out.loops = (ent.loops || []).map((l) => transformBulgeList(m, l, true, similar, mirrored));
      out.angle = normAngle(mapAngle(m, ent.angle || 0));
      if (ent.scale) out.scale = ent.scale * sf;
      // A reflection mirrors the pattern; with the angle mapped as a direction,
      // drawing the pattern reflected (then rotated) gives the mirror image.
      if (mirrored) {
        if (ent.mirror) delete out.mirror;
        else out.mirror = true;
      }
      break;
    case 'insert': {
      const p = apply(m, ent.x, ent.y);
      const rot = ent.rot || 0;
      const c = Math.cos(rot),
        s = Math.sin(rot);
      // Images of the block's local X and Y axes.
      const ux = m[0] * c + m[2] * s,
        uy = m[1] * c + m[3] * s;
      const vx = -m[0] * s + m[2] * c,
        vy = -m[1] * s + m[3] * c;
      const lu = Math.hypot(ux, uy) || 1;
      let r = Math.atan2(uy, ux);
      let sx = (ent.sx ?? 1) * lu;
      let sy = ((ent.sy ?? 1) * (ux * vy - uy * vx)) / lu;
      if (mirrored) {
        // Express the reflection as a negative X scale.
        r += Math.PI;
        sx = -sx;
        sy = -sy;
      }
      out.x = p.x;
      out.y = p.y;
      out.rot = normAngle(r);
      out.sx = sx;
      out.sy = sy;
      break;
    }
    default:
      break;
  }
  return out;
}
