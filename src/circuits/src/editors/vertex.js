// Corner (vertex) editing for wires, lines, rectangles, polygons and tracks.

import { simplifyPolyline } from '../core/geom.js';

const POLY_TYPES = new Set(['wire', 'bus', 'gline', 'pour', 'region']);

export function isVertexEditable(o) {
  return !!o && (POLY_TYPES.has(o.t) || o.t === 'track' || o.t === 'grect' || o.t === 'dim');
}

/** Draggable points of an object. */
export function handlesOf(o) {
  if (POLY_TYPES.has(o.t)) {
    const out = [];
    for (let i = 0; i < o.pts.length; i += 2) out.push({ index: i / 2, x: o.pts[i], y: o.pts[i + 1] });
    return out;
  }
  if (o.t === 'track' || o.t === 'dim') return [{ index: 0, x: o.x1, y: o.y1 }, { index: 1, x: o.x2, y: o.y2 }];
  if (o.t === 'grect') return [{ index: 0, x: o.x1, y: o.y1 }, { index: 1, x: o.x2, y: o.y1 }, { index: 2, x: o.x2, y: o.y2 }, { index: 3, x: o.x1, y: o.y2 }];
  return [];
}

/**
 * Removes corners where an open polyline doubles back along itself
 * (A -> B -> C on one line with C heading back towards A): the overlap is a
 * dead stub, and A -> C covers the rest with the same two ends. A wire
 * folded entirely onto itself collapses to a point, which callers reject.
 */
function dropFoldBacks(pts) {
  const out = [...pts];
  for (let i = 2; i + 3 < out.length; ) {
    const ax = out[i - 2], ay = out[i - 1], bx = out[i], by = out[i + 1], cx = out[i + 2], cy = out[i + 3];
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const dot = (bx - ax) * (cx - bx) + (by - ay) * (cy - by);
    if (cross === 0 && dot < 0) {
      out.splice(i, 2);
      const merged = simplifyPolyline(out);
      out.length = 0;
      out.push(...merged);
      i = 2;
    } else i += 2;
  }
  return out;
}

/** Returns the object with one vertex moved. */
export function moveVertex(o, index, x, y) {
  if (POLY_TYPES.has(o.t)) {
    const pts = [...o.pts];
    pts[index * 2] = x;
    pts[index * 2 + 1] = y;
    const closed = o.t === 'pour' || o.t === 'region';
    // Open polylines merge collinear corners; closed outlines keep their corners.
    return { ...o, pts: closed ? pts : dropFoldBacks(simplifyPolyline(pts)) };
  }
  if (o.t === 'track' || o.t === 'dim') return index === 0 ? { ...o, x1: x, y1: y } : { ...o, x2: x, y2: y };
  if (o.t === 'grect') {
    const r = { ...o };
    if (index === 0 || index === 3) r.x1 = x; else r.x2 = x;
    if (index === 0 || index === 1) r.y1 = y; else r.y2 = y;
    return r;
  }
  return o;
}

/** Adds the vertex editing methods to an editor class. */
export function installVertexEditing(Editor, drawPreview) {
  Object.assign(Editor.prototype, {
    vertexHandles() {
      if (this.selection.size !== 1 || this.tool !== this.select || this.select.move) return [];
      const [id] = this.selection;
      const o = this.doc.store.get(id);
      if (!isVertexEditable(o) || o.locked) return [];
      return handlesOf(o).map((hd) => ({ ...hd, id }));
    },
    vertexAt(x, y) {
      const reach = 6 * this.nmPerPx;
      let best = null, bd = reach;
      for (const hd of this.vertexHandles()) {
        const d = Math.hypot(hd.x - x, hd.y - y);
        if (d <= bd) { bd = d; best = hd; }
      }
      return best;
    },
    beginVertexDrag(hd) {
      this.hidden.add(hd.id);
      this._dirtyMain = true;
      this._dirtyLayers?.add('*');
      this.requestRender(true);
    },
    drawVertexDrag(b, v) {
      const o = this.doc.store.get(v.id);
      if (o) drawPreview(this, b, moveVertex(o, v.index, v.x, v.y));
    },
    endVertexDrag(v, commit) {
      this.hidden.delete(v.id);
      this._dirtyMain = true;
      this._dirtyLayers?.add('*');
      const o = this.doc.store.get(v.id);
      if (commit && o) {
        const next = moveVertex(o, v.index, v.x, v.y);
        const degenerate = next.pts ? next.pts.length < ((o.t === 'pour' || o.t === 'region') ? 6 : 4) : false;
        if (!degenerate) this.doc.store.transact('Move corner', (s) => s.update(v.id, next));
      }
      this.requestRender(true);
    },
  });
}
