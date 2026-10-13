import { describe, expect, it } from "vitest";
import { P, createDeck, slideDiagramDataStamp } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { readShapeDiagram } from "../lib/pptx/src/api/fn/diagram-read.ts";
import { diagramDeck } from "./diagram-copy-fixture.js";

const render = (pres, slide) =>
  renderSlideToSvg(pres, slide, {
    textLayout: "svg",
    stableDefinitionIds: true,
  });
const words = (svg) => svg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const decode = (bytes) => new TextDecoder().decode(bytes);
const diagramParts = (pres) =>
  P._internalPackageOf(pres)
    .parts.map((p) => p.name)
    .filter((n) => n.startsWith("/ppt/diagrams/"));
const reload = async (pres) =>
  P.loadPresentation(await P.savePresentation(pres));
const firstDiagram = (pres) =>
  P.getSlideShapes(P.getSlides(pres)[0]).find(P.isDiagramShape);

const MODEL = {
  layout: "arrow-steps",
  items: [
    { text: "Plan", level: 0 },
    { text: "Scope", level: 1 },
    { text: "Build", level: 0 },
    { text: "Ship", level: 0 },
  ],
  colors: "accent2",
  style: "subtle",
};
const insert = (model = MODEL) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const frame = P.addSlideSmartArt(slide, {
    model,
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(8),
    h: P.inches(4),
    name: "Process",
  });
  return { pres, slide, frame };
};

