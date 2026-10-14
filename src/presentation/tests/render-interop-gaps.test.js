// Rendering differences found by opening our files in a desktop editor:
// polynomial trendlines, XY axis ranges, gradient outlines and reflections.
// Expected values are what that editor showed for the same data.
import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import {
  fitTrendline,
  formatCoefficient,
} from "../lib/pptx-preview/src/chart-trendline.ts";
import {
  autoBubbleScale,
  autoValueScale,
} from "../lib/pptx-preview/src/chart-scale.ts";

const IN = (v) => Math.round(v * 914400);
const chartDeck = (spec) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const frame = P.addSlideChart(slide, {
    spec,
    x: IN(0.7),
    y: IN(1.4),
    w: IN(8.5),
    h: IN(4),
  });
  return { pres, slide, frame };
};
const text = (parts) => parts.map((p) => p.text).join("");

describe("trendline fits", () => {
  it("fits a polynomial on the points' x values", () => {
    const fit = fitTrendline("poly", [1, 2, 3, 4, 5], [2, 4, 5, 4, 6], {
      order: 2,
    });
    // As the desktop editor labels it.
    expect(text(fit.equation)).toBe("y = -0.1429x² + 1.6571x + 0.8");
    expect(fit.rSquared.toFixed(4)).toBe("0.7597");
    expect(fit.at(3)).toBeCloseTo(-0.1429 * 9 + 1.6571 * 3 + 0.8, 2);
  });

  it("fits exponential, logarithmic and power curves on real x", () => {
    const xs = [1, 2, 4, 8];
    const exp = fitTrendline(
      "exp",
      xs,
      xs.map((x) => 3 * Math.exp(0.5 * x)),
    );
    expect(exp.at(6)).toBeCloseTo(3 * Math.exp(3), 6);
    expect(text(exp.equation)).toBe("y = 3e0.5x");
    expect(exp.equation[1].sup).toBe(true);
    const log = fitTrendline(
      "log",
      xs,
      xs.map((x) => 2 + Math.log(x)),
    );
    expect(log.at(3)).toBeCloseTo(2 + Math.log(3), 6);
    const power = fitTrendline(
      "power",
      xs,
      xs.map((x) => 5 * x ** 1.5),
    );
    expect(power.at(3)).toBeCloseTo(5 * 3 ** 1.5, 6);
    // Non-positive values fall back to a straight line.
    expect(fitTrendline("exp", [1, 2, 3], [-1, 2, 3]).curved).toBe(false);
  });

  it("formats coefficients to four decimals, trimmed", () => {
    expect(formatCoefficient(0.8)).toBe("0.8");
    expect(formatCoefficient(-0.142857)).toBe("-0.1429");
    expect(formatCoefficient(12)).toBe("12");
  });

  it("draws a curve with its equation and R² as a thin dark line", () => {
    const { pres, slide } = chartDeck({
      kind: "scatter",
      categories: [],
      scatterStyle: "marker",
      series: [
        {
          name: "A",
          xValues: [1, 2, 3, 4, 5],
          values: [2, 4, 5, 4, 6],
          trendline: {
            type: "poly",
            order: 2,
            displayEquation: true,
            displayRSquared: true,
          },
        },
      ],
    });
    const svg = renderSlideToSvg(pres, slide, { textLayout: "svg" });
    const curve =
      /<path d="(M[^"]+)"[^>]*fill="none" stroke="#000000" stroke-width="1"/.exec(
        svg,
      );
    expect(curve).not.toBeNull();
    // Sampled, not a straight segment.
    expect(curve[1].split("L").length).toBeGreaterThan(10);
    expect(svg).toContain("y = -0.1429x² + 1.6571x + 0.8");
    expect(svg).toContain("R² = 0.7597");
  });

  it("writes whether the equation and R² show, even when they don't", async () => {
    const { pres } = chartDeck({
      kind: "line",
      categories: ["a", "b", "c"],
      series: [{ name: "S", values: [1, 2, 4], trendline: { type: "exp" } }],
    });
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(await P.savePresentation(pres));
    const chart = strFromU8(
      files[Object.keys(files).find((f) => /charts\/chart\d+\.xml$/.test(f))],
    );
    expect(chart).toContain('<c:dispRSqr val="0"/><c:dispEq val="0"/>');
  });
});

