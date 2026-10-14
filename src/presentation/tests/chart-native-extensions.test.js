import { describe, it, expect } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import {
  chartExtensionDeck,
  chartRoot,
  chartGraph,
  workbook,
} from "./chart-copy-fixture.js";
import {
  NS,
  parseXml,
  serializeXml,
  firstChildElement,
  allChildElements,
  getAttrValue,
  qname,
  walkElements,
} from "../lib/pptx/src/internal/xml/index.ts";
import { preserveNativeChartExtensions } from "../lib/pptx/src/internal/chartml/native-extensions.ts";
import { buildChartSpaceDoc } from "../lib/pptx/src/internal/chartml/chart-builder.ts";
const c = (n) => qname("c", n, NS.chart),
  attr = (n) => qname("", n, "");
const doc = (f) =>
  parseXml(
    new TextDecoder().decode(
      P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data,
    ),
  );
const save = (f, d) => {
  P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data =
    new TextEncoder().encode(serializeXml(d));
};
const canonical = (e) => [
  e.name.namespaceURI,
  e.name.localName,
  e.attrs.map((a) => [a.name.namespaceURI, a.name.localName, a.value]).sort(),
  e.children.map((n) =>
    n.kind === "element" ? canonical(n) : [n.kind, n.data],
  ),
];
const slots = (f) => {
  const root = doc(f).root,
    chart = firstChildElement(root, c("chart")),
    area = firstChildElement(chart, c("plotArea"));
  return [
    root,
    chart,
    ...area.children
      .filter((n) => n.kind === "element")
      .flatMap((group) => allChildElements(group, c("ser"))),
  ].map((host) => {
    const ext = firstChildElement(host, c("extLst"));
    return ext ? canonical(ext) : null;
  });
};
const allExtensions = (f) => {
  const output = [];
  walkElements(doc(f).root, (e) => {
    if (e.name.namespaceURI === NS.chart && e.name.localName === "extLst")
      output.push(canonical(e));
  });
  return output;
};
const changeData = (f) => {
  const chart = P.getSlideCharts(f.slide)[0];
  P.setChartSpec(chart, {
    ...chart.spec,
    series: chart.spec.series.map((s, i) => ({
      ...s,
      name: `Edited ${i + 1}`,
      values: [17, null, 31],
    })),
  });
};
const snapshot = (f) =>
  P._internalPackageOf(f.p).parts.map((p) => [
    p.name,
    p.contentType,
    p.data.slice(),
  ]);