describe("SmartArt authoring", () => {
  it("writes real diagram parts with an original layout definition", async () => {
    const { pres, frame } = insert();
    const diagram = readShapeDiagram(frame);
    for (const key of ["data", "layout", "quickStyle", "colors", "drawing"])
      expect(diagram[key]).not.toBeNull();
    expect(diagram.issues).toEqual([]);
    const layout = decode(diagram.layout.part.data);
    expect(layout).toContain(
      'uniqueId="urn:everything:smartart:layout/arrow-steps"',
    );
    expect(layout).toContain('<dgm:cat type="process"');
    expect(layout).toContain('<dgm:alg type="lin">');
    const data = decode(diagram.data.part.data);
    expect(data).toContain(">Scope<");
    expect(data).toContain('type="parTrans"');
    expect(decode(diagram.colors.part.data)).toContain('val="accent2"');
    expect(P.getShapeName(frame)).toBe("Process");
    expect(diagramParts(pres)).toHaveLength(5);
    const types = P._internalPackageOf(pres).contentTypes.overrides.map(
      (o) => o.contentType,
    );
    expect(types.filter((t) => t.includes("diagram"))).toHaveLength(5);
    const again = firstDiagram(await reload(pres));
    expect(P.getShapeSmartArt(again)).toEqual(MODEL);
  });

  it("rewrites layout, colors, style, items and direction in place", async () => {
    const { pres, slide, frame } = insert();
    const stamp = slideDiagramDataStamp(pres, slide);
    const next = {
      layout: "org-chart",
      items: [
        { text: "Lead", level: 0 },
        { text: "Design", level: 1 },
        { text: "Engineering", level: 1 },
        { text: "Platform", level: 2 },
      ],
      colors: "colorful",
      style: "intense",
      rightToLeft: true,
    };
    P.setShapeSmartArt(frame, next);
    expect(P.getShapeSmartArt(frame)).toEqual(next);
    expect(diagramParts(pres)).toHaveLength(5);
    expect(slideDiagramDataStamp(pres, slide)).not.toBe(stamp);
    const svg = render(pres, slide);
    expect(words(svg)).toContain("Engineering");
    expect(svg).not.toContain("data-pptx-diagram-issues");
    expect(decode(readShapeDiagram(frame).layout.part.data)).toContain(
      '<dgm:dir val="rev"/>',
    );
    // A color-only change also invalidates the slide's cached render.
    const before = slideDiagramDataStamp(pres, slide);
    P.setShapeSmartArt(frame, { ...next, colors: "accent5" });
    expect(slideDiagramDataStamp(pres, slide)).not.toBe(before);
    const back = firstDiagram(await reload(pres));
    expect(P.getShapeSmartArt(back)).toEqual({ ...next, colors: "accent5" });
    expect(() => P.validatePresentation(pres)).not.toThrow();
  });

  it("mirrors right-to-left diagrams", () => {
    const ltr = insert().frame,
      rtl = insert({ ...MODEL, rightToLeft: true }).frame;
    const firstX = (frame) =>
      Number(
        /<a:off x="(\d+)"/.exec(
          decode(readShapeDiagram(frame).drawing.part.data),
        )[1],
      );
    expect(firstX(rtl)).toBeGreaterThan(firstX(ltr));
    // Slices mirror by angle so their text still reads left to right.
    const wheel = insert({
      ...MODEL,
      layout: "wheel",
      rightToLeft: true,
    }).frame;
    expect(decode(readShapeDiagram(wheel).drawing.part.data)).not.toContain(
      "flipH",
    );
  });

  it("normalizes outlines and falls back to default colors and styles", () => {
    const { frame } = insert({
      layout: "tiles",
      items: [
        { text: "Orphan", level: 2 },
        { text: "Child", level: 4 },
      ],
      colors: "nope",
      style: "nope",
    });
    expect(P.getShapeSmartArt(frame)).toEqual({
      layout: "tiles",
      items: [
        { text: "Orphan", level: 0 },
        { text: "Child", level: 1 },
      ],
      colors: P.DEFAULT_SMARTART_COLORS,
      style: P.DEFAULT_SMARTART_STYLE,
    });
    expect(() =>
      P.addSlideSmartArt(P.getSlides(createDeck("blank"))[0], {
        model: { ...MODEL, layout: "missing" },
        x: 0,
        y: 0,
        w: 100,
        h: 100,
      }),
    ).toThrow(/unknown SmartArt layout/);
  });

  it("forks parts shared with another frame before rewriting", async () => {
    const { pres, slide } = insert();
    // Two frames bound to the same relationships, as some files have.
    const pkg = P._internalPackageOf(pres);
    const part = pkg.getPart(P.getSlidePartName(slide));
    const xml = decode(part.data);
    const frameXml = /<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/.exec(xml)[0];
    part.data = new TextEncoder().encode(
      xml.replace(
        "</p:spTree>",
        frameXml.replace(/ id="\d+"/, ' id="99"') + "</p:spTree>",
      ),
    );
    const shared = await reload(pres);
    const target = P.getSlides(shared)[0];
    const [one, two] = P.getSlideShapes(target).filter(P.isDiagramShape);
    P.setShapeSmartArt(one, {
      ...MODEL,
      items: [{ text: "Changed", level: 0 }],
    });
    expect(P.getShapeSmartArt(one).items[0].text).toBe("Changed");
    expect(P.getShapeSmartArt(two).items[0].text).toBe("Plan");
    expect(diagramParts(shared)).toHaveLength(10);
    expect(() => P.validatePresentation(shared)).not.toThrow();
  });

  it("splits text into Convert to Text lines", () => {
    expect(P.smartArtTextLines(MODEL)).toEqual(MODEL.items);
  });

  it("converts to a group of ordinary shapes and drops the diagram parts", async () => {
    const { pres, slide, frame } = insert({ ...MODEL, layout: "wheel" });
    const drawn = (
      decode(readShapeDiagram(frame).drawing.part.data).match(/<dsp:sp /g) ?? []
    ).length;
    const group = P.convertSmartArtToShapes(slide, frame);
    expect(P.isDiagramShape(group)).toBe(false);
    const children = P.getGroupChildren(group);
    // Pie slices keep their text in a separate box over the slice.
    expect(children.length).toBe(drawn * 2);
    expect(children.some((c) => P.getShapeText(c) === "Scope")).toBe(false);
    expect(children.map((c) => P.getShapeText(c)).join(" ")).toContain("Plan");
    expect(P.getSlideShapes(slide).some(P.isDiagramShape)).toBe(false);
    expect(diagramParts(pres)).toEqual([]);
    const rels = P._internalPackageOf(pres).getRels(P.getSlidePartName(slide));
    expect(rels.items.some((r) => r.type.includes("diagram"))).toBe(false);
    expect(words(render(pres, slide))).toContain("Build");
    expect(() => P.validatePresentation(pres)).not.toThrow();
    const back = await reload(pres);
    expect(P.getSlideShapes(P.getSlides(back)[0]).length).toBeGreaterThan(0);
  });
});

