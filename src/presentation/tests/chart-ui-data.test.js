import { describe, expect, it } from "vitest";
import { P, createDeck, parseDeck } from "../src/model.js";
import {
  CHART_TYPES,
  canSwitchRowColumn,
  comboSpec,
  convertChart,
  deleteColumn,
  deleteRow,
  deleteSeriesColumn,
  detectChartType,
  gridToSpec,
  insertColumn,
  insertRow,
  insertSeriesColumn,
  parseTsv,
  pasteBlock,
  sampleSpec,
  specToGrid,
  switchRowColumn,
  toTsv,
} from "../src/charts/chart-data.js";

const CATEGORY_TYPES = CHART_TYPES.filter((t) => !t.custom);

async function roundTrip(spec) {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  P.addSlideChart(slide, {
    spec,
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(6),
    h: P.inches(4),
  });
  const bytes = await P.savePresentation(pres);
  const back = await parseDeck(bytes);
  const shape = P.getSlideShapes(P.getSlides(back.pres ?? back)[0]).find((s) =>
    P.isChartShape(s),
  );
  return P.getShapeChartSpec(shape);
}

describe("chart catalogue", () => {
  it("detects each sample as its own type", () => {
    for (const type of CHART_TYPES) {
      if (type.custom) continue;
      expect(detectChartType(sampleSpec(type.id)), type.id).toBe(type.id);
    }
  });

  it("builds and reads back every category type", async () => {
    for (const type of CATEGORY_TYPES) {
      const spec = sampleSpec(type.id);
      const read = await roundTrip(spec);
      expect(read, type.id).not.toBeNull();
      expect(detectChartType(read), type.id).toBe(type.id);
      expect(read.series[0].values).toEqual(spec.series[0].values);
    }
  });

  it("converts between types keeping data and series formatting", () => {
    const column = {
      ...sampleSpec("column-clustered"),
      series: sampleSpec("column-clustered").series.map((s, i) =>
        i === 0 ? { ...s, color: "#112233" } : s,
      ),
    };
    const line = convertChart(column, "line-markers");
    expect(line.kind).toBe("line");
    expect(line.series[0].color).toBe("#112233");
    expect(line.categories).toEqual(column.categories);
    const pie = convertChart(line, "pie");
    expect(pie.series).toHaveLength(1);
    expect(pie.grouping).toBeUndefined();
    const scatter = convertChart(column, "scatter");
    expect(scatter.kind).toBe("scatter");
    expect(scatter.series[0].xValues).toEqual([1, 2, 3, 4]);
    expect(scatter.categories).toEqual([]);
    const back = convertChart(scatter, "column-stacked");
    expect(back.categories).toEqual(["1", "2", "3", "4"]);
    expect(back.series[0].xValues).toBeUndefined();
    expect(back.grouping).toBe("stacked");
  });

  it("makes custom combinations by series", () => {
    const spec = comboSpec(sampleSpec("column-clustered"), [
      { kind: "column" },
      { kind: "line", secondary: true },
      { kind: "area" },
    ]);
    expect(spec.kind).toBe("column");
    expect(spec.series.map((s) => s.chartKind ?? null)).toEqual([
      null,
      "line",
      "area",
    ]);
    expect(spec.series[1].secondaryAxis).toBe(true);
    expect(detectChartType(spec)).toBe("combo-custom");
  });
});

