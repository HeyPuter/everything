// A group's frame follows what it holds: after an edit moves one of its
// objects, its offset and extent are the box around its objects again,
// and nothing else on the slide moves, in a turned or mirrored group too.
import { describe, it, expect } from "vitest";
import {
  P,
  fitGroups,
  groupFrames,
  groupParents,
  slideBounds,
  slideRotation,
} from "../src/model.js";

const I = 914400;

function deck({ rotation = 0, flip = null, nested = false } = {}) {
  const pres = P.createPresentation();
  const slide = P.addBlankSlide(pres);
  const box = (name, x, y) =>
    P.addSlideShape(slide, {
      preset: "rect",
      name,
      x: x * I,
      y: y * I,
      w: 2 * I,
      h: 1 * I,
    });
  const a = box("A", 1, 1);
  const b = box("B", 5, 3);
  let group = P.groupShapes([a, b], { name: "G" });
  if (nested) {
    const c = box("C", 9, 5);
    group = P.groupShapes([group, c], { name: "Outer" });
  }
  if (rotation) P.setShapeRotation(group, rotation);
  if (flip) P.setShapeFlip(group, flip);
  return { pres, slide };
}
const named = (slide, name) => {
  const all = [];
  const visit = (s) => {
    all.push(s);
    if (P.getShapeKind(s) === "group") P.getGroupChildren(s).forEach(visit);
  };
  P.getSlideShapes(slide).forEach(visit);
  return all.find((s) => P.getShapeName(s) === name);
};
// Where an object shows on the slide, to the EMU.
const shown = (pres, slide, name) => {
  const shape = named(slide, name);
  const parents = groupParents(slide);
  const b = slideBounds(pres, shape, parents);
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    w: Math.round(b.w),
    h: Math.round(b.h),
    r: slideRotation(shape, parents),
  };
};
// One edit as the editor makes it: what the groups hold, read before.
function edit(pres, slide, fn) {
  const frames = groupFrames(slide);
  fn();
  fitGroups(pres, slide, frames);
}
const near = (a, b) =>
  ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - b[k]) <= 2) && a.r === b.r;

describe("fitGroups", () => {
  for (const [label, options] of [
    ["an upright group", {}],
    ["a turned group", { rotation: 90 }],
    [
      "a turned and mirrored group",
      { rotation: 30, flip: { horizontal: true } },
    ],
    ["a group in a group", { nested: true, rotation: 45 }],
  ])
    it(`fits ${label} to an object moved out of it, and moves nothing else`, () => {
      const { pres, slide } = deck(options);
      const before = ["A", "B", "C"]
        .filter((n) => named(slide, n))
        .map((n) => [n, shown(pres, slide, n)]);
      edit(pres, slide, () => {
        const a = named(slide, "A");
        const own = P.getShapeBounds(a);
        P.setShapeBounds(a, { ...own, x: own.x - 3 * I, y: own.y + 4 * I });
      });
      for (const [name, was] of before)
        if (name !== "A")
          expect(near(shown(pres, slide, name), was)).toBe(true);
      // The inner group's children space is the box around its objects.
      const g = named(slide, "G");
      const boxes = P.getGroupChildren(g).map((c) => P.getShapeBounds(c));
      const left = Math.min(...boxes.map((b) => b.x)),
        top = Math.min(...boxes.map((b) => b.y));
      expect(P.getGroupTransform(g).inner).toEqual({
        x: left,
        y: top,
        w: Math.max(...boxes.map((b) => b.x + b.w)) - left,
        h: Math.max(...boxes.map((b) => b.y + b.h)) - top,
      });
    });

  it("leaves a group alone when an edit does not touch what it holds", () => {
    const { pres, slide } = deck({ rotation: 20 });
    const g = named(slide, "G");
    const before = JSON.stringify(P.getGroupTransform(g));
    edit(pres, slide, () => P.renameShape(named(slide, "A"), "Renamed"));
    expect(JSON.stringify(P.getGroupTransform(named(slide, "G")))).toBe(before);
  });
});
