import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import {
  BULLET_STYLES,
  NUMBER_STYLES,
  applyListStyle,
  bulletKind,
  _private,
} from "../src/format/bullets.js";
import {
  PATTERNS,
  cropToAspect,
  fillOrFit,
  recolorPresets,
  shade,
} from "../src/format/pane.js";
import {
  SHAPE_GROUPS,
  boxTransform,
  editablePaths,
  freeformFromEditable,
  mergeOutlines,
  presetName,
  presetPath,
  shapeRings,
} from "../src/format/edit-shape.js";
import { cameraAngles, projectRotation } from "../src/format/effects.js";
import { withoutBackground } from "../src/format/index.js";
import { imageSize } from "../src/format/image-size.js";
import { texturePixels, TEXTURES } from "../src/format/textures.js";
import { MATRIX_ROWS, matrixStyleChoices } from "../src/format/styles.js";
import { area, polygonsArea } from "../src/format/polygon-boolean.js";
import { flattenGeometry } from "../src/format/geometry-flatten.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEIGBkY/jMwAAAZCgL+DW1ZmwAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

function deck() {
  const pres = createDeck("blank");
  return { pres, slide: P.getSlides(pres)[0] };
}
const box = (x, y, w, h) => ({
  x: P.inches(x),
  y: P.inches(y),
  w: P.inches(w),
  h: P.inches(h),
});

describe("bullets and numbering", () => {
  it("formats numbers as the galleries show them", () => {
    expect(_private.roman(14)).toBe("XIV");
    expect(_private.alpha(28)).toBe("AB");
    expect(_private.circled(3)).toBe("③");
    expect(_private.circled(2, true)).toBe("❷");
    expect(NUMBER_STYLES.map(([, , f]) => f(4))).toContain("iv.");
    // Labels stay distinct for people who hear them.
    const labels = NUMBER_STYLES.map(([, label]) => label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("applies bullets, numbers, pictures and none to paragraphs", async () => {
    const { pres, slide } = deck();
    const s = P.addSlideTextBox(slide, {
      ...box(1, 1, 5, 2),
      text: "One\nTwo\nThree",
    });
    const [, , arrow] = BULLET_STYLES.find(([id]) => id === "arrow");
    applyListStyle(P, s, [0, 1], {
      kind: "bullet",
      char: arrow,
      font: null,
      color: "#FF0000",
      sizePct: 1.25,
    });
    applyListStyle(P, s, [2], {
      kind: "number",
      scheme: "romanUcPeriod",
      startAt: 4,
    });
    expect(bulletKind(P, s, 0)).toEqual({ kind: "bullet", char: arrow });
    expect(bulletKind(P, s, 2)).toEqual({
      kind: "number",
      scheme: "romanUcPeriod",
      startAt: 4,
    });
    expect(P.getParagraphBulletFormat(s, 1)).toMatchObject({
      color: "#FF0000",
      sizePct: 1.25,
    });
    const svg = renderSlideToSvg(pres, slide, { textLayout: "svg" });
    expect(svg).toContain("IV.");
    applyListStyle(P, s, [1], { kind: "picture", bytes: PNG });
    expect(bulletKind(P, s, 1)).toEqual({ kind: "picture" });
    applyListStyle(P, s, [0], { kind: "none" });
    expect(bulletKind(P, s, 0)).toEqual({ kind: "none" });
    expect(P.getParagraphLayout(s, 0)).toMatchObject({
      marL: null,
      indent: null,
    });
    const back = P.findShapeById(
      P.getSlides(await P.loadPresentation(await P.savePresentation(pres)))[0],
      P.getShapeId(s),
    );
    expect(bulletKind(P, back, 2).scheme).toBe("romanUcPeriod");
  });

  it("renders circled numbers", () => {
    const { pres, slide } = deck();
    const s = P.addSlideTextBox(slide, { ...box(1, 1, 5, 2), text: "A\nB" });
    applyListStyle(P, s, [0, 1], {
      kind: "number",
      scheme: "circleNumDbPlain",
      startAt: 1,
    });
    const svg = renderSlideToSvg(pres, slide, { textLayout: "svg" });
    expect(svg).toContain("①");
    expect(svg).toContain("②");
  });
});

describe("pictures", () => {
  it("crops to an aspect ratio about the center", () => {
    expect(cropToAspect({ w: 400, h: 200 }, 1)).toEqual({
      left: 0.25,
      right: 0.25,
      top: 0,
      bottom: 0,
    });
    const tall = cropToAspect({ w: 100, h: 400 }, 1);
    expect(tall.top).toBeCloseTo(0.375);
    expect(tall.bottom).toBeCloseTo(0.375);
    expect(cropToAspect({ w: 160, h: 90 }, 16 / 9)).toEqual({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    });
  });

  it("fills or fits a picture in its box", () => {
    const b = { x: 0, y: 0, w: 1000, h: 1000 };
    const fill = fillOrFit({ w: 200, h: 100 }, b, "fill");
    expect(fill.box).toEqual(b);
    expect(fill.crop.left).toBeCloseTo(0.25);
    const fit = fillOrFit({ w: 200, h: 100 }, b, "fit");
    expect(fit.box).toEqual({ x: 0, y: 250, w: 1000, h: 500 });
  });

  it("reads image sizes from their headers", () => {
    expect(imageSize(PNG)).toEqual({ w: 2, h: 2 });
    const gif = new Uint8Array(30);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0]);
    expect(imageSize(gif)).toEqual({ w: 10, h: 20 });
    const jpeg = new Uint8Array(40);
    jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 30, 0, 50]);
    expect(imageSize(jpeg)).toEqual({ w: 50, h: 30 });
  });

  it("offers recolor presets for every accent", () => {
    const theme = P.getPresentationTheme(deck().pres);
    const presets = recolorPresets(theme);
    expect(presets.filter(([, p]) => p.kind === "duotone")).toHaveLength(13);
    expect(shade("#808080", 1)).toBe("#FFFFFF");
    expect(shade("#808080", -1)).toBe("#000000");
  });

  it("draws textures deterministically", { timeout: 30_000 }, () => {
    expect(TEXTURES.length).toBeGreaterThanOrEqual(8);
    for (const [id] of TEXTURES.slice(0, 3)) {
      const a = texturePixels(id);
      expect(a).toHaveLength(128 * 128 * 4);
      expect(texturePixels(id)).toEqual(a);
    }
  });
});

