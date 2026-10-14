// Chart features a chart editor offers each reach the slide preview.
import { describe, expect, it } from "vitest";
import { P, createDeck, preview } from "../src/model.js";

const categories = ["Q1", "Q2", "Q3", "Q4"];
const series = [
  { name: "Alpha", values: [4, 7, 5, 8] },
  { name: "Beta", values: [3, 2, 6, 4] },
];
const render = (spec) => {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0];
  P.addSlideChart(slide, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(7),
    h: P.inches(4),
    spec: { categories, series, ...spec },
  });
  return decodeURIComponent(preview(p, slide));
};
const textX = (svg, text) =>
  Number(svg.match(new RegExp(`<text x="([\\d.]+)"[^>]*>${text}</text>`))?.[1]);
const textY = (svg, text) =>
  Number(
    svg.match(
      new RegExp(`<text x="[\\d.]+" y="([\\d.]+)"[^>]*>${text}</text>`),
    )?.[1],
  );

describe("chart feature rendering", () => {
  it("draws the chart and axis titles", () => {
    const svg = render({
      kind: "column",
      title: "Revenue",
      valueAxisTitle: "Units",
      categoryAxisTitle: "Quarter",
    });
    for (const text of ["Revenue", "Units", "Quarter"])
      expect(svg).toContain(`>${text}<`);
  });

  it("places the legend on each side and hides it", () => {
    const at = {};
    for (const position of ["r", "t", "b", "l", "tr"]) {
      const svg = render({ kind: "column", legend: { position } });
      at[position] = [textX(svg, "Alpha"), textY(svg, "Alpha")];
      expect(at[position].every(Number.isFinite)).toBe(true);
    }
    expect(at.r[0]).toBeGreaterThan(at.l[0]);
    expect(at.b[1]).toBeGreaterThan(at.t[1]);
    const hidden = render({ kind: "column", legend: { position: null } });
    expect(hidden).not.toContain(">Alpha<");
  });

  it("draws data labels with values, categories and percentages", () => {
    const values = render({
      kind: "column",
      dataLabels: {
        showValue: true,
        showCategory: false,
        showSeriesName: false,
        showPercent: false,
      },
    });
    expect(values).toContain(">8<");
    const pie = render({
      kind: "pie",
      series: [series[0]],
      dataLabels: {
        showValue: false,
        showCategory: true,
        showSeriesName: false,
        showPercent: true,
      },
    });
    expect(pie).toMatch(/Q4[^<]*33%/);
  });

  it("adds gridlines for each axis switch", () => {
    const count = (svg) => (svg.match(/<line|<path/g) ?? []).length;
    const none = render({ kind: "column", valueAxisMajorGridlines: false });
    const major = render({ kind: "column", valueAxisMajorGridlines: true });
    const all = render({
      kind: "column",
      valueAxisMajorGridlines: true,
      valueAxisMinorGridlines: true,
      categoryAxisMajorGridlines: true,
    });
    expect(count(major)).toBeGreaterThan(count(none));
    expect(count(all)).toBeGreaterThan(count(major));
  });

  for (const type of ["linear", "exp", "log", "poly", "power", "movingAvg"])
    it(`draws a ${type} trendline`, () => {
      const plain = render({ kind: "line" });
      const svg = render({
        kind: "line",
        series: [
          {
            ...series[0],
            trendline: {
              type,
              ...(type === "poly" ? { order: 2 } : {}),
              ...(type === "movingAvg" ? { period: 2 } : {}),
              color: "#AA0000",
            },
          },
          series[1],
        ],
      });
      expect(svg.length).toBeGreaterThan(plain.length);
      expect(svg).toMatch(/stroke="#AA0000"/i);
    });

  for (const kind of ["column", "bar", "line", "area"])
    for (const grouping of ["stacked", "percentStacked"])
      it(`draws ${grouping} ${kind}`, () => {
        const svg = render({ kind, grouping });
        if (grouping === "percentStacked") expect(svg).toContain(">100%<");
        else expect(svg).toContain(">12<");
      });

  it("draws combo charts on two axes", () => {
    const svg = render({
      kind: "column",
      series: [
        series[0],
        {
          name: "Rate",
          values: [40, 70, 55, 90],
          chartKind: "line",
          secondaryAxis: true,
        },
      ],
    });
    expect(svg).toContain(">100<");
    expect(svg).toMatch(/<path[^>]*fill="none"/);
  });

  it("honors the doughnut hole size", () => {
    const one = (holeSizePct) =>
      render({ kind: "doughnut", series: [series[0]], holeSizePct });
    expect(one(10)).not.toEqual(one(80));
    expect(one(80)).toEqual(one(80));
  });

  it("hides either axis", () => {
    const shown = render({ kind: "column" });
    expect(shown).toContain(">Q1<");
    expect(render({ kind: "column", categoryAxisHidden: true })).not.toContain(
      ">Q1<",
    );
    const hiddenValues = render({ kind: "column", valueAxisHidden: true });
    expect(shown).toContain(">8<");
    expect(hiddenValues).not.toMatch(/>8</);
  });
});
