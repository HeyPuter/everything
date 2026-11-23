import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

// A 4 x 2 pixel PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAAASFvFNAAAAEUlEQVR4nGP4z8DAwMDAwAAADvwB/7L1V8gAAAAASUVORK5CYII=";

const text = (label) =>
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${label}</a:t></a:r></a:p></p:txBody>`;
const shape = (id, label, { xfrm = "", fill = "", x = 457200 } = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${label}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${xfrm}><a:off x="${x}" y="457200"/><a:ext cx="2743200" cy="914400"/></a:xfrm><a:prstGeom prst="rightArrow"><a:avLst/></a:prstGeom>${fill}</p:spPr>${text(label)}</p:sp>`;
const group = (id, xfrm, children) =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm${xfrm}><a:off x="457200" y="457200"/><a:ext cx="2743200" cy="914400"/><a:chOff x="457200" y="457200"/><a:chExt cx="2743200" cy="914400"/></a:xfrm></p:grpSpPr>${children}</p:grpSp>`;

async function render(xml) {
  const pres = createDeck("blank"),
    slide = P.getSlides(pres)[0];
  const files = unzipSync(await P.savePresentation(pres));
  const name = P.getSlidePartName(slide).slice(1);
  const rels = name.replace("slides/", "slides/_rels/") + ".rels";
  files[name] = strToU8(
    strFromU8(files[name]).replace("</p:spTree>", `${xml}</p:spTree>`),
  );
  files["ppt/media/flipped.png"] = Uint8Array.from(atob(PNG), (c) =>
    c.charCodeAt(0),
  );
  files[rels] = strToU8(
    strFromU8(files[rels]).replace(
      "</Relationships>",
      '<Relationship Id="rIdFlipped" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/flipped.png"/></Relationships>',
    ),
  );
  const types = strFromU8(files["[Content_Types].xml"]);
  if (!types.includes('Extension="png"'))
    files["[Content_Types].xml"] = strToU8(
      types.replace(
        "<Default ",
        '<Default Extension="png" ContentType="image/png"/><Default ',
      ),
    );
  const loaded = await parseDeck(zipSync(files));
  return renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
    textLayout: "svg",
  });
}

// Whether the text drawn with `label` is mirrored: an odd number of
// mirroring scales among the groups that enclose it.
function mirrored(svg, label) {
  const at = svg.indexOf(`>${label}<`);
  expect(at).toBeGreaterThan(0);
  const stack = [];
  for (const tag of svg.slice(0, at).matchAll(/<(\/?)g\b([^>]*)>/g)) {
    if (tag[1]) stack.pop();
    else if (!tag[2].endsWith("/")) stack.push(tag[2]);
  }
  const flips = stack.join(" ").match(/scale\((-1 1|1 -1)\)/g)?.length;
  return (flips ?? 0) % 2 === 1;
}

describe("text of flipped shapes", () => {
  it("reads the right way round in a group flipped along one axis", async () => {
    const svg = await render(
      group(20, ' flipH="1"', shape(21, "Across")) +
        group(30, ' flipV="1"', shape(31, "Upside")) +
        group(40, ' flipH="1" flipV="1"', shape(41, "Both")),
    );
    expect(mirrored(svg, "Across")).toBe(false);
    expect(mirrored(svg, "Upside")).toBe(false);
    expect(mirrored(svg, "Both")).toBe(false);
  });
  it("reads the right way round in nested flipped groups", async () => {
    const svg = await render(
      group(
        50,
        ' flipH="1"',
        group(51, ' flipH="1"', shape(52, "Twice")) +
          group(53, "", shape(54, "Once", { xfrm: ' flipH="1"' })),
      ),
    );
    expect(mirrored(svg, "Twice")).toBe(false);
    expect(mirrored(svg, "Once")).toBe(false);
  });
  it("reads the right way round on a flipped picture-filled shape", async () => {
    const svg = await render(
      shape(60, "Pictured", {
        xfrm: ' flipH="1"',
        fill: '<a:blipFill><a:blip r:embed="rIdFlipped"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>',
      }),
    );
    expect(svg).toContain("<image");
    expect(mirrored(svg, "Pictured")).toBe(false);
  });
});
