import { paintPlotGuides } from "./chart-plot-guides-fixture.js";
import { describe, it, expect } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import { chartRoot } from "./chart-copy-fixture.js";
import {
  parseXml,
  walkElements,
  getAttrValue,
  qname,
} from "../lib/pptx/src/internal/xml/index.ts";

const color = "#2672A6",
  axisColor = "#9152BD",
  categoryColor = "#A3472B";
const attr = (e, name) => getAttrValue(e, qname("", name, ""));
const text = (e) =>
  e.children
    .filter((c) => c.kind === "text")
    .map((c) => c.data)
    .join("");
function fixture(kind = "column", overrides = {}) {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0],
    shape = P.addSlideChart(slide, {
      x: P.inches(1),
      y: P.inches(0.6),
      w: P.inches(8),
      h: P.inches(5),
      spec: {
        kind,
        categories: ["North", "South", "West"],
        series: [{ name: "Units", color, values: [-3, 4, 8] }],
        valueAxis: { min: -5, max: 10, majorUnit: 5 },
        valueAxisOrientation: "minMax",
        valueAxisLineColor: axisColor,
        valueAxisLabelStyle: { color: axisColor },
        valueAxisMajorGridlines: true,
        valueAxisMajorGridlineColor: "#735192",
        categoryAxisLineColor: categoryColor,
        categoryAxisTickLabelPos: "none",
        categoryAxisLabelRotationDeg: 0,
        valueAxisLabelRotationDeg: 0,
        ...overrides,
      },
    });
  return { p, slide, shape };
}
function render(f) {
  paintPlotGuides(f);
  const svg = decodeURIComponent(
      preview(f.p, f.slide).split(",").slice(1).join(","),
    ),
    elements = [];
  walkElements(parseXml(svg).root, (e) => elements.push(e));
  const bar = P.getShapeChartSpec(f.shape).kind === "bar",
    spine = elements.find(
      (e) =>
        e.name.localName === "line" &&
        attr(e, "stroke") === axisColor &&
        (bar
          ? attr(e, "y1") === attr(e, "y2") && attr(e, "x1") !== attr(e, "x2")
          : attr(e, "x1") === attr(e, "x2") && attr(e, "y1") !== attr(e, "y2")),
    ),
    axis = bar ? "x" : "y",
    sum = Number(attr(spine, axis + "1")) + Number(attr(spine, axis + "2"));
  return { svg, elements, bar, sum, spine };
}
function reverse(f) {
  P.setChartSpec(P.getSlideCharts(f.slide)[0], {
    ...P.getShapeChartSpec(f.shape),
    valueAxisOrientation: "maxMin",
  });
}
function geometry(r) {
  return r.elements.filter(
    (e) =>
      ["rect", "path", "circle"].includes(e.name.localName) &&
      ([attr(e, "fill"), attr(e, "stroke")].includes(color) ||
        (e.name.localName === "rect" &&
          attr(e, "fill") === "#FFFFFF" &&
          attr(e, "stroke") === "#000000")),
  );
}
function assertReflected(a, b) {
  expect(b.sum).toBe(a.sum);
  const before = geometry(a),
    after = geometry(b);
  expect(after).toHaveLength(before.length);
  for (let i = 0; i < before.length; i++) {
    const e = before[i],
      f = after[i];
    expect(f.name.localName).toBe(e.name.localName);
    if (e.name.localName === "rect") {
      const coord = a.bar ? "x" : "y",
        extent = a.bar ? "width" : "height";
      expect(Number(attr(f, coord)) + Number(attr(f, extent))).toBeCloseTo(
        a.sum - Number(attr(e, coord)),
        1,
      );
      for (const key of [
        extent,
        a.bar ? "y" : "x",
        a.bar ? "height" : "width",
        "fill",
      ])
        expect(attr(f, key)).toBe(attr(e, key));
    } else if (e.name.localName === "path") {
      const points = (n) =>
          [...attr(n, "d").matchAll(/[-+]?\d+(?:\.\d+)?/g)].map((m) =>
            Number(m[0]),
          ),
        x = points(e),
        y = points(f);
      expect(y).toHaveLength(x.length);
      for (let j = 0; j < x.length; j++)
        expect(y[j]).toBeCloseTo(j % 2 === 1 ? a.sum - x[j] : x[j], 1);
    } else {
      expect(Number(attr(f, "cy"))).toBeCloseTo(
        a.sum - Number(attr(e, "cy")),
        1,
      );
      expect(attr(f, "cx")).toBe(attr(e, "cx"));
    }
  }
}
describe("native value-axis direction and crossing projection", () => {
  for (const kind of ["bar", "column", "line", "area"])
    for (const grouping of ["clustered", "stacked", "percentStacked"])
      it(`${kind} ${grouping} reverses value geometry without reversing categories or series data`, () => {
        const f = fixture(kind, { grouping }),
          before = render(f),
          spec = P.getShapeChartSpec(f.shape);
        reverse(f);
        const actual = P.getShapeChartSpec(f.shape);
        expect(actual.categories).toEqual(spec.categories);
        expect(actual.series).toEqual(spec.series);
        assertReflected(before, render(f));
      });
  it.each(["bar", "column", "line", "area"])(
    "%s reverses numeric labels and major gridlines with the same scale",
    (kind) => {
      const f = fixture(kind),
        before = render(f);
      reverse(f);
      const after = render(f),
        coord = before.bar ? "x" : "y";
      for (const e of before.elements.filter(
        (e) => e.name.localName === "text" && attr(e, "fill") === axisColor,
      )) {
        const t = after.elements.find(
          (t) =>
            t.name.localName === "text" &&
            attr(t, "fill") === axisColor &&
            text(t) === text(e),
        );
        expect(Number(attr(t, coord))).toBeCloseTo(
          before.sum - Number(attr(e, coord)),
          1,
        );
        expect(attr(t, "transform")).toBeNull();
      }
      const grids = (r) =>
        r.elements.filter(
          (e) => e.name.localName === "line" && attr(e, "stroke") === "#735192",
        );
      expect(grids(before).length).toBeGreaterThan(0);
      expect(grids(after)).toHaveLength(grids(before).length);
      grids(before).forEach((e, i) =>
        expect(Number(attr(grids(after)[i], coord + "1"))).toBeCloseTo(
          before.sum - Number(attr(e, coord + "1")),
          1,
        ),
      );
    },
  );
  for (const kind of ["bar", "column"])
    for (const direction of ["minMax", "maxMin"])
      for (const crossing of ["min", "max", "autoZero", { at: 3 }])
        it(`${kind} ${direction} locates the category spine at ${JSON.stringify(crossing)} on the value scale`, () => {
          const f = fixture(kind, {
              valueAxisOrientation: direction,
              categoryAxisCrosses: crossing,
            }),
            r = render(f),
            coord = r.bar ? "x" : "y",
            start = Number(attr(r.spine, coord + "1")),
            end = Number(attr(r.spine, coord + "2")),
            value =
              crossing === "min"
                ? -5
                : crossing === "max"
                  ? 10
                  : crossing === "autoZero"
                    ? 0
                    : crossing.at,
            fraction = (value + 5) / 15,
            forward = r.bar ? fraction : 1 - fraction,
            expected =
              start +
              (direction === "maxMin" ? 1 - forward : forward) * (end - start),
            cat = r.elements.find(
              (e) =>
                e.name.localName === "line" &&
                attr(e, "stroke") === categoryColor &&
                (r.bar
                  ? attr(e, "x1") === attr(e, "x2") &&
                    attr(e, "y1") !== attr(e, "y2")
                  : attr(e, "y1") === attr(e, "y2") &&
                    attr(e, "x1") !== attr(e, "x2")),
            );
          expect(Number(attr(cat, coord + "1"))).toBeCloseTo(expected, 1);
        });
  it("retains independent primary and secondary directions through transfer, export and edits", async () => {
    const f = fixture("column", {
        secondaryValueAxisOrientation: "maxMin",
        series: [
          { name: "Primary", values: [2, 4, 6] },
          {
            name: "Secondary",
            secondaryAxis: true,
            chartKind: "line",
            color,
            values: [20, 50, 80],
          },
        ],
      }),
      original = P.getShapeChartSpec(f.shape),
      q = createDeck("blank"),
      to = P.importSlide(q, f.slide, P.getSlideLayouts(q)[0]),
      back = P.importSlide(f.p, to, P.getSlideLayout(f.slide));
    expect(original.secondaryValueAxisOrientation).toBe("maxMin");
    for (const slide of [to, back])
      expect(P.getSlideCharts(slide)[0].spec).toEqual(original);
    const reopened = await P.loadPresentation(await P.savePresentation(q));
    expect(P.getSlideCharts(P.getSlides(reopened).at(-1))[0].spec).toEqual(
      original,
    );
    expect(P.validatePresentation(reopened)).toEqual([]);
    const source = P._internalPackageOf(f.p)
        .getPart(chartRoot(f.shape))
        .data.slice(),
      copied = P.getSlideCharts(back)[0];
    P.setChartSpec(copied, {
      ...copied.spec,
      secondaryValueAxisOrientation: "minMax",
    });
    expect(P.getShapeChartSpec(f.shape)).toEqual(original);
    expect(P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data).toEqual(
      source,
    );
  });
  for (const primary of ["minMax", "maxMin"])
    for (const secondary of ["minMax", "maxMin"])
      it(`mixed plots project independent ${primary}/${secondary} value directions`, () => {
        const series = [
            { name: "Primary", color, values: [2, 4, 6] },
            {
              name: "Secondary",
              chartKind: "line",
              secondaryAxis: true,
              color: "#E58325",
              values: [20, 50, 80],
            },
          ],
          baseline = render(fixture("column", { series })),
          actual = render(
            fixture("column", {
              series,
              valueAxisOrientation: primary,
              secondaryValueAxisOrientation: secondary,
            }),
          );
        if (primary === "maxMin") assertReflected(baseline, actual);
        else expect(geometry(actual)).toEqual(geometry(baseline));
        const path = (r) =>
            r.elements.find(
              (e) =>
                e.name.localName === "path" && attr(e, "stroke") === "#E58325",
            ),
          points = (e) =>
            [...attr(e, "d").matchAll(/[-+]?\d+(?:\.\d+)?/g)].map((m) =>
              Number(m[0]),
            ),
          a = points(path(baseline)),
          b = points(path(actual));
        expect(b).toHaveLength(a.length);
        for (let i = 0; i < a.length; i++)
          expect(b[i]).toBeCloseTo(
            i % 2 && secondary === "maxMin" ? baseline.sum - a[i] : a[i],
            1,
          );
      });
  for (const kind of ["bar", "column"])
    for (const position of ["ctr", "inEnd", "outEnd", "inBase"])
      it(`${kind} retains readable signed ${position} labels at the physical base/end after reversal`, () => {
        const f = fixture(kind, {
            valueAxisOrientation: "maxMin",
            dataLabels: { showValue: true, position },
          }),
          r = render(f),
          bars = geometry(r);
        for (const [i, value] of [-3, 4, 8].entries()) {
          const label = r.elements.find(
              (e) =>
                e.name.localName === "text" &&
                attr(e, "fill") !== axisColor &&
                text(e) === String(value),
            ),
            coordinate = Number(attr(label, r.bar ? "x" : "y")),
            start = Number(attr(bars[i], r.bar ? "x" : "y")),
            end = start + Number(attr(bars[i], r.bar ? "width" : "height"));
          if (position === "outEnd")
            expect(coordinate < start || coordinate > end).toBe(true);
          else expect(coordinate >= start && coordinate <= end).toBe(true);
          expect(attr(label, "transform")).toBeNull();
          if (r.bar && position !== "ctr")
            expect(attr(label, "text-anchor")).toBe(
              value < 0
                ? position === "inEnd"
                  ? "end"
                  : "start"
                : position === "inEnd"
                  ? "start"
                  : "end",
            );
        }
      });
  for (const kind of ["column", "line"])
    for (const type of ["linear", "exp", "log"])
      it(`${kind} projects its ${type} trendline from semantic values after fitting`, () => {
        const f = fixture(kind, {
            series: [
              {
                name: "Units",
                values: [2, 4, 8],
                color,
                trendline: { type, color: "#438643" },
              },
            ],
          }),
          before = render(f);
        reverse(f);
        const after = render(f),
          path = (r) =>
            r.elements.find(
              (e) =>
                e.name.localName === "path" && attr(e, "stroke") === "#438643",
            ),
          points = (e) =>
            [...attr(e, "d").matchAll(/[-+]?\d+(?:\.\d+)?/g)].map((m) =>
              Number(m[0]),
            ),
          a = points(path(before)),
          b = points(path(after));
        expect(b).toHaveLength(a.length);
        a.forEach((n, i) =>
          expect(b[i]).toBeCloseTo(i % 2 ? before.sum - n : n, 1),
        );
        if (type === "exp" && kind === "line") {
          // An exact exponential: the sampled curve passes through each
          // point (samples 0, 32 and 64 of 64 fall on them).
          const data = points(
            before.elements.find(
              (e) => e.name.localName === "path" && attr(e, "stroke") === color,
            ),
          );
          for (const [k, sample] of [0, 32, 64].entries()) {
            expect(a[sample * 2]).toBeCloseTo(data[k * 2], 1);
            expect(a[sample * 2 + 1]).toBeCloseTo(data[k * 2 + 1], 1);
          }
        }
      });
  for (const kind of ["bar", "column"])
    for (const rotation of [null, 0])
      it(`${kind} reserves room for reversed labels with ${rotation === null ? "automatic" : "explicit"} rotation`, () => {
        const f = fixture(kind, {
            valueAxisOrientation: "maxMin",
            valueAxis: { min: 0, max: 10 },
            series: [{ name: "Units", color, values: [2, 4, 8] }],
            categoryAxisTickLabelPos: "nextTo",
            categoryAxisLabelRotationDeg: rotation,
          }),
          r = render(f),
          labels = r.elements.filter(
            (e) =>
              e.name.localName === "text" &&
              ["North", "South", "West"].includes(text(e)),
          );
        expect(labels).toHaveLength(3);
        for (const label of labels) {
          if (kind === "column") {
            const y = Number(attr(label, "y")),
              half = Number(attr(label, "font-size")) / 2;
            expect(y - half).toBeGreaterThanOrEqual(57.6 + 8);
            expect(y).toBeLessThan(Number(attr(r.spine, "y1")));
          } else {
            expect(attr(label, "text-anchor")).toBe("start");
            expect(Number(attr(label, "x"))).toBeLessThan(864 - 8);
          }
        }
      });
  it.each(["valueAxisOrientation", "secondaryValueAxisOrientation"])(
    "rejects invalid %s atomically at the authoring boundary",
    (key) => {
      const f = fixture(),
        spec = P.getShapeChartSpec(f.shape),
        part = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)),
        native = part.data.slice();
      expect(() =>
        P.setChartSpec(P.getSlideCharts(f.slide)[0], {
          ...spec,
          [key]: "backwards",
        }),
      ).toThrow(/ST_Orientation/);
      expect(P.getShapeChartSpec(f.shape)).toEqual(spec);
      expect(part.data).toEqual(native);
    },
  );
  for (const kind of ["bar", "column"])
    for (const direction of ["minMax", "maxMin"])
      for (const position of ["low", "high"])
        it(`${kind} ${direction} ${position} labels follow their logical edge independently of crossing ticks`, () => {
          const f = fixture(kind, {
              valueAxisOrientation: direction,
              categoryAxisCrosses: { at: 3 },
              categoryAxisTickLabelPos: "nextTo",
            }),
            before = render(f);
          P.setChartSpec(P.getSlideCharts(f.slide)[0], {
            ...P.getShapeChartSpec(f.shape),
            categoryAxisTickLabelPos: position,
          });
          const r = render(f),
            labels = r.elements.filter(
              (e) =>
                e.name.localName === "text" &&
                ["North", "South", "West"].includes(text(e)),
            ),
            coord = r.bar ? "x" : "y",
            low = (position === "low") !== (direction === "maxMin");
          expect(labels).toHaveLength(3);
          for (const label of labels) {
            if (r.bar)
              expect(attr(label, "text-anchor")).toBe(low ? "end" : "start");
            const edge = Number(
              attr(
                r.spine,
                coord + (r.bar ? (low ? "1" : "2") : low ? "2" : "1"),
              ),
            );
            expect(
              (Number(attr(label, coord)) - edge) *
                (r.bar ? (low ? -1 : 1) : low ? 1 : -1),
            ).toBeGreaterThan(0);
          }
          // Label placement never changes the authored crossing value.
          expect(P.getShapeChartSpec(f.shape).categoryAxisCrosses).toEqual({
            at: 3,
          });
          expect(geometry(r)).toHaveLength(geometry(before).length);
        });
  it("projects smooth control points, markers, drop lines and high-low guides through the same value direction", () => {
    const f = fixture("line", {
        lineMarkers: true,
        dropLines: true,
        hiLowLines: true,
        series: [
          {
            name: "Units",
            color,
            values: [-3, 4, 8],
            smooth: true,
            markerSymbol: "circle",
          },
          { name: "Prior", color: "#E58325", values: [2, 6, 4] },
        ],
      }),
      before = render(f);
    reverse(f);
    const after = render(f);
    assertReflected(before, after);
    const guides = (r) =>
        r.elements.filter(
          (e) =>
            e.name.localName === "line" &&
            ["#9CA3AF", "#4B5563"].includes(attr(e, "stroke")),
        ),
      a = guides(before),
      b = guides(after);
    expect(a).toHaveLength(6);
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i++)
      for (const endpoint of ["1", "2"]) {
        expect(attr(b[i], "x" + endpoint)).toBe(attr(a[i], "x" + endpoint));
        expect(Number(attr(b[i], "y" + endpoint))).toBeCloseTo(
          before.sum - Number(attr(a[i], "y" + (endpoint === "1" ? "2" : "1"))),
          1,
        );
      }
  });
  it.each(["bar", "column", "line", "area"])(
    "%s keeps single/empty value domains finite after reversal",
    (kind) => {
      for (const values of [[7], []]) {
        const f = fixture(kind, {
          series: [{ name: "Units", color, values }],
          categories: values.length ? ["North"] : [],
        });
        reverse(f);
        const r = render(f);
        expect(r.svg).not.toMatch(/NaN|Infinity/);
        expect(P.getShapeChartSpec(f.shape).series[0].values).toEqual(values);
        expect(P.validatePresentation(f.p)).toEqual([]);
      }
    },
  );
  it.each(["bar", "column", "line", "area"])(
    "%s exports axis positions for its physical category/value dimensions",
    (kind) => {
      const f = fixture(kind),
        part = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)),
        axes = [];
      walkElements(parseXml(new TextDecoder().decode(part.data)).root, (e) => {
        if (["catAx", "valAx"].includes(e.name.localName)) axes.push(e);
      });
      const position = (axis) =>
        axis.children
          .find((e) => e.kind === "element" && e.name.localName === "axPos")
          .attrs.find((a) => a.name.localName === "val").value;
      expect(position(axes.find((e) => e.name.localName === "catAx"))).toBe(
        kind === "bar" ? "l" : "b",
      );
      expect(position(axes.find((e) => e.name.localName === "valAx"))).toBe(
        kind === "bar" ? "b" : "l",
      );
    },
  );
});
