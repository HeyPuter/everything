import { describe, expect, it } from "vitest";
import { P, createDeck, parseDeck, preview } from "../src/model.js";
import { buildChartSpaceDoc } from "../lib/pptx/src/internal/chartml/chart-builder.ts";
import {
  chartAxisContext,
  chartPlotContext,
  primaryChartAxis,
} from "../lib/pptx/src/internal/chartml/axis-context.ts";
import { chartRoot, workbook } from "./chart-copy-fixture.js";
import {
  NS,
  parseXml,
  serializeXml,
  firstChildElement,
  getAttrValue,
  qname,
  elem,
  attr,
} from "../lib/pptx/src/internal/xml/index.ts";

const fields = [
    "categoryAxisCrosses",
    "valueAxisCrosses",
    "secondaryCategoryAxisCrosses",
    "secondaryValueAxisCrosses",
  ],
  values = ["autoZero", "min", "max", { at: 2 }, { at: -3.125 }],
  c = (name) => qname("c", name, NS.chart),
  val = qname("", "val", ""),
  child = (e, name) => firstChildElement(e, c(name)),
  crossingNodes = (axis) =>
    axis.children.filter(
      (n) =>
        n.kind === "element" &&
        n.name.namespaceURI === NS.chart &&
        ["crosses", "crossesAt"].includes(n.name.localName),
    ),
  settings = (spec) =>
    Object.fromEntries(fields.map((key) => [key, spec[key]])),
  baseSpec = (kind = "column") => ({
    kind,
    categories: ["North", "South", "West"],
    series: [
      { name: "Primary", values: [2, 4, 3] },
      {
        name: "Secondary",
        values: [20, 30, 10],
        secondaryAxis: true,
        chartKind: kind === "column" ? "line" : kind,
      },
    ],
  }),
  options = (spec) => ({
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(7),
    h: P.inches(4),
    spec,
  });
function fixture(spec = baseSpec()) {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0],
    shape = P.addSlideChart(slide, options(spec));
  return { p, slide, shape };
}
function part(f) {
  return P._internalPackageOf(f.p).getPart(chartRoot(f.shape));
}
function axes(root) {
  const ctx = chartPlotContext(root);
  return [
    primaryChartAxis(ctx, ["catAx", "dateAx", "serAx"]),
    primaryChartAxis(ctx, ["valAx"]),
    ctx.axes.axisForGroups(["catAx", "dateAx", "serAx"], true),
    ctx.axes.axisForGroups(["valAx"], true),
  ];
}
function raw(f) {
  return axes(parseXml(new TextDecoder().decode(part(f).data)).root).map((a) =>
    crossingNodes(a).map((n) => [n.name.localName, getAttrValue(n, val)]),
  );
}
function mutate(f, fn) {
  const doc = parseXml(new TextDecoder().decode(part(f).data));
  fn(axes(doc.root), doc.root);
  part(f).data = new TextEncoder().encode(serializeXml(doc));
}
function replace(axis, entries) {
  axis.children = axis.children.filter((n) => !crossingNodes(axis).includes(n));
  const index = axis.children.indexOf(child(axis, "crossAx"));
  axis.children.splice(
    index + 1,
    0,
    ...entries.map(([name, value]) =>
      elem(c(name), { attrs: value === null ? [] : [attr(val, value)] }),
    ),
  );
}
const snapshot = (p) =>
  P._internalPackageOf(p).parts.map((p) => [
    p.name,
    p.contentType,
    p.data.slice(),
  ]);

