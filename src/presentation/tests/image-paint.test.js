import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { P, parseDeck, createDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { imagePaintFixture } from "./image-paint-fixture.js";
import { geometryImage } from "./geometry-fixture.js";
const first = (p) => P.getSlideShapes(P.getSlides(p)[0])[0];
const resolve = (p) => P.getShapeImagePaintEffective(p, first(p));
const svg = (p) => renderSlideToSvg(p, P.getSlides(p)[0]);

describe("effective image paint", () => {
  it.each(["local", "layout", "master"])(
    "reads all image paint from the %s declaration's own relationship scope",
    async (level) => {
      const bytes = await imagePaintFixture({ level }),
        p = await parseDeck(bytes);
      const paint = resolve(p);
      expect(paint.bytes).toEqual(new Uint8Array(geometryImage));
      expect(paint.format).toBe("png");
      expect(paint.opacity).toBe(0.25);
      expect(paint.brightness).toBe(0.1);
      expect(paint.contrast).toBe(0.8);
      expect(paint.crop).toEqual({
        left: 0.1,
        top: 0.15,
        right: 0.2,
        bottom: 0.05,
      });
      const output = svg(p);
      expect(output).toContain('opacity="0.250"');
      expect(output).toContain('slope="4.5" intercept="-1.7"');
      expect(output).not.toContain('data-pptx-fallback="image"');
      // Reads neither materialize the inherited fill nor rewrite relationships.
      const saved = unzipSync(await P.savePresentation(p)),
        before = unzipSync(bytes);
      for (const part of Object.keys(saved).filter(
        (n) => n !== "[Content_Types].xml",
      ))
        expect(saved[part]).toEqual(before[part]);
      if (level !== "local")
        expect(P.getShapeImageFillBytes(first(p))).toBeNull();
    },
  );
  it.each([
    "<a:noFill/>",
    '<a:solidFill><a:srgbClr val="4080C0"/></a:solidFill>',
    "<a:gradFill/>",
    "<a:pattFill/>",
    "<a:grpFill/>",
  ])("a nearer fill blocks image inheritance: %s", async (override) => {
    const p = await parseDeck(await imagePaintFixture({ override }));
    expect(resolve(p)).toBeNull();
  });
  it.each(["local", "layout", "master"])(
    "keeps absent correction defaults for %s image paint",
    async (level) => {
      const p = await parseDeck(
          await imagePaintFixture({ level, effects: "", crop: "" }),
        ),
        paint = resolve(p);
      expect(paint.opacity).toBeNull();
      expect(paint.brightness).toBeNull();
      expect(paint.contrast).toBeNull();
      expect(paint.crop).toBeNull();
      expect(paint.grayscale).toBe(false);
      expect(paint.biLevelThreshold).toBeNull();
      expect(paint.duotone).toBeNull();
    },
  );
  it("reads inherited grayscale, threshold and transformed duotone colors", async () => {
    const p = await parseDeck(
      await imagePaintFixture({
        effects:
          '<a:grayscl/><a:biLevel thresh="30000"/><a:duotone><a:srgbClr val="4080C0"><a:shade val="50000"/></a:srgbClr><a:srgbClr val="FFFFFF"/></a:duotone>',
      }),
    );
    const paint = resolve(p);
    expect(paint.grayscale).toBe(true);
    expect(paint.biLevelThreshold).toBe(30);
    expect(paint.duotone).toEqual({
      firstColor: "#2C5C8C",
      secondColor: "#FFFFFF",
    });
  });
  it("keeps missing resources diagnosed and never resolves an image in a different owner's scope", async () => {
    const p = await parseDeck(await imagePaintFixture({ broken: true }));
    expect(resolve(p).bytes).toBeNull();
    expect(svg(p)).toContain('data-pptx-fallback="image"');
  });
  it("a malformed nearer image fill blocks the ancestor image and its effects", async () => {
    const p = await parseDeck(
      await imagePaintFixture({ override: "<a:blipFill/>" }),
    );
    expect(resolve(p).bytes).toBeNull();
    expect(resolve(p).opacity).toBeNull();
    expect(resolve(p).crop).toBeNull();
    expect(svg(p)).toContain('data-pptx-fallback="image"');
  });
  it("a new local image fill does not borrow the ancestor's corrections", async () => {
    const p = await parseDeck(await imagePaintFixture());
    expect(resolve(p).opacity).toBe(0.25);
    P.setShapeImageFill(first(p), new Uint8Array(geometryImage));
    const paint = resolve(p);
    expect(paint.bytes).toEqual(new Uint8Array(geometryImage));
    expect(paint.crop).toBeNull();
    expect(paint.opacity).toBeNull();
    expect(paint.brightness).toBeNull();
    expect(paint.contrast).toBeNull();
  });
  it.each(["valid", "broken", "invalid"])(
    "resolves inherited SVG paint with its raster fallback: %s",
    async (svgMode) => {
      const p = await parseDeck(await imagePaintFixture({ svg: svgMode })),
        paint = resolve(p);
      if (svgMode === "valid") {
        expect(paint.format).toBe("svg");
        expect(strFromU8(paint.bytes)).toContain('fill="#40C080"');
      } else {
        expect(paint.format).toBe("png");
        expect(paint.bytes).toEqual(new Uint8Array(geometryImage));
      }
    },
  );
  it("retains a layout-owned external link without fetching it", async () => {
    const p = await parseDeck(await imagePaintFixture({ external: true }));
    expect(resolve(p).bytes).toBeNull();
    expect(resolve(p).linkUrl).toBe("https://example.com/paint.png");
    expect(svg(p)).toContain("picture (link: https://example.com/paint.png)");
  });
  it("keeps literal picture accessor behavior and uses the same effect readers", () => {
    const p = createDeck("blank"),
      s = P.getSlides(p)[0],
      sh = P.addSlideImage(s, geometryImage, {
        x: 0,
        y: 0,
        w: P.inches(2),
        h: P.inches(1),
      });
    P.setShapeImageCrop(sh, { left: 0.1, top: 0.2, right: 0.1, bottom: 0 });
    P.setShapeImageOpacity(sh, 0.6);
    P.setShapeImageBrightness(sh, 0.1);
    P.setShapeImageContrast(sh, 0.8);
    const paint = P.getShapeImagePaintEffective(p, sh);
    expect(paint.bytes).toEqual(P.getShapeImageBytes(sh));
    expect(paint.crop).toEqual(P.getShapeImageCrop(sh));
    expect(paint.opacity).toBe(P.getShapeImageOpacity(sh));
    expect(paint.brightness).toBe(P.getShapeImageBrightness(sh));
    expect(paint.contrast).toBe(P.getShapeImageContrast(sh));
  });
  it.each(["layout", "master"])(
    "retains %s paint through save and forward/return transfer",
    async (level) => {
      const p = await parseDeck(await imagePaintFixture({ level })),
        before = resolve(p);
      let transferred = p;
      for (let i = 0; i < 2; i++) {
        const target = createDeck("blank"),
          blank = P.getSlides(target)[0];
        P.importSlide(
          target,
          P.getSlides(transferred)[0],
          P.getSlideLayouts(target)[0],
          { preservePaintFormatting: true, preserveTextFormatting: true },
        );
        P.removeSlide(target, blank);
        transferred = await parseDeck(await P.savePresentation(target));
        expect({ ...resolve(transferred), partName: null }).toEqual({
          ...before,
          partName: null,
        });
        expect(resolve(transferred).partName).toBe(
          P.getShapeImagePartName(first(transferred)),
        );
        expect(P.validatePresentation(transferred)).toEqual([]);
      }
    },
  );
});
