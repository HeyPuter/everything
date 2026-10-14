import { describe, expect, it } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import { buildChartSpaceDoc } from "../lib/pptx/src/internal/chartml/chart-builder.ts";
import { readChartSpec } from "../lib/pptx/src/internal/chartml/chart-reader.ts";
import {
  NS,
  allChildElements,
  firstChildElement,
  parseXml,
  qname,
  serializeXml,
} from "../lib/pptx/src/internal/xml/index.ts";

const c = (name) => qname("c", name, NS.chart);
const roundTrip = (spec) =>
  readChartSpec(parseXml(serializeXml(buildChartSpaceDoc(spec))).root);
const withBars = (kind, errorBars, extra = {}) => ({
  kind,
  categories: ["A", "B", "C"],
  series: [{ name: "S1", values: [3, 5, 4], errorBars, ...extra }],
});
const deck = (spec) => {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0],
    shape = P.addSlideChart(slide, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(7),
      h: P.inches(4),
      spec,
    });
  return { p, slide, shape };
};
const svgOf = (f) => decodeURIComponent(preview(f.p, f.slide));
const childNames = (el) =>
  el.children.filter((n) => n.kind === "element").map((n) => n.name.localName);

describe("chart error bars", () => {
  const variants = [
    { type: "both", valueType: "fixedVal", value: 2 },
    { type: "plus", valueType: "percentage", value: 10, noEndCap: true },
    { type: "minus", valueType: "stdDev", value: 2, color: "#C00000" },
    { type: "both", valueType: "stdErr" },
    { type: "both", valueType: "fixedVal" },
  ];
  for (const kind of ["column", "bar", "line", "area"])
    for (const bars of variants)
      it(`${kind} round-trips ${JSON.stringify(bars)}`, () => {
        expect(roundTrip(withBars(kind, bars)).series[0].errorBars).toEqual(
          bars,
        );
      });

  it("sits after the trendline and before the categories", () => {
    const root = buildChartSpaceDoc(
      withBars(
        "line",
        { type: "both", valueType: "fixedVal", value: 1 },
        { trendline: { type: "linear" } },
      ),
    ).root;
    const ser = firstChildElement(
      firstChildElement(
        firstChildElement(firstChildElement(root, c("chart")), c("plotArea")),
        c("lineChart"),
      ),
      c("ser"),
    );
    const names = childNames(ser);
    expect(names.indexOf("errBars")).toBe(names.indexOf("trendline") + 1);
    expect(names.indexOf("cat")).toBe(names.indexOf("errBars") + 1);
    const bars = firstChildElement(ser, c("errBars"));
    expect(childNames(bars)).toEqual([
      "errBarType",
      "errValType",
      "noEndCap",
      "val",
    ]);
  });

  it("XY series write a direction and keep X bars", () => {
    const spec = {
      kind: "scatter",
      categories: [],
      scatterStyle: "marker",
      series: [
        {
          name: "P",
          xValues: [1, 2, 3],
          values: [2, 4, 3],
          errorBars: {
            direction: "x",
            type: "both",
            valueType: "fixedVal",
            value: 0.5,
          },
        },
      ],
    };
    const root = buildChartSpaceDoc(spec).root;
    const ser = allChildElements(
      firstChildElement(
        firstChildElement(firstChildElement(root, c("chart")), c("plotArea")),
        c("scatterChart"),
      ),
      c("ser"),
    )[0];
    expect(childNames(firstChildElement(ser, c("errBars")))[0]).toBe("errDir");
    expect(roundTrip(spec).series[0].errorBars).toEqual(
      spec.series[0].errorBars,
    );
  });

  it("rejects error bars the schema has no slot for", () => {
    const bars = { type: "both", valueType: "fixedVal" };
    expect(() =>
      buildChartSpaceDoc({
        kind: "pie",
        categories: ["A"],
        series: [{ name: "S", values: [1], errorBars: bars }],
      }),
    ).toThrow(/no error bars/);
    expect(() =>
      buildChartSpaceDoc(withBars("column", { ...bars, direction: "x" })),
    ).toThrow(/X error bars/);
    expect(() =>
      buildChartSpaceDoc(withBars("column", { ...bars, value: -1 })),
    ).toThrow(/value/);
    expect(() =>
      buildChartSpaceDoc(withBars("column", { ...bars, type: "up" })),
    ).toThrow(/type/);
    const f = deck(withBars("column", undefined));
    expect(() =>
      P.setChartSpec(P.getSlideCharts(f.slide)[0], {
        ...P.getShapeChartSpec(f.shape),
        series: [
          {
            name: "S1",
            values: [1, 2, 3],
            errorBars: { ...bars, color: "red" },
          },
        ],
      }),
    ).toThrow(/invalid chart color/);
  });

  for (const kind of ["column", "bar", "line", "area"])
    it(`${kind} preview draws one bar per point with caps`, () => {
      const svg = svgOf(
        deck(withBars(kind, { type: "both", valueType: "fixedVal", value: 1 })),
      );
      const path = svg.match(/data-chart-error-bars="y" d="([^"]+)"/)?.[1];
      expect(path).toBeTruthy();
      // 3 points × (plus, minus) × (stem + cap) = 12 subpaths.
      expect(path.match(/M/g)).toHaveLength(12);
    });

  it("noEndCap and one-sided bars draw fewer strokes", () => {
    const svg = svgOf(
      deck(
        withBars("column", {
          type: "plus",
          valueType: "fixedVal",
          value: 1,
          noEndCap: true,
        }),
      ),
    );
    const path = svg.match(/data-chart-error-bars="y" d="([^"]+)"/)[1];
    expect(path.match(/M/g)).toHaveLength(3);
  });

  it("scatter preview draws X and Y bars", () => {
    const f = deck({
      kind: "scatter",
      categories: [],
      scatterStyle: "marker",
      series: [
        {
          name: "P",
          xValues: [1, 2, 3],
          values: [2, 4, 3],
          errorBars: { direction: "x", type: "both", valueType: "fixedVal" },
        },
      ],
    });
    expect(svgOf(f)).toContain('data-chart-error-bars="x"');
  });

  it("setChartSpec adds, changes and removes error bars and up/down bars", () => {
    const f = deck({
      kind: "line",
      categories: ["A", "B"],
      series: [
        { name: "S1", values: [1, 2] },
        { name: "S2", values: [2, 1] },
      ],
    });
    const chart = () => P.getSlideCharts(f.slide)[0];
    const edit = (fn) => P.setChartSpec(chart(), fn(chart().spec));
    const bars = { type: "plus", valueType: "fixedVal", value: 3 };
    edit((spec) => ({
      ...spec,
      upDownBars: true,
      series: spec.series.map((s) => ({ ...s, errorBars: bars })),
    }));
    let read = P.getShapeChartSpec(f.shape);
    expect(read.upDownBars).toBe(true);
    expect(read.series.map((s) => s.errorBars)).toEqual([bars, bars]);
    edit((spec) => ({
      ...spec,
      series: spec.series.map((s, i) =>
        i
          ? { ...s, errorBars: undefined }
          : { ...s, errorBars: { ...bars, value: 4 } },
      ),
    }));
    read = P.getShapeChartSpec(f.shape);
    expect(read.series.map((s) => s.errorBars)).toEqual([
      { ...bars, value: 4 },
      undefined,
    ]);
    edit((spec) => ({ ...spec, upDownBars: undefined }));
    expect(P.getShapeChartSpec(f.shape).upDownBars).toBeUndefined();
  });

  it("survives save and reload", async () => {
    const f = deck(
      withBars("column", { type: "minus", valueType: "percentage", value: 20 }),
    );
    const saved = await P.loadPresentation(await P.savePresentation(f.p));
    expect(P.validatePresentation(saved)).toEqual([]);
    expect(
      P.getSlideCharts(P.getSlides(saved)[0])[0].spec.series[0].errorBars,
    ).toEqual({ type: "minus", valueType: "percentage", value: 20 });
  });
});

describe("up/down bars", () => {
  const spec = {
    kind: "line",
    categories: ["Mon", "Tue", "Wed"],
    upDownBars: true,
    series: [
      { name: "Open", values: [10, 12, 9] },
      { name: "Close", values: [12, 11, 13] },
    ],
  };
  it("round-trips and renders up and down bars", async () => {
    expect(roundTrip(spec).upDownBars).toBe(true);
    expect(roundTrip({ ...spec, upDownBars: undefined }).upDownBars).toBe(
      undefined,
    );
    const f = deck(spec);
    const svg = svgOf(f);
    expect(svg.match(/data-chart-up-down="up"/g)).toHaveLength(2);
    expect(svg.match(/data-chart-up-down="down"/g)).toHaveLength(1);
    const saved = await P.loadPresentation(await P.savePresentation(f.p));
    expect(P.validatePresentation(saved)).toEqual([]);
  });
});
