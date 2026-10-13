/**
 * Geometry effects applied to a group act on all of its artwork as one
 * piece: a Warp bends the whole group across the group's bounds rather than
 * each object across its own. The group is drawn as live artwork whose
 * generated copy hands the effect, framed by the group's bounds, down to
 * every path and type object inside.
 *
 * Effects with a `combine` hook (Pathfinder) work on the group's artwork
 * as a whole instead: the effects before one apply to each object, the
 * combining effect turns the resulting shapes into new ones (combine(items,
 * fx, info) with items [{ style, subpaths }] in paint order, returning new
 * items, or null while its result is still being computed), and the effects
 * after it apply to those.
 */
// Appearance stacks are tried before group effects (a group's stack hands its effects to its contents).
import './appearance.js';
import { registerLive, virtualId, liveDef, liveArtwork } from './live.js';
import { geomEffectsOf, geomEffectDef, geomEffectsToken, effectiveSubpaths, paintParts } from './geom-effects.js';
import { nodeBounds, unionRect } from './geometry.js';
import { pickStyle } from './nodes.js';

registerLive('groupEffects', {
  // The selection box stays on the source artwork, like any effect.
  bounds: 'source',
  test: (n) => n.type === 'group' && !n.live && !n.blend && Boolean(geomEffectsOf(n)),
  // Results computed in the background (Pathfinder, type outlines) regenerate when ready.
  deps: () => [geomEffectsToken()],
  generate(doc, g) {
    let frame = null;
    for (const c of g.children) {
      const cn = doc.get(c);
      if (cn && !cn.hidden) frame = unionRect(frame, nodeBounds(doc, cn));
    }
    if (!frame) return { items: [] };
    const fx = geomEffectsOf(g).map((e) => ({ ...e, frame: e.frame || frame }));
    if (fx.some((e) => geomEffectDef(e.type)?.combine)) return combineGroup(doc, g, fx, frame);
    const extra = new Map();
    const copy = (n) => {
      if (!n) return null;
      let v;
      if (n.type === 'path' || n.type === 'compound' || n.type === 'text') {
        v = { ...n, id: virtualId(n.id), source: n.id, effects: [...(n.effects || []), ...fx] };
        if (n.type === 'compound') v.children = n.children.map((c) => copy(doc.get(c))).filter(Boolean);
      } else if (n.type === 'group') {
        v = { ...n, id: virtualId(n.id), children: n.children.map((c) => copy(doc.get(c))).filter(Boolean) };
      } else return n.id;
      extra.set(v.id, v);
      return v.id;
    };
    // The copy keeps the group's structure (clipping, blends) but not its
    // paint-level settings: the group itself still applies opacity,
    // blending and raster effects around the generated artwork.
    const root = {
      ...g,
      id: virtualId(g.id),
      effects: [],
      opacity: 1,
      blendMode: 'normal',
      children: g.children.map((c) => copy(doc.get(c))).filter(Boolean),
    };
    extra.set(root.id, root);
    return { items: [root.id], extra };
  },
});

/**
 * Shapes of objects that are not made of anchors, from the modules that
 * know them: text(doc, node) -> [{ style, subpaths, fillRule }] | null
 * (glyph outlines; null while fonts load).
 */
export const shapeHooks = { text: null };

/**
 * The visible shapes of a group as combine() items, back to front: paths
 * and compound paths with their own geometry effects applied, type as its
 * glyph outlines, and the generated shapes of live artwork inside.
 */
export function shapeItems(doc, g) {
  const out = [];
  const visit = (vdoc, n) => {
    if (!n || n.hidden) return;
    if (n.type === 'path' || n.type === 'compound') {
      const subpaths = effectiveSubpaths(vdoc, n).filter((s) => s.anchors.length > 1);
      if (subpaths.length) out.push({ style: { ...pickStyle(n), effects: [] }, fillRule: n.fillRule, subpaths, source: n.source || n.id });
    } else if (n.type === 'group' && !liveDef(n)) {
      for (const c of n.children) visit(vdoc, vdoc.get(c));
    } else if (liveDef(n)) {
      const art = liveArtwork(vdoc, n);
      for (const it of art.items) visit(art.vdoc, it);
    } else if (n.type === 'text' && shapeHooks.text) {
      for (const it of shapeHooks.text(vdoc, n) || []) out.push(it);
    }
  };
  for (const c of g.children) visit(doc, doc.get(c));
  return out;
}

function combineGroup(doc, g, fx, frame) {
  let items = shapeItems(doc, g);
  for (const e of fx) {
    const def = geomEffectDef(e.type);
    if (def.combine) {
      const r = def.combine(items, e, { bounds: frame, node: g, doc });
      // Still computing: draw the shapes as they are until the result arrives.
      if (!r) break;
      items = r;
    } else {
      items = items.map((it) => {
        try {
          const subs = def.apply(it.subpaths, e, { bounds: frame, node: g, doc, pending: () => {} });
          return { ...it, subpaths: Array.isArray(subs) ? subs.filter((s) => s?.anchors?.length) : it.subpaths };
        } catch (err) {
          console.warn(`Effect ${e.type} failed`, err);
          return it;
        }
      });
    }
  }
  return finish(items, g);
}

/** Virtual nodes for combined items (a path or compound path per paint) inside a plain group. */
function finish(items, g) {
  const extra = new Map();
  const kids = [];
  const add = (style, subpaths, it) => {
    let node;
    if (subpaths.length === 1) {
      const s = subpaths[0];
      node = { ...style, id: virtualId(g.id), type: 'path', name: '', anchors: s.anchors, closed: s.closed, hidden: false, locked: false };
    } else {
      const children = subpaths.map((s) => {
        const id = virtualId(g.id);
        extra.set(id, { id, type: 'path', name: '', anchors: s.anchors, closed: s.closed, hidden: false, locked: false });
        return id;
      });
      node = { ...style, id: virtualId(g.id), type: 'compound', name: '', children, fillRule: it.fillRule || 'nonzero', hidden: false, locked: false };
    }
    if (it.source) node.source = it.source;
    extra.set(node.id, node);
    kids.push(node.id);
  };
  for (const it of items) {
    if (!it.subpaths.length) continue;
    // Outlines that paint differently (Scribble hatching) become objects of their own.
    const parts = paintParts(it.style, it.subpaths);
    if (parts) for (const p of parts) add({ ...it.style, ...p.style }, p.subpaths.map(({ paint, ...s }) => s), it);
    else add(it.style, it.subpaths, it);
  }
  const root = { id: virtualId(g.id), type: 'group', name: '', children: kids, clip: false, hidden: false, locked: false };
  extra.set(root.id, root);
  return { items: [root.id], extra };
}
