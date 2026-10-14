import { describe, expect, it } from "vitest";
import { P, preview } from "../src/model.js";
import { chartSeriesOutlineDeck } from "./chart-copy-fixture.js";
import {
  convertChart,
  gridToSpec,
  sampleSpec,
  specToGrid,
  switchRowColumn,
} from "../src/charts/chart-data.js";

const bars = (svg, fill) =>
  [...svg.matchAll(/<rect clip-path="[^"]*"[^>]*>/g)]
    .map((m) => m[0])
    .filter((r) => r.includes(`fill="${fill}"`));
const svgOf = (pres, slide) =>
  decodeURIComponent(preview(pres, slide).split(",").slice(1).join(","));

describe("negative bars", () => {
  it("an omitted invertIfNegative draws a negative bar inverted, an explicit false in the series fill", () => {
    const { p, slide } = chartSeriesOutlineDeck();
    // The outline decks set false: every bar, the negative one included,
    // keeps its fill and outline.
    expect(bars(svgOf(p, slide), "#23916F")).toHaveLength(6);
    expect(bars(svgOf(p, slide), "#FFFFFF")).toHaveLength(0);
    for (const chart of P.getSlideCharts(slide))
      P.setChartSpec(chart, {
        ...chart.spec,
        series: chart.spec.series.map(({ invertIfNegative, ...s }) => s),
      });
    // Omission is the native "inverted" default.
    expect(bars(svgOf(p, slide), "#23916F")).toHaveLength(4);
    expect(bars(svgOf(p, slide), "#FFFFFF")).toHaveLength(2);
  });

  it("bars the chart tools make are not inverted, and existing bars keep their setting", () => {
    expect(
      sampleSpec("column-clustered").series.every(
        (s) => s.invertIfNegative === false,
      ),
    ).toBe(true);
    const line = sampleSpec("line-markers");
    expect(line.series.every((s) => s.invertIfNegative === undefined)).toBe(
      true,
    );
    expect(
      convertChart(line, "bar-stacked").series.every(
        (s) => s.invertIfNegative === false,
      ),
    ).toBe(true);
    // An imported bar series with no setting keeps none through edits.
    const imported = {
      ...sampleSpec("column-clustered"),
      series: sampleSpec("column-clustered").series.map(
        ({ invertIfNegative, ...s }) => s,
      ),
    };
    expect(
      convertChart(imported, "column-stacked").series[0].invertIfNegative,
    ).toBeUndefined();
    const grid = specToGrid(imported);
    grid[0].push("Series 4");
    grid[1].push("-1");
    const next = gridToSpec(grid, imported);
    expect(next.series[0].invertIfNegative).toBeUndefined();
    expect(next.series[3].invertIfNegative).toBe(false);
    expect(switchRowColumn(imported).series[3].invertIfNegative).toBe(false);
  });
});
