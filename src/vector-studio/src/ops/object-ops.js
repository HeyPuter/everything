/**
 * Object operations on the editor's selection: delete, group, ungroup,
 * arrange, lock/hide, clipping masks, compound paths, join, average,
 * reverse, nudge, align and distribute. Each runs as one undoable
 * transaction and leaves a sensible selection.
 */
import { UserError } from '../lib/errors.js';
import { createGroup, createCompound, createPath } from '../model/nodes.js';
import { nodeBounds, selectionBounds, transformNodes, visualBounds } from '../model/geometry.js';
import { reverseAnchors, signedArea } from '../model/bezier.js';
import { translate } from '../lib/matrix.js';
import { duplicateNodes } from './layer-ops.js';

/** Selected ids grouped by parent, each list back-to-front. */
function byParent(doc, ids) {
  const map = new Map();
  for (const id of doc.sortByPaintOrder(ids)) {
    const n = doc.get(id);
    if (!n) continue;
    if (!map.has(n.parent)) map.set(n.parent, []);
    map.get(n.parent).push(id);
  }
  return map;
}

/**
 * The segment last clicked with Direct Selection, while the selection is
 * still exactly that click (its two anchors on the unchanged path), else null.
 */
export function selectedSegment(editor) {
  const seg = editor.segment;
  if (!seg) return null;
  const set = editor.anchors.get(seg.id);
  const n = editor.doc.get(seg.id);
  if (n !== seg.node || set !== seg.set || editor.selection.size !== 1 || editor.anchors.size !== 1) return null;
  const i1 = (seg.index + 1) % n.anchors.length;
  return set.size === 2 && set.has(seg.index) && set.has(i1) ? seg : null;
}

/**
 * Segments a Direct Selection marquee crossed without enclosing any anchor
 * (editor.segmentHits: pathId -> { node, set, indices }), still valid for
 * the current selection: Map pathId -> segment indices.
 */
export function selectedSegmentHits(editor) {
  const out = new Map();
  for (const [id, hit] of editor.segmentHits || []) {
    const set = editor.anchors.get(id);
    if (set && set === hit.set && !set.size && editor.doc.get(id) === hit.node && hit.indices.length) out.set(id, hit.indices);
  }
  return out;
}

/**
 * Remove segments (segment i joins anchor i to i + 1): a closed path opens
 * at the first one, an open path splits at each (stray single points go).
 */
function deleteSegments(doc, path, indices) {
  const parent = doc.get(path.parent);
  const at = parent.children.indexOf(path.id);
  const n = path.anchors.length;
  const tidy = (run) => {
    const out = run.slice();
    out[0] = { ...out[0], ix: out[0].x, iy: out[0].y };
    const l = out.length - 1;
    out[l] = { ...out[l], ox: out[l].x, oy: out[l].y };
    return out;
  };
  let list = path.anchors;
  let cuts = [...new Set(indices)].sort((a, b) => a - b);
  if (path.closed) {
    // Open the loop just after the first removed segment; the others shift with it.
    const start = (cuts[0] + 1) % n;
    list = [...list.slice(start), ...list.slice(0, start)];
    cuts = cuts.slice(1).map((i) => (i - start + n) % n);
  }
  const runs = [];
  let from = 0;
  for (const c of cuts) {
    runs.push(list.slice(from, c + 1));
    from = c + 1;
  }
  runs.push(list.slice(from));
  const kept = runs.filter((r) => r.length > 1);
  if (path.closed && kept.length === 1 && cuts.length === 0) {
    doc.update(path.id, { anchors: tidy(kept[0]), closed: false, shape: undefined });
    return;
  }
  doc.remove(path.id);
  kept.forEach((run, k) => doc.insert({ ...path, id: createPath([], false).id, anchors: tidy(run), closed: false, shape: undefined }, parent.id, at + k));
}

/**
 * Remove groups and compound paths left with no children after their
 * contents were deleted (walking up from the given parent ids), so no
 * invisible empty objects remain.
 */
