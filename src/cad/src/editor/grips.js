/**
 * Grips: editable handles on selected objects. gripsOf() lists them and
 * applyGrip() returns the entity after dragging grip `i` to (x, y).
 */
import {
  splineFromFitPoints,
  splineFromControlPoints,
  isFullEllipse,
  ellipsePoint,
  ellipseParamOf,
} from '../core/geom/index.js';

const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;

/** @returns {{x:number, y:number, kind?:string}[]} */
export function gripsOf(ent) {
  switch (ent.type) {
    case 'line':
      return [
        { x: ent.x1, y: ent.y1 },
        { x: (ent.x1 + ent.x2) / 2, y: (ent.y1 + ent.y2) / 2, kind: 'mid' },
        { x: ent.x2, y: ent.y2 },
      ];
    case 'xline':
    case 'ray':
      return [
        { x: ent.x, y: ent.y, kind: 'mid' },
        { x: ent.x + ent.dx * 10, y: ent.y + ent.dy * 10, kind: 'dir' },
      ];
    case 'circle':
      return [
        { x: ent.cx, y: ent.cy, kind: 'mid' },
        { x: ent.cx + ent.r, y: ent.cy, kind: 'rad' },
        { x: ent.cx, y: ent.cy + ent.r, kind: 'rad' },
        { x: ent.cx - ent.r, y: ent.cy, kind: 'rad' },
        { x: ent.cx, y: ent.cy - ent.r, kind: 'rad' },
      ];
    case 'arc': {
      const mid = ent.start + norm(ent.end - ent.start) / 2;
      return [
        { x: ent.cx + ent.r * Math.cos(ent.start), y: ent.cy + ent.r * Math.sin(ent.start) },
        { x: ent.cx + ent.r * Math.cos(mid), y: ent.cy + ent.r * Math.sin(mid), kind: 'rad' },
        { x: ent.cx + ent.r * Math.cos(ent.end), y: ent.cy + ent.r * Math.sin(ent.end) },
        { x: ent.cx, y: ent.cy, kind: 'mid' },
      ];
    }
    case 'ellipse': {
      const nx = -ent.my * ent.ratio,
        ny = ent.mx * ent.ratio;
      const g = [
        { x: ent.cx, y: ent.cy, kind: 'mid' },
        { x: ent.cx + ent.mx, y: ent.cy + ent.my, kind: 'axis' },
        { x: ent.cx - ent.mx, y: ent.cy - ent.my, kind: 'axis' },
        { x: ent.cx + nx, y: ent.cy + ny, kind: 'minor' },
        { x: ent.cx - nx, y: ent.cy - ny, kind: 'minor' },
      ];
      // An elliptical arc's ends (grips 5 and 6).
      if (!isFullEllipse(ent)) g.push(ellipsePoint(ent, ent.start), ellipsePoint(ent, ent.end));
      return g;
    }
    case 'polyline': {
      const p = ent.pts;
      const n = p.length / 3;
      const g = [];
      for (let i = 0; i < n; i++) g.push({ x: p[i * 3], y: p[i * 3 + 1], v: i });
      const segs = ent.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        const b = p[i * 3 + 2];
        let mx = (p[i * 3] + p[j * 3]) / 2,
          my = (p[i * 3 + 1] + p[j * 3 + 1]) / 2;
        if (b) {
          const dx = p[j * 3] - p[i * 3],
            dy = p[j * 3 + 1] - p[i * 3 + 1];
          // Sagitta offset to the arc midpoint.
          mx += (dy * b) / 2;
          my -= (dx * b) / 2;
        }
        g.push({ x: mx, y: my, kind: 'seg', s: i });
      }
      return g;
    }
    case 'spline': {
      const src = ent.fit && ent.fit.length >= 4 ? ent.fit : ent.ctrl;
      const g = [];
      for (let i = 0; i < src.length; i += 2) g.push({ x: src[i], y: src[i + 1], v: i / 2 });
      return g;
    }
    case 'point':
    case 'text':
    case 'mtext':
    case 'insert':
      return [{ x: ent.x, y: ent.y }];
    case 'leader': {
      const g = [];
      for (let i = 0; i < ent.pts.length; i += 2) g.push({ x: ent.pts[i], y: ent.pts[i + 1], v: i / 2 });
      return g;
    }
    case 'dimension': {
      const g = [
        { x: ent.x1, y: ent.y1 },
        { x: ent.x2, y: ent.y2 },
        { x: ent.lx, y: ent.ly, kind: 'loc' },
      ];
      if (ent.dimType === 'angular') g.push({ x: ent.x3, y: ent.y3 });
      return g;
    }
    case 'hatch': {
      const g = [];
      const loops = ent.loops || [];
      if (loops.length === 1 && loops[0].length <= 3 * 64) {
        const l = loops[0];
        for (let i = 0; i < l.length; i += 3) g.push({ x: l[i], y: l[i + 1], v: i / 3 });
      }
      return g;
    }
  }
  return [];
}

