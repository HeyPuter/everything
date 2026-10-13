/**
 * Brush operations on the selection and the document's brush list. Every
 * change is one undo step.
 */
import { UserError } from '../../lib/errors.js';
import { docBrushes, setDocBrushes, brushById, brushUsers, copyBrush, uniqueBrushName } from './brush-model.js';
import { expandLive } from '../../model/live.js';
import { targetedItem, setItemAttrs } from '../paint/appearance-ops.js';
import { stackItems } from '../../model/appearance.js';

/** Paths and compound paths under the selection (groups contribute their leaves). */
export function brushTargets(editor) {
  if (!editor) return [];
  const doc = editor.doc;
  const out = new Map();
  const visit = (n) => {
    if (!n || n.locked) return;
    if (n.type === 'group' || n.type === 'layer') {
      for (const c of n.clip ? n.children.slice(0, -1) : n.children) visit(doc.get(c));
    } else if (n.type === 'compound') out.set(n.id, n);
    else if (n.type === 'path') {
      const p = doc.get(n.parent);
      if (p?.type === 'compound') out.set(p.id, p);
      else out.set(n.id, n);
    }
  };
  for (const id of editor.topSelection()) visit(doc.get(id));
  return [...out.values()];
}

/** The brush id shared by the selection's paths: an id, null (no brush), 'mixed', or undefined (nothing selected). */
export function selectionBrush(editor) {
  // A stroke picked in the Appearance panel shows its own brush.
  const item = pickedStroke(editor);
  if (item) {
    const ids = new Set(item.owners.map((n) => stackItems(n)[item.index]?.brush?.id || null));
    return ids.size === 1 ? [...ids][0] : 'mixed';
  }
  const t = brushTargets(editor);
  if (!t.length) return undefined;
  const ids = new Set(t.map((n) => n.brush?.id || null));
  return ids.size === 1 ? [...ids][0] : 'mixed';
}

const newSeed = () => Math.floor(Math.random() * 0x7fffffff);

/** The extra stroke picked in the Appearance panel (brushes and profiles go to it), or null. */
export function pickedStroke(editor) {
  const t = targetedItem(editor);
  return t?.item.type === 'stroke' ? t : null;
}

/**
 * Paint the selected paths with a brush (keeping their overrides when the
 * brush is the same). Paths without a stroke get the current stroke color.
 */
export function applyBrush(editor, brushId, label = 'Apply Brush') {
  const doc = editor.doc;
  const def = brushById(doc, brushId);
  if (!def) return false;
  const item = pickedStroke(editor);
  const targets = brushTargets(editor);
  if (!targets.length && !item) return false;
  doc.transact(label, () => {
    // A library brush the document does not hold yet joins its brushes.
    if (!docBrushes(doc).some((b) => b.id === def.id)) setDocBrushes(doc, [...docBrushes(doc), def]);
    if (item) {
      setItemAttrs(editor, item.index, { brush: (cur) => (cur?.id === brushId ? cur : { id: brushId, seed: newSeed() }) }, label);
      return;
    }
    for (const n of targets) {
      const patch = { brush: n.brush?.id === brushId ? n.brush : { id: brushId, seed: newSeed() } };
      if (!n.stroke) patch.stroke = editor.style.stroke || { type: 'solid', color: '#000000' };
      if (!(n.strokeWidth > 0)) patch.strokeWidth = 1;
      doc.update(n.id, patch);
    }
  });
  return true;
}

/** Remove Brush Stroke: back to a plain stroke. */
export function removeBrush(editor) {
  const doc = editor.doc;
  const item = pickedStroke(editor);
  if (item) return setItemAttrs(editor, item.index, { brush: undefined, brushPressure: undefined }, 'Remove Brush Stroke');
  const targets = brushTargets(editor).filter((n) => n.brush);
  if (!targets.length) return false;
  doc.transact('Remove Brush Stroke', () => {
    for (const n of targets) doc.update(n.id, { brush: undefined, brushPressure: undefined });
  });
  return true;
}

