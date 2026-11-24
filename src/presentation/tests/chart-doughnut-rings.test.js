import { expect, it } from "vitest";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { P, createDeck } from "../src/model.js";
import {
  nativeDoughnutRingsDeck,
  ringColors,
} from "./chart-doughnut-rings-fixture.js";
import {
  chartLegendLayoutDeck,
  chartRoot,
  workbook,
} from "./chart-copy-fixture.js";
import { NativeChartWorkbook } from "../lib/pptx/src/internal/chartml/native-workbook.ts";
import {
  NS,
  parseXml,
  serializeXml,
  walkElements,
  firstChildElement,
  textContent,
  getAttrValue,
  qname,
} from "../lib/pptx/src/internal/xml/index.ts";
const attr = (e, n) => getAttrValue(e, qname("", n, ""));
function paint(f) {
  const svg = renderSlideToSvg(f.p, f.slide),
    nodes = [];
  walkElements(parseXml(svg).root, (e) => nodes.push(e));
  const slices = nodes
    .filter(
      (e) =>
        e.name.localName === "path" &&
        /A[\d.]/.test(attr(e, "d") ?? "") &&
        ringColors.includes(attr(e, "fill")),
    )
    .map((e) => ({
      color: attr(e, "fill"),
      d: attr(e, "d"),
      rule: attr(e, "fill-rule"),
      radii: [...attr(e, "d").matchAll(/A([\d.]+),([\d.]+)/g)].map(
        (m) => +m[1],
      ),
    }));
  const texts = nodes
    .filter((e) => e.name.localName === "text")
    .map((e) => ({
      text: e.children
        .filter((n) => n.kind === "text")
        .map((n) => n.data)
        .join(""),
      color: attr(e, "fill"),
      x: +attr(e, "x"),
      y: +attr(e, "y"),
    }));
  return { svg, slices, texts };
}
for (const n of [1, 2, 3, 5])
  for (const hole of [0, 1, 30, 90])
    for (const angle of [0, 87])
      it(`${n} imported rings with hole ${hole} and angle ${angle} retain equal radial widths and original series paint`, () => {
        const f = nativeDoughnutRingsDeck({
            values: Array.from({ length: n }, () => [2, 3]),
            hole,
            angle,
          }),
          r = paint(f),
          outer = Math.max(...r.slices.flatMap((s) => s.radii));
        expect(r.slices).toHaveLength(n * 2);
        for (let ring = 0; ring < n; ring++) {
          const paths = r.slices.filter((s) => s.color === ringColors[ring]);
          expect(paths).toHaveLength(2);
          for (const path of paths) {
            const expected = [
              (hole + ((100 - hole) * (ring + 1)) / n) / 100,
              ...(hole || ring
                ? [(hole + ((100 - hole) * ring) / n) / 100]
                : []),
            ];
            expect(path.radii).toHaveLength(expected.length);
            path.radii.forEach((radius, i) =>
              expect(radius / outer).toBeCloseTo(expected[i], 4),
            );
          }
        }
        const start = r.slices[0].d.match(
            hole ? /^M([\d.-]+),([\d.-]+)/ : /L([\d.-]+),([\d.-]+)/,
          ),
          end = r.slices[0].d.match(
            /A[\d.]+,[\d.]+ 0 [01] 1 ([\d.-]+),([\d.-]+)/,
          ),
          radius = r.slices[0].radii[0],
          theta = ((angle - 90) * Math.PI) / 180,
          next = theta + (2 / 5) * Math.PI * 2;
        // The endpoint difference is independent of the plot's location.
        expect((+end[1] - +start[1]) / radius).toBeCloseTo(
          Math.cos(next) - Math.cos(theta),
          3,
        );
        expect((+end[2] - +start[2]) / radius).toBeCloseTo(
          Math.sin(next) - Math.sin(theta),
          3,
        );
        expect(P.getShapeChartSpec(f.shape).holeSizePct).toBe(hole);
        expect(r.svg).not.toMatch(/NaN|Infinity|unsupported/);
      });
