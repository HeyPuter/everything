/**
 * Spatial index over model space entities (R-tree), kept in sync with a
 * Drawing's change events. Used for picking, window selection and snapping.
 * Construction lines (xline, ray) are infinite and kept in a separate list.
 */
import RBush from 'rbush';
import { entityBounds } from './geom/index.js';
import { emitEntity, makeContext, BoundsSink } from './tessellate.js';
import { blocksUsing } from './display.js';

const COMPLEX = new Set(['text', 'mtext', 'dimension', 'leader', 'insert', 'point']);
/** Objects whose extents depend on text and dimension styles and unit formats. */
const STYLED = new Set(['text', 'mtext', 'dimension', 'leader', 'insert']);
/** Header keys that change dimension text, and so dimension and block extents. */
const BOUNDS_HEADER_KEYS = ['linearFormat', 'linearPrecision', 'angularFormat', 'angularPrecision'];

export class SpatialIndex {
  constructor(drawing) {
    this.drawing = drawing;
    this.tree = new RBush(12);
    this.items = new Map();
    this.infinite = new Set();
    this.rebuild();
  }

  /** Bounds of one entity, including text, dimensions and block references. */
  boundsOf(ent) {
    if (!COMPLEX.has(ent.type)) {
      const b = entityBounds(ent);
      if (b && ent.type === 'polyline' && ent.width > 0) return this._drawnBounds(ent, b);
      if (b) return b;
    }
    if (ent.type === 'point') return [ent.x, ent.y, ent.x, ent.y];
    return this._drawnBounds(ent, null);
  }

  /**
   * Bounds of the entity as drawn (text strokes, blocks, the band of a wide
   * polyline), joined with `base` when given.
   */
  _drawnBounds(ent, base) {
    const sink = new BoundsSink();
    const tol = base ? Math.max(base[2] - base[0], base[3] - base[1], ent.width || 0) * 1e-4 || 1e-6 : boundsTol(ent);
    const ctx = makeContext(this.drawing, { tol, pointSize: 0, patterns: false, bounds: true });
    // Bounds must not depend on layer visibility, so resolve as if visible.
    ctx.ignoreVisibility = true;
    try {
      emitEntity(ent, sink, ctx);
    } catch {
      return base;
    }
    const b = sink.bounds;
    if (!base || !b) return b ?? base;
    return [Math.min(b[0], base[0]), Math.min(b[1], base[1]), Math.max(b[2], base[2]), Math.max(b[3], base[3])];
  }

  rebuild() {
    this.tree.clear();
    this.items.clear();
    this.infinite.clear();
    const list = [];
    for (const ent of this.drawing.entities.values()) {
      const it = this._item(ent);
      if (it) list.push(it);
    }
    this.tree.load(list);
  }

  _item(ent) {
    if (ent.type === 'xline' || ent.type === 'ray') {
      this.infinite.add(ent.id);
      return null;
    }
    const b = this.boundsOf(ent);
    if (!b) return null;
    const it = { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], id: ent.id };
    this.items.set(ent.id, it);
    return it;
  }

  /** Apply a Drawing change record. */
  applyChange(change) {
    // Bulk loading beats item-by-item inserts for very large edits.
    const styles = change.tableNames && (change.tableNames.has('textStyles') || change.tableNames.has('dimStyles'));
    const units = change.headerKeys && BOUNDS_HEADER_KEYS.some((k) => change.headerKeys.has(k));
    let ids = change.ids;
    // Styles and unit formats only move text, dimensions and the blocks that may hold them.
    if (styles || units) {
      ids = new Set(ids);
      for (const [id, e] of this.drawing.entities) if (STYLED.has(e.type)) ids.add(id);
    }
    if (ids.size > Math.max(5000, this.items.size / 4)) {
      this.rebuild();
      return;
    }
    // A redefined block moves only the references that use it (or a block nesting it).
    if (change.blocks.size) {
      ids = new Set(ids);
      const affected = blocksUsing(this.drawing, change.blocks);
      for (const [id, e] of this.drawing.entities) if (e.type === 'insert' && affected.has(e.name)) ids.add(id);
    }
    for (const id of ids) {
      const old = this.items.get(id);
      if (old) {
        this.tree.remove(old);
        this.items.delete(id);
      }
      this.infinite.delete(id);
      const ent = this.drawing.entities.get(id);
      if (ent) {
        const it = this._item(ent);
        if (it) this.tree.insert(it);
      }
    }
  }

  /** Ids whose bounds intersect the rectangle (plus all construction lines if includeInfinite). */
  search(minX, minY, maxX, maxY, includeInfinite = true) {
    const out = this.tree.search({ minX, minY, maxX, maxY }).map((it) => it.id);
    if (includeInfinite) for (const id of this.infinite) out.push(id);
    return out;
  }

  /** Ids whose bounds lie fully inside the rectangle. */
  searchInside(minX, minY, maxX, maxY) {
    return this.tree
      .search({ minX, minY, maxX, maxY })
      .filter((it) => it.minX >= minX && it.maxX <= maxX && it.minY >= minY && it.maxY <= maxY)
      .map((it) => it.id);
  }

  bounds(id) {
    const it = this.items.get(id);
    return it ? [it.minX, it.minY, it.maxX, it.maxY] : null;
  }

  /** Extents of everything (finite entities only), or null when empty. */
  extents(filter) {
    let b = null;
    for (const it of this.items.values()) {
      if (filter && !filter(it.id)) continue;
      if (!b) b = [it.minX, it.minY, it.maxX, it.maxY];
      else {
        if (it.minX < b[0]) b[0] = it.minX;
        if (it.minY < b[1]) b[1] = it.minY;
        if (it.maxX > b[2]) b[2] = it.maxX;
        if (it.maxY > b[3]) b[3] = it.maxY;
      }
    }
    return b;
  }
}

function boundsTol(ent) {
  const h = ent.h || 1;
  return Math.max(h * 0.05, 1e-6);
}
