/**
 * Conversion between document nodes and geometry-engine shapes, and the
 * shared "replace these objects with results" transaction helpers.
 */
import { createPath, createCompound, createGroup, pickStyle, STYLE_KEYS } from '../../model/nodes.js';
import { liveDef } from '../../model/live.js';
import { nodeBounds } from '../../model/geometry.js';
import { rectangle } from '../../model/shapes.js';
import { OP, runGeom } from './engine/index.js';

/** Live kinds of groups whose children are ordinary artwork (drawn as they are). */
const PLAIN_CONTENT_KINDS = new Set(['groupEffects', 'appearance']);

/** Whether a group is a live object (blend, Repeat, ...) whose children are its inputs rather than its artwork. */
export function isLiveContainer(n) {
  if (n?.type !== 'group') return false;
  const def = liveDef(n);
  return Boolean(def && !PLAIN_CONTENT_KINDS.has(def.key));
}

/** Whether a node is an input of a live object (inside a blend, a Repeat, ...). */
export function insideLive(doc, n) {
  for (let p = doc.get(n.parent); p; p = doc.get(p.parent)) if (isLiveContainer(p)) return true;
  return false;
}

/** "the blend" for a live group labeled "<Blend>". */
function liveLabel(node) {
  const def = liveDef(node);
  const raw = typeof def?.label === 'function' ? def.label(node) : def?.label;
  const name = String(raw || '').replace(/[<>]/g, '').trim().toLowerCase();
  return name ? `the ${name}` : 'live objects';
}

/** Message for a path operation given only live objects: "<what> works on paths. Expand the blend first (...)". */
export function expandLiveFirst(what, live) {
  return `${what} works on paths. Expand ${liveLabel(live)} first (Object > Expand).`;
}

/** Whether a node is a clipping group (a group whose last child clips the others). */
export function isClipGroup(n) {
  return n?.type === 'group' && Boolean(n.clip) && n.children.length > 0 && !liveDef(n);
}

/** Whether a node is the clipping path of its clipping group. */
export function isClipMask(doc, n) {
  const p = n && doc.get(n.parent);
  return isClipGroup(p) && p.children[p.children.length - 1] === n.id;
}

/** Whether a clipping path is (or contains) type, which the geometry engine cannot use. */
function maskHasText(doc, n) {
  if (!n) return false;
  if (n.type === 'text') return true;
  return n.type === 'group' && n.children.some((c) => maskHasText(doc, doc.get(c)));
}

/**
 * Leaves that carry geometry (paths and compound paths), back to front,
 * from the given ids. With `intoLive: false` the inputs of live groups are
 * left out (`skippedLive` collects those groups).
 *
 * With a `clipped` Map, a clipping group reached by the walk (selected as
 * a whole, or inside a selected group) gives its contents and not its
 * clipping path, which only shapes what the contents show: each content
 * leaf maps to { masks, group } (the clipping paths over it, outermost
 * first, and the outermost of those clipping groups). A clipping group
 * clipped by type is left out (`skippedClip` collects it). A clipping
 * path selected by itself (Direct Selection) is still a leaf.
 */
export function geometryLeaves(
  doc,
  ids,
  {
    skipHidden = true,
    skipLocked = true,
    intoLive = true,
    skippedLive = null,
    clipped = null,
    skippedClip = null,
  } = {},
) {
  const out = [];
  const seen = new Set();
  const visit = (n, clip) => {
    if (!n || seen.has(n.id)) return;
    // A path picked inside a compound path stands for the whole compound.
    if (n.type === 'path' && doc.get(n.parent)?.type === 'compound') n = doc.get(n.parent);
    if (seen.has(n.id)) return;
    seen.add(n.id);
    if (skipHidden && n.hidden) return;
    if (skipLocked && n.locked) return;
    if (n.type === 'path' || n.type === 'compound') {
      out.push(n);
      if (clip) clipped.set(n.id, clip);
    } else if (!intoLive && isLiveContainer(n)) skippedLive?.push(n);
    else if (clipped && isClipGroup(n)) {
      const mask = doc.get(n.children[n.children.length - 1]);
      if (maskHasText(doc, mask)) {
        skippedClip?.push(n);
        return;
      }
      seen.add(mask.id);
      const inner = clip
        ? { masks: [...clip.masks, mask], group: clip.group }
        : { masks: [mask], group: n };
      for (const c of n.children.slice(0, -1)) visit(doc.get(c), inner);
    } else if (n.type === 'group' || n.type === 'layer')
      for (const c of n.children) visit(doc.get(c), clip);
  };
  for (const id of doc.sortByPaintOrder(ids)) visit(doc.get(id), null);
  return out;
}

