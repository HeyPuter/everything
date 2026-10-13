/**
 * Editing appearance stacks (model/appearance.js) for the selection: the
 * Appearance panel's commands, and the paint hooks that send the Color,
 * Swatches, Gradient and Stroke panels' edits to the fill or stroke picked
 * in the Appearance panel.
 *
 * The objects whose stacks are edited ("owners") are the selected objects
 * themselves: a path inside a compound path edits the compound, a group
 * its own stack (its contents keep theirs), and a layer targeted from the
 * Layers panel (editor.layerTarget) the layer's.
 *
 * Items are addressed by their index in stackItems(). The picked item
 * (editor.appearanceTarget, set by the Appearance panel) holds for the
 * owners it was picked on.
 */
import { stackItems, normalizeAppearance, canHaveAppearance, hasBasePaint, itemPaint, itemStrokeAttrs, STROKE_ATTRS, STROKE_DEFAULTS } from '../../model/appearance.js';
import { paintHooks, commonStyle, applyStyle } from '../../ops/paint-ops.js';

const clone = (v) => (v == null ? v : structuredClone(v));

/** The objects whose appearance the panel shows and edits. */
export function appearanceOwners(editor) {
  if (!editor) return [];
  const doc = editor.doc;
  const lt = editor.layerTarget;
  if (lt && lt.version === editor.selection.version && doc.get(lt.id)?.type === 'layer') return [doc.get(lt.id)];
  const out = new Map();
  for (const id of editor.topSelection()) {
    let n = doc.get(id);
    if (n?.type === 'path' && doc.get(n.parent)?.type === 'compound') n = doc.get(n.parent);
    if (n && n.type !== 'layer') out.set(n.id, n);
  }
  return [...out.values()];
}

/** Owners that can carry a stack. */
export function stackOwners(editor) {
  return appearanceOwners(editor).filter(canHaveAppearance);
}

/** A stack's shape: item kinds in order (owners with equal shapes edit together). */
export function stackShape(node) {
  return stackItems(node)
    .map((it) => (it.base ? `${it.type}*` : it.type))
    .join(',');
}

/** The owners' shared stack: { owners, items (the first owner's), same } or null without owners. */
export function sharedStack(editor) {
  const owners = stackOwners(editor);
  if (!owners.length) return null;
  const shape = stackShape(owners[0]);
  return { owners, items: stackItems(owners[0]), same: owners.every((n) => stackShape(n) === shape) };
}

/** Set the picked item (index into the stack) for the current owners; null picks none. */
export function setAppearanceTarget(editor, index) {
  if (!editor) return;
  editor.appearanceTarget = index == null ? null : { index, ids: stackOwners(editor).map((n) => n.id).join(',') };
  editor.emit('style');
}

/** The picked stack index while it still applies to the selection, else null. */
export function appearanceTargetIndex(editor) {
  const t = editor?.appearanceTarget;
  if (!t) return null;
  const st = sharedStack(editor);
  if (!st || st.owners.map((n) => n.id).join(',') !== t.ids) {
    // Another selection: the pick is over (and costs nothing from now on).
    editor.appearanceTarget = null;
    return null;
  }
  if (!st.same) return null;
  return t.index < st.items.length ? t.index : null;
}

/** The picked item when it is an extra fill or stroke (or any item of a group), else null. */
export function targetedItem(editor) {
  const i = appearanceTargetIndex(editor);
  if (i == null) return null;
  const st = sharedStack(editor);
  const it = st.items[i];
  if (!it || it.base || (it.type !== 'fill' && it.type !== 'stroke')) return null;
  return { index: i, item: it, owners: st.owners };
}

/**
 * Change every owner's stack: fn(items, node) returns new items (or
 * { items, patch } to change the node's own fields too). One undo step.
 */
