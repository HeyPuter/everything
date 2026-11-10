/**
 * Helpers for building entities from other entities: copy the non-geometric
 * fields (layer, color, linetype, width, text, ...) and replace the geometry.
 */

/** Geometry fields per entity type. */
export const GEOM_KEYS = {
  line: ['x1', 'y1', 'x2', 'y2'],
  xline: ['x', 'y', 'dx', 'dy'],
  ray: ['x', 'y', 'dx', 'dy'],
  circle: ['cx', 'cy', 'r'],
  arc: ['cx', 'cy', 'r', 'start', 'end'],
  ellipse: ['cx', 'cy', 'mx', 'my', 'ratio', 'start', 'end'],
  polyline: ['pts', 'closed'],
  spline: ['degree', 'ctrl', 'knots', 'fit', 'closed'],
  point: ['x', 'y'],
  leader: ['pts'],
  hatch: ['loops'],
};

/**
 * New entity of `type` with the non-geometric fields of `src` (minus its id)
 * and the given geometry fields.
 */
export function derive(src, type, geom) {
  const skip = GEOM_KEYS[src.type];
  const out = {};
  for (const k in src) {
    if (k === 'id' || (skip && skip.includes(k))) continue;
    out[k] = src[k];
  }
  out.type = type;
  return Object.assign(out, geom);
}

/** Copy of `src` with some fields replaced; keeps the id (an in-place edit). */
export function update(src, geom) {
  return Object.assign({ ...src }, geom);
}

/** Line entity derived from src. */
export function lineFrom(src, x1, y1, x2, y2) {
  return derive(src, 'line', { x1, y1, x2, y2 });
}

/** Arc entity derived from src. */
export function arcFrom(src, cx, cy, r, start, end) {
  return derive(src, 'arc', { cx, cy, r, start, end });
}

/** Polyline entity derived from src (keeps width when src is a polyline). */
export function polylineFrom(src, pts, closed = false) {
  const out = derive(src, 'polyline', { pts, closed });
  if (out.width === undefined) out.width = 0;
  return out;
}

function shiftFlat(pts, dx, dy, stride) {
  const out = pts.slice();
  for (let i = 0; i + 1 < out.length; i += stride) {
    out[i] += dx;
    out[i + 1] += dy;
  }
  return out;
}

/**
 * Copy of a curve entity moved by (dx, dy). Only coordinates change (angles,
 * bulges and radii are kept bit for bit), so moving by -p and back by p, with
 * p one of the entity's own points, restores every original coordinate exactly.
 */
export function shiftEntity(ent, dx, dy) {
  const out = { ...ent };
  switch (ent.type) {
    case 'line':
      out.x1 += dx;
      out.y1 += dy;
      out.x2 += dx;
      out.y2 += dy;
      break;
    case 'xline':
    case 'ray':
    case 'point':
      out.x += dx;
      out.y += dy;
      break;
    case 'circle':
    case 'arc':
    case 'ellipse':
      out.cx += dx;
      out.cy += dy;
      break;
    case 'polyline':
      out.pts = shiftFlat(ent.pts, dx, dy, 3);
      break;
    case 'spline':
      out.ctrl = shiftFlat(ent.ctrl, dx, dy, 2);
      if (ent.fit) out.fit = shiftFlat(ent.fit, dx, dy, 2);
      break;
    default:
      break;
  }
  return out;
}

/** The first point of a curve entity when it is not the origin, else null. */
export function localOrigin(ent) {
  let x = 0,
    y = 0;
  switch (ent.type) {
    case 'line':
      x = ent.x1;
      y = ent.y1;
      break;
    case 'xline':
    case 'ray':
      x = ent.x;
      y = ent.y;
      break;
    case 'circle':
    case 'arc':
    case 'ellipse':
      x = ent.cx;
      y = ent.cy;
      break;
    case 'polyline':
      x = ent.pts[0];
      y = ent.pts[1];
      break;
    case 'spline':
      x = ent.ctrl?.[0];
      y = ent.ctrl?.[1];
      break;
    default:
      break;
  }
  return Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0) ? { x, y } : null;
}
