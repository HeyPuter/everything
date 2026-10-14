import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { P, createDeck, preview } from "../src/model.js";
import { buildChartSpaceDoc } from "../lib/pptx/src/internal/chartml/chart-builder.ts";
import { readChartSpec } from "../lib/pptx/src/internal/chartml/chart-reader.ts";
import {
  NS,
  allChildElements,
  firstChildElement,
  getAttrValue,
  parseXml,
  qname,
  serializeXml,
} from "../lib/pptx/src/internal/xml/index.ts";
import { chartRoot, workbook } from "./chart-copy-fixture.js";

const c = (name) => qname("c", name, NS.chart);
const val = qname("", "val", "");
const roundTrip = (spec) =>
  readChartSpec(parseXml(serializeXml(buildChartSpaceDoc(spec))).root);

const scatter = (extra = {}) => ({
  kind: "scatter",
  categories: [],
  scatterStyle: "marker",
  series: [
    { name: "Height", xValues: [1, 2, 3, 4], values: [2.5, 3, 4.25, 5] },
    { name: "Weight", xValues: [1, 2, 3, 4], values: [1, 1.5, null, 3] },
  ],
  ...extra,
});
const bubble = (extra = {}) => ({
  kind: "bubble",
  categories: [],
  series: [
    {
      name: "Region A",
      xValues: [1, 2, 3],
      values: [10, 20, 15],
      bubbleSizes: [4, 9, 16],
    },
    {
      name: "Region B",
      xValues: [1.5, 2.5],
      values: [12, 8],
      bubbleSizes: [2, 5],
    },
  ],
  ...extra,
});
const radar = (extra = {}) => ({
  kind: "radar",
  categories: ["Speed", "Range", "Cost", "Comfort", "Safety"],
  radarStyle: "marker",
  series: [
    { name: "Model 1", values: [4, 3, 5, 2, 4] },
    { name: "Model 2", values: [2, 5, 3, 4, 3] },
  ],
  ...extra,
});

function deck(spec) {
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
}
const chartXml = (f) =>
  parseXml(
    new TextDecoder().decode(
      P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data,
    ),
  ).root;
const sheetXml = (f) =>
  strFromU8(unzipSync(workbook(f.p, f.shape).data)["xl/worksheets/sheet1.xml"]);
const formulas = (root) => {
  const out = [];
  const visit = (el) => {
    for (const n of el.children)
      if (n.kind === "element") {
        if (n.name.localName === "f")
          out.push(n.children.map((t) => t.data).join(""));
        visit(n);
      }
  };
  visit(root);
  return out;
};

