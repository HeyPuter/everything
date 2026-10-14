/**
 * Arrange (Page Layout ▸ Arrange, the Selection Pane): the order, alignment, grouping and rotation of a
 * sheet's drawing objects — charts, pictures, shapes, text boxes, WordArt, slicers, timelines and controls,
 * which the sheet keeps in one list (sheet.charts) from the back to the front.
 *
 * A group is the objects that share a `group` id; they stay next to each other in the list, so the group
 * moves through the stacking order as one, and a click on any of them selects them all.
 */

/** The objects' ids widened to whole groups: picking one member of a group picks the group. */
export function withGroups(list, ids) {
  const want = new Set(ids), groups = new Set(list.filter((o) => want.has(o.id) && o.group).map((o) => o.group));
  return list.filter((o) => want.has(o.id) || (o.group && groups.has(o.group))).map((o) => o.id);
}

/** The list cut into stacking units, back to front: a group is one unit, any other object its own. */
function units(list) {
  const out = [];
  for (const o of list) {
    const last = out.at(-1);
    if (o.group && last?.group === o.group) last.items.push(o);
    else out.push({ group: o.group || null, items: [o] });
  }
  return out;
}

/**
 * The list after Bring to Front ('front'), Send to Back ('back'), Bring Forward ('forward') or Send Backward
 * ('backward') of the objects named (whole groups): the ones moved keep their order among themselves, and
 * Forward and Backward pass one other unit each.
 */
export function orderObjects(list, ids, where) {
  const picked = new Set(withGroups(list, ids));
  const all = units(list).map((u) => ({ ...u, on: u.items.some((o) => picked.has(o.id)) }));
  let next;
  if (where === 'front') next = [...all.filter((u) => !u.on), ...all.filter((u) => u.on)];
  else if (where === 'back') next = [...all.filter((u) => u.on), ...all.filter((u) => !u.on)];
  else if (where === 'forward') {
    next = all.slice();
    for (let i = next.length - 2; i >= 0; i--) if (next[i].on && !next[i + 1].on) [next[i], next[i + 1]] = [next[i + 1], next[i]];
  } else if (where === 'backward') {
    next = all.slice();
    for (let i = 1; i < next.length; i++) if (next[i].on && !next[i - 1].on) [next[i], next[i - 1]] = [next[i - 1], next[i]];
  } else return list;
  return next.flatMap((u) => u.items);
}

/** The list with one object (its whole group) moved so that it sits at `to` in the order, back to front (the Selection Pane's drag). */
export function moveObjectTo(list, id, to) {
  const picked = new Set(withGroups(list, [id]));
  const moving = list.filter((o) => picked.has(o.id)), rest = list.filter((o) => !picked.has(o.id));
  // Never into the middle of another group.
  let at = Math.max(0, Math.min(rest.length, to));
  while (at > 0 && at < rest.length && rest[at - 1].group && rest[at - 1].group === rest[at].group) at--;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/**
 * Group the objects named under the id `group`: they come together in the stacking order where the front
 * one of them was, keeping their order, and an earlier group they belonged to is dissolved into this one.
 */
export function groupObjects(list, ids, group) {
  const picked = new Set(withGroups(list, ids));
  if (picked.size < 2) return null;
  const members = list.filter((o) => picked.has(o.id)).map((o) => ({ ...o, group }));
  const front = list.findLastIndex((o) => picked.has(o.id));
  const out = [];
  list.forEach((o, i) => {
    if (!picked.has(o.id)) out.push(o);
    if (i === front) out.push(...members);
  });
  return out;
}

/** Ungroup: the groups of the objects named are dissolved; their members keep their places. */
export function ungroupObjects(list, ids) {
  const groups = new Set(list.filter((o) => ids.includes(o.id) && o.group).map((o) => o.group));
  if (!groups.size) return null;
  return list.map((o) => (o.group && groups.has(o.group) ? (({ group, ...rest }) => rest)(o) : o));
}

/** The box around some rects ({ x, y, w, h }). */
export function boundsOf(rects) {
  const x1 = Math.min(...rects.map((r) => r.x)), y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w)), y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Where Align puts each object ({ id, x, y, w, h }, sheet pixels): along the box around them all, at its
 * left, centre or right edge, or its top, middle or bottom. Returns { id, x, y } for each.
 */