/** Entity after moving grip `i` to (x, y). */
export function applyGrip(ent, i, x, y) {
  const g = gripsOf(ent)[i];
  if (!g) return ent;
  const dx = x - g.x,
    dy = y - g.y;
  switch (ent.type) {
    case 'line':
      if (i === 0) return { ...ent, x1: x, y1: y };
      if (i === 2) return { ...ent, x2: x, y2: y };
      return { ...ent, x1: ent.x1 + dx, y1: ent.y1 + dy, x2: ent.x2 + dx, y2: ent.y2 + dy };
    case 'xline':
    case 'ray': {
      if (i === 0) return { ...ent, x, y };
      const l = Math.hypot(x - ent.x, y - ent.y);
      if (l < 1e-12) return ent;
      return { ...ent, dx: (x - ent.x) / l, dy: (y - ent.y) / l };
    }
    case 'circle':
      if (i === 0) return { ...ent, cx: x, cy: y };
      return { ...ent, r: Math.max(1e-9, Math.hypot(x - ent.cx, y - ent.cy)) };
    case 'arc': {
      if (i === 3) return { ...ent, cx: x, cy: y };
      if (i === 1) return { ...ent, r: Math.max(1e-9, Math.hypot(x - ent.cx, y - ent.cy)) };
      // Moving an end keeps the other end and the arc's middle point: recompute through 3 points.
      const pts = gripsOf(ent);
      const a = i === 0 ? { x, y } : pts[0];
      const b = pts[1];
      const c = i === 2 ? { x, y } : pts[2];
      return arcThrough(ent, a, b, c) ?? ent;
    }
    case 'ellipse': {
      if (i === 0) return { ...ent, cx: x, cy: y };
      if (i >= 5) {
        // Move an end along the ellipse; it may not land on the other end (that reads as closed).
        const t = ellipseParamOf(ent, x, y);
        const gap = norm(t - (i === 5 ? ent.end : ent.start));
        if (gap < 1e-6 || gap > TAU - 1e-6) return ent;
        return i === 5 ? { ...ent, start: t } : { ...ent, end: t };
      }
      const vx = x - ent.cx,
        vy = y - ent.cy;
      const major = Math.hypot(ent.mx, ent.my);
      if (i === 1 || i === 2) {
        const len = Math.hypot(vx, vy);
        if (len < 1e-12) return ent;
        const s = i === 1 ? 1 : -1;
        const minor = major * ent.ratio;
        // Keep the minor radius; swap axes if the new major gets shorter.
        if (len >= minor) return { ...ent, mx: s * vx, my: s * vy, ratio: minor / len };
        const ux = -vy / len,
          uy = vx / len;
        return { ...ent, mx: ux * minor * s, my: uy * minor * s, ratio: len / minor, ...shiftParams(ent, -s * (Math.PI / 2)) };
      }
      const ux = ent.mx / major,
        uy = ent.my / major;
      const d = Math.abs(-uy * vx + ux * vy);
      if (d < 1e-12) return ent;
      if (d <= major) return { ...ent, ratio: d / major };
      return { ...ent, mx: -uy * d, my: ux * d, ratio: major / d, ...shiftParams(ent, -Math.PI / 2) };
    }
    case 'polyline': {
      const p = ent.pts.slice();
      const n = p.length / 3;
      if (g.v !== undefined) {
        p[g.v * 3] = x;
        p[g.v * 3 + 1] = y;
        return { ...ent, pts: p };
      }
      const s = g.s,
        j = (s + 1) % n;
      if (p[s * 3 + 2]) {
        // Arc segment midpoint: keep ends, pass through the new point.
        const b = bulgeThrough(p[s * 3], p[s * 3 + 1], x, y, p[j * 3], p[j * 3 + 1]);
        if (b !== null) p[s * 3 + 2] = b;
        return { ...ent, pts: p };
      }
      p[s * 3] += dx;
      p[s * 3 + 1] += dy;
      p[j * 3] += dx;
      p[j * 3 + 1] += dy;
      return { ...ent, pts: p };
    }
    case 'spline': {
      if (ent.fit && ent.fit.length >= 4) {
        const fit = ent.fit.slice();
        fit[g.v * 2] = x;
        fit[g.v * 2 + 1] = y;
        return { ...ent, ...splineFromFitPoints(fit, ent.closed), fit };
      }
      const ctrl = ent.ctrl.slice();
      ctrl[g.v * 2] = x;
      ctrl[g.v * 2 + 1] = y;
      return { ...ent, ...splineFromControlPoints(ctrl, ent.degree), fit: [] };
    }
    case 'point':
    case 'text':
    case 'mtext':
    case 'insert':
      return { ...ent, x, y };
    case 'leader': {
      const pts = ent.pts.slice();
      pts[g.v * 2] = x;
      pts[g.v * 2 + 1] = y;
      return { ...ent, pts };
    }
    case 'dimension':
      if (i === 0) return { ...ent, x1: x, y1: y };
      if (i === 1) return { ...ent, x2: x, y2: y };
      if (i === 2) return { ...ent, lx: x, ly: y };
      return { ...ent, x3: x, y3: y };
    case 'hatch': {
      const loops = ent.loops.map((l) => l.slice());
      loops[0][g.v * 3] = x;
      loops[0][g.v * 3 + 1] = y;
      return { ...ent, loops };
    }
  }
  return ent;
}

