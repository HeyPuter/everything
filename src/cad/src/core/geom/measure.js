/**
 * Lengths, areas and centroids.
 */
import { TWO_PI, ccwSweep } from './vec.js';
import { bulgeLength, BULGE_EPS } from './bulge.js';
import { ellipseAxes, ellipseSweep, isFullEllipse } from './ellipse.js';
import { evalSplineFull, splineBreaks, sampleSpline } from './spline.js';
import { bulgePolyPoints } from './tessellate.js';

const GX = [0, -0.5384693101056831, 0.5384693101056831, -0.906179845938664, 0.906179845938664];
const GW = [0.5688888888888889, 0.4786286704993665, 0.4786286704993665, 0.2369268850561891, 0.2369268850561891];

function gauss5(f, a, b) {
  const h = (b - a) / 2,
    m = (a + b) / 2;
  let s = 0;
  for (let i = 0; i < 5; i++) s += GW[i] * f(m + h * GX[i]);
  return s * h;
}

function adapt(f, a, b, whole, tol, depth) {
  const m = (a + b) / 2;
  const l = gauss5(f, a, m),
    r = gauss5(f, m, b);
  if (depth >= 24 || Math.abs(l + r - whole) <= tol) return l + r;
  return adapt(f, a, m, l, tol / 2, depth + 1) + adapt(f, m, b, r, tol / 2, depth + 1);
}

/** Adaptive Gauss-Legendre integral of f over [a, b], split into `panels` first. */
export function integrate(f, a, b, relTol = 1e-12, panels = 4) {
  if (!(b > a)) return 0;
  let total = 0;
  const parts = [];
  for (let i = 0; i < panels; i++) {
    const x0 = a + ((b - a) * i) / panels,
      x1 = a + ((b - a) * (i + 1)) / panels;
    const g = gauss5(f, x0, x1);
    parts.push(g);
    total += Math.abs(g);
  }
  const tol = Math.max(relTol * total, 1e-300);
  let s = 0;
  for (let i = 0; i < panels; i++) {
    const x0 = a + ((b - a) * i) / panels,
      x1 = a + ((b - a) * (i + 1)) / panels;
    s += adapt(f, x0, x1, parts[i], tol / panels, 0);
  }
  return s;
}

/** Arc length of an ellipse between parameters t0 and t0 + sweep. */
export function ellipseArcLength(e, t0, sweep) {
  const { a, b } = ellipseAxes(e);
  if (!(a > 0)) return 0;
  const f = (t) => {
    const s = Math.sin(t),
      c = Math.cos(t);
    return Math.sqrt(a * a * s * s + b * b * c * c);
  };
  return integrate(f, t0, t0 + sweep, 1e-13, Math.max(4, Math.ceil((sweep / TWO_PI) * 16)));
}

/** Arc length of a spline over its whole domain. */
export function splineLength(s) {
  const br = splineBreaks(s);
  let len = 0;
  // Measure a copy moved to the origin: far from it the rounding noise of the
  // control points exceeds the integration tolerance, which then never converges.
  const c = s.ctrl;
  const local = { degree: s.degree, knots: s.knots, ctrl: new Array(c.length) };
  for (let i = 0; i + 1 < c.length; i += 2) {
    local.ctrl[i] = c[i] - c[0];
    local.ctrl[i + 1] = c[i + 1] - c[1];
  }
  const f = (u) => {
    const r = evalSplineFull(local, u);
    return Math.hypot(r.dx, r.dy);
  };
  for (let k = 0; k + 1 < br.length; k++) len += integrate(f, br[k], br[k + 1], 1e-12, 2);
  return len;
}

/** Length of a stride-3 bulged point list. */
export function bulgeListLength(pts, closed) {
  const n = Math.floor(pts.length / 3);
  if (n < 2) return 0;
  const segs = closed ? n : n - 1;
  let len = 0;
  for (let i = 0; i < segs; i++) {
    const a = i * 3,
      b = ((i + 1) % n) * 3;
    len += bulgeLength(pts[a], pts[a + 1], pts[b], pts[b + 1], pts[a + 2]);
  }
  return len;
}

