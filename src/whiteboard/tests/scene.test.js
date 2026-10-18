import test from "node:test";
import assert from "node:assert/strict";
import { item, board, validateBoard, bounds } from "../src/model.js";
import {
  descendants,
  group,
  ungroup,
  createFrame,
  moveItems,
  connectObjects,
  updateConnectors,
  duplicateItems,
  inferMovedParents,
  inferParents,
  attachToFrame,
  removeItems,
  orderedFrames,
  nextFrameTitle,
  orderAfterFrames,
  frameItems,
  safeURL,
  alignItems,
  layoutUnits,
  layoutMoves,
  reorderItems,
} from "../src/scene.js";
import { TEMPLATE_CATALOG, fromTemplate } from "../src/templates.js";

test("alignment preserves spacing inside groups and frames", () => {
  for (const container of ["group", "frame"]) {
    const items = [item("note", 200, 100), item("note", 450, 160)];
    const members = new Set(items.map((i) => i.id));
    if (container === "group") group(items, members);
    else createFrame(items, members);
    const first = items.find((i) => i.type === "note");
    const second = items.filter((i) => i.type === "note")[1];
    const offset = { x: second.x - first.x, y: second.y - first.y };
    const other = item("rect", 0, 0);
    items.push(other);
    alignItems(items, new Set(items.map((i) => i.id)), "left");
    assert.equal(
      Math.min(...items.filter((i) => i !== other).map((i) => i.x)),
      0,
    );
    assert.deepEqual({ x: second.x - first.x, y: second.y - first.y }, offset);
    assert.equal(other.x, 0);
  }
});

test("groups move atomically and ungroup without changing content", () => {
  const items = [item("note", 10, 20), item("rect", 220, 20)];
  group(items, new Set(items.map((i) => i.id)));
  moveItems(items, new Set([items[0].id]), 35, 50);
  assert.deepEqual(
    items.map((i) => [i.x, i.y]),
    [
      [45, 70],
      [255, 70],
    ],
  );
  ungroup(items, new Set([items[0].id]));
  assert.equal(descendants(items, new Set([items[0].id])).size, 1);
});
test("frames are logical containers whose content moves and duplicates with remapped membership", () => {
  const items = [
      item("note", 10, 70),
      item("table", 220, 70, { cells: [["A", "B"]] }),
    ],
    children = new Set(items.map((i) => i.id));
  const frame = createFrame(items, children, "Planning");
  assert.equal(frameItems(items, frame.id).size, 3);
  const prior = items.map((i) => [i.x, i.y]);
  moveItems(items, new Set([frame.id]), 100, 200);
  items.forEach((i, n) =>
    assert.deepEqual([i.x, i.y], [prior[n][0] + 100, prior[n][1] + 200]),
  );
  const copies = duplicateItems(items, new Set([frame.id]));
  assert.equal(copies.size, 3);
  const copiedFrame = items.find((i) => copies.has(i.id) && i.type === "frame");
  assert.equal(items.filter((i) => i.parentId === copiedFrame.id).length, 2);
  assert.equal(removeItems(items, new Set([frame.id])).length, 3);
});
test("attached connectors follow movement and resizing and clone their endpoints", () => {
  const items = [
    item("rect", 0, 0, { w: 100, h: 100 }),
    item("rect", 300, 0, { w: 100, h: 100 }),
  ];
  const first = items[0],
    second = items[1],
    line = connectObjects(items, new Set([first.id, second.id]));
  assert.deepEqual([line.x, line.y, line.w, line.h], [100, 50, 200, 0]);
  moveItems(items, new Set([second.id]), 100, 0);
  assert.equal(line.w, 300);
  first.w = 200;
  updateConnectors(items);
  assert.equal(line.x, 200);
  assert.equal(line.w, 200);
  const copies = duplicateItems(items, new Set(items.map((i) => i.id)));
  const cloned = items.find((i) => copies.has(i.id) && i.type === "arrow");
  assert.ok(copies.has(cloned.startId) && copies.has(cloned.endId));
  assert.ok(
    !removeItems(items, new Set([first.id])).some((i) => i.id === line.id),
  );
});
test("every specialist template is valid, bilingual, and uses actual editable containers", () => {
  assert.ok(TEMPLATE_CATALOG.length >= 40);
  for (const lang of ["en", "fr"])
    for (const def of TEMPLATE_CATALOG) {
      const b = fromTemplate(def.id, lang);
      assert.equal(validateBoard(b), b);
      assert.ok(b.items.length >= 4);
      assert.equal(b.title, def.name[lang === "fr" ? 1 : 0]);
      if (def.id !== "mindmap") assert.ok(b.items.some((i) => i.parentId));
    }
});
test("links, tables, attachments, and relationship imports are validated", () => {
  assert.equal(safeURL("javascript:alert(1)"), null);
  assert.equal(safeURL("https://example.com"), "https://example.com/");
  for (const i of [
    item("link", 0, 0, { url: "javascript:alert(1)" }),
    item("table", 0, 0, { cells: [["a"], ["b", "c"]] }),
    item("file", 0, 0, {
      fileName: "x.html",
      data: "data:text/html;base64,abcd",
    }),
    item("note", 0, 0, { parentId: "missing" }),
  ]) {
    const b = board();
    b.items = [i];
    assert.throws(() => validateBoard(b));
  }
});

