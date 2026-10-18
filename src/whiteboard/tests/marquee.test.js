import test from "node:test";
import assert from "node:assert/strict";
import { item } from "../src/model.js";
import {
  createMarqueeIndex,
  marqueeSelection,
  readPreciseSelection,
} from "../src/marquee.js";
const ids = (index, x, y, w, h, precise = false) => [
  ...marqueeSelection(index, { x, y, w, h }, precise),
];

test("marquee selection distinguishes touching from 90% coverage and applies strict coverage to tables and mind nodes", () => {
  const items = [
    "note",
    "rect",
    "ellipse",
    "text",
    "image",
    "frame",
    "link",
    "file",
    "table",
  ].map((type) => item(type, -100, -100, { w: 100, h: 100 }));
  items.push(
    item("note", -100, -100, { w: 100, h: 100, mindMap: { parent: null } }),
  );
  const index = createMarqueeIndex(items);
  assert.equal(ids(index, -110, -110, 20, 20).length, 8);
  assert.equal(ids(index, -110, -110, 20, 20, true).length, 0);
  assert.equal(ids(index, -100, -100, 90, 100, true).length, 10);
  assert.equal(ids(index, -100, -100, 89.9, 100, true).length, 0);
  assert.equal(ids(index, -100, -100, 95, 95, true).length, 10);
  assert.equal(ids(index, -100, -100, 94, 95, true).length, 0);
  assert.equal(ids(index, 0, 0, 0, 100).length, 0);
  assert.equal(readPreciseSelection("true"), true);
  for (const value of [null, "", "false", "garbage"])
    assert.equal(readPreciseSelection(value), false);
});

test("marquee indexes respect protected groups, independent frame children and visible collapsed branches", () => {
  const frame = item("frame", 0, 0, { w: 500, h: 500, locked: true }),
    note = item("note", 20, 20, { parentId: frame.id }),
    locked = item("rect", 40, 40, { groupId: "g", locked: true }),
    mate = item("rect", 80, 40, { groupId: "g" }),
    root = item("rect", 200, 0, { mindMap: { parent: null } }),
    hidden = item("rect", 440, 0, { mindMap: { parent: root.id } });
  const items = [frame, note, locked, mate, root, hidden],
    before = JSON.stringify(items);
  const index = createMarqueeIndex(
    items,
    items.filter((i) => i !== hidden),
  );
  assert.deepEqual(ids(index, -100, -100, 1000, 1000, true), [
    note.id,
    root.id,
  ]);
  assert.equal(JSON.stringify(items), before);
  note.locked = true;
  assert.equal(
    createMarqueeIndex(items).some((e) => e.id === frame.id),
    false,
  );
});

test("stroke selection follows actual straight, elbow, curved and drawn paths, including zero-area and reversed lines", () => {
  const diagonal = item("arrow", 0, 0, { w: 100, h: 100 }),
    elbow = item("arrow", 0, 0, { w: 100, h: 100, lineType: "elbow" }),
    curve = item("arrow", 0, 0, { w: 100, h: 100, lineType: "curved" }),
    horizontal = item("arrow", 100, 150, { w: -100, h: 0 }),
    vertical = item("arrow", 200, 100, { w: 0, h: -100 }),
    pen = item("pen", 300, 0, {
      w: 100,
      h: 100,
      points: [
        [0, 0],
        [100, 100],
      ],
    }),
    dot = item("pen", 500, 0, { w: 0, h: 0, points: [[0, 0]] });
  const index = createMarqueeIndex([
    diagonal,
    elbow,
    curve,
    horizontal,
    vertical,
    pen,
    dot,
  ]);
  assert.deepEqual(
    ids(index, 1, 80, 10, 10),
    [],
    "Empty space inside a diagonal bounding box is not a line hit",
  );
  assert.ok(ids(index, 49, 49, 2, 2).includes(diagonal.id));
  assert.ok(ids(index, 20, -1, 10, 2).includes(elbow.id));
  assert.ok(ids(index, 49, 49, 2, 2).includes(curve.id));
  assert.deepEqual(ids(index, -1, 149, 91, 2, true), [horizontal.id]);
  assert.deepEqual(ids(index, 199, -1, 2, 91, true), [vertical.id]);
  assert.ok(ids(index, 299, -1, 91, 91, true).includes(pen.id));
  assert.deepEqual(ids(index, 499, -1, 2, 2, true), [dot.id]);
});

test("connector labels participate in crossing selection and must be covered for precise selection", () => {
  const line = item("arrow", 0, 0, {
      w: 100,
      h: 0,
      text: "A long connection label",
    }),
    index = createMarqueeIndex([line]),
    label = index[0].label;
  assert.ok(label.h > 0);
  assert.deepEqual(ids(index, label.x, label.y + 1, label.w, 2), [line.id]);
  assert.deepEqual(ids(index, -10, -1, 120, 2, true), []);
  assert.deepEqual(ids(index, -500, -100, 1000, 200, true), [line.id]);
});

test("a 5,000-object marquee reuses geometry without reading object data during pointer movement", () => {
  let reads = 0;
  const items = Array.from({ length: 5000 }, (_, n) => ({
    id: String(n),
    type: "rect",
    get x() {
      reads++;
      return n * 120;
    },
    y: 0,
    w: 100,
    h: 100,
    get text() {
      throw Error("No content reads");
    },
  }));
  const index = createMarqueeIndex(items),
    initial = reads;
  for (let n = 0; n < 10; n++)
    assert.equal(ids(index, 0, 0, 600000, 100, true).length, 5000);
  assert.equal(reads, initial);
});

test("fully enclosed or distant complex strokes need no point traversal; partial stroke geometry is cached", () => {
  let reads = 0;
  const stroke = {
    id: "stroke",
    type: "pen",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    get points() {
      reads++;
      return Array.from({ length: 20000 }, (_, n) => [n / 199.99, n / 199.99]);
    },
  };
  const index = createMarqueeIndex([stroke]);
  assert.equal(reads, 0);
  assert.deepEqual(ids(index, -1, -1, 102, 102, true), ["stroke"]);
  assert.deepEqual(ids(index, 200, 200, 10, 10), []);
  assert.equal(reads, 0);
  assert.deepEqual(ids(index, 45, 45, 10, 10), ["stroke"]);
  const prepared = reads;
  assert.deepEqual(ids(index, 45, 45, 10, 10), ["stroke"]);
  assert.equal(reads, prepared);
});

test("a box drawn inside a frame selects the content there, not the frame", () => {
  const frame = item("frame", 0, 0, { w: 900, h: 600 }),
    a = item("note", 50, 200, { w: 180, h: 180, parentId: frame.id }),
    b = item("note", 260, 200, { w: 180, h: 180, parentId: frame.id }),
    index = createMarqueeIndex([frame, a, b]);
  assert.deepEqual(ids(index, 30, 150, 420, 270), [a.id, b.id]);
  assert.deepEqual(ids(index, 30, 420, 270, 140), []);
  // Crossing or touching the frame's edge still picks the frame.
  assert.deepEqual(ids(index, -10, 150, 100, 100), [frame.id, a.id]);
  assert.deepEqual(ids(index, 0, 420, 100, 100), [frame.id]);
  assert.deepEqual(ids(index, -10, -10, 920, 620).length, 3);
  // Precise selection is unchanged: the frame needs 90% coverage.
  assert.deepEqual(ids(index, 30, 150, 420, 270, true), [a.id, b.id]);
});