for (const middle of [null, [], [0, 0], [null, null]])
  it(`middle cache ${JSON.stringify(middle)} removes only absent ring slots`, () => {
    const r = paint(
        nativeDoughnutRingsDeck({ values: [[2, 3], middle, [4, 1]], hole: 30 }),
      ),
      outer = Math.max(...r.slices.flatMap((s) => s.radii)),
      count = middle === null ? 2 : 3;
    expect(r.slices).toHaveLength(4);
    const inner = r.slices.filter((s) => s.color === ringColors[0]),
      last = r.slices.filter((s) => s.color === ringColors[2]);
    expect(inner[0].radii[0] / outer).toBeCloseTo(0.3 + 0.7 / count, 4);
    expect(last[0].radii[1] / outer).toBeCloseTo(1 - 0.7 / count, 4);
  });
for (const kind of ["pie", "doughnut"])
  for (const values of [[5], [0, 7, 0], [null, 3], [-4]])
    it(`${kind} paints one complete circle for ${JSON.stringify(values)} without zero-value radial seams`, () => {
      const f = chartLegendLayoutDeck({
          kind,
          series: [{ name: "Only", values, color: ringColors[0] }],
          holeSizePct: 50,
        }),
        r = paint(f);
      expect(r.slices).toHaveLength(1);
      expect(r.slices[0].radii).toHaveLength(kind === "pie" ? 2 : 4);
      expect(r.slices[0].rule).toBe("evenodd");
      expect(r.slices[0].d).not.toContain(" L");
    });
for (const values of [
  [2, -4, 3],
  [-2, -4, -3],
  [1e308, -1e308, 1e308],
])
  it(`signed magnitudes ${JSON.stringify(values)} keep native slice geometry without changing source data`, () => {
    const positive = values.map((v) => Math.abs(v)),
      scaled = positive.map((v) => v / Math.max(...positive)),
      f = nativeDoughnutRingsDeck({ values: [values, [3, 2, 1]] }),
      want = nativeDoughnutRingsDeck({ values: [scaled, [3, 2, 1]] }),
      r = paint(f);
    expect(r.slices.map((s) => s.d)).toEqual(
      paint(want).slices.map((s) => s.d),
    );
    expect(P.getShapeChartSpec(f.shape).series[0].values).toEqual(values);
    expect(r.svg).not.toMatch(/NaN|Infinity/);
  });
it("series label flags, signed values, percent totals and text colors remain independent for each ring", () => {
  const f = nativeDoughnutRingsDeck({
      values: [
        [2, -3],
        [3, -7],
      ],
      labels: [
        { showValue: true, color: "#123ABC" },
        { showPercent: true, color: "#764321" },
      ],
    }),
    r = paint(f);
  expect(
    r.texts.filter((t) => t.color === "#123ABC").map((t) => t.text),
  ).toEqual(["2", "-3"]);
  expect(
    r.texts.filter((t) => t.color === "#764321").map((t) => t.text),
  ).toEqual(["30%", "-70%"]);
});
for (const explosion of [0, 25])
  it(`doughnut explosion ${explosion} applies only to the outer available ring`, () => {
    const f = nativeDoughnutRingsDeck({ explosions: [explosion, explosion] }),
      r = paint(f),
      base = paint(nativeDoughnutRingsDeck());
    expect(r.slices.filter((s) => s.color === ringColors[0])).toEqual(
      base.slices.filter((s) => s.color === ringColors[0]),
    );
    const outer = r.slices.filter((s) => s.color === ringColors[1]);
    if (explosion)
      expect(outer).not.toEqual(
        base.slices.filter((s) => s.color === ringColors[1]),
      );
    else
      expect(outer).toEqual(
        base.slices.filter((s) => s.color === ringColors[1]),
      );
  });
