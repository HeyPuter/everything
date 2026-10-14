import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEIGBkY/jMwAAAZCgL+DW1ZmwAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

function deck() {
  const pres = createDeck("blank"),
    slide = P.getSlides(pres)[0];
  return { pres, slide };
}
async function roundTrip(pres) {
  return P.loadPresentation(await P.savePresentation(pres));
}
const shapeOn = (pres, id) => P.findShapeById(P.getSlides(pres)[0], id);
const svgOf = (pres) =>
  renderSlideToSvg(pres, P.getSlides(pres)[0], { textLayout: "svg" });

describe("paragraph layout and bullets", () => {
  it("writes indents and tab stops in schema order and reads them back", async () => {
    const { pres, slide } = deck();
    const box = P.addSlideTextBox(slide, {
      text: "A\tB\tC",
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(6),
      h: P.inches(1),
    });
    P.setShapeBullets(box, "bullet");
    P.setParagraphLayout(box, 0, {
      marL: P.inches(0.5),
      indent: -P.inches(0.25),
      defaultTab: P.inches(0.75),
      tabs: [
        { pos: P.inches(3), align: "r" },
        { pos: P.inches(1.5), align: "ctr" },
      ],
    });
    P.setParagraphBulletFormat(box, 0, {
      color: "#FF0000",
      sizePct: 1.5,
      font: "Arial",
    });
    const xml = P.getShapeXmlString(box);
    // lnSpc..spcAft, buClr, buSz, buFont, buChar, tabLst order.
    const order = ["buClr", "buSzPct", "buFont", "buChar", "tabLst"].map((n) =>
      xml.indexOf(`<a:${n}`),
    );
    expect(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1]))).toBe(
      true,
    );
    const back = shapeOn(await roundTrip(pres), P.getShapeId(box));
    expect(P.getParagraphLayout(back, 0)).toEqual({
      marL: 457200,
      marR: null,
      indent: -228600,
      defaultTab: 685800,
      tabs: [
        { pos: 1371600, align: "ctr" },
        { pos: 2743200, align: "r" },
      ],
    });
    expect(P.getParagraphBulletFormat(back, 0)).toEqual({
      color: "#FF0000",
      sizePct: 1.5,
      font: "Arial",
    });
    P.setParagraphBulletFormat(back, 0, { color: null, sizePct: null });
    expect(P.getParagraphBulletFormat(back, 0)).toMatchObject({
      color: null,
      sizePct: null,
    });
  });

  it("lays text out on tab stops", () => {
    const { pres, slide } = deck();
    const box = P.addSlideTextBox(slide, {
      text: "A\tB",
      x: 0,
      y: 0,
      w: P.inches(6),
      h: P.inches(1),
    });
    P.setParagraphLayout(box, 0, { tabs: [{ pos: P.inches(2), align: "l" }] });
    const svg = svgOf(pres);
    const dx = Number(/<tspan dx="([\d.]+)"/.exec(svg)?.[1]);
    // "A" is narrow, so the tab carries B most of the way to 2 inches (192px).
    expect(dx).toBeGreaterThan(150);
    expect(dx).toBeLessThan(192);
  });

  it("gives a paragraph a picture bullet", async () => {
    const { pres, slide } = deck();
    const box = P.addSlideTextBox(slide, {
      text: "One\nTwo",
      x: 0,
      y: 0,
      w: P.inches(4),
      h: P.inches(1),
    });
    const id = P.setParagraphBulletPicture(box, 0, { bytes: PNG });
    P.setParagraphBulletPicture(box, 1, { relationshipId: id });
    const back = shapeOn(await roundTrip(pres), P.getShapeId(box));
    expect(P.isParagraphBulletPicture(back, 0)).toBe(true);
    expect(P.isParagraphBulletPicture(back, 1)).toBe(true);
    expect(P.getParagraphBulletImageBytes(back, 1)).toEqual(PNG);
  });
});