test("all six alignments use outer bounds, including reverse arrows", () => {
  for (const mode of ["left", "center", "right", "top", "middle", "bottom"]) {
    const a = item("rect", -100, -80, { w: 40, h: 60 });
    const b = item("arrow", 160, 140, { w: -60, h: -40 });
    const items = [a, b];
    const before = structuredClone(items);
    alignItems(items, new Set(items.map((i) => i.id)), mode);
    const boxes = items.map((i) => bounds([i]));
    const coordinate = (box) =>
      ({
        left: box.x,
        center: box.x + box.w / 2,
        right: box.x + box.w,
        top: box.y,
        middle: box.y + box.h / 2,
        bottom: box.y + box.h,
      })[mode];
    assert.equal(coordinate(boxes[0]), coordinate(boxes[1]));
    assert.equal(coordinate(boxes[0]), coordinate(bounds(before)));
    items.forEach((i, n) => {
      assert.equal(i.w, before[n].w);
      assert.equal(i.h, before[n].h);
      assert.equal(
        ["top", "middle", "bottom"].includes(mode) ? i.x : i.y,
        ["top", "middle", "bottom"].includes(mode) ? before[n].x : before[n].y,
      );
    });
    assert.equal(
      layoutMoves(items, new Set(items.map((i) => i.id)), mode).length,
      0,
    );
  }
});

test("distribution keeps endpoints fixed and gives unequal-size objects equal gaps on either axis", () => {
  for (const mode of ["horizontal", "vertical"]) {
    for (const overlap of [false, true]) {
      const step = overlap ? 20 : 200;
      const items = [
        item("rect", -100, -100, { w: 80, h: 50 }),
        item("rect", -90, -90, { w: 120, h: 90 }),
        item("rect", -80, -80, { w: 60, h: 70 }),
        item("rect", step, step, { w: 40, h: 30 }),
      ];
      const before = structuredClone(items);
      alignItems(items, new Set(items.map((i) => i.id)), mode);
      assert.deepEqual(items[0], before[0]);
      assert.deepEqual(items.at(-1), before.at(-1));
      const axis = mode === "horizontal" ? "x" : "y";
      const size = mode === "horizontal" ? "w" : "h";
      const gaps = items
        .slice(1)
        .map((i, n) => i[axis] - items[n][axis] - items[n][size]);
      assert.ok(gaps.every((gap) => Math.abs(gap - gaps[0]) < 1e-9));
    }
  }
});

test("a frame around objects at the board's edge stays on the board", () => {
  const corner = item("note", -1e6, -1e6, { w: 190, h: 160 });
  const b = board("Edge");
  b.items = [corner];
  validateBoard(b);
  const frame = createFrame(b.items, new Set([corner.id]));
  assert.equal(frame.x, -1e6);
  assert.equal(frame.y, -1e6);
  assert.equal(corner.parentId, frame.id);
  validateBoard(b);
});

