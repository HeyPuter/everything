// Pictures in picture layouts and formatting of single SmartArt shapes:
// kept in the data model, drawn into the saved drawing, and kept across
// re-layouts and saves.
import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { readShapeDiagram } from "../lib/pptx/src/api/fn/diagram-read.ts";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEIGBkY/jMwAAAZCgL+DW1ZmwAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const decode = (bytes) => new TextDecoder().decode(bytes);
const reload = async (pres) =>
  P.loadPresentation(await P.savePresentation(pres));
const firstDiagram = (pres) =>
  P.getSlideShapes(P.getSlides(pres)[0]).find(P.isDiagramShape);
const media = (pres) =>
  P._internalPackageOf(pres)
    .parts.map((p) => p.name)
    .filter((n) => n.startsWith("/ppt/media/"));

const insert = (layout = "captioned-pictures") => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const frame = P.addSlideSmartArt(slide, {
    model: {
      layout,
      items: [
        { text: "Lake", level: 0 },
        { text: "Hills", level: 0 },
        { text: "Coast", level: 0 },
      ],
      colors: "accent1",
      style: "flat",
    },
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(8),
    h: P.inches(4),
  });
  return { pres, slide, frame };
};

describe("SmartArt shape formatting", () => {
  it("lists the laid-out shapes with stable keys", () => {
    const { frame } = insert();
    const shapes = P.getSmartArtShapes(frame);
    const pics = shapes.filter((s) => s.role === "pic");
    expect(pics.map((s) => s.key)).toEqual(["0/pic", "1/pic", "2/pic"]);
    expect(pics.every((s) => s.w > 0 && s.h > 0)).toBe(true);
  });

  it("fills a picture placeholder with a picture that survives saving", async () => {
    const { pres, frame } = insert();
    const picture = P.addSmartArtPicture(frame, PNG);
    expect(picture).toMatch(/^\/ppt\/media\/image\d+\.png$/);
    const model = P.getShapeSmartArt(frame);
    P.setShapeSmartArt(frame, {
      ...model,
      items: model.items.map((item, i) =>
        i === 1 ? { ...item, format: { pic: { picture } } } : item,
      ),
    });
    const diagram = readShapeDiagram(frame);
    expect(decode(diagram.drawing.part.data)).toContain(
      '<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdPic1"/>',
    );
    // On the picture node of the layout definition's tree, where desktop
    // editors look for it.
    const data = decode(diagram.data.part.data);
    expect(data).toMatch(
      /type="pres"><dgm:prSet presAssocID="[^"]+" presName="image" presStyleLbl="alignImgPlace1" presStyleIdx="1" presStyleCnt="3"\/><dgm:spPr><a:blipFill/,
    );
    expect(data).toContain('type="presParOf"');
    const back = await reload(pres);
    const frame2 = firstDiagram(back);
    const read = P.getShapeSmartArt(frame2);
    expect(read.items[1].format).toEqual({ pic: { picture } });
    expect(P.getSmartArtPictureBytes(frame2, picture)).toEqual(PNG);
    const svg = renderSlideToSvg(back, P.getSlides(back)[0], {
      textLayout: "svg",
    });
    expect(svg).toContain("<image");
    // Adding an item keeps the picture on its item.
    P.setShapeSmartArt(frame2, {
      ...read,
      items: [{ text: "New", level: 0 }, ...read.items],
    });
    expect(P.getShapeSmartArt(frame2).items[2].format).toEqual({
      pic: { picture },
    });
    // Taking the picture away drops its media part.
    const now = P.getShapeSmartArt(frame2);
    P.setShapeSmartArt(frame2, {
      ...now,
      items: now.items.map(({ format: _f, ...item }) => item),
    });
    expect(media(back)).not.toContain(picture);
  });

  it("keeps geometry, size, fill, outline, effects and text styles", async () => {
    const { pres, frame } = insert("tiles");
    const model = P.getShapeSmartArt(frame);
    const format = {
      geom: "ellipse",
      scale: 1.2,
      fill: "#FF8800",
      line: "scheme:accent2/lumMod=75000",
      lineWidth: 25400,
      effects: {
        glow: { color: "scheme:accent1", opacity: 0.6, radiusEmu: 101600 },
      },
    };
    const textStyle = {
      fill: "#112233",
      outline: "#FFFFFF",
      outlineWidth: 12700,
    };
    const before = P.getSmartArtShapes(frame).find((s) => s.key === "0/node");
    P.setShapeSmartArt(frame, {
      ...model,
      format: { "trans:0": { fill: "none" } },
      items: model.items.map((item, i) =>
        i === 0 ? { ...item, format: { node: format }, textStyle } : item,
      ),
    });
    const after = P.getSmartArtShapes(frame).find((s) => s.key === "0/node");
    expect(after.geom).toBe("ellipse");
    expect(after.w).toBeCloseTo(before.w * 1.2, -1);
    const drawing = decode(readShapeDiagram(frame).drawing.part.data);
    expect(drawing).toContain('<a:prstGeom prst="ellipse">');
    expect(drawing).toContain('<a:srgbClr val="FF8800"/>');
    expect(drawing).toContain(
      '<a:ln w="25400"><a:solidFill><a:schemeClr val="accent2"><a:lumMod val="75000"/></a:schemeClr></a:solidFill></a:ln>',
    );
    expect(drawing).toContain('<a:glow rad="101600">');
    expect(drawing).toContain(
      '<a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln><a:solidFill><a:srgbClr val="112233"/></a:solidFill>',
    );
    const back = P.getShapeSmartArt(firstDiagram(await reload(pres)));
    expect(back.items[0].format).toEqual({ node: format });
    expect(back.items[0].textStyle).toEqual(textStyle);
    expect(back.format).toEqual({ "trans:0": { fill: "none" } });
    expect(back.items[1].format).toBeUndefined();
  });
});

