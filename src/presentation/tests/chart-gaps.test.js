// Bubble and scatter labels and trendlines, data tables on horizontal bar
// charts, and custom error-bar amounts (literal or from the data sheet).
import { describe, expect, it } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import { buildChartSpaceDoc } from "../lib/pptx/src/internal/chartml/chart-builder.ts";
import { readChartSpec } from "../lib/pptx/src/internal/chartml/chart-reader.ts";
import { parseXml, serializeXml } from "../lib/pptx/src/internal/xml/index.ts";
import {
  gridToSpec,
  normalizeSheetRange,
  parseErrorAmounts,
  specToGrid,
} from "../src/charts/chart-data.js";

const roundTrip = (spec) =>
  readChartSpec(parseXml(serializeXml(buildChartSpaceDoc(spec))).root);
const deck = (spec) => {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0];
  P.addSlideChart(slide, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(8),
    h: P.inches(5),
    spec,
  });
  return { p, slide };
};
const svgOf = (f) => decodeURIComponent(preview(f.p, f.slide));
const labels = {
  showValue: true,
  showCategory: false,
  showSeriesName: false,
  showPercent: false,
};
const bubble = (extra = {}) => ({
  kind: "bubble",
  categories: [],
  series: [
    {
      name: "Region",
      xValues: [1, 2, 3],
      values: [10, 27, 15],
      bubbleSizes: [4, 9, 16],
      ...extra,
    },
  ],
});

describe("XY data labels and trendlines", () => {
  it("labels each bubble with its value, and the X value when asked", () => {
    const svg = svgOf(deck({ ...bubble(), dataLabels: labels }));
    for (const v of ["10", "27", "15"]) expect(svg).toContain(`>${v}</text>`);
    const both = svgOf(
      deck({
        ...bubble(),
        dataLabels: { ...labels, showCategory: true, separator: "; " },
      }),
    );
    expect(both).toContain(">2; 27</text>");
  });
  it("draws trendlines over bubbles and scatter points", () => {
    // With no line format of its own, a trendline is a thin solid dark line
    // (as a desktop editor draws it).
    const dashed = (svg) =>
      (svg.match(/fill="none" stroke="#000000" stroke-width="1"/g) || [])
        .length;
    expect(dashed(svgOf(deck(bubble({ trendline: { type: "linear" } }))))).toBe(
      1,
    );
    expect(
      dashed(
        svgOf(
          deck({
            kind: "scatter",
            categories: [],
            scatterStyle: "marker",
            series: [
              {
                name: "S",
                xValues: [3, 1, 2],
                values: [3, 1, 2],
                trendline: { type: "movingAvg", period: 2 },
              },
            ],
          }),
        ),
      ),
    ).toBe(1);
    expect(
      roundTrip(bubble({ trendline: { type: "linear" } })).series[0],
    ).toMatchObject({ trendline: { type: "linear" } });
  });
});

describe("data tables on horizontal bar charts", () => {
  it("draws the table under the value axis and keeps category labels", () => {
    const svg = svgOf(
      deck({
        kind: "bar",
        categories: ["North", "South"],
        dataTable: { showOutline: true, showKeys: true },
        series: [
          { name: "Sales", values: [12, 7] },
          { name: "Costs", values: [5, 9] },
        ],
      }),
    );
    expect(svg).toContain('data-chart-data-table="1"');
    // Categories appear on the axis and again in the table's header row.
    expect(svg.match(/>North<\/text>/g)).toHaveLength(2);
    expect(svg).toContain(">Costs</text>");
    expect(svg).toContain('data-chart-table-key="1"');
  });
});

describe("custom error bar amounts", () => {
  const custom = {
    type: "both",
    valueType: "cust",
    plus: [1, 2, 0.5],
    minus: [0.5, null, 1],
  };
  const column = (bars) => ({
    kind: "column",
    categories: ["A", "B", "C"],
    series: [
      { name: "S1", values: [3, 5, 4], errorBars: bars },
      { name: "Spread", values: [1, 2, 0.5] },
    ],
  });
  it("round-trips literal amounts and data-sheet ranges", () => {
    expect(roundTrip(column(custom)).series[0].errorBars).toEqual(custom);
    const ranged = {
      ...custom,
      plusRef: "Sheet1!$C$2:$C$4",
      minusRef: "Sheet1!$C$2:$C$4",
      minus: [1, 2, 0.5],
    };
    const xml = serializeXml(buildChartSpaceDoc(column(ranged)));
    expect(xml).toContain("<c:plus><c:numRef><c:f>Sheet1!$C$2:$C$4</c:f>");
    expect(roundTrip(column(ranged)).series[0].errorBars).toEqual(ranged);
    const plusOnly = { type: "plus", valueType: "cust", plus: [1, 1, 1] };
    const only = serializeXml(buildChartSpaceDoc(column(plusOnly)));
    expect(only).toContain("<c:plus>");
    expect(only).not.toContain("<c:minus>");
  });
  it("draws each point's own amounts", () => {
    const svg = svgOf(deck(column(custom)));
    const d = /data-chart-error-bars="y" d="([^"]+)"/.exec(svg)[1];
    // Two segments for A and C, one (plus only) for B; each with a cap.
    expect(d.match(/V/g)).toHaveLength(5);
  });
  it("survives saving", async () => {
    const f = deck(column(custom));
    const saved = await P.loadPresentation(await P.savePresentation(f.p));
    expect(P.validatePresentation(saved)).toEqual([]);
    expect(
      P.getSlideCharts(P.getSlides(saved)[0])[0].spec.series[0].errorBars,
    ).toEqual(custom);
  });
  it("reads amounts typed or taken from a range of the data sheet", () => {
    const spec = column(custom);
    expect(normalizeSheetRange("c2:C4")).toBe("Sheet1!$C$2:$C$4");
    expect(normalizeSheetRange("B2:C4")).toBeNull();
    expect(parseErrorAmounts("1, 2.5; 3", spec)).toEqual({
      values: [1, 2.5, 3],
    });
    expect(parseErrorAmounts("1, x", spec)).toBeNull();
    expect(parseErrorAmounts("=Sheet1!$C$2:$C$4", spec)).toEqual({
      values: [1, 2, 0.5],
      ref: "Sheet1!$C$2:$C$4",
    });
    // Editing the data sheet updates amounts that come from it.
    const linked = column({
      type: "both",
      valueType: "cust",
      plus: [1, 2, 0.5],
      plusRef: "Sheet1!$C$2:$C$4",
    });
    const grid = specToGrid(linked);
    grid[2][2] = "7";
    expect(gridToSpec(grid, linked).series[0].errorBars.plus).toEqual([
      1, 7, 0.5,
    ]);
  });
});