describe("shapes", () => {
  it("names and draws every preset in the Change Shape gallery", () => {
    const all = SHAPE_GROUPS.flatMap(([, list]) => list);
    expect(new Set(all).size).toBe(all.length);
    for (const preset of all) {
      expect(presetPath(preset), preset).toMatch(/^M/);
      expect(presetName(preset)).not.toMatch(/[a-z][A-Z]/);
    }
    expect(presetName("star5")).toBe("Star: 5 Points");
    expect(presetName("flowChartDecision")).toBe("Flowchart: Decision");
  });

  it("turns a preset into editable points and back without changing it", () => {
    const { pres, slide } = deck();
    const s = P.addSlideShape(slide, { preset: "ellipse", ...box(1, 1, 3, 2) });
    const b = P.getShapeBoundsResolved(pres, s);
    const geometry = P.getShapeGeometryResolved(pres, s).geometry;
    const paths = editablePaths(geometry, b.w, b.h);
    expect(paths).toHaveLength(1);
    expect(paths[0].closed).toBe(true);
    expect(paths[0].nodes).toHaveLength(4);
    expect(paths[0].nodes.every((n) => n.in && n.out)).toBe(true);
    P.setShapeFreeformPaths(s, freeformFromEditable(paths, b.w, b.h));
    expect(P.getShapeGeometryEffective(pres, s).kind).toBe("custom");
    const rings = flattenGeometry(
      P.getShapeGeometryResolved(pres, s).geometry,
      {
        tolerance: 200,
        w: b.w,
        h: b.h,
      },
    );
    const exact = (Math.PI * b.w * b.h) / 4;
    expect(Math.abs(area(rings[0].points)) / exact).toBeCloseTo(1, 2);
  });

  it("maps points between a turned, mirrored box and the slide", () => {
    const t = boxTransform({
      x: 100,
      y: 200,
      w: 40,
      h: 20,
      rot: 90,
      flipH: true,
    });
    const p = { x: 5, y: 7 };
    const back = t.toBox(t.toSlide(p));
    expect(back.x).toBeCloseTo(5);
    expect(back.y).toBeCloseTo(7);
  });

  it("merges overlapping shapes", () => {
    const { pres, slide } = deck();
    const a = P.addSlideShape(slide, { preset: "rect", ...box(1, 1, 2, 2) });
    const b = P.addSlideShape(slide, { preset: "rect", ...box(2, 2, 2, 2) });
    const operands = [shapeRings(P, pres, a), shapeRings(P, pres, b)];
    const sq = P.inches(1) ** 2;
    const total = (pieces) =>
      pieces.reduce((n, piece) => {
        const ring = [];
        let sum = 0;
        for (const c of piece.paths[0].commands) {
          if (c.type === "close") {
            sum += area(ring);
            ring.length = 0;
          } else ring.push({ x: c.x, y: c.y });
        }
        return n + Math.abs(sum);
      }, 0) / sq;
    expect(total(mergeOutlines(operands, "union"))).toBeCloseTo(7, 1);
    expect(total(mergeOutlines(operands, "intersect"))).toBeCloseTo(1, 1);
    expect(total(mergeOutlines(operands, "subtract"))).toBeCloseTo(3, 1);
    expect(mergeOutlines(operands, "fragment")).toHaveLength(3);
    expect(polygonsArea([])).toBe(0);
  });
});

