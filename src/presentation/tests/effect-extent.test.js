import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

const shadow =
  '<a:effectLst><a:outerShdw blurRad="76200" dist="152400" dir="2700000" algn="tl" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="60000"/></a:srgbClr></a:outerShdw></a:effectLst>';
const glow =
  '<a:effectLst><a:glow rad="139700"><a:srgbClr val="FF0000"/></a:glow></a:effectLst>';

const shape = (id, prst, cx, cy, spPr) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="S${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${spPr}</p:spPr></p:sp>`;

async function render(xml) {
  const pres = createDeck("blank"),
    slide = P.getSlides(pres)[0];
  const files = unzipSync(await P.savePresentation(pres));
  const name = P.getSlidePartName(slide).slice(1);
  files[name] = strToU8(
    strFromU8(files[name]).replace("</p:spTree>", `${xml}</p:spTree>`),
  );
  const loaded = await parseDeck(zipSync(files));
  return renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
    textLayout: "svg",
  });
}

// The rectangle that sizes the filtered group's bounding box, as numbers.
const extent = (svg) => {
  const match = svg.match(
    /<g filter="url\(#[^)]+\)"><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="none" stroke="none"\/>/,
  );
  return match && match.slice(1).map(Number);
};

describe("shape effects", () => {
  it("draw a straight line with a shadow, and its shadow", async () => {
    // A line has no height, so a filter sized on its geometry alone left
    // nothing to draw: neither the line nor its shadow appeared.
    const svg = await render(
      shape(
        10,
        "line",
        5486400,
        0,
        `<a:ln w="38100"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln>${shadow}`,
      ),
    );
    const [x, y, w, h] = extent(svg);
    // dist 12pt at 45 degrees (11.3px each way) + three deviations of a
    // 6pt blur (12px), plus twice the 4px outline.
    expect(h).toBeGreaterThan(2 * (11.3 + 12));
    expect(y + h / 2).toBeCloseTo(96, 1);
    expect(x).toBeLessThan(96 - 23);
    expect(w).toBeGreaterThan(576 + 2 * 23);
  });
  it("leave room for a glow around a small shape", async () => {
    const svg = await render(
      shape(
        11,
        "rect",
        300000,
        300000,
        `<a:solidFill><a:srgbClr val="2266CC"/></a:solidFill>${glow}`,
      ),
    );
    const [x, , w] = extent(svg);
    // An 11pt glow reaches 1.4 times its radius (14.7px * 1.4).
    expect(96 - x).toBeCloseTo(14.67 * 1.4, 1);
    expect(w).toBeCloseTo(31.5 + 2 * 14.67 * 1.4, 1);
  });
  it("adds nothing to a shape without effects", async () => {
    const svg = await render(
      shape(
        12,
        "rect",
        300000,
        300000,
        '<a:solidFill><a:srgbClr val="2266CC"/></a:solidFill>',
      ),
    );
    expect(svg).not.toContain('fill="none" stroke="none"/>');
    expect(extent(svg)).toBeNull();
  });
});
