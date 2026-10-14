import { describe, it, expect } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import { chartRoot, workbook } from "./chart-copy-fixture.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import {
  NS,
  parseXml,
  serializeXml,
  firstChildElement,
  qname,
  walkElements,
  getAttrValue,
} from "../lib/pptx/src/internal/xml/index.ts";
const child = (e, n) => firstChildElement(e, qname("", n, NS.chart));
const attr = (e, n) => getAttrValue(e, qname("", n, ""));
const color = "#A138C4";
const categories = ["North", "East", "South", "West", "Central"];
function fixture(spec = {}) {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0];
  const shape = P.addSlideChart(slide, {
    x: P.inches(1),
    y: P.inches(0.5),
    w: P.inches(7),
    h: P.inches(4.5),
    spec: {
      kind: "column",
      categories,
      series: [{ name: "Units", values: [2, 7, 3, 5, 1] }],
      categoryAxisLineColor: color,
      categoryAxisLabelRotationDeg: 0,
      categoryAxisMajorTickMark: "out",
      categoryAxisMinorTickMark: "none",
      categoryAxisTickLabelSkip: 1,
      categoryAxisTickMarkSkip: 1,
      categoryAxisTickLabelPos: "nextTo",
      valueAxisHidden: true,
      ...spec,
    },
  });
  return {
    p,
    slide,
    shape,
    part: P._internalPackageOf(p).getPart(chartRoot(shape)),
  };
}
function editAxis(f, axisName, mutate) {
  const doc = parseXml(new TextDecoder().decode(f.part.data));
  mutate(child(child(child(doc.root, "chart"), "plotArea"), axisName));
  f.part.data = new TextEncoder().encode(serializeXml(doc));
}
function value(e, raw) {
  const a = e.attrs.find(
    (a) => a.name.localName === "val" && a.name.namespaceURI === "",
  );
  if (raw === undefined) e.attrs = e.attrs.filter((x) => x !== a);
  else a.value = raw;
}
function rendered(f) {
  const svg = renderSlideToSvg(f.p, f.slide),
    lines = [],
    texts = [];
  walkElements(parseXml(svg).root, (e) => {
    if (e.name.localName === "line" && attr(e, "stroke") === color)
      lines.push(e);
    if (e.name.localName === "text")
      texts.push(
        e.children
          .filter((c) => c.kind === "text")
          .map((c) => c.data)
          .join(""),
      );
  });
  const bar = P.getShapeChartSpec(f.shape).kind === "bar";
  const ticks = lines.filter((e) =>
    bar ? attr(e, "y1") === attr(e, "y2") : attr(e, "x1") === attr(e, "x2"),
  );
  const spine = lines.find((e) => !ticks.includes(e));
  return { svg, lines, texts, ticks, spine, bar };
}
function position(e, bar) {
  return Number(attr(e, bar ? "y1" : "x1"));
}
function direction(r, mode) {
  const base = Number(attr(r.spine, r.bar ? "x1" : "y1"));
  for (const e of r.ticks) {
    const ends = [
      Number(attr(e, r.bar ? "x1" : "y1")),
      Number(attr(e, r.bar ? "x2" : "y2")),
    ];
    const inward = ends.some((x) => (r.bar ? x > base : x < base));
    const outward = ends.some((x) => (r.bar ? x < base : x > base));
    expect(inward).toBe(mode === "in" || mode === "cross");
    expect(outward).toBe(mode === "out" || mode === "cross");
  }
}
const tickFields = (shape) => {
  const s = P.getShapeChartSpec(shape);
  return [
    s.categoryAxisMajorTickMark,
    s.categoryAxisMinorTickMark,
    s.categoryAxisTickMarkSkip,
    s.categoryAxisTickLabelSkip,
    s.categoryAxisTickLabelPos,
  ];
};
describe("native category-axis major tick decorations", () => {
  for (const kind of ["bar", "column", "line", "area"])
    it.each(["none", "in", "out", "cross"])(
      `${kind} honors authored %s marks without hiding labels or data`,
      (mode) => {
        const f = fixture({
            kind,
            valueAxisCrossBetween: "between",
            categoryAxisMajorTickMark: mode,
          }),
          before = f.part.data.slice(),
          r = rendered(f);
        expect(r.spine).toBeDefined();
        expect(r.ticks).toHaveLength(
          mode === "none" ? 0 : categories.length + 1,
        );
        direction(r, mode);
        for (const text of categories) expect(r.texts).toContain(text);
        expect(r.svg).not.toContain("no data");
        expect(f.part.data).toEqual(before);
      },
    );
  for (const kind of ["bar", "column"])
    it.each([1, 2, 3, 4294967295])(
      `${kind} draws every %s category tick independently of label stride`,
      (skip) => {
        const all = rendered(fixture({ kind })),
          f = fixture({
            kind,
            categoryAxisTickMarkSkip: skip,
            categoryAxisTickLabelSkip: 2,
          }),
          r = rendered(f);
        const original = all.ticks.map((e) => position(e, all.bar));
        // Bar categories run bottom-to-top; the skip sequence starts there.
        original.sort((a, b) => (all.bar ? b - a : a - b));
        const expected = original
          .filter((_, i) => i % skip === 0)
          .sort((a, b) => a - b);
        expect(
          r.ticks.map((e) => position(e, r.bar)).sort((a, b) => a - b),
        ).toEqual(expected);
        expect(r.texts.filter((t) => categories.includes(t))).toEqual([
          "North",
          "South",
          "Central",
        ]);
        expect(tickFields(f.shape).slice(2, 4)).toEqual([skip, 2]);
      },
    );
  it.each(["bar", "column"])(
    "%s hides only labels for tickLblPos=none",
    (kind) => {
      const r = rendered(
        fixture({
          kind,
          categoryAxisTickLabelPos: "none",
          categoryAxisMajorTickMark: "cross",
          categoryAxisTickMarkSkip: 2,
        }),
      );
      expect(r.spine).toBeDefined();
      expect(r.ticks).toHaveLength(3);
      direction(r, "cross");
      expect(r.texts.filter((t) => categories.includes(t))).toEqual([]);
    },
  );
  it("honors major mode, skip and hidden labels on a shared mixed-chart axis", () => {
    const f = fixture({
        categoryAxisMajorTickMark: "in",
        categoryAxisTickMarkSkip: 3,
        categoryAxisTickLabelPos: "none",
        series: [
          { name: "Columns", values: [2, 7, 3, 5, 1] },
          { name: "Line", chartKind: "line", values: [1, 3, 4, 2, 6] },
        ],
      }),
      r = rendered(f);
    expect(r.ticks).toHaveLength(2);
    direction(r, "in");
    expect(r.texts.filter((t) => categories.includes(t))).toEqual([]);
  });
  it.each(["bar", "column"])(
    "%s removes decorations and labels for a deleted category axis",
    (kind) => {
      const r = rendered(
        fixture({
          kind,
          categoryAxisHidden: true,
          categoryAxisMajorTickMark: "cross",
        }),
      );
      expect(r.lines).toEqual([]);
      expect(r.texts.filter((t) => categories.includes(t))).toEqual([]);
    },
  );
  it.each(["bar", "column"])(
    "%s renders omitted major marks as cross without authoring the default",
    (kind) => {
      const f = fixture({ kind, categoryAxisMajorTickMark: undefined }),
        r = rendered(f);
      expect(
        P.getShapeChartSpec(f.shape).categoryAxisMajorTickMark,
      ).toBeUndefined();
      expect(r.ticks).toHaveLength(6);
      direction(r, "cross");
    },
  );
  it.each([
    {
      categories: ["Only"],
      series: [{ name: "Units", values: [6] }],
      count: 2,
    },
    { categories: [], series: [{ name: "Units", values: [] }], count: 2 },
    {
      categories: ["Named"],
      series: [{ name: "Units", values: [3, 1, 7, 2] }],
      count: 5,
    },
  ])(
    "handles single, empty and partially labeled data ($count tick slots)",
    ({ count, ...spec }) => {
      const r = rendered(fixture(spec));
      expect(r.ticks).toHaveLength(count);
      expect(r.spine).toBeDefined();
    },
  );
  it("keeps labels with an explicitly invisible category stroke", () => {
    const f = fixture({
        categoryAxisLineColor: null,
        categoryAxisMajorTickMark: "cross",
      }),
      r = rendered(f);
    expect(r.lines).toEqual([]);
    for (const t of categories) expect(r.texts).toContain(t);
    expect(r.svg).not.toContain(`stroke="${color}"`);
  });
  for (const axisName of ["catAx", "valAx"])
    it.each(["majorTickMark", "minorTickMark"])(
      `${axisName} resolves an empty %s element to the schema default cross`,
      (local) => {
        const f = fixture({
          valueAxisMajorTickMark: "out",
          valueAxisMinorTickMark: "none",
        });
        editAxis(f, axisName, (a) => value(child(a, local), undefined));
        const original = f.part.data.slice(),
          spec = P.getShapeChartSpec(f.shape);
        const key =
          (axisName === "catAx" ? "categoryAxis" : "valueAxis") +
          (local === "majorTickMark" ? "MajorTickMark" : "MinorTickMark");
        expect(spec[key]).toBe("cross");
        expect(f.part.data).toEqual(original);
      },
    );
  it("keeps foreign and invalid tick modes distinct from the schema default", () => {
    for (const raw of ["unknown", "OUT", ""]) {
      const f = fixture();
      editAxis(f, "catAx", (a) => value(child(a, "majorTickMark"), raw));
      expect(
        P.getShapeChartSpec(f.shape).categoryAxisMajorTickMark,
      ).toBeUndefined();
    }
    const f = fixture();
    editAxis(f, "catAx", (a) => {
      child(a, "majorTickMark").name.namespaceURI = "urn:foreign";
    });
    expect(
      P.getShapeChartSpec(f.shape).categoryAxisMajorTickMark,
    ).toBeUndefined();
  });
  it("resolves an empty label-position element to nextTo without changing XML", () => {
    const f = fixture();
    editAxis(f, "catAx", (a) => value(child(a, "tickLblPos"), undefined));
    const before = f.part.data.slice();
    expect(P.getShapeChartSpec(f.shape).categoryAxisTickLabelPos).toBe(
      "nextTo",
    );
    expect(f.part.data).toEqual(before);
  });
  it.each(["TickLabelSkip", "TickMarkSkip"])(
    "preserves positive unsigned %s values and rejects malformed native metadata",
    (suffix) => {
      const local = suffix === "TickLabelSkip" ? "tickLblSkip" : "tickMarkSkip",
        key = "categoryAxis" + suffix;
      for (const [raw, expected] of [
        ["1", 1],
        [" +002 ", 2],
        ["4294967295", 4294967295],
        ["0", undefined],
        ["-1", undefined],
        ["2bad", undefined],
        ["2.5", undefined],
        ["4294967296", undefined],
        ["", undefined],
      ]) {
        const f = fixture();
        editAxis(f, "catAx", (a) => value(child(a, local), raw));
        const before = f.part.data.slice();
        expect(P.getShapeChartSpec(f.shape)[key], raw).toBe(expected);
        expect(f.part.data).toEqual(before);
      }
    },
  );
  it.each(["categoryAxisTickLabelSkip", "categoryAxisTickMarkSkip"])(
    "rejects invalid authored %s before add or edit mutates the package",
    (key) => {
      const f = fixture(),
        pkg = P._internalPackageOf(f.p),
        before = pkg.parts.map((p) => [p.name, p.data.slice()]),
        chart = P.getSlideCharts(f.slide)[0];
      for (const invalid of [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        4294967296,
        "2",
        null,
      ]) {
        expect(() =>
          P.addSlideChart(f.slide, {
            x: P.inches(1),
            y: P.inches(1),
            w: P.inches(2),
            h: P.inches(2),
            spec: { ...chart.spec, [key]: invalid },
          }),
        ).toThrow(key);
        expect(() =>
          P.setChartSpec(chart, { ...chart.spec, [key]: invalid }),
        ).toThrow(key);
        expect(pkg.parts.map((p) => [p.name, p.data])).toEqual(before);
      }
    },
    30_000,
  );
  it("preserves modes, independent strides and label visibility through edits, export and native transfer both ways", async () => {
    const f = fixture({
        categoryAxisMajorTickMark: "cross",
        categoryAxisTickMarkSkip: 2,
        categoryAxisTickLabelSkip: 3,
        categoryAxisTickLabelPos: "none",
      }),
      original = f.part.data.slice(),
      sourceWorkbook = workbook(f.p, f.shape).data.slice();
    const q = createDeck("blank"),
      to = P.importSlide(q, f.slide, P.getSlideLayouts(q)[0]),
      back = P.importSlide(f.p, to, P.getSlideLayout(f.slide));
    for (const s of [f.slide, to, back])
      expect(tickFields(P.getSlideCharts(s)[0].shape)).toEqual([
        "cross",
        "none",
        2,
        3,
        "none",
      ]);
    expect(preview(q, to)).toBe(preview(f.p, f.slide));
    const copied = P.getSlideCharts(back)[0];
    P.setChartSpec(copied, {
      ...copied.spec,
      categoryAxisMajorTickMark: "none",
      categoryAxisTickMarkSkip: 1,
      categoryAxisTickLabelSkip: 1,
      categoryAxisTickLabelPos: "nextTo",
    });
    expect(tickFields(copied.shape)).toEqual(["none", "none", 1, 1, "nextTo"]);
    expect(f.part.data).toEqual(original);
    expect(workbook(f.p, f.shape).data).toEqual(sourceWorkbook);
    const p = await P.loadPresentation(await P.savePresentation(f.p));
    expect(
      tickFields(P.getSlideCharts(P.getSlides(p).at(-1))[0].shape),
    ).toEqual(["none", "none", 1, 1, "nextTo"]);
    expect(P.validatePresentation(p)).toEqual([]);
    expect(P.validatePresentation(q)).toEqual([]);
  });
});
