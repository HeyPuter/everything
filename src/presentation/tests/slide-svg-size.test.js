import { describe, it, expect } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import {
  parseXml,
  getAttrValue,
  qname,
  NS,
  serializeXml,
} from "../lib/pptx/src/internal/xml/index.ts";
import { slidePixelSizes, slideSvgSizeDeck } from "./slide-svg-size-fixture.js";
const attribute = (root, name) => getAttrValue(root, qname("", name, ""));
function dimensions(svg, width, height, preserveAspectRatio = "xMidYMid meet") {
  const root = parseXml(svg).root;
  expect(Number(attribute(root, "width"))).toBe(width);
  expect(Number(attribute(root, "height"))).toBe(height);
  expect(attribute(root, "viewBox").split(/\s+/).map(Number)).toEqual([
    0,
    0,
    width,
    height,
  ]);
  expect(attribute(root, "preserveAspectRatio")).toBe(preserveAspectRatio);
}
function sizePreview(p, s) {
  return decodeURIComponent(preview(p, s).split(",").slice(1).join(","));
}
describe("slide SVG intrinsic dimensions", () => {
  it.each([...slidePixelSizes, [1050.37, 642.19]])(
    "retains native %s by %s pixel dimensions in both text-layout modes and image previews",
    (width, height) => {
      const { pres, slide } = slideSvgSizeDeck(width, height),
        before = P._internalPackageOf(pres).parts.map((p) => [
          p.name,
          p.data.slice(),
        ]);
      for (const textLayout of ["svg", "foreignObject"])
        dimensions(
          renderSlideToSvg(pres, slide, { textLayout }),
          width,
          height,
        );
      dimensions(sizePreview(pres, slide), width, height, "none");
      expect(
        P._internalPackageOf(pres).parts.map((p) => [p.name, p.data]),
      ).toEqual(before);
    },
  );
  it("uses the existing widescreen fallback when slide-size metadata is absent", () => {
    const pres = createDeck("blank"),
      part = P._internalPackageOf(pres).getPart("/ppt/presentation.xml"),
      doc = parseXml(new TextDecoder().decode(part.data));
    doc.root.children = doc.root.children.filter(
      (c) =>
        !(
          c.kind === "element" &&
          c.name.namespaceURI === NS.pml &&
          c.name.localName === "sldSz"
        ),
    );
    // Preserve the native omission; this is a renderer fallback only.
    part.data = new TextEncoder().encode(serializeXml(doc));
    const before = part.data.slice();
    expect(P.getSlideSize(pres)).toBeNull();
    dimensions(renderSlideToSvg(pres, P.getSlides(pres)[0]), 1280, 720);
    expect(part.data).toEqual(before);
  });
  it("reads the size the deck has now after it changes", () => {
    const pres = createDeck("blank");
    const first = P.getSlideSize(pres);
    first.width = 1;
    expect(P.getSlideSize(pres).width).toBe(12192000);
    P.setSlideSize(pres, { width: P.inches(10), height: P.inches(7.5) });
    expect(P.getSlideSize(pres)).toMatchObject({
      width: P.inches(10),
      height: P.inches(7.5),
    });
  });
  it("keeps native sizing and geometry through transfer both ways, edit, export and reopen", async () => {
    const { pres, slide, shape } = slideSvgSizeDeck(720, 960),
      original = sizePreview(pres, slide),
      target = createDeck("blank");
    P.setSlideSize(target, P.getSlideSize(pres));
    const forward = P.importSlide(target, slide, P.getSlideLayouts(target)[0]),
      returned = P.importSlide(pres, forward, P.getSlideLayout(slide));
    expect(sizePreview(target, forward)).toBe(original);
    expect(sizePreview(pres, returned)).toBe(original);
    const copiedShape = P.getSlideShapes(returned)[0];
    P.setShapeFill(copiedShape, "#8432A1");
    expect(P.getShapeFill(shape)).toEqual({ kind: "solid", color: "#1267B2" });
    const reopened = await P.loadPresentation(await P.savePresentation(pres));
    expect(P.getSlideSize(reopened)).toEqual(P.getSlideSize(pres));
    expect(sizePreview(reopened, P.getSlides(reopened)[0])).toBe(original);
    dimensions(
      sizePreview(reopened, P.getSlides(reopened).at(-1)),
      720,
      960,
      "none",
    );
    expect(
      P.getShapeBounds(P.getSlideShapes(P.getSlides(reopened).at(-1))[0]),
    ).toEqual(P.getShapeBounds(shape));
    expect(P.validatePresentation(reopened)).toEqual([]);
    expect(P.validatePresentation(target)).toEqual([]);
  });
});