test("layout treats connected group/frame relationships atomically and updates connectors once", () => {
  const items = [item("note", 100, 80), item("note", 320, 120)];
  const first = items[0],
    second = items[1];
  const frame = createFrame(items, new Set([first.id]));
  group(items, new Set([first.id, second.id]));
  const outside = item("rect", 900, 300),
    far = item("rect", 1400, 600);
  items.push(outside, far);
  const arrow = connectObjects(items, new Set([first.id, outside.id]));
  const ids = new Set(items.map((i) => i.id));
  assert.equal(layoutUnits(items, ids).length, 3);
  const relative = [
    first.x - frame.x,
    first.y - frame.y,
    second.x - first.x,
    second.y - first.y,
  ];
  alignItems(items, ids, "middle");
  assert.deepEqual(
    [
      first.x - frame.x,
      first.y - frame.y,
      second.x - first.x,
      second.y - first.y,
    ],
    relative,
  );
  const snapshot = structuredClone(arrow);
  updateConnectors(items);
  assert.deepEqual(arrow, snapshot);
  assert.equal(layoutMoves(items, new Set([arrow.id]), "horizontal").length, 0);
  assert.equal(
    layoutMoves(items, new Set([outside.id, far.id]), "horizontal").length,
    0,
  );
});

test("layer actions preserve selected order, skip frames, respect groups, and stop at stack boundaries", () => {
  const items = ["a", "b", "c", "d", "e"].map((id) =>
    item("note", 0, 0, { id }),
  );
  const ids = new Set(["b", "c"]);
  const names = (items) =>
    items
      .filter((i) => i.type !== "frame")
      .map((i) => i.id)
      .join("");
  assert.equal(names(reorderItems(items, ids, "front")), "adebc");
  assert.equal(names(reorderItems(items, ids, "back")), "bcade");
  assert.equal(names(reorderItems(items, ids, "forward")), "adbce");
  assert.equal(names(reorderItems(items, ids, "backward")), "bcade");
  assert.equal(
    names(reorderItems(items, new Set(["b", "d"]), "forward")),
    "acbed",
  );
  assert.equal(reorderItems(items, new Set(["e"]), "front"), items);
  assert.equal(reorderItems(items, new Set(["a"]), "backward"), items);
  assert.equal(reorderItems(items, new Set(), "front"), items);
  group(items, ids);
  const frame = item("frame", 0, 0);
  items.splice(2, 0, frame);
  const result = reorderItems(items, new Set(["b"]), "front");
  assert.equal(names(result), "adebc");
  assert.equal(result[2], frame);
  assert.equal(reorderItems(items, new Set([frame.id]), "front"), items);
  assert.equal(names(items), "abcde");
});

test("moved objects join the frame they land in unless their own frame moved too", () => {
  const f = item("frame", 0, 0, { w: 300, h: 200 }),
    g = item("frame", 1000, 0, { w: 300, h: 300 }),
    child = item("note", 250, 20, { w: 100, h: 100, parentId: f.id }),
    loose = item("note", 1100, 100, { w: 100, h: 100 });
  const items = [f, g, child, loose];
  // The frame, its child reaching past its edge, and a loose note moved
  // together: the note lands in the other frame; the child stays.
  inferMovedParents(items, new Set([f.id, child.id, loose.id]));
  assert.equal(loose.parentId, g.id);
  assert.equal(child.parentId, f.id);
  assert.equal(f.parentId, undefined);
  // Moved on its own out of every frame, the child leaves its frame.
  child.x = 500;
  inferMovedParents(items, new Set([child.id]));
  assert.equal(child.parentId, undefined);
});

