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
 * Items whose element is not a plain copy of the object's outline (their
 * own geometry effects, inside or outside strokes, arrowheads, width
 * profiles, brushes) also carry data-appearance-spec: their stroke options
 * and geometry effects as JSON. The stack group then carries the object's
 * own outline (data-appearance-d, path data) and its object-level geometry
 * effects (data-appearance-fx), so the stack can be rebuilt even when no
 * item draws the plain outline.
 *
 * Import: such a group whose items share one outline (or that names its
 * outline) becomes a single object with that stack again; each item keeps
 * the opacity, blending and effects its element carried. Anything else
 * stays a plain group.
 */
import { hasAppearanceStack, generateAppearance, normalizeAppearance, STROKE_ATTRS } from '../../model/appearance.js';
import { isGeomEffectType } from '../../model/geom-effects.js';
import { createPath, createCompound } from '../../model/nodes.js';

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const geomFx = (n) => (n?.effects || []).filter((e) => e && isGeomEffectType(e.type));

/** Whether an item element will not be a plain copy of the outline with the item's paint. */
function needsSpec(n) {
  if (geomFx(n).length) return true;
  if (n.fill && !n.stroke) return false;
  return Boolean((n.strokeAlign && n.strokeAlign !== 'center') || n.arrowStart || n.arrowEnd || n.widthProfile || n.brush || (n.dashAlign && n.dash?.length));
}

function subpathsOfNode(view, n) {
  if (n.type === 'path') return [{ anchors: n.anchors, closed: n.closed }];
  return (n.children || []).map((c) => view.get(c)).filter((c) => c?.anchors).map((c) => ({ anchors: c.anchors, closed: c.closed }));
}

/**
 * exportBakers entry (runs before live artwork is drawn): stack objects
 * keep their own outline and object-level geometry effects, items that
 * will not draw the plain outline keep their options.
 */
export const appearanceSpecBaker = {
  key: 'appearanceSpec',
  test: (n) => ((n.type === 'path' || n.type === 'compound') && hasAppearanceStack(n) && !n.appearanceSource) || (Boolean(n.appearanceItem) && !n.appearanceSpec && needsSpec(n)),
  bake(n, view) {
    if (!n.appearanceItem) return { ...n, appearanceSource: { subpaths: subpathsOfNode(view, n), effects: geomFx(n) } };
    // Object-level geometry effects come last in an item's effects: keep only the item's own.
    const objectFx = geomFx(view.get(n.source)).length;
    const own = geomFx(n);
    const props = { effects: own.slice(0, Math.max(0, own.length - objectFx)) };
    if (n.stroke) for (const k of STROKE_ATTRS) if (n[k] !== undefined && n[k] !== null) props[k] = n[k];
    return { ...n, appearanceSpec: props };
  },
};