describe("XY and radar chart authoring", () => {
  for (const style of [
    "marker",
    "lineMarker",
    "line",
    "smooth",
    "smoothMarker",
    "none",
  ])
    it(`scatter ${style} round-trips the authored spec`, () => {
      const spec = scatter({ scatterStyle: style });
      expect(roundTrip(spec)).toMatchObject(spec);
      const read = roundTrip(spec);
      for (const series of read.series) {
        expect(series.lineColor).not.toBe(null);
        expect(series).not.toHaveProperty("markerSymbol");
        expect(series).not.toHaveProperty("smooth");
      }
    });

  it("scatter series spell the hidden line and markers for other editors", () => {
    const marker = buildChartSpaceDoc(scatter()).root;
    const ser = allChildElements(
      firstChildElement(
        firstChildElement(firstChildElement(marker, c("chart")), c("plotArea")),
        c("scatterChart"),
      ),
      c("ser"),
    )[0];
    const ln = firstChildElement(
      firstChildElement(ser, c("spPr")),
      qname("a", "ln", NS.dml),
    );
    expect(firstChildElement(ln, qname("a", "noFill", NS.dml))).not.toBeNull();
    const line = buildChartSpaceDoc(scatter({ scatterStyle: "smooth" })).root;
    const lineSer = allChildElements(
      firstChildElement(
        firstChildElement(firstChildElement(line, c("chart")), c("plotArea")),
        c("scatterChart"),
      ),
      c("ser"),
    )[0];
    const symbol = firstChildElement(
      firstChildElement(lineSer, c("marker")),
      c("symbol"),
    );
    expect(getAttrValue(symbol, val)).toBe("none");
    expect(getAttrValue(firstChildElement(lineSer, c("smooth")), val)).toBe(
      "1",
    );
  });

  it("explicit series formatting still wins over the style", () => {
    const spec = scatter({
      scatterStyle: "marker",
      series: [
        {
          name: "A",
          xValues: [1, 2],
          values: [3, 4],
          lineColor: "#112233",
          markerSymbol: "diamond",
        },
      ],
    });
    expect(roundTrip(spec).series[0]).toMatchObject({
      lineColor: "#112233",
      markerSymbol: "diamond",
    });
  });

  it("bubble round-trips sizes, scale and size meaning", () => {
    const spec = bubble({ bubbleScale: 150, bubbleSizeRepresents: "width" });
    expect(roundTrip(spec)).toMatchObject(spec);
  });

  for (const style of ["standard", "marker", "filled"])
    it(`radar ${style} round-trips`, () => {
      const spec = radar({ radarStyle: style });
      const read = roundTrip(spec);
      expect(read).toMatchObject(spec);
      for (const series of read.series)
        expect(series).not.toHaveProperty("markerSymbol");
    });

  it("scatter workbook shares one X column when the series agree", () => {
    const f = deck(scatter());
    const sheet = sheetXml(f);
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t>X</t></is></c>');
    expect(sheet).toContain("<t>Height</t>");
    expect(sheet).toContain("<t>Weight</t>");
    expect(sheet).toContain('<c r="A5"><v>4</v></c>');
    expect(sheet).toContain('<c r="C3"><v>1.5</v></c>');
    expect(sheet).not.toContain('r="C4"');
    expect(formulas(chartXml(f))).toEqual([
      "Sheet1!$B$1",
      "Sheet1!$A$2:$A$5",
      "Sheet1!$B$2:$B$5",
      "Sheet1!$C$1",
      "Sheet1!$A$2:$A$5",
      "Sheet1!$C$2:$C$5",
    ]);
  });

  it("bubble workbook gives each series its own X, Y and size columns", () => {
    const f = deck(bubble());
    expect(formulas(chartXml(f))).toEqual([
      "Sheet1!$B$1",
      "Sheet1!$A$2:$A$4",
      "Sheet1!$B$2:$B$4",
      "Sheet1!$C$2:$C$4",
      "Sheet1!$E$1",
      "Sheet1!$D$2:$D$3",
      "Sheet1!$E$2:$E$3",
      "Sheet1!$F$2:$F$3",
    ]);
    const sheet = sheetXml(f);
    expect(sheet).toContain("<t>Region A size</t>");
    expect(sheet).toContain('<c r="F3"><v>5</v></c>');
  });

  it("radar keeps the categorical sheet layout", () => {
    const f = deck(radar());
    expect(sheetXml(f)).toContain("<t>Comfort</t>");
    expect(formulas(chartXml(f))[1]).toBe("Sheet1!$A$2:$A$6");
  });

  it("setChartSpec edits XY data and rewrites the workbook", () => {
    const f = deck(scatter());
    const chart = P.getSlideCharts(f.slide)[0];
    const next = scatter({
      scatterStyle: "lineMarker",
      series: [{ name: "Only", xValues: [5, 6, 7], values: [9, 8, 7] }],
    });
    P.setChartSpec(chart, next);
    expect(P.getShapeChartSpec(f.shape)).toMatchObject(next);
    expect(sheetXml(f)).toContain("<t>Only</t>");
    expect(sheetXml(f)).toContain('<c r="A4"><v>7</v></c>');
    expect(sheetXml(f)).not.toContain("Weight");
  });

  for (const [from, to] of [
    ["column", "scatter"],
    ["scatter", "line"],
    ["line", "bubble"],
    ["bubble", "radar"],
    ["radar", "column"],
    ["scatter", "bubble"],
  ])
    it(`setChartSpec changes ${from} into ${to}`, async () => {
      const specs = {
        column: {
          kind: "column",
          categories: ["Q1", "Q2", "Q3"],
          series: [{ name: "Sales", values: [3, 5, 4] }],
        },
        line: {
          kind: "line",
          categories: ["Q1", "Q2"],
          series: [{ name: "Trend", values: [1, 2] }],
        },
        scatter: scatter(),
        bubble: bubble(),
        radar: radar(),
      };
      const f = deck(specs[from]);
      P.setChartSpec(P.getSlideCharts(f.slide)[0], specs[to]);
      expect(P.getShapeChartSpec(f.shape)).toMatchObject(specs[to]);
      const names = specs[to].series.map((s) => s.name);
      for (const name of names) expect(sheetXml(f)).toContain(name);
      const saved = await P.loadPresentation(await P.savePresentation(f.p));
      const [chart] = P.getSlideCharts(P.getSlides(saved)[0]);
      expect(chart.spec).toMatchObject(specs[to]);
      expect(P.validatePresentation(saved)).toEqual([]);
    });

  for (const spec of [scatter(), bubble(), radar()])
    it(`${spec.kind} survives save, reload and renders`, async () => {
      const f = deck(spec);
      const saved = await P.loadPresentation(await P.savePresentation(f.p));
      expect(P.validatePresentation(saved)).toEqual([]);
      const slide = P.getSlides(saved)[0];
      expect(P.getSlideCharts(slide)[0].spec).toMatchObject(spec);
      const svg = decodeURIComponent(preview(saved, slide));
      expect(svg).toMatch(/<svg/);
      expect(svg.length).toBeGreaterThan(2000);
    });
});
