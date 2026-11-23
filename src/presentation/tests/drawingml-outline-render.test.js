// How shape outlines draw what DrawingML describes, checked against the
// desktop presentation app's output for the same files.
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

// A one-slide deck whose shape tree holds `shapes` (DrawingML markup).
const deckWith = async (shapes) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const files = unzipSync(await P.savePresentation(pres));
  const name = P.getSlidePartName(slide).slice(1);
  files[name] = strToU8(
    strFromU8(files[name]).replace("<p:grpSpPr/>", `<p:grpSpPr/>${shapes}`),
  );
  return parseDeck(zipSync(files));
};
const render = async (shapes) => {
  const pres = await deckWith(shapes);
  return renderSlideToSvg(pres, P.getSlides(pres)[0], { textLayout: "svg" });
};
const shape = (spPr, prst = "rect") =>
  `<p:sp><p:nvSpPr><p:cNvPr id="9" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="2743200" cy="1371600"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${spPr}</p:spPr></p:sp>`;
const black = '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>';
// w = 76200 EMU = 8 px.
const dashOf = (svg) =>
  /stroke-dasharray="([^"]*)"/.exec(svg)?.[1].split(/[ ,]+/).map(Number);

describe("dashed outlines with round and square caps", () => {
  const line = (cap, dash) =>
    shape(
      `<a:ln w="76200"${cap ? ` cap="${cap}"` : ""}>${black}${dash}</a:ln>`,
    );

  it("keeps the gaps of a round dot line", async () => {
    // sysDot is one width on, one off; the caps are part of the dot.
    const svg = await render(line("rnd", '<a:prstDash val="sysDot"/>'));
    expect(dashOf(svg)).toEqual([0, 16]);
  });

  it("includes square caps in preset dashes", async () => {
    const svg = await render(line("sq", '<a:prstDash val="dash"/>'));
    expect(dashOf(svg)).toEqual([24, 32]);
  });

  it("leaves flat caps alone", async () => {
    const svg = await render(line("", '<a:prstDash val="sysDot"/>'));
    expect(dashOf(svg)).toEqual([8, 8]);
  });

  it("includes round caps in custom dashes but not square ones", async () => {
    const cust =
      '<a:custDash><a:ds d="300000" sp="100000"/><a:ds d="100000" sp="100000"/></a:custDash>';
    expect(dashOf(await render(line("rnd", cust)))).toEqual([16, 16, 0, 16]);
    expect(dashOf(await render(line("sq", cust)))).toEqual([24, 8, 8, 8]);
  });
});

describe("preset shadows", () => {
  const preset = (prst, color = '<a:srgbClr val="404040"/>') =>
    shape(
      `<a:solidFill><a:srgbClr val="FFC000"/></a:solidFill><a:effectLst><a:prstShdw prst="${prst}" dist="114300" dir="2700000">${color}</a:prstShdw></a:effectLst>`,
    );
  const effects = async (markup) => {
    const pres = await deckWith(markup);
    const slide = P.getSlides(pres)[0];
    return P.getShapeEffects(pres, P.getSlideShapes(slide).at(-1));
  };

  it("draws a drop shadow at its distance and direction", async () => {
    const svg = await render(preset("shdw2"));
    // 9 pt at 45°: 12 px along each axis' diagonal.
    const d = (114300 / 9525) * Math.SQRT1_2;
    expect(svg).toContain(
      `<feDropShadow dx="${d.toFixed(2)}" dy="${d.toFixed(2)}" stdDeviation="0.00" flood-color="#404040"`,
    );
  });

  it("lays perspective shadows back from or forward of the bottom edge", async () => {
    expect(await effects(preset("shdw3"))).toMatchObject([
      { kind: "outerShdw", scaleY: 0.5, skewXDeg: 60, align: "b" },
    ]);
    expect(await effects(preset("shdw8"))).toMatchObject([
      { kind: "outerShdw", scaleY: -0.5, skewXDeg: 60, align: "b" },
    ]);
    const svg = await render(preset("shdw3"));
    expect(svg).toContain('data-pptx-shadow="1"');
  });

  it("draws a double shadow with a lighter second copy beneath", async () => {
    const [first, second] = await effects(preset("shdw13"));
    expect(first).toMatchObject({ color: "#404040", distEmu: 114300 });
    expect(second).toMatchObject({ color: "#A5A5A5", distEmu: 228600 });
  });

  it("keeps a shadow hidden behind its shape off the page", async () => {
    expect(await effects(preset("shdw9"))).toEqual([]);
  });
});
