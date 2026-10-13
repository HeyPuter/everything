/**
 * Graphic styles: named appearances (fill, stroke and stroke options,
 * extra fills and strokes, opacity, blending and effects) stored in
 * doc.root.graphicStyles. New
 * documents show the built-in defaults until the list is edited.
 *
 * Applying a style links the object to it (node.graphicStyle = id). The
 * link holds while the object's appearance still matches the style, so
 * any later appearance edit breaks it; Redefine Graphic Style updates the
 * style and every object still linked to it.
 */
import { pickStyle } from '../../model/nodes.js';
import { applyStyleDeep } from '../../tools/navigation.js';
import { uid } from '../../lib/ids.js';
import { createEffect } from './effects-model.js';
import { matchesStyle } from '../panels/select-commands.js';

const solid = (color) => ({ type: 'solid', color });

export const DEFAULT_GRAPHIC_STYLES = [
  { id: 'gs-default', name: 'Default Graphic Style', style: { fill: solid('#ffffff'), stroke: solid('#000000'), strokeWidth: 1, dash: [], opacity: 1, blendMode: 'normal', effects: [] } },
  { id: 'gs-soft-shadow', name: 'Soft Shadow', style: { fill: solid('#ffffff'), stroke: null, strokeWidth: 0, opacity: 1, blendMode: 'normal', effects: [createEffect('dropShadow', { x: 4, y: 6, blur: 8, opacity: 0.35 })] } },
  { id: 'gs-neon', name: 'Neon Glow', style: { fill: null, stroke: solid('#29e3ff'), strokeWidth: 4, strokeJoin: 'round', strokeCap: 'round', opacity: 1, blendMode: 'normal', effects: [createEffect('outerGlow', { color: '#29e3ff', blur: 6, opacity: 0.9, mode: 'normal' })] } },
  {
    id: 'gs-sunset',
    name: 'Sunset Fade',
    style: {
      fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#ffb347', opacity: 1 }, { offset: 1, color: '#e0457b', opacity: 1 }] },
      stroke: null,
      strokeWidth: 0,
      opacity: 1,
      blendMode: 'normal',
      effects: [],
    },
  },
  { id: 'gs-dashed', name: 'Dashed Outline', style: { fill: null, stroke: solid('#333333'), strokeWidth: 2, dash: [6, 4], dashAlign: 'corners', strokeCap: 'round', opacity: 1, blendMode: 'normal', effects: [] } },
  { id: 'gs-button', name: 'Soft Button', style: { fill: solid('#3d7bfd'), stroke: null, strokeWidth: 0, opacity: 1, blendMode: 'normal', effects: [createEffect('roundCorners', { radius: 8 }), createEffect('innerGlow', { color: '#ffffff', opacity: 0.45, blur: 6, mode: 'screen' }), createEffect('dropShadow', { x: 0, y: 3, blur: 4, opacity: 0.3 })] } },
  { id: 'gs-haze', name: 'Haze', style: { fill: solid('#7f5af0'), stroke: null, strokeWidth: 0, opacity: 0.8, blendMode: 'multiply', effects: [createEffect('blur', { radius: 4 })] } },
  { id: 'gs-paper', name: 'Paper Cutout', style: { fill: solid('#f4efe6'), stroke: solid('#d9cfc0'), strokeWidth: 1, opacity: 1, blendMode: 'normal', effects: [createEffect('dropShadow', { x: 2, y: 2, blur: 1, opacity: 0.4 })] } },
];

export function graphicStylesOf(doc) {
  return doc.root.graphicStyles || DEFAULT_GRAPHIC_STYLES;
}

/** Style fields of a node, including the extra stroke options this feature adds. */
export function styleOfNode(doc, node) {
  if (node.type === 'group') {
    // Groups contribute their own effects/opacity and the first leaf's paint.
    let leaf = null;
    const find = (n) => {
      if (leaf || !n) return;
      if (n.type === 'group') for (const c of n.children) find(doc.get(c));
      else if (n.type === 'path' || n.type === 'compound' || n.type === 'text') leaf = n;
    };
    find(node);
    const base = leaf ? styleOfNode(doc, leaf) : {};
    const out = { ...base, opacity: node.opacity ?? 1, blendMode: node.blendMode || 'normal', effects: structuredClone(node.effects || []) };
    if (node.appearance?.length) out.groupAppearance = structuredClone(node.appearance);
    return out;
  }
  const s = structuredClone(pickStyle(node));
  if (node.dashAlign) s.dashAlign = node.dashAlign;
  return s;
}