/** Set overrides (Options of Selected Object) on the selected brushed paths. */
export function setBrushOverrides(doc, ids, overrides) {
  for (const id of ids) {
    const n = doc.get(id);
    if (!n?.brush) continue;
    doc.update(id, { brush: { id: n.brush.id, seed: n.brush.seed, ...overrides } });
  }
}

/** Add a brush to the document's list (after `afterId` when given). Inside a transaction. */
export function addBrush(doc, brush, afterId = null) {
  const list = [...docBrushes(doc)];
  const i = afterId ? list.findIndex((b) => b.id === afterId) : -1;
  if (i >= 0) list.splice(i + 1, 0, brush);
  else list.push(brush);
  setDocBrushes(doc, list);
  return brush;
}

/** Replace a brush definition in the document's list. Inside a transaction. */
export function replaceBrush(doc, brush) {
  const list = docBrushes(doc).map((b) => (b.id === brush.id ? brush : b));
  if (!list.some((b) => b.id === brush.id)) list.push(brush);
  setDocBrushes(doc, list);
}

export function duplicateBrushes(doc, ids) {
  const out = [];
  doc.transact('Duplicate Brush', () => {
    for (const id of ids) {
      const def = brushById(doc, id);
      if (!def) continue;
      const copy = copyBrush(def, uniqueBrushName(doc, `${def.name} copy`));
      addBrush(doc, copy, id);
      out.push(copy.id);
    }
  });
  return out;
}

/**
 * Delete brushes. Objects using them are expanded (their brush becomes
 * plain artwork) or go back to plain strokes, as `inUse` says:
 * 'expand' | 'remove'.
 */
export function deleteBrushes(doc, ids, inUse = 'remove') {
  const gone = new Set(ids);
  doc.transact(ids.length > 1 ? 'Delete Brushes' : 'Delete Brush', () => {
    for (const id of ids) {
      for (const user of brushUsers(doc, id)) {
        if (inUse === 'expand') expandLive(doc, user);
        else doc.update(user, { brush: undefined, brushPressure: undefined });
      }
    }
    setDocBrushes(doc, docBrushes(doc).filter((b) => !gone.has(b.id)));
  });
}

/** Ids of the document's brushes no object uses. */
export function unusedBrushIds(doc) {
  const used = new Set();
  doc.walk((n) => {
    if (n.brush?.id) used.add(n.brush.id);
    return true;
  });
  return docBrushes(doc).filter((b) => !used.has(b.id)).map((b) => b.id);
}

/**
 * Select > Object > Brush Strokes: every visible, unlocked path painted with
 * a brush; with `type` ('bristle'), only strokes of brushes of that type.
 */
export function selectBrushStrokes(editor, type = null) {
  const out = [];
  const doc = editor.doc;
  editor.doc.walk((n) => {
    if (n.hidden || n.locked) return false;
    if ((n.type === 'path' || n.type === 'compound') && n.brush?.id && (!type || brushById(doc, n.brush.id)?.type === type)) out.push(n.id);
    return n.type !== 'compound';
  });
  if (!out.length) throw new UserError(type === 'bristle' ? 'No objects use a bristle brush.' : 'No objects use a brush.');
  editor.select(out);
  return out.length;
}

/** Move a brush within the list (reorder from the panel). */
export function moveBrush(doc, id, toIndex) {
  const list = [...docBrushes(doc)];
  const i = list.findIndex((b) => b.id === id);
  if (i < 0) return;
  const [b] = list.splice(i, 1);
  list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, b);
  doc.transact('Move Brush', () => setDocBrushes(doc, list));
}

/**
 * Clipboard support: copied objects carry the definitions of the brushes
 * they use, and pasting into another document adds the ones it lacks.
 */
export const brushClipboardHook = {
  copy(doc, ids, data) {
    const used = new Set();
    for (const item of data.items || []) for (const n of item.nodes || []) if (n.brush?.id) used.add(n.brush.id);
    data.brushes = [...used].map((id) => brushById(doc, id)).filter(Boolean);
  },
  paste(doc, data) {
    const have = new Set(docBrushes(doc).map((b) => b.id));
    const missing = (data.brushes || []).filter((b) => !have.has(b.id));
    if (missing.length) setDocBrushes(doc, [...docBrushes(doc), ...missing]);
  },
};
