/**
 * Layer operations behind the Layers panel menu. Functions taking `doc`
 * run inside a transaction; the ones taking an editor open their own.
 *
 * The panel keeps its own row selection of layers ("picked" layers, see
 * layerPicks): the layers the menu's layer commands act on, next to the
 * artwork selection the object commands act on. With no picked layer the
 * active layer is the target.
 */
import { createLayer, defaultLabel, LAYER_COLORS } from '../model/nodes.js';

const picks = new WeakMap(); // editor -> Set of layer ids

/** The layers picked in the Layers panel for an editor (a live Set). */
export function layerPicks(editor) {
  let s = picks.get(editor);
  if (!s) picks.set(editor, (s = new Set()));
  return s;
}

/** Layers the layer commands act on, in stacking order (back to front): the picked layers, else the active layer. */
export function targetLayers(editor) {
  const doc = editor.doc;
  const ids = [...layerPicks(editor)].filter((id) => doc.get(id)?.type === 'layer');
  if (!ids.length) {
    const active = doc.get(editor.activeLayerId);
    if (active?.type === 'layer') ids.push(active.id);
    else if (doc.layers().length) ids.push(doc.layers().at(-1).id);
  }
  return doc.sortByPaintOrder(ids);
}

/** The node a "this item" command names: the frontmost selected object, else the active layer. */
export function currentItem(editor) {
  const sel = editor.topSelection();
  if (sel.length) return editor.doc.get(sel[sel.length - 1]);
  return editor.doc.get(targetLayers(editor).at(-1)) || null;
}

/** A layer name not used yet: "Layer N". */
export function nextLayerName(doc) {
  const used = new Set();
  doc.walk((n) => {
    if (n.type === 'layer') used.add(n.name);
    return n.type === 'layer';
  });
  let i = doc.layers().length + 1;
  for (let k = 1; k < i; k++) if (!used.has(`Layer ${k}`)) return `Layer ${k}`;
  while (used.has(`Layer ${i}`)) i++;
  return `Layer ${i}`;
}

function layerColor(doc) {
  const used = new Set();
  doc.walk((n) => {
    if (n.type === 'layer') used.add(n.color);
    return n.type === 'layer';
  });
  return LAYER_COLORS.find((c) => !used.has(c)) || LAYER_COLORS[used.size % LAYER_COLORS.length];
}

/** Insert a new (sub)layer under `parentId` at `index`. Returns the layer node. */
export function insertLayer(doc, parentId, index = Infinity, props = {}) {
  const layer = { ...createLayer(props.name || nextLayerName(doc), props.color || layerColor(doc)), ...props };
  if (!layer.name) layer.name = nextLayerName(doc);
  return doc.insert(layer, parentId, index);
}

/** Copies of nodes, each placed right above its original. Returns the copies' ids. */
export function duplicateNodes(doc, ids) {
  const out = [];
  for (const id of doc.sortByPaintOrder(ids)) {
    const n = doc.get(id);
    const parent = n && doc.get(n.parent);
    if (!parent) continue;
    const { node, descendants } = doc.cloneSubtree(id);
    if (n.type === 'layer') node.name = `${n.name || 'Layer'} copy`;
    doc.insert(node, parent.id, parent.children.indexOf(id) + 1, descendants);
    out.push(node.id);
  }
  return out;
}

/** Delete layers, keeping at least one top-level layer. Returns the number deleted. */
export function deleteLayers(doc, ids) {
  let n = 0;
  for (const id of ids) {
    const layer = doc.get(id);
    if (!layer || layer.type !== 'layer') continue;
    if (layer.parent === 'root' && doc.layers().length <= 1) break;
    doc.remove(id);
    n++;
  }
  return n;
}

/**
 * Merge Selected: the contents of every layer in `ids` move into `targetId`
 * (one of them), keeping their stacking order; the emptied layers go.
 */
export function mergeLayers(doc, ids, targetId) {
  const layers = doc.sortByPaintOrder(ids.filter((id) => doc.get(id)?.type === 'layer' && !doc.isAncestor(id, targetId)));
  if (!layers.includes(targetId) || layers.length < 2) return false;
  // Everything ends up in the target in global stacking order.
  const items = [];
  for (const id of layers) for (const c of doc.get(id).children) items.push(c);
  const ordered = doc.sortByPaintOrder(items);
  for (const c of ordered) doc.move(c, targetId);
  for (const id of layers) if (id !== targetId && doc.get(id)) doc.remove(id);
  return true;
}

/**
 * Flatten Artwork: every visible top-level layer's artwork moves into
 * `targetId`; hidden layers and their artwork are deleted; template layers
 * stay as they are.
 */
export function flattenLayers(doc, targetId) {
  const target = doc.layerOf(targetId);
  let top = target;
  while (top && top.parent !== 'root') top = doc.get(top.parent);
  if (!top) return false;
  const others = doc.layers().filter((l) => l.id !== top.id && !l.template);
  const items = [];
  for (const l of [top, ...others]) if (!l.hidden) for (const c of l.children) items.push(c);
  for (const c of doc.sortByPaintOrder(items)) doc.move(c, top.id);
  for (const l of others) doc.remove(l.id);
  if (top.hidden) doc.update(top.id, { hidden: false });
  return top.id;
}

/** Does flattening drop artwork (a hidden, non-template layer with contents)? */
export function flattenDiscards(doc) {
  return doc.layers().some((l) => l.hidden && !l.template && l.children.length);
}

/**
 * Collect in New Layer: objects (or layers) move into a new (sub)layer
 * created where the frontmost of them was. Returns the new layer id.
 */
