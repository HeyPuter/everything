import { setChartAxisGridDeclarations } from "./chart-axis-grid-fixture.js";
import { describe, it, expect } from "vitest";
import {
  autoBubbleScale,
  autoValueScale,
} from "../lib/pptx-preview/src/chart-scale.ts";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import {
  chartLegendLayoutDeck,
  chartRoot,
  workbook,
} from "./chart-copy-fixture.js";
import {
  NS,
  parseXml,
  firstChildElement,
  serializeXml,
  walkElements,
  getAttrValue,
  qname,
} from "../lib/pptx/src/internal/xml/index.ts";

const C = "#A3472B",
  V = "#9152BD",
  CL = "#AC2351",
  VL = "#17589B",
  S = "#E85239";
const attr = (e, name) => getAttrValue(e, qname("", name, ""));
const num = (e, name) => Number(attr(e, name));
const text = (e) =>
  e.children
    .filter((n) => n.kind === "text")
    .map((n) => n.data)
    .join("");
const measure = (text, font) => ({
  widthPx: [...text].length * font.sizePx * 0.6,
  ascentPx: font.sizePx * 0.8,
  descentPx: font.sizePx * 0.2,
});
function fixture(kind = "column", spec = {}) {
  return chartLegendLayoutDeck({
    kind,
    legend: undefined,
    categories: ["First", "Second", "Third", "Fourth"],
    valueAxis: { min: -2, max: 10, majorUnit: 2 },
    categoryAxisTickLabelPos: "none",
    valueAxisTickLabelPos: "none",
    categoryAxisLineColor: C,
    valueAxisLineColor: V,
    categoryAxisMajorTickMark: "out",
    valueAxisMajorTickMark: "out",
    categoryAxisMinorTickMark: "none",
    valueAxisMinorTickMark: "none",
    categoryAxisLabelRotationDeg: 0,
    valueAxisLabelRotationDeg: 0,
    categoryAxisLabelStyle: { color: CL, sizePt: 9 },
    valueAxisLabelStyle: { color: VL, sizePt: 9 },
    series: [
      {
        name: "Units",
        values: [2, 4, 3, 5],
        color: S,
        invertIfNegative: false,
      },
    ],
    ...spec,
  });
}
function paint(f) {
  const nodes = [];
  walkElements(
    parseXml(renderSlideToSvg(f.p, f.slide, { measureText: measure })).root,
    (e) => nodes.push(e),
  );
  const box = nodes.find(
      (e) => e.name.localName === "rect" && attr(e, "fill") === "#ECF5E9",
    ),
    plot = {
      x: num(box, "x"),
      y: num(box, "y"),
      w: num(box, "width"),
      h: num(box, "height"),
    };
  const spine = (color) =>
    nodes.find(
      (e) =>
        e.name.localName === "line" &&
        attr(e, "stroke") === color &&
        Math.hypot(num(e, "x2") - num(e, "x1"), num(e, "y2") - num(e, "y1")) >
          10,
    );
  return {
    nodes,
    plot,
    spine,
    labels: (color) =>
      nodes.filter(
        (e) => e.name.localName === "text" && attr(e, "fill") === color,
      ),
    ticks: (color) =>
      nodes.filter(
        (e) =>
          e.name.localName === "line" &&
          attr(e, "stroke") === color &&
          Math.hypot(
            num(e, "x2") - num(e, "x1"),
            num(e, "y2") - num(e, "y1"),
          ) <= 10,
      ),
  };
}
const bound = (v) => Math.max(0, Math.min(1, v));
const physical = (fraction, reversed, horizontal) =>
  horizontal
    ? reversed
      ? 1 - fraction
      : fraction
    : reversed
      ? fraction
      : 1 - fraction;
const crossFraction = (crossing, min, max) =>
  crossing === "max"
    ? 1
    : typeof crossing === "object"
      ? bound((crossing.at - min) / (max - min))
      : crossing === "min"
        ? 0
        : bound(-min / (max - min));