describe("imported SmartArt", () => {
  it("reads items from a diagram this engine did not write", async () => {
    const pres = await diagramDeck({ count: 1 });
    const frame = firstDiagram(pres);
    const model = P.getShapeSmartArt(frame);
    expect(model.layout).toBe("");
    expect(model.items).toEqual([{ text: "Semantic 0", level: 0 }]);
    expect(P.SMARTART_LAYOUTS.map((l) => l.id)).toContain(
      P.guessSmartArtLayout(frame),
    );
  });

  it("changes text in place but refuses structure changes without a layout", async () => {
    const pres = await diagramDeck({ count: 1 });
    const frame = firstDiagram(pres);
    expect(() =>
      P.setShapeSmartArt(frame, {
        ...P.getShapeSmartArt(frame),
        items: [
          { text: "a", level: 0 },
          { text: "b", level: 0 },
        ],
      }),
    ).toThrow(/choose a layout/);
  });

  it("takes one of our layouts and keeps other frames' parts", async () => {
    const pres = await diagramDeck({ count: 2 });
    const slide = P.getSlides(pres)[0];
    const [first, second] = P.getSlideShapes(slide).filter(P.isDiagramShape);
    const sharedStyle = readShapeDiagram(second).quickStyle.part;
    const styleBytes = sharedStyle.data;
    P.setShapeSmartArt(first, {
      ...P.getShapeSmartArt(first),
      layout: P.guessSmartArtLayout(first),
      items: [
        { text: "Semantic 0", level: 0 },
        { text: "Added", level: 0 },
      ],
    });
    expect(P.getShapeSmartArt(first).items.map((i) => i.text)).toEqual([
      "Semantic 0",
      "Added",
    ]);
    // The quick style part both frames shared is forked, not overwritten.
    expect(readShapeDiagram(second).quickStyle.part.data).toBe(styleBytes);
    expect(P.getShapeSmartArt(second).items[0].text).toBe("Semantic 1");
    const svg = render(pres, slide);
    expect(words(svg)).toContain("Added");
    const back = await reload(pres);
    expect(
      P.getShapeSmartArt(
        P.getSlideShapes(P.getSlides(back)[0]).filter(P.isDiagramShape)[0],
      ).items,
    ).toHaveLength(2);
  });

  it("converts an imported drawing with its picture to shapes", async () => {
    const pres = await diagramDeck({ count: 1 });
    const slide = P.getSlides(pres)[0];
    const group = P.convertSmartArtToShapes(slide, firstDiagram(pres));
    const rels = P._internalPackageOf(pres).getRels(P.getSlidePartName(slide));
    const image = rels.items.find((r) => r.type.endsWith("/image"));
    expect(image).toBeTruthy();
    const [child] = P.getGroupChildren(group);
    expect(P.getGroupChildren(group)).toHaveLength(1);
    expect(P.getShapeText(child)).toBe("Rendered 0");
    expect(P.getShapeName(group)).toMatch(/^Diagram/);
    expect(() => P.validatePresentation(pres)).not.toThrow();
  });
});

describe("render stamps", () => {
  it("change when a chart part changes", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const chart = P.addSlideChart(slide, {
      spec: {
        kind: "column",
        categories: ["A", "B"],
        series: [{ name: "S", values: [1, 2] }],
      },
      x: 0,
      y: 0,
      w: P.inches(4),
      h: P.inches(3),
    });
    const before = slideDiagramDataStamp(pres, slide);
    expect(before).toContain("chart");
    P.setChartSpec(
      { shape: chart, spec: P.getShapeChartSpec(chart) },
      {
        kind: "column",
        categories: ["A", "B"],
        series: [{ name: "S", values: [3, 4] }],
      },
    );
    expect(slideDiagramDataStamp(pres, slide)).not.toBe(before);
  });
});
