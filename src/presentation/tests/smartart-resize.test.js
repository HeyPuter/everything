import { describe, expect, it } from "vitest";
import { P, createDeck, setSlideBounds } from "../src/model.js";

const drawingBytes = (pres) => {
  const pkg = P._internalPackageOf(pres);
  return pkg.parts
    .filter((p) => p.name.startsWith("/ppt/diagrams/drawing"))
    .map((p) => new TextDecoder().decode(p.data))
    .join("");
};

describe("SmartArt frames", () => {
  it("lay their drawing out again when resized, not when moved", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const shape = P.addSlideSmartArt(slide, {
      model: {
        layout: "arrow-steps",
        items: [
          { text: "One", level: 0 },
          { text: "Two", level: 0 },
        ],
        colors: P.DEFAULT_SMARTART_COLORS,
        style: P.DEFAULT_SMARTART_STYLE,
      },
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(6),
      h: P.inches(3),
    });
    const first = drawingBytes(pres);
    const b = P.getShapeBounds(shape);
    setSlideBounds(pres, shape, { ...b, x: b.x + P.inches(1) });
    expect(drawingBytes(pres)).toBe(first);
    setSlideBounds(pres, shape, { ...b, w: P.inches(9) });
    const resized = drawingBytes(pres);
    expect(resized).not.toBe(first);
    expect(P.getShapeSmartArt(shape).items.map((i) => i.text)).toEqual([
      "One",
      "Two",
    ]);
  });
});
