import { describe, it, expect } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import { chartRenderingView } from "../lib/pptx/src/api/fn/charts.ts";
import {
  chartPlotGuidesDeck,
  guideLineModes,
} from "./chart-plot-guides-fixture.js";
import { chartLineTheme } from "./chart-area-paint-fixture.js";
import {
  chartLineGapsDeck,
  chartRoot,
  workbook,
} from "./chart-copy-fixture.js";
import {
  parseXml,
  walkElements,
  getAttrValue,
  qname,
} from "../lib/pptx/src/internal/xml/index.ts";
const attr = (e, n) => getAttrValue(e, qname("", n, ""));
const color = "#1B7CA3";
function paint(f) {
  const svg = decodeURIComponent(
      preview(f.p, f.slide).split(",").slice(1).join(","),
    ),
    elements = [];
  walkElements(parseXml(svg).root, (e) => elements.push(e));
  const plot = elements.find(
    (e) => e.name.localName === "rect" && attr(e, "fill") === "#F7F9FB",
  );
  return {
    svg,
    elements,
    plot: Object.fromEntries(
      ["x", "y", "width", "height"].map((n) => [n, Number(attr(plot, n))]),
    ),
    guides: elements.filter(
      (e) => e.name.localName === "line" && attr(e, "stroke") === color,
    ),
  };
}
const make = (groups, options = {}) =>
  chartPlotGuidesDeck({
    groups,
    plotAreaFill: "#F7F9FB",
    valueAxisCrossBetween: "between",
    categoryAxisTickLabelPos: "none",
    valueAxisTickLabelPos: "none",
    ...options,
  });
const y = (r, value, min, max, direction) =>
  r.plot.y +
  r.plot.height *
    (direction === "maxMin"
      ? (value - min) / (max - min)
      : 1 - (value - min) / (max - min));