export function collectInNewLayer(doc, ids) {
  const sorted = doc.sortByPaintOrder(ids.filter((id) => doc.get(id)));
  if (!sorted.length) return null;
  const front = doc.get(sorted.at(-1));
  let parent = doc.get(front.parent);
  let index = parent.children.indexOf(front.id) + 1;
  // Objects inside groups collect into a sublayer of their layer, above the group.
  if (front.type !== 'layer') {
    let n = front;
    while (parent && parent.type !== 'layer') {
      n = parent;
      parent = doc.get(parent.parent);
    }
    index = parent.children.indexOf(n.id) + 1;
  }
  const layer = insertLayer(doc, parent.id, index);
  for (const id of sorted) doc.move(id, layer.id);
  return layer.id;
}

/**
 * Release to Layers: the contents of a layer or group each go to a new
 * sublayer. Sequence: one object per layer. Build: each layer adds one more
 * object to copies of the ones below (for animation frames). A group's
 * layers are created in its layer where the group was, and the group goes.
 * Returns the new layer ids, back to front.
 */
export function releaseToLayers(doc, containerId, mode = 'sequence') {
  const c = doc.get(containerId);
  if (!c?.children?.length || c.type === 'compound' || c.type === 'root') return [];
  const kids = c.children.slice();
  let parentId = c.id;
  let index = 0;
  if (c.type !== 'layer') {
    const layer = doc.layerOf(c.id);
    // The group's position in its layer (walking up from nested groups).
    let n = c;
    while (n.parent !== layer.id) n = doc.get(n.parent);
    parentId = layer.id;
    index = layer.children.indexOf(n.id);
  } else {
    // Sublayers already in the layer stay below the new ones.
    index = 0;
  }
  const made = [];
  kids.forEach((kid, i) => {
    const node = doc.get(kid);
    if (!node || node.type === 'layer') return;
    const layer = insertLayer(doc, parentId, index + made.length, { name: `${defaultLabel(c)} ${made.length + 1}` });
    if (mode === 'build') {
      for (let j = 0; j < i; j++) {
        const below = doc.get(kids[j]);
        if (!below || below.type === 'layer') continue;
        const { node: copy, descendants } = doc.cloneSubtree(kids[j]);
        doc.insert(copy, layer.id, Infinity, descendants);
      }
    }
    doc.move(kid, layer.id);
    made.push(layer.id);
  });
  if (c.type !== 'layer' && !doc.get(c.id).children.length) doc.remove(c.id);
  return made;
}

/** Reverse Order: siblings in `ids` trade places (front to back). Returns true when anything moved. */
export function reverseOrder(doc, ids) {
  const byParent = new Map();
  for (const id of ids) {
    const n = doc.get(id);
    if (!n) continue;
    if (!byParent.has(n.parent)) byParent.set(n.parent, []);
    byParent.get(n.parent).push(id);
  }
  let moved = false;
  for (const [pid, group] of byParent) {
    if (group.length < 2) continue;
    const parent = doc.get(pid);
    const slots = group.map((id) => parent.children.indexOf(id)).sort((a, b) => a - b);
    const order = slots.map((s) => parent.children[s]).reverse();
    const children = parent.children.slice();
    slots.forEach((s, i) => (children[s] = order[i]));
    doc.update(pid, { children });
    moved = true;
  }
  return moved;
}

/** Top-level layers other than the ones holding `keepIds`. */
export function otherLayers(doc, keepIds) {
  const keep = new Set();
  for (const id of keepIds) {
    let n = doc.get(id);
    while (n && n.parent && n.parent !== 'root') n = doc.get(n.parent);
    if (n) keep.add(n.id);
  }
  return doc.layers().filter((l) => !keep.has(l.id));
}

/**
 * Hide / Outline / Lock Others: the other top-level layers get `key`;
 * when they all have it already, every layer is restored instead (Show
 * All, Preview All, Unlock All). Returns 'others' or 'all'.
 */
export function toggleOthers(doc, keepIds, key) {
  const others = otherLayers(doc, keepIds);
  if (!others.length) return null;
  const allSet = others.every((l) => l[key]);
  if (allSet) {
    for (const l of doc.layers()) if (l[key]) doc.update(l.id, { [key]: false });
    return 'all';
  }
  for (const l of others) if (!l[key]) doc.update(l.id, { [key]: true });
  return 'others';
}

/** Whether toggleOthers would restore all layers (for the menu label). */
export function othersAllSet(doc, keepIds, key) {
  const others = otherLayers(doc, keepIds);
  return others.length > 0 && others.every((l) => l[key]);
}

/** Template on or off for layers: a template is locked, does not print and dims its images. */
export function setTemplate(doc, ids, on) {
  for (const id of ids) {
    const l = doc.get(id);
    if (l?.type !== 'layer') continue;
    doc.update(id, on ? { template: true, locked: true, print: false } : { template: false, locked: false, print: true });
  }
}

/** The layer each top-level id lives in, by name (for Paste Remembers Layers). */
export function layerNamesOf(doc, ids) {
  return ids.map((id) => doc.layerOf(id)?.name ?? null);
}

/** The layer named `name` (searching sublayers too), created at the top when missing. */
export function layerNamed(doc, name) {
  let found = null;
  doc.walk((n) => {
    if (found) return false;
    if (n.type === 'layer' && n.name === name) found = n;
    return n.type === 'layer';
  });
  return found || insertLayer(doc, 'root', Infinity, { name });
}