export function editStacks(editor, label, fn, { coalesce = null, owners = null } = {}) {
  const list = owners || stackOwners(editor);
  if (!list.length) return false;
  const doc = editor.doc;
  doc.transact(
    label,
    () => {
      for (const o of list) {
        const n = doc.get(o.id);
        if (!n) continue;
        const r = fn(stackItems(n).map((it) => ({ ...it })), n);
        if (!r) continue;
        const items = Array.isArray(r) ? r : r.items;
        const patch = Array.isArray(r) ? {} : r.patch || {};
        doc.update(n.id, { ...patch, ...normalizeAppearance({ ...n, ...patch }, items) });
      }
    },
    { coalesce },
  );
  return true;
}

/** A new fill: the topmost fill's paint, or white. */
function newFill(node, items) {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].type === 'fill' && itemPaint(node, items[i])) return { type: 'fill', fill: clone(itemPaint(node, items[i])) };
  if (node.type === 'text' && node.fill) return { type: 'fill', fill: clone(node.fill) };
  return { type: 'fill', fill: { type: 'solid', color: '#ffffff' } };
}

/** A new stroke: the topmost stroke's paint and options, or 1 pt black. */
function newStroke(node, items) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'stroke' && itemPaint(node, items[i])) return { type: 'stroke', ...clone(itemStrokeAttrs(node, items[i])), stroke: clone(itemPaint(node, items[i])) };
  }
  return { type: 'stroke', ...clone(STROKE_DEFAULTS), dash: [], stroke: { type: 'solid', color: '#000000' } };
}

/**
 * Add New Fill / Add New Stroke: above the item at `above` (the picked
 * one), or at the top. An object whose own fill (stroke) is None and has
 * no other gets its own paint turned on instead. Returns the new item's
 * index (same for all owners), or null.
 */
export function addItem(editor, type, above = null) {
  const owners = stackOwners(editor);
  if (!owners.length) return null;
  let index = null;
  editStacks(editor, type === 'fill' ? 'Add New Fill' : 'Add New Stroke', (items, n) => {
    const baseIdx = items.findIndex((it) => it.base && it.type === type);
    const others = items.some((it) => it.type === type && !it.base);
    if (baseIdx >= 0 && !itemPaint(n, items[baseIdx]) && !others) {
      index = baseIdx;
      const patch = type === 'fill' ? { fill: { type: 'solid', color: '#ffffff' } } : { stroke: { type: 'solid', color: '#000000' }, ...(n.strokeWidth > 0 ? {} : { strokeWidth: 1 }) };
      return { items, patch };
    }
    const item = type === 'fill' ? newFill(n, items) : newStroke(n, items);
    const at = above != null && above < items.length ? above + 1 : items.length;
    items.splice(at, 0, item);
    index = at;
    return items;
  });
  if (index != null) setAppearanceTarget(editor, index);
  return index;
}

/** Duplicate Item: a copy of the item right above it (a base item's copy is an extra item). */
export function duplicateItem(editor, index) {
  let ok = false;
  editStacks(editor, 'Duplicate Item', (items, n) => {
    const it = items[index];
    if (!it || it.type === 'contents') return null;
    const copy = { ...clone(it) };
    if (it.base) {
      delete copy.base;
      copy[it.type] = clone(itemPaint(n, it));
      if (it.type === 'stroke') Object.assign(copy, clone(itemStrokeAttrs(n, it)));
    }
    items.splice(index + 1, 0, copy);
    ok = true;
    return items;
  });
  if (ok) setAppearanceTarget(editor, index + 1);
  return ok;
}

/** The node fields that make `item` the object's own fill or stroke. */
function promotePatch(item) {
  if (item.type === 'fill') return { fill: clone(item.fill ?? null) };
  const out = { stroke: clone(item.stroke ?? null) };
  for (const k of STROKE_ATTRS) out[k] = item[k] !== undefined ? clone(item[k]) : STROKE_DEFAULTS[k] !== undefined ? clone(STROKE_DEFAULTS[k]) : undefined;
  return out;
}

