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
  it("sizes bubbles as a percentage of the default bubble size", async () => {
    const { renderSlideToSvg } =
      await import("../lib/pptx-preview/src/index.ts");
    const largest = (bubbleScale) => {
      const pres = createDeck("title");
      const slide = addLayoutSlide(pres, "blank");
      P.addSlideChart(slide, {
        spec: {
          kind: "bubble",
          categories: [],
          bubbleScale,
          series: [
            {
              name: "S",
              xValues: [1, 2, 3],
              values: [3, 1, 2],
              bubbleSizes: [10, 30, 20],
            },
          ],
        },
        x: 0,
        y: 0,
        w: 3657600,
        h: 2743200,
      });
      const svg = renderSlideToSvg(pres, slide);
      return Math.max(
        ...[...svg.matchAll(/<circle\b[^>]*\br="([\d.]+)"/g)].map((m) =>
          Number(m[1]),
        ),
      );
    };
    const full = largest(100);
    // A quarter of the plot's smaller side across at 100%: under 36px for
    // a 3-inch-high frame.
    expect(full).toBeLessThan(36);
    expect(largest(50) / full).toBeCloseTo(0.5, 2);
  });
  it("reads the focus rectangle as insets from each edge", async () => {
    const { renderSlideToSvg } =
      await import("../lib/pptx-preview/src/index.ts");
    const pres = createDeck("title");
    const slide = addLayoutSlide(pres, "blank");
    const shape = P.addSlideShape(slide, {
      preset: "rect",
      x: 0,
      y: 0,
      w: 914400,
      h: 914400,
    });
    P.setShapeGradientFill(shape, {
      stops: [
        { offset: 0, color: "#FFFFFF" },
        { offset: 1, color: "#ED7D31" },
      ],
      path: "circle",
      // A point 30% across and 20% down.
      focus: { left: 0.3, top: 0.2, right: 0.7, bottom: 0.8 },
    });
    expect(P.getSlideXmlString(slide)).toContain(
      '<a:fillToRect l="30000" t="20000" r="70000" b="80000"/>',
    );
    const svg = renderSlideToSvg(pres, slide);
    expect(svg).toMatch(/<radialGradient\b[^>]*cx="0\.3000" cy="0\.2000"/);
  });
});

describe("SmartArt shape formatting", () => {
  it("puts it on presentation points of the layout definition's tree", async () => {
    const pres = createDeck("title");
    const slide = addLayoutSlide(pres, "blank");
    const frame = P.addSlideSmartArt(slide, {
      model: {
        layout: "arrow-steps",
        colors: P.DEFAULT_SMARTART_COLORS,
        style: P.DEFAULT_SMARTART_STYLE,
        items: [
          { text: "Plan", level: 0 },
          { text: "Build", level: 0, format: { node: { fill: "#C00000" } } },
          { text: "Ship", level: 0 },
        ],
      },
      x: 0,
      y: 0,
      w: 7315200,
      h: 2743200,
    });
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(await P.savePresentation(pres));
    const name = Object.keys(files).find((f) =>
      /^ppt\/diagrams\/data\d+\.xml$/.test(f),
    );
    const data = strFromU8(files[name]);
    // Root, three nodes and the two arrows between them.
    expect(data.match(/type="pres"/g)).toHaveLength(6);
    expect(data.match(/type="presParOf"/g)).toHaveLength(5);
    expect(data.match(/type="presOf"/g)).toHaveLength(3);
    expect(data).toMatch(
      /presName="node" presStyleLbl="node1" presStyleIdx="1" presStyleCnt="3"><dgm:presLayoutVars><dgm:bulletEnabled val="1"\/><\/dgm:presLayoutVars><\/dgm:prSet><dgm:spPr><a:solidFill><a:srgbClr val="C00000"\/>/,
    );
    expect(data).toMatch(
      /presName="arrow" presStyleLbl="sibTrans2D1" presStyleIdx="1" presStyleCnt="2"\/>/,
    );
    // The drawing's shapes are not tied to those points: desktop editors
    // would take a tied drawing's cached text boxes over the layout's.
    const drawing = strFromU8(
      files[name.replace("data", "drawing")] ??
        files[Object.keys(files).find((f) => /drawing\d+\.xml$/.test(f))],
    );
    expect(drawing).toContain('modelId="{DA000000-');
    expect(P.getShapeSmartArt(frame).items[1].format).toEqual({
      node: { fill: "#C00000" },
    });
  });
});

describe("SmartArt layout definitions", () => {
  const layoutXml = async (layout) => {
    const pres = createDeck("title");
    const slide = addLayoutSlide(pres, "blank");
    P.addSlideSmartArt(slide, {
      model: {
        layout,
        colors: P.DEFAULT_SMARTART_COLORS,
        style: P.DEFAULT_SMARTART_STYLE,
        items: [
          { text: "A", level: 0 },
          { text: "B", level: 0 },
        ],
      },
      x: 0,
      y: 0,
      w: 4572000,
      h: 2743200,
    });
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(await P.savePresentation(pres));
    return strFromU8(
      files[
        Object.keys(files).find((f) => /diagrams\/layout\d+\.xml$/.test(f))
      ],
    );
  };
  it("builds a pyramid up from its base, apex first", async () => {
    const up = await layoutXml("pyramid");
    expect(up).toContain('<dgm:param type="linDir" val="fromB"/>');
    expect(up).toContain('<dgm:shape type="trapezoid" r:blip="">');
    expect(up).toContain('styleLbl="node1"');
    const down = await layoutXml("inverted-pyramid");
    expect(down).toContain('<dgm:param type="linDir" val="fromT"/>');
    expect(down).not.toContain('rot="180"');
  });
});