describe("character formatting", () => {
  it("round-trips underline color, equal height, outline, gradient and effects", async () => {
    const { pres, slide } = deck();
    const box = P.addSlideTextBox(slide, {
      text: "Hello",
      x: 0,
      y: 0,
      w: P.inches(4),
      h: P.inches(1),
    });
    const format = {
      underline: "dbl",
      underlineColor: "#00FF00",
      strike: "dblStrike",
      normalizeHeight: true,
      outline: { color: "#0000FF", widthEmu: 19050 },
      gradient: {
        stops: [
          { offset: 0, color: "#FF0000" },
          { offset: 1, color: "#0000FF" },
        ],
        angleDeg: 0,
      },
      effects: {
        shadow: {
          color: "#000000",
          opacity: 0.5,
          blurEmu: 38100,
          distEmu: 38100,
          angleDeg: 45,
        },
        glow: { color: "#FFFF00", opacity: 0.6, radiusEmu: 63500 },
      },
    };
    P.setShapeTextFormat(box, format);
    const back = shapeOn(await roundTrip(pres), P.getShapeId(box));
    const read = P.getShapeRunFormat(back, 0, 0);
    expect(read).toMatchObject({
      underline: "dbl",
      underlineColor: "#00FF00",
      strike: "dblStrike",
      normalizeHeight: true,
      outline: { color: "#0000FF", widthEmu: 19050 },
      gradient: { angleDeg: 0 },
      effects: {
        shadow: { blurEmu: 38100, distEmu: 38100, angleDeg: 45, opacity: 0.5 },
        glow: { radiusEmu: 63500, opacity: 0.6 },
      },
    });
    const svg = svgOf(await roundTrip(pres));
    expect(svg).toContain('stroke="#0000FF"');
    expect(svg).toMatch(/fill="url\(#pkdef-[a-z0-9]+\)"/);
    expect(svg).toContain("<feMorphology");
    // Double underline and strikethrough are drawn as lines: two each.
    expect(
      svg.match(/<path d="M[\d. -]+H[\d.]+" stroke="#00FF00"/g),
    ).toHaveLength(2);
    // A solid color replaces the gradient.
    P.setShapeTextFormat(back, { color: "#123456" });
    expect(P.getShapeRunFormat(back, 0, 0).gradient).toBeUndefined();
  });
});

describe("shape effects and 3-D", () => {
  it("edits one effect at a time and keeps the rest in schema order", async () => {
    const { pres, slide } = deck();
    const shape = P.addSlideShape(slide, {
      preset: "rect",
      x: 0,
      y: 0,
      w: P.inches(2),
      h: P.inches(1),
    });
    P.setShapeEffectSpec(pres, shape, {
      shadow: {
        type: "outer",
        color: "#000000",
        opacity: 0.4,
        blurEmu: 50800,
        distEmu: 38100,
        angleDeg: 90,
      },
    });
    P.setShapeEffectSpec(pres, shape, {
      softEdge: { radiusEmu: 63500 },
      glow: { color: "#FF0000", opacity: 0.6, radiusEmu: 127000 },
      reflection: {
        startOpacity: 0.5,
        endPos: 0.35,
        distEmu: 0,
        blurEmu: 6350,
      },
    });
    const xml = P.getShapeXmlString(shape);
    const order = ["glow", "outerShdw", "reflection", "softEdge"].map((n) =>
      xml.indexOf(`<a:${n}`),
    );
    expect(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1]))).toBe(
      true,
    );
    const back = await roundTrip(pres);
    const spec = P.getShapeEffectSpec(back, shapeOn(back, P.getShapeId(shape)));
    expect(spec.shadow).toMatchObject({
      type: "outer",
      opacity: 0.4,
      angleDeg: 90,
    });
    expect(spec.glow).toMatchObject({ radiusEmu: 127000 });
    expect(spec.reflection).toMatchObject({ endPos: 0.35, startOpacity: 0.5 });
    expect(spec.softEdge).toEqual({ radiusEmu: 63500 });
    P.setShapeEffectSpec(back, shapeOn(back, P.getShapeId(shape)), {
      glow: null,
      shadow: { ...spec.shadow, type: "inner" },
    });
    const after = P.getShapeEffectSpec(
      back,
      shapeOn(back, P.getShapeId(shape)),
    );
    expect(after.glow).toBeNull();
    expect(after.shadow.type).toBe("inner");
    expect(after.softEdge).toEqual({ radiusEmu: 63500 });
  });

  it("stores bevel, depth, material, lighting and rotation", async () => {
    const { pres, slide } = deck();
    const shape = P.addSlideShape(slide, {
      preset: "rect",
      x: 0,
      y: 0,
      w: P.inches(2),
      h: P.inches(1),
    });
    expect(P.getShape3D(shape).present).toBe(false);
    P.setShape3D(shape, {
      bevelTop: { preset: "circle", widthEmu: 76200, heightEmu: 76200 },
      depthEmu: 50800,
      depthColor: "#FF0000",
      material: "metal",
      lightRig: "balanced",
    });
    P.setShape3D(shape, {
      camera: "perspectiveFront",
      rotX: 20,
      rotY: 30,
      fov: 45,
    });
    const back = shapeOn(await roundTrip(pres), P.getShapeId(shape));
    expect(P.getShape3D(back)).toMatchObject({
      present: true,
      camera: "perspectiveFront",
      rotX: 20,
      rotY: 30,
      fov: 45,
      lightRig: "balanced",
      bevelTop: { preset: "circle", widthEmu: 76200 },
      depthEmu: 50800,
      depthColor: "#FF0000",
      material: "metal",
    });
    const xml = P.getShapeXmlString(back);
    expect(xml.indexOf("<a:scene3d")).toBeLessThan(xml.indexOf("<a:sp3d"));
    P.setShape3D(back, null);
    expect(P.getShape3D(back).present).toBe(false);
  });
});

