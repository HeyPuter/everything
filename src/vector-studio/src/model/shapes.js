/**
 * Anchor-list generators for the shape tools. All return closed or open
 * anchor lists in absolute coordinates, clockwise on a y-down screen,
 * starting at the top-left corner (rectangles) or the top (ellipses,
 * polygons, stars).
 *
 * Live shapes keep their parameters in `node.shape` so the Properties panel
 * can edit width, height, corner radius, sides and so on; the anchors stay
 * the source of truth for rendering and are regenerated from the params.
 */
import { anchor, transformAnchors } from './bezier.js';
import { rotate } from '../lib/matrix.js';

export const KAPPA = 0.5522847498307936;

/** Rectangle with optional per-corner radii [tl, tr, br, bl]. */
export function rectangle(x, y, w, h, radii = 0) {
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  const r = Array.isArray(radii) ? radii : [radii, radii, radii, radii];
  const max = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = r.map((v) => Math.max(0, Math.min(max, v || 0)));
  if (!tl && !tr && !br && !bl) {
    return [anchor(x, y), anchor(x + w, y), anchor(x + w, y + h), anchor(x, y + h)];
  }
  const out = [];
  const k = KAPPA;
  // Each rounded corner contributes two anchors; square corners one.
  const corner = (cx, cy, r, inDir, outDir) => {
    if (!r) {
      out.push(anchor(cx, cy));
      return;
    }
    const ax = cx + inDir[0] * r;
    const ay = cy + inDir[1] * r;
    const bx = cx + outDir[0] * r;
    const by = cy + outDir[1] * r;
    out.push(anchor(ax, ay, ax, ay, ax - inDir[0] * r * k, ay - inDir[1] * r * k));
    out.push(anchor(bx, by, bx - outDir[0] * r * k, by - outDir[1] * r * k, bx, by));
  };
  corner(x, y, tl, [0, 1], [1, 0]);
  corner(x + w, y, tr, [-1, 0], [0, 1]);
  corner(x + w, y + h, br, [0, -1], [-1, 0]);
  corner(x, y + h, bl, [1, 0], [0, -1]);
  return out;
}

/** Ellipse inscribed in the box, four anchors starting at the left. */
export function ellipse(x, y, w, h) {
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { x: cx - rx, y: cy, ix: cx - rx, iy: cy + ky, ox: cx - rx, oy: cy - ky },
    { x: cx, y: cy - ry, ix: cx - kx, iy: cy - ry, ox: cx + kx, oy: cy - ry },
    { x: cx + rx, y: cy, ix: cx + rx, iy: cy - ky, ox: cx + rx, oy: cy + ky },
    { x: cx, y: cy + ry, ix: cx + kx, iy: cy + ry, ox: cx - kx, oy: cy + ry },
  ];
}

/** Is a live ellipse cut into a pie (its start and end angles differ)? */
export function isPie(shape) {
  if (shape?.kind !== 'ellipse' || shape.pieStart == null || shape.pieEnd == null) return false;
  const sweep = (((shape.pieEnd - shape.pieStart) % 360) + 360) % 360;
  return sweep > 1e-6 && sweep < 360 - 1e-6;
}

/**
 * Pie of the ellipse centered at (cx, cy): the arc from `start` to `end`
 * degrees, counterclockwise on screen from 3 o'clock, closed through the
 * center. Arc pieces span at most 90 degrees each.
 */
export function pie(cx, cy, rx, ry, start, end) {
  let sweep = (((end - start) % 360) + 360) % 360;
  if (sweep < 1e-6) sweep = 360;
  const n = Math.max(1, Math.ceil(sweep / 90 - 1e-9));
  const step = ((sweep / n) * Math.PI) / 180;
  const k = (4 / 3) * Math.tan(step / 4);
  const a0 = (start * Math.PI) / 180;
  const pt = (t) => ({ x: cx + rx * Math.cos(t), y: cy - ry * Math.sin(t), dx: -rx * Math.sin(t), dy: -ry * Math.cos(t) });
  const out = [];
  for (let i = 0; i <= n; i++) {
    const p = pt(a0 + i * step);
    out.push({
      x: p.x,
      y: p.y,
      ix: i > 0 ? p.x - k * p.dx : p.x,
      iy: i > 0 ? p.y - k * p.dy : p.y,
      ox: i < n ? p.x + k * p.dx : p.x,
      oy: i < n ? p.y + k * p.dy : p.y,
    });
  }
  out.push(anchor(cx, cy));
  return out;
}

/** Regular polygon with `sides` corners, radius to the corners, first corner at the top. */
export function polygon(cx, cy, radius, sides = 6) {
  const n = Math.max(3, Math.round(sides));
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    out.push(anchor(cx + radius * Math.cos(a), cy + radius * Math.sin(a)));
  }
  return out;
}