test("a line between moved objects leaves the frame with them", () => {
  const f = item("frame", 0, 0, { w: 400, h: 300 }),
    a = item("note", 20, 20, { w: 100, h: 100 }),
    b = item("note", 250, 20, { w: 100, h: 100 });
  const items = [f, a, b];
  const line = connectObjects(items, new Set([a.id, b.id]));
  inferMovedParents(items, new Set([line.id]));
  assert.equal(line.parentId, f.id);
  moveItems(items, new Set([a.id, b.id]), 0, 600);
  inferMovedParents(items, new Set([a.id, b.id]));
  assert.equal(a.parentId, undefined);
  assert.equal(line.parentId, undefined);
  const left = removeItems(items, new Set([f.id]));
  assert.ok(left.includes(line), "deleting the empty frame keeps the line");
  // Moved back in, the line joins the frame again.
  moveItems(items, new Set([a.id, b.id]), 0, -600);
  inferMovedParents(items, new Set([a.id, b.id]));
  assert.equal(line.parentId, f.id);
});

test("a line passing over a frame between objects outside it stays out of the frame", () => {
  const f = item("frame", 300, 0, { w: 300, h: 300 }),
    a = item("note", 0, 100, { w: 100, h: 100 }),
    b = item("note", 800, 100, { w: 100, h: 100 });
  const items = [f, a, b];
  const line = connectObjects(items, new Set([a.id, b.id]));
  inferParents(items, new Set([line.id]));
  assert.equal(line.parentId, undefined);
  assert.deepEqual([...descendants(items, new Set([f.id]))], [f.id]);
  assert.ok(
    removeItems(items, new Set([f.id])).includes(line),
    "deleting the empty frame keeps the line",
  );
  // A free line still goes by its middle.
  const free = item("arrow", 200, 150, { w: 300, h: 0 });
  items.push(free);
  inferParents(items, new Set([free.id]));
  assert.equal(free.parentId, f.id);
});

test("aligning across a frame's edge updates frame membership like a drag does", () => {
  const f = item("frame", 0, 0, { w: 400, h: 300 }),
    a = item("note", 40, 80, { parentId: f.id }),
    b = item("note", 1000, 80);
  const items = [f, a, b];
  // Right-aligned, the note from the frame lands far outside it.
  alignItems(items, new Set([a.id, b.id]), "right");
  assert.equal(a.x, b.x);
  assert.equal(a.parentId, undefined, "the note left the frame");
  // Left-aligned to the frame's note, the loose note lands inside it.
  alignItems(items, new Set([a.id, b.id]), "left");
  assert.equal(a.parentId, undefined);
  b.y = 80;
  alignItems(items, new Set([b.id, a.id]), "left");
  const inside = item("note", 60, 60);
  items.push(inside);
  alignItems(items, new Set([b.id, inside.id]), "left");
  assert.equal(b.parentId, f.id, "the loose note joined the frame");
});

test("removing all but one member of a group leaves the survivor ungrouped", () => {
  const f = item("frame", 0, 0, { w: 400, h: 300, groupId: "g1" }),
    n = item("note", 600, 80, { groupId: "g1" }),
    p = item("note", 900, 80, { groupId: "g2" }),
    q = item("note", 950, 80, { groupId: "g2" }),
    r = item("note", 1000, 80, { groupId: "g2" });
  let items = [f, n, p, q, r];
  // Inside the group, one member is deleted on its own.
  items = removeItems(items, new Set([n.id]), { groups: false });
  assert.ok(items.includes(f));
  assert.equal(f.groupId, undefined, "a frame alone is not a group member");
  items = removeItems(items, new Set([r.id]), { groups: false });
  assert.equal(p.groupId, "g2", "two members still make a group");
  assert.equal(q.groupId, "g2");
});

test("moving a frame into another frame leaves it its contents", () => {
  const f = item("frame", 0, 0, { w: 400, h: 300 }),
    g = item("frame", 1000, 0, { w: 400, h: 300 }),
    a = item("note", 40, 80, { parentId: f.id }),
    loose = item("note", 600, 80);
  const items = [f, g, a, loose];
  attachToFrame(items, new Set([f.id, a.id, loose.id]), g.id);
  assert.equal(a.parentId, f.id);
  assert.equal(loose.parentId, g.id);
  assert.equal(f.parentId, undefined);
  attachToFrame(items, new Set([f.id, a.id]), null);
  assert.equal(a.parentId, f.id);
});