/** Extra attributes for exported elements (svgExportHooks.attrs; `w` is the SVG writer). */
export function appearanceAttrs(node, w) {
  if (node.appearanceItem) {
    let out = ` data-appearance-item="${node.appearanceItem}"`;
    if (node.appearanceSpec) out += ` data-appearance-spec="${escapeAttr(JSON.stringify(node.appearanceSpec))}"`;
    return out;
  }
  if (node.type === 'group' && hasAppearanceStack(node)) {
    let out = ' data-appearance="stack"';
    const src = node.appearanceSource;
    if (src?.subpaths?.length && w?.d) {
      out += ` data-appearance-d="${w.d(src.subpaths)}"`;
      if (src.effects.length) out += ` data-appearance-fx="${escapeAttr(JSON.stringify(src.effects))}"`;
    }
    return out;
  }
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

const parseJSON = (s, fallback) => {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

/** The first node (depth first, in paint order) under id that paints `kind`. */
function paintingNode(nodes, id, kind) {
  const n = nodes.get(id);
  if (!n) return null;
  if ((n.type === 'path' || n.type === 'compound') && (kind === 'fill' ? n.fill : n.stroke && n.strokeWidth > 0)) return n;
  for (const c of n.children || []) {
    const hit = paintingNode(nodes, c, kind);
    if (hit) return hit;
  }
  return null;
}

/**
 * A marked group's items as one object with a stack (inside the SVG
 * importer): `kids` are the item elements, `ids` the nodes made from them
 * (one each). `opts.stack` is the group element and `opts.outline(d)`
 * turns path data in the group's coordinates into document subpaths.
 * Returns the merged node's id, or null to keep the group.
 */
export function mergeAppearanceGroup(nodes, kids, ids, { stack = null, outline = null } = {}) {
  if (!ids.length || kids.length !== ids.length) return null;
  const specs = kids.map((k) => (k.hasAttribute('data-appearance-spec') ? parseJSON(k.getAttribute('data-appearance-spec'), {}) : null));
  const named = stack?.getAttribute('data-appearance-d');
  const own = named && outline ? outline(named).filter((s) => s.anchors.length > 1) : null;
  if (specs.some(Boolean) || own?.length) {
    const r = mergeWithSpecs(nodes, kids, ids, specs, own, stack);
    if (r) return r;
  }
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

/**
 * Rebuild a stack from items that carry their options (data-appearance-spec):
 * paints come from the imported elements, stroke options and geometry
 * effects from the spec, and the outline from the stack group (or an item
 * that draws it plainly).
 */
function mergeWithSpecs(nodes, kids, ids, specs, own, stack) {
  let outline = own?.length ? own : null;
  let template = null;
  if (!outline) {
    // An item without a spec draws the plain outline.
    const i = specs.findIndex((s) => !s);
    const n = i >= 0 ? nodes.get(ids[i]) : null;
    if (!n || (n.type !== 'path' && n.type !== 'compound')) return null;
    template = n;
    outline = n.type === 'path' ? [{ anchors: n.anchors, closed: n.closed }] : n.children.map((c) => nodes.get(c)).filter(Boolean).map((c) => ({ anchors: c.anchors, closed: c.closed }));
  }
  const items = [];
  const patch = { fill: null, stroke: null };
  let first = null;
  let rule = null;
  for (let i = 0; i < kids.length; i++) {
    const tag = String(kids[i].getAttribute('data-appearance-item') || '');
    const type = /stroke/.test(tag) ? 'stroke' : 'fill';
    const holder = nodes.get(ids[i]);
    const painter = paintingNode(nodes, ids[i], type);
    if (!holder || !painter) return null;
    if (painter.type === 'compound' && !rule) rule = painter.fillRule;
    const spec = specs[i] || {};
    const attrs = {};
    if ((holder.opacity ?? 1) !== 1) attrs.opacity = holder.opacity;
    if (holder.blendMode && holder.blendMode !== 'normal') attrs.blendMode = holder.blendMode;
    const raster = (holder.effects || []).filter((e) => !isGeomEffectType(e.type));
    const effects = [...(spec.effects || []), ...raster];
    if (effects.length) attrs.effects = effects;
    const strokeOpts = {};
    if (type === 'stroke') {
      for (const k of STROKE_ATTRS) {
        if (spec[k] !== undefined) strokeOpts[k] = spec[k];
        else if (!specs[i] && painter[k] !== undefined) strokeOpts[k] = painter[k];
      }
    }
    if (/base/.test(tag) && !items.some((it) => it.type === type && it.base)) {
      items.push({ type, base: true, ...attrs });
      if (type === 'fill') patch.fill = painter.fill;
      else Object.assign(patch, { stroke: painter.stroke, ...strokeOpts });
    } else if (type === 'fill') items.push({ type, fill: painter.fill, ...attrs });
    else items.push({ type, stroke: painter.stroke, ...strokeOpts, ...attrs });
    first ||= holder;
  }
  // The object: the outline with the stack, the first item's name.
  const fillRule = template?.fillRule || rule || 'nonzero';
  let merged;
  if (outline.length === 1) merged = createPath(outline[0].anchors, outline[0].closed, { fill: null, stroke: null });
  else {
    const kidsNodes = outline.map((s) => createPath(s.anchors, s.closed, { fill: null, stroke: null }));
    merged = createCompound(kidsNodes.map((k) => k.id), { fill: null, stroke: null }, { fillRule });
    for (const k of kidsNodes) nodes.set(k.id, { ...k, parent: merged.id });
  }
  const objectFx = stack?.hasAttribute('data-appearance-fx') ? parseJSON(stack.getAttribute('data-appearance-fx'), []) : [];
  merged = { ...merged, ...patch, name: first?.name || '', opacity: 1, blendMode: 'normal', effects: Array.isArray(objectFx) ? objectFx : [] };
  Object.assign(merged, normalizeAppearance(merged, items));
  if (merged.appearance === undefined) delete merged.appearance;
  for (const id of ids) removeTree(nodes, id);
  nodes.set(merged.id, merged);
  return merged.id;
}
