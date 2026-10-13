import test from "node:test";
import assert from "node:assert/strict";
import { freeSpot, clearSpot } from "../src/placement.js";

const view = { x: 0, y: 0, w: 1000, h: 800 };
const box = { x: 400, y: 300, w: 200, h: 200 };

test("an object added without a pointer keeps a free spot", () => {
  assert.deepEqual(freeSpot([], box, view), { x: 400, y: 300 });
  // Frames and connectors lie under content, so they never take a spot.
  assert.deepEqual(
    freeSpot(
      [
        { type: "frame", x: 0, y: 0, w: 1000, h: 800 },
        { type: "arrow", x: 500, y: 400, w: -300, h: -200 },
      ],
      box,
      view,
    ),
    { x: 400, y: 300 },
  );
});

test("objects added one after another go beside each other, in view", () => {
  const items = [];
  for (let n = 0; n < 6; n++) {
    const p = freeSpot(items, box, view);
    for (const i of items)
      assert.ok(
        p.x >= i.x + i.w ||
          p.x + box.w <= i.x ||
          p.y >= i.y + i.h ||
          p.y + box.h <= i.y,
        `${JSON.stringify(p)} overlaps ${JSON.stringify(i)}`,
      );
    assert.ok(
      p.x >= 0 && p.y >= 0 && p.x + box.w <= 1000 && p.y + box.h <= 800,
    );
    items.push({ type: "note", ...p, w: box.w, h: box.h });
  }
  // The second goes to the right of the first, as reading continues.
  assert.deepEqual({ x: items[1].x, y: items[1].y }, { x: 624, y: 300 });
});

test("a full view keeps the spot asked for", () => {
  const wall = [{ type: "rect", x: -50, y: -50, w: 1100, h: 900 }];
  assert.deepEqual(freeSpot(wall, box, view), { x: 400, y: 300 });
});

test("people adding at once start looking in different directions", () => {
  const taken = [{ type: "note", ...box }];
  const spots = [0, 0.25, 0.5, 0.75].map((turn) =>
    JSON.stringify(freeSpot(taken, box, view, { turn })),
  );
  assert.equal(new Set(spots).size, 4);
});

test("a large object goes beside a small one when steps of its own size leave the view", () => {
  // A 480 by 300 embed centred in a 1440 by 900 view, over a note.
  const wide = { x: 480, y: 300, w: 480, h: 300 },
    screen = { x: 0, y: 0, w: 1440, h: 900 },
    note = { type: "note", x: 625, y: 370, w: 190, h: 160 };
  const spot = freeSpot([note], wide, screen);
  assert.notDeepEqual(spot, { x: 480, y: 300 });
  const placed = { ...wide, ...spot };
  assert.ok(
    placed.x >= note.x + note.w ||
      placed.x + placed.w <= note.x ||
      placed.y >= note.y + note.h ||
      placed.y + placed.h <= note.y,
  );
  assert.ok(placed.x >= 0 && placed.x + placed.w <= 1440);
  assert.ok(placed.y >= 0 && placed.y + placed.h <= 900);
});

test("a block of frames goes right of what it would cover, frames included", () => {
  const block = { x: 0, y: 0, w: 500, h: 300 };
  assert.deepEqual(clearSpot([], block), { x: 0, y: 0 });
  // Connectors may cross it; frames and notes may not.
  assert.deepEqual(
    clearSpot([{ type: "arrow", x: 0, y: 0, w: 400, h: 200 }], block),
    { x: 0, y: 0 },
  );
  assert.deepEqual(
    clearSpot(
      [
        { type: "frame", x: 100, y: 100, w: 400, h: 400 },
        // Reached only once the block has moved past the frame.
        { type: "note", x: 600, y: 0, w: 200, h: 200 },
        // Below the block: never in the way.
        { type: "note", x: 0, y: 900, w: 200, h: 200 },
      ],
      block,
    ),
    { x: 880, y: 0 },
  );
});
