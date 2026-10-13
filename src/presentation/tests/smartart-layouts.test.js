import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { parseXml } from "../lib/pptx/src/internal/xml/index.ts";

const render = (pres, slide) =>
  renderSlideToSvg(pres, slide, {
    textLayout: "svg",
    stableDefinitionIds: true,
  });
const deckWith = (model, size = { w: 8, h: 4.5 }) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const frame = P.addSlideSmartArt(slide, {
    model,
    x: P.inches(1),
    y: P.inches(1.5),
    w: P.inches(size.w),
    h: P.inches(size.h),
  });
  return { pres, slide, frame };
};

describe("SmartArt layout catalog", () => {
  it("covers every category with original layouts", () => {
    const ids = P.SMARTART_LAYOUTS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(30);
    for (const category of P.SMARTART_CATEGORIES)
      expect(
        P.SMARTART_LAYOUTS.filter((l) => l.category === category.id).length,
      ).toBeGreaterThanOrEqual(3);
    for (const layout of P.SMARTART_LAYOUTS) {
      expect(layout.name).toBeTruthy();
      expect(layout.description.length).toBeGreaterThan(20);
      expect(layout.sample.length).toBeGreaterThan(0);
    }
    expect(P.SMARTART_COLOR_SCHEMES.length).toBeGreaterThan(20);
    expect(P.SMARTART_STYLES.map((s) => s.id)).toContain("subtle");
  });

  for (const layout of P.SMARTART_LAYOUTS)
    it(`builds, validates and renders ${layout.id}`, async () => {
      const items = layout.sample.map((item, i) => ({
        ...item,
        text: `Item ${i}`,
      }));
      const { pres, slide, frame } = deckWith({
        layout: layout.id,
        items,
        colors: "colorful",
        style: "intense",
      });
      expect(P.isDiagramShape(frame)).toBe(true);
      const svg = render(pres, slide);
      expect(svg).not.toContain("data-pptx-diagram-issues");
      // Wrapped labels continue on the next line.
      const words = svg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      for (const item of items) expect(words).toContain(item.text);
      expect(() => P.validatePresentation(pres)).not.toThrow();
      const back = await P.loadPresentation(await P.savePresentation(pres));
      const again = P.getSlideShapes(P.getSlides(back)[0]).find(
        P.isDiagramShape,
      );
      expect(P.getShapeSmartArt(again)).toEqual({
        layout: layout.id,
        items,
        colors: "colorful",
        style: "intense",
      });
    });

  it("draws each layout as a valid standalone preview", () => {
    for (const layout of P.SMARTART_LAYOUTS) {
      const svg = P.smartArtPreviewSvg(layout.id, { width: 120, height: 80 });
      expect(parseXml(svg).root.name.localName).toBe("svg");
      expect(svg).toContain("<path");
      expect(svg).not.toMatch(/NaN|Infinity/);
    }
    const labelled = P.smartArtPreviewSvg("arrow-steps", {
      width: 400,
      height: 200,
      items: [
        { text: "Plan", level: 0 },
        { text: "Build", level: 0 },
      ],
      palette: {
        accents: [
          "#112233",
          "#445566",
          "#778899",
          "#AABBCC",
          "#DDEEFF",
          "#123456",
        ],
        dk1: "#000000",
        lt1: "#FFFFFF",
      },
    });
    expect(labelled).toContain(">Plan<");
    expect(labelled).toContain("#112233");
  });

  for (const layout of P.SMARTART_LAYOUTS)
    it(`handles empty, deep and long outlines in ${layout.id}`, () => {
      for (const items of [
        [],
        Array.from({ length: 12 }, (_, i) => ({ text: `n${i}`, level: i % 4 })),
        [{ text: "a much longer piece of text that needs wrapping", level: 0 }],
      ]) {
        const { pres, slide } = deckWith(
          { layout: layout.id, items, colors: "accent2", style: "flat" },
          { w: 6, h: 3 },
        );
        const svg = render(pres, slide);
        expect(svg).not.toMatch(/NaN|Infinity/);
        expect(svg).not.toContain("data-pptx-diagram-issues");
      }
    });
});
