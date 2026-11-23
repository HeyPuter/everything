// How slides draw what DrawingML describes: picture corrections, effects
// and group transforms, checked against the ECMA-376 behaviour.
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { luminanceTransfer } from "../lib/pptx-preview/src/render-slide.ts";
import { geometryImage } from "./geometry-fixture.js";

const IN = (v) => Math.round(v * 914400);
const pictureDeck = (setup) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const pic = P.addSlideImage(slide, geometryImage, {
    x: IN(1),
    y: IN(1),
    w: IN(2),
    h: IN(1),
  });
  setup(pic);
  return renderSlideToSvg(pres, slide, { textLayout: "svg" });
};
const transfer = (svg) =>
  /<feComponentTransfer color-interpolation-filters="sRGB"><feFuncR type="linear" slope="([-\d.]+)" intercept="([-\d.]+)"/.exec(
    svg,
  );

describe("picture brightness and contrast", () => {
  const apply = (b, c) => {
    const { slope, intercept } = luminanceTransfer(b, c);
    return (v) => slope * v + intercept;
  };

  it("leaves the picture alone at 0% and 0%", () => {
    expect(luminanceTransfer(0, 0)).toEqual({ slope: 1, intercept: 0 });
  });

  it("moves colours toward white or black with brightness", () => {
    expect(apply(1, 0)(0)).toBeCloseTo(1);
    expect(apply(-1, 0)(1)).toBeCloseTo(0);
    expect(apply(0.4, 0)(0)).toBeCloseTo(0.4);
    expect(apply(0.4, 0)(1)).toBeCloseTo(1);
    expect(apply(-0.4, 0)(1)).toBeCloseTo(0.6);
  });

  it("spreads or gathers colours about the middle grey with contrast", () => {
    for (const c of [-0.6, -0.2, 0.2, 0.6])
      expect(apply(0, c)(0.5)).toBeCloseTo(0.5);
    // More contrast pushes a dark grey darker; less pulls it toward grey.
    expect(apply(0, 0.4)(0.3)).toBeLessThan(0.3);
    expect(apply(0, -0.4)(0.3)).toBeGreaterThan(0.3);
    expect(apply(0, -1)(0.1)).toBeCloseTo(0.5);
  });

  it("keeps a washed-out picture pale but visible", () => {
    const f = apply(0.7, -0.7);
    expect(f(0)).toBeGreaterThan(0.75);
    expect(f(1)).toBeLessThan(0.95);
    expect(f(1)).toBeGreaterThan(f(0));
  });

  it("draws a contrast change without turning the picture grey", () => {
    const svg = pictureDeck((pic) => P.setShapeImageContrast(pic, 0.2));
    const [, slope, intercept] = transfer(svg);
    expect(Number(slope)).toBeCloseTo(1.25, 3);
    expect(Number(intercept)).toBeCloseTo(-0.125, 3);
  });

  it("draws brightness alone in the picture's own colours", () => {
    const svg = pictureDeck((pic) => P.setShapeImageBrightness(pic, 0.3));
    const [, slope, intercept] = transfer(svg);
    expect(slope).toBe("0.7");
    expect(intercept).toBe("0.3");
  });
});

const shapeDeck = (setup, options = {}) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const shape = P.addSlideShape(slide, {
    preset: "rect",
    x: IN(1),
    y: IN(1),
    w: IN(2),
    h: IN(1),
    ...options,
  });
  setup(pres, shape);
  return renderSlideToSvg(pres, slide, { textLayout: "svg" });
};
const shadow = (type, extra = {}) => ({
  shadow: {
    type,
    color: "#000000",
    opacity: 0.5,
    blurEmu: 50800,
    distEmu: 76200,
    angleDeg: 45,
    ...extra,
  },
});

