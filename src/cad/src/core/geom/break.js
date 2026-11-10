/**
 * Break: remove part of a curve between two points, or split it at a point.
 */
import { paramModel } from './trim.js';
import { closestOnPrims } from './nearest.js';
import { shiftEntity, localOrigin } from './entity.js';

function paramAt(model, x, y) {
  const c = closestOnPrims(model.prims, x, y);
  if (!c) return null;
  let u = model.param(c.prim, c.t);
  if (model.cyclic) {
    const per = model.hi - model.lo;
    u = model.lo + ((((u - model.lo) % per) + per) % per);
  }
  return u;
}

/**
 * Remove the part of ent between the projections of (x1, y1) and (x2, y2).
 * Closed curves (circles, full ellipses, closed polylines and splines) lose
 * the part running forward (CCW for circles, vertex order for polylines)
 * from the first point to the second. Returns the remaining entities (no
 * ids), or null when the entity cannot be broken.
 */
export function breakEntity(ent, x1, y1, x2, y2) {
  // Relative to the object, where the tolerances do not grow with its coordinates.
  const o = localOrigin(ent);
  if (o) {
    const r = breakEntity(shiftEntity(ent, -o.x, -o.y), x1 - o.x, y1 - o.y, x2 - o.x, y2 - o.y);
    return r && r.map((e) => shiftEntity(e, o.x, o.y));
  }
  const model = paramModel(ent);
  if (!model) return null;
  const u1 = paramAt(model, x1, y1),
    u2 = paramAt(model, x2, y2);
  if (u1 === null || u2 === null) return null;
  const { lo, hi, eps } = model;
  if (model.cyclic) {
    const per = hi - lo;
    if (Math.abs(u2 - u1) <= eps || per - Math.abs(u2 - u1) <= eps) return breakAtPoint(ent, x1, y1);
    const piece = u2 > u1 ? model.piece(u2, u1 + per) : model.piece(u2, u1);
    return piece ? [piece] : [];
  }
  const a = Math.min(u1, u2),
    b = Math.max(u1, u2);
  const out = [];
  if (a > lo + eps) {
    const p = model.piece(lo, a);
    if (p) out.push(p);
  }
  if (b < hi - eps) {
    const p = model.piece(b, hi);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Split ent at the projection of (x, y). Open curves give two entities;
 * closed polylines and splines give one open entity starting and ending
 * there. Returns null when the point is at an end or the entity cannot be
 * split (circles, full ellipses).
 */
export function breakAtPoint(ent, x, y) {
  const o = localOrigin(ent);
  if (o) {
    const r = breakAtPoint(shiftEntity(ent, -o.x, -o.y), x - o.x, y - o.y);
    return r && r.map((e) => shiftEntity(e, o.x, o.y));
  }
  const model = paramModel(ent);
  if (!model) return null;
  const u = paramAt(model, x, y);
  if (u === null) return null;
  const { lo, hi, eps } = model;
  if (model.cyclic) {
    if (ent.type === 'circle' || ent.type === 'ellipse') return null;
    const p = model.piece(u, u + (hi - lo));
    return p ? [p] : null;
  }
  if (!(u > lo + eps && u < hi - eps)) return null;
  const a = model.piece(lo, u),
    b = model.piece(u, hi);
  return a && b ? [a, b] : null;
}
