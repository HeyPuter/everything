/**
 * Conversion between document nodes and geometry-engine shapes, and the
 * shared "replace these objects with results" transaction helpers.
 */
import { createPath, createCompound, createGroup, pickStyle, STYLE_KEYS } from '../../model/nodes.js';

/** Leaves that carry geometry (paths and compound paths), back to front, from the given ids. */
export function geometryLeaves(doc, ids, { skipHidden = true, skipLocked = true } = {}) {
  const out = [];
  const seen = new Set();
  const visit = (n) => {
    if (!n || seen.has(n.id)) return;
    // A path picked inside a compound path stands for the whole compound.
    if (n.type === 'path' && doc.get(n.parent)?.type === 'compound') n = doc.get(n.parent);
    if (seen.has(n.id)) return;
    seen.add(n.id);
    if (skipHidden && n.hidden) return;
    if (skipLocked && n.locked) return;
    if (n.type === 'path' || n.type === 'compound') out.push(n);
    else if (n.type === 'group' || n.type === 'layer') for (const c of n.children) visit(doc.get(c));
  };
  for (const id of doc.sortByPaintOrder(ids)) visit(doc.get(id));
  return out;
}

/** Subpaths of a path or compound node: [{ anchors, closed }]. */
export function subpathsOf(doc, node) {
  if (node.type === 'path') return node.anchors.length ? [{ anchors: node.anchors, closed: node.closed }] : [];
  if (node.type === 'compound') {
    return node.children
      .map((c) => doc.get(c))
      .filter((c) => c?.type === 'path' && c.anchors.length)
      .map((c) => ({ anchors: c.anchors, closed: c.closed }));
  }
  return [];
}

/** True for a path that only works as a line (open, unfilled). */
export function isOpenLine(node) {
  return node.type === 'path' && !node.closed && !node.fill;
}

/**
 * Engine shape for a node. `string` makes it a cutting line (Divide uses
 * open unfilled paths that way). `key` groups shapes for Merge and Merge Brush.
 */
export function shapeOf(doc, node, { string = false, key = -1 } = {}) {
  return {
    subpaths: subpathsOf(doc, node),
    filled: Boolean(node.fill),
    evenodd: node.fillRule === 'evenodd',
    string,
    key,
  };
}

/** Style fields of a node (paths and compounds keep their style on the node). */
export function styleOf(node) {
  return pickStyle(node);
}

/** A path or compound node built from a result record's subpaths. Returns { node, descendants } or null. */
export function nodeFromSubpaths(subpaths, style, extra = {}) {
  const sps = subpaths.filter((sp) => sp.anchors.length >= 2);
  if (!sps.length) return null;
  if (sps.length === 1) return { node: createPath(sps[0].anchors, sps[0].closed, style, extra), descendants: [] };
  const comp = createCompound([], style, { fillRule: 'nonzero', ...extra });
  const kids = sps.map((sp) => ({ ...createPath(sp.anchors, sp.closed, {}), parent: comp.id }));
  comp.children = kids.map((k) => k.id);
  return { node: comp, descendants: kids };
}

/** A group node holding built items: returns { node, descendants }. */
export function groupOf(items, extra = {}) {
  const g = createGroup([], extra);
  const descendants = [];
  for (const it of items) {
    g.children.push(it.node.id);
    descendants.push({ ...it.node, parent: g.id }, ...it.descendants);
  }
  return { node: g, descendants };
}

/** Where to put results: the parent and index just above the topmost of `nodes`. */
export function insertionPoint(doc, nodes) {
  const ids = doc.sortByPaintOrder(nodes.map((n) => n.id));
  const top = doc.get(ids[ids.length - 1]);
  const parent = doc.get(top.parent);
  return { parentId: parent.id, index: parent.children.indexOf(top.id) + 1 };
}

/**
 * Remove `remove` nodes and insert built items at the insertion point (in
 * order, back to front). Removes groups that become empty. Returns new ids.
 */
export function replaceWith(doc, remove, items, at = insertionPoint(doc, remove)) {
  const parentsToCheck = new Set();
  // Index shifts as earlier siblings are removed.
  let index = at.index;
  const parent = doc.get(at.parentId);
  for (const n of remove) {
    if (n.parent === at.parentId && parent.children.indexOf(n.id) < at.index) index--;
  }
  for (const n of remove) {
    if (!doc.has(n.id)) continue;
    if (n.parent) parentsToCheck.add(n.parent);
    doc.remove(n.id);
  }
  const out = [];
  for (const it of items) {
    doc.insert(it.node, at.parentId, index++, it.descendants);
    out.push(it.node.id);
  }
  // Groups (not layers) left empty by the operation go away.
  for (const pid of parentsToCheck) {
    const p = doc.get(pid);
    if (p && p.type === 'group' && !p.children.length) doc.remove(pid);
  }
  return out;
}

/** Style with stroke removed (Trim, Merge, Crop). */
export function fillOnly(style) {
  return { ...style, stroke: null };
}

/** A stable string key for a solid fill (Merge, Merge Brush); null when not a plain solid. */
export function solidKey(node) {
  const f = node.fill;
  if (!f || f.type !== 'solid') return null;
  return `${f.color.toLowerCase()}|${f.opacity ?? 1}`;
}

/** Identity snapshot so async jobs can detect edits made meanwhile. */
export function snapshot(doc, nodes) {
  const map = new Map();
  for (const n of nodes) {
    map.set(n.id, n);
    if (n.type === 'compound') for (const c of n.children) map.set(c, doc.get(c));
  }
  return map;
}

export function unchangedSince(doc, snap) {
  for (const [id, n] of snap) if (doc.get(id) !== n) return false;
  return true;
}

export { STYLE_KEYS };
