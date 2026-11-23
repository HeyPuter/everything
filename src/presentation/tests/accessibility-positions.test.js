import { describe, it, expect } from "vitest";
import { P, createDeck, slideBounds, slidePosition } from "../src/model.js";
import { findAccessibilityIssues } from "../src/review/accessibility.js";

// Tables whose rows grow past their frames, at the top level and inside a
// plain, a mirrored and a turned group, so the laid-out size differs from
// the frame wherever the check looks.
function deck() {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const tall = Array.from({ length: 6 }, (_, r) => [
    `Row ${r} with words that wrap across the narrow column`,
    `${r}`,
  ]);
  const table = (x, y) =>
    P.addSlideTable(slide, {
      x: P.inches(x),
      y: P.inches(y),
      w: P.inches(2),
      h: P.inches(0.4),
      rows: tall,
    });
  const box = (x, y, text) =>
    P.addSlideTextBox(slide, {
      x: P.inches(x),
      y: P.inches(y),
      w: P.inches(1),
      h: P.inches(0.5),
      text,
    });
  const top = table(6, 0.3);
  box(0.5, 0.2, "Heading");
  const groups = [];
  for (const [i, setup] of [
    [0, () => {}],
    [1, (g) => P.setShapeFlip(g, { horizontal: true, vertical: true })],
    [2, (g) => P.setShapeRotation(g, 33)],
  ]) {
    const inner = table(0.5 + i * 3, 3);
    const label = box(1 + i * 3, 2.5, `Label ${i}`);
    const group = P.groupShapes([inner, label]);
    setup(group);
    groups.push({ group, inner });
  }
  return { pres, slide, top, groups };
}
const env = (pres, withPosition) => ({
  isTable: (s) => P.isTableShape(s),
  slideBounds: (s) => slideBounds(pres, s),
  ...(withPosition ? { slidePosition: (s) => slidePosition(pres, s) } : {}),
  size: () => ({ cx: 12192000, cy: 6858000 }),
  textColors: () => null,
});

describe("accessibility check positions", () => {
  it("starts every box where its full bounds start", () => {
    const { pres, slide, top, groups } = deck();
    const full = slideBounds(pres, top);
    // The laid-out rows are taller than the frame the file gives.
    expect(full.h).toBeGreaterThan(P.getShapeBoundsResolved(pres, top).h);
    for (const shape of [top, ...groups.flatMap((g) => [g.group, g.inner])]) {
      const a = slideBounds(pres, shape);
      const b = slidePosition(pres, shape);
      expect([b.x, b.y]).toEqual([a.x, a.y]);
    }
    expect(P.getSlideShapes(slide).length).toBeGreaterThan(6);
  });
  it("finds the same issues as with full bounds, without asking for them", () => {
    const { pres } = deck();
    const before = findAccessibilityIssues(pres, env(pres, false));
    let asked = 0;
    const counted = env(pres, true);
    const bounds = counted.slideBounds;
    counted.slideBounds = (s) => (asked++, bounds(s));
    const after = findAccessibilityIssues(pres, counted);
    expect(after).toEqual(before);
    expect(after.map((i) => i.kind)).toContain("readingOrder");
    expect(asked).toBe(0);
  });
});
