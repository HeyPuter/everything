/**
 * Appearance stacks: any number of fills and strokes on one object, each
 * with its own paint, opacity, blending mode, visibility and effects.
 *
 * Objects keep their single fill and stroke in the plain style fields
 * (node.fill, node.stroke, strokeWidth, ...), which is all most objects ever
 * need. An object with more carries `node.appearance`: its items in paint
 * order (the first paints first, at the bottom):
 *
 *   { type: 'fill', base: true, ...attrs }    the object's own fill (node.fill)
 *   { type: 'stroke', base: true, ...attrs }  the object's own stroke (node.stroke
 *                                             and its stroke options)
 *   { type: 'fill', fill, ...attrs }          another fill
 *   { type: 'stroke', stroke, strokeWidth, strokeCap, strokeJoin, miterLimit,
 *     strokeAlign, dash, dashOffset, dashAlign, arrowStart, arrowEnd,
 *     widthProfile, brush, ...attrs }         another stroke with its own options
 *   { type: 'contents' }                      where a group's or layer's
 *                                             children (or a type object's
 *                                             characters) paint
 *
 * attrs: opacity (0..1), blendMode, hidden (the eye is off) and effects
 * ([{ type, ...params }], geometry and raster effects for just this item).
 * Base items read their paint from the node, so every tool that sets
 * node.fill or node.stroke keeps working and edits the base items. Paths and
 * compound paths have base items; type objects paint their characters with
 * their own fill and stroke (the contents item) and groups and layers carry
 * only extra items around their contents.
 *
 * The object's own opacity, blending, opacity mask and raster effects apply
 * to the whole stack, and its geometry effects to every item (after the
 * item's own). A stack draws as live artwork (model/live.js): every item is
 * a virtual copy of the object painted with just that item, so rendering,
 * hit testing, visual bounds, the exporters and Expand Appearance (one path
 * per fill and stroke) all follow without knowing about stacks. Layers are
 * not live; the renderer and the exporters draw their items through
 * layerAppearanceArtwork().
 *
 * Basic stacks (one base fill under one base stroke, no item attributes)
 * are stored without `appearance` at all: see normalizeAppearance().
 */
import { registerLive, virtualId, virtualView } from './live.js';
import { isGeomEffectType, baseSubpaths, subpathsBounds } from './geom-effects.js';
import { transformHooks, transformPaint, nodeBounds } from './geometry.js';

/** Stroke options a stroke item carries (base strokes keep them on the node). */
export const STROKE_ATTRS = ['strokeWidth', 'strokeCap', 'strokeJoin', 'miterLimit', 'strokeAlign', 'dash', 'dashOffset', 'dashAlign', 'arrowStart', 'arrowEnd', 'widthProfile', 'brush', 'brushPressure'];

/** Stroke options an extra stroke starts from (and falls back to). */
export const STROKE_DEFAULTS = Object.freeze({
  strokeWidth: 1,
  strokeCap: 'butt',
  strokeJoin: 'miter',
  miterLimit: 10,
  strokeAlign: 'center',
  dash: Object.freeze([]),
  dashOffset: 0,
  arrowStart: null,
  arrowEnd: null,
});

/** Per-item attributes besides the paint and stroke options. */
export const ITEM_ATTRS = ['opacity', 'blendMode', 'hidden', 'effects'];

const PAINTED = new Set(['path', 'compound', 'text']);
const CONTAINERS = new Set(['group', 'layer']);

/** Whether a node type can carry an appearance stack. */
export function canHaveAppearance(node) {
  return Boolean(node && (PAINTED.has(node.type) || CONTAINERS.has(node.type)));
}

/** Objects whose stack has base fill and stroke items (their own paint fields). */
export function hasBasePaint(node) {
  return node?.type === 'path' || node?.type === 'compound';
}

/** True when a node carries a (non-empty) appearance stack. */
export function hasAppearanceStack(node) {
  return Boolean(node && Array.isArray(node.appearance) && node.appearance.length && canHaveAppearance(node));
}

/**
 * The node's stack as stored items, with the implicit ones filled in: a
 * node without `appearance` has its base fill under its base stroke (paths)
 * or just its contents (type, groups, layers). A stored stack that lost a
 * base item gets it back (a base fill at the bottom, a base stroke above
 * the last fill), so node.fill and node.stroke always have a place.
 */