/** Length of an entity (Infinity for xline / ray, null when not a curve). */
export function lengthOf(ent) {
  switch (ent.type) {
    case 'line':
      return Math.hypot(ent.x2 - ent.x1, ent.y2 - ent.y1);
    case 'circle':
      return TWO_PI * ent.r;
    case 'arc':
      return ent.r * ccwSweep(ent.start, ent.end);
    case 'ellipse':
      return ellipseArcLength(ent, isFullEllipse(ent) ? 0 : ent.start, ellipseSweep(ent));
    case 'polyline':
      return bulgeListLength(ent.pts, !!ent.closed);
    case 'spline':
      return ent.ctrl && ent.ctrl.length >= 4 ? splineLength(ent) : 0;
    case 'leader': {
      let len = 0;
      const p = ent.pts;
      for (let i = 0; i + 3 < p.length; i += 2) len += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      return len;
    }
    case 'hatch': {
      let len = 0;
      for (const l of ent.loops || []) len += bulgeListLength(l, true);
      return len;
    }
    case 'xline':
    case 'ray':
      return Infinity;
    case 'point':
      return 0;
    default:
      return null;
  }
}

/**
 * Signed area of a stride-3 bulged point list (positive = CCW). Open lists
 * are closed with a straight chord.
 */
export function signedAreaPolyline(pts, closed = true) {
  const n = Math.floor(pts.length / 3);
  if (n < 2) return 0;
  // Shift coordinates to the first vertex for precision far from the origin.
  const ox = pts[0],
    oy = pts[1];
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 3,
      q = ((i + 1) % n) * 3;
    const x1 = pts[p] - ox,
      y1 = pts[p + 1] - oy,
      x2 = pts[q] - ox,
      y2 = pts[q + 1] - oy;
    a += (x1 * y2 - x2 * y1) / 2;
    const b = closed || i < n - 1 ? pts[p + 2] : 0;
    if (Math.abs(b) > BULGE_EPS) {
      const th = 4 * Math.atan(b);
      const c = Math.hypot(x2 - x1, y2 - y1);
      const r = (c * (1 + b * b)) / (4 * Math.abs(b));
      a += ((r * r) / 2) * (th - Math.sin(th));
    }
  }
  return a;
}

/** Signed area of a flat [x, y, ...] polygon (positive = CCW). */
export function signedAreaFlat(pts) {
  const n = pts.length >> 1;
  if (n < 3) return 0;
  const ox = pts[0],
    oy = pts[1];
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += (pts[2 * i] - ox) * (pts[2 * j + 1] - oy) - (pts[2 * j] - ox) * (pts[2 * i + 1] - oy);
  }
  return a / 2;
}

/**
 * Area centroid of a closed stride-3 bulged point list:
 * { x, y, area } (area signed), or null when the area vanishes.
 */
