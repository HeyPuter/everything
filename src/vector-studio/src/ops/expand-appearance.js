/**
 * Object > Expand Appearance: turn live artwork and live geometry effects
 * into ordinary, editable objects that look the same.
 *
 *  - live objects (repeats, symbol instances, blends, groups with effects)
 *    become plain groups of their generated artwork
 *  - paths with geometry effects (Roughen, Warp, Round Corners, ...) get the
 *    effect baked into their anchors
 *  - feature modules add more through `appearanceExpanders`: entries
 *    { test(doc, node) -> bool, expand(doc, node) -> bool } run for every
 *    object in the expanded subtrees inside the transaction (e.g. brush
 *    strokes into outlines)
 */
import { isLive, expandLive } from '../model/live.js';
import { geomEffectsOf, effectiveSubpaths, isGeomEffectType, paintParts } from '../model/geom-effects.js';
import { createPath } from '../model/nodes.js';
import { uid } from '../lib/ids.js';

export const appearanceExpanders = [];

/** Whether Expand Appearance would change anything about a node or its descendants. */
export function hasExpandableAppearance(doc, node, hooks = appearanceExpanders) {
  if (!node) return false;
  if (isLive(node) || geomEffectsOf(node)) return true;
  if (hooks.some((h) => h.test?.(doc, node))) return true;
  return Boolean(node.children?.some((c) => hasExpandableAppearance(doc, doc.get(c), hooks)));
}

/** Bake a path or compound's geometry effects into its anchors (inside a transaction). */
export function bakeGeometryEffects(doc, node) {
  const subs = effectiveSubpaths(doc, node);
  const effects = (node.effects || []).filter((e) => !isGeomEffectType(e.type));
  const parts = paintParts(node, subs);
  if (!parts && node.type === 'path' && subs.length === 1) {
    doc.update(node.id, { anchors: subs[0].anchors, closed: subs[0].closed, shape: undefined, effects });
    return doc.get(node.id);
  }
  const { id, type, parent, anchors, closed, shape, children, ...style } = node;
  const p = doc.get(parent);
  const index = p ? p.children.indexOf(id) : Infinity;
  doc.remove(id);
  if (!parts) {
    const b = shapeFrom({ ...style, effects }, subs);
    return doc.insert(b.node, parent, index, b.descendants);
  }
  // Outlines that paint differently (Scribble hatching, Crop Marks) become a group of objects.
  const gid = uid('g');
  const { opacity, blendMode, isolate, knockout, name } = node;
  const group = { id: gid, type: 'group', name: name || '', children: [], clip: false, hidden: false, locked: false, opacity: opacity ?? 1, blendMode: blendMode || 'normal', effects };
  if (isolate) group.isolate = true;
  if (knockout) group.knockout = true;
  const out = doc.insert(group, parent, index);
  for (const part of parts) {
    const plain = part.subpaths.map(({ paint, ...s }) => s);
    const b = shapeFrom({ ...style, ...part.style, name: '', effects: [], opacity: 1, blendMode: 'normal' }, plain);
    doc.insert(b.node, gid, Infinity, b.descendants);
  }
  return doc.get(out.id);
}

/** A path (one outline) or compound path with `style`: { node, descendants } for insert(). */
function shapeFrom(style, subs) {
  if (subs.length === 1) return { node: createPath(subs[0].anchors, subs[0].closed, style), descendants: [] };
  // Several outlines (a Transform effect's copies, a compound) become one compound path.
  const kids = subs.map((s) => createPath(s.anchors, s.closed, { fill: null, stroke: null }));
  const cid = uid('c');
  const compound = { ...style, id: cid, type: 'compound', children: kids.map((k) => k.id), fillRule: style.fillRule || 'nonzero', hidden: false, locked: false };
  return { node: compound, descendants: kids.map((k) => ({ ...k, parent: cid })) };
}

/** Expand one object's appearance (inside a transaction). Returns the resulting node id. */
export function expandNodeAppearance(doc, id, hooks = appearanceExpanders) {
  let node = doc.get(id);
  if (!node) return id;
  if (isLive(node)) node = expandLive(doc, id) || node;
  const visit = (nid) => {
    let n = doc.get(nid);
    if (!n) return nid;
    if (isLive(n)) n = expandLive(doc, nid) || n;
    for (const h of hooks) {
      if (h.test?.(doc, n) && h.expand(doc, n)) n = doc.get(n.id) || n;
    }
    if ((n.type === 'path' || n.type === 'compound') && geomEffectsOf(n)) n = bakeGeometryEffects(doc, n) || n;
    if (n.children && n.type !== 'compound') for (const c of [...n.children]) visit(c);
    return n.id;
  };
  return visit(node.id);
}

/** Expand the appearance of the editor's selection. Returns true when something changed. */
export function expandAppearance(editor, label = 'Expand Appearance') {
  const doc = editor.doc;
  const ids = editor.topSelection().filter((id) => hasExpandableAppearance(doc, doc.get(id)));
  if (!ids.length) return false;
  const out = [];
  doc.transact(label, () => {
    for (const id of ids) out.push(expandNodeAppearance(doc, id));
    editor.select(out.filter((id) => doc.get(id)));
  });
  return true;
}