export function removeEmptyContainers(doc, parentIds, keep = null) {
  for (const id of parentIds) {
    let n = doc.get(id);
    // The group in isolation mode stays, empty or not.
    while (n && n.id !== keep && (n.type === 'group' || n.type === 'compound') && !n.children.length) {
      const up = n.parent;
      doc.remove(n.id);
      n = up ? doc.get(up) : null;
    }
  }
}

export function deleteSelection(editor, label = 'Clear') {
  const { doc } = editor;
  const ids = editor.topSelection();
  if (!ids.length) return false;
  const parents = new Set(ids.map((id) => doc.get(id)?.parent).filter(Boolean));
  const seg = selectedSegment(editor);
  if (seg) {
    doc.transact(label, () => deleteSegments(doc, doc.get(seg.id), [seg.index]));
    editor.clearSelection();
    return true;
  }
  // Direct-selected anchors delete just those anchors, marquee-crossed segments just those
  // segments; a path with an empty anchor selection is never deleted whole.
  const partial = [...editor.anchors].filter(([id, set]) => {
    const n = doc.get(id);
    return n && set.size && set.size < n.anchors.length;
  });
  const segs = selectedSegmentHits(editor);
  const keep = (id) => partial.some(([p]) => p === id) || editor.anchors.get(id)?.size === 0;
  doc.transact(label, () => {
    for (const [id, set] of partial) deleteAnchors(doc, doc.get(id), set);
    for (const [id, indices] of segs) deleteSegments(doc, doc.get(id), indices);
    for (const id of ids) if (!keep(id)) doc.remove(id);
    removeEmptyContainers(doc, parents, editor.isolation);
  });
  editor.clearSelection();
  return true;
}

