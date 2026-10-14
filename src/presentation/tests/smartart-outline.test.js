import { describe, expect, it } from "vitest";
import {
  addAbove,
  addAfter,
  addBefore,
  addBelow,
  canDemote,
  canMoveDown,
  canMoveUp,
  canPromote,
  demote,
  indentLine,
  itemsFromParagraphs,
  joinWithPrevious,
  moveDown,
  moveUp,
  normalize,
  promote,
  removeItem,
  splitItem,
} from "../src/smartart/outline.js";

const tree = () => [
  { text: "A", level: 0 },
  { text: "a1", level: 1 },
  { text: "a2", level: 1 },
  { text: "B", level: 0 },
  { text: "b1", level: 1 },
  { text: "C", level: 0 },
];
const show = (items) =>
  items.map((i) => `${"-".repeat(i.level)}${i.text}`).join(" ");

describe("SmartArt outline", () => {
  it("normalizes levels", () => {
    expect(
      show(
        normalize([
          { text: "x", level: 2 },
          { text: "y", level: 3 },
          { text: "z", level: 0 },
        ]),
      ),
    ).toBe("x -y z");
  });

  it("adds shapes after, before, above and below", () => {
    const after = addAfter(tree(), 0);
    expect(show(after.items)).toBe("A -a1 -a2  B -b1 C");
    expect(after.index).toBe(3);
    expect(show(addBefore(tree(), 3).items)).toBe("A -a1 -a2  B -b1 C");
    const above = addAbove(tree(), 3);
    expect(show(above.items)).toBe("A -a1 -a2  -B --b1 C");
    const below = addBelow(tree(), 3);
    expect(show(below.items)).toBe("A -a1 -a2 B -b1 - C");
    expect(below.index).toBe(5);
    expect(show(addAfter([], 0).items)).toBe("");
  });

  it("promotes and demotes with the subtree", () => {
    const items = tree();
    expect(canPromote(items, 0)).toBe(false);
    expect(canDemote(items, 0)).toBe(false);
    expect(canDemote(items, 3)).toBe(true);
    expect(show(demote(items, 3).items)).toBe("A -a1 -a2 -B --b1 C");
    expect(show(promote(items, 1).items)).toBe("A a1 -a2 B -b1 C");
    expect(canDemote(items, 2)).toBe(true);
    expect(canDemote(items, 1)).toBe(false);
  });

  it("moves an item with its subtree among its siblings", () => {
    const items = tree();
    expect(canMoveUp(items, 0)).toBe(false);
    expect(canMoveDown(items, 5)).toBe(false);
    expect(canMoveUp(items, 3)).toBe(true);
    const up = moveUp(items, 3);
    expect(show(up.items)).toBe("B -b1 A -a1 -a2 C");
    expect(up.index).toBe(0);
    const down = moveDown(items, 0);
    expect(show(down.items)).toBe("B -b1 A -a1 -a2 C");
    expect(down.index).toBe(2);
    expect(show(moveDown(items, 1).items)).toBe("A -a2 -a1 B -b1 C");
    expect(canMoveDown(items, 2)).toBe(false);
  });

  it("removes an item and lifts its children", () => {
    expect(show(removeItem(tree(), 0).items)).toBe("a1 a2 B -b1 C");
  });

  it("edits like a text outline", () => {
    const split = splitItem(tree(), 3, 0);
    expect(show(split.items)).toBe("A -a1 -a2  B -b1 C");
    const joined = joinWithPrevious(split.items, 4);
    expect(show(joined.items)).toBe("A -a1 -a2 B -b1 C");
    expect(joined.caret).toBe(0);
    expect(show(indentLine(tree(), 3, 1).items)).toBe("A -a1 -a2 -B -b1 C");
    expect(show(indentLine(tree(), 1, -1).items)).toBe("A a1 -a2 B -b1 C");
    expect(indentLine(tree(), 0, -1).items).toEqual(tree());
  });

  it("reads bulleted paragraphs as items", () => {
    expect(
      show(
        itemsFromParagraphs([
          { text: "One", level: 0 },
          { text: "", level: 0 },
          { text: "detail ", level: 1 },
          { text: "Two", level: 0 },
        ]),
      ),
    ).toBe("One -detail Two");
  });
});