describe("effects and styles", () => {
  it("projects 3-D rotations", () => {
    expect(projectRotation({ x: 0, y: 0, z: 0 })).toEqual([1, 0, 0, 1]);
    const [a, , , d] = projectRotation(cameraAngles("perspectiveLeft"));
    expect(a).toBeLessThan(1);
    expect(d).toBeCloseTo(1);
  });

  it("styles shapes from the theme's style matrix", async () => {
    const { pres, slide } = deck();
    const s = P.addSlideShape(slide, { preset: "rect", ...box(1, 1, 2, 1) });
    P.setShapeFill(s, "#123456");
    const choice = matrixStyleChoices(P.getPresentationTheme(pres)).find(
      (c) => c.id === "matrix|Intense|accent2",
    );
    expect(MATRIX_ROWS).toHaveLength(3);
    P.setShapeStyleMatrix(s, choice.refs);
    const xml = P.getShapeXmlString(s);
    expect(xml).toMatch(/<a:fillRef[^>]*idx="3"/);
    expect(xml).not.toContain("123456");
    expect(P.getShapeFillEffective(pres, s).kind).toBe("gradient");
    const back = await P.loadPresentation(await P.savePresentation(pres));
    expect(
      P.getShapeXmlString(P.getSlideShapes(P.getSlides(back)[0])[0]),
    ).toContain("<p:style>");
  });

  it("keeps only the patterns the file format names", () => {
    const { pres, slide } = deck();
    const s = P.addSlideShape(slide, { preset: "rect", ...box(1, 1, 1, 1) });
    for (const preset of PATTERNS)
      P.setShapePatternFill(s, {
        preset,
        foreground: "#000000",
        background: "#FFFFFF",
      });
    expect(P.getShapePatternFill(pres, s).preset).toBe(PATTERNS.at(-1));
  });

  it("takes the slide background out of a picture of copied objects", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#EEEEEE"/><circle r="2"/></svg>';
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const out = decodeURIComponent(withoutBackground(url).split(",")[1]);
    expect(out).not.toContain("<rect");
    expect(out).toContain("<circle");
  });
});

describe("fonts", () => {
  it("lists and replaces typefaces across slides and the theme", async () => {
    const { pres, slide } = deck();
    const s = P.addSlideTextBox(slide, { ...box(1, 1, 4, 1), text: "Hello" });
    P.setShapeTextFormat(s, { font: "Courier New" });
    expect(P.getPresentationTypefaces(pres)).toEqual(
      expect.arrayContaining(["Calibri", "Courier New"]),
    );
    expect(P.replacePresentationTypeface(pres, "Courier New", "Georgia")).toBe(
      1,
    );
    expect(P.replacePresentationTypeface(pres, "Calibri", "Verdana")).toBe(2);
    const back = await P.loadPresentation(await P.savePresentation(pres));
    expect(P.getPresentationTypefaces(back)).toEqual(["Georgia", "Verdana"]);
  });
});