export function alignRects(rects, how) {
  if (rects.length < 2) return rects.map(({ id, x, y }) => ({ id, x, y }));
  const b = boundsOf(rects);
  return rects.map((r) => {
    const at = { id: r.id, x: r.x, y: r.y };
    if (how === 'left') at.x = b.x;
    else if (how === 'center') at.x = b.x + (b.w - r.w) / 2;
    else if (how === 'right') at.x = b.x + b.w - r.w;
    else if (how === 'top') at.y = b.y;
    else if (how === 'middle') at.y = b.y + (b.h - r.h) / 2;
    else if (how === 'bottom') at.y = b.y + b.h - r.h;
    return at;
  });
}

/**
 * Distribute Horizontally ('horizontal') or Vertically: the first and last objects along the axis stay, and
 * the others move so the gaps between neighbours are equal. Needs three objects; returns { id, x, y } for each.
 */
export function distributeRects(rects, axis) {
  if (rects.length < 3) return rects.map(({ id, x, y }) => ({ id, x, y }));
  const [pos, size] = axis === 'vertical' ? ['y', 'h'] : ['x', 'w'];
  const sorted = rects.slice().sort((a, b) => a[pos] + a[size] / 2 - (b[pos] + b[size] / 2) || a[pos] - b[pos]);
  const first = sorted[0], last = sorted.at(-1);
  const span = last[pos] + last[size] - first[pos];
  const gap = (span - sorted.reduce((n, r) => n + r[size], 0)) / (sorted.length - 1);
  const place = new Map();
  let at = first[pos];
  for (const r of sorted) { place.set(r.id, at); at += r[size] + gap; }
  return rects.map((r) => ({ id: r.id, x: pos === 'x' ? place.get(r.id) : r.x, y: pos === 'y' ? place.get(r.id) : r.y }));
}

/** Can Rotate turn or flip this object? Pictures, shapes and text boxes can; charts, slicers and controls cannot. */
export const canRotate = (obj) => obj?.type === 'image' || obj?.type === 'text';

/** The rotation and flips after Rotate Right 90° ('right'), Rotate Left 90° ('left'), Flip Vertical ('flipV') or Flip Horizontal ('flipH'). */
export function rotatePatch(obj, op) {
  const rotation = obj.rotation || 0;
  if (op === 'right') return { rotation: (rotation + 90) % 360 };
  if (op === 'left') return { rotation: (rotation + 270) % 360 };
  if (op === 'flipH') return { flipH: !obj.flipH };
  if (op === 'flipV') return { flipV: !obj.flipV };
  return {};
}

/**
 * Snap a moving box's left and top to the nearest of some lines (cell edges, other objects' edges) within
 * `within` pixels, by either of its edges along each axis. `xs` and `ys` are the lines; returns { x, y }.
 */
export function snapRect(rect, xs, ys, within) {
  const best = (start, size, lines) => {
    let out = start, gap = within + 1;
    for (const line of lines) for (const edge of [start, start + size]) {
      const d = Math.abs(line - edge);
      if (d < gap) { gap = d; out = start + (line - edge); }
    }
    return out;
  };
  return { x: best(rect.x, rect.w, xs), y: best(rect.y, rect.h, ys) };
}

/**
 * The names the Selection Pane shows: an object's own name, or one by its kind and its place among the
 * objects of that kind (Chart 2, Picture 1, Text Box 3…). Groups are numbered the same way. Returns a Map
 * of object id → name and of group id → name.
 */
export function objectNames(list) {
  const counts = new Map(), names = new Map();
  const next = (kind) => { const n = (counts.get(kind) || 0) + 1; counts.set(kind, n); return `${kind} ${n}`; };
  for (const o of list) {
    if (o.group && !names.has(o.group)) names.set(o.group, next('Group'));
    const kind = o.type === 'image' ? (o.drawingShape || o.nativeDrawing ? 'Shape' : 'Picture')
      : o.type === 'text' ? (o.equation ? 'Equation' : o.style?.effects ? 'WordArt' : 'Text Box')
        : o.type === 'slicer' ? 'Slicer' : o.type === 'timeline' ? 'Timeline' : o.type === 'scroll' ? 'Scroll Bar' : o.type === 'smartart' ? 'SmartArt' : 'Chart';
    const fallback = next(kind);
    names.set(o.id, o.name || ((o.type === 'slicer' || o.type === 'timeline') && o.title ? o.title : fallback));
  }
  return names;
}