describe("SmartArt Format tab helpers", async () => {
  const { withShapeFormat, withTextStyle, wordArtTextStyle, shapeAt } =
    await import("../src/smartart/smartart-format.js");
  const model = {
    layout: "tiles",
    items: [
      { text: "A", level: 0 },
      { text: "B", level: 0, format: { node: { fill: "#FF0000" } } },
    ],
    colors: "accent1",
    style: "flat",
  };
  it("changes, merges and removes one shape's format", () => {
    const a = withShapeFormat(model, "0/node", (f) => ({ ...f, scale: 1.1 }));
    expect(a.items[0].format).toEqual({ node: { scale: 1.1 } });
    const b = withShapeFormat(a, "1/node", (f) => ({ ...f, line: "none" }));
    expect(b.items[1].format).toEqual({
      node: { fill: "#FF0000", line: "none" },
    });
    const c = withShapeFormat(b, "1/node", () => null);
    expect(c.items[1].format).toBeUndefined();
    const d = withShapeFormat(model, "trans:0", () => ({ fill: "none" }));
    expect(d.format).toEqual({ "trans:0": { fill: "none" } });
    expect(withShapeFormat(d, "trans:0", () => null).format).toBeUndefined();
  });
  it("sets text styles and maps WordArt styles onto them", () => {
    const styled = withTextStyle(model, 0, () =>
      wordArtTextStyle({
        color: "#112233",
        outline: { color: "#ffffff", widthEmu: 12700 },
        effects: {
          shadow: {
            color: "#000000",
            opacity: 0.4,
            blurEmu: 3,
            distEmu: 2,
            angleDeg: 45,
          },
        },
      }),
    );
    expect(styled.items[0].textStyle).toEqual({
      fill: "#112233",
      outline: "#FFFFFF",
      outlineWidth: 12700,
      effects: {
        shadow: {
          type: "outer",
          color: "#000000",
          opacity: 0.4,
          blurEmu: 3,
          distEmu: 2,
          angleDeg: 45,
        },
      },
    });
    expect(withTextStyle(styled, 0, () => null).items[0].textStyle).toBe(
      undefined,
    );
  });
  it("finds the topmost shape under a point, turned shapes included", () => {
    const shapes = [
      { key: "bg", x: 0, y: 0, w: 100, h: 100, rot: 0 },
      { key: "bar", x: 40, y: 0, w: 20, h: 100, rot: 90 },
    ];
    expect(shapeAt(shapes, 50, 50).key).toBe("bar");
    expect(shapeAt(shapes, 10, 50).key).toBe("bar");
    expect(shapeAt(shapes, 50, 10).key).toBe("bg");
    expect(shapeAt(shapes, 150, 10)).toBeNull();
  });
});
