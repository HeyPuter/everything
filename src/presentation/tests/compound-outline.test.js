import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

function outlined(compound, preset = "rect") {
  const pres = createDeck("blank"),
    slide = P.getSlides(pres)[0];
  const shape = P.addSlideShape(slide, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(2),
    h: P.inches(preset === "line" ? 0 : 1),
    preset,
  });
  P.setShapeFill(shape, "#FFE0A0");
  // A 6pt (8px) outline.
  P.setShapeStroke(shape, { color: "#203060", widthEmu: 76200 });
  if (compound) P.setShapeStrokeCompound(shape, compound);
  return renderSlideToSvg(pres, slide, { textLayout: "svg" });
}
// The stripe widths cut from the outline, and the colors they cut.
const stripes = (svg) =>
  [
    ...(svg.match(/<mask [^>]*>(.*?)<\/mask>/)?.[1] ?? "").matchAll(
      /stroke="(#[0-9A-F]{6})" stroke-width="([^"]+)"/g,
    ),
  ].map((m) => [m[1], Number(m[2])]);

describe("compound outlines", () => {
  it("draws a double outline as two lines with a clear stripe between", () => {
    const svg = outlined("dbl");
    expect(stripes(svg)).toEqual([["#000000", 2.67]]);
    // The full-width line is what the stripe is cut from; the fill is whole.
    expect(svg).toMatch(
      /<g mask="url\(#[^)]+\)"><rect [^>]*fill="none" stroke="#203060" stroke-width="8.00"/,
    );
    expect(svg).toMatch(/<rect [^>]*fill="#FFE0A0" stroke="none"/);
  });
  it("draws a triple outline as a thick line between two thin ones", () => {
    expect(stripes(outlined("tri"))).toEqual([
      ["#000000", 5.33],
      ["#FFFFFF", 2.67],
    ]);
  });
  it("keeps a single outline as one line", () => {
    const svg = outlined("sng");
    expect(svg).not.toContain("<mask");
    expect(svg).toMatch(/fill="#FFE0A0" stroke="#203060" stroke-width="8.00"/);
  });
  it("cuts a straight line's stripe, which has no area of its own", () => {
    const svg = outlined("dbl", "line");
    const region = svg.match(
      /<mask [^>]*maskUnits="userSpaceOnUse" x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)"/,
    );
    expect(Number(region[2])).toBeGreaterThan(8);
    expect(stripes(svg)).toEqual([["#000000", 2.67]]);
  });
});
