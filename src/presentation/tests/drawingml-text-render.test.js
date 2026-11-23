// How text draws what DrawingML describes, checked against the desktop
// presentation app's output for the same files.
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

// A one-slide deck whose shape tree holds `shapes` (DrawingML markup).
const render = async (shapes) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const files = unzipSync(await P.savePresentation(pres));
  const name = P.getSlidePartName(slide).slice(1);
  files[name] = strToU8(
    strFromU8(files[name]).replace("<p:grpSpPr/>", `<p:grpSpPr/>${shapes}`),
  );
  const loaded = await parseDeck(zipSync(files));
  return renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
    textLayout: "svg",
  });
};
const textBox = (paragraphs) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="9" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="4572000" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;

describe("underline colour", () => {
  it.each(["wavy", "wavyHeavy", "wavyDbl"])(
    "draws a %s underline in its own colour",
    async (u) => {
      const svg = await render(
        textBox(
          `<a:p><a:r><a:rPr lang="en-US" sz="2400" u="${u}"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:uFill><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:uFill></a:rPr><a:t>Wavy</a:t></a:r></a:p>`,
        ),
      );
      const waves = [
        ...svg.matchAll(/<path d="M[^"]* Q[^"]*" stroke="([^"]+)"/g),
      ];
      expect(waves.length).toBe(u === "wavyDbl" ? 2 : 1);
      for (const wave of waves) expect(wave[1]).toBe("#FF0000");
    },
  );

  it("draws a wavy underline in the text colour without one", async () => {
    const svg = await render(
      textBox(
        `<a:p><a:r><a:rPr lang="en-US" sz="2400" u="wavy"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:rPr><a:t>Wavy</a:t></a:r></a:p>`,
      ),
    );
    expect(svg).toMatch(/<path d="M[^"]* Q[^"]*" stroke="#0000FF"/);
  });
});
