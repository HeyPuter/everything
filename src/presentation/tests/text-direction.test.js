import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { fixture } from "./text-direction-fixture.js";

const effective = (f) => P.getShapeBodyPrEffective(f.pres, f.shape).vert;
const render = (f, textLayout = "svg") =>
  renderSlideToSvg(f.pres, f.slide, {
    textLayout,
    stableDefinitionIds: true,
    resolveFontFamily: () => "Arial",
    measureText: (text, spec) => ({
      widthPx: [...text].length * spec.sizePx * 0.5,
      ascentPx: spec.sizePx * 0.8,
      descentPx: spec.sizePx * 0.2,
      lineGapPx: 0,
    }),
  });

describe("explicit horizontal text overrides", () => {
  it.each([
    "vert",
    "vert270",
    "wordArtVert",
    "eaVert",
    "mongolianVert",
    "wordArtVertRtl",
  ])(
    "blocks an inherited %s direction without changing the local reader",
    async (direction) => {
      const f = await fixture({
        slideDirection: "horz",
        layoutDirection: direction,
      });
      expect(P.getShapeTextDirection(f.shape)).toBeNull();
      expect(effective(f)).toBeNull();
      const inherited = await fixture({ layoutDirection: direction });
      expect(effective(inherited)).toBe(direction);
    },
  );
  it.each([
    [null, "horz", "vert270", null],
    [null, null, "horz", null],
    ["horz", "vert", "vert270", null],
    ["vert", "horz", "vert270", "vert"],
    [null, "vert270", "horz", "vert270"],
    ["invalid", "horz", "vert", null],
    ["invalid", "invalid", "vert270", "vert270"],
    [null, null, null, null],
  ])(
    "resolves %s / %s / %s by nearest valid property",
    async (slideDirection, layoutDirection, masterDirection, expected) => {
      expect(
        effective(
          await fixture({ slideDirection, layoutDirection, masterDirection }),
        ),
      ).toBe(expected);
    },
  );
  it("queries and renders without changing authored slide, layout or master XML", async () => {
    const f = await fixture({ slideDirection: "horz" });
    const before = unzipSync(await P.savePresentation(f.pres));
    effective(f);
    render(f);
    render(f, "foreignObject");
    expect(unzipSync(await P.savePresentation(f.pres))).toEqual(before);
  });
  it.each(["svg", "foreignObject"])(
    "paints explicit horizontal text with the same %s layout as a horizontal hierarchy",
    async (textLayout) => {
      const override = await fixture({ slideDirection: "horz" }),
        horizontal = await fixture({
          slideDirection: "horz",
          layoutDirection: "horz",
          masterDirection: "horz",
        }),
        vertical = await fixture();
      expect(render(override, textLayout)).toBe(render(horizontal, textLayout));
      expect(render(override, textLayout)).not.toBe(
        render(vertical, textLayout),
      );
    },
  );
  it("writes horizontal explicitly and uses null to restore inheritance", async () => {
    const f = await fixture();
    P.setShapeTextDirection(f.shape, "horz");
    expect(P.getShapeXmlString(f.shape)).toContain('vert="horz"');
    expect(effective(f)).toBeNull();
    const saved = await parseDeck(await P.savePresentation(f.pres));
    const loaded = {
      pres: saved,
      shape: P.getSlideShapes(P.getSlides(saved)[0])[0],
    };
    expect(effective(loaded)).toBeNull();
    P.setShapeTextDirection(f.shape, null);
    expect(P.getShapeXmlString(f.shape)).not.toContain('vert="');
    expect(effective(f)).toBe("vert270");
  });
  it("preserves horizontal through a clipboard import in each direction, copies and editing", async () => {
    const original = await fixture({ slideDirection: "horz" }),
      clip = createDeck("blank");
    const held = P.importSlide(
      clip,
      original.slide,
      P.getSlideLayouts(clip)[0],
    );
    const pasted = P.importSlide(
      original.pres,
      held,
      P.getSlideLayout(original.slide),
    );
    const pastedShape = P.getSlideShapes(pasted)[0];
    const copied = P.copyShape(pasted, pastedShape);
    P.setShapeText(copied, "Edited horizontal text");
    const saved = await parseDeck(await P.savePresentation(original.pres));
    const last = P.getSlides(saved).at(-1);
    for (const shape of P.getSlideShapes(last)) {
      expect(P.getShapeXmlString(shape)).toContain('vert="horz"');
      expect(P.getShapeBodyPrEffective(saved, shape).vert).toBeNull();
    }
    expect(P.getShapeText(P.getSlideShapes(last).at(-1))).toBe(
      "Edited horizontal text",
    );
  });
});

describe("stacked text", () => {
  it("stacks each character a reader sees as one, not each code point", async () => {
    const pres = createDeck("blank"),
      slide = P.getSlides(pres)[0];
    const shape = P.addSlideTextBox(slide, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(1),
      h: P.inches(5),
      // A thumbs-up with its skin tone, a decomposed é, a family emoji.
      text: "A\u{1F44D}\u{1F3FD}é\u{1F468}‍\u{1F469}‍\u{1F467}",
    });
    P.setShapeTextDirection(shape, "wordArtVert");
    const loaded = await parseDeck(await P.savePresentation(pres));
    const svg = render({ pres: loaded, slide: P.getSlides(loaded)[0] });
    const rows = [...svg.matchAll(/<text\b[^>]*>(?:<tspan\b[^>]*>)?([^<]*)/g)]
      .map((m) => m[1])
      .filter(Boolean);
    expect(rows).toEqual([
      "A",
      "\u{1F44D}\u{1F3FD}",
      "é",
      "\u{1F468}‍\u{1F469}‍\u{1F467}",
    ]);
  });
});

describe("East Asian vertical text", () => {
  async function turned(direction) {
    const pres = createDeck("blank"),
      slide = P.getSlides(pres)[0];
    const shape = P.addSlideTextBox(slide, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(2),
      h: P.inches(4),
      text: "縦書きABC「語」",
    });
    P.setShapeTextDirection(shape, direction);
    const loaded = await parseDeck(await P.savePresentation(pres));
    return render({ pres: loaded, slide: P.getSlides(loaded)[0] });
  }
  const standing = (svg) =>
    [...svg.matchAll(/<tspan\b([^>]*)>([^<]*)<\/tspan>/g)]
      .filter((m) => m[1].includes('rotate="-90"'))
      .map((m) => m[2]);
  it("stands ideographs and kana upright and lays Latin text and brackets along the column", async () => {
    const svg = await turned("eaVert");
    expect(svg).toContain('transform="rotate(90 ');
    expect(standing(svg)).toEqual(["縦書き", "語"]);
    // The upright glyphs turn back within their em squares: moved by the
    // ascent (0.88 em) across and the descent down, and back after them.
    expect(svg).toMatch(/dx="[\d.]+" dy="[\d.]+" rotate="-90"[^>]*>縦書き/);
    expect(svg).toMatch(/dx="-[\d.]+" dy="-[\d.]+"[^>]*>ABC「/);
  });
  it("turns every character with the column in rotated text", async () => {
    expect(standing(await turned("vert"))).toEqual([]);
  });
});