describe("independent native chart axis crossings", () => {
  for (const kind of ["column", "bar", "line", "area"])
    for (let shift = 0; shift < values.length; shift++)
      it(`${kind} retains four independent crossing choices through edits and transfer (${shift})`, async () => {
        const requested = Object.fromEntries(
            fields.map((key, i) => [key, values[(i + shift) % values.length]]),
          ),
          f = fixture({ ...baseSpec(kind), ...requested }),
          original = P.getShapeChartSpec(f.shape),
          native = raw(f),
          book = workbook(f.p, f.shape).data.slice();
        expect(settings(original)).toEqual(requested);
        expect(native).toEqual(
          fields.map((key) => [
            [
              typeof requested[key] === "string" ? "crosses" : "crossesAt",
              String(
                typeof requested[key] === "string"
                  ? requested[key]
                  : requested[key].at,
              ),
            ],
          ]),
        );
        P.setChartSpec(P.getSlideCharts(f.slide)[0], {
          ...original,
          title: "New title",
        });
        expect(raw(f)).toEqual(native);
        expect(workbook(f.p, f.shape).data).toEqual(book);
        const q = createDeck("blank"),
          copy = P.importSlide(q, f.slide, P.getSlideLayouts(q)[0]),
          back = P.importSlide(f.p, copy, P.getSlideLayout(f.slide));
        expect(settings(P.getSlideCharts(copy)[0].spec)).toEqual(requested);
        expect(settings(P.getSlideCharts(back)[0].spec)).toEqual(requested);
        const edited = P.getSlideCharts(back)[0],
          sourceXml = part(f).data.slice();
        P.setChartSpec(edited, {
          ...edited.spec,
          categoryAxisCrosses: { at: 6.5 },
          secondaryValueAxisCrosses: "min",
          series: edited.spec.series.map((s) => ({
            ...s,
            values: s.values.map((v) => v + 0.25),
          })),
        });
        expect(part(f).data).toEqual(sourceXml);
        expect(workbook(f.p, f.shape).data).toEqual(book);
        expect(P.getSlideCharts(back)[0].spec).toMatchObject({
          categoryAxisCrosses: { at: 6.5 },
          secondaryValueAxisCrosses: "min",
        });
        expect(settings(P.getSlideCharts(f.slide)[0].spec)).toEqual(requested);
        const reopened = await parseDeck(await P.savePresentation(f.p)),
          charts = P.getSlides(reopened).flatMap((s) => P.getSlideCharts(s));
        expect(charts).toHaveLength(2);
        expect(
          new Set(charts.map((c) => workbook(reopened, c.shape).name)).size,
        ).toBe(2);
        expect(settings(charts[0].spec)).toEqual(requested);
        expect(charts[1].spec.series[0].values).toEqual([2.25, 4.25, 3.25]);
        expect(P.validatePresentation(reopened)).toEqual([]);
      });

  for (const [i, field] of fields.entries()) {
    it(`${field} edits only its native crossing slot and can clear it`, () => {
      const f = fixture({
          ...baseSpec(),
          ...Object.fromEntries(fields.map((key, j) => [key, values[j]])),
        }),
        before = raw(f);
      for (const crossing of [{ at: 1.25 }, "max", undefined]) {
        const chart = P.getSlideCharts(f.slide)[0];
        P.setChartSpec(chart, { ...chart.spec, [field]: crossing });
        const actual = raw(f);
        expect(settings(P.getSlideCharts(f.slide)[0].spec)[field]).toEqual(
          crossing,
        );
        expect(actual[i]).toEqual(
          crossing === undefined
            ? []
            : [
                [
                  typeof crossing === "string" ? "crosses" : "crossesAt",
                  String(typeof crossing === "string" ? crossing : crossing.at),
                ],
              ],
        );
        actual.forEach((nodes, j) => {
          if (j !== i) expect(nodes).toEqual(before[j]);
        });
      }
    });
    for (const value of [
      null,
      "zero",
      "MAX",
      5,
      {},
      { at: "2" },
      { at: NaN },
      { at: Infinity },
      { at: -Infinity },
    ])
      it(`${field} rejects ${JSON.stringify(value)} atomically`, () => {
        const f = fixture(),
          original = snapshot(f.p),
          spec = P.getShapeChartSpec(f.shape),
          paint = preview(f.p, f.slide),
          requested = { ...spec, [field]: value };
        expect(() =>
          P.setChartSpec(P.getSlideCharts(f.slide)[0], requested),
        ).toThrow(new RegExp(field));
        expect(snapshot(f.p)).toEqual(original);
        expect(preview(f.p, f.slide)).toBe(paint);
        const p = createDeck("blank"),
          before = snapshot(p);
        expect(() =>
          P.addSlideChart(P.getSlides(p)[0], options(requested)),
        ).toThrow(new RegExp(field));
        expect(snapshot(p)).toEqual(before);
        expect(() => buildChartSpaceDoc(requested)).toThrow(new RegExp(field));
      }, 30_000);
    for (const [token, expected] of [
      [" +2.50e+1 ", { at: 25 }],
      ["-.25", { at: -0.25 }],
      ["0", { at: 0 }],
      ["2junk", undefined],
      ["0x20", undefined],
      ["", undefined],
      ["NaN", undefined],
      ["INF", undefined],
      ["1e999", undefined],
    ])
      it(`${field} reads complete finite numeric tokens and retains native lexical form: ${JSON.stringify(token)}`, () => {
        const f = fixture();
        mutate(f, (a) => replace(a[i], [["crossesAt", token]]));
        const native = raw(f),
          chart = P.getSlideCharts(f.slide)[0];
        expect(chart.spec[field]).toEqual(expected);
        P.setChartSpec(chart, { ...chart.spec, title: "Keep native crossing" });
        expect(raw(f)).toEqual(native);
      });
    it(`${field} preserves omitted or unreadable native choices during an unrelated edit`, async () => {
      for (const entries of [
        [],
        [["crosses", null]],
        [["crosses", "other"]],
        [
          ["crosses", "min"],
          ["crossesAt", "broken"],
        ],
      ]) {
        const f = fixture();
        mutate(f, (a) => replace(a[i], entries));
        const native = part(f).data.slice(),
          chart = P.getSlideCharts(f.slide)[0];
        expect(chart.spec[field]).toBeUndefined();
        const q = await parseDeck(await P.savePresentation(f.p));
        expect(
          part({ p: q, shape: P.getSlideCharts(P.getSlides(q)[0])[0].shape })
            .data,
        ).toEqual(native);
        P.setChartSpec(chart, {
          ...chart.spec,
          title: "Retain native omission",
        });
        expect(raw(f)[i]).toEqual(entries);
      }
    });
  }
  it("resolves crossing metadata by referenced axes with secondary axes first and an unrelated axis", () => {
    const requested = {
        categoryAxisCrosses: { at: 4.5 },
        valueAxisCrosses: "min",
        secondaryCategoryAxisCrosses: "max",
        secondaryValueAxisCrosses: { at: 2 },
      },
      f = fixture({ ...baseSpec(), ...requested });
    mutate(f, (a, root) => {
      const ctx = chartPlotContext(root),
        extra = structuredClone(a[3]);
      child(extra, "axId").attrs[0].value = "987654321";
      replace(extra, [["crossesAt", "900"]]);
      ctx.area.children = ctx.area.children.filter((n) => !a.includes(n));
      ctx.area.children.push(extra, a[3], a[2], a[1], a[0]);
    });
    expect(settings(P.getShapeChartSpec(f.shape))).toEqual(requested);
    P.setChartSpec(P.getSlideCharts(f.slide)[0], {
      ...P.getShapeChartSpec(f.shape),
      title: "Referenced axes",
    });
    expect(settings(P.getShapeChartSpec(f.shape))).toEqual(requested);
  });
  for (const position of ["l", "r"])
    for (const reversed of [false, true])
      it(`keeps two referenced systems when both value axes are ${position} and XML order is ${reversed ? "reversed" : "forward"}`, () => {
        const requested = {
            categoryAxisCrosses: { at: 3 },
            valueAxisCrosses: position === "r" ? "max" : "min",
            secondaryCategoryAxisCrosses: { at: 25 },
            secondaryValueAxisCrosses: position === "r" ? "max" : "min",
          },
          f = fixture({ ...baseSpec(), ...requested });
        mutate(f, (a, root) => {
          for (const axis of [a[1], a[3]])
            child(axis, "axPos").attrs[0].value = position;
          const ctx = chartPlotContext(root),
            extra = structuredClone(a[3]);
          child(extra, "axId").attrs[0].value = "987654321";
          ctx.area.children = ctx.area.children.filter((n) => !a.includes(n));
          ctx.area.children.push(
            extra,
            ...(reversed ? a.slice().reverse() : a),
          );
        });
        let chart = P.getSlideCharts(f.slide)[0];
        expect(settings(chart.spec)).toEqual(requested);
        expect(chart.spec.series.map((s) => !!s.secondaryAxis)).toEqual([
          false,
          true,
        ]);
        P.setChartSpec(chart, {
          ...chart.spec,
          title: "Independent same-edge systems",
          series: chart.spec.series.map((s) => ({
            ...s,
            values: s.values.map((v) => v + 0.25),
          })),
        });
        chart = P.getSlideCharts(f.slide)[0];
        expect(settings(chart.spec)).toEqual(requested);
        expect(chart.spec.series.map((s) => !!s.secondaryAxis)).toEqual([
          false,
          true,
        ]);
        expect(chart.spec.series.map((s) => s.values)).toEqual([
          [2.25, 4.25, 3.25],
          [20.25, 30.25, 10.25],
        ]);
      });
  for (const positions of [
    ["b", "l"],
    ["t", "r"],
  ])
    it(`keeps both coordinates of an XY axis system together when pairs share ${positions.join("/")} positions`, () => {
      const doc = parseXml(
          `<c:plotArea xmlns:c="${NS.chart}"><c:scatterChart><c:axId val="10"/><c:axId val="11"/></c:scatterChart><c:scatterChart><c:axId val="20"/><c:axId val="21"/></c:scatterChart>${[
            [10, 11, positions[0]],
            [11, 10, positions[1]],
            [20, 21, positions[0]],
            [21, 20, positions[1]],
          ]
            .map(
              ([id, cross, pos]) =>
                `<c:valAx><c:axId val="${id}"/><c:axPos val="${pos}"/><c:crossAx val="${cross}"/></c:valAx>`,
            )
            .join("")}</c:plotArea>`,
        ),
        area = doc.root,
        groups = area.children
          .filter(
            (n) => n.kind === "element" && n.name.localName === "scatterChart",
          )
          .map((element) => ({ element })),
        ctx = chartAxisContext(area, groups);
      expect(groups.map((g) => ctx.groupUsesSecondaryAxis(g.element))).toEqual([
        false,
        true,
      ]);
      const horizontal = (a) =>
        ["b", "t"].includes(getAttrValue(child(a, "axPos"), val));
      expect(
        getAttrValue(
          child(ctx.axisForGroups(["valAx"], false, horizontal), "axId"),
          val,
        ),
      ).toBe("10");
      expect(
        getAttrValue(
          child(ctx.axisForGroups(["valAx"], true, horizontal), "axId"),
          val,
        ),
      ).toBe("20");
    });
  it("retains native date-axis crossing values when converting to the authorable category axis", () => {
    const f = fixture();
    mutate(f, (a) => {
      a[0].name = c("dateAx");
      replace(a[0], [["crossesAt", " 4.25e0 "]]);
    });
    const chart = P.getSlideCharts(f.slide)[0];
    expect(chart.spec.categoryAxisCrosses).toEqual({ at: 4.25 });
    P.setChartSpec(chart, { ...chart.spec, title: "Edited date categories" });
    expect(raw(f)[0]).toEqual([["crossesAt", " 4.25e0 "]]);
  });
  it("keeps the opposite-edge default only for a newly created secondary axis", () => {
    const f = fixture();
    expect(P.getShapeChartSpec(f.shape).secondaryValueAxisCrosses).toBe("max");
    mutate(f, (a) => replace(a[3], []));
    const chart = P.getSlideCharts(f.slide)[0];
    expect(chart.spec.secondaryValueAxisCrosses).toBeUndefined();
    P.setChartSpec(chart, { ...chart.spec, title: "No new default" });
    expect(raw(f)[3]).toEqual([]);
  });
});