describe("native plot guide geometry", () => {
  // Measured in the native reference: one envelope per category, including all
  // displayed vertices. Stacked lines return to zero; areas return to crossing.
  for (const kind of ["line", "area"])
    for (const grouping of ["standard", "stacked", "percentStacked"])
      for (const blank of ["gap", "zero", "span"])
        for (const direction of ["minMax", "maxMin"])
          it(`${kind} ${grouping} ${blank} ${direction} follows displayed points`, () => {
            const percent = grouping === "percentStacked",
              stacked = grouping !== "standard",
              min = percent ? 0 : -10,
              max = percent ? 1 : 60,
              cross = percent ? 0.2 : 5;
            const f = make(
                [
                  {
                    kind,
                    grouping,
                    dropLines: "color",
                    ...(kind === "line" ? { hiLowLines: "color" } : {}),
                  },
                ],
                {
                  grouping,
                  dispBlanksAs: blank,
                  valueAxis: { min, max },
                  categoryAxisCrosses: { at: cross },
                  valueAxisOrientation: direction,
                  series: [
                    {
                      name: "First",
                      values: [8, null, 14, 38],
                      markerSymbol: "none",
                      color: "#D85532",
                    },
                    {
                      name: "Second",
                      values: [25, 11, null, 19],
                      markerSymbol: "none",
                      color: "#425EA8",
                    },
                  ],
                },
              ),
              r = paint(f);
            const zero =
                stacked ||
                blank === "zero" ||
                (kind === "area" && blank === "span"),
              points = percent
                ? [
                    [8 / 33, 0, 1, 38 / 57],
                    [1, 1, 1, 1],
                  ]
                : stacked
                  ? [
                      [8, 0, 14, 38],
                      [33, 11, 14, 57],
                    ]
                  : [
                      [8, zero ? 0 : null, 14, 38],
                      [25, 11, zero ? 0 : null, 19],
                    ];
            const expected = [];
            for (let c = 0; c < 4; c++) {
              const values = points.map((s) => s[c]).filter((v) => v !== null),
                lo = Math.min(...values),
                hi = Math.max(...values),
                baseline = stacked && kind === "line" ? 0 : cross;
              expected.push([
                c,
                Math.min(lo, baseline),
                Math.max(hi, baseline),
              ]);
              if (kind === "line" && hi > lo) expected.push([c, lo, hi]);
            }
            expect(r.guides).toHaveLength(expected.length);
            expected.forEach(([c, lo, hi], i) => {
              const line = r.guides[i],
                ys = [
                  y(r, lo, min, max, direction),
                  y(r, hi, min, max, direction),
                ].sort((a, b) => a - b);
              expect(Number(attr(line, "x1"))).toBeCloseTo(
                r.plot.x + ((c + 0.5) * r.plot.width) / 4,
                1,
              );
              expect(Number(attr(line, "y1"))).toBeCloseTo(ys[0], 1);
              expect(Number(attr(line, "y2"))).toBeCloseTo(ys[1], 1);
            });
          });
  for (const dispNaAsBlank of [false, true])
    it(`native #N/A blank=${dispNaAsBlank} shares the data projection`, () => {
      const f = chartLineGapsDeck({
        values: [2, null, 4, null, 3],
        naIndices: [1],
        dispNaAsBlank,
        dispBlanksAs: "zero",
        dropLines: true,
        categoryAxisMajorTickMark: "none",
        categoryAxisMinorTickMark: "none",
        plotAreaFill: "#F7F9FB",
      });
      const r = paint(f),
        view = chartRenderingView(f.shape),
        stroke = view.plotGroups[0].dropLines.paint.color;
      const guides = r.elements.filter(
        (e) =>
          e.name.localName === "line" &&
          attr(e, "stroke") === stroke &&
          Number(attr(e, "x1")) > r.plot.x + 1 &&
          Number(attr(e, "x1")) < r.plot.x + r.plot.width - 1 &&
          attr(e, "x1") === attr(e, "x2"),
      );
      // #N/A connects surrounding values unless explicitly treated as a blank;
      // the ordinary blank at D uses zero in either case.
      expect(guides).toHaveLength(dispNaAsBlank ? 5 : 4);
    });
  it("does not extend shorter series into trailing categories", () => {
    const f = make(
      [{ kind: "line", dropLines: "color", hiLowLines: "color" }],
      {
        dispBlanksAs: "zero",
        series: [
          { name: "Short", values: [10], markerSymbol: "none" },
          { name: "Long", values: [20, 30, 40, 50], markerSymbol: "none" },
        ],
      },
    );
    expect(paint(f).guides).toHaveLength(5); // four drops, one two-point high-low
  });
  it("scales repeated stacks independently on their shared automatic axis", () => {
    const f = make(
        [
          { kind: "line", grouping: "stacked", hiLowLines: "color" },
          { kind: "line", grouping: "stacked", hiLowLines: "color" },
        ],
        {
          valueAxis: {},
          series: [
            { name: "A", values: [8, 10, 14, 38], markerSymbol: "none" },
            { name: "B", values: [25, 11, 8, 19], markerSymbol: "none" },
            { name: "C", values: [4, 5, 7, 19], markerSymbol: "none" },
            { name: "D", values: [12, 5, 4, 9], markerSymbol: "none" },
          ],
        },
      ),
      r = paint(f);
    // The largest independent stack is 57, giving the existing auto-scale
    // fallback a 0..60 domain. The separate stacks must not sum to 85.
    expect(Number(attr(r.guides[3], "y1"))).toBeCloseTo(
      y(r, 57, 0, 60, "minMax"),
      1,
    );
    expect(Number(attr(r.guides[7], "y1"))).toBeCloseTo(
      y(r, 28, 0, 60, "minMax"),
      1,
    );
  });
  it("does not repeat translucent drops for overlapping series", () => {
    const f = make([{ kind: "line", dropLines: "color" }]),
      r = paint(f);
    expect(r.guides).toHaveLength(4);
    expect(r.guides.every((e) => attr(e, "stroke-opacity") === "0.4")).toBe(
      true,
    );
  });
  it("keeps secondary-only guides on their own plot and scale", () => {
    const f = make(
        [
          { kind: "line" },
          {
            kind: "line",
            secondary: true,
            dropLines: "color",
            hiLowLines: "color",
          },
        ],
        {
          axes: {
            secondaryValue: { hidden: false, min: -40, max: 100 },
            secondaryCategory: { hidden: false },
          },
          secondaryCategoryAxisCrosses: { at: 35 },
        },
      ),
      r = paint(f);
    expect(r.guides).toHaveLength(8);
    const values = [
      [8, 25],
      [-6, 11],
      [-8, 14],
      [19, 38],
    ];
    values.forEach(([lo, hi], c) => {
      const expected = [Math.min(lo, 35), Math.max(hi, 35)]
        .map((v) => y(r, v, -40, 100, "minMax"))
        .sort((a, b) => a - b);
      expect(Number(attr(r.guides[c * 2], "y1"))).toBeCloseTo(expected[0], 1);
      expect(Number(attr(r.guides[c * 2], "y2"))).toBeCloseTo(expected[1], 1);
    });
  });
  it("keeps repeated kind/axis groups separate, including independent stacking", () => {
    const f = make([
        { kind: "line", grouping: "standard", dropLines: "color" },
        { kind: "line", grouping: "stacked", hiLowLines: "color" },
      ]),
      r = paint(f),
      view = chartRenderingView(f.shape);
    expect(view.plotGroups.map((g) => [g.series, g.grouping])).toEqual([
      [[0, 1], "standard"],
      [[2, 3], "stacked"],
    ]);
    expect(r.guides).toHaveLength(8);
    // At A the first group's drop spans 0..25, while the second's high-low
    // spans its own cumulative 8..33, excluding the first group's vertices.
    expect(Number(attr(r.guides[0], "y1"))).toBeCloseTo(
      y(r, 25, -10, 60, "minMax"),
      1,
    );
    expect(Number(attr(r.guides[4], "y1"))).toBeCloseTo(
      y(r, 33, -10, 60, "minMax"),
      1,
    );
    expect(Number(attr(r.guides[4], "y2"))).toBeCloseTo(
      y(r, 8, -10, 60, "minMax"),
      1,
    );
  });
  it("does not invent guides from the first plot's legacy flags", () => {
    const f = make([
      { kind: "line", dropLines: "color" },
      { kind: "line", secondary: true },
    ]);
    expect(P.getShapeChartSpec(f.shape).dropLines).toBe(true);
    expect(paint(f).guides).toHaveLength(4);
  });
});