/**
 * When the major axis turns by 90 degrees the parameter frame turns with it;
 * shift an elliptical arc's start and end so the arc stays in place.
 */
function shiftParams(ent, by) {
  const full = Math.abs(norm(ent.end - ent.start)) < 1e-9 || Math.abs(ent.end - ent.start - TAU) < 1e-9;
  return full ? {} : { start: norm(ent.start + by), end: norm(ent.end + by) };
}

function arcThrough(ent, a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y,
    b2 = b.x * b.x + b.y * b.y,
    c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  let s = Math.atan2(a.y - cy, a.x - cx),
    e = Math.atan2(c.y - cy, c.x - cx);
  const m = Math.atan2(b.y - cy, b.x - cx);
  // Keep the orientation that passes through b.
  if (norm(m - s) > norm(e - s)) [s, e] = [e, s];
  return { ...ent, cx, cy, r, start: norm(s), end: norm(e) };
}

/** Bulge of the arc from (x1, y1) to (x2, y2) through (mx, my). */
function bulgeThrough(x1, y1, mx, my, x2, y2) {
  const arc = arcThrough({}, { x: x1, y: y1 }, { x: mx, y: my }, { x: x2, y: y2 });
  if (!arc) return 0;
  // The through point decides which of the two arcs (and so the sweep sign).
  const a0 = Math.atan2(y1 - arc.cy, x1 - arc.cx),
    a1 = Math.atan2(y2 - arc.cy, x2 - arc.cx),
    am = Math.atan2(my - arc.cy, mx - arc.cx);
  const ccw = norm(am - a0) < norm(a1 - a0);
  const sweep = ccw ? norm(a1 - a0) : -norm(a0 - a1);
  return Math.tan(sweep / 4);
}
