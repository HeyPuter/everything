import { describe, expect, it } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import { buildChartSpaceDoc } from "../lib/pptx/src/internal/chartml/chart-builder.ts";
import { readChartSpec } from "../lib/pptx/src/internal/chartml/chart-reader.ts";
import {
  NS,
  firstChildElement,
  parseXml,
  qname,
  serializeXml,
} from "../lib/pptx/src/internal/xml/index.ts";

const c = (name) => qname("c", name, NS.chart);
const roundTrip = (spec) =>
  readChartSpec(parseXml(serializeXml(buildChartSpaceDoc(spec))).root);
const base = (kind = "column", extra = {}) => ({
  kind,
  categories: ["North", "South", "East"],
  series: [
    { name: "Plan", values: [4, 6, 5] },
    { name: "Actual", values: [5, 4.5, 7] },
  ],
  ...extra,
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
const svgOf = (p, slide) => decodeURIComponent(preview(p, slide));

describe("chart data table", () => {
  it("writes c:dTable after the axes and before the plot paint", () => {
    const root = buildChartSpaceDoc(
      base("column", {
        dataTable: { showHorzBorder: true, showKeys: true },
        plotAreaFill: "#FFFFFF",
      }),
    ).root;
    const area = firstChildElement(
      firstChildElement(root, c("chart")),
      c("plotArea"),
    );
    const names = area.children
      .filter((n) => n.kind === "element")
      .map((n) => n.name.localName);
    expect(names).toEqual([
      "layout",
      "barChart",
      "catAx",
      "valAx",
      "dTable",
      "spPr",
    ]);
    const table = firstChildElement(area, c("dTable"));
    expect(
      table.children
        .filter((n) => n.kind === "element")
        .map((n) => n.name.localName),
    ).toEqual(["showHorzBorder", "showKeys"]);
  });

  for (const kind of ["column", "bar", "line", "area"])
    it(`${kind} round-trips each flag`, () => {
      const dataTable = {
        showHorzBorder: true,
        showVertBorder: false,
        showOutline: true,
        showKeys: true,
      };
      expect(roundTrip(base(kind, { dataTable })).dataTable).toEqual(dataTable);
    });

  it("charts without categories on axes write no table", () => {
    for (const kind of ["pie", "doughnut", "radar"]) {
      const spec = base(kind, {
        dataTable: { showKeys: true },
        series: [{ name: "Plan", values: [4, 6, 5] }],
      });
      expect(roundTrip(spec).dataTable).toBeUndefined();
    }
  });

  it("setChartSpec adds and removes the table and keeps it through save", async () => {
    const f = deck(base());
    const chart = () => P.getSlideCharts(f.slide)[0];
    P.setChartSpec(chart(), {
      ...chart().spec,
      dataTable: { showOutline: true, showKeys: true },
    });
    expect(P.getShapeChartSpec(f.shape).dataTable).toEqual({
      showOutline: true,
      showKeys: true,
    });
    const saved = await P.loadPresentation(await P.savePresentation(f.p));
    expect(P.validatePresentation(saved)).toEqual([]);
    expect(P.getSlideCharts(P.getSlides(saved)[0])[0].spec.dataTable).toEqual({
      showOutline: true,
      showKeys: true,
    });
    const { dataTable, ...rest } = chart().spec;
    void dataTable;
    P.setChartSpec(chart(), rest);
    expect(P.getShapeChartSpec(f.shape).dataTable).toBeUndefined();
  });

  it("renders the table under the plot in place of the category labels", () => {
    const plain = deck(base());
    const plainSvg = svgOf(plain.p, plain.slide);
    expect(plainSvg).toContain(">North<");
    expect(plainSvg).not.toContain("data-chart-data-table");
    const f = deck(
      base("column", {
        dataTable: {
          showHorzBorder: true,
          showVertBorder: true,
          showOutline: true,
          showKeys: true,
        },
      }),
    );
    const svg = svgOf(f.p, f.slide);
    const table = svg.match(/<g data-chart-data-table="1">(.*?)<\/g>/)?.[1];
    expect(table).toBeTruthy();
    for (const text of ["North", "South", "East", "Plan", "Actual", "4.5", "7"])
      expect(table).toContain(`>${text}<`);
    expect(table.match(/data-chart-table-key/g)).toHaveLength(2);
    // The category names appear once: in the table, not as tick labels.
    expect(svg.match(/>North</g)).toHaveLength(1);
  });

  it("line tables key their series with a line", () => {
    const f = deck(base("line", { dataTable: { showKeys: true } }));
    expect(svgOf(f.p, f.slide)).toMatch(/<line data-chart-table-key="0"/);
  });
});
