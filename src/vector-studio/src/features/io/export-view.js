/**
 * A read-only document view for the exporters with live artwork baked:
 * every live object (blends, repeats, symbol instances, ...) reads as a
 * plain group of its generated artwork, and paths with geometry effects
 * (Roughen, Warp, ...) read with the effect applied to their anchors, so
 * SVG, PDF and print output match the screen. Feature modules bake more
 * through `exportBakers` (io/hooks.js), such as pattern fills; writers that
 * handle a kind natively name it in `native`. Documents with nothing to
 * bake are returned unchanged. `keep(node)` can leave chosen live objects
 * as they are (symbol instances written as <use>).
 */
import { liveDef, liveArtwork, virtualId } from '../../model/live.js';
import { geomEffectsOf, effectiveSubpaths, isGeomEffectType, paintParts } from '../../model/geom-effects.js';
// Blends are registered by the module that computes their steps.
import '../artboards/blend-math.js';
import { exportBakers, exportSkipIds } from './hooks.js';
import { VDocument } from '../../model/document.js';

export { exportBakers };

/**
 * The document as it is now, for exporters that yield while they work
 * (raster tiles, PDF pages): edits made meanwhile do not reach the file
 * halfway through. Nodes are immutable, so this copies only the node map.
 * Views and other read-only sources are returned as they are.
 */
export function frozenDocument(doc) {
  if (!(doc instanceof VDocument)) return doc;
  const copy = new VDocument();
  for (const [id, n] of doc.nodes) copy.nodes.set(id, n);
  copy.assets = doc.assets;
  return copy;
}

export function exportView(doc, { keep = null, native = [] } = {}) {
  const bakers = exportBakers.filter((b) => !native.includes(b.key));
  const skip = exportSkipIds(doc);
  let any = skip.size > 0;
  doc.walk((n) => {
    if (any) return false;
    if (liveDef(n) || ((n.type === 'path' || n.type === 'compound') && geomEffectsOf(n)) || bakers.some((b) => b.test(n))) any = true;
    return !any;
  });
  if (!any) return doc;

  const extra = new Map();
  const memo = new Map();
  const view = {
    get: (id) => {
      if (memo.has(id)) return memo.get(id);
      const n = bake(extra.get(id) || doc.get(id));
      memo.set(id, n);
      return n;
    },
    has: (id) => extra.has(id) || doc.has(id),
    assets: doc.assets,
    root: doc.root,
    name: doc.name,
    artboards: doc.artboards,
    walk: (fn, id = 'root', depth = 0) => {
      const n = view.get(id);
      if (!n) return;
      if (id !== 'root' && fn(n, depth) === false) return;
      if (n.children) for (const c of n.children) view.walk(fn, c, depth + 1);
    },
  };

  function bake(n) {
    if (!n) return n;
    if (skip.has(n.id)) return { ...n, hidden: true };
    for (const b of bakers) if (b.test(n)) n = b.bake(n, view, extra);
    const def = liveDef(n);
    // Kinds the exporters write natively (gradient meshes) stay as they are.
    if (def?.exportSelf) return n;
    if (def && !keep?.(n)) {
      // Generate against the baked view so nested live sources arrive baked too.
      const { items, extra: more } = liveArtwork(view, n);
      for (const [id, v] of more) extra.set(id, v);
      for (const it of items) if (!view.has(it.id)) extra.set(it.id, it);
      const { live, blend, transform, symbol, ...plain } = n;
      if (n.type === 'path' || n.type === 'compound') {
        // A live path (brush stroke) becomes a group: only its group-level settings carry over.
        const { anchors, closed, shape, fill, stroke, fillRule, ...rest } = plain;
        const effects = (n.effects || []).filter((e) => !isGeomEffectType(e.type));
        return { ...rest, effects, type: 'group', clip: false, children: items.map((it) => it.id) };
      }
      return { ...plain, type: 'group', clip: false, children: items.map((it) => it.id) };
    }
    if ((n.type === 'path' || n.type === 'compound') && geomEffectsOf(n)) {
      const subs = effectiveSubpaths(view, n);
      const effects = (n.effects || []).filter((e) => !isGeomEffectType(e.type));
      const parts = paintParts(n, subs);
      if (!parts) return shapeOf({ ...n, effects }, subs);
      // Outlines that paint differently (Scribble hatching, Crop Marks) export as objects of their own.
      const kids = parts.map((p) => {
        const v = shapeOf({ ...n, ...p.style, id: virtualId(n.id), parent: n.id, effects: [], opacity: 1, blendMode: 'normal' }, p.subpaths);
        extra.set(v.id, v);
        return v.id;
      });
      const { anchors, closed, shape, fillRule, ...rest } = n;
      return { ...rest, type: 'group', clip: false, effects, children: kids };
    }
    return n;
  }

  /** A path (one outline) or compound path with the given outlines in place of the node's own. */
  function shapeOf(n, subs) {
    if (n.type === 'path' && subs.length === 1) return { ...n, anchors: subs[0].anchors, closed: subs[0].closed, shape: undefined };
    const kids = subs.map((s) => {
      const id = virtualId(n.id);
      extra.set(id, { id, type: 'path', parent: n.id, anchors: s.anchors, closed: s.closed });
      return id;
    });
    return { ...n, type: 'compound', children: kids, fillRule: n.fillRule || 'nonzero', anchors: undefined, closed: undefined, shape: undefined };
  }
  return view;
}
