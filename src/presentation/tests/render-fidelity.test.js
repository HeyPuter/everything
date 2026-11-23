// How slides draw what DrawingML describes: picture corrections, effects
// and group transforms, checked against the ECMA-376 behaviour.
import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
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
});