/** Remove anchors from a path, splitting an open path where segments disappear. */
function deleteAnchors(doc, path, indices) {
  const keep = path.anchors.map((_, i) => !indices.has(i));
  const parent = doc.get(path.parent);
  const index = parent.children.indexOf(path.id);
  const runs = [];
  let cur = [];
  const n = path.anchors.length;
  let start = 0;
  if (path.closed) {
    start = keep.indexOf(false);
    if (start < 0) return;
  }
  for (let k = 0; k < n; k++) {
    const i = path.closed ? (start + k) % n : k;
    if (keep[i]) cur.push(path.anchors[i]);
    else {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) runs.push(cur);
  doc.remove(path.id);
  runs.forEach((run, k) => {
    const piece = { ...path, id: createPath([], false).id, anchors: run, closed: false, shape: undefined };
    doc.insert(piece, parent.id, index + k);
  });
}

/**
 * Selected objects for commands that build or move containers: a subpath of
 * a compound path (Direct Selection) stands for its compound path, since
 * only paths can go inside one. Back to front, without repeats.
 */
function wholeObjects(doc, ids) {
  const out = new Set();
  for (const id of ids) {
    let n = doc.get(id);
    while (n && doc.get(n.parent)?.type === 'compound') n = doc.get(n.parent);
    if (n) out.add(n.id);
  }
  return doc.sortByPaintOrder(out);
}

export function group(editor) {
  const { doc } = editor;
  const ids = wholeObjects(doc, editor.topSelection());
  if (!ids.length) return;
  doc.transact('Group', () => {
    // The group goes where the topmost selected object was.
    const top = doc.get(ids[ids.length - 1]);
    const parent = doc.get(top.parent);
    const index = parent.children.indexOf(top.id) + 1;
    const g = createGroup([]);
    doc.insert(g, parent.id, index);
    for (const id of ids) doc.move(id, g.id);
    // Selected inside the transaction so Redo selects the group again.
    editor.select([g.id]);
  });
}

export function ungroup(editor) {
  const { doc } = editor;
  const ids = editor.topSelection().filter((id) => doc.get(id)?.type === 'group');
  if (!ids.length) return;
  const released = [];
  doc.transact('Ungroup', () => {
    for (const id of ids) {
      const g = doc.get(id);
      const parent = doc.get(g.parent);
      let index = parent.children.indexOf(id);
      const kids = g.children.slice();
      // A clip group releases its mask too (it stays as an unpainted path).
      for (const c of kids) {
        doc.move(c, parent.id, index++);
        released.push(c);
      }
      doc.remove(id);
    }
    // Hidden or locked contents come out of the group but stay unselected.
    const pickable = (id) => !doc.get(id).hidden && !doc.get(id).locked;
    editor.select([...released.filter(pickable), ...editor.topSelection().filter((id) => doc.has(id))]);
  });
}

/** Arrange within each parent: 'front' | 'forward' | 'backward' | 'back'. */
export function arrange(editor, how) {
  const { doc } = editor;
  const ids = editor.topSelection();
  if (!ids.length) return;
  const labels = { front: 'Bring to Front', forward: 'Bring Forward', backward: 'Send Backward', back: 'Send to Back' };
  doc.transact(labels[how], () => {
    for (let [parentId, list] of byParent(doc, ids)) {
      const parent = doc.get(parentId);
      // In a clip group the clipping path (the last child) stays last, so it keeps clipping.
      const mask = parent.clip && parent.children.length ? parent.children[parent.children.length - 1] : null;
      const children = mask ? parent.children.slice(0, -1) : parent.children.slice();
      if (mask) list = list.filter((id) => id !== mask);
      const sel = new Set(list);
      let next;
      if (how === 'front') next = [...children.filter((c) => !sel.has(c)), ...list];
      else if (how === 'back') next = [...list, ...children.filter((c) => !sel.has(c))];
      else if (how === 'forward') {
        next = children.slice();
        // Move each selected object above the next unselected object it overlaps (or the next one).
        for (let i = next.length - 2; i >= 0; i--) {
          if (sel.has(next[i]) && !sel.has(next[i + 1])) [next[i], next[i + 1]] = [next[i + 1], next[i]];
        }
      } else {
        next = children.slice();
        for (let i = 1; i < next.length; i++) {
          if (sel.has(next[i]) && !sel.has(next[i - 1])) [next[i], next[i - 1]] = [next[i - 1], next[i]];
        }
      }
      if (mask) children.push(mask), next.push(mask);
      // Already in place (Bring to Front on the frontmost object): no undo step, document stays saved.
      if (next.some((c, i) => c !== children[i])) doc.update(parentId, { children: next });
    }
  });
}

/** Move the selection to another layer (Object > Arrange > Send to Current Layer). */
export function sendToLayer(editor, layerId) {
  const { doc } = editor;
  if (doc.isLocked(layerId) || doc.isHidden(layerId))
    throw new UserError(
      'The current layer is locked or hidden: unlock and show it, or pick another layer.',
    );
  // Objects already on the layer keep their place in its stacking order.
  const ids = wholeObjects(doc, editor.topSelection()).filter(
    (id) => doc.get(id)?.parent !== layerId,
  );
  if (!ids.length) return;
  doc.transact('Send to Current Layer', () => {
    for (const id of ids) doc.move(id, layerId);
  });
}

export function lockSelection(editor) {
  const { doc } = editor;
  const ids = editor.topSelection();
  if (!ids.length) return;
  doc.transact('Lock', () => {
    ids.forEach((id) => doc.update(id, { locked: true }));
    editor.clearSelection();
  });
}

/** Unlock everything below the layer level and select what was unlocked. */
const concealed = new WeakMap();

/**
 * Whether Unlock All and Show All would find anything: a locked object
 * outside locked layers, a hidden object outside hidden layers. Worked out
 * once per document state (menus ask on every open).
 */
export function concealedState(doc) {
  const c = concealed.get(doc);
  if (c && c.version === doc.nodes.version) return c;
  const out = { version: doc.nodes.version, locked: false, hidden: false };
  const visit = (id, lockedLayer, hiddenLayer) => {
    const n = doc.get(id);
    if (!n || (out.locked && out.hidden)) return;
    if (n.type === 'layer') {
      lockedLayer ||= Boolean(n.locked);
      hiddenLayer ||= Boolean(n.hidden);
      if (lockedLayer && hiddenLayer) return;
    } else {
      if (n.locked && !lockedLayer) out.locked = true;
      if (n.hidden && !hiddenLayer) out.hidden = true;
    }
    if (n.children) for (const k of n.children) visit(k, lockedLayer, hiddenLayer);
  };
  for (const id of doc.root.children) visit(id, false, false);
  concealed.set(doc, out);
  return out;
}

export function unlockAll(editor) {
  const { doc } = editor;
  const out = [];
  doc.transact('Unlock All', () => {
    doc.walk((n) => {
      if (n.type === 'layer') return !n.locked;
      if (n.locked) {
        doc.update(n.id, { locked: false });
        out.push(n.id);
      }
      return true;
    });
    // What is still hidden is unlocked but not selected.
    editor.select(out.filter((id) => !doc.isHidden(id)));
  });
}

/**
 * Lock Others / Hide Others: everything on unlocked, visible layers and
 * sublayers that is not part of the selection (top-level objects only;
 * sublayers themselves stay as they are, so Unlock All and Show All bring
 * their contents back).
 */
export function lockOrHideOthers(editor, key) {
  const { doc } = editor;
  const sel = new Set(editor.topSelection());
  // Containers of selected objects are kept too (one ancestor walk per selected id).
  const holders = new Set();
  for (const id of sel) for (const a of doc.ancestors(id)) holders.add(a.id);
  const keep = (id) => sel.has(id) || holders.has(id);
  const targets = [];
  const visit = (lid) => {
    const layer = doc.get(lid);
    if (!layer || layer.locked || layer.hidden) return;
    for (const id of layer.children) {
      const n = doc.get(id);
      if (n?.type === 'layer') visit(id);
      else if (n && !keep(id) && !n[key]) targets.push(id);
    }
  };
  for (const lid of doc.root.children) visit(lid);
  if (!targets.length) return;
  doc.transact(key === 'locked' ? 'Lock Others' : 'Hide Others', () => targets.forEach((id) => doc.update(id, { [key]: true })));
}

export function hideSelection(editor) {
  const { doc } = editor;
  const ids = editor.topSelection();
  if (!ids.length) return;
  doc.transact('Hide', () => {
    ids.forEach((id) => doc.update(id, { hidden: true }));
    editor.clearSelection();
  });
}

export function showAll(editor) {
  const { doc } = editor;
  const out = [];
  doc.transact('Show All', () => {
    doc.walk((n) => {
      if (n.type === 'layer') return !n.hidden;
      if (n.hidden) {
        doc.update(n.id, { hidden: false });
        out.push(n.id);
      }
      return true;
    });
    // What is still locked is shown but not selected.
    editor.select(out.filter((id) => !doc.isLocked(id)));
  });
}

/** Make Clipping Mask: the topmost selected object clips the others. */
export function makeClipMask(editor) {
  const { doc } = editor;
  const ids = wholeObjects(doc, editor.topSelection());
  if (ids.length < 2) throw new UserError('Select at least two objects: the topmost one becomes the clipping path.');
  const mask = doc.get(ids[ids.length - 1]);
  if (!['path', 'compound', 'text', 'group'].includes(mask.type)) throw new UserError('The clipping path must be a path, compound path, group or text.');
  doc.transact('Make Clipping Mask', () => {
    const top = doc.get(ids[ids.length - 1]);
    const parent = doc.get(top.parent);
    const index = parent.children.indexOf(top.id) + 1;
    const g = createGroup([], { clip: true });
    doc.insert(g, parent.id, index);
    for (const id of ids) doc.move(id, g.id);
    // The clipping path loses its paint: it only defines the clip.
    if (mask.type === 'path' || mask.type === 'compound') doc.update(mask.id, { fill: null, stroke: null });
    editor.select([g.id]);
  });
}

export function releaseClipMask(editor) {
  const { doc } = editor;
  const ids = editor.topSelection().map((id) => {
    let n = doc.get(id);
    while (n && !(n.type === 'group' && n.clip)) n = n.parent ? doc.get(n.parent) : null;
    return n?.id;
  });
  const groups = [...new Set(ids.filter(Boolean))];
  if (!groups.length) return;
  // One undo step: the Ungroup transaction joins this one.
  doc.transact('Release Clipping Mask', () => {
    for (const id of groups) doc.update(id, { clip: false });
    editor.select(groups);
    ungroup(editor);
  });
}

/**
 * Make Compound Path from the selected paths (and paths inside selected
 * groups). The clipping path of a clipping group is not made a subpath (its
 * area never shows); a clipping group left with nothing to clip goes away.
 */
export function makeCompound(editor) {
  const { doc } = editor;
  const paths = [];
  const clipGroups = [];
  const collect = (n) => {
    if (!n) return;
    if (n.type === 'path') paths.push(n);
    else if (n.type === 'compound') for (const c of n.children) paths.push(doc.get(c));
    else if (n.type === 'group' && n.clip && n.children.length) {
      clipGroups.push(n.id);
      for (const c of n.children.slice(0, -1)) collect(doc.get(c));
    } else if (n.type === 'group') for (const c of n.children) collect(doc.get(c));
  };
  const sel = wholeObjects(doc, editor.topSelection());
  for (const id of sel) collect(doc.get(id));
  if (paths.length < 1) return;
  const topPaint = doc.get(sel[sel.length - 1]);
  doc.transact('Make Compound Path', () => {
    const style = { ...pickPaint(paths[0]) };
    if (topPaint && (topPaint.type === 'path' || topPaint.type === 'compound')) Object.assign(style, pickPaint(topPaint));
    const top = doc.get(sel[sel.length - 1]);
    const parent = doc.get(top.parent);
    const index = parent.children.indexOf(top.id) + 1;
    const c = createCompound([], style, { fillRule: 'nonzero' });
    doc.insert(c, parent.id, index);
    // Compound paths reverse inner subpaths so holes appear under the non-zero rule.
    const outerSign = Math.sign(signedArea(paths.reduce((a, b) => (Math.abs(signedArea(b.anchors)) > Math.abs(signedArea(a.anchors)) ? b : a)).anchors)) || 1;
    const bounds = paths.map((p) => nodeBounds(doc, p));
    const containedByOther = containedFlags(bounds);
    paths.forEach((p, i) => {
      const cur = doc.get(p.id);
      const area = signedArea(cur.anchors);
      if (containedByOther[i] && Math.sign(area) === outerSign)
        doc.update(p.id, { anchors: reverseAnchors(cur.anchors) });
      doc.move(p.id, c.id);
      doc.update(p.id, { shape: undefined });
    });
    // Groups (nested ones too) and compound paths the paths came from go once emptied.
    removeEmptyContainers(doc, new Set(paths.map((p) => p.parent)), editor.isolation);
    for (const id of clipGroups.reverse()) {
      const g = doc.get(id);
      if (!g || g.children.length !== 1 || id === editor.isolation) continue;
      const up = g.parent;
      doc.remove(id);
      removeEmptyContainers(doc, [up], editor.isolation);
    }
    editor.select([c.id]);
  });
}

/**
 * For each box, whether another box contains it. A box that contains b
 * covers b's center, so each box is compared only with the boxes listed in
 * the grid cell holding its center (instead of with every other box).
 */
export function containedFlags(bounds) {
  const n = bounds.length;
  const flags = new Array(n).fill(false);
  const all = unionBounds(bounds);
  if (!all) return flags;
  const side = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cw = all.w / side || 1;
  const ch = all.h / side || 1;
  const col = (x) => Math.max(0, Math.min(side - 1, Math.floor((x - all.x) / cw)));
  const row = (y) => Math.max(0, Math.min(side - 1, Math.floor((y - all.y) / ch)));
  const cells = new Map();
  // Boxes spanning many cells are compared with every box instead (no grid blow-up for nested outlines).
  const big = [];
  bounds.forEach((b, j) => {
    if (!b) return;
    // (Widened by the containment tolerance, so a box touching a cell edge is listed there.)
    const r0 = row(b.y - 1e-6);
    const r1 = row(b.y + b.h + 1e-6);
    const c0 = col(b.x - 1e-6);
    const c1 = col(b.x + b.w + 1e-6);
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > 16) {
      big.push(j);
      return;
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * side + c;
        const list = cells.get(k);
        if (list) list.push(j);
        else cells.set(k, [j]);
      }
    }
  });
  bounds.forEach((b, i) => {
    if (!b) return;
    const list = cells.get(row(b.y + b.h / 2) * side + col(b.x + b.w / 2)) || [];
    const inside = (j) => j !== i && contains(bounds[j], b);
    flags[i] = list.some(inside) || big.some(inside);
  });
  return flags;
}

