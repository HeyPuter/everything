import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

const text = (label) =>
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2000"/><a:t>${label}</a:t></a:r></a:p></p:txBody>`;
const shape = (id, { y = 0, xfrm = "", label = "" } = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="S${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${xfrm}><a:off x="0" y="${y}"/><a:ext cx="1828800" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="25400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr>${label ? text(label) : ""}</p:sp>`;
// A group 2.5 times as wide as its child space, as resizing a group leaves it.
const group = (children) =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="4572000" cy="2743200"/><a:chOff x="0" y="0"/><a:chExt cx="1828800" cy="2743200"/></a:xfrm></p:grpSpPr>${children}</p:grpSp>`;

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
    measureText: (value, spec) => ({
      widthPx: [...value].length * spec.sizePx * 0.5,
      ascentPx: spec.sizePx * 0.9,
      descentPx: spec.sizePx * 0.2,
      lineGapPx: 0,
    }),
  });
}
const rects = (svg) =>
  [
    ...svg.matchAll(
      /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="none" stroke="#000000" stroke-width="([^"]+)"/g,
    ),
  ].map((m) => m.slice(1).map(Number));

describe("a resized group", () => {
  it("keeps its text at its point size and its outlines at their width", async () => {
    const svg = await render(group(shape(10, { label: "Label" })));
    // Nothing is stretched: the child is drawn in its mapped box instead.
    expect(svg).not.toMatch(/scale\(/);
    // 20pt text and a 2pt outline, as on an ungrouped shape.
    expect(svg).toContain('font-size="26.67"');
    expect(rects(svg)).toEqual([[96, 96, 480, 48, 2.67]]);
  });
  it("scales a quarter-turned child's width with the group's height", async () => {
    const svg = await render(
      group(shape(11, { y: 1371600, xfrm: ' rot="5400000"' })),
    );
    // Its 192px width runs down the slide, where the group is not
    // stretched; its 48px height runs across, where it is.
    const [[x, y, w, h]] = rects(svg);
    expect([w, h]).toEqual([192, 120]);
    // Its centre is mapped: 96px across the child space, 2.5 times over.
    expect(x + w / 2).toBeCloseTo(96 + 96 * 2.5, 2);
    expect(y + h / 2).toBeCloseTo(96 + 168, 2);
  });
});