describe("XY axis ranges", () => {
  // Data range → the axis the desktop editor gave it.
  const cases = [
    [1, 6, 0, 7, 1],
    [1, 5, 0, 6, 1],
    [0.5, 3.9, 0, 4.5, 0.5],
    [12, 27, 0, 30, 5],
    [102, 160, 0, 180, 20],
    [-3, 9, -4, 10, 2],
    [1000, 4000, 0, 4500, 500],
    [0.12, 0.47, 0, 0.5, 0.05],
  ];
  for (const [lo, hi, min, max, unit] of cases)
    it(`scales ${lo}..${hi} to ${min}..${max} by ${unit}`, () => {
      const s = autoValueScale(lo, hi);
      expect(s.min).toBeCloseTo(min, 9);
      expect(s.max).toBeCloseTo(max, 9);
      expect(s.unit).toBeCloseTo(unit, 9);
    });

  it("keeps a minimum above zero for data close together", () => {
    const s = autoValueScale(90, 100);
    expect(s.min).toBeGreaterThan(0);
    expect(s.min).toBeLessThanOrEqual(89.5);
    expect(s.max).toBeGreaterThanOrEqual(100.5);
  });

  it("makes room for bubbles on both axes", () => {
    const sizes = [5, 9, 3, 7];
    const r = (i) => 0.125 * Math.sqrt(sizes[i] / 9);
    expect(autoBubbleScale([12, 47, 81, 140], r)).toMatchObject({
      min: -20,
      max: 180,
    });
    expect(autoBubbleScale([230, 410, 160, 380], r)).toMatchObject({
      min: 0,
      max: 500,
    });
  });

  it("draws scatter axes from zero with room above the data", () => {
    const { pres, slide } = chartDeck({
      kind: "scatter",
      categories: [],
      scatterStyle: "marker",
      series: [
        { name: "S", xValues: [1, 2, 3, 4, 5], values: [2, 4, 5, 4, 6] },
      ],
    });
    const svg = renderSlideToSvg(pres, slide, { textLayout: "svg" });
    const labels = [...svg.matchAll(/<text[^>]*>(-?[\d.]+)<\/text>/g)].map(
      (m) => m[1],
    );
    for (const t of ["0", "6", "7"]) expect(labels).toContain(t);
  });
});

describe("outlines and reflections", () => {
  const shapeDeck = (setup) => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const shape = P.addSlideShape(slide, {
      preset: "rect",
      x: IN(1),
      y: IN(1),
      w: IN(2.5),
      h: IN(1.5),
      text: "Shape",
    });
    setup(pres, shape);
    return renderSlideToSvg(pres, slide, { textLayout: "svg" });
  };

  it("draws a gradient outline at its full width over all of the stroke", () => {
    const svg = shapeDeck((pres, s) => {
      P.setShapeStroke(s, { color: "#000000", widthEmu: 50800 });
      P.setShapeLineGradient(s, {
        stops: [
          { offset: 0, color: "#00B050" },
          { offset: 1, color: "#7030A0" },
        ],
        angleDeg: 0,
      });
    });
    const rect =
      /<rect[^>]*stroke="url\(#([^)]+)\)"[^>]*stroke-width="([\d.]+)"/.exec(
        svg,
      );
    expect(Number(rect[2])).toBeCloseTo(50800 / 9525, 2);
    // The paint covers the half of the stroke outside the shape.
    const tile = new RegExp(
      `<pattern id="${rect[1]}"[^>]*width="([\\d.]+)"`,
    ).exec(svg);
    expect(Number(tile[1])).toBeCloseTo(240 + 50800 / 9525, 1);
  });

  it("mirrors the shape and its text below it, fading away from the edge", () => {
    const svg = shapeDeck((pres, s) =>
      P.setShapeEffectSpec(pres, s, {
        reflection: {
          blurEmu: 0,
          startOpacity: 0.5,
          endOpacity: 0,
          distEmu: 0,
          endPos: 0.5,
        },
      }),
    );
    const at = svg.indexOf('data-pptx-reflection="1"');
    expect(at).toBeGreaterThan(-1);
    const reflected = svg.slice(at, svg.indexOf("</g></g>", at));
    expect(reflected).toContain("scale(1 -1)");
    expect(reflected).toContain(">Shape<");
    // The fade starts opaque at the contact edge (the shape's bottom).
    const bottom = (IN(1) + IN(1.5)) / 9525;
    const grad = new RegExp(
      `<linearGradient id="[^"]+" gradientUnits="userSpaceOnUse" x1="0" y1="${bottom.toFixed(2)}"[^>]*><stop offset="0" stop-color="#fff" stop-opacity="0.500"/><stop offset="0.500" stop-color="#fff" stop-opacity="0.00\\d"/>`,
    );
    expect(svg).toMatch(grad);
  });
});