function unionBounds(list) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of list) {
    if (!b || !Number.isFinite(b.x + b.y + b.w + b.h)) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function contains(a, b) {
  return a && b && b.x >= a.x - 1e-6 && b.y >= a.y - 1e-6 && b.x + b.w <= a.x + a.w + 1e-6 && b.y + b.h <= a.y + a.h + 1e-6 && (a.w > b.w || a.h > b.h);
}

function pickPaint(n) {
  const out = {};
  for (const k of ['fill', 'stroke', 'strokeWidth', 'strokeCap', 'strokeJoin', 'miterLimit', 'strokeAlign', 'dash', 'dashOffset', 'opacity', 'blendMode', 'effects']) if (n[k] !== undefined) out[k] = n[k];
  return out;
}

export function releaseCompound(editor) {
  const { doc } = editor;
  const ids = editor.topSelection().filter((id) => doc.get(id)?.type === 'compound');
  if (!ids.length) return;
  const out = [];
  doc.transact('Release Compound Path', () => {
    for (const id of ids) {
      const c = doc.get(id);
      const parent = doc.get(c.parent);
      let index = parent.children.indexOf(id);
      const paint = pickPaint(c);
      for (const k of c.children.slice()) {
        doc.move(k, parent.id, index++);
        doc.update(k, paint);
        out.push(k);
      }
      doc.remove(id);
    }
    // Hidden or locked subpaths come out but stay unselected.
    editor.select(out.filter((k) => !doc.get(k).hidden && !doc.get(k).locked));
  });
}

/**
 * Join: with two open endpoints selected (or two open paths) connect them;
 * with one open path, close it. Coincident endpoints merge into one anchor.
 */
export function join(editor) {
  const { doc } = editor;
  const paths = editor.topSelection().map((id) => doc.get(id)).filter((n) => n?.type === 'path' && !n.closed);
  if (!paths.length) throw new UserError('Select an open path or two open endpoints to join.');
  doc.transact('Join', () => {
    if (paths.length === 1) {
      const p = paths[0];
      const a = p.anchors[0];
      const b = p.anchors[p.anchors.length - 1];
      let anchors = p.anchors;
      if (Math.hypot(a.x - b.x, a.y - b.y) < 0.01 && anchors.length > 2) {
        anchors = anchors.slice(0, -1);
        anchors[0] = { ...anchors[0], ix: b.ix, iy: b.iy };
      }
      doc.update(p.id, { anchors, closed: true, shape: undefined });
      editor.select([p.id]);
      return;
    }
    // Join paths pairwise by nearest endpoints, accumulating into the first.
    const base = paths[0];
    let anchors = base.anchors.slice();
    const rest = paths.slice(1);
    while (rest.length) {
      let best = null;
      const end = anchors[anchors.length - 1];
      const start = anchors[0];
      rest.forEach((p, idx) => {
        const s = p.anchors[0];
        const e = p.anchors[p.anchors.length - 1];
        const cands = [
          { d: Math.hypot(end.x - s.x, end.y - s.y), idx, mode: 'end-start' },
          { d: Math.hypot(end.x - e.x, end.y - e.y), idx, mode: 'end-end' },
          { d: Math.hypot(start.x - e.x, start.y - e.y), idx, mode: 'start-end' },
          { d: Math.hypot(start.x - s.x, start.y - s.y), idx, mode: 'start-start' },
        ];
        for (const c of cands) if (!best || c.d < best.d) best = c;
      });
      const other = rest.splice(best.idx, 1)[0];
      let oa = other.anchors;
      if (best.mode === 'end-end' || best.mode === 'start-start') oa = reverseAnchors(oa);
      if (best.mode.startsWith('start')) {
        // Prepend.
        const merged = best.d < 0.01 ? [...oa.slice(0, -1), { ...anchors[0], ix: oa[oa.length - 1].ix, iy: oa[oa.length - 1].iy }, ...anchors.slice(1)] : [...oa, ...anchors];
        anchors = merged;
      } else {
        const merged = best.d < 0.01 ? [...anchors.slice(0, -1), { ...anchors[anchors.length - 1], ox: oa[0].ox, oy: oa[0].oy }, ...oa.slice(1)] : [...anchors, ...oa];
        anchors = merged;
      }
      doc.remove(other.id);
    }
    doc.update(base.id, { anchors, shape: undefined });
    editor.select([base.id]);
  });
}

/** Average selected anchors: 'h' | 'v' | 'both'. */
export function average(editor, axis = 'both') {
  const { doc } = editor;
  const pts = [];
  const targets = [];
  for (const id of editor.selection) {
    const n = doc.get(id);
    if (n?.type !== 'path') continue;
    const sel = editor.selectedAnchors(id);
    targets.push([n, sel]);
    for (const i of sel) pts.push(n.anchors[i]);
  }
  if (pts.length < 2) throw new UserError('Select two or more anchor points to average.');
  const ax = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const ay = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  doc.transact('Average', () => {
    for (const [n, sel] of targets) {
      const anchors = n.anchors.map((a, i) => {
        if (!sel.has(i)) return a;
        const dx = axis === 'v' ? 0 : ax - a.x;
        const dy = axis === 'h' ? 0 : ay - a.y;
        return { ...a, x: a.x + dx, y: a.y + dy, ix: a.ix + dx, iy: a.iy + dy, ox: a.ox + dx, oy: a.oy + dy };
      });
      doc.update(n.id, { anchors, shape: undefined });
    }
  });
}

export function reversePaths(editor) {
  const { doc } = editor;
  // Each path once, even when both it and its compound path are selected.
  const paths = new Set();
  for (const id of editor.selection) {
    const n = doc.get(id);
    if (n?.type === 'path') paths.add(id);
    if (n?.type === 'compound') for (const c of n.children) paths.add(c);
  }
  doc.transact('Reverse Path Direction', () => {
    for (const id of paths) {
      const n = doc.get(id);
      if (n?.type === 'path') doc.update(id, { anchors: reverseAnchors(n.anchors) });
    }
  });
}

/** Nudge the selection (or selected anchors) by (dx, dy); `copy` duplicates first. */
export function nudge(editor, dx, dy, { copy = false } = {}) {
  const { doc } = editor;
  if (!editor.selection.size) return;
  // Segments a Direct Selection marquee crossed move with their end points (as when dragged).
  const hits = selectedSegmentHits(editor);
  const partial = [...editor.anchors]
    .filter(([id, set]) => doc.get(id) && set.size < doc.get(id).anchors.length)
    .map(([id, set]) => {
      const idx = new Set(set);
      const count = doc.get(id).anchors.length;
      for (const i of hits.get(id) || []) idx.add(i).add((i + 1) % count);
      return [id, idx];
    });
  doc.transact(copy ? 'Duplicate' : 'Move', () => {
    if (partial.length && !copy) {
      for (const [id, set] of partial) {
        // A path the marquee touched without selecting any of it stays as it is.
        if (!set.size) continue;
        const n = doc.get(id);
        doc.update(id, {
          // Moved anchors keep their other properties (a live corner, ...).
          anchors: n.anchors.map((a, i) => (set.has(i) ? { ...a, x: a.x + dx, y: a.y + dy, ix: a.ix + dx, iy: a.iy + dy, ox: a.ox + dx, oy: a.oy + dy } : a)),
          shape: undefined,
        });
      }
      // Everything not moved anchor by anchor above moves whole, including
      // a path whose anchors were all picked one by one (an explicit full set).
      const moved = new Set(partial.map(([id]) => id));
      const rest = editor.topSelection().filter((id) => !moved.has(id));
      transformNodes(doc, rest, translate(dx, dy));
      return;
    }
    let ids = editor.topSelection();
    if (copy) {
      ids = duplicateNodes(doc, ids);
      editor.select(ids);
    }
    transformNodes(doc, ids, translate(dx, dy));
    // A nudge is a move, so Transform Again repeats it (as a copy after Alt+arrow).
    editor.lastTransform = { matrix: translate(dx, dy), copy };
  });
}

/**
 * Align the selection. `edge`: 'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom'.
 * `to`: 'selection' | 'artboard' | 'key' (key object id in opts.key).
 */
export function align(editor, edge, { to = 'selection', key = null, previewBounds = false } = {}) {
  const { doc } = editor;
  const ids = editor.topSelection();
  if (!ids.length) return;
  const bounds = (id) => (previewBounds ? visualBounds(doc, doc.get(id)) : nodeBounds(doc, doc.get(id)));
  let ref;
  if (to === 'artboard') ref = editor.artboard();
  else if (to === 'key' && key) ref = bounds(key);
  else ref = selectionBounds(doc, ids, previewBounds);
  if (!ref) return;
  if (to === 'selection' && ids.length < 2) ref = editor.artboard();
  doc.transact('Align', () => {
    for (const id of ids) {
      if (id === key) continue;
      const b = bounds(id);
      if (!b) continue;
      let dx = 0;
      let dy = 0;
      if (edge === 'left') dx = ref.x - b.x;
      if (edge === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
      if (edge === 'right') dx = ref.x + ref.w - (b.x + b.w);
      if (edge === 'top') dy = ref.y - b.y;
      if (edge === 'vcenter') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
      if (edge === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
      if (dx || dy) transformNodes(doc, [id], translate(dx, dy));
    }
  });
}

/**
 * Distribute objects evenly. `edge` like align ('left', 'hcenter', ...) for
 * distributing those edges, or 'hspace' / 'vspace' for equal gaps (with an
 * optional fixed `spacing` against a key object).
 */
export function distribute(editor, edge, { spacing = null, key = null, previewBounds = false } = {}) {
  const { doc } = editor;
  const ids = editor.topSelection();
  if (ids.length < (spacing != null ? 2 : 3)) return;
  const items = ids.map((id) => ({ id, b: previewBounds ? visualBounds(doc, doc.get(id)) : nodeBounds(doc, doc.get(id)) })).filter((i) => i.b);
  // Objects without bounds (empty groups) take no part.
  if (items.length < (spacing != null ? 2 : 3)) return;
  const horizontal = ['left', 'hcenter', 'right', 'hspace'].includes(edge);
  const pos = (b) => {
    if (edge === 'left' || edge === 'hspace') return b.x;
    if (edge === 'hcenter') return b.x + b.w / 2;
    if (edge === 'right') return b.x + b.w;
    if (edge === 'top' || edge === 'vspace') return b.y;
    if (edge === 'vcenter') return b.y + b.h / 2;
    return b.y + b.h;
  };
  items.sort((a, b) => pos(a.b) - pos(b.b));
  doc.transact('Distribute', () => {
    if (edge === 'hspace' || edge === 'vspace') {
      const size = (b) => (horizontal ? b.w : b.h);
      const start = horizontal ? items[0].b.x : items[0].b.y;
      const last = items[items.length - 1];
      const end = horizontal ? last.b.x + last.b.w : last.b.y + last.b.h;
      const total = items.reduce((s, i) => s + size(i.b), 0);
      const gap = spacing != null ? spacing : (end - start - total) / (items.length - 1);
      let cursor = start;
      const ki = key ? items.findIndex((i) => i.id === key) : -1;
      if (spacing != null && ki >= 0) {
        // Lay out around the key object, which stays put.
        cursor = (horizontal ? items[ki].b.x : items[ki].b.y) - items.slice(0, ki).reduce((s, i) => s + size(i.b) + gap, 0);
      }
      for (const it of items) {
        const cur = horizontal ? it.b.x : it.b.y;
        const d = cursor - cur;
        if (Math.abs(d) > 1e-9) transformNodes(doc, [it.id], horizontal ? translate(d, 0) : translate(0, d));
        cursor += size(it.b) + gap;
      }
      return;
    }
    const first = pos(items[0].b);
    const last = pos(items[items.length - 1].b);
    const step = (last - first) / (items.length - 1);
    items.forEach((it, i) => {
      const d = first + step * i - pos(it.b);
      if (Math.abs(d) > 1e-9) transformNodes(doc, [it.id], horizontal ? translate(d, 0) : translate(0, d));
    });
  });
}