describe("paints and geometry", () => {
  it("paints a gradient line and renders it", async () => {
    const { pres, slide } = deck();
    const shape = P.addSlideShape(slide, {
      preset: "rect",
      x: 0,
      y: 0,
      w: P.inches(2),
      h: P.inches(1),
    });
    P.setShapeStroke(shape, { color: "#FF0000", widthEmu: P.pt(4) });
    P.setShapeStrokeDash(shape, "dash");
    P.setShapeLineGradient(shape, {
      stops: [
        { offset: 0, color: "#FF0000" },
        { offset: 1, color: "#00FF00" },
      ],
      angleDeg: 0,
    });
    const back = await roundTrip(pres);
    const s = shapeOn(back, P.getShapeId(shape));
    expect(P.getShapeLineGradient(back, s)?.stops).toHaveLength(2);
    expect(P.getShapeStrokeDash(s)).toBe("dash");
    expect(svgOf(back)).toMatch(/stroke="url\(#pkdef-[a-z0-9]+\)"/);
    P.setShapeLineGradient(s, null);
    expect(P.getShapeLineGradient(back, s)).toBeNull();
    expect(P.getShapeStroke(s)).toMatchObject({
      kind: "solid",
      color: "#FF0000",
    });
  });

  it("tiles a picture fill and stores picture adjustments and recoloring", async () => {
    const { pres, slide } = deck();
    const shape = P.addSlideShape(slide, {
      preset: "ellipse",
      x: 0,
      y: 0,
      w: P.inches(2),
      h: P.inches(1),
    });
    P.setShapeImageFill(shape, PNG);
    P.setShapeImageFillMode(shape, {
      mode: "tile",
      offsetX: 0,
      offsetY: 0,
      scaleX: 2,
      scaleY: 2,
      align: "tl",
      mirror: "xy",
    });
    P.setShapePictureAdjustments(shape, {
      saturation: 2,
      temperature: 8000,
      sharpness: 0.5,
      artistic: { effect: "artisticBlur", amount: 0.4 },
    });
    P.setShapePictureRecolor(shape, { kind: "grayscale" });
    const back = await roundTrip(pres);
    const s = shapeOn(back, P.getShapeId(shape));
    expect(P.getShapeImageFillMode(s)).toMatchObject({
      mode: "tile",
      scaleX: 2,
      mirror: "xy",
    });
    expect(P.getShapePictureAdjustments(s)).toEqual({
      saturation: 2,
      temperature: 8000,
      sharpness: 0.5,
      artistic: { effect: "artisticBlur", amount: 0.4 },
    });
    expect(P.getShapePictureRecolor(s)).toEqual({ kind: "grayscale" });
    const svg = svgOf(back);
    expect(svg).toContain("<pattern");
    expect(svg).toContain('type="saturate"');
    expect(svg).toContain("feConvolveMatrix");
    P.setShapePictureAdjustments(s, {
      saturation: null,
      temperature: null,
      sharpness: null,
      artistic: null,
    });
    expect(P.getShapeXmlString(s)).not.toContain("imgProps");
    P.setShapePictureRecolor(s, {
      kind: "duotone",
      dark: "#000000",
      light: "#FFCC88",
    });
    expect(P.getShapePictureRecolor(s)).toEqual({
      kind: "duotone",
      dark: "#000000",
      light: "#FFCC88",
    });
  });

  it("changes a shape's preset geometry and keeps its formatting", () => {
    const { pres, slide } = deck();
    const shape = P.addSlideTextBox(slide, {
      text: "Keep me",
      x: 0,
      y: 0,
      w: P.inches(2),
      h: P.inches(1),
    });
    P.setShapeFill(shape, "#336699");
    P.setShapePresetGeometry(shape, "star5");
    expect(P.getShapePreset(shape)).toBe("star5");
    expect(P.getShapeFill(shape)).toMatchObject({ color: "#336699" });
    expect(P.getShapeText(shape)).toBe("Keep me");
    expect(P.getShapeGeometryResolved(pres, shape).preset).toBe("star5");
  });
});
