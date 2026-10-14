import { describe, expect, it } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import {
  parseXml,
  walkElements,
  getAttrValue,
  qname,
  NS,
  serializeXml,
} from "../lib/pptx/src/internal/xml/index.ts";
import {
  chartRoot,
  workbook,
  chartLegendLayoutDeck,
} from "./chart-copy-fixture.js";
import {
  chartRadarDataLabelDeck,
  chartRadarDataLabelPair,
  radarDataLabelColor,
  radarAlternateLabelColor,
  withRadarPointLabels,
} from "./chart-radar-data-label-fixture.js";
import { chartRenderingView } from "../lib/pptx/src/api/fn/charts.ts";

const attr = (e, name) => getAttrValue(e, qname("", name, ""));
function view(p, slide) {
  const elements = [];
  walkElements(
    parseXml(
      decodeURIComponent(preview(p, slide).split(",").slice(1).join(",")),
    ).root,
    (e) => elements.push(e),
  );
  return {
    elements,
    labels: (color = radarDataLabelColor) =>
      elements.filter(
        (e) => e.name.localName === "text" && attr(e, "fill") === color,
      ),
  };
}
const text = (e) =>
  e.children
    .filter((c) => c.kind === "text")
    .map((c) => c.data)
    .join("");
const strings = (f, color) => view(f.p, f.slide).labels(color).map(text);
const nativeLabels = (p, shape) => {
  const labels = [];
  walkElements(
    parseXml(
      new TextDecoder().decode(
        P._internalPackageOf(p).getPart(chartRoot(shape)).data,
      ),
    ).root,
    (e) => {
      if (e.name.namespaceURI === NS.chart && e.name.localName === "dLbls")
        labels.push(serializeXml({ root: e, prolog: [], epilog: [] }));
    },
  );
  return labels;
};