describe("native plot guide line resolution", () => {
  for (const variant of [undefined, "office2010"])
    for (let style = 1; style <= 48; style++)
      it(`${variant ?? "legacy"} style ${style} binds Other Lines before theme transforms`, () => {
        const f = make(
            [{ kind: "line", dropLines: "automatic", hiLowLines: "automatic" }],
            { style, variant, themeLine: chartLineTheme },
          ),
          view = chartRenderingView(f.shape),
          before = f.part.data.slice();
        const scheme = style <= 32 ? "tx1" : style <= 40 ? "dk1" : "lt1",
          shade =
            style >= 35 && style <= 40 && !variant
              ? '<a:shade val="25000"/>'
              : "";
        const mode = `<a:ln w="57150" cap="rnd"><a:solidFill><a:schemeClr val="${scheme}">${shade}<a:shade val="70000"/><a:alpha val="60000"/></a:schemeClr></a:solidFill><a:prstDash val="sysDot"/><a:bevel/></a:ln>`;
        guideLineModes.reference = mode;
        const explicit = make(
          [{ kind: "line", dropLines: "reference", hiLowLines: "reference" }],
          { style, variant, themeLine: chartLineTheme },
        );
        expect(view.plotGroups[0].dropLines).toEqual(
          chartRenderingView(explicit.shape).plotGroups[0].dropLines,
        );
        expect(view.plotGroups[0].hiLowLines).toEqual(
          view.plotGroups[0].dropLines,
        );
        expect(f.part.data).toEqual(before);
        expect(P.getShapeChartSpec(f.shape).dropLines).toBe(true);
        delete guideLineModes.reference;
      });
  for (const mode of ["none", "zero"])
    it(`${mode} suppresses paint without losing its native declaration`, () => {
      const f = make([{ kind: "area", dropLines: mode }]),
        r = paint(f),
        g = chartRenderingView(f.shape).plotGroups[0].dropLines;
      expect(g).toBeDefined();
      expect(P.getShapeChartSpec(f.shape).dropLines).toBe(true);
      expect(
        r.guides.every(
          (e) =>
            Number(attr(e, "stroke-width")) === 0 ||
            attr(e, "stroke") === "none",
        ),
      ).toBe(true);
    });
  it("renders guide paint through copied font/data edits and save/reimport without mutating native parts", async () => {
    const f = make([
        { kind: "area", secondary: true, dropLines: "gradient" },
        { kind: "line", hiLowLines: "custom" },
      ]),
      bytes = f.part.data.slice(),
      book = workbook(f.p, f.shape).data.slice(),
      before = preview(f.p, f.slide);
    paint(f);
    expect(f.part.data).toEqual(bytes);
    expect(workbook(f.p, f.shape).data).toEqual(book);
    const p = createDeck("blank"),
      s = P.importSlide(p, f.slide, P.getSlideLayouts(p)[0]),
      shape = P.getSlideCharts(s)[0].shape;
    const chart = P.getSlideCharts(s)[0];
    P.setChartSpec(chart, {
      ...chart.spec,
      textStyle: { font: "Arial", sizePt: 13 },
      series: chart.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => (v === null ? v : v + 2)),
      })),
    });
    const copied = chartRenderingView(shape).plotGroups;
    // Plot groups are written in the order of their first series.
    expect(copied.map((g) => [g.kind, !!g.dropLines, !!g.hiLowLines])).toEqual([
      ["area", true, false],
      ["line", false, true],
    ]);
    const saved = await P.loadPresentation(await P.savePresentation(p));
    expect(preview(saved, P.getSlides(saved).at(-1))).toEqual(preview(p, s));
    expect(f.part.data).toEqual(bytes);
    expect(preview(f.p, f.slide)).toEqual(before);
    expect(P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data).toEqual(
      bytes,
    );
  });
});
