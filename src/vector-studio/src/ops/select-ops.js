/**
 * Select menu operations.
 */
import { UserError } from '../lib/errors.js';
import { nodeBounds, rectsIntersect } from '../model/geometry.js';

/** Top-level selectable objects (direct children of unlocked, visible layers). */
export function selectableTargets(editor) {
  const { doc } = editor;
  const out = [];
  const root = editor.isolation ? [editor.isolation] : doc.root.children;
  for (const lid of root) {
    const layer = doc.get(lid);
    if (!layer || layer.hidden || layer.locked) continue;
    for (const id of layer.children) {
      const n = doc.get(id);
      if (n && !n.hidden && !n.locked) out.push(id);
    }
  }
  return out;
}

export function selectAll(editor) {
  editor.select(selectableTargets(editor));
}

export function selectAllOnArtboard(editor) {
  const a = editor.artboard();
  if (!a) return;
  const ids = selectableTargets(editor).filter((id) => {
    const b = nodeBounds(editor.doc, editor.doc.get(id));
    return b && rectsIntersect(b, a);
  });
  editor.select(ids);
}

export function selectInverse(editor) {
  const sel = new Set(editor.topSelection());
  editor.select(selectableTargets(editor).filter((id) => !sel.has(id)));
}

/** All paintable leaves (paths, compounds, text) that are visible and unlocked. */
function leaves(editor) {
  const out = [];
  editor.doc.walk((n) => {
    if (n.hidden || n.locked) return false;
    if (n.type === 'compound') {
      out.push(n);
      return false;
    }
    if (n.type === 'path' || n.type === 'text' || n.type === 'image') out.push(n);
    return true;
  });
  return out;
}

/** A brush reference without its random seed (two strokes with the same brush and options match). */
const brushKey = (n) => {
  if (!n.brush?.id) return '';
  const { seed, ...rest } = n.brush;
  return JSON.stringify(rest);
};

const paintKey = (p) => (p ? JSON.stringify(p.type === 'solid' ? { t: 'solid', c: p.color.toLowerCase() } : { t: p.type, s: p.stops }) : 'none');

/** Select > Same > ... `what`: fill | stroke | fillStroke | strokeWeight | opacity | blendMode | appearance | shape */
export function selectSame(editor, what) {
  const ref = editor.selectedNodes().find((n) => n.type !== 'group' && n.type !== 'layer');
  if (!ref) throw new UserError('Select an object to match.');
  const keyOf = {
    fill: (n) => paintKey(n.fill),
    stroke: (n) => paintKey(n.stroke),
    fillStroke: (n) => paintKey(n.fill) + '|' + paintKey(n.stroke),
    strokeWeight: (n) => (n.stroke ? String(n.strokeWidth) : 'none'),
    opacity: (n) => String(n.opacity ?? 1),
    blendMode: (n) => n.blendMode || 'normal',
    // Brushes (with their per-stroke options) and width profiles are part of the appearance.
    appearance: (n) => [paintKey(n.fill), paintKey(n.stroke), n.strokeWidth, n.opacity ?? 1, n.blendMode, JSON.stringify(n.effects || []), brushKey(n), JSON.stringify(n.widthProfile || null), JSON.stringify(n.appearance || null)].join('|'),
    shape: (n) => n.shape?.kind || n.type,
  }[what];
  const target = keyOf(ref);
  editor.select(leaves(editor).filter((n) => n.type !== 'image' && keyOf(n) === target).map((n) => n.id));
}

/** Select > Object > ... `what`: text | clipping | stray | sameLayer */
export function selectObjects(editor, what) {
  const { doc } = editor;
  if (what === 'sameLayer') {
    const layers = new Set(editor.topSelection().map((id) => doc.layerOf(id)?.id));
    editor.select(selectableTargets(editor).filter((id) => layers.has(doc.layerOf(id)?.id)));
    return;
  }
  const out = [];
  doc.walk((n) => {
    if (n.hidden || n.locked) return false;
    if (what === 'text' && n.type === 'text') out.push(n.id);
    if (what === 'clipping' && n.type === 'group' && n.clip && n.children.length) out.push(n.children[n.children.length - 1]);
    if (what === 'stray' && n.type === 'path' && n.anchors.length === 1) out.push(n.id);
    return true;
  });
  editor.select(out);
}

/** Next object above/below the current one in stacking order (within its parent). */
export function selectNext(editor, dir) {
  const { doc } = editor;
  const sel = editor.topSelection();
  if (!sel.length) return;
  const id = dir > 0 ? sel[sel.length - 1] : sel[0];
  const n = doc.get(id);
  const parent = doc.get(n.parent);
  const i = parent.children.indexOf(id) + dir;
  const next = parent.children[i];
  if (next && !doc.get(next)?.locked) editor.select([next]);
}

/** Remember and restore selections (Select > Reselect). */
export function reselect(editor, last) {
  if (last) editor.select(last.filter((id) => editor.doc.has(id)));
}