test("a frame drawn around other frames takes them, and what they hold, along", async () => {
  const { hasLocked } = await import("../src/locking.js");
  const todo = item("frame", 0, 0, { w: 300, h: 600, text: "To do" }),
    done = item("frame", 340, 0, { w: 300, h: 600, text: "Done" }),
    card = item("note", 40, 80, { text: "Card", parentId: todo.id }),
    finished = item("note", 380, 80, { text: "Shipped", parentId: done.id }),
    // The same size as another frame: neither holds the other.
    twin = item("frame", 340, 0, { w: 300, h: 600, text: "Twin" });
  const items = [todo, done, card, finished, twin];
  const board = createFrame(
    items,
    new Set([todo.id, done.id, twin.id]),
    "Board",
  );
  const all = descendants(items, new Set([board.id]));
  for (const i of [todo, done, card, finished, twin])
    assert.ok(all.has(i.id), i.text);
  assert.equal(descendants(items, new Set([done.id])).has(twin.id), false);
  assert.equal(descendants(items, new Set([twin.id])).has(done.id), false);
  moveItems(items, new Set([board.id]), 50, 0);
  assert.deepEqual(
    [todo.x, done.x, card.x, finished.x],
    [50, 390, 90, 430],
    "The columns and their cards move with the frame around them",
  );
  // Deleting it deletes them, and a locked card inside protects it.
  finished.locked = true;
  assert.equal(hasLocked(items, new Set([board.id])), true);
  assert.equal(hasLocked(items, new Set([todo.id])), false);
  delete finished.locked;
  assert.deepEqual(
    removeItems(items, new Set([board.id])).map((i) => i.id),
    [],
  );
  // A frame dragged out of the larger one no longer belongs to it.
  todo.x = 5000;
  assert.equal(descendants(items, new Set([board.id])).has(todo.id), false);
});

test("a new frame comes after every frame, also once one has been deleted", () => {
  const a = item("frame", 0, 0, { order: 0 }),
    b = item("frame", 500, 0, { order: 1 }),
    c = item("frame", 1000, 0, { order: 2 }),
    d = item("frame", 1500, 0, { order: 3 }),
    note = item("note", 2100, 20);
  let items = [a, b, c, d, note];
  items = removeItems(items, new Set([c.id]));
  const f = createFrame(items, new Set([note.id]));
  assert.deepEqual(
    orderedFrames(items).map((x) => x.id),
    [a.id, b.id, d.id, f.id],
  );
});

test("a frame around a selected frame leaves that frame its contents", () => {
  const inner = item("frame", 0, 0, { w: 400, h: 300, text: "Inner" });
  const a = item("note", 40, 80, { parentId: inner.id });
  const b = item("note", 600, 80);
  const items = [inner, a, b];
  const outer = createFrame(items, new Set([inner.id, b.id]), "Section");
  assert.equal(a.parentId, inner.id);
  assert.equal(b.parentId, outer.id);
  assert.equal(inner.parentId, undefined);
  // The new frame surrounds everything that was selected.
  const box = bounds([inner, a, b]);
  assert.ok(outer.x < box.x && outer.x + outer.w > box.x + box.w);
  moveItems(items, new Set([inner.id]), 100, 0);
  assert.equal(a.x, 140);
  validateBoard({ ...board(), items });
});

test("moving an object into a frame brings it inside, where a nudge keeps it", () => {
  const f = item("frame", 400, 400, { w: 400, h: 300 }),
    far = item("note", 0, 0),
    near = item("note", 420, 440),
    line = item("arrow", 0, 0, { w: 100, h: 0, startId: far.id });
  const items = [f, far, near, line];
  attachToFrame(items, new Set([far.id, near.id]), f.id);
  assert.equal(far.parentId, f.id);
  assert.equal(near.parentId, f.id);
  // One already inside stays where it was; the far one now lies inside,
  // so moving it afterwards does not drop it out of the frame again.
  assert.deepEqual([near.x, near.y], [420, 440]);
  const cx = far.x + far.w / 2,
    cy = far.y + far.h / 2;
  assert.ok(cx > f.x && cx < f.x + f.w && cy > f.y && cy < f.y + f.h);
  assert.ok(
    line.x >= far.x && line.x <= far.x + far.w && line.y >= far.y,
    "its connector followed",
  );
  inferMovedParents(items, new Set([far.id]));
  assert.equal(far.parentId, f.id);
});

