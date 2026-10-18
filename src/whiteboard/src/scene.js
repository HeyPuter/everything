import { remapMindMap } from "./mind-map.js";
import { assertUnlocked, protectedIds } from "./locking.js";
import { shapeAnchor } from "./shapes.js";
import { imageContentBox } from "./image-crop.js";
import { rotationOf, localPoint, worldPoint, frameWithin } from "./geometry.js";
import { uid, clone, bounds, item } from "./model.js";
import { remapObjectLink } from "./object-link-data.js";
export const isConnector = (i) =>
  i.type === "arrow" && Boolean(i.startId || i.endId);
// Whether an object moves by the offset when the objects in `ids` move.
// A line attached to something is redrawn by updateConnectors instead, but
// one attached at a single end to an object moving with it moves whole, so
// its loose end comes along rather than staying behind.
export const movesWith = (i, ids) =>
  !isConnector(i) || (!(i.startId && i.endId) && ids.has(i.startId || i.endId));
export function safeURL(value) {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
// The frames lying within a frame (frameWithin). Frames record no parent of
// their own; this is by position, found by a sweep over the frames by left
// edge, since a board can hold thousands of them.
function nestedFrames(items) {
  const frames = items
    .filter((i) => i.type === "frame")
    .sort((p, q) => p.x - q.x);
  return (outer) => {
    let low = 0,
      high = frames.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (frames[mid].x < outer.x) low = mid + 1;
      else high = mid;
    }
    const found = [];
    for (let n = low; n < frames.length; n++) {
      const inner = frames[n];
      if (inner.x > outer.x + outer.w) break;
      if (frameWithin(inner, outer)) found.push(inner.id);
    }
    return found;
  };
}
// The frame each nested frame lies within: the smallest of the frames that
// hold it, so frames nest as a tree.
export function frameParents(items) {
  const inside = nestedFrames(items),
    area = (f) => f.w * f.h,
    byId = new Map(),
    parents = new Map();
  for (const i of items) if (i.type === "frame") byId.set(i.id, i);
  for (const outer of byId.values())
    for (const id of inside(outer)) {
      const held = byId.get(parents.get(id));
      if (!held || area(outer) < area(held)) parents.set(id, outer.id);
    }
  return parents;
}
export function descendants(items, ids, { groups = true } = {}) {
  const result = new Set(ids),
    children = new Map(),
    groupMembers = new Map(),
    byId = new Map();
  let inside = null;
  for (const i of items) {
    byId.set(i.id, i);
    for (const parent of [i.parentId, i.mindMap?.parent].filter(Boolean)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(i.id);
    }
    if (groups && i.groupId) {
      if (!groupMembers.has(i.groupId)) groupMembers.set(i.groupId, []);
      groupMembers.get(i.groupId).push(i.id);
    }
  }
  const queue = [...ids],
    visitedGroups = new Set();
  for (let n = 0; n < queue.length; n++) {
    const id = queue[n],
      group = byId.get(id)?.groupId;
    const next = [...(children.get(id) || [])];
    if (byId.get(id)?.type === "frame")
      next.push(...(inside ??= nestedFrames(items))(byId.get(id)));
    if (groups && group && !visitedGroups.has(group)) {
      visitedGroups.add(group);
      next.push(...groupMembers.get(group));
    }
    for (const child of next)
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
  }
  return result;
}
// A selected group can also contain later-added frame contents or mind-map
// descendants without giving those children the group's own id.
export function selectionGroupId(chosen) {
  const groupId = chosen.find((i) => i.groupId)?.groupId;
  if (!groupId) return null;
  if (chosen.every((i) => i.groupId === groupId)) return groupId;
  const roots = new Set(
    chosen.filter((i) => i.groupId === groupId).map((i) => i.id),
  );
  const members = descendants(chosen, roots, { groups: false });
  return chosen.every((i) => members.has(i.id)) ? groupId : null;
}
// Partial selections inside a group must not recreate that group when copied,
// or combine independently selected members into one alignment unit.
export function completeGroups(items, ids) {
  const selected = new Set(),
    partial = new Set();
  for (const i of items) {
    if (!i.groupId) continue;
    (ids.has(i.id) ? selected : partial).add(i.groupId);
  }
  for (const id of partial) selected.delete(id);
  return selected;
}
export function unlockedSelection(items, ids, { expand = true } = {}) {
  const blocked = protectedIds(items);
  const candidates = new Set([...ids].filter((id) => !blocked.has(id)));
  if (!expand) return candidates;
  return new Set(
    [...descendants(items, candidates)].filter((id) => !blocked.has(id)),
  );
}
// Locked objects never join a frame, since one would pin the frame in
// place, so each lies in the smallest frame holding its middle, as it
// would have joined it. They are hidden, staged, presented, exported and
// counted with that frame.
export function lockedPlaces(items) {
  const places = new Map(),
    loose = items.filter((i) => i.locked && !i.parentId && i.type !== "frame");
  if (!loose.length) return places;
  const frames = items
    .filter((i) => i.type === "frame")
    .sort((a, b) => a.w * a.h - b.w * b.h);
  for (const i of loose) {
    const cx = i.x + i.w / 2,
      cy = i.y + i.h / 2;
    const frame = frames.find(
      (f) => cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h,
    );
    if (frame) places.set(i.id, frame.id);
  }
  return places;
}
export function frameItems(items, id) {
  return descendants(items, new Set([id]), { groups: false });
}
// frameItems for many frames at once: the board is indexed once, so a board
// with thousands of frames takes one pass instead of one per frame. Each
// frame's set lists its objects in board order.
// With `nested`, a frame also holds the frames lying within it and what
// they hold, as it does when it is moved, copied, exported or presented.
export function framesItems(items, ids, { nested = false } = {}) {
  const children = new Map(),
    order = new Map(),
    byId = new Map(),
    inside = nested ? nestedFrames(items) : null,
    placed = lockedPlaces(items);
  items.forEach((i, n) => {
    order.set(i.id, n);
    byId.set(i.id, i);
    for (const parent of [
      i.parentId || placed.get(i.id),
      i.mindMap?.parent,
    ].filter(Boolean)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(i.id);
    }
  });
  const result = new Map();
  for (const id of ids) {
    const found = new Set([id]),
      queue = [id];
    for (let n = 0; n < queue.length; n++) {
      const frame = inside && byId.get(queue[n]);
      for (const child of [
        ...(children.get(queue[n]) || []),
        ...(frame?.type === "frame" ? inside(frame) : []),
      ])
        if (!found.has(child)) (found.add(child), queue.push(child));
    }
    result.set(
      id,
      new Set(
        [...found]
          .filter((m) => order.has(m))
          .sort((a, b) => order.get(a) - order.get(b)),
      ),
    );
  }
  return result;
}
// Grouping what is already exactly one whole group would only give it a new
// id: an undo step that seems to do nothing.
export function isWholeGroup(items, ids, options) {
  const members = descendants(items, ids, options);
  const groupId = items.find((i) => members.has(i.id))?.groupId;
  return (
    !!groupId &&
    items.every((i) => members.has(i.id) === (i.groupId === groupId))
  );
}
export function group(items, ids, options) {
  assertUnlocked(items, ids);
  const members = descendants(items, ids, options);
  if (members.size < 2) throw Error("Select at least two objects to group.");
  const id = uid();
  const old = new Set();
  for (const i of items)
    if (members.has(i.id)) {
      if (i.groupId) old.add(i.groupId);
      i.groupId = id;
    }
  // A group is two or more objects, so one left alone by grouping part of
  // its group leaves it, as after removeItems.
  if (old.size) {
    const left = new Map();
    for (const i of items)
      if (old.has(i.groupId))
        left.set(i.groupId, (left.get(i.groupId) || 0) + 1);
    for (const i of items)
      if (old.has(i.groupId) && left.get(i.groupId) < 2) delete i.groupId;
  }
  return members;
}
export function ungroup(items, ids) {
  assertUnlocked(items, ids);
  const groups = new Set(
    items.filter((i) => ids.has(i.id)).map((i) => i.groupId),
  );
  for (const i of items) if (groups.has(i.groupId)) delete i.groupId;
}
export function attachToFrame(items, ids, parentId) {
  assertUnlocked(items, ids);
  const frame = items.find((i) => i.id === parentId && i.type === "frame");
  if (parentId && !frame) throw Error("Choose a valid frame.");
  const frames = new Set(
    items.filter((i) => ids.has(i.id) && i.type === "frame").map((i) => i.id),
  );
  for (const i of items.filter((i) => ids.has(i.id))) {
    if (i.type === "frame") continue;
    // What a chosen frame holds stays with it.
    if (frames.has(i.parentId)) continue;
    if (parentId) i.parentId = parentId;
    else delete i.parentId;
  }
  if (!frame) return;
  // An object moved into a frame lies inside it, as its name says: one
  // left outside would leave the frame again with its next move, since a
  // frame holds what its middle is in.
  for (const i of items.filter((i) => ids.has(i.id))) {
    if (i.type === "frame" || i.parentId !== frame.id || isConnector(i))
      continue;
    const cx = i.x + i.w / 2,
      cy = i.y + i.h / 2,
      inside = (c, start, size, extent) =>
        Math.min(
          Math.max(c, start + Math.min(extent / 2, size / 2)),
          start + size - Math.min(extent / 2, size / 2),
        );
    const dx = inside(cx, frame.x, frame.w, i.w) - cx,
      dy = inside(cy, frame.y, frame.h, i.h) - cy;
    if (dx || dy) moveItems(items, new Set([i.id]), dx, dy);
  }
}
// Frames in `skip`, such as frames hidden from this person, never take in
// objects: what someone adds over them stays theirs to see.
export function inferParents(
  items,
  ids,
  { includeLocked = false, skip = null } = {},
) {
  const frames = items
    .filter((i) => i.type === "frame" && !skip?.has(i.id))
    .sort((a, b) => a.w * a.h - b.w * b.h);
  for (const i of items) {
    if (
      (!includeLocked && i.locked) ||
      i.type === "frame" ||
      (ids && !ids.has(i.id))
    )
      continue;
    // A line joining two objects belongs to a frame only when both of its
    // ends are in it: one passing over a frame between objects outside it
    // would otherwise go with the frame when it is deleted or copied.
    const points =
      i.type === "arrow" && i.startId && i.endId
        ? [
            [i.x, i.y],
            [i.x + i.w, i.y + i.h],
          ]
        : [[i.x + i.w / 2, i.y + i.h / 2]];
    const parent = frames.find((f) =>
      points.every(
        ([x, y]) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h,
      ),
    );
    if (parent) i.parentId = parent.id;
    else delete i.parentId;
  }
}
// After objects move, turn, or change size, each whose frame did not move
// with it belongs to the frame its middle is now in. What a moved frame
// holds stays with it, even where it reaches past the frame's edge.
export function inferMovedParents(items, ids, options) {
  const roots = new Set(
    items.filter((i) => ids.has(i.id) && !ids.has(i.parentId)).map((i) => i.id),
  );
  // A line attached to a moved object moved with it, so the frame its
  // middle is in is read again too; a line left behind in a frame would
  // otherwise go with that frame when it is deleted or copied.
  for (const i of items)
    if (
      !ids.has(i.id) &&
      !ids.has(i.parentId) &&
      ((i.startId && ids.has(i.startId)) || (i.endId && ids.has(i.endId)))
    )
      roots.add(i.id);
  if (roots.size) inferParents(items, roots, options);
}
function anchor(box, toward) {
  if (rotationOf(box))
    return worldPoint(
      box,
      anchor({ ...box, rotation: 0 }, localPoint(box, toward)),
    );
  if (box.type === "image" && box.crop?.sourceAspect)
    box = { ...box, ...imageContentBox(box) };
  if (box.type === "rect" && box.shape) return shapeAnchor(box, toward);
  const cx = box.x + box.w / 2,
    cy = box.y + box.h / 2,
    dx = toward.x - cx,
    dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const rx = Math.abs(dx) / (box.w / 2 || 1),
    ry = Math.abs(dy) / (box.h / 2 || 1);
  const scale =
    1 /
    (box.type === "ellipse" ||
    (box.type === "image" && box.crop?.mask === "ellipse")
      ? Math.hypot(rx, ry)
      : Math.max(rx, ry));
  return { x: cx + dx * scale, y: cy + dy * scale };
}
export function updateConnectors(items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const i of items.filter(isConnector)) {
    const start = byId.get(i.startId),
      end = byId.get(i.endId);
    if (!start) delete i.startId;
    if (!end) delete i.endId;
    const startCenter = start
      ? { x: start.x + start.w / 2, y: start.y + start.h / 2 }
      : { x: i.x, y: i.y };
    const endCenter = end
      ? { x: end.x + end.w / 2, y: end.y + end.h / 2 }
      : { x: i.x + i.w, y: i.y + i.h };
    // Orthogonal and curved lines meet the middle of a side so their tangents
    // do not skim or cut through a node boundary. They run across when the
    // ends are further apart across than down, unless the objects overlap
    // across and are clear of each other up and down: the line's bend,
    // halfway between them, would then cut through both.
    if (i.lineType && i.lineType !== "straight") {
      const box = (o, c) => (o ? o : { ...c, w: 0, h: 0 }),
        s = box(start, startCenter),
        e = box(end, endCenter),
        gap = (axis, size) =>
          Math.max(s[axis], e[axis]) -
          Math.min(s[axis] + s[size], e[axis] + e[size]),
        across = gap("x", "w") > 0,
        down = gap("y", "h") > 0;
      i.routeAxis =
        across !== down
          ? across
            ? "x"
            : "y"
          : Math.abs(endCenter.x - startCenter.x) >=
              Math.abs(endCenter.y - startCenter.y)
            ? "x"
            : "y";
    }
    const toward = (from, to) =>
      !i.lineType || i.lineType === "straight"
        ? to
        : i.routeAxis === "x"
          ? { x: to.x, y: from.y }
          : { x: from.x, y: to.y };
    let a = start ? anchor(start, toward(startCenter, endCenter)) : startCenter;
    let b = end ? anchor(end, toward(endCenter, startCenter)) : endCenter;
    // Objects that touch only at a corner would both be met at that corner,
    // leaving no line. The line then leaves the first from the middle of its
    // side facing across, and meets the second in the middle of its side
    // facing up or down, so it runs outside both.
    if (start && end && start !== end && Math.hypot(b.x - a.x, b.y - a.y) < 1) {
      const dx = endCenter.x - startCenter.x,
        dy = endCenter.y - startCenter.y;
      if (dx && dy) {
        a = { x: dx > 0 ? start.x + start.w : start.x, y: startCenter.y };
        b = { x: endCenter.x, y: dy > 0 ? end.y : end.y + end.h };
      }
    }
    i.x = a.x;
    i.y = a.y;
    i.w = b.x - a.x;
    i.h = b.y - a.y;
  }
}
export function connectObjects(items, ids) {
  const nodes = items.filter(
    (i) => ids.has(i.id) && !["arrow", "pen", "frame"].includes(i.type),
  );
  if (nodes.length !== 2) throw Error("Select exactly two objects to connect.");
  const arrow = item("arrow", 0, 0, {
    startId: nodes[0].id,
    endId: nodes[1].id,
  });
  items.unshift(arrow);
  updateConnectors(items);
  return arrow;
}
export function moveItems(items, ids, dx, dy, options) {
  assertUnlocked(items, ids);
  const expanded = descendants(items, ids, options);
  for (const i of items) {
    if (expanded.has(i.id) && movesWith(i, expanded)) {
      i.x += dx;
      i.y += dy;
    }
  }
  updateConnectors(items);
  return expanded;
}
export function duplicateItems(items, ids, offset = 30, options) {
  const expanded = descendants(items, ids, options),
    chosen = items.filter((i) => expanded.has(i.id)),
    map = new Map(chosen.map((i) => [i.id, uid()])),
    groups = new Map(),
    wholeGroups = completeGroups(items, expanded);
  const copies = chosen.map((i) => {
    const c = clone(i);
    c.id = map.get(i.id);
    remapObjectLink(c, map);
    remapMindMap(c, map);
    c.x += offset;
    c.y += offset;
    if (c.groupId && !wholeGroups.has(c.groupId)) delete c.groupId;
    if (c.groupId) {
      if (!groups.has(c.groupId)) groups.set(c.groupId, uid());
      c.groupId = groups.get(c.groupId);
    }
    if (c.parentId) c.parentId = map.get(c.parentId) || c.parentId;
    if (c.startId) c.startId = map.get(c.startId) || c.startId;
    if (c.endId) c.endId = map.get(c.endId) || c.endId;
    return c;
  });
  items.push(...copies);
  updateConnectors(items);
  return new Set(copies.map((i) => i.id));
}
export function removeItems(items, ids, options) {
  assertUnlocked(items, ids, { deleting: true });
  const expanded = descendants(items, ids, options);
  const kept = items.filter(
    (i) =>
      !expanded.has(i.id) && !expanded.has(i.startId) && !expanded.has(i.endId),
  );
  // A group is two or more objects. One left on its own is no longer in
  // a group: it would otherwise resize and lock as a group member does.
  const members = new Map();
  for (const i of kept)
    if (i.groupId) members.set(i.groupId, (members.get(i.groupId) || 0) + 1);
  for (const i of kept)
    if (i.groupId && members.get(i.groupId) < 2) delete i.groupId;
  return kept;
}
export function createFrame(items, ids, title = "Section", options) {
  assertUnlocked(items, ids);
  const selected = descendants(items, ids, options),
    b = bounds(items.filter((i) => selected.has(i.id)));
  // Around objects at the board's edge, the frame starts at the edge.
  const edge = (n) => Math.max(-1e6, Math.min(1e6, n));
  const f = item("frame", edge(b.x - 30), edge(b.y - 65), {
    w: b.w + 60,
    h: b.h + 95,
    text: title,
    order: nextFrameOrder(items),
  });
  items.unshift(f);
  // A selected frame keeps its own contents and lies inside the new frame,
  // which takes it along; only the objects outside it join the new frame.
  attachToFrame(items, selected, f.id);
  return f;
}
export function orderedFrames(items) {
  return items
    .filter((i) => i.type === "frame")
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}
// New frames are numbered, as in Miro: after the board's frames, and past
// any number already used in either language, so two frames never share a
// name by default. `word` is "Frame" in the interface language.
export function nextFrameTitle(items, word = "Frame") {
  let n = items.filter((i) => i.type === "frame").length;
  for (const i of items) {
    const match =
      i.type === "frame" && /^(?:Frame|Cadre) (\d+)$/.exec(i.text || "");
    if (match) n = Math.max(n, Number(match[1]));
  }
  return `${word} ${n + 1}`;
}
// Copied or pasted frames whose places in the presentation order are taken,
// as by the frames they were copied from, present after every frame on the
// board, in their own order, rather than sharing those places; frames cut
// and pasted back keep theirs.
export function orderAfterFrames(items, copies) {
  const taken = new Set(
      items.filter((i) => i.type === "frame").map((f) => f.order || 0),
    ),
    copied = orderedFrames(copies);
  if (!copied.some((f) => taken.has(f.order || 0))) return;
  const last = nextFrameOrder(items);
  copied.forEach((f, n) => (f.order = last + n));
}
// The order a new frame takes to come after every frame on the board; a
// count of frames would repeat an order once one has been deleted.
export function nextFrameOrder(items) {
  return items
    .filter((i) => i.type === "frame")
    .reduce((n, i) => Math.max(n, (i.order || 0) + 1), 0);
}
// Groups and selected frames form atomic layout units. Attached connectors
// follow their endpoints and never contribute their own layout bounds.
export function layoutUnits(items, ids, options) {
  const selected = descendants(items, ids, options);
  const parents = new Map();
  const roots = new Map();
  const wholeGroups = completeGroups(items, selected);
  const find = (id) => {
    if (!parents.has(id)) parents.set(id, id);
    let root = id;
    while (parents.get(root) !== root) root = parents.get(root);
    while (id !== root) {
      const next = parents.get(id);
      parents.set(id, root);
      id = next;
    }
    return root;
  };
  const join = (a, b) => parents.set(find(a), find(b));
  for (const i of items) {
    if (!selected.has(i.id)) continue;
    find(i.id);
    if (i.parentId && selected.has(i.parentId)) join(i.id, i.parentId);
    // A line attached at one end goes where its object goes.
    if (isConnector(i) && movesWith(i, selected))
      join(i.id, i.startId || i.endId);
    if (
      i.groupId &&
      i.groupId !== options?.withinGroup &&
      wholeGroups.has(i.groupId)
    ) {
      if (roots.has(i.groupId)) join(i.id, roots.get(i.groupId));
      else roots.set(i.groupId, i.id);
    }
  }
  const units = new Map();
  for (const i of items) {
    if (!selected.has(i.id)) continue;
    const root = find(i.id);
    if (!units.has(root)) units.set(root, { ids: new Set(), items: [] });
    const unit = units.get(root);
    unit.ids.add(i.id);
    if (!isConnector(i)) unit.items.push(i);
  }
  return [...units.values()]
    .filter((unit) => unit.items.length)
    .map((unit) => ({ ids: unit.ids, box: bounds(unit.items) }));
}