describe("native chart axis placement", () => {
  it("retains the shared fallback projection for mixed horizontal and vertical groups", () => {
    const f = fixture("bar", {
        valueAxis: undefined,
        series: [
          { name: "Primary", values: [2, 4, 3, 5], color: S },
          {
            name: "Secondary",
            values: [20, 40, 30, 50],
            color: "#2F8541",
            secondaryAxis: true,
            chartKind: "line",
          },
        ],
      }),
      r = paint(f),
      bars = r.nodes.filter(
        (e) => e.name.localName === "rect" && attr(e, "fill") === S,
      );
    expect(bars).toHaveLength(4);
    bars.forEach((bar, i) =>
      expect(num(bar, "width") / r.plot.w).toBeCloseTo([2, 4, 3, 5][i] / 60, 4),
    );
  });
  for (const kind of ["scatter", "bubble"])
    for (const xDirection of ["minMax", "maxMin"])
      for (const yDirection of ["minMax", "maxMin"])
        for (const mode of ["low", "high", "nextTo", "none"])
          it(`${kind} ${xDirection}/${yDirection} keeps points aligned with its independent ${mode} numeric axes`, () => {
            const f = fixture("column", {
              categoryAxisOrientation: xDirection,
              valueAxisOrientation: yDirection,
              categoryAxisTickLabelPos: mode,
              valueAxisTickLabelPos: mode,
              categoryAxisCrosses: { at: 5 },
              valueAxisCrosses: { at: 2 },
            });
            const part = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)),
              doc = parseXml(new TextDecoder().decode(part.data)),
              child = (e, n) => firstChildElement(e, qname("c", n, NS.chart)),
              area = child(child(doc.root, "chart"), "plotArea"),
              group = child(area, "barChart"),
              xAxis = child(area, "catAx"),
              yAxis = child(area, "valAx"),
              cache = (values) =>
                `<c:numLit><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("")}</c:numLit>`;
            xAxis.name = qname("c", "valAx", NS.chart);
            xAxis.children = xAxis.children.filter(
              (e) =>
                e.kind !== "element" ||
                e.name.namespaceURI !== NS.chart ||
                ![
                  "auto",
                  "lblAlgn",
                  "lblOffset",
                  "tickLblSkip",
                  "tickMarkSkip",
                  "noMultiLvlLbl",
                ].includes(e.name.localName),
            );
            area.children[area.children.indexOf(group)] = parseXml(
              `<c:${kind}Chart xmlns:c="${NS.chart}" xmlns:a="${NS.dml}">${kind === "scatter" ? '<c:scatterStyle val="marker"/>' : ""}<c:ser><c:idx val="0"/><c:order val="0"/><c:spPr><a:solidFill><a:srgbClr val="E85239"/></a:solidFill></c:spPr>${kind === "scatter" ? '<c:marker><c:symbol val="circle"/></c:marker>' : ""}<c:xVal>${cache([1, 2, 4])}</c:xVal><c:yVal>${cache([2, 4, 3])}</c:yVal>${kind === "bubble" ? `<c:bubbleSize>${cache([1, 3, 2])}</c:bubbleSize>` : ""}</c:ser><c:axId val="${attr(child(xAxis, "axId"), "val")}"/><c:axId val="${attr(child(yAxis, "axId"), "val")}"/></c:${kind}Chart>`,
            ).root;
            part.data = new TextEncoder().encode(serializeXml(doc));
            const r = paint(f),
              points = r.nodes.filter(
                (e) => e.name.localName === "circle" && attr(e, "fill") === S,
              );
            expect(points).toHaveLength(3);
            // The X axis has no authored limits: it takes the automatic
            // range desktop editors give XY data (from zero, with room
            // for bubbles).
            const xs = [1, 2, 4],
              sizes = [1, 3, 2];
            const xScale =
              kind === "bubble"
                ? autoBubbleScale(xs, (i) => 0.125 * Math.sqrt(sizes[i] / 3))
                : autoValueScale(1, 4);
            const xFraction = (x) =>
              (x - xScale.min) / (xScale.max - xScale.min);
            for (const [i, point] of points.entries()) {
              expect((num(point, "cx") - r.plot.x) / r.plot.w).toBeCloseTo(
                physical(xFraction(xs[i]), xDirection === "maxMin", true),
                4,
              );
              expect((num(point, "cy") - r.plot.y) / r.plot.h).toBeCloseTo(
                physical(
                  ([2, 4, 3][i] + 2) / 12,
                  yDirection === "maxMin",
                  false,
                ),
                4,
              );
            }
            expect((num(r.spine(V), "x1") - r.plot.x) / r.plot.w).toBeCloseTo(
              physical(xFraction(2), xDirection === "maxMin", true),
              4,
            );
            expect((num(r.spine(C), "y1") - r.plot.y) / r.plot.h).toBeCloseTo(
              physical(7 / 12, yDirection === "maxMin", false),
              4,
            );
            expect(r.labels(VL)).toHaveLength(mode === "none" ? 0 : 7);
            expect(r.labels(CL)).toHaveLength(
              mode === "none"
                ? 0
                : Math.round((xScale.max - xScale.min) / xScale.unit) + 1,
            );
          });
  for (const kind of ["column", "bar", "line", "area"])
    for (const direction of ["minMax", "maxMin"])
      for (const spacing of ["between", "midCat"])
        for (const crossing of [
          "autoZero",
          "min",
          "max",
          { at: -1 },
          { at: 1.5 },
          { at: 2.9 },
          { at: 5 },
        ])
          it(`${kind} ${direction} ${spacing} projects its value spine at ${JSON.stringify(crossing)}`, () => {
            const f = fixture(kind, {
                categoryAxisOrientation: direction,
                valueAxisCrossBetween: spacing,
                valueAxisCrosses: crossing,
              }),
              r = paint(f),
              horizontal = kind !== "bar",
              fraction = physical(
                crossFraction(crossing, 1, spacing === "between" ? 5 : 4),
                direction === "maxMin",
                horizontal,
              ),
              coordinate = horizontal
                ? r.plot.x + fraction * r.plot.w
                : r.plot.y + fraction * r.plot.h;
            expect(num(r.spine(V), horizontal ? "x1" : "y1")).toBeCloseTo(
              coordinate,
              1,
            );
            expect(r.ticks(V)).toHaveLength(7);
            for (const tick of r.ticks(V))
              expect(
                [
                  num(tick, horizontal ? "x1" : "y1"),
                  num(tick, horizontal ? "x2" : "y2"),
                ].some((v) => Math.abs(v - coordinate) < 0.02),
              ).toBe(true);
            expect(r.labels(VL)).toHaveLength(0);
          });
  for (const kind of ["column", "bar"])
    for (const target of ["category", "value"])
      for (const direction of ["minMax", "maxMin"])
        for (const mode of ["low", "high", "nextTo", "none"])
          for (const crossing of [
            "autoZero",
            "max",
            { at: target === "category" ? 5 : 2 },
            { at: target === "category" ? 20 : 5 },
          ])
            it(`${kind} ${target} ${direction} ${mode} labels at ${JSON.stringify(crossing)}`, () => {
              const category = target === "category",
                f = fixture(kind, {
                  [`${target}AxisTickLabelPos`]: mode,
                  [`${target}AxisCrosses`]: crossing,
                  [category
                    ? "valueAxisOrientation"
                    : "categoryAxisOrientation"]: direction,
                }),
                r = paint(f),
                labels = r.labels(category ? CL : VL),
                horizontal = (kind === "bar") === category,
                min = category ? -2 : 1,
                max = category ? 10 : 5,
                reversed = direction === "maxMin",
                lowSide = (horizontal ? -1 : 1) * (reversed ? -1 : 1),
                side =
                  lowSide *
                  (mode === "high" || (mode !== "low" && crossing === "max")
                    ? -1
                    : 1);
              expect(labels).toHaveLength(
                mode === "none" ? 0 : category ? 4 : 7,
              );
              let fraction =
                mode === "low"
                  ? 0
                  : mode === "high"
                    ? 1
                    : crossFraction(crossing, min, max);
              if (
                mode === "nextTo" &&
                reversed &&
                typeof crossing === "object" &&
                crossing.at >= max
              )
                fraction = 0;
              const anchor = physical(fraction, reversed, horizontal),
                coordinate = horizontal
                  ? r.plot.x + anchor * r.plot.w
                  : r.plot.y + anchor * r.plot.h;
              for (const label of labels) {
                expect(
                  (num(label, horizontal ? "x" : "y") - coordinate) * side,
                ).toBeGreaterThan(0);
                expect(
                  Math.abs(num(label, horizontal ? "x" : "y") - coordinate),
                ).toBeLessThan(25);
                if (horizontal)
                  expect(attr(label, "text-anchor")).toBe(
                    side < 0 ? "end" : "start",
                  );
              }
              expect(r.spine(category ? C : V)).toBeTruthy();
              expect(r.ticks(category ? C : V).length).toBeGreaterThan(0);
            });
  for (const kind of ["column", "bar"])
    for (const direction of ["minMax", "maxMin"])
      for (const mode of ["low", "high"])
        for (const secondary of [false, true])
          it(`${kind} ${direction} ${mode} reserves the ${secondary ? "secondary" : "primary"} exterior label gutter`, () => {
            const f = fixture(kind, {
                valueAxisTickLabelPos: secondary ? "none" : mode,
                categoryAxisOrientation: direction,
                ...(secondary
                  ? {
                      secondaryValueAxisTickLabelPos: mode,
                      secondaryCategoryAxisOrientation: direction,
                      secondaryValueAxisNumberFormat: "0.00",
                      series: [
                        { name: "Primary", values: [2, 4, 3, 5], color: S },
                        {
                          name: "Secondary",
                          values: [2000000, 4000000, 3000000, 5000000],
                          color: "#2F8541",
                          secondaryAxis: true,
                          chartKind: kind === "column" ? "line" : "bar",
                        },
                      ],
                    }
                  : {}),
                valueAxis: {
                  min: -2000000,
                  max: 10000000,
                  majorUnit: 2000000,
                  numberFormat: "0.00",
                },
                valueAxisLabelStyle: { color: VL, sizePt: 18 },
              }),
              r = paint(f),
              bounds = P.getShapeBounds(f.shape),
              x = +bounds.x / 9525,
              y = +bounds.y / 9525,
              w = +bounds.w / 9525,
              h = +bounds.h / 9525;
            for (const label of r.labels(VL)) {
              const width = measure(text(label), {
                  sizePx: num(label, "font-size"),
                }).widthPx,
                anchor = attr(label, "text-anchor"),
                left =
                  num(label, "x") -
                  (anchor === "end"
                    ? width
                    : anchor === "middle"
                      ? width / 2
                      : 0),
                right = left + width;
              expect(left).toBeGreaterThanOrEqual(x - 1);
              expect(right).toBeLessThanOrEqual(x + w + 1);
              expect(
                num(label, "y") - num(label, "font-size") / 2,
              ).toBeGreaterThanOrEqual(y - 1);
              expect(
                num(label, "y") + num(label, "font-size") / 2,
              ).toBeLessThanOrEqual(y + h + 1);
            }
          });
  it("none retains the independent unit label, grid, ticks, data labels and native workbook", () => {
    const f = fixture("column", {
        valueAxisTickLabelPos: "none",
        valueAxisMajorGridlines: true,
        valueAxisMajorGridlineColor: "#9C52E4",
        valueAxis: {
          min: 0,
          max: 10000000,
          majorUnit: 2000000,
          displayUnits: "millions",
        },
        dataLabels: { showValue: true, textStyle: { color: "#ABC123" } },
      }),
      before = P._internalPackageOf(f.p)
        .getPart(chartRoot(f.shape))
        .data.slice(),
      book = workbook(f.p, f.shape).data.slice(),
      r = paint(f);
    expect(r.labels(VL)).toHaveLength(0);
    const unit = r.nodes.find((e) => text(e) === "Millions"),
      bounds = P.getShapeBounds(f.shape);
    expect(unit).toBeTruthy();
    expect(num(unit, "x")).toBeGreaterThan(+bounds.x / 9525);
    expect(num(unit, "x")).toBeLessThan(+(bounds.x + bounds.w) / 9525);
    expect(r.labels("#ABC123")).toHaveLength(4);
    expect(r.nodes.some((e) => attr(e, "stroke") === "#9C52E4")).toBe(true);
    expect(r.ticks(V).length).toBeGreaterThan(0);
    expect(P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data).toEqual(
      before,
    );
    expect(workbook(f.p, f.shape).data).toEqual(book);
  });
  for (const kind of ["column", "bar"])
    for (const primaryMode of ["low", "high", "none"])
      for (const secondaryMode of ["low", "high", "none"])
        it(`${kind} combo keeps primary ${primaryMode} and secondary ${secondaryMode} labels independent`, async () => {
          const f = fixture(kind, {
              valueAxisTickLabelPos: primaryMode,
              secondaryValueAxisTickLabelPos: secondaryMode,
              valueAxisCrosses: { at: 2 },
              secondaryValueAxisCrosses: "max",
              secondaryValueAxisLineColor: "#245A41",
              textStyle: { color: VL, sizePt: 9 },
              secondaryCategoryAxisOrientation: "maxMin",
              series: [
                {
                  name: "Primary",
                  values: [2, 4, 3, 5],
                  color: S,
                  invertIfNegative: false,
                },
                {
                  name: "Secondary",
                  values: [20, 40, 30, 50],
                  color: "#2F8541",
                  secondaryAxis: true,
                  chartKind: kind === "column" ? "line" : "bar",
                  markerSymbol: "none",
                },
              ],
            }),
            // Author secondary visibility and its shared chart font explicitly;
            // primary label formatting must not control the secondary axis.
            r = paint(
              setChartAxisGridDeclarations(f, {
                secondaryValue: { hidden: false },
              }),
            ),
            all = r.labels(VL);
          const expected = [
            ...(primaryMode === "none" ? [] : [-2, 0, 2, 4, 6, 8, 10]),
            ...(secondaryMode === "none" ? [] : [0, 10, 20, 30, 40, 50, 60]),
          ];
          expect(all.map((e) => Number(text(e))).sort((a, b) => a - b)).toEqual(
            expected.sort((a, b) => a - b),
          );
          const sec = r.spine("#245A41");
          expect(sec).toBeTruthy();
          // Native outward rows reserve the primary row before positioning
          // the secondary spine, independently of fixed/hidden label modes.
          const stacked = primaryMode === "low" && secondaryMode !== "low";
          const row = kind === "bar" ? 20.4 : 25.6;
          expect(num(sec, kind === "bar" ? "y1" : "x1")).toBeCloseTo(
            (kind === "bar" ? r.plot.y + r.plot.h : r.plot.x) +
              (stacked ? (kind === "bar" ? row : -row) : 0),
            1,
          );
          const q = createDeck("blank"),
            copy = P.importSlide(q, f.slide, P.getSlideLayouts(q)[0]),
            back = P.importSlide(f.p, copy, P.getSlideLayout(f.slide));
          expect(P.getSlideCharts(back)[0].spec.valueAxisTickLabelPos).toBe(
            primaryMode,
          );
          expect(
            P.getSlideCharts(back)[0].spec.secondaryValueAxisTickLabelPos,
          ).toBe(secondaryMode);
          const reopened = await parseDeck(await P.savePresentation(f.p));
          expect(P.validatePresentation(reopened)).toEqual([]);
        });
});