it("native omitted and canonical zero hole sizes share the same radial geometry", () => {
  const f = nativeDoughnutRingsDeck({ hole: null }),
    g = nativeDoughnutRingsDeck({ hole: 0 });
  expect(P.getShapeChartSpec(f.shape).holeSizePct).toBe(0);
  expect(P.getShapeChartSpec(g.shape).holeSizePct).toBe(0);
  expect(paint(f).svg).toBe(paint(g).svg);
});
for (const n of [2, 3, 5])
  for (const hole of [0, 50])
    it(`authors ${n} editable rings with hole ${hole}, transfers both ways and edits the copy independently`, async () => {
      const values = Array.from({ length: n }, (_, i) => [i + 2, null, i + 4]),
        f = chartLegendLayoutDeck({
          kind: "doughnut",
          holeSizePct: hole,
          series: values.map((v, i) => ({
            name: `Ring ${i + 1}`,
            values: v,
            color: ringColors[i],
            dataLabels: { showValue: i === 0, showPercent: i === 1 },
          })),
        }),
        source = P.getSlideCharts(f.slide)[0],
        raw = P._internalPackageOf(f.p)
          .getPart(chartRoot(source.shape))
          .data.slice(),
        book = workbook(f.p, source.shape).data.slice(),
        before = paint(f).svg;
      expect(source.spec.series.map((s) => s.values)).toEqual(values);
      const data = new NativeChartWorkbook(book);
      for (let i = 0; i < n; i++)
        expect(
          textContent(
            firstChildElement(
              data.cell("Sheet1", { row: 1, col: i + 1 }),
              qname("", "v", NS.sml),
            ),
          ),
        ).toBe(String(i + 2));
      const q = createDeck("blank"),
        to = P.importSlide(q, f.slide, P.getSlideLayouts(q)[0]),
        back = P.importSlide(f.p, to, P.getSlideLayout(f.slide)),
        copy = P.getSlideCharts(back)[0];
      expect(paint({ p: f.p, slide: back }).svg).toBe(before);
      P.setChartSpec(copy, {
        ...copy.spec,
        series: copy.spec.series.map((s, i) =>
          i === n - 1 ? { ...s, values: [9, 1] } : s,
        ),
      });
      expect(P.getShapeChartSpec(copy.shape).series[n - 1].values).toEqual([
        9, 1,
      ]);
      expect(workbook(f.p, copy.shape).name).not.toBe(
        workbook(f.p, source.shape).name,
      );
      expect(
        P._internalPackageOf(f.p).getPart(chartRoot(source.shape)).data,
      ).toEqual(raw);
      expect(workbook(f.p, source.shape).data).toEqual(book);
      expect(paint(f).svg).toBe(before);
      const saved = await P.loadPresentation(await P.savePresentation(f.p));
      expect(paint({ p: saved, slide: P.getSlides(saved)[0] }).svg).toBe(
        before,
      );
      expect(
        P.getSlideCharts(P.getSlides(saved)[1])[0].spec.series[n - 1].values,
      ).toEqual([9, 1]);
      expect(P.validatePresentation(saved)).toEqual([]);
    });
for (const hole of [-1, 91, NaN, Infinity])
  it(`rejects hole ${hole} before changing an editable multi-ring chart`, () => {
    const f = chartLegendLayoutDeck({
        kind: "doughnut",
        series: [
          { name: "One", values: [2, 3] },
          { name: "Two", values: [4, 1] },
        ],
      }),
      c = P.getSlideCharts(f.slide)[0],
      before = P._internalPackageOf(f.p).parts.map((p) => [
        p.name,
        p.data.slice(),
      ]);
    expect(() => P.setChartSpec(c, { ...c.spec, holeSizePct: hole })).toThrow();
    expect(
      P._internalPackageOf(f.p).parts.map((p) => [p.name, p.data]),
    ).toEqual(before);
  });
