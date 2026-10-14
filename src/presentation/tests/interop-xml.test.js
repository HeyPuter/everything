// Markup that desktop readers insist on. Each case was found by opening a
// file this app wrote in a desktop presentation editor and getting a repair
// prompt or lost content; the tests pin the corrected XML.
import { describe, expect, it } from "vitest";
import { P, createDeck, addLayoutSlide } from "../src/model.js";

const slideXml = (slide) => P.getSlideXmlString(slide);

describe("transitions", () => {
  it("spells out the morph option even when it is the default", () => {
    const pres = createDeck("title");
    const slide = addLayoutSlide(pres, "obj");
    P.setSlideTransition(slide, { effect: "morph" });
    expect(slideXml(slide)).toContain('<p159:morph option="byObject"/>');
    expect(P.getSlideTransition(slide)).toMatchObject({ effect: "morph" });
    P.setSlideTransition(slide, { effect: "morph", morphOption: "byChar" });
    expect(slideXml(slide)).toContain('<p159:morph option="byChar"/>');
  });
});

describe("document properties", () => {
  const coreXml = async (pres) => {
    const { unzipSync, strFromU8 } = await import("fflate");
    return strFromU8(
      unzipSync(await P.savePresentation(pres))["docProps/core.xml"],
    );
  };
  it("types the created and modified dates as W3CDTF", async () => {
    const pres = createDeck("title");
    P.setCoreProperties(pres, {
      created: "2026-10-01T00:00:00Z",
      modified: new Date("2026-10-13T08:30:00.250Z"),
    });
    const xml = await coreXml(pres);
    expect(xml).toMatch(
      /xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/,
    );
    expect(xml).toContain(
      '<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-01T00:00:00Z</dcterms:created>',
    );
    expect(xml).toContain(
      '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-13T08:30:00Z</dcterms:modified>',
    );
    expect(P.getCoreProperties(pres)).toMatchObject({
      created: "2026-10-01T00:00:00Z",
      modified: "2026-10-13T08:30:00Z",
    });
  });
});

describe("media timing", () => {
  it("drops the main sequence a media effect leaves empty", () => {
    const pres = createDeck("title");
    const slide = addLayoutSlide(pres, "obj");
    const wav = new Uint8Array(64);
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const shape = P.addSlideMedia(
      slide,
      {
        kind: "audio",
        data: wav,
        contentType: "audio/wav",
        extension: "wav",
        poster: png,
      },
      { x: 0, y: 0, w: 914400, h: 914400 },
      { durationMs: 1000 },
    );
    expect(slideXml(slide)).toContain('nodeType="mainSeq"');
    P.setShapeMediaOptions(shape, { start: "whenClicked", durationMs: 1000 });
    const xml = slideXml(slide);
    expect(xml).not.toContain('nodeType="mainSeq"');
    expect(xml).not.toMatch(/<p:childTnLst\/>/);
    expect(xml).toContain('nodeType="interactiveSeq"');
    expect(P.getShapeMedia(shape).options.start).toBe("whenClicked");
  });
});

describe("rendering matches desktop readers", () => {
  it("puts the first stop of a path gradient at its focus", async () => {
    const { renderSlideToSvg } =
      await import("../lib/pptx-preview/src/index.ts");
    const pres = createDeck("title");
    const slide = addLayoutSlide(pres, "blank");
    const shape = P.addSlideShape(slide, {
      preset: "ellipse",
      x: 0,
      y: 0,
      w: 914400,
      h: 914400,
    });
    P.setShapeGradientFill(shape, {
      stops: [
        { offset: 0, color: "#FFFFFF" },
        { offset: 1, color: "#2F5597" },
      ],
      path: "circle",
      focus: { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 },
    });
    const svg = renderSlideToSvg(pres, slide);
    expect(svg).toContain("<radialGradient");
    // The radial progress runs from the focus (0) to the edge (1); the red
    // channel's transfer gives the color at each: white at the focus.
    const red = svg.match(
      /<feFuncR[^>]*amplitude="([^"]+)"[^>]*offset="([^"]+)"/,
    );
    expect(Number(red[2])).toBeCloseTo(1, 5);
    expect(Number(red[2]) + Number(red[1])).toBeCloseTo(0x2f / 255, 5);
  });
});
