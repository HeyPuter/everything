/**
 * Dimension constraints: a dimension can keep its segments equal (EQ) and
 * lock segments to their current length. After every edit the elements
 * the user did not touch move to satisfy them.
 *
 *   dimension.eq      true: the references stay equally spaced
 *   dimension.locks   [{ i, j, value }]  reference indices and locked length
 */
import { add, scale, dot, norm } from './geom.js';
import { dimensionGeometry } from './plan.js';
import { wallAxis } from './model.js';

const MOVABLE = new Set(['wall', 'grid', 'refPlane', 'detailLine', 'roomSeparator', 'modelLine', 'areaBoundary', 'door', 'window', 'opening', 'column', 'component']);
const eqPt = (p, q) => Math.abs(p[0] - q[0]) < 1 && Math.abs(p[1] - q[1]) < 1;

export function constrained(el) {
  return el?.kind === 'dimension' && el.refs?.length >= 2 && (el.eq || el.locks?.length);
}

/** Move the element a reference points at by `s` along the dimension direction. */
function moveRef(doc, ref, dir, s) {
  const el = doc.get(ref.id);
  if (!el || !MOVABLE.has(el.kind) || el.pinned || Math.abs(s) < 0.01) return false;
  const v = scale(dir, s);
  if (el.hostId) {
    const host = doc.get(el.hostId);
    if (!host) return false;
    const ax = wallAxis(doc, host);
    doc.update(el.id, { t: Math.max(0, Math.min(ax.length, el.t + dot(v, ax.dir))) });
    return true;
  }
  if (el.at && !el.a) {
    doc.update(el.id, { at: add(el.at, v) });
    return true;
  }
  if (!el.a || !el.b) return false;
  // An end reference moves just that end; a face or axis moves the element.
  if (ref.ref === 'a' || ref.ref === 'b') {
    doc.update(el.id, { [ref.ref]: add(el[ref.ref], v) });
    return true;
  }
  if (el.kind === 'wall') {
    // Walls joined at an end stretch with it, as when dragging.
    for (const o of doc.all('wall')) {
      if (o.id === el.id) continue;
      for (const end of ['a', 'b']) if (eqPt(o[end], el.a) || eqPt(o[end], el.b)) doc.update(o.id, { [end]: add(o[end], v) });
    }
  }
  doc.update(el.id, { a: add(el.a, v), b: add(el.b, v) });
  return true;
}

/**
 * Restore constraints after an edit. `drivers` are the elements the user
 * changed; they stay put and the others follow. Returns the ids moved.
 */
export function solveConstraints(doc, walls, drivers) {
  const moved = new Set();
  const dims = doc.all('dimension').filter(constrained);
  if (!dims.length) return moved;
  // References the user did not just move, and that point at an element.
  const canMove = (ref) => !!ref?.id && doc.has(ref.id) && !drivers.has(ref.id);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const dim of dims) {
      const live = doc.get(dim.id);
      if (!live || !constrained(live)) continue;
      const g = dimensionGeometry(doc, walls, live);
      const dir = norm(live.dir);
      // Locked lengths: move whichever side was not driven.
      for (const lk of live.locks || []) {
        const ri = live.refs[lk.i];
        const rj = live.refs[lk.j];
        if (!ri || !rj) continue;
        const cur = g.pos[lk.j] - g.pos[lk.i];
        const err = (Math.sign(cur) || 1) * lk.value - cur;
        if (Math.abs(err) < 0.5) continue;
        if (canMove(rj) && moveRef(doc, rj, dir, err)) {
          moved.add(rj.id);
          changed = true;
        } else if (canMove(ri) && moveRef(doc, ri, dir, -err)) {
          moved.add(ri.id);
          changed = true;
        }
      }
      // Equal spacing between the outermost references.
      if (live.eq && live.refs.length >= 3) {
        const g2 = dimensionGeometry(doc, walls, doc.get(dim.id));
        const order = g2.order;
        const first = g2.pos[order[0]];
        const last = g2.pos[order.at(-1)];
        const step = (last - first) / (order.length - 1);
        order.forEach((ri, k) => {
          if (k === 0 || k === order.length - 1) return;
          const want = first + step * k;
          const err = want - g2.pos[ri];
          if (Math.abs(err) < 0.5) return;
          const ref = live.refs[ri];
          if (moveRef(doc, ref, dir, err)) {
            moved.add(ref.id);
            changed = true;
          }
        });
      }
    }
    if (!changed) break;
  }
  return moved;
}

/** Lock every segment of a dimension at its current length (or unlock them). */
export function lockAll(doc, walls, dim, on = true) {
  if (!on) return { locks: [] };
  const g = dimensionGeometry(doc, walls, dim);
  const locks = [];
  for (let k = 0; k + 1 < g.order.length; k++) {
    const i = g.order[k];
    const j = g.order[k + 1];
    locks.push({ i, j, value: Math.abs(g.pos[j] - g.pos[i]) });
  }
  return { locks };
}