/**
 * Remove Item. Removing an object's own fill (stroke) makes the next fill
 * (stroke) its own, or sets it to None when there is no other.
 */
export function removeItem(editor, index) {
  let ok = false;
  editStacks(editor, 'Remove Item', (items, n) => {
    const it = items[index];
    if (!it || it.type === 'contents') return null;
    ok = true;
    if (!it.base) {
      items.splice(index, 1);
      return items;
    }
    // The nearest other item of the same kind (above first) takes over.
    let j = -1;
    for (let k = index + 1; k < items.length && j < 0; k++) if (items[k].type === it.type) j = k;
    for (let k = index - 1; k >= 0 && j < 0; k--) if (items[k].type === it.type) j = k;
    if (j < 0) return { items: items.map((x, k) => (k === index ? { type: it.type, base: true } : x)), patch: { [it.type]: null } };
    const next = items[j];
    const patch = promotePatch(next);
    const { opacity, blendMode, hidden, effects } = next;
    items[j] = { type: it.type, base: true, opacity, blendMode, hidden, effects };
    items.splice(index, 1);
    return { items, patch };
  });
  if (ok) setAppearanceTarget(editor, null);
  return ok;
}

/** Move an item to position `to` in the stack. */
export function moveItem(editor, from, to) {
  if (from === to) return false;
  const ok = editStacks(editor, 'Reorder Appearance', (items) => {
    if (!items[from] || to < 0 || to >= items.length) return null;
    const [it] = items.splice(from, 1);
    items.splice(to, 0, it);
    return items;
  });
  if (ok && editor.appearanceTarget?.index === from) setAppearanceTarget(editor, to);
  return ok;
}

/**
 * Change item attributes: opacity, blendMode, hidden, effects, or its
 * paint and stroke options (a base item's go to the object itself).
 */
export function setItemAttrs(editor, index, attrs, label = 'Change Appearance', coalesce = null) {
  return editStacks(
    editor,
    label,
    (items, n) => {
      const it = items[index];
      if (!it) return null;
      const own = {};
      const patch = {};
      for (const [k, v] of Object.entries(attrs)) {
        const paintKey = k === 'fill' || k === 'stroke' || STROKE_ATTRS.includes(k);
        if (paintKey && it.base) patch[k] = clone(v);
        else if (paintKey && it.type === 'contents') continue;
        else own[k] = clone(typeof v === 'function' ? v(it[k], it, n) : v);
      }
      items[index] = { ...it, ...own };
      return { items, patch };
    },
    { coalesce },
  );
}

/** Show or hide an item (the eye). */
export function toggleItem(editor, index) {
  const st = sharedStack(editor);
  const it = st?.items[index];
  if (!it) return false;
  return setItemAttrs(editor, index, { hidden: !it.hidden }, it.hidden ? 'Show Appearance Item' : 'Hide Appearance Item');
}

/** Clear Appearance: no fill, stroke, effects or stack; full opacity and normal blending. */
export function clearStacks(editor) {
  const owners = stackOwners(editor);
  if (!owners.length) return false;
  const doc = editor.doc;
  doc.transact('Clear Appearance', () => {
    for (const n of owners) {
      const patch = { appearance: undefined, effects: [], opacity: 1, blendMode: 'normal' };
      if (hasBasePaint(n) || n.type === 'text') Object.assign(patch, { fill: null, stroke: null });
      doc.update(n.id, patch);
    }
  });
  setAppearanceTarget(editor, null);
  return true;
}

/** Reduce to Basic Appearance: only the object's own fill and stroke, no effects (opacity stays). */
export function reduceStacks(editor) {
  const owners = stackOwners(editor);
  if (!owners.length) return false;
  const doc = editor.doc;
  doc.transact('Reduce to Basic Appearance', () => {
    for (const n of owners) doc.update(n.id, { appearance: undefined, effects: [] });
  });
  setAppearanceTarget(editor, null);
  return true;
}

