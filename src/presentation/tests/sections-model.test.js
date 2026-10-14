import { describe, it, expect } from "vitest";
import {
  groupSlides,
  moveSlidesTo,
  addSectionAt,
  renameSectionAt,
  moveSectionBy,
  removeSectionAt,
} from "../src/views/sections-model.js";

const order = ["a", "b", "c", "d", "e"];
const sections = [
  { name: "Intro", slides: ["a", "b"] },
  { name: "Body", slides: ["c", "d", "e"] },
];

describe("sections model", () => {
  it("groups slides, adopting slides no section lists", () => {
    expect(groupSlides(order, [])).toEqual([{ name: null, slides: order }]);
    expect(
      groupSlides(order, [
        { name: "One", slides: ["a"] },
        { name: "Two", slides: ["c"] },
      ]),
    ).toEqual([
      { name: "One", slides: ["a", "b"] },
      { name: "Two", slides: ["c", "d", "e"] },
    ]);
  });

  it("moves slides within and across sections", () => {
    expect(
      moveSlidesTo(order, [], new Set(["d"]), { section: 0, before: "b" }),
    ).toEqual({ order: ["a", "d", "b", "c", "e"], sections: [] });
    const across = moveSlidesTo(order, sections, new Set(["a", "e"]), {
      section: 1,
      before: "d",
    });
    expect(across.order).toEqual(["b", "c", "a", "e", "d"]);
    expect(across.sections).toEqual([
      { name: "Intro", slides: ["b"] },
      { name: "Body", slides: ["c", "a", "e", "d"] },
    ]);
    // To the end of a section, which may leave the other one empty.
    const emptied = moveSlidesTo(order, sections, new Set(["a", "b"]), {
      section: 1,
    });
    expect(emptied.sections[0]).toEqual({ name: "Intro", slides: [] });
    expect(moveSlidesTo(order, sections, new Set(["b"]), { section: 0 })).toBe(
      null,
    );
  });

  it("adds, renames, moves and removes sections", () => {
    expect(addSectionAt(order, [], "c", "New").sections).toEqual([
      { name: "Default Section", slides: ["a", "b"] },
      { name: "New", slides: ["c", "d", "e"] },
    ]);
    expect(addSectionAt(order, [], "a", "All").sections).toEqual([
      { name: "All", slides: order },
    ]);
    expect(addSectionAt(order, sections, "d", "Split").sections).toEqual([
      { name: "Intro", slides: ["a", "b"] },
      { name: "Body", slides: ["c"] },
      { name: "Split", slides: ["d", "e"] },
    ]);
    expect(renameSectionAt(order, sections, 1, "Main").sections[1].name).toBe(
      "Main",
    );
    const moved = moveSectionBy(order, sections, 1, -1);
    expect(moved.order).toEqual(["c", "d", "e", "a", "b"]);
    expect(moveSectionBy(order, sections, 1, 1)).toBe(null);
    const kept = removeSectionAt(order, sections, 1);
    expect(kept.sections).toEqual([{ name: "Intro", slides: order }]);
    expect(kept.removed).toEqual([]);
    const first = removeSectionAt(order, sections, 0);
    expect(first.sections).toEqual([{ name: "Body", slides: order }]);
    const gone = removeSectionAt(order, sections, 0, { withSlides: true });
    expect(gone.removed).toEqual(["a", "b"]);
    expect(gone.order).toEqual(["c", "d", "e"]);
  });
});