describe("shadows", () => {
  it("paints an inner shadow over the shape it falls on", () => {
    const svg = shapeDeck((pres, s) =>
      P.setShapeEffectSpec(pres, s, shadow("inner")),
    );
    const merge = /<feMerge>(.*?)<\/feMerge>/.exec(svg)[1];
    const order = [...merge.matchAll(/in="([^"]+)"/g)].map((m) => m[1]);
    expect(order[0]).toBe("SourceGraphic");
    expect(order[1]).toMatch(/^innerOut/);
  });

  it("paints an outer shadow behind the shape", () => {
    const svg = shapeDeck((pres, s) =>
      P.setShapeEffectSpec(pres, s, shadow("outer")),
    );
    const merge = /<feMerge>(.*?)<\/feMerge>/.exec(svg)[1];
    const order = [...merge.matchAll(/in="([^"]+)"/g)].map((m) => m[1]);
    expect(order.at(-1)).toBe("SourceGraphic");
  });

  const drop = (svg) =>
    /<feDropShadow dx="([-\d.]+)" dy="([-\d.]+)"/
      .exec(svg)
      .slice(1)
      .map(Number);

  it("keeps a shadow fixed to the page when the shape turns or flips", () => {
    // The pane writes rotWithShape="0": 6pt down and to the right.
    const d = 76200 / 9525 / Math.SQRT2;
    for (const [rotation, flip] of [
      [180, null],
      [90, null],
      [0, "horizontal"],
      [270, "vertical"],
    ]) {
      const svg = shapeDeck((pres, s) => {
        P.setShapeEffectSpec(pres, s, shadow("outer"));
        if (rotation) P.setShapeRotation(s, rotation);
        if (flip)
          P.setShapeFlip(s, {
            horizontal: flip === "horizontal",
            vertical: flip === "vertical",
          });
      });
      // The filter paints inside the shape's turn and flips; undo them.
      let [dx, dy] = drop(svg);
      if (flip === "horizontal") dx = -dx;
      if (flip === "vertical") dy = -dy;
      const r = (rotation * Math.PI) / 180;
      const px = dx * Math.cos(r) - dy * Math.sin(r),
        py = dx * Math.sin(r) + dy * Math.cos(r);
      expect(px).toBeCloseTo(d, 1);
      expect(py).toBeCloseTo(d, 1);
    }
  });

  it("turns a shadow that turns with the shape", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const s = P.addSlideShape(slide, {
      preset: "rect",
      x: IN(1),
      y: IN(1),
      w: IN(2),
      h: IN(1),
    });
    P.setShapeEffectSpec(pres, s, shadow("outer"));
    P.setShapeRotation(s, 180);
    const files = unzipSync(await P.savePresentation(pres));
    const name = P.getSlidePartName(slide).slice(1);
    files[name] = strToU8(
      strFromU8(files[name]).replace('rotWithShape="0"', 'rotWithShape="1"'),
    );
    const loaded = await parseDeck(zipSync(files));
    const svg = renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
      textLayout: "svg",
    });
    // Offset in the shape's own frame, so it turns with it.
    const d = 76200 / 9525 / Math.SQRT2;
    const [dx, dy] = drop(svg);
    expect(dx).toBeCloseTo(d, 1);
    expect(dy).toBeCloseTo(d, 1);
  });

  it("draws the shadow size from the Shadow pane", () => {
    const svg = shapeDeck((pres, s) =>
      P.setShapeEffectSpec(pres, s, shadow("outer", { scale: 1.2 })),
    );
    expect(svg).not.toContain("feDropShadow");
    const m = /data-pptx-shadow="1"><g transform="matrix\(([^)]+)\)"/.exec(svg);
    const [a, b, c, d, e, f] = m[1].split(" ").map(Number);
    expect([a, b, c, d]).toEqual([1.2, 0, 0, 1.2]);
    // Grown about the box's centre (192, 144), then offset 6pt at 45°.
    const off = 76200 / 9525 / Math.SQRT2;
    expect(e).toBeCloseTo(192 - 1.2 * 192 + off, 2);
    expect(f).toBeCloseTo(144 - 1.2 * 144 + off, 2);
  });
});

describe("tiled picture fills", () => {
  const tiled = (align) => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const s = P.addSlideShape(slide, {
      preset: "rect",
      x: IN(1),
      y: IN(1),
      w: IN(2),
      h: IN(1),
    });
    P.setShapeImageFill(s, geometryImage);
    P.setShapeImageFillMode(s, {
      mode: "tile",
      offsetX: 0,
      offsetY: 0,
      scaleX: 10,
      scaleY: 10,
      align,
      mirror: "none",
    });
    const svg = renderSlideToSvg(pres, slide, { textLayout: "svg" });
    return /<pattern [^>]*x="([\d.]+)" y="([\d.]+)"/
      .exec(svg)
      .slice(1)
      .map(Number);
  };
  // A 2px picture at 1000% is a 20px tile in a 192 x 96px box at (96, 96).
  it.each([
    ["tl", 96, 96],
    ["ctr", 96 + 86, 96 + 38],
    ["r", 96 + 172, 96 + 38],
    ["b", 96 + 86, 96 + 76],
  ])("lines the tiles up from the %s point", (align, x, y) => {
    expect(tiled(align)).toEqual([x, y]);
  });
});