it("pie authoring keeps further series unplotted and editable", () => {
  const f = chartLegendLayoutDeck({
      kind: "pie",
      series: [
        { name: "One", values: [2, 3] },
        { name: "Two", values: [3, 1] },
      ],
    }),
    c = P.getSlideCharts(f.slide)[0];
  expect(c.spec.series.map((s) => s.name)).toEqual(["One", "Two"]);
  // An edit to the chart rebuilds it with both series.
  P.setChartSpec(c, { ...c.spec, title: "Shares" });
  const again = P.getSlideCharts(f.slide)[0].spec;
  expect(again.title).toBe("Shares");
  expect(again.series.map((s) => s.values)).toEqual([
    [2, 3],
    [3, 1],
  ]);
  // The legend names the first series' slices, not the series.
  const svg = renderSlideToSvg(f.p, f.slide);
  expect(svg).toContain(">North<");
  expect(svg).not.toContain(">Two<");
  expect(() => chartLegendLayoutDeck({ kind: "pie", series: [] })).toThrow(
    "pie chart requires at least one series",
  );
});

for (const kind of ["pie", "doughnut"])
  for (const enabled of [false, true])
    it(`${kind} editable rebuilds retain native data-label legend key ${enabled}`, () => {
      const f = chartLegendLayoutDeck({
          kind,
          dataLabels: { showValue: true },
          series: [
            {
              name: "Values",
              values: [2, 3],
              dataLabels: { showPercent: true },
            },
            ...(kind === "doughnut"
              ? [
                  {
                    name: "Outer",
                    values: [4, 1],
                    dataLabels: { showValue: true },
                  },
                ]
              : []),
          ],
        }),
        part = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)),
        root = parseXml(new TextDecoder().decode(part.data));
      walkElements(root.root, (e) => {
        if (
          e.name.namespaceURI === NS.chart &&
          e.name.localName === "showLegendKey"
        )
          e.attrs[0].value = enabled ? "1" : "0";
      });
      part.data = new TextEncoder().encode(serializeXml(root));
      const c = P.getSlideCharts(f.slide)[0];
      for (const patch of [
        { title: "Appearance" },
        {
          series: c.spec.series.map((s, i) => ({
            ...s,
            values: i ? [6, 4] : [8, 2],
          })),
        },
      ]) {
        P.setChartSpec(P.getSlideCharts(f.slide)[0], {
          ...P.getShapeChartSpec(f.shape),
          ...patch,
        });
        const keys = [];
        walkElements(
          parseXml(
            new TextDecoder().decode(
              P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data,
            ),
          ).root,
          (e) => {
            if (
              e.name.namespaceURI === NS.chart &&
              e.name.localName === "showLegendKey"
            )
              keys.push(attr(e, "val"));
          },
        );
        expect(keys.length).toBeGreaterThan(1);
        expect(keys.every((v) => v === (enabled ? "1" : "0"))).toBe(true);
      }
    });

for (const kind of ["pie", "doughnut"])
  for (const values of [
    [2, 0, -3],
    [0, -4, 0],
    [0, 0],
    [2, null, -3],
    [null, null],
  ])
    it(`${kind} signed and zero labels ${JSON.stringify(values)} retain values without degenerate slices`, () => {
      const f = chartLegendLayoutDeck({
          kind,
          series: [
            {
              name: "Signed",
              values,
              color: ringColors[0],
              dataLabels: {
                showValue: true,
                showPercent: true,
                showCategory: false,
                showSeriesName: false,
                separator: " | ",
                textStyle: { color: "#101010" },
              },
            },
          ],
        }),
        r = paint(f),
        total = values.reduce((sum, v) => sum + Math.abs(v ?? 0), 0);
      expect(
        r.texts.filter((t) => t.color === "#101010").map((t) => t.text),
      ).toEqual(
        values
          .filter((v) => v !== null)
          .map((v) => `${v} | ${(total ? (v / total) * 100 : 0).toFixed(0)}%`),
      );
      expect(r.slices).toHaveLength(
        values.filter((v) => v !== null && v !== 0).length,
      );
      expect(r.svg).not.toMatch(/NaN|Infinity/);
    });