describe("data sheet grid", () => {
  it("round-trips category data through the grid", () => {
    const spec = sampleSpec("column-clustered");
    const grid = specToGrid(spec);
    expect(grid[0]).toEqual(["", "Series 1", "Series 2", "Series 3"]);
    expect(grid[1][0]).toBe("Category 1");
    expect(gridToSpec(grid, spec)).toEqual(spec);
  });

  it("adds and removes rows, columns and series", () => {
    const spec = sampleSpec("column-clustered");
    let grid = insertRow(specToGrid(spec), 5);
    grid[5] = ["Category 5", "1", "2", "3"];
    grid = insertColumn(grid, 4);
    grid[0][4] = "Series 4";
    grid[1][4] = "7";
    let next = gridToSpec(grid, spec);
    expect(next.categories).toHaveLength(5);
    expect(next.series).toHaveLength(4);
    expect(next.series[3].values).toEqual([7, null, null, null, null]);
    next = gridToSpec(deleteColumn(deleteRow(grid, 1), 1), spec);
    expect(next.categories[0]).toBe("Category 2");
    expect(next.series[0].name).toBe("Series 2");
  });

  it("adds and deletes a series column keeping the others' formatting", () => {
    const sample = sampleSpec("column-clustered");
    const colors = ["#C00000", "#00B050", "#0070C0"];
    const spec = {
      ...sample,
      series: sample.series.map((s, i) => ({ ...s, color: colors[i] })),
    };
    let { grid, spec: prior } = deleteSeriesColumn(specToGrid(spec), spec, 1);
    let next = gridToSpec(grid, prior);
    expect(next.series.map((s) => [s.name, s.color])).toEqual([
      ["Series 2", "#00B050"],
      ["Series 3", "#0070C0"],
    ]);
    ({ grid, spec: prior } = insertSeriesColumn(specToGrid(spec), spec, 2));
    next = gridToSpec(grid, prior);
    expect(next.series.map((s) => s.color)).toEqual([
      "#C00000",
      undefined,
      "#00B050",
      "#0070C0",
    ]);
    expect(next.series[2].values).toEqual(spec.series[1].values);
  });

  it("adds and deletes a bubble series with its size column", () => {
    const spec = sampleSpec("bubble");
    let { grid, spec: prior } = insertSeriesColumn(specToGrid(spec), spec, 2);
    expect(grid[0]).toHaveLength(5);
    grid[0][1] = "New";
    grid[1][1] = "5";
    grid[1][2] = "3";
    const next = gridToSpec(grid, prior);
    expect(next.series.map((s) => s.name)).toEqual(["New", "Y Values"]);
    expect(next.series[0].bubbleSizes[0]).toBe(3);
    expect(next.series[1]).toMatchObject({
      values: spec.series[0].values,
      bubbleSizes: spec.series[0].bubbleSizes,
    });
    ({ grid, spec: prior } = deleteSeriesColumn(grid, next, 1));
    expect(gridToSpec(grid, prior).series).toEqual([
      expect.objectContaining({
        name: "Y Values",
        values: spec.series[0].values,
        bubbleSizes: spec.series[0].bubbleSizes,
      }),
    ]);
    // The last series stays.
    expect(deleteSeriesColumn(grid, prior, 2).grid).toBe(grid);
  });

  it("pastes tab-separated blocks and grows the grid", () => {
    const rows = parseTsv('a\tb\n"x\ty"\t2\r\n3\t4\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x\ty", "2"],
      ["3", "4"],
    ]);
    expect(parseTsv(toTsv(rows))).toEqual(rows);
    const grid = pasteBlock([["", "S"]], 1, 0, [
      ["Q1", "5", "6"],
      ["Q2", "7", "8"],
    ]);
    expect(grid).toEqual([
      ["", "S", ""],
      ["Q1", "5", "6"],
      ["Q2", "7", "8"],
    ]);
    const spec = gridToSpec(grid, sampleSpec("column-clustered"));
    expect(spec.series.map((s) => s.name)).toEqual(["S", "Series 2"]);
    expect(spec.series[1].values).toEqual([6, 8]);
  });

  it("lays out x/y and bubble data in columns", () => {
    const xy = sampleSpec("scatter");
    const grid = specToGrid(xy);
    expect(grid[0]).toEqual(["X Values", "Y Values"]);
    expect(gridToSpec(grid, xy).series[0].xValues).toEqual(
      xy.series[0].xValues,
    );
    const bubble = sampleSpec("bubble");
    const bgrid = specToGrid(bubble);
    expect(bgrid[0]).toEqual(["X Values", "Y Values", "Size"]);
    expect(gridToSpec(bgrid, bubble).series[0].bubbleSizes).toEqual([10, 4, 8]);
  });

  it("switches rows and columns", () => {
    const spec = sampleSpec("column-clustered");
    const switched = switchRowColumn(spec);
    expect(switched.categories).toEqual(["Series 1", "Series 2", "Series 3"]);
    expect(switched.series).toHaveLength(4);
    expect(switched.series[0].name).toBe("Category 1");
    expect(switched.series[0].values).toEqual([4.1, 2.2, 1.8]);
    expect(switchRowColumn(switched).series[0].values).toEqual(
      spec.series[0].values,
    );
  });

  it("leaves a pie's data alone instead of switching it away", () => {
    const pie = sampleSpec("pie");
    expect(canSwitchRowColumn("pie")).toBe(false);
    expect(canSwitchRowColumn("doughnut")).toBe(true);
    expect(switchRowColumn(pie)).toEqual(pie);
    expect(switchRowColumn(switchRowColumn(pie)).series[0].values).toEqual(
      pie.series[0].values,
    );
  });
});