describe("native chart extension retention on surviving structural hosts", () => {
  for (const kind of ["bar", "column", "line", "area", "pie", "doughnut"])
    it(`${kind} data/name edits retain complete extension lists through export/reopen`, async () => {
      const f = chartExtensionDeck(kind),
        before = slots(f),
        allBefore = allExtensions(f);
      changeData(f);
      expect(slots(f)).toEqual(before);
      expect(allExtensions(f)).toEqual(allBefore);
      expect(P.getShapeChartSpec(f.shape).series[0].name).toBe("Edited 1");
      expect(P.getShapeChartSpec(f.shape).series[0].values).toEqual([
        17,
        null,
        31,
      ]);
      const reopened = await P.loadPresentation(await P.savePresentation(f.p)),
        slide = P.getSlides(reopened)[0],
        shape = P.getSlideCharts(slide)[0].shape;
      expect(slots({ p: reopened, shape })).toEqual(before);
      expect(allExtensions({ p: reopened, shape })).toEqual(allBefore);
      expect(P.validatePresentation(reopened)).toEqual([]);
      const d = doc({ p: reopened, shape });
      for (const host of [d.root, firstChildElement(d.root, c("chart"))])
        expect(
          host.children.filter((n) => n.kind === "element").at(-1).name
            .localName,
        ).toBe("extLst");
    });
  for (const kind of ["bar", "column", "line", "area", "pie", "doughnut"])
    // Two transfers, edits and saves per chart kind: heavy under load.
    it(`${kind} transfer both ways and returned-copy edits retain identities, relationships and original data`, async () => {
      const f = chartExtensionDeck(kind),
        before = slots(f),
        allBefore = allExtensions(f),
        original = snapshot(f),
        render = preview(f.p, f.slide),
        assets = chartGraph(f.p, chartRoot(f.shape))
          .filter((p) => p.contentType === "image/png")
          .map((p) => p.data.slice()),
        target = createDeck("blank"),
        forward = P.importSlide(target, f.slide, P.getSlideLayouts(target)[0], {
          preservePaintFormatting: true,
        }),
        shape = P.getSlideCharts(forward)[0].shape;
      expect(slots({ p: target, shape })).toEqual(before);
      expect(allExtensions({ p: target, shape })).toEqual(allBefore);
      const back = P.importSlide(f.p, forward, P.getSlideLayout(f.slide), {
          preservePaintFormatting: true,
        }),
        copy = P.getSlideCharts(back)[0];
      const originalBook = workbook(f.p, f.shape).data.slice();
      changeData({ p: f.p, slide: back, shape: copy.shape });
      expect(slots({ p: f.p, shape: copy.shape })).toEqual(before);
      expect(allExtensions({ p: f.p, shape: copy.shape })).toEqual(allBefore);
      expect(workbook(f.p, f.shape).data).toEqual(originalBook);
      expect(
        chartGraph(f.p, chartRoot(copy.shape))
          .filter((p) => p.contentType === "image/png")
          .map((p) => p.data),
      ).toEqual(assets);
      for (const [name, type, data] of original) {
        // Adding the copied slide legitimately changes presentation metadata;
        // every original chart dependency remains independently owned.
        if (chartGraph(f.p, chartRoot(f.shape)).some((p) => p.name === name))
          expect(P._internalPackageOf(f.p).getPart(name)).toMatchObject({
            contentType: type,
            data,
          });
      }
      expect(preview(f.p, f.slide)).toBe(render);
      const reopened = await P.loadPresentation(await P.savePresentation(f.p));
      expect(P.validatePresentation(reopened)).toEqual([]);
      expect(
        slots({
          p: reopened,
          shape: P.getSlideCharts(P.getSlides(reopened).at(-1))[0].shape,
        }),
      ).toEqual(before);
    }, 30_000);
  it("extension identities follow positional model series through reversed combo groups and nonsequential native indices", () => {
    const f = chartExtensionDeck("column", true),
      d = doc(f),
      area = firstChildElement(
        firstChildElement(d.root, c("chart")),
        c("plotArea"),
      );
    const groups = area.children.filter(
      (n) =>
        n.kind === "element" &&
        ["barChart", "lineChart"].includes(n.name.localName),
    );
    for (const [i, group] of groups.entries())
      firstChildElement(firstChildElement(group, c("ser")), c("idx")).attrs = [
        { name: attr("val"), value: String(19 + i * 11) },
      ];
    area.children = [
      ...groups.reverse(),
      ...area.children.filter((n) => !groups.includes(n)),
    ];
    save(f, d);
    const before = slots(f),
      names = P.getShapeChartSpec(f.shape).series.map((s) => s.name);
    changeData(f);
    const after = slots(f);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    const current = P.getShapeChartSpec(f.shape).series;
    const byModelIndex = (series) => {
      const root = doc(f).root,
        area = firstChildElement(
          firstChildElement(root, c("chart")),
          c("plotArea"),
        ),
        result = {};
      for (const group of area.children.filter((n) => n.kind === "element"))
        for (const s of allChildElements(group, c("ser")))
          result[
            Number(getAttrValue(firstChildElement(s, c("idx")), attr("val")))
          ] = canonical(firstChildElement(s, c("extLst")));
      return series.map((_, i) => result[i]);
    };
    expect(byModelIndex(current)).toEqual(before.slice(2));
    expect(names).toHaveLength(2);
  });
  it("removing all series does not revive their extension hosts, and newly added series get no stale record", () => {
    const f = chartExtensionDeck("column", true),
      chart = P.getSlideCharts(f.slide)[0],
      before = slots(f).slice(0, 2);
    P.setChartSpec(chart, { ...chart.spec, series: [] });
    expect(slots(f)).toEqual(before);
    const empty = P.getSlideCharts(f.slide)[0];
    P.setChartSpec(empty, {
      ...empty.spec,
      series: [{ name: "New", values: [5, 8, 13] }],
    });
    expect(slots(f)).toEqual([...before, null]);
  });
  it("adding series or clearing/repopulating a uniquely identified group retains its group metadata", () => {
    const f = chartExtensionDeck("column", true),
      chart = P.getSlideCharts(f.slide)[0],
      before = allExtensions(f);
    const groups = () => {
        const area = firstChildElement(
          firstChildElement(doc(f).root, c("chart")),
          c("plotArea"),
        );
        return new Map(
          area.children
            .filter(
              (n) =>
                n.kind === "element" &&
                ["barChart", "lineChart"].includes(n.name.localName),
            )
            .map((group) => [
              group.name.localName,
              canonical(firstChildElement(group, c("extLst"))),
            ]),
        );
      },
      original = groups();
    P.setChartSpec(chart, {
      ...chart.spec,
      series: [...chart.spec.series, { name: "Added", values: [5, 8, 13] }],
    });
    expect(allExtensions(f)).toEqual(before);
    const current = P.getSlideCharts(f.slide)[0];
    P.setChartSpec(current, { ...current.spec, series: [] });
    expect(groups().get("barChart")).toEqual(original.get("barChart"));
    const empty = P.getSlideCharts(f.slide)[0];
    P.setChartSpec(empty, {
      ...empty.spec,
      series: [{ name: "New", values: [1, 2, 3] }],
    });
    expect(groups().get("barChart")).toEqual(original.get("barChart"));
    expect(slots(f).at(-1)).toBeNull();
  });
  it("converting the series type retains chart-wide extensions without transplanting incompatible series records", () => {
    const f = chartExtensionDeck(),
      chart = P.getSlideCharts(f.slide)[0],
      before = slots(f).slice(0, 2);
    P.setChartSpec(chart, { ...chart.spec, kind: "line" });
    expect(slots(f)).toEqual([...before, null]);
  });
  it("bar-to-column conversion keeps extensions because both directions use the same native series type", () => {
    const f = chartExtensionDeck(),
      chart = P.getSlideCharts(f.slide)[0],
      before = slots(f);
    P.setChartSpec(chart, { ...chart.spec, kind: "column" });
    expect(slots(f)).toEqual(before);
    expect(P.getShapeChartSpec(f.shape).kind).toBe("column");
  });
  it("legend-entry extension records follow their indices through reordering and removal", () => {
    const f = chartExtensionDeck("column", true),
      chart = P.getSlideCharts(f.slide)[0];
    P.setChartSpec(chart, {
      ...chart.spec,
      legend: { ...chart.spec.legend, hiddenIndices: [1, 0] },
    });
    const d = doc(f),
      legend = firstChildElement(
        firstChildElement(d.root, c("chart")),
        c("legend"),
      ),
      expected = new Map();
    for (const entry of allChildElements(legend, c("legendEntry"))) {
      const idx = getAttrValue(firstChildElement(entry, c("idx")), attr("val")),
        ext = parseXml(
          `<c:extLst xmlns:c="${NS.chart}" xmlns:ce="urn:owned:legend-entry"><c:ext uri="urn:owned:entry"><ce:metadata owner="${idx}"/></c:ext></c:extLst>`,
        ).root;
      entry.children.push(ext);
      expected.set(Number(idx), canonical(ext));
    }
    save(f, d);
    const current = P.getSlideCharts(f.slide)[0];
    P.setChartSpec(current, {
      ...current.spec,
      legend: { ...current.spec.legend, hiddenIndices: [0, 1] },
    });
    const entries = allChildElements(
      firstChildElement(
        firstChildElement(doc(f).root, c("chart")),
        c("legend"),
      ),
      c("legendEntry"),
    );
    expect(
      entries.map((entry) =>
        Number(getAttrValue(firstChildElement(entry, c("idx")), attr("val"))),
      ),
    ).toEqual([0, 1]);
    for (const entry of entries)
      expect(canonical(firstChildElement(entry, c("extLst")))).toEqual(
        expected.get(
          Number(getAttrValue(firstChildElement(entry, c("idx")), attr("val"))),
        ),
      );
    P.setChartSpec(P.getSlideCharts(f.slide)[0], {
      ...P.getShapeChartSpec(f.shape),
      legend: { ...current.spec.legend, hiddenIndices: [1] },
    });
    expect(
      allChildElements(
        firstChildElement(
          firstChildElement(doc(f).root, c("chart")),
          c("legend"),
        ),
        c("legendEntry"),
      ),
    ).toHaveLength(1);
  }, 30_000);
  it("removed titles, axes, legends, labels, markers and trendlines do not regain extension hosts", () => {
    const f = chartExtensionDeck("line"),
      chart = P.getSlideCharts(f.slide)[0];
    P.setChartSpec(chart, {
      ...chart.spec,
      kind: "pie",
      title: undefined,
      legend: { position: null },
      dataLabels: undefined,
      series: chart.spec.series.map((s) => ({
        ...s,
        trendline: undefined,
        dataLabels: undefined,
        markerSymbol: undefined,
        markerSizePt: undefined,
      })),
    });
    const absent = new Set([
      "title",
      "legend",
      "catAx",
      "valAx",
      "dLbls",
      "marker",
      "trendline",
    ]);
    walkElements(doc(f).root, (e) => {
      if (e.name.namespaceURI === NS.chart)
        expect(absent.has(e.name.localName)).toBe(false);
    });
    expect(P.getShapeChartSpec(f.shape).kind).toBe("pie");
  });
  it("inherits prefixes referenced only by opaque attribute values after data editing", () => {
    const f = chartExtensionDeck();
    let expected = 0;
    walkElements(doc(f).root, (e) => {
      expected += e.attrs.filter((a) => a.value === "only:option").length;
    });
    changeData(f);
    const root = doc(f).root;
    let values = 0;
    function visit(e, bindings) {
      bindings = new Map([...bindings, ...e.prefixDecls]);
      for (const a of e.attrs)
        if (a.value === "only:option") {
          expect(bindings.get("only")).toBe("urn:owned:chart-extension-qname");
          values++;
        }
      for (const n of e.children) if (n.kind === "element") visit(n, bindings);
    }
    visit(root, new Map());
    expect(values).toBe(expected);
    expect(values).toBeGreaterThan(3);
  });
  it("unidentified native records remain opaque rather than receiving a guessed URI", () => {
    const f = chartExtensionDeck(),
      d = doc(f),
      ext = firstChildElement(firstChildElement(d.root, c("extLst")), c("ext"));
    ext.attrs = [];
    save(f, d);
    const before = slots(f);
    changeData(f);
    expect(slots(f)).toEqual(before);
  });
  it("complete replacement beyond the cache-reader limit retains extension records without materializing cache data", () => {
    const f = chartExtensionDeck(),
      chart = P.getSlideCharts(f.slide)[0],
      d = doc(f),
      before = slots(f);
    walkElements(d.root, (e) => {
      if (e.name.namespaceURI === NS.chart && e.name.localName === "ptCount")
        e.attrs = [{ name: attr("val"), value: "100000000" }];
    });
    save(f, d);
    expect(P.getShapeChartSpec(f.shape)).toBeNull();
    expect(() => P.setChartSpec(chart, chart.spec)).not.toThrow();
    expect(slots(f)).toEqual(before);
    expect(P.getShapeChartSpec(f.shape)).not.toBeNull();
  });
  it("rejected non-finite edits leave all native extension and dependency bytes unchanged", () => {
    const f = chartExtensionDeck(),
      chart = P.getSlideCharts(f.slide)[0],
      before = snapshot(f);
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() =>
        P.setChartSpec(chart, {
          ...chart.spec,
          series: [{ ...chart.spec.series[0], values: [1, value, 3] }],
        }),
      ).toThrow(/finite number/);
      expect(snapshot(f)).toEqual(before);
    }
  }, 30_000);
  for (const missing of ["plotArea", "chart"])
    it(`repairing a missing ${missing} retains metadata on the surviving outer hosts`, () => {
      const f = chartExtensionDeck(),
        chart = P.getSlideCharts(f.slide)[0],
        before = slots(f),
        d = doc(f),
        owner =
          missing === "chart" ? d.root : firstChildElement(d.root, c("chart"));
      owner.children = owner.children.filter(
        (n) =>
          n.kind !== "element" ||
          n.name.namespaceURI !== NS.chart ||
          n.name.localName !== missing,
      );
      save(f, d);
      expect(P.getShapeChartSpec(f.shape)).toBeNull();
      P.setChartSpec(chart, chart.spec);
      const after = slots(f);
      expect(after[0]).toEqual(before[0]);
      expect(after[1]).toEqual(missing === "chart" ? null : before[1]);
      expect(after[2]).toBeNull();
      expect(P.getShapeChartSpec(f.shape)).not.toBeNull();
      expect(P.validatePresentation(f.p)).toEqual([]);
    });
  it("merge inputs remain immutable and authored extension URIs take precedence while unrelated records survive", () => {
    const f = chartExtensionDeck(),
      original = doc(f),
      before = serializeXml(original),
      authored = buildChartSpaceDoc(P.getShapeChartSpec(f.shape)),
      chart = firstChildElement(authored.root, c("chart"));
    chart.children.push(
      parseXml(
        `<c:extLst xmlns:c="${NS.chart}" xmlns:new="urn:owned:authored"><c:ext uri="urn:owned:chart"><new:replacement value="edited"/></c:ext><c:ext uri="urn:owned:added"><new:metadata/></c:ext></c:extLst>`,
      ).root,
    );
    preserveNativeChartExtensions(original.root, authored.root);
    expect(serializeXml(original)).toBe(before);
    const list = firstChildElement(chart, c("extLst")),
      entries = allChildElements(list, c("ext"));
    expect(entries.map((e) => getAttrValue(e, attr("uri")))).toEqual([
      "{56B9EC1D-385E-4148-901F-78D8002777C0}",
      "urn:owned:chart",
      "urn:owned:added",
    ]);
    expect(entries[1].children[0].name.namespaceURI).toBe("urn:owned:authored");
    expect(entries[1].children[0].name.localName).toBe("replacement");
  });
});