test("objects touching only at a corner are joined by a line outside both", () => {
  const a = item("rect", 0, 0, { w: 200, h: 120 }),
    b = item("rect", 200, 120, { w: 200, h: 120 });
  const items = [a, b];
  const line = connectObjects(items, new Set([a.id, b.id]));
  assert.ok(Math.hypot(line.w, line.h) > 50, "a visible line");
  // From the middle of the first one's right side to the middle of the
  // second's top, outside both.
  assert.deepEqual([line.x, line.y], [200, 60]);
  assert.deepEqual([line.x + line.w, line.y + line.h], [300, 120]);
});

test("grouping part of a group leaves no one-member group behind", () => {
  const items = [
    item("note", 0, 0, { groupId: "old" }),
    item("note", 300, 0, { groupId: "old" }),
    item("note", 600, 0, { groupId: "old" }),
    item("note", 0, 300, { groupId: "pair" }),
    item("note", 300, 300, { groupId: "pair" }),
    item("note", 600, 300, { groupId: "pair" }),
  ];
  const [a, b, c, d, e, f] = items;
  group(items, new Set([a.id, b.id]), { groups: false });
  assert.equal(a.groupId, b.groupId);
  assert.notEqual(a.groupId, "old");
  assert.equal(c.groupId, undefined);
  // An old group keeping two members stays a group.
  group(items, new Set([d.id, a.id]), { groups: false });
  assert.equal(e.groupId, "pair");
  assert.equal(f.groupId, "pair");
  assert.equal(b.groupId, undefined);
});

test("new frames are numbered past every default name in either language", () => {
  assert.equal(nextFrameTitle([]), "Frame 1");
  const items = [
    item("frame", 0, 0, { text: "Frame 2" }),
    item("frame", 0, 0, { text: "Cadre 7" }),
    item("frame", 0, 0, { text: "Ideas" }),
  ];
  assert.equal(nextFrameTitle(items), "Frame 8");
  assert.equal(nextFrameTitle(items, "Cadre"), "Cadre 8");
  assert.equal(nextFrameTitle(items.slice(2), "Cadre"), "Cadre 2");
});

test("copied frames present after the board's frames unless their place is free", async () => {
  const { planDuplication } = await import("../src/duplication.js");
  const a = item("frame", 0, 0, { w: 400, h: 300, text: "A", order: 0 }),
    b = item("frame", 600, 0, { w: 400, h: 300, text: "B", order: 1 }),
    items = [a, b];
  const { copies } = planDuplication(items, new Set([a.id]));
  assert.deepEqual(
    copies.map((f) => f.order),
    [2],
    "A duplicate does not share its original's place",
  );
  // Two copies keep their order between them, after the board's frames.
  const both = planDuplication(items, new Set([a.id, b.id])).copies;
  assert.deepEqual(
    orderedFrames(both).map((f) => [f.text, f.order]),
    [
      ["A", 2],
      ["B", 3],
    ],
  );
  // A frame cut and pasted back keeps its place.
  const cut = { ...structuredClone(a), id: "pasted" };
  orderAfterFrames([b], [cut]);
  assert.equal(cut.order, 0);
  // Slides 4 and 5 pasted onto a board whose frames take orders 0 to 3
  // present after them in their own order, not as 5 then 4.
  const target = [0, 1, 2, 3].map((order) =>
      item("frame", order * 500, 0, { order }),
    ),
    four = item("frame", 0, 600, { text: "4", order: 3 }),
    five = item("frame", 500, 600, { text: "5", order: 4 });
  orderAfterFrames(target, [four, five]);
  assert.deepEqual([four.order, five.order], [4, 5]);
});
