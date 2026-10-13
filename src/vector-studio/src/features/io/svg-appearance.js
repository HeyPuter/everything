/**
 * Appearance stacks (model/appearance.js) in SVG.
 *
 * Export: an object with several fills and strokes is written as a <g>
 * marked data-appearance holding one element per fill and stroke in paint
 * order (exportView draws the stack as live artwork); each item element
 * names its kind in data-appearance-item ("fill", "stroke", with " base"
 * for the object's own fill or stroke). A layer's stack is baked for every
 * exporter the same way.
 *
 * Import: such a group whose items share one outline becomes a single
 * object with that stack again; each item keeps the opacity, blending and
 * effects its element carried. Anything else stays a plain group.
 */
import { hasAppearanceStack, generateAppearance, normalizeAppearance, STROKE_ATTRS } from '../../model/appearance.js';

/** Extra attributes for exported elements (svgExportHooks.attrs). */
export function appearanceAttrs(node) {
  if (node.appearanceItem) return ` data-appearance-item="${node.appearanceItem}"`;
  if (node.type === 'group' && hasAppearanceStack(node)) return ' data-appearance="stack"';
  return '';
}

/** exportBakers entry: a layer's stack drawn around its contents. */
export const layerAppearanceBaker = {
  key: 'layerAppearance',
  test: (n) => n.type === 'layer' && hasAppearanceStack(n),
  bake(n, view, extra) {
    const g = generateAppearance(view, n);
    for (const [id, v] of g.extra) extra.set(id, v);
    return { ...n, appearance: undefined, children: g.items };
  },
};

/** One outline per node for comparing geometry: a key of rounded anchors, or null. */
function geometryKey(nodes, n) {
  const subs = n.type === 'path' ? [n] : n.type === 'compound' ? n.children.map((c) => nodes.get(c)).filter(Boolean) : null;
  if (!subs?.length) return null;
  const r = (v) => Math.round(v * 1000) / 1000;
  return JSON.stringify(subs.map((s) => [s.closed, s.anchors.map((a) => [r(a.x), r(a.y), r(a.ix), r(a.iy), r(a.ox), r(a.oy)])]));
}

function removeTree(nodes, id) {
  const n = nodes.get(id);
  if (!n) return;
  nodes.delete(id);
  for (const c of n.children || []) removeTree(nodes, c);
}

/**
 * A marked group's items as one object with a stack (inside the SVG
 * importer): `kids` are the item elements, `ids` the nodes made from them
 * (one each). Returns the merged node's id, or null to keep the group.
 */
export function mergeAppearanceGroup(nodes, kids, ids) {
  if (!ids.length || kids.length !== ids.length) return null;
  const list = ids.map((id) => nodes.get(id));
  if (list.some((n) => !n || (n.type !== 'path' && n.type !== 'compound'))) return null;
  const key = geometryKey(nodes, list[0]);
  if (!key || list.some((n) => geometryKey(nodes, n) !== key) || list.some((n) => n.type !== list[0].type)) return null;
  const items = [];
  let base = null;
  const patch = { fill: null, stroke: null };
  list.forEach((n, i) => {
    const tag = String(kids[i].getAttribute('data-appearance-item') || '');
    const attrs = {};
    if ((n.opacity ?? 1) !== 1) attrs.opacity = n.opacity;
    if (n.blendMode && n.blendMode !== 'normal') attrs.blendMode = n.blendMode;
    if (n.effects?.length) attrs.effects = n.effects;
    const paints = [];
    if (n.fill && !/stroke/.test(tag)) paints.push('fill');
    if (n.stroke && n.strokeWidth > 0 && !/fill/.test(tag)) paints.push('stroke');
    for (const type of paints) {
      const wantBase = /base/.test(tag) || (!tag && !items.some((it) => it.type === type && it.base));
      if (wantBase && !items.some((it) => it.type === type && it.base)) {
        items.push({ type, base: true, ...attrs });
        if (type === 'fill') patch.fill = n.fill;
        else {
          patch.stroke = n.stroke;
          for (const k of STROKE_ATTRS) if (n[k] !== undefined) patch[k] = n[k];
        }
        if (!base) base = n;
      } else if (type === 'fill') items.push({ type, fill: n.fill, ...attrs });
      else {
        const it = { type, stroke: n.stroke, ...attrs };
        for (const k of STROKE_ATTRS) if (n[k] !== undefined) it[k] = n[k];
        items.push(it);
      }
    }
  });
  const keep = base || list[0];
  const merged = { ...keep, ...patch, opacity: 1, blendMode: 'normal', effects: [] };
  Object.assign(merged, normalizeAppearance(merged, items));
  if (merged.appearance === undefined) delete merged.appearance;
  for (const n of list) if (n !== keep) removeTree(nodes, n.id);
  nodes.set(keep.id, merged);
  return keep.id;
}