describe("native automatic radar data labels", () => {
  for (const kind of ["pie", "doughnut"])
    it(`${kind} retains automatic separator paint while preserving authored empty text`, () => {
      const make = (separator) => {
        const dataLabels = { showValue: true, showCategory: true, separator };
        return chartLegendLayoutDeck({
          kind,
          dataLabels,
          series: [{ name: "Signal", values: [2, 4, 6], dataLabels }],
        });
      };
      const empty = make(""),
        omitted = make(undefined);
      expect(preview(empty.p, empty.slide)).toBe(
        preview(omitted.p, omitted.slide),
      );
      expect(P.getShapeChartSpec(empty.shape).dataLabels.separator).toBe("");
    });

  for (const kind of [
    "radar",
    "column",
    "bar",
    "line",
    "area",
    "pie",
    "doughnut",
  ])
    it(`${kind} keeps an explicit empty separator distinct from omission through save`, async () => {
      const dataLabels = { showValue: true, showCategory: true, separator: "" },
        series = [{ name: "Signal", values: [2, 4, 6], dataLabels }],
        f =
          kind === "radar"
            ? chartRadarDataLabelDeck({ dataLabels, series })
            : chartLegendLayoutDeck({ kind, dataLabels, series });
      for (const p of [
        f.p,
        await P.loadPresentation(await P.savePresentation(f.p)),
      ]) {
        const spec = P.getSlideCharts(P.getSlides(p)[0])[0].spec;
        expect(spec.dataLabels.separator).toBe("");
        expect(spec.series[0].dataLabels.separator).toBe("");
        expect(P.validatePresentation(p)).toEqual([]);
      }
    });

  for (const radarStyle of ["standard", "marker", "filled"]) {
    for (const scope of ["group", "series"])
      it(`${radarStyle} resolves an empty ${scope} collection to native component defaults without rewriting the model`, () => {
        const f = chartRadarDataLabelDeck({ radarStyle, count: 4 });
        if (scope === "series") withRadarPointLabels(f, []);
        const part = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)),
          doc = parseXml(new TextDecoder().decode(part.data));
        walkElements(doc.root, (e) => {
          if (e.name.namespaceURI === NS.chart && e.name.localName === "dLbls")
            e.children = [];
        });
        part.data = new TextEncoder().encode(serializeXml(doc));
        const before = P.getShapeChartSpec(f.shape),
          raw = part.data.slice();
        expect(strings(f, "#000000")).toEqual([
          "Signal, A, 2",
          "Signal, B, 4",
          "Signal, C, 6",
          "Signal, D, 8",
        ]);
        expect(P.getShapeChartSpec(f.shape)).toEqual(before);
        expect(part.data).toEqual(raw);
      });

    for (const mode of ["implicit", "format", "category"])
      it(`${radarStyle} applies native point ${mode} defaults independently of its collection`, () => {
        const labels = {
            showValue: true,
            showCategory: false,
            showSeriesName: false,
            showPercent: false,
            numberFormat: "0.0",
            numberFormatSourceLinked: false,
            textStyle: {
              font: "Arial",
              sizePt: 12,
              color: radarDataLabelColor,
            },
          },
          flags =
            '<c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showLegendKey val="0"/><c:showBubbleSize val="0"/>',
          xml =
            mode === "implicit"
              ? ""
              : mode === "format"
                ? '<c:numFmt formatCode="0.00&quot; units&quot;" sourceLinked="0"/>' +
                  flags
                : flags
                    .replace('<c:showVal val="1"/>', '<c:showVal val="0"/>')
                    .replace(
                      '<c:showCatName val="0"/>',
                      '<c:showCatName val="1"/>',
                    ),
          f = withRadarPointLabels(
            chartRadarDataLabelDeck({
              radarStyle,
              count: 4,
              series: [
                {
                  name: "Signal",
                  values: [2, 4, 6, 8],
                  color: "#E85239",
                  dataLabels: labels,
                },
              ],
            }),
            [{ index: 2, xml }],
          );
        expect(strings(f)).toEqual(
          mode === "format"
            ? ["2.0", "4.0", "8.0"]
            : ["2.0", "4.0", mode === "implicit" ? "Signal, C, 6" : "C", "8.0"],
        );
        expect(strings(f, "#000000")).toEqual(
          mode === "format" ? ["6.00 units"] : [],
        );
        if (mode === "format")
          expect(
            attr(view(f.p, f.slide).labels("#000000")[0], "font-size"),
          ).toBe(String(10 * (4 / 3)));
      });

    it(`${radarStyle} respects point deletion, literal/cached/empty custom text and sparse overrides through transfer and save`, async () => {
      const f = withRadarPointLabels(
          chartRadarDataLabelDeck({ radarStyle, count: 8 }),
          [
            { index: 0, xml: "<c:delete/>" },
            {
              index: 1,
              xml: '<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Custom&lt;&amp;&gt;</a:t></a:r><a:br/><a:r><a:t>second</a:t></a:r></a:p></c:rich></c:tx><c:numFmt formatCode="0.000" sourceLinked="0"/><c:showVal val="1"/><c:showCatName val="1"/>',
            },
            {
              index: 2,
              xml: '<c:tx><c:strRef><c:f>Data!$A$1</c:f><c:strCache><c:ptCount val="4294967295"/><c:pt idx="4294967294"><c:v>opaque</c:v></c:pt><c:pt idx="0"><c:v>Cached&lt;&amp;&gt;</c:v></c:pt></c:strCache></c:strRef></c:tx>',
            },
            {
              index: 3,
              xml: "<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></c:rich></c:tx>",
            },
            {
              index: 4,
              xml: '<c:numFmt formatCode="0.00&quot; units&quot;" sourceLinked="0"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr b="1"><a:solidFill><a:srgbClr val="663399"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:pPr></a:p></c:txPr><c:showVal val="1"/><c:showCatName/><c:showSerName val="1"/><c:showPercent val="0"/><c:separator/>',
            },
            {
              index: 5,
              xml: '<c:showVal val="0"/><c:showCatName val="true"/>',
            },
          ],
        ),
        original = P.getShapeChartSpec(f.shape),
        xml = P._internalPackageOf(f.p)
          .getPart(chartRoot(f.shape))
          .data.slice(),
        book = workbook(f.p, f.shape).data.slice(),
        labelsXml = nativeLabels(f.p, f.shape);
      const check = (p, slide) => {
        const chart = P.getSlideCharts(slide)[0];
        expect(P.getShapeChartSpec(chart.shape)).toEqual(original);
        // Cross-deck transfer may add its explicit chart color-map override;
        // every native point label and its unknown content must remain exact.
        expect(nativeLabels(p, chart.shape)).toEqual(labelsXml);
        expect(workbook(p, chart.shape).data).toEqual(book);
        expect(strings({ p, slide }, "#000000")).toEqual([
          "Custom<&>",
          "second",
          "Cached<&>",
          "Signal, F",
          "8",
          "9",
        ]);
        expect(strings({ p, slide }, radarAlternateLabelColor)).toEqual([
          "Signal, E, 6.00 units",
        ]);
        const styled = view(p, slide).labels(radarAlternateLabelColor)[0];
        expect(attr(styled, "font-weight")).toBe("700");
        expect(attr(styled, "font-family")).not.toContain("+mn-lt");
        expect(P.validatePresentation(p)).toEqual([]);
      };
      check(f.p, f.slide);
      expect(
        P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data,
      ).toEqual(xml);
      const target = createDeck("blank"),
        slide = P.importSlide(target, f.slide, P.getSlideLayouts(target)[0], {
          preservePaintFormatting: true,
          preserveTextFormatting: true,
        });
      check(target, slide);
      const reopened = await P.loadPresentation(
        await P.savePresentation(target),
      );
      check(reopened, P.getSlides(reopened).at(-1));
      const back = P.importSlide(
        f.p,
        P.getSlides(reopened).at(-1),
        P.getSlideLayout(f.slide),
        { preservePaintFormatting: true, preserveTextFormatting: true },
      );
      check(f.p, back);
    });

    it(`${radarStyle} keeps a deleted series collection hidden despite a point delete=false`, () => {
      const f = withRadarPointLabels(
        chartRadarDataLabelDeck({ radarStyle }),
        [{ index: 2, xml: '<c:delete val="0"/>' }],
        { deleted: true },
      );
      expect(strings(f, "#000000")).toEqual([]);
    });

    it(`${radarStyle} bounds sparse indices and keeps the last duplicate without painting opaque records`, () => {
      const f = withRadarPointLabels(chartRadarDataLabelDeck({ radarStyle }), [
        { index: "-1", xml: "<c:delete/>" },
        { index: "1junk", xml: "<c:delete/>" },
        { index: "4294967296", xml: "<c:delete/>" },
        { index: "4294967295", xml: "<c:delete/>" },
        { index: 1, xml: "<c:delete/>" },
        { index: 1, xml: '<c:delete val="0"/>' },
      ]);
      expect([
        ...chartRenderingView(f.shape).dataLabelOverrides[0].points.keys(),
      ]).toEqual([4294967295, 1]);
      expect(strings(f, "#000000")).toEqual([
        "2",
        "Signal, B, 3.6",
        "5.2",
        "6.8",
        "8.4",
      ]);
    });

    for (const count of [3, 4, 5, 6, 8])
      for (const sizePt of [8, 12, 20])
        it(`${radarStyle} labels all ${count} finite values at ${sizePt}pt without mutating editable data`, () => {
          const f = chartRadarDataLabelDeck({ radarStyle, count, sizePt }),
            before = P.getShapeChartSpec(f.shape),
            xml = P._internalPackageOf(f.p)
              .getPart(chartRoot(f.shape))
              .data.slice(),
            book = workbook(f.p, f.shape).data.slice(),
            rendered = view(f.p, f.slide);
          expect(rendered.labels().map(text)).toEqual(
            before.series[0].values.map((v) => v.toFixed(1)),
          );
          for (const label of rendered.labels()) {
            expect(attr(label, "font-size")).toBe(String(sizePt * (4 / 3)));
            expect(attr(label, "text-anchor")).toBe("middle");
          }
          expect(P.getShapeChartSpec(f.shape)).toEqual(before);
          expect(
            P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data,
          ).toEqual(xml);
          expect(workbook(f.p, f.shape).data).toEqual(book);
        });

    for (let mask = 0; mask < 8; mask++)
      it(`${radarStyle} retains independent label components for mask ${mask}`, () => {
        const labels = {
            showSeriesName: !!(mask & 1),
            showCategory: !!(mask & 2),
            showValue: !!(mask & 4),
            showPercent: false,
            numberFormat: "0.0",
            textStyle: {
              font: "Arial",
              sizePt: 12,
              color: radarDataLabelColor,
            },
          },
          f = chartRadarDataLabelDeck({ radarStyle, dataLabels: labels }),
          spec = P.getShapeChartSpec(f.shape);
        expect(strings(f)).toEqual(
          mask
            ? spec.series[0].values.map((v, i) =>
                [
                  ...(labels.showSeriesName ? ["Signal"] : []),
                  ...(labels.showCategory ? [spec.categories[i]] : []),
                  ...(labels.showValue ? [v.toFixed(1)] : []),
                ].join(", "),
              )
            : [],
        );
      });

    for (const separator of ["", " | ", "\n"])
      it(`${radarStyle} preserves explicit ${JSON.stringify(separator)} separators and XML characters`, () => {
        const f = chartRadarDataLabelPair(radarStyle, "combined"),
          spec = P.getShapeChartSpec(f.shape);
        // Radar authoring remains read-only: build the requested input before
        // conversion instead of using the public mutation API.
        const single = chartRadarDataLabelDeck({
          radarStyle,
          categories: spec.categories,
          dataLabels: { ...spec.dataLabels, separator },
        });
        const expected = spec.series[0].values.flatMap((v, i) => {
          const parts = ["Signal", spec.categories[i], v.toFixed(1)];
          return separator === "\n" ? parts : [parts.join(separator || ", ")];
        });
        expect(strings(single)).toEqual(expected);
        expect(strings(single).join("")).toContain("A<&>");
      });

    for (const enabled of [false, true, undefined])
      it(`${radarStyle} resolves over-scale labels ${enabled} independently of blanks and zero`, () => {
        const f = chartRadarDataLabelDeck({
          radarStyle,
          showDataLabelsOverMaximum: enabled,
          series: [{ name: "Range", values: [-5, 0, null, 10, 15] }],
        });
        expect(strings(f)).toEqual(
          enabled === false ? ["0.0", "10.0"] : ["-5.0", "0.0", "10.0", "15.0"],
        );
        expect(P.getShapeChartSpec(f.shape).showDataLabelsOverMaximum).toBe(
          enabled,
        );
      });

    it(`${radarStyle} labels an isolated point without requiring a polygon`, () => {
      const f = chartRadarDataLabelDeck({
        radarStyle,
        series: [{ name: "Single", values: [null, null, 6, null, null] }],
      });
      expect(strings(f)).toEqual(["6.0"]);
    });

    for (const mode of ["value", "combined", "range"])
      // Transfers both ways with workbooks, and a save: heavy under load.
      it(`${radarStyle} ${mode} keeps labels, overrides and independent workbooks through transfer both ways and save`, async () => {
        const f = chartRadarDataLabelPair(radarStyle, mode),
          original = P.getSlideCharts(f.slide).map((c) => ({
            spec: c.spec,
            book: workbook(f.p, c.shape).data.slice(),
          })),
          expected = [strings(f), strings(f, radarAlternateLabelColor)],
          target = createDeck("blank"),
          slide = P.importSlide(target, f.slide, P.getSlideLayouts(target)[0], {
            preservePaintFormatting: true,
            preserveTextFormatting: true,
          });
        const check = (p, slide) => {
          const charts = P.getSlideCharts(slide);
          expect(charts).toHaveLength(2);
          expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(2);
          expect(
            new Set(charts.map((c) => workbook(p, c.shape).name)).size,
          ).toBe(2);
          charts.forEach((c, i) => {
            expect(c.spec).toEqual(original[i].spec);
            expect(workbook(p, c.shape).data).toEqual(original[i].book);
          });
          expect(view(p, slide).labels().map(text)).toEqual(expected[0]);
          expect(
            view(p, slide).labels(radarAlternateLabelColor).map(text),
          ).toEqual(expected[1]);
          expect(P.validatePresentation(p)).toEqual([]);
        };
        check(target, slide);
        const reopened = await P.loadPresentation(
          await P.savePresentation(target),
        );
        check(reopened, P.getSlides(reopened).at(-1));
        const back = P.importSlide(
          f.p,
          P.getSlides(reopened).at(-1),
          P.getSlideLayout(f.slide),
          {
            preservePaintFormatting: true,
            preserveTextFormatting: true,
          },
        );
        check(f.p, back);
      }, 30_000);
  }

  it("places labels radially outside their points and above opaque filled data", () => {
    for (const radarStyle of ["standard", "marker", "filled"])
      for (const valueAxis of [
        { min: 0, max: 10, majorUnit: 1 },
        { min: 0, max: 10, majorUnit: 5 },
        { min: -20, max: 20, majorUnit: 10 },
        { min: 100, max: 200, majorUnit: 25 },
      ]) {
        const f = chartRadarDataLabelDeck({
            radarStyle,
            count: 5,
            valueAxis,
            series: [
              {
                name: "Scaled",
                values: Array.from(
                  { length: 5 },
                  (_, i) =>
                    valueAxis.min +
                    (0.2 + i * 0.16) * (valueAxis.max - valueAxis.min),
                ),
                color: "#E85239",
              },
            ],
          }),
          rendered = view(f.p, f.slide),
          polygon = rendered.elements.find(
            (e) =>
              e.name.localName === "polygon" && attr(e, "stroke") === "#E85239",
          ),
          points = attr(polygon, "points")
            .split(" ")
            .map((p) => p.split(",").map(Number)),
          center = rendered.elements.find(
            (e) =>
              e.name.localName === "text" &&
              attr(e, "fill") === "#2468AC" &&
              text(e) === String(valueAxis.min),
          ),
          radius = (+attr(center, "y") - points[0][1]) * 5,
          second = rendered.labels()[1];
        expect(+attr(second, "x") - points[1][0]).toBeCloseTo(
          (radius * Math.cos(-Math.PI / 2 + (2 * Math.PI) / 5)) / 5,
          1,
        );
        expect(rendered.elements.indexOf(second)).toBeGreaterThan(
          rendered.elements.indexOf(polygon),
        );
      }
  });
});
