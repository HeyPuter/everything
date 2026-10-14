import { describe, expect, it } from "vitest";
import { P, createDeck, preview, shape, text } from "../src/model.js";
import {
  buildSequence,
  parsePath,
  pathEnd,
  samplePath,
  slideTimeline,
} from "../src/animations/player.js";
import {
  movePathEnd,
  optionGroups,
  reversePath,
} from "../src/animations/options.js";
import {
  EFFECTS,
  effectName,
  entryFor,
  newEffect,
} from "../src/animations/catalog.js";

const svgOf = (src) =>
  decodeURIComponent(src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
const item = (start, durationMs, delay = 0) => ({
  start,
  delay,
  effect: { durationMs },
});

describe("animation timeline", () => {
  it("groups effects by click and chains after-previous effects", () => {
    const groups = buildSequence([
      item("with", 500),
      item("click", 1000),
      item("with", 400, 200),
      item("after", 300, 100),
      item("click", 500),
    ]);
    expect(groups.map((g) => g.auto)).toEqual([true, false, false]);
    expect(groups[1].items.map((i) => i.at)).toEqual([0, 200, 1100]);
  });
  it("counts a paragraph build's steps on the slide", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const body = text(slide, "One\nTwo\nThree", 1, 1, 4, 3);
    P.setSlideAnimations(slide, [
      newEffect(
        entryFor({ presetClass: "entr", presetId: 10 }),
        P.getShapeId(body),
        {
          text: { by: "paragraph", level: 1 },
        },
      ),
    ]);
    const { groups } = slideTimeline(slide);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.items[0].part)).toEqual([[0], [1], [2]]);
  });
});

describe("motion paths", () => {
  it("reads lines and curves and samples them evenly", () => {
    const d = "M 0 0 L 0.25 0 L 0.25 0.25 E";
    expect(parsePath(d)).toHaveLength(2);
    expect(pathEnd(d)).toEqual([0.25, 0.25]);
    const points = samplePath(d, 4);
    expect(points).toHaveLength(5);
    expect(points[2][0]).toBeCloseTo(0.25, 5);
    expect(points[2][1]).toBeCloseTo(0, 5);
    expect(pathEnd("M 0 0 C 0 0.2 0.25 0.2 0.25 0 E")).toEqual([0.25, 0]);
  });
  it("reverses a path so it is travelled from its end", () => {
    expect(reversePath("M 0 0 L 0.25 0 L 0.25 0.5 E")).toBe(
      "M 0.25 0.5 L 0.25 0 L 0 0 E",
    );
    expect(reversePath("M 0 0 C 0 1 1 1 1 0 E")).toBe("M 1 0 C 1 1 0 1 0 0 E");
  });
  it("moves a path's end with its last control point", () => {
    expect(movePathEnd("M 0 0 L 0.25 0 E", 0.05, 0.1)).toBe(
      "M 0 0 L 0.3 0.1 E",
    );
    expect(movePathEnd("M 0 0 C 0 0.2 0.25 0.2 0.25 0 E", 0.1, 0)).toBe(
      "M 0 0 C 0 0.2 0.35 0.2 0.35 0 E",
    );
  });
});

describe("effect catalog and options", () => {
  it("names every gallery effect and maps variants back to it", () => {
    for (const entry of EFFECTS.filter((e) => e.gallery))
      expect(effectName(newEffect(entry, "2"))).toBe(entry.name);
    expect(entryFor({ presetClass: "entr", presetId: 47 }).name).toBe(
      "Float In",
    );
    expect(entryFor({ presetClass: "entr", presetId: 8 }).name).toBe("Shape");
  });
  it("offers directions, amounts and text sequences", () => {
    const fly = EFFECTS.find((e) => e.cls === "entr" && e.id === 2);
    const effect = newEffect(fly, "2");
    const groups = optionGroups(fly, effect, { hasText: true, paragraphs: 3 });
    expect(groups.map((g) => g.label)).toEqual(["Direction", "Sequence"]);
    const left = groups[0].options.find((o) => o.label === "From Left");
    expect(left.apply(effect)).toEqual({ presetSubtype: 8 });
    const byParagraph = groups[1].options.find(
      (o) => o.label === "By Paragraph",
    );
    expect(byParagraph.apply(effect).text).toEqual({
      level: 1,
      by: "paragraph",
    });
    const spin = EFFECTS.find((e) => e.cls === "emph" && e.id === 8);
    const spinGroups = optionGroups(spin, newEffect(spin, "2"), {});
    const ccw = spinGroups[0].options.find(
      (o) => o.label === "Counterclockwise",
    );
    expect(ccw.apply({ amount: 360 })).toEqual({ amount: -360 });
  });
});

describe("slide layers", () => {
  it("draws only the shapes and paragraphs a layer asks for", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const box = shape(slide, 1, 1, 2, 1, "#123456");
    const body = text(slide, "Keep\nDrop", 4, 1, 4, 2);
    const full = svgOf(preview(pres, slide));
    expect(full).toContain("Keep");
    expect(full).toContain("Drop");
    const only = svgOf(
      preview(pres, slide, {
        background: false,
        shape: (s) =>
          P.getShapeId(s) === P.getShapeId(body)
            ? { body: false, paragraphs: new Set([0]) }
            : false,
      }),
    );
    expect(only).toContain("Keep");
    expect(only).not.toContain("Drop");
    expect(only.toLowerCase()).not.toContain("#123456");
    const boxOnly = svgOf(
      preview(pres, slide, {
        background: true,
        shape: (s) => P.getShapeId(s) === P.getShapeId(box),
      }),
    );
    expect(boxOnly.toLowerCase()).toContain("#123456");
    expect(boxOnly).not.toContain("Keep");
  });
});
