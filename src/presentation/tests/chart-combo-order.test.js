import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";

const add = (spec) => {
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
const categories = ["A", "B", "C"];

describe("combo chart series order", () => {
  it("keeps the authored series order when the base kind leads", async () => {
    const spec = {
      kind: "column",
      categories,
      series: [
        { name: "Bars", values: [1, 2, 3] },
        { name: "Line 1", values: [3, 2, 1], chartKind: "line" },
        {
          name: "Line 2",
          values: [2, 2, 2],
          chartKind: "line",
          secondaryAxis: true,
        },
      ],
    };
    const f = add(spec);
    expect(P.getShapeChartSpec(f.shape)).toMatchObject(spec);
    const saved = await P.loadPresentation(await P.savePresentation(f.p));
    expect(P.getSlideCharts(P.getSlides(saved)[0])[0].spec).toMatchObject(spec);
  });

  it("reads a combo back with its first series' kind as the base kind", () => {
    const f = add({
      kind: "column",
      categories,
      series: [
        { name: "Area 1", values: [1, 2, 3], chartKind: "area" },
        { name: "Area 2", values: [2, 3, 4], chartKind: "area" },
        { name: "Bars", values: [3, 1, 2] },
      ],
    });
    const read = P.getShapeChartSpec(f.shape);
    expect(read.kind).toBe("area");
    expect(read.series.map((s) => [s.name, s.chartKind])).toEqual([
      ["Area 1", undefined],
      ["Area 2", undefined],
      ["Bars", "column"],
    ]);
  });
});