export function centroidPolyline(pts) {
  const n = Math.floor(pts.length / 3);
  if (n < 2) return null;
  const ox = pts[0],
    oy = pts[1];
  let A = 0,
    mx = 0,
    my = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 3,
      q = ((i + 1) % n) * 3;
    const x1 = pts[p] - ox,
      y1 = pts[p + 1] - oy,
      x2 = pts[q] - ox,
      y2 = pts[q + 1] - oy;
    const cr = x1 * y2 - x2 * y1;
    A += cr / 2;
    mx += ((x1 + x2) * cr) / 6;
    my += ((y1 + y2) * cr) / 6;
    const b = pts[p + 2];
    if (Math.abs(b) > BULGE_EPS) {
      const th = 4 * Math.atan(b);
      const c = Math.hypot(x2 - x1, y2 - y1);
      if (!(c > 0)) continue;
      const r = (c * (1 + b * b)) / (4 * Math.abs(b));
      const sa = ((r * r) / 2) * (th - Math.sin(th));
      // Arc midpoint direction from the chord midpoint (right of travel for CCW).
      const hx = (x1 + x2) / 2 + ((y2 - y1) * b) / 2,
        hy = (y1 + y2) / 2 - ((x2 - x1) * b) / 2;
      const k = (1 - b * b) / (4 * b);
      const cx = (x1 + x2) / 2 - (y2 - y1) * k,
        cy = (y1 + y2) / 2 + (x2 - x1) * k;
      const at = Math.abs(th);
      const s = Math.sin(at / 2);
      const d = (4 * r * s * s * s) / (3 * (at - Math.sin(at)));
      const ux = (hx - cx) / r,
        uy = (hy - cy) / r;
      A += sa;
      mx += sa * (cx + ux * d);
      my += sa * (cy + uy * d);
    }
  }
  if (!(Math.abs(A) > 0)) return null;
  return { x: ox + mx / A, y: oy + my / A, area: A };
}

/** Even-odd point in polygon test for a flat [x, y, ...] ring. */
export function pointInPolygon(x, y, pts) {
  const n = pts.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i],
      yi = pts[2 * i + 1],
      xj = pts[2 * j],
      yj = pts[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Net area of hatch loops: nested loops alternate between fill and hole. */
export function hatchArea(loops) {
  const valid = loops.filter((l) => l.length >= 6);
  if (!valid.length) return 0;
  const areas = valid.map((l) => Math.abs(signedAreaPolyline(l, true)));
  const rings = valid.map((l, i) => {
    const size = Math.sqrt(areas[i]) || 1;
    return bulgePolyPoints(l, true, size * 1e-4);
  });
  let total = 0;
  for (let i = 0; i < valid.length; i++) {
    // Probe slightly inside the loop's first edge to avoid touching vertices.
    const r = rings[i];
    const px = (r[0] + r[2]) / 2,
      py = (r[1] + r[3]) / 2;
    let depth = 0;
    for (let j = 0; j < valid.length; j++) if (j !== i && areas[j] > areas[i] && pointInPolygon(px, py, rings[j])) depth++;
    total += depth % 2 ? -areas[i] : areas[i];
  }
  return Math.abs(total);
}

/**
 * Area of an entity. Closed shapes give their enclosed area; open arcs,
 * polylines and splines are closed with a straight chord. Hatches subtract
 * holes. Returns 0 for other entities.
 */
export function areaOf(ent) {
  switch (ent.type) {
    case 'circle':
      return Math.PI * ent.r * ent.r;
    case 'arc': {
      const sw = ccwSweep(ent.start, ent.end);
      return ((ent.r * ent.r) / 2) * (sw - Math.sin(sw));
    }
    case 'ellipse': {
      const { a, b } = ellipseAxes(ent);
      if (isFullEllipse(ent)) return Math.PI * a * b;
      const sw = ellipseSweep(ent);
      return ((a * b) / 2) * (sw - Math.sin(sw));
    }
    case 'polyline':
      return Math.abs(signedAreaPolyline(ent.pts, !!ent.closed));
    case 'spline': {
      if (!ent.ctrl || ent.ctrl.length < 6) return 0;
      let x0 = Infinity,
        x1 = -Infinity,
        y0 = Infinity,
        y1 = -Infinity;
      const c = ent.ctrl;
      for (let i = 0; i + 1 < c.length; i += 2) {
        x0 = Math.min(x0, c[i]);
        x1 = Math.max(x1, c[i]);
        y0 = Math.min(y0, c[i + 1]);
        y1 = Math.max(y1, c[i + 1]);
      }
      const pts = sampleSpline(ent, Math.max(x1 - x0, y1 - y0) * 1e-6 || 1e-9).pts;
      return Math.abs(signedAreaFlat(pts));
    }
    case 'hatch':
      return hatchArea(ent.loops || []);
    default:
      return 0;
  }
}
