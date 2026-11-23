import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

// A 6 x 2 inch text box with two short left-aligned lines, at 20 px per
// character.
async function centered(bodyPr) {
  const pres = createDeck("blank"),
    slide = P.getSlides(pres)[0];
  P.addSlideTextBox(slide, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(6),
    h: P.inches(2),
    text: "Wider line\nShort",
  });
  const files = unzipSync(await P.savePresentation(pres));
  const name = P.getSlidePartName(slide).slice(1);
  files[name] = strToU8(
    strFromU8(files[name]).replace(
      /<a:bodyPr\b[^>]*?(\/>|>)/,
      (_, end) => `<a:bodyPr lIns="0" rIns="0"${bodyPr}${end}`,
    ),
  );
  const loaded = await parseDeck(zipSync(files));
  const svg = renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
    textLayout: "svg",
    measureText: (text, spec) => ({
      widthPx: [...text].length * 20,
      ascentPx: spec.sizePx * 0.8,
      descentPx: spec.sizePx * 0.2,
      lineGapPx: 0,
    }),
  });
  return [...svg.matchAll(/<text x="([^"]+)"[^>]*text-anchor="start"/g)].map(
    (m) => Number(m[1]),
  );
}

describe("a text box centered with anchorCtr", () => {
  it("centers its text's own box, keeping the lines left aligned", async () => {
    expect(await centered("")).toEqual([96, 96]);
    // "Wider line" is 200 px; the 576 px box leaves 188 px each side.
    expect(await centered(' anchorCtr="1"')).toEqual([284, 284]);
    expect(await centered(' anchorCtr="0"')).toEqual([96, 96]);
  });
});