/**
 * Stroke options a style replaces even when it does not list them, so a
 * style's appearance replaces the object's whole appearance (no leftover
 * dashes or arrowheads from before).
 */
const STROKE_RESET = { strokeCap: 'butt', strokeJoin: 'miter', miterLimit: 10, strokeAlign: 'center', dash: [], dashOffset: 0, dashAlign: undefined, arrowStart: null, arrowEnd: null, appearance: undefined };

/** Apply a graphic style to the top-level selection, linking it when `id` is given. */
export function applyGraphicStyle(editor, style, id = null) {
  const doc = editor.doc;
  const top = editor.topSelection().map((nid) => doc.get(nid)).filter((n) => n && n.type !== 'layer');
  editor.setStyle(structuredClone(style));
  if (!top.length) return;
  doc.transact('Apply Graphic Style', () => applyStyleTo(doc, top, style, id));
}

/** Apply a style to nodes (inside a transaction). */
export function applyStyleTo(doc, nodes, style, id = null) {
  const paintPatch = { ...STROKE_RESET, ...style };
  delete paintPatch.effects;
  delete paintPatch.opacity;
  delete paintPatch.blendMode;
  delete paintPatch.groupAppearance;
  for (const n of nodes) {
    const own = { effects: structuredClone(style.effects || []), opacity: style.opacity ?? 1, blendMode: style.blendMode || 'normal', graphicStyle: id || undefined };
    if (n.type === 'group') {
      // A group's own fills and strokes (around its contents) come from a group's style.
      own.appearance = style.groupAppearance ? structuredClone(style.groupAppearance) : undefined;
      for (const c of n.children) applyStyleDeep(doc, doc.get(c), structuredClone(paintPatch));
      doc.update(n.id, own);
    } else if (n.type === 'image') doc.update(n.id, own);
    else applyStyleDeep(doc, n, { ...structuredClone(paintPatch), ...own });
  }
}

/** The graphic style a node is linked to (applied and not edited since), or null. */
export function linkedStyle(doc, node) {
  if (!node?.graphicStyle) return null;
  const gs = graphicStylesOf(doc).find((s) => s.id === node.graphicStyle);
  return gs && matchesStyle(doc, node, gs.style) ? gs : null;
}

/** Nodes in the document linked to a style. */
export function styleUsers(doc, id) {
  const out = [];
  for (const n of doc.nodes.values()) if (n.graphicStyle === id && linkedStyle(doc, n)) out.push(n);
  return out;
}

/** Styles no object in the document uses (by link or by matching appearance). */
export function unusedGraphicStyleIds(doc) {
  const list = graphicStylesOf(doc);
  const nodes = [];
  doc.walk((n) => {
    if (n.type !== 'layer') nodes.push(n);
  });
  return list.filter((gs) => !nodes.some((n) => n.graphicStyle === gs.id || matchesStyle(doc, n, gs.style))).map((gs) => gs.id);
}

/**
 * One style combining several: later styles' fill and stroke settings win,
 * effects stack in order, opacity multiplies and the last non-normal
 * blending mode wins.
 */
export function mergeStyles(styles) {
  const out = structuredClone(styles[0] || {});
  out.effects = [...(out.effects || [])];
  for (const st of styles.slice(1)) {
    for (const [k, v] of Object.entries(st)) {
      if (k === 'effects' || k === 'opacity' || k === 'blendMode') continue;
      if (k === 'fill' || k === 'stroke') {
        if (v) out[k] = structuredClone(v);
      } else if (v !== undefined) out[k] = structuredClone(v);
    }
    out.effects.push(...structuredClone(st.effects || []));
    out.opacity = (out.opacity ?? 1) * (st.opacity ?? 1);
    if (st.blendMode && st.blendMode !== 'normal') out.blendMode = st.blendMode;
  }
  if (out.stroke && !(out.strokeWidth > 0)) out.strokeWidth = 1;
  return out;
}

/** Sort styles by name (natural order). */
export function sortStylesByName(list) {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return list.slice().sort((a, b) => coll.compare(a.name, b.name));
}

/** Write the list (materializing the defaults on first edit). */
export function setGraphicStyles(doc, list) {
  doc.updateRoot({ graphicStyles: list });
}

export function newStyleId() {
  return uid('gs');
}