export function stackItems(node) {
  if (!node) return [];
  const list = hasAppearanceStack(node) ? node.appearance.filter((it) => it && typeof it === 'object') : [];
  if (hasBasePaint(node)) {
    const out = list.slice();
    if (!out.some((it) => it.type === 'fill' && it.base)) out.unshift({ type: 'fill', base: true });
    if (!out.some((it) => it.type === 'stroke' && it.base)) {
      let at = 0;
      out.forEach((it, i) => {
        if (it.type === 'fill') at = i + 1;
      });
      out.splice(at, 0, { type: 'stroke', base: true });
    }
    return out.filter((it) => it.type !== 'contents');
  }
  if (canHaveAppearance(node)) {
    const out = list.filter((it) => !it.base);
    if (!out.some((it) => it.type === 'contents')) out.unshift({ type: 'contents' });
    return out;
  }
  return [];
}

/** The paint an item draws with (base items read the node's own), or null. */
export function itemPaint(node, item) {
  if (!item || item.type === 'contents') return null;
  if (item.base) return node[item.type] ?? null;
  return item[item.type] ?? null;
}

/** The stroke options an item strokes with: the node's for the base stroke. */
export function itemStrokeAttrs(node, item) {
  const src = item.base ? node : item;
  const out = {};
  for (const k of STROKE_ATTRS) {
    const v = src[k] !== undefined ? src[k] : item.base ? undefined : STROKE_DEFAULTS[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** An item's style fields as an applyStyle-like patch: { fill } or { stroke, strokeWidth, ... }. */
export function itemStyle(node, item) {
  if (item.type === 'fill') return { fill: itemPaint(node, item) };
  if (item.type === 'stroke') return { stroke: itemPaint(node, item), ...itemStrokeAttrs(node, item) };
  return {};
}

function hasItemAttrs(item) {
  return (item.opacity ?? 1) !== 1 || (item.blendMode && item.blendMode !== 'normal') || Boolean(item.hidden) || Boolean(item.effects?.length);
}

/**
 * Whether a stack (stored items) is the basic appearance: for paths a base
 * fill below a base stroke without item attributes, for others only their
 * contents.
 */
export function isBasicStack(node, items) {
  if (hasBasePaint(node)) {
    return items.length === 2 && items[0].type === 'fill' && items[0].base && items[1].type === 'stroke' && items[1].base && !hasItemAttrs(items[0]) && !hasItemAttrs(items[1]);
  }
  return items.length === 1 && items[0].type === 'contents';
}

/** Copy an item without empty attributes (normal blending, full opacity, no effects). */
function cleanItem(item) {
  const out = { ...item };
  if (out.opacity === undefined || out.opacity === 1) delete out.opacity;
  if (!out.blendMode || out.blendMode === 'normal') delete out.blendMode;
  if (!out.hidden) delete out.hidden;
  if (!out.effects?.length) delete out.effects;
  if (out.base) {
    delete out.fill;
    delete out.stroke;
    for (const k of STROKE_ATTRS) delete out[k];
  }
  return out;
}

/** Patch storing `items` as the node's stack: { appearance } or { appearance: undefined } when basic. */
export function normalizeAppearance(node, items) {
  const list = items.map(cleanItem);
  return { appearance: isBasicStack(node, list) ? undefined : list };
}

// ---- paints (swatches, recoloring) ----

/** Every paint a node's extra stack items use (the base ones are node.fill / node.stroke). */
export function stackPaints(node) {
  if (!hasAppearanceStack(node)) return [];
  const out = [];
  for (const it of node.appearance) if (it && !it.base && (it.type === 'fill' || it.type === 'stroke') && it[it.type]) out.push(it[it.type]);
  return out;
}

/**
 * Map the paints of a node's extra stack items: fn(paint, kind) returns the
 * paint (the same object when unchanged). Returns the new appearance array,
 * or null when nothing changed.
 */
export function mapStackPaints(node, fn) {
  if (!hasAppearanceStack(node)) return null;
  let changed = false;
  const out = node.appearance.map((it) => {
    if (!it || it.base || (it.type !== 'fill' && it.type !== 'stroke') || !it[it.type]) return it;
    const p = fn(it[it.type], it.type);
    if (p === it[it.type]) return it;
    changed = true;
    return { ...it, [it.type]: p };
  });
  return changed ? out : null;
}

// ---- artwork ----

const objectGeomEffects = (node) => (node.effects || []).filter((e) => e && !e.hidden && isGeomEffectType(e.type));

/** Strip a type object's per-character paint so an item paints every character alike. */
function plainRuns(runs) {
  if (!runs) return runs;
  return runs.map((r) => {
    if (!('fill' in r) && !('stroke' in r) && !('strokeWidth' in r)) return r;
    const { fill, stroke, strokeWidth, ...rest } = r;
    return rest;
  });
}

/** The node as one item of its stack: paints only with that item. */
function itemNode(node, item, objFx, frame) {
  const { appearance, opacityMask, graphicStyle, isolate, knockout, ...rest } = node;
  const own = item.effects || [];
  const v = {
    ...rest,
    id: virtualId(node.id),
    source: node.source || node.id,
    opacity: item.opacity ?? 1,
    blendMode: item.blendMode || 'normal',
    effects: [...own, ...objFx.map((e) => (e.frame || !frame ? e : { ...e, frame }))],
  };
  if (item.type === 'fill') {
    v.fill = itemPaint(node, item);
    v.stroke = null;
    for (const k of ['brush', 'brushPressure', 'widthProfile', 'dashAlign']) delete v[k];
    v.arrowStart = null;
    v.arrowEnd = null;
  } else {
    v.fill = null;
    v.stroke = itemPaint(node, item);
    if (!item.base) {
      for (const k of STROKE_ATTRS) delete v[k];
      Object.assign(v, itemStrokeAttrs(node, item));
    }
  }
  if (node.type === 'text' && !item.base) v.runs = plainRuns(node.runs);
  return v;
}

/** The node itself drawn as its contents item: its own children or characters. */
function contentsNode(node, objFx) {
  const { appearance, opacityMask, graphicStyle, ...rest } = node;
  return { ...rest, id: virtualId(node.id), source: node.source || node.id, opacity: 1, blendMode: 'normal', effects: objFx, isolate: undefined, knockout: undefined };
}

/**
 * A container's fill or stroke item: its paintable descendants painted
 * with the item (keeping clipping), as a virtual group carrying the item's
 * opacity, blending and raster effects.
 */
function containerItem(doc, g, item, extra) {
  const paint = itemPaint(g, item);
  const style = item.type === 'fill' ? { fill: paint, stroke: null } : { fill: null, stroke: paint, ...itemStrokeAttrs(g, item) };
  const fx = item.effects || [];
  const geom = fx.filter((e) => isGeomEffectType(e.type));
  const raster = fx.filter((e) => !isGeomEffectType(e.type));
  const copy = (n, isMask = false) => {
    if (!n || n.hidden) return null;
    if (isMask) return n.id;
    if (n.type === 'path' || n.type === 'compound' || n.type === 'text') {
      const { appearance, opacityMask, graphicStyle, brush, brushPressure, widthProfile, ...rest } = n;
      const v = { ...rest, id: virtualId(n.id), source: n.id, ...style, opacity: 1, blendMode: 'normal', effects: [...(n.effects || []).filter((e) => isGeomEffectType(e.type)), ...geom] };
      if (item.type === 'fill') {
        v.arrowStart = null;
        v.arrowEnd = null;
      }
      if (n.type === 'text') v.runs = plainRuns(n.runs);
      extra.set(v.id, v);
      return v.id;
    }
    if (n.type === 'group' && !n.live && !n.blend) {
      const kids = n.children.map((c, i) => copy(doc.get(c), n.clip && i === n.children.length - 1)).filter(Boolean);
      const { appearance, opacityMask, graphicStyle, ...rest } = n;
      const v = { ...rest, id: virtualId(n.id), children: kids, opacity: 1, blendMode: 'normal', effects: (n.effects || []).filter((e) => isGeomEffectType(e.type)) };
      extra.set(v.id, v);
      return v.id;
    }
    return null;
  };
  const kids = g.children.map((c, i) => copy(doc.get(c), g.type === 'group' && g.clip && i === g.children.length - 1)).filter(Boolean);
  const root = { id: virtualId(g.id), type: 'group', name: '', children: kids, clip: g.type === 'group' && Boolean(g.clip), hidden: false, locked: false, opacity: item.opacity ?? 1, blendMode: item.blendMode || 'normal', effects: raster, source: g.id };
  extra.set(root.id, root);
  return root.id;
}

/**
 * The generated artwork of a stack: { items, extra } for model/live.js.
 * Hidden items and items without paint draw nothing.
 */
export function generateAppearance(doc, node) {
  const extra = new Map();
  const items = [];
  const container = CONTAINERS.has(node.type);
  const objFx = container ? [] : objectGeomEffects(node);
  // Object-level geometry effects frame every item alike (an Offset Path on one stroke must not move a Warp).
  const frame = objFx.length && node.type !== 'text' ? subpathsBounds(baseSubpaths(doc, node)) : null;
  for (const item of stackItems(node)) {
    if (item.hidden) continue;
    if (item.type === 'contents') {
      if (container) {
        const geom = objectGeomEffects(node);
        // Children draw as themselves (clickable); clipping and group effects need the group's structure.
        if (node.type === 'layer' || (!node.clip && !geom.length && !node.knockout)) items.push(...node.children);
        else {
          const v = contentsNode(node, geom);
          extra.set(v.id, v);
          items.push(v.id);
        }
      } else {
        const v = contentsNode(node, objFx);
        extra.set(v.id, v);
        items.push(v.id);
      }
      continue;
    }
    if (item.type !== 'fill' && item.type !== 'stroke') continue;
    const paint = itemPaint(node, item);
    if (!paint) continue;
    if (item.type === 'stroke' && !(itemStrokeAttrs(node, item).strokeWidth > 0)) continue;
    if (container) {
      items.push(containerItem(doc, node, item, extra));
      continue;
    }
    const v = itemNode(node, item, objFx, frame);
    extra.set(v.id, v);
    items.push(v.id);
  }
  return { items, extra };
}

registerLive('appearance', {
  // The selection box stays on the object's own geometry.
  bounds: 'source',
  test: (n) => n.type !== 'layer' && hasAppearanceStack(n),
  generate: generateAppearance,
});

const layerCache = new WeakMap();

/**
 * A layer's stack artwork (layers are not live objects): { items, vdoc }
 * like liveArtwork(), cached while the layer and its subtree are unchanged.
 */
export function layerAppearanceArtwork(doc, layer) {
  const snap = [];
  const walk = (id) => {
    const n = doc.get(id);
    if (!n) return;
    snap.push(n);
    if (n.children) for (const c of n.children) walk(c);
  };
  for (const c of layer.children) walk(c);
  const hit = layerCache.get(layer);
  if (hit && hit.doc === doc && hit.snap.length === snap.length && hit.snap.every((n, i) => n === snap[i])) return hit.result;
  const g = generateAppearance(doc, layer);
  const vdoc = virtualView(doc, g.extra);
  const result = { items: g.items.map((id) => vdoc.get(id)).filter(Boolean), vdoc, extra: g.extra };
  layerCache.set(layer, { doc, snap, result });
  return result;
}

// ---- transforms ----

/**
 * Keep a stack in step with its object: gradient and pattern paints of the
 * extra items move, turn and stretch with it, and with Scale Strokes &
 * Effects their stroke weights scale too.
 */
function stackTransformPatch(node, m, opts, doc) {
  if (!hasAppearanceStack(node)) return null;
  const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const bounds = () => (doc ? nodeBounds(doc, node) : null);
  let changed = false;
  const appearance = node.appearance.map((it) => {
    if (!it || it.base || (it.type !== 'fill' && it.type !== 'stroke')) return it;
    let out = it;
    const p = it[it.type];
    const tp = p ? transformPaint(p, m, bounds, opts) : p;
    if (tp !== p) out = { ...out, [it.type]: tp };
    if (it.type === 'stroke' && opts.scaleStrokes && s !== 1 && it.strokeWidth > 0) out = { ...out, strokeWidth: it.strokeWidth * s };
    if (out !== it) changed = true;
    return out;
  });
  return changed ? { appearance } : null;
}

transformHooks.push(stackTransformPatch);