// Plan first so commands that cannot move anything don't consume undo history.
export function layoutMoves(items, ids, mode, options) {
  assertUnlocked(items, ids);
  const units = layoutUnits(items, ids, options);
  const distribute = ["horizontal", "vertical"].includes(mode);
  if (units.length < (distribute ? 3 : 2)) return [];
  const b = bounds(units.map((unit) => unit.box));
  if (distribute) {
    const axis = mode === "horizontal" ? "x" : "y";
    const size = mode === "horizontal" ? "w" : "h";
    units.sort((a, b) => a.box[axis] - b.box[axis]);
    // Keep the first and last objects anchored, even when objects overlap.
    const first = units[0].box,
      last = units.at(-1).box;
    const gap =
      (last[axis] -
        first[axis] -
        units.slice(0, -1).reduce((sum, unit) => sum + unit.box[size], 0)) /
      (units.length - 1);
    let position = first[axis] + first[size] + gap;
    return units
      .slice(1, -1)
      .map((unit) => {
        const delta = position - unit.box[axis];
        position += unit.box[size] + gap;
        return {
          ids: unit.ids,
          dx: axis === "x" ? delta : 0,
          dy: axis === "y" ? delta : 0,
        };
      })
      .filter((move) => Math.abs(move.dx) > 1e-9 || Math.abs(move.dy) > 1e-9);
  }
  return units
    .map(({ ids, box: i }) => ({
      ids,
      dx:
        mode === "left"
          ? b.x - i.x
          : mode === "center"
            ? b.x + b.w / 2 - i.x - i.w / 2
            : mode === "right"
              ? b.x + b.w - i.x - i.w
              : 0,
      dy:
        mode === "top"
          ? b.y - i.y
          : mode === "middle"
            ? b.y + b.h / 2 - i.y - i.h / 2
            : mode === "bottom"
              ? b.y + b.h - i.y - i.h
              : 0,
    }))
    .filter((move) => Math.abs(move.dx) > 1e-9 || Math.abs(move.dy) > 1e-9);
}
export function applyLayout(items, moves, options) {
  const moved = new Set(moves.flatMap((move) => [...move.ids]));
  assertUnlocked(items, moved);
  const offsets = new Map();
  for (const { ids, dx, dy } of moves)
    for (const id of ids) offsets.set(id, { dx, dy });
  for (const i of items) {
    const offset = offsets.get(i.id);
    if (!offset || !movesWith(i, offsets)) continue;
    i.x += offset.dx;
    i.y += offset.dy;
  }
  // Aligning or distributing can carry an object across a frame's edge; it
  // then belongs to the frame it lands in, as after a drag.
  inferMovedParents(items, moved, options);
  updateConnectors(items);
}
export function alignItems(items, ids, mode, options) {
  applyLayout(items, layoutMoves(items, ids, mode, options), options);
}

export function reorderItems(items, ids, direction, options) {
  assertUnlocked(items, ids);
  const selected = descendants(items, ids, options);
  const objects = items.filter((i) => i.type !== "frame");
  let ordered = objects.slice();
  if (direction === "front" || direction === "back") {
    const chosen = objects.filter((i) => selected.has(i.id));
    const rest = objects.filter((i) => !selected.has(i.id));
    ordered =
      direction === "front" ? [...rest, ...chosen] : [...chosen, ...rest];
  } else if (direction === "forward") {
    for (let n = ordered.length - 2; n >= 0; n--)
      if (selected.has(ordered[n].id) && !selected.has(ordered[n + 1].id))
        [ordered[n], ordered[n + 1]] = [ordered[n + 1], ordered[n]];
  } else if (direction === "backward") {
    for (let n = 1; n < ordered.length; n++)
      if (selected.has(ordered[n].id) && !selected.has(ordered[n - 1].id))
        [ordered[n], ordered[n - 1]] = [ordered[n - 1], ordered[n]];
  }
  if (ordered.every((i, n) => i === objects[n])) return items;
  let n = 0;
  return items.map((i) => (i.type === "frame" ? i : ordered[n++]));
}