/** Path and compound leaves of a clipping path (itself, or the parts of a group), for snapshots. */
export function maskLeaves(doc, mask) {
  if (!mask) return [];
  if (mask.type === 'path' || mask.type === 'compound') return [mask];
  if (mask.type === 'group')
    return [mask, ...mask.children.flatMap((c) => maskLeaves(doc, doc.get(c)))];
  return [mask];
}

/**
 * Engine shape of a clipping path's area, as the renderer clips: a path by
 * its fill rule, a group by all its parts under non-zero, anything else
 * (an image) by its bounding box.
 */
function maskShape(doc, mask) {
  if (mask.type === 'path' || mask.type === 'compound')
    return { ...shapeOf(doc, mask), filled: true, string: false };
  const parts = (n) => {
    if (!n) return [];
    if (n.type === 'path' || n.type === 'compound') return subpathsOf(doc, n);
    if (n.type === 'group') return n.children.flatMap((c) => parts(doc.get(c)));
    const b = nodeBounds(doc, n);
    return b ? [{ anchors: rectangle(b.x, b.y, b.w, b.h), closed: true }] : [];
  };
  return { subpaths: parts(mask), filled: true, evenodd: false, string: false, key: -1 };
}

/** Bounding box of subpaths' anchors and handles. */
function boxOf(subpaths) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const sp of subpaths) {
    for (const a of sp.anchors) {
      for (const [x, y] of [
        [a.x, a.y],
        [a.ix ?? a.x, a.iy ?? a.y],
        [a.ox ?? a.x, a.oy ?? a.y],
      ]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}

const boxPath = (b, pad) => {
  const x0 = b.x0 - pad;
  const y0 = b.y0 - pad;
  const x1 = b.x1 + pad;
  const y1 = b.y1 + pad;
  const pt = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
  return { anchors: [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)], closed: true };
};

/**
 * What a clipped operand shows: its engine shape cut to every clipping path
 * over it. An area is intersected with them; a cutting line (`shape.string`)
 * keeps its parts inside them. Resolves to the cut shape, or null when
 * nothing of it shows.
 */
async function visibleShape(doc, shape, masks, opts) {
  const maskShapes = masks.map((m) => maskShape(doc, m));
  if (!shape.string) {
    const recs = await runGeom(
      OP.INTERSECT,
      [{ ...shape, string: false }, ...maskShapes],
      [],
      opts,
    );
    const subpaths = recs[0]?.subpaths || [];
    return subpaths.length ? { ...shape, subpaths, evenodd: false } : null;
  }
  let subpaths = shape.subpaths;
  for (const m of maskShapes) {
    const b = boxOf([...subpaths, ...m.subpaths]);
    if (!b || !m.subpaths.length) return null;
    // The lines keep what is outside the area around the clipping path. The
    // engine calls a cut line unchanged when it keeps as many lines and points
    // as it got, which a line cut at both ends can do: a short marker line in
    // that area, always cut away, keeps the count from matching.
    const outside = await runGeom(
      OP.MINUS_FRONT,
      [{ subpaths: [boxPath(b, 10)], filled: true }, m],
      [],
      opts,
    );
    if (!outside[0]?.subpaths.length) continue;
    const pt = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
    const marker = { anchors: [pt(b.x0 - 6, b.y0 - 5), pt(b.x0 - 4, b.y0 - 5)], closed: false };
    const recs = await runGeom(
      OP.SUBTRACT_EACH,
      [
        { ...shape, subpaths: [...subpaths, marker] },
        { subpaths: outside[0].subpaths, filled: true },
      ],
      [],
      opts,
    );
    subpaths = recs.flatMap((r) => r.subpaths);
    if (!subpaths.length) return null;
  }
  return { ...shape, subpaths };
}

/**
 * Engine shapes of operands as they show: shapes of leaves listed in
 * `clipped` (see geometryLeaves) are cut to their clipping paths. Resolves
 * to an array parallel to `shapes`, with null where nothing shows.
 */
export async function visibleShapes(doc, leaves, shapes, clipped, opts = {}) {
  return Promise.all(
    shapes.map((s, i) => {
      const clip = clipped?.get(leaves[i].id);
      return clip ? visibleShape(doc, s, clip.masks, opts) : s;
    }),
  );
}

/**
 * The nodes standing for operands in the paint order: a leaf of a clipping
 * group taken as a whole stands for that group (results go outside it).
 */
export function operandAnchors(nodes, clipped) {
  if (!clipped?.size) return nodes;
  return nodes.map((n) => clipped.get(n.id)?.group || n);
}

/** Nodes to snapshot for operands: the leaves and the clipping paths over them. */
export function withMasks(doc, nodes, clipped) {
  if (!clipped?.size) return nodes;
  const out = new Set(nodes);
  for (const n of nodes)
    for (const m of clipped.get(n.id)?.masks || []) for (const l of maskLeaves(doc, m)) out.add(l);
  return [...out];
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

/**
 * Where to put results: the parent and index just above the topmost of
 * `nodes`. With `clipped` (see geometryLeaves), above the clipping group a
 * clipped leaf was taken from.
 */
export function insertionPoint(doc, nodes, clipped = null) {
  const ids = doc.sortByPaintOrder(operandAnchors(nodes, clipped).map((n) => n.id));
  const top = doc.get(ids[ids.length - 1]);
  const parent = doc.get(top.parent);
  return { parentId: parent.id, index: parent.children.indexOf(top.id) + 1 };
}

/**
 * Remove `remove` nodes and insert built items at the insertion point (in
 * order, back to front). Returns new ids.
 *
 * Containers left empty go away: groups (not layers), and clipping groups
 * left with only their clipping path (a clipping path with a stroke, which
 * shows, stays as an ordinary unfilled path). When a clipping path is
 * removed, the items that land in its place (last in its group) clip
 * instead, several of them as one group; with none there, the group stops
 * clipping rather than being clipped by the object below.
 */
export function replaceWith(doc, remove, items, at = insertionPoint(doc, remove)) {
  const parentsToCheck = new Set();
  const lostMask = new Set();
  for (const n of remove)
    if (doc.has(n.id) && isClipMask(doc, doc.get(n.id))) lostMask.add(n.parent);
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
  const added = new Set(out);
  for (const gid of lostMask) {
    const g = doc.get(gid);
    if (!g || !g.children.length) continue;
    let k = g.children.length;
    while (k > 0 && added.has(g.children[k - 1])) k--;
    const tail = g.children.slice(k);
    if (tail.length > 1) {
      // Several results take the clipping path's place: they clip as one group.
      const wrap = createGroup([]);
      doc.insert(wrap, gid, Infinity);
      for (const id of tail) doc.move(id, wrap.id);
    } else if (!tail.length) doc.update(gid, { clip: false });
  }
  removeEmptied(doc, parentsToCheck, added);
  return out;
}

/**
 * Remove containers in `parents` (and up) that an operation emptied: groups
 * with no children, and clipping groups with nothing left to clip. A
 * clipping group whose only child is one of `added` (a result that took
 * the clipping path's place) stops clipping instead.
 */
export function removeEmptied(doc, parents, added = new Set()) {
  const queue = [...parents];
  while (queue.length) {
    const p = doc.get(queue.shift());
    if (!p || p.type !== 'group') continue;
    if (!p.children.length) {
      queue.push(p.parent);
      doc.remove(p.id);
    } else if (p.clip && p.children.length === 1 && !liveDef(p)) {
      const only = doc.get(p.children[0]);
      if (added.has(only.id)) {
        doc.update(p.id, { clip: false });
        continue;
      }
      const shows =
        (only.type === 'path' || only.type === 'compound') && only.stroke && only.strokeWidth > 0;
      if (shows) {
        // The clipping path's stroke shows: it stays where the group was, unfilled.
        const up = doc.get(p.parent);
        doc.move(only.id, up.id, up.children.indexOf(p.id));
        doc.update(only.id, { fill: null });
      }
      queue.push(p.parent);
      doc.remove(p.id);
    }
  }
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