/** Show All Hidden Attributes: turn every item's and effect's eye back on. */
export function showAllHidden(editor) {
  const owners = stackOwners(editor).filter((n) => stackItems(n).some((it) => it.hidden || it.effects?.some((e) => e.hidden)) || n.effects?.some((e) => e.hidden));
  if (!owners.length) return false;
  const unhide = (list) => list?.map((e) => {
    if (!e?.hidden) return e;
    const { hidden, ...rest } = e;
    return rest;
  });
  editStacks(
    editor,
    'Show All Hidden Attributes',
    (items, n) => ({ items: items.map((it) => ({ ...it, hidden: undefined, effects: unhide(it.effects) })), patch: n.effects?.length ? { effects: unhide(n.effects) } : {} }),
    { owners },
  );
  return true;
}

// ---- paint hooks ----

const itemKeys = (type) => (type === 'fill' ? ['fill'] : ['stroke', ...STROKE_ATTRS]);

/**
 * Route style edits to the picked fill or stroke: the matching keys of a
 * patch change that item, the rest go on as usual. Installed once by the
 * paint feature (wrapping hooks already there).
 */
export function installAppearanceHooks() {
  const prevApply = paintHooks.applyStyle;
  const prevCommon = paintHooks.commonStyle;
  paintHooks.applyStyle = (editor, patch, label, coalesce) => {
    if (prevApply?.(editor, patch, label, coalesce)) return true;
    const t = targetedItem(editor);
    if (!t) return false;
    const keys = itemKeys(t.item.type);
    const mine = Object.fromEntries(Object.entries(patch).filter(([k]) => keys.includes(k)));
    if (!Object.keys(mine).length) return false;
    const rest = Object.fromEntries(Object.entries(patch).filter(([k]) => !keys.includes(k)));
    if (mine.stroke && !(mine.strokeWidth > 0) && !(t.item.strokeWidth > 0)) mine.strokeWidth = 1;
    editor.doc.transact(label, () => {
      setItemAttrs(editor, t.index, mine, label);
      // Fields the item does not own (opacity, the other paint) apply to the objects as usual.
      if (Object.keys(rest).length) {
        const saved = editor.appearanceTarget;
        editor.appearanceTarget = null;
        try {
          applyStyle(editor, rest, label);
        } finally {
          editor.appearanceTarget = saved;
        }
      }
    }, { coalesce });
    editor.emit('style');
    return true;
  };
  paintHooks.commonStyle = (editor, key) => {
    const v = prevCommon?.(editor, key);
    if (v !== undefined) return v;
    const t = targetedItem(editor);
    if (!t || !itemKeys(t.item.type).includes(key)) return undefined;
    const vals = t.owners.map((n) => {
      const it = stackItems(n)[t.index];
      return key === t.item.type ? itemPaint(n, it) : itemStrokeAttrs(n, it)[key] ?? null;
    });
    const first = JSON.stringify(vals[0] ?? null);
    return vals.every((x) => JSON.stringify(x ?? null) === first) ? vals[0] ?? null : 'mixed';
  };
}

export { commonStyle };

/** The stack item new effects go to: the fill or stroke picked in the Appearance panel, or null for the object. */
export function effectItemIndex(editor) {
  const i = appearanceTargetIndex(editor);
  if (i == null) return null;
  const it = sharedStack(editor).items[i];
  return it && (it.type === 'fill' || it.type === 'stroke') ? i : null;
}

/** An object's effects (item null) or one stack item's. */
export function effectsOf(node, item = null) {
  if (item == null) return node?.effects || [];
  return stackItems(node)[item]?.effects || [];
}

/** Patch setting an object's effects (item null) or one stack item's. */
export function effectsPatch(node, item, list) {
  if (item == null) return { effects: list };
  return normalizeAppearance(node, stackItems(node).map((it, i) => (i === item ? { ...it, effects: list } : it)));
}
