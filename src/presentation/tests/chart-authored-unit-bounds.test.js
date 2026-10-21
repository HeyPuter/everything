import { describe, expect, it } from "vitest";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import {
  chartLegendLayoutDeck,
  chartRoot,
  workbook,
} from "./chart-copy-fixture.js";
import {
  getAttrValue,
  parseXml,
  qname,
  walkElements,
} from "../lib/pptx/src/internal/xml/index.ts";

const attr = (e, name) => getAttrValue(e, qname("", name, ""));
const num = (e, name) => Number(attr(e, name));
const text = (e) =>
  e.children
    .filter((c) => c.kind === "text")
    .map((c) => c.data)
    .join("");
const measure = (text, font) => ({
  widthPx: [...text].length * font.sizePx * 0.6,
  ascentPx: font.sizePx * 0.8,
  descentPx: font.sizePx * 0.2,
});
function fixture(kind, values, axis, extra = {}) {
  return chartLegendLayoutDeck({
    kind,
    legend: undefined,
    categories: ["A", "B", "C", "D"],
    series: [
      { name: "Units", values, color: "#E85239", invertIfNegative: false },
    ],
    categoryAxisTickLabelPos: "none",
    // Isolate range projection from exclusion at a painted crossing.
    categoryAxisLineColor: null,
    valueAxisTickLabelPos: "low",
    categoryAxisLabelRotationDeg: 0,
    valueAxisLabelRotationDeg: 0,
    valueAxisLabelStyle: { font: "Arial", sizePt: 9, color: "#17589B" },
    valueAxisMajorGridlines: true,
    valueAxisMajorGridlineColor: "#9152BD",
    valueAxis: { numberFormat: "0.0000000000", ...axis },
    ...extra,
  });
}
function paint(f) {
  const nodes = [];
  walkElements(
    parseXml(renderSlideToSvg(f.p, f.slide, { measureText: measure })).root,
    (e) => nodes.push(e),
  );
  return {
    plot: nodes.find(
      (e) => e.name.localName === "rect" && attr(e, "fill") === "#ECF5E9",
    ),
    labels: nodes.filter(
      (e) => e.name.localName === "text" && attr(e, "fill") === "#17589B",
    ),
    grids: nodes.filter(
      (e) => e.name.localName === "line" && attr(e, "stroke") === "#9152BD",
    ),
    bars: nodes.filter(
      (e) => e.name.localName === "rect" && attr(e, "fill") === "#E85239",
    ),
  };
}
const range = (a, b) => [a, b, (a + b) / 2, a];
// These independent native controls use authored units, so neither font
// metrics nor automatic tick-density fitting can change the expected limits.
const cases = [
  [range(7.8, 12), { majorUnit: 1 }, [0, 13]],
  [range(9.999988, 12), { majorUnit: 1 }, [0, 13]],
  [range(10, 12), { majorUnit: 1 }, [9, 13]],
  [range(10.000012, 12), { majorUnit: 1 }, [9, 13]],
  [range(10.8, 12), { majorUnit: 0.2 }, [10.2, 12.2]],
  [range(8.4, 10), { majorUnit: 0.05 }, [7.6, 10.15]],
  [range(9.8, 10), { majorUnit: 0.05 }, [9.7, 10.05]],
  [range(82, 90), { majorUnit: 1.6 }, [76.8, 91.2]],
  [range(-1, 9), { majorUnit: 0.5 }, [-1.5, 9.5]],
  [range(-4, 5), { majorUnit: 1.8 }, [-5.4, 7.2]],
  [[2, 2, 2, 2], { majorUnit: 0.4 }, [0, 2.4]],
  [[0, 0, 0, 0], { majorUnit: 0.3 }, [0, 1.2]],
  [[0, 0, 0, 0], { majorUnit: 20 }, [0, 20]],
  [range(2, 5), { min: 1.25, majorUnit: 1 }, [1.25, 5.25]],
  [range(2, 5), { max: 3.25, majorUnit: 1 }, [-0.75, 3.25]],
  [range(9, 10), { max: 10, majorUnit: 0.25 }, [8.5, 10]],
  [range(9, 10), { min: 9, majorUnit: 0.05 }, [9, 10.05]],
  [range(2, 5), { min: -100, majorUnit: 10 }, [-100, 20]],
  [range(2, 5), { min: 6, majorUnit: 1 }, [6, 7]],
  [range(2, 5), { max: -10, majorUnit: 3 }, [-13, -10]],
  [[-2, -2, -2, -2], { min: -2, majorUnit: 0.3 }, [-2, -1.4]],
  [[2, 2, 2, 2], { max: 2, majorUnit: 0.3 }, [1.4, 2]],
  [[0, 0, 0, 0], { min: 0, majorUnit: 0.3 }, [0, 0.3]],
];
function check(f, min, max, unit, reversed = false) {
  const r = paint(f),
    values = r.labels.map((e) => Number(text(e).replaceAll(",", ""))),
    count = Math.round((max - min) / unit) + 1;
  expect(values).toHaveLength(count);
  expect(r.grids).toHaveLength(count);
  values.forEach((value, i) => expect(value).toBeCloseTo(min + i * unit, 8));
  expect(values.at(-1)).toBeCloseTo(max, 8);
  const horizontal = P.getShapeChartSpec(f.shape).kind === "bar",
    start = num(r.plot, horizontal ? "x" : "y"),
    length = num(r.plot, horizontal ? "width" : "height");
  r.grids.forEach((grid, i) => {
    const fraction = (i * unit) / (max - min),
      forward = horizontal ? fraction : 1 - fraction;
    expect((num(grid, horizontal ? "x1" : "y1") - start) / length).toBeCloseTo(
      reversed ? 1 - forward : forward,
      4,
    );
  });
  return r;
}
describe("automatic chart bounds with authored major units", () => {
  for (const kind of ["column", "bar", "line", "area"])
    for (const [values, axis, bounds] of cases)
      for (const reflect of [false, true])
        it(`${kind} resolves ${JSON.stringify(axis)} for ${values[0]}..${values[1]}${reflect ? " reflected" : ""}`, () => {
          const mirrored = reflect
            ? {
                majorUnit: axis.majorUnit,
                ...(axis.min === undefined ? {} : { max: -axis.min }),
                ...(axis.max === undefined ? {} : { min: -axis.max }),
              }
            : axis;
          // An all-zero automatic axis has a positive default, independent
          // of reflecting its values. One-sided bounds still reflect.
          const zeroDefault =
            values.every((v) => v === 0) &&
            axis.min === undefined &&
            axis.max === undefined;
          const expected =
              reflect && !zeroDefault ? [-bounds[1], -bounds[0]] : bounds,
            f = fixture(
              kind,
              values.map((v) => (reflect ? -v : v)),
              mirrored,
              { valueAxisOrientation: "maxMin" },
            );
          check(f, ...expected, axis.majorUnit, true);
        });

  for (const factor of [1e-6, 1e6])
    it(`resolves the same proportions after scaling data and units by ${factor}`, () => {
      const f = fixture(
        "column",
        range(8.4, 10).map((v) => v * factor),
        { majorUnit: 0.05 * factor },
      );
      check(f, 7.6 * factor, 10.15 * factor, 0.05 * factor);
    });

  for (const kind of ["column", "bar"])
    it(`${kind} projects the bars and gridlines through the same automatic range`, () => {
      const values = range(82, 90),
        min = 76.8,
        max = 91.2,
        f = fixture(kind, values, { majorUnit: 1.6 }),
        r = check(f, min, max, 1.6),
        horizontal = kind === "bar",
        start = num(r.plot, horizontal ? "x" : "y"),
        length = num(r.plot, horizontal ? "width" : "height");
      expect(r.bars).toHaveLength(4);
      r.bars.forEach((bar, i) => {
        const extent = ((values[i] - min) / (max - min)) * length;
        // The serialized plot span and bar each round independently to 0.01px.
        expect(
          Math.abs(num(bar, horizontal ? "width" : "height") - extent),
        ).toBeLessThan(0.01);
        expect(
          Math.abs(
            num(bar, horizontal ? "x" : "y") -
              (horizontal ? start : start + length - extent),
          ),
        ).toBeLessThan(0.015);
      });
    });

  // As with minor units, an authored major unit too small for the span is
  // drawn at 500 intervals rather than one label and gridline per unit.
  for (const kind of ["column", "bar", "line", "area"])
    it(`${kind} draws at most 500 major intervals for a tiny authored unit`, () => {
      check(
        fixture(kind, range(1, 4), { min: 0, max: 5, majorUnit: 0.0001 }),
        0,
        5,
        0.01,
      );
    });
  it("scales positive and negative stacked totals before rounding automatic ends", () => {
    const f = fixture(
      "column",
      [3, -2, 4, -1],
      { majorUnit: 1 },
      {
        grouping: "stacked",
        series: [
          { name: "A", values: [3, -2, 4, -1] },
          { name: "B", values: [4, -3, 2, -1] },
        ],
      },
    );
    check(f, -6, 8, 1);
  });

  it("shares the rounded range and interval count across combination groups", () => {
    const f = fixture(
      "column",
      range(9.8, 10),
      { majorUnit: 0.05 },
      {
        series: [
          { name: "Bars", values: range(9.8, 10), color: "#E85239" },
          { name: "Line", values: [10, 10, 10, 10], chartKind: "line" },
        ],
      },
    );
    const r = check(f, 9.7, 10.05, 0.05);
    expect(r.bars).toHaveLength(4);
    r.bars.forEach((bar, i) =>
      expect(num(bar, "height") / num(r.plot, "height")).toBeCloseTo(
        (range(9.8, 10)[i] - 9.7) / (10.05 - 9.7),
        4,
      ),
    );
  });

  it("retains automatic bounds, editable data and source parts through transfer and reimport", async () => {
    const f = fixture("bar", range(82, 90), { majorUnit: 1.6 }),
      spec = P.getShapeChartSpec(f.shape),
      raw = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data.slice(),
      book = workbook(f.p, f.shape).data.slice();
    check(f, 76.8, 91.2, 1.6);
    expect(P.getShapeChartSpec(f.shape)).toEqual(spec);
    expect(spec.valueAxis.min).toBeUndefined();
    expect(spec.valueAxis.max).toBeUndefined();
    const q = createDeck("blank"),
      imported = P.importSlide(q, f.slide, P.getSlideLayouts(q)[0]),
      loaded = await parseDeck(await P.savePresentation(q)),
      back = P.importSlide(
        f.p,
        P.getSlides(loaded).at(-1),
        P.getSlideLayout(f.slide),
      ),
      shape = P.getSlideCharts(back)[0].shape;
    expect(P.getSlideCharts(imported)[0].spec).toEqual(spec);
    expect(P.getShapeChartSpec(shape)).toEqual(spec);
    expect(P._internalPackageOf(f.p).getPart(chartRoot(shape)).data).toEqual(
      raw,
    );
    expect(workbook(f.p, shape).data).toEqual(book);
    check({ p: f.p, slide: back, shape }, 76.8, 91.2, 1.6);
    P.setChartSpec(
      { shape, spec },
      { ...spec, series: [{ ...spec.series[0], values: range(-90, -82) }] },
    );
    check({ p: f.p, slide: back, shape }, -91.2, -76.8, 1.6);
    expect(P.validatePresentation(f.p)).toEqual([]);
  });
});