/** Star with `points` tips, outer radius r1 and inner radius r2. */
export function star(cx, cy, r1, r2, points = 5) {
  const n = Math.max(3, Math.round(points));
  const out = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? r1 : r2;
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    out.push(anchor(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return out;
}

/** Inner radius that makes the star's edges straight across opposite tips (a "regular" star). */
export function regularStarInner(r1, points) {
  const n = Math.max(3, Math.round(points));
  if (n < 5) return r1 * 0.5;
  return (r1 * Math.cos((2 * Math.PI) / n)) / Math.cos(Math.PI / n);
}

/** Straight line. */
export function line(x1, y1, x2, y2) {
  return [anchor(x1, y1), anchor(x2, y2)];
}

/**
 * Quarter-ellipse arc from (x1, y1) to (x2, y2), bulging outward with the
 * Arc tool's default slope. `concave` flips the bulge.
 */
export function arc(x1, y1, x2, y2, concave = false) {
  const k = KAPPA;
  // The arc's center is the corner of the box opposite the bulge.
  const cx = concave ? x2 : x1;
  const cy = concave ? y1 : y2;
  const a = anchor(x1, y1);
  const b = anchor(x2, y2);
  if (!concave) {
    a.ox = x1 + (x2 - cx) * k;
    a.oy = y1;
    b.ix = x2;
    b.iy = y2 + (y1 - cy) * k;
  } else {
    a.ox = x1;
    a.oy = y1 + (y2 - cy) * k;
    b.ix = x2 + (x1 - cx) * k;
    b.iy = y2;
  }
  return [a, b];
}

/**
 * Archimedean-style decaying spiral for the Spiral tool: `segments`
 * quarter turns, each `decay` (0..1) times the previous radius.
 */
export function spiral(cx, cy, radius, decay = 0.8, segments = 10, clockwise = true) {
  const out = [];
  let r = radius;
  const dir = clockwise ? 1 : -1;
  let a = -Math.PI / 2;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), r });
    a += (dir * Math.PI) / 2;
    r *= decay;
  }
  // Tangent handles: perpendicular to the radius, length kappa * radius.
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const ang = Math.atan2(p.y - cy, p.x - cx);
    const tx = -Math.sin(ang) * dir;
    const ty = Math.cos(ang) * dir;
    const rin = i > 0 ? (pts[i - 1].r + p.r) / 2 : p.r;
    const rout = i < pts.length - 1 ? (pts[i + 1].r + p.r) / 2 : p.r;
    out.push({
      x: p.x,
      y: p.y,
      ix: i > 0 ? p.x - tx * rin * KAPPA : p.x,
      iy: i > 0 ? p.y - ty * rin * KAPPA : p.y,
      ox: i < pts.length - 1 ? p.x + tx * rout * KAPPA : p.x,
      oy: i < pts.length - 1 ? p.y + ty * rout * KAPPA : p.y,
    });
  }
  return out;
}

/** Rectangular grid: returns a list of open line anchor lists plus the frame rectangle. */
export function rectGrid(x, y, w, h, rows = 5, cols = 5) {
  const lines = [];
  for (let i = 1; i < cols; i++) {
    const gx = x + (w * i) / cols;
    lines.push(line(gx, y, gx, y + h));
  }
  for (let j = 1; j < rows; j++) {
    const gy = y + (h * j) / rows;
    lines.push(line(x, gy, x + w, gy));
  }
  return { frame: rectangle(x, y, w, h), lines };
}

/** Polar grid: concentric ellipses and radial dividers. */
export function polarGrid(x, y, w, h, rings = 5, dividers = 5) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const circles = [];
  for (let i = rings + 1; i >= 1; i--) {
    const f = i / (rings + 1);
    circles.push(ellipse(cx - (w / 2) * f, cy - (h / 2) * f, w * f, h * f));
  }
  const lines = [];
  for (let i = 0; i < dividers; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / dividers;
    lines.push(line(cx, cy, cx + (w / 2) * Math.cos(a), cy + (h / 2) * Math.sin(a)));
  }
  return { circles, lines };
}

/** Anchors for a live shape description. */
export function shapeAnchors(shape) {
  let pts;
  switch (shape.kind) {
    case 'rect':
      pts = rectangle(shape.cx - shape.w / 2, shape.cy - shape.h / 2, shape.w, shape.h, shape.radii || 0);
      break;
    case 'ellipse':
      pts = isPie(shape) ? pie(shape.cx, shape.cy, shape.w / 2, shape.h / 2, shape.pieStart, shape.pieEnd) : ellipse(shape.cx - shape.w / 2, shape.cy - shape.h / 2, shape.w, shape.h);
      break;
    case 'polygon':
      pts = polygon(shape.cx, shape.cy, shape.r, shape.sides);
      break;
    case 'star':
      pts = star(shape.cx, shape.cy, shape.r1, shape.r2, shape.points);
      break;
    case 'line':
      pts = line(shape.x1, shape.y1, shape.x2, shape.y2);
      return pts;
    default:
      return null;
  }
  return shape.angle ? transformAnchors(pts, rotate(shape.angle, shape.cx, shape.cy)) : pts;
}
