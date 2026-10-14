import { describe, it, expect } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import {
  chartMarkerPaintDeck,
  chartLineMarkersDeck,
  chartRoot,
  workbook,
} from "./chart-copy-fixture.js";
import {
  NS,
  parseXml,
  serializeXml,
  walkElements,
  firstChildElement,
  allChildElements,
  qname,
  getAttrValue,
} from "../lib/pptx/src/internal/xml/index.ts";
const child = (e, n) => firstChildElement(e, qname("c", n, NS.chart)),
  a = (e, n) => firstChildElement(e, qname("a", n, NS.dml)),
  attr = (e, n) => getAttrValue(e, qname("", n, ""));
function xml(f) {
  return parseXml(
    new TextDecoder().decode(
      P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data,
    ),
  );
}
function markers(f, doc = xml(f)) {
  const area = child(child(doc.root, "chart"), "plotArea"),
    group = area.children.find(
      (e) => e.kind === "element" && e.name.localName.endsWith("Chart"),
    );
  return allChildElements(group, qname("c", "ser", NS.chart)).map((s) =>
    child(s, "marker"),
  );
}
function changeXml(f, change) {
  const doc = xml(f);
  change(doc);
  P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data =
    new TextEncoder().encode(serializeXml(doc));
}
function render(f) {
  const svg = decodeURIComponent(
      preview(f.p, f.slide).split(",").slice(1).join(","),
    ),
    nodes = [];
  walkElements(parseXml(svg).root, (e) => nodes.push(e));
  return {
    svg,
    nodes,
    marks: nodes.filter(
      (e) =>
        ["circle", "rect", "polygon"].includes(e.name.localName) &&
        ["#EA7423", "#349185", "#CC3344"].includes(attr(e, "stroke")),
    ),
  };
}
const fields = (s) => [
  s.markerSymbol,
  s.markerSizePt,
  s.markerFill,
  s.markerStrokeColor,
  s.markerStrokeWidthEmu,
];
const canonical = (e) => [
  e.name.namespaceURI,
  e.name.localName,
  e.attrs.map((a) => [a.name.namespaceURI, a.name.localName, a.value]).sort(),
  e.children.map((n) =>
    n.kind === "element" ? canonical(n) : [n.kind, n.data],
  ),
];
function neutral(e, field) {
  const copy = structuredClone(e),
    line = a(copy, "ln");
  if (field === "markerFill")
    copy.children = copy.children.filter(
      (e) =>
        e.kind !== "element" ||
        !["solidFill", "noFill", "gradFill"].includes(e.name.localName),
    );
  if (field === "markerStrokeColor")
    line.children = line.children.filter(
      (e) =>
        e.kind !== "element" ||
        !["solidFill", "noFill", "gradFill"].includes(e.name.localName),
    );
  if (field === "markerStrokeWidthEmu")
    line.attrs = line.attrs.filter((a) => a.name.localName !== "w");
  return canonical(copy);
}
describe("independent chart marker paint and point units", () => {
  for (const kind of ["line", "scatter", "radar"]) {
    it(`${kind} imports and paints marker fill, hollow fill, independent outline and EMU width on plot and legend`, () => {
      const f = chartMarkerPaintDeck(kind),
        spec = P.getShapeChartSpec(f.shape),
        r = render(f);
      expect(spec.kind).toBe(kind);
      expect(spec.series.map(fields)).toEqual([
        ["circle", 6, "#116699", "#EA7423", 9525],
        ["square", 12, "#D9B231", "#349185", 19050],
        ["diamond", 24, null, "#CC3344", 38100],
      ]);
      // Three points per series plus their three legend keys share marker paint.
      expect(r.marks).toHaveLength(12);
      for (const [i, color] of ["#EA7423", "#349185", "#CC3344"].entries())
        for (const node of r.marks.filter((e) => attr(e, "stroke") === color)) {
          expect(attr(node, "fill")).toBe(["#116699", "#D9B231", "none"][i]);
          expect(Number(attr(node, "stroke-width"))).toBe([1, 2, 4][i]);
        }
      const circles = r.marks.filter((e) => e.name.localName === "circle"),
        squares = r.marks.filter((e) => e.name.localName === "rect"),
        diamonds = r.marks.filter((e) => e.name.localName === "polygon");
      expect(circles.filter((e) => Number(attr(e, "r")) === 4)).toHaveLength(3);
      expect(
        squares.filter((e) => Number(attr(e, "width")) === 16),
      ).toHaveLength(3);
      expect(
        diamonds.filter((e) => {
          const xs = attr(e, "points")
            .split(" ")
            .map((p) => Number(p.split(",")[0]));
          // Points are written to two decimals.
          return Math.abs(Math.max(...xs) - Math.min(...xs) - 32) < 0.02;
        }),
      ).toHaveLength(3);
      expect(r.svg).not.toMatch(/NaN|Infinity/);
    });
    it(`${kind} export and transfer both ways retain native marker paint, data and independent workbooks`, async () => {
      const f = chartMarkerPaintDeck(kind),
        original = P.getShapeChartSpec(f.shape),
        book = workbook(f.p, f.shape).data.slice(),
        target = createDeck("blank");
      const imported = P.importSlide(
          target,
          f.slide,
          P.getSlideLayouts(target)[0],
        ),
        returned = P.importSlide(f.p, imported, P.getSlideLayout(f.slide));
      const p = await P.loadPresentation(await P.savePresentation(f.p)),
        slides = P.getSlides(p);
      for (const slide of slides) {
        const c = P.getSlideCharts(slide)[0];
        expect(c.spec).toEqual(original);
        expect(workbook(p, c.shape).data).toEqual(book);
        expect(render({ p, slide }).marks).toHaveLength(12);
      }
      expect(P.getSlideCharts(returned)[0].spec).toEqual(original);
      expect(P.validatePresentation(p)).toEqual([]);
    });
  }
  it("line marker data edits and copied style edits leave the original chart and workbook independent", async () => {
    const f = chartMarkerPaintDeck(),
      original = P.getShapeChartSpec(f.shape),
      before = markers(f).map(canonical),
      slide = P.importSlide(f.p, f.slide, P.getSlideLayout(f.slide)),
      chart = P.getSlideCharts(slide)[0];
    P.setChartSpec(chart, {
      ...chart.spec,
      series: chart.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 3),
      })),
    });
    expect(markers({ ...f, shape: chart.shape }).map(canonical)).toEqual(
      before,
    );
    P.setChartSpec(chart, {
      ...P.getShapeChartSpec(chart.shape),
      series: chart.spec.series.map((s) => ({
        ...s,
        markerFill: null,
        markerStrokeColor: "#276491",
        markerStrokeWidthEmu: 0,
        markerSizePt: 2,
      })),
    });
    expect(P.getShapeChartSpec(f.shape)).toEqual(original);
    const p = await P.loadPresentation(await P.savePresentation(f.p));
    expect(P.getSlideCharts(P.getSlides(p)[0])[0].spec).toEqual(original);
    expect(
      P.getSlideCharts(P.getSlides(p)[1])[0].spec.series.map(fields),
    ).toEqual([
      ["circle", 2, null, "#276491", 0],
      ["square", 2, null, "#276491", 0],
      ["diamond", 2, null, "#276491", 0],
    ]);
    expect(P.validatePresentation(p)).toEqual([]);
  });
  for (const [field, value] of [
    ["markerFill", null],
    ["markerFill", "#934A26"],
    ["markerFill", undefined],
    ["markerStrokeColor", null],
    ["markerStrokeColor", "#934A26"],
    ["markerStrokeColor", undefined],
    ["markerStrokeWidthEmu", 0],
    ["markerStrokeWidthEmu", 50800],
    ["markerStrokeWidthEmu", undefined],
  ])
    it(`${field}=${value} changes only its own paint component while retaining native effects, dash and caps`, () => {
      const f = chartMarkerPaintDeck();
      changeXml(f, (doc) => {
        const sp = child(markers(f, doc)[0], "spPr"),
          ln = a(sp, "ln");
        ln.attrs.push({ name: qname("", "cap", ""), value: "rnd" });
        ln.children.push(
          parseXml(`<a:prstDash xmlns:a="${NS.dml}" val="dash"/>`).root,
        );
        sp.children.push(
          parseXml(
            `<a:effectLst xmlns:a="${NS.dml}"><a:glow rad="12700"><a:srgbClr val="123456"/></a:glow></a:effectLst>`,
          ).root,
        );
      });
      const before = child(markers(f)[0], "spPr"),
        c = P.getSlideCharts(f.slide)[0];
      P.setChartSpec(c, {
        ...c.spec,
        series: c.spec.series.map((s, i) => (i ? s : { ...s, [field]: value })),
      });
      expect(P.getShapeChartSpec(f.shape).series[0][field]).toBe(value);
      expect(neutral(child(markers(f)[0], "spPr"), field)).toEqual(
        neutral(before, field),
      );
    });
  it("native theme marker paint resolves independently and stays native during value edits", () => {
    const f = chartMarkerPaintDeck();
    changeXml(f, (doc) => {
      const sp = child(markers(f, doc)[0], "spPr"),
        fill = a(sp, "solidFill");
      fill.children = [
        parseXml(
          `<a:schemeClr xmlns:a="${NS.dml}" val="accent2"><a:lumMod val="50000"/></a:schemeClr>`,
        ).root,
      ];
    });
    const before = markers(f).map(canonical),
      c = P.getSlideCharts(f.slide)[0];
    expect(c.spec.series[0].markerFill).toMatch(/^#[0-9A-F]{6}$/i);
    expect(c.spec.series[0].markerFill).not.toBe(c.spec.series[0].color);
    P.setChartSpec(c, {
      ...c.spec,
      series: c.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 1),
      })),
    });
    expect(markers(f).map(canonical)).toEqual(before);
  });
  it("opaque marker gradients remain intact until an explicit fill override, with other native properties retained", () => {
    const f = chartMarkerPaintDeck();
    changeXml(f, (doc) => {
      const sp = child(markers(f, doc)[0], "spPr");
      sp.children = sp.children.map((e) =>
        e === a(sp, "solidFill")
          ? parseXml(
              `<a:gradFill xmlns:a="${NS.dml}"><a:gsLst><a:gs pos="0"><a:srgbClr val="23854A"/></a:gs><a:gs pos="100000"><a:srgbClr val="DE8923"/></a:gs></a:gsLst><a:lin ang="7200000"/></a:gradFill>`,
            ).root
          : e,
      );
    });
    const before = markers(f).map(canonical),
      c = P.getSlideCharts(f.slide)[0];
    expect(c.spec.series[0].markerFill).toBeUndefined();
    P.setChartSpec(c, {
      ...c.spec,
      series: c.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 1),
      })),
    });
    expect(markers(f).map(canonical)).toEqual(before);
    const next = P.getShapeChartSpec(f.shape);
    P.setChartSpec(c, {
      ...next,
      series: next.series.map((s, i) =>
        i ? s : { ...s, markerFill: "#123456" },
      ),
    });
    expect(a(child(markers(f)[0], "spPr"), "gradFill")).toBeNull();
    expect(P.getShapeChartSpec(f.shape).series[0].markerFill).toBe("#123456");
  });
  for (const [token, expected] of [
    ["2", 2],
    ["72", 72],
    [" +12 ", 12],
    ["002", 2],
    ["1", undefined],
    ["73", undefined],
    ["12.5", undefined],
    ["12pt", undefined],
    ["1e1", undefined],
    ["", undefined],
    [null, 5],
    ["-2", undefined],
  ])
    it(`strictly reads ST_MarkerSize ${JSON.stringify(token)} without changing source bytes`, () => {
      const f = chartMarkerPaintDeck();
      changeXml(f, (doc) => {
        const size = child(markers(f, doc)[0], "size");
        size.attrs =
          token === null ? [] : [{ name: qname("", "val", ""), value: token }];
      });
      const bytes = P._internalPackageOf(f.p)
        .getPart(chartRoot(f.shape))
        .data.slice();
      expect(P.getShapeChartSpec(f.shape).series[0].markerSizePt).toBe(
        expected,
      );
      render(f);
      expect(
        P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data,
      ).toEqual(bytes);
    });
  for (const [field, invalid] of [
    ["markerSizePt", 1],
    ["markerSizePt", 73],
    ["markerSizePt", 4.5],
    ["markerSizePt", NaN],
    ["markerSizePt", Infinity],
    ["markerSizePt", "12"],
    ["markerStrokeWidthEmu", -1],
    ["markerStrokeWidthEmu", 20116801],
    ["markerStrokeWidthEmu", NaN],
    ["markerFill", "invalid"],
    ["markerStrokeColor", "red"],
  ])
    it(`rejects invalid ${field} ${invalid} atomically before changing native chart/workbook`, () => {
      const f = chartMarkerPaintDeck(),
        c = P.getSlideCharts(f.slide)[0],
        pkg = P._internalPackageOf(f.p),
        before = pkg.parts.map((p) => [p.name, p.data.slice()]);
      expect(() =>
        P.setChartSpec(c, {
          ...c.spec,
          series: c.spec.series.map((s, i) =>
            i ? s : { ...s, [field]: invalid },
          ),
        }),
      ).toThrow();
      expect(pkg.parts.map((p) => [p.name, p.data])).toEqual(before);
    });
  for (const markerSizePt of [2, 72])
    it(`authors boundary ${markerSizePt} points and converts at 96/72 without pixel clamping`, () => {
      const f = chartLineMarkersDeck({
        series: [
          {
            name: "Size",
            values: [1, 2, 3],
            markerSymbol: "circle",
            markerSizePt,
            markerFill: "#116699",
            markerStrokeColor: null,
          },
        ],
      });
      const r = render(f),
        nodes = r.nodes.filter(
          (e) => e.name.localName === "circle" && attr(e, "fill") === "#116699",
        );
      expect(nodes).toHaveLength(3);
      for (const e of nodes)
        expect(Number(attr(e, "r"))).toBeCloseTo(
          (markerSizePt * 96) / 72 / 2,
          1,
        );
    });
  for (const symbol of ["x", "plus", "dash"])
    for (const markerFill of ["#116699", null])
      it(`${symbol} keeps its native fill region independent of the cross or border`, () => {
        const f = chartLineMarkersDeck({
            series: [
              {
                name: "Glyph",
                values: [1, 2, 3],
                markerSymbol: symbol,
                markerFill,
                markerStrokeColor: "#EA7423",
                markerStrokeWidthEmu: 19050,
              },
            ],
          }),
          r = render(f);
        if (symbol === "dash") {
          const bodies = r.nodes.filter(
            (e) =>
              e.name.localName === "rect" && attr(e, "stroke") === "#EA7423",
          );
          expect(bodies).toHaveLength(3);
          for (const body of bodies) {
            expect(attr(body, "fill")).toBe(markerFill ?? "none");
            expect(Number(attr(body, "stroke-width"))).toBe(2);
          }
        } else {
          const crosses = r.nodes.filter(
            (e) => e.name.localName === "g" && attr(e, "stroke") === "#EA7423",
          );
          expect(crosses).toHaveLength(3);
          for (const cross of crosses) {
            expect(Number(attr(cross, "stroke-width"))).toBe(2);
            expect(
              cross.children.filter((e) => e.kind === "element"),
            ).toHaveLength(2);
          }
          const backdrops = r.nodes.filter(
            (e) => e.name.localName === "rect" && attr(e, "fill") === "#116699",
          );
          expect(backdrops).toHaveLength(markerFill === null ? 0 : 3);
        }
      });
  it("radar explicit none hides plot and legend markers independently of its data outline", () => {
    const f = chartMarkerPaintDeck("radar");
    changeXml(f, (doc) => {
      const symbol = child(markers(f, doc)[0], "symbol");
      symbol.attrs[0].value = "none";
    });
    expect(render(f).marks).toHaveLength(8);
  });
  it("an empty size element uses the schema's 5-point default through data edit/export, while an omitted element remains style-dependent", async () => {
    const f = chartMarkerPaintDeck();
    changeXml(f, (doc) => {
      child(markers(f, doc)[0], "size").attrs = [];
      const second = markers(f, doc)[1];
      second.children = second.children.filter(
        (e) => e !== child(second, "size"),
      );
    });
    const c = P.getSlideCharts(f.slide)[0];
    expect(c.spec.series.map((s) => s.markerSizePt)).toEqual([
      5,
      undefined,
      24,
    ]);
    P.setChartSpec(c, {
      ...c.spec,
      series: c.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 1),
      })),
    });
    const p = await P.loadPresentation(await P.savePresentation(f.p));
    expect(
      P.getSlideCharts(P.getSlides(p)[0])[0].spec.series.map(
        (s) => s.markerSizePt,
      ),
    ).toEqual([5, undefined, 24]);
    expect(P.validatePresentation(p)).toEqual([]);
  });
  it("the legend container includes the actual marker outline even when its width is omitted", () => {
    const f = chartLineMarkersDeck({
        legend: {
          position: "b",
          fill: "#F8F3EB",
          strokeColor: null,
          textStyle: { sizePt: 1 },
        },
        series: [
          {
            name: "Key",
            values: [1, 2],
            markerSymbol: "circle",
            markerFill: "#116699",
            markerStrokeColor: "#EA7423",
          },
        ],
      }),
      r = render(f);
    const key = r.marks.find(
        (e) => e.name.localName === "circle" && Number(attr(e, "r")) === 4.5,
      ),
      back = r.nodes.find(
        (e) => e.name.localName === "rect" && attr(e, "fill") === "#F8F3EB",
      );
    expect(Number(attr(key, "stroke-width"))).toBe(1);
    expect(Number(attr(back, "x"))).toBeLessThanOrEqual(
      Number(attr(key, "cx")) - 5,
    );
    expect(
      Number(attr(back, "y")) + Number(attr(back, "height")),
    ).toBeGreaterThanOrEqual(Number(attr(key, "cy")) + 5);
  });
  it("a paint-only marker retains omitted symbol and size and can reset all explicit paint", () => {
    const f = chartLineMarkersDeck({
      series: [
        {
          name: "Only paint",
          values: [1, 2],
          markerFill: null,
          markerStrokeColor: "#CC3344",
          markerStrokeWidthEmu: 9525,
        },
      ],
    });
    expect(fields(P.getShapeChartSpec(f.shape).series[0])).toEqual([
      undefined,
      undefined,
      null,
      "#CC3344",
      9525,
    ]);
    const c = P.getSlideCharts(f.slide)[0];
    P.setChartSpec(c, {
      ...c.spec,
      series: c.spec.series.map((s) => ({
        ...s,
        markerFill: undefined,
        markerStrokeColor: undefined,
        markerStrokeWidthEmu: undefined,
      })),
    });
    expect(markers(f)).toEqual([null]);
  });
});
