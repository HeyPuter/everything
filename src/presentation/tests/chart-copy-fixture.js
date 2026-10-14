import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import {
  NS,
  parseXml,
  serializeXml,
  firstChildElement,
  qname,
  getAttrValue,
  walkElements,
} from "../lib/pptx/src/internal/xml/index.ts";
import { P, createDeck } from "../src/model.js";
import { resolveChartPartName } from "../lib/pptx/src/api/fn/charts.ts";
import { resolveTarget } from "../lib/pptx/src/internal/opc/index.ts";
import { REL_TYPES } from "../lib/pptx/src/internal/presentationml/index.ts";

export const chartRoot = (shape) =>
  resolveChartPartName(P.getShapeSlide(shape), shape).partName;

export function chartExplicitBooleanDeck(kind = "bar", value = false) {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0],
    shape = P.addSlideChart(slide, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(6),
      h: P.inches(3),
      spec: {
        kind,
        categories: ["First", "Second"],
        roundedCorners: value,
        categoryAxisNoMultiLevelLabel: value,
        series: [
          {
            name: "Units",
            values: [-3, 7],
            color: "#276491",
            invertIfNegative: value,
          },
        ],
      },
    });
  return { p, slide, shape };
}

export function chartLegendOrderDeck({ kind = "bar", ...options } = {}) {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0],
    shape = P.addSlideChart(slide, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(7),
      h: P.inches(4),
      spec: {
        kind,
        categories: ["East", "West"],
        series: [
          { name: "Alpha", values: [2, 4], color: "#E85239" },
          { name: "Beta", values: [3, 2], color: "#2F8541" },
          { name: "Gamma", values: [5, 3], color: "#376CA8" },
        ],
        legend: { position: "b" },
        ...options,
      },
    });
  return { p, slide, shape };
}

// Independently authored marker paint, including a hollow marker. Scatter and
// radar authoring is currently read-only, so native group/channel XML exercises
// their import/render/transfer paths without pretending the API can edit them.
export function chartMarkerPaintDeck(kind = "line") {
  const f = chartLineMarkersDeck({
    grouping: "clustered",
    legend: { position: "r" },
    series: [
      {
        name: "Alpha",
        values: [2, 4, 1],
        color: "#E85239",
        markerSymbol: "circle",
        markerSizePt: 6,
        markerFill: "#116699",
        markerStrokeColor: "#EA7423",
        markerStrokeWidthEmu: 9525,
      },
      {
        name: "Beta",
        values: [3, 2, 5],
        color: "#2F8541",
        markerSymbol: "square",
        markerSizePt: 12,
        markerFill: "#D9B231",
        markerStrokeColor: "#349185",
        markerStrokeWidthEmu: 19050,
      },
      {
        name: "Gamma",
        values: [1, 3, 2],
        color: "#376CA8",
        markerSymbol: "diamond",
        markerSizePt: 24,
        markerFill: null,
        markerStrokeColor: "#CC3344",
        markerStrokeWidthEmu: 38100,
      },
    ],
  });
  if (kind === "line") return f;
  const part = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)),
    doc = parseXml(new TextDecoder().decode(part.data)),
    child = (e, n) => firstChildElement(e, qname("c", n, NS.chart)),
    area = child(child(doc.root, "chart"), "plotArea"),
    group = child(area, "lineChart");
  group.name = qname("c", kind + "Chart", NS.chart);
  const style = child(group, "grouping");
  style.name = qname("c", kind + "Style", NS.chart);
  style.attrs[0].value = kind === "radar" ? "marker" : "lineMarker";
  group.children = group.children.filter(
    (e) =>
      e.kind !== "element" || !["marker", "smooth"].includes(e.name.localName),
  );
  if (kind === "scatter") {
    const cat = child(area, "catAx"),
      x = child(cat, "axId").attrs[0].value,
      y = child(child(area, "valAx"), "axId").attrs[0].value;
    area.children = area.children.map((e) =>
      e === cat
        ? parseXml(
            `<c:valAx xmlns:c="${NS.chart}"><c:axId val="${x}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="${y}"/></c:valAx>`,
          ).root
        : e,
    );
    for (const ser of group.children.filter(
      (e) => e.kind === "element" && e.name.localName === "ser",
    )) {
      const cat = child(ser, "cat"),
        value = child(ser, "val");
      value.name = qname("c", "yVal", NS.chart);
      ser.children = ser.children.map((e) =>
        e === cat
          ? parseXml(
              `<c:xVal xmlns:c="${NS.chart}"><c:numLit><c:ptCount val="3"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt><c:pt idx="2"><c:v>4</c:v></c:pt></c:numLit></c:xVal>`,
            ).root
          : e,
      );
    }
  }
  part.data = new TextEncoder().encode(serializeXml(doc));
  return f;
}

export function chartLegendLayoutDeck({
  sizePt = 32,
  position = "r",
  ...options
} = {}) {
  return chartLegendOrderDeck({
    kind: "bar",
    categories: ["North", "West", "South", "East"],
    series: [
      { name: "Alpha", values: [2, 4, 3, 5], color: "#E85239" },
      { name: "Beta", values: [3, 2, 4, 1], color: "#2F8541" },
      { name: "Gamma", values: [4, 1, 2, 3], color: "#376CA8" },
    ],
    categoryAxisLabelRotationDeg: null,
    valueAxisLabelRotationDeg: null,
    categoryAxisLabelStyle: { font: "Arial", sizePt },
    valueAxisLabelStyle: { font: "Arial", sizePt },
    valueAxis: { min: 0, max: 6, majorUnit: 1 },
    legend: {
      position,
      textStyle: { font: "Arial", sizePt },
      fill: "#FFF0D1",
      strokeColor: "#845B20",
    },
    plotAreaFill: "#ECF5E9",
    plotAreaStrokeColor: "#23916F",
    ...options,
  });
}

export function chartLineMarkersDeck(options = {}) {
  return chartLegendOrderDeck({
    kind: "line",
    grouping: "stacked",
    categories: ["First", "Middle", "Last"],
    series: [
      {
        name: "Alpha",
        values: [2, 4, 1],
        color: "#E85239",
        markerSymbol: "circle",
      },
      {
        name: "Beta",
        values: [3, 2, 5],
        color: "#2F8541",
        markerSymbol: "circle",
      },
      {
        name: "Gamma",
        values: [1, 3, 2],
        color: "#376CA8",
        markerSymbol: "circle",
      },
    ],
    lineMarkers: true,
    legend: undefined,
    categoryAxisLabelRotationDeg: 0,
    valueAxisLabelRotationDeg: 0,
    valueAxis: { min: 0, max: 20 },
    ...options,
  });
}

export function chartStackedBlanksDeck(options = {}) {
  const f = chartLineMarkersDeck({ dispBlanksAs: "gap", ...options }),
    chart = P.getSlideCharts(f.slide)[0];
  P.setChartSpec(chart, {
    ...chart.spec,
    series: chart.spec.series.map((s) => ({
      ...s,
      values: [s.values[0], null, s.values[2]],
    })),
  });
  return f;
}

// Native missing cells and #N/A cells share the numeric model's null projection,
// but their native cache/workbook records and line-display semantics differ.
export function chartLineGapsDeck({
  values = [2, 4, 3, null, 3, 1, 5],
  naIndices = [],
  dispNaAsBlank,
  smooth = true,
  ...options
} = {}) {
  const f = chartLineMarkersDeck({
      grouping: "standard",
      dispBlanksAs: "gap",
      categories: values.map((_, i) => `Category ${i + 1}`),
      valueAxis: { min: 0, max: 6 },
      series: [
        {
          name: "Units",
          values,
          color: "#376CA8",
          lineColor: "#376CA8",
          markerSymbol: "circle",
          markerFill: "#376CA8",
          markerSizePt: 6,
          smooth,
        },
      ],
      ...options,
    }),
    part = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)),
    doc = parseXml(strFromU8(part.data)),
    chart = firstChildElement(doc.root, qname("c", "chart", NS.chart));
  for (const index of naIndices) {
    if (values[index] !== null)
      throw new Error("A native error needs a null numeric projection");
  }
  walkElements(chart, (e) => {
    if (e.name.namespaceURI === NS.chart && e.name.localName === "numCache")
      for (const index of naIndices)
        e.children.push(
          parseXml(
            `<c:pt xmlns:c="${NS.chart}" idx="${index}"><c:v>#N/A</c:v></c:pt>`,
          ).root,
        );
  });
  if (dispNaAsBlank !== undefined)
    chart.children.push(
      parseXml(
        `<c:extLst xmlns:c="${NS.chart}" xmlns:c16r3="http://schemas.microsoft.com/office/drawing/2017/03/chart"><c:ext uri="{56B9EC1D-385E-4148-901F-78D8002777C0}"><c16r3:dataDisplayOptions16><c16r3:dispNaAsBlank val="${dispNaAsBlank ? 1 : 0}"/></c16r3:dataDisplayOptions16></c:ext></c:extLst>`,
      ).root,
    );
  part.data = strToU8(serializeXml(doc));
  if (naIndices.length) {
    const book = workbook(f.p, f.shape),
      entries = unzipSync(book.data),
      sheet = parseXml(strFromU8(entries["xl/worksheets/sheet1.xml"])),
      spreadsheet = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    walkElements(sheet.root, (e) => {
      if (e.name.namespaceURI !== spreadsheet || e.name.localName !== "row")
        return;
      const row = Number(getAttrValue(e, qname("", "r", "")));
      if (!naIndices.includes(row - 2)) return;
      const address = `B${row}`;
      e.children = e.children.filter(
        (c) =>
          c.kind !== "element" ||
          getAttrValue(c, qname("", "r", "")) !== address,
      );
      e.children.push(
        parseXml(
          `<c xmlns="${spreadsheet}" r="${address}" t="e"><v>#N/A</v></c>`,
        ).root,
      );
    });
    entries["xl/worksheets/sheet1.xml"] = strToU8(serializeXml(sheet));
    book.data = zipSync(entries);
  }
  return f;
}

// Owned ChartML and workbooks, with opaque styling and an external dependency.
// Different kinds and data distinguish independent logical charts.
export function chartCopyDeck({ grouped = false, transparent = false } = {}) {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0],
    pkg = P._internalPackageOf(p);
  for (const [i, kind] of ["bar", "line"].entries()) {
    const shape = P.addSlideChart(slide, {
      name: `Native chart ${i + 1}`,
      x: P.inches(1 + i * 5),
      y: P.inches(1),
      w: P.inches(4),
      h: P.inches(3),
      spec: {
        kind,
        ...(transparent
          ? {
              chartAreaFill: null,
              chartAreaStrokeColor: null,
              plotAreaFill: null,
              plotAreaStrokeColor: null,
            }
          : {}),
        categories: ["North", "South", "West"],
        series: [{ name: `Revenue ${i + 1}`, values: [4 + i, 9, -2] }],
      },
    });
    const name = chartRoot(shape),
      rels = pkg.getRels(name);
    const style = `/assets/chart/style-${i}.xml`;
    pkg.addPart(
      style,
      "application/vnd.ms-office.chartstyle+xml",
      new TextEncoder().encode(
        `<cs:chartStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" id="${201 + i}"><cs:future xmlns:cs="urn:owned:chart-extension" value="opaque-${i}"/></cs:chartStyle>`,
      ),
    );
    rels.items.push({
      id: "ownedStyle",
      type: "http://schemas.microsoft.com/office/2011/relationships/chartStyle",
      target: style,
      targetMode: "Internal",
    });
    rels.items.push({
      id: "ownedExternal",
      type: REL_TYPES.hyperlink,
      target: "https://example.com/chart-source",
      targetMode: "External",
    });
    pkg.setRels(name, rels);
  }
  if (grouped)
    P.groupShapes(P.getSlideShapes(slide), { name: "Native charts" });
  return { p, slide };
}

export function chartGraph(p, root) {
  const pkg = P._internalPackageOf(p),
    seen = new Map();
  function visit(name) {
    const part = pkg.getPart(name);
    if (!part) throw new Error(`Missing graph member ${name}`);
    if (seen.has(part.name.toLowerCase())) return;
    seen.set(part.name.toLowerCase(), part);
    for (const r of pkg.getRels(part.name)?.items ?? [])
      if (r.targetMode === "Internal")
        visit(resolveTarget(part.name, r.target));
  }
  visit(root);
  return [...seen.values()];
}

export function workbook(p, shape) {
  const pkg = P._internalPackageOf(p),
    name = chartRoot(shape),
    external = firstChildElement(
      parseXml(new TextDecoder().decode(pkg.getPart(name).data)).root,
      qname("c", "externalData", NS.chart),
    ),
    id = external && getAttrValue(external, qname("r", "id", NS.officeDocRels)),
    rel = pkg
      .getRels(name)
      ?.items.find((r) => r.id === id && r.type === REL_TYPES.package);
  if (!rel || rel.targetMode !== "Internal")
    throw new Error("Chart has no bound embedded workbook");
  return pkg.getPart(resolveTarget(name, rel.target));
}

export function chartDataDeck() {
  const f = chartCopyDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries())
    P.setChartSpec(chart, {
      ...chart.spec,
      categories: i ? ["Named category"] : [],
      series: [{ ...chart.spec.series[0], values: [4 + i, 9, -2, 17] }],
    });
  return f;
}

export function chartSeriesOutlineDeck() {
  const f = chartCopyDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries())
    P.setChartSpec(chart, {
      ...chart.spec,
      kind: i ? "column" : "bar",
      legend: { position: "b" },
      series: [
        {
          ...chart.spec.series[0],
          // The negative point is drawn in the series' own fill: these
          // decks are about outlines, not the inverted fill an omitted
          // invertIfNegative gives negative bars.
          invertIfNegative: false,
          color: "#23916F",
          lineColor: i ? "#B63874" : null,
          lineWidthEmu: i ? 38100 : 0,
          lineDash: "dash",
        },
        ...(i
          ? [
              {
                name: "Secondary",
                chartKind: "line",
                secondaryAxis: true,
                color: "#548BD2",
                lineColor: null,
                lineWidthEmu: 9525,
                markerSymbol: "circle",
                values: [2, 4, 8],
              },
            ]
          : []),
      ],
    });
  return f;
}

export function chartStrokeWidthDeck() {
  const f = chartCopyDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries())
    P.setChartSpec(chart, {
      ...chart.spec,
      kind: i ? "column" : "bar",
      categoryAxisLineColor: "#A84271",
      categoryAxisLineWidthEmu: i ? 19050 : 0,
      valueAxisLineColor: "#3166B8",
      valueAxisLineWidthEmu: i ? 28575 : 1,
      valueAxisMajorGridlines: true,
      valueAxisMajorGridlineColor: "#28A773",
      valueAxisMajorGridlineWidthEmu: i ? 38100 : 9525,
      valueAxisMinorGridlines: true,
      valueAxisMinorGridlineWidthEmu: 47625,
      categoryAxisMajorGridlines: true,
      categoryAxisMajorGridlineWidthEmu: 57150,
      categoryAxisMinorGridlines: true,
      categoryAxisMinorGridlineWidthEmu: 66675,
      plotAreaStrokeColor: "#D99622",
      plotAreaStrokeWidthEmu: i ? 76200 : 0,
      chartAreaStrokeColor: "#7543AA",
      chartAreaStrokeWidthEmu: i ? 85725 : 1,
      ...(i
        ? {
            secondaryValueAxisLineColor: "#C36929",
            secondaryValueAxisLineWidthEmu: 104775,
            secondaryCategoryAxisLineColor: null,
            secondaryCategoryAxisLineWidthEmu: 95250,
          }
        : {}),
      series: [
        ...chart.spec.series,
        ...(i
          ? [
              {
                name: "Secondary",
                chartKind: "line",
                secondaryAxis: true,
                values: [2, 4, 8],
              },
            ]
          : []),
      ],
    });
  return f;
}

export function chartCategorySpacingDeck() {
  const f = chartCopyDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries())
    P.setChartSpec(chart, {
      ...chart.spec,
      kind: i ? "column" : "line",
      valueAxisCrossBetween: i ? "between" : "midCat",
      ...(i ? { secondaryValueAxisCrossBetween: "midCat" } : {}),
      categoryAxisOrientation: i ? "maxMin" : "minMax",
      categoryAxisLabelRotationDeg: 0,
      categoryAxisLabelStyle: { color: i ? "#238F61" : "#713AC8" },
      categoryAxisLineColor: i ? "#238F61" : "#713AC8",
      categoryAxisMajorTickMark: "cross",
      categoryAxisMinorTickMark: "none",
      valueAxisHidden: true,
      series: [
        { ...chart.spec.series[0], color: i ? "#D57026" : "#346BA8" },
        ...(i
          ? [
              {
                name: "Secondary",
                color: "#28A883",
                chartKind: "line",
                secondaryAxis: true,
                values: [2, 4, 8],
              },
            ]
          : []),
      ],
    });
  return f;
}

export function chartCategoryOrderDeck() {
  const f = chartCopyDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries())
    P.setChartSpec(chart, {
      ...chart.spec,
      kind: i ? "column" : "bar",
      categoryAxisOrientation: "maxMin",
      ...(i ? { secondaryCategoryAxisOrientation: "minMax" } : {}),
      categoryAxisLabelRotationDeg: 0,
      categoryAxisLabelStyle: { color: i ? "#238F61" : "#713AC8" },
      categoryAxisMajorTickMark: "none",
      valueAxisHidden: true,
      series: [
        { ...chart.spec.series[0], color: i ? "#D57026" : "#346BA8" },
        ...(i
          ? [
              {
                name: "Secondary",
                color: "#28A883",
                chartKind: "line",
                secondaryAxis: true,
                values: [2, 4, 8],
              },
            ]
          : []),
      ],
    });
  return f;
}

export function chartAxisReferenceDeck() {
  const f = chartCopyDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries()) {
    P.setChartSpec(chart, {
      ...chart.spec,
      kind: i ? "line" : "column",
      valueAxis: { min: -5, max: 25, majorUnit: 5, numberFormat: "0.0" },
      valueAxisLineColor: "#9142B6",
      categoryAxisLabelRotationDeg: 0,
      valueAxisLabelRotationDeg: 0,
      series: [
        { ...chart.spec.series[0], ...(i ? {} : { secondaryAxis: true }) },
        {
          name: "Secondary",
          chartKind: i ? "column" : "line",
          secondaryAxis: true,
          values: [40, 90, 20],
        },
      ],
    });
    const part = P._internalPackageOf(f.p).getPart(chartRoot(chart.shape)),
      doc = parseXml(new TextDecoder().decode(part.data)),
      plot = firstChildElement(
        firstChildElement(doc.root, qname("", "chart", NS.chart)),
        qname("", "plotArea", NS.chart),
      ),
      axes = plot.children.filter(
        (e) =>
          e.kind === "element" &&
          e.name.namespaceURI === NS.chart &&
          e.name.localName === "valAx",
      );
    if (!i) {
      const categories = plot.children.filter(
          (e) =>
            e.kind === "element" &&
            e.name.namespaceURI === NS.chart &&
            e.name.localName === "catAx",
        ),
        categoryId = firstChildElement(
          categories[0],
          qname("", "axId", NS.chart),
        ).attrs[0].value,
        secondaryValueId = firstChildElement(
          axes[1],
          qname("", "axId", NS.chart),
        ).attrs[0].value;
      // Shared category axes do not require reciprocal crossing references.
      // Keep the unused primary value axis crossing that same category axis.
      plot.children = plot.children.filter((e) => e !== categories[1]);
      firstChildElement(
        categories[0],
        qname("", "crossAx", NS.chart),
      ).attrs[0].value = secondaryValueId;
      firstChildElement(
        axes[1],
        qname("", "crossAx", NS.chart),
      ).attrs[0].value = categoryId;
      for (const group of plot.children) {
        if (
          group.kind !== "element" ||
          group.name.namespaceURI !== NS.chart ||
          !["barChart", "lineChart"].includes(group.name.localName)
        )
          continue;
        firstChildElement(group, qname("", "axId", NS.chart)).attrs[0].value =
          categoryId;
      }
    }
    plot.children = plot.children.filter((e) => !axes.includes(e));
    plot.children.push(...axes.reverse());
    // Axis definitions and plot references may use different lexical
    // spellings of the same unsigned integer identifier.
    for (const axis of plot.children) {
      if (
        axis.kind !== "element" ||
        axis.name.namespaceURI !== NS.chart ||
        !["catAx", "valAx"].includes(axis.name.localName)
      )
        continue;
      const id = firstChildElement(axis, qname("", "axId", NS.chart));
      id.attrs[0].value = `00${id.attrs[0].value}`;
    }
    part.data = new TextEncoder().encode(serializeXml(doc));
  }
  return f;
}

export function chartValueOrderDeck() {
  const f = chartCopyDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries()) {
    P.setChartSpec(chart, {
      ...chart.spec,
      kind: i ? "column" : "bar",
      valueAxis: { min: 0, max: 10, majorUnit: 2 },
      valueAxisOrientation: i ? "minMax" : "maxMin",
      secondaryValueAxisOrientation: "maxMin",
      valueAxisCrosses: i ? { at: 3 } : "autoZero",
      valueAxisLabelStyle: { color: "#9152BD" },
      categoryAxisLabelStyle: { color: "#A3472B" },
      categoryAxisTickLabelPos: i ? "none" : "nextTo",
      categoryAxisLabelRotationDeg: 0,
      valueAxisLabelRotationDeg: 0,
      series: [
        { name: "Units", color: "#2672A6", values: [2, 4, 8] },
        ...(i
          ? [
              {
                name: "Secondary",
                chartKind: "line",
                secondaryAxis: true,
                color: "#E58325",
                values: [20, 50, 80],
              },
            ]
          : []),
      ],
    });
  }
  return f;
}

export function chartCategoryTickDeck() {
  const f = chartCopyDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries())
    P.setChartSpec(chart, {
      ...chart.spec,
      categoryAxisLineColor: i ? "#238F61" : "#713AC8",
      categoryAxisMajorTickMark: i ? "in" : "cross",
      categoryAxisMinorTickMark: "none",
      categoryAxisTickMarkSkip: 2,
      categoryAxisTickLabelSkip: 3,
      categoryAxisTickLabelPos: i ? "nextTo" : "none",
      valueAxisHidden: true,
    });
  return f;
}

export function chartAxisPaintDeck() {
  const f = chartCopyDeck();
  for (const chart of P.getSlideCharts(f.slide))
    P.setChartSpec(chart, {
      ...chart.spec,
      categoryAxisLineColor: null,
      valueAxisLineColor: null,
      categoryAxisMajorGridlineColor: null,
      categoryAxisMinorGridlineColor: null,
      valueAxisMajorGridlineColor: null,
      valueAxisMinorGridlineColor: null,
      categoryAxisMajorGridlines: true,
      categoryAxisMinorGridlines: true,
      valueAxisMajorGridlines: true,
      valueAxisMinorGridlines: true,
    });
  return f;
}

export function chartCacheDeck() {
  const f = chartDataDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries())
    P.setChartSpec(chart, {
      ...chart.spec,
      series: [
        { ...chart.spec.series[0], values: [4 + i, null, -2, null, null] },
      ],
    });
  return f;
}

// Different native theme overrides plus a transform prevent an accent-palette
// fallback from accidentally passing an app clipboard rendering control.
export function chartColorDeck() {
  const f = chartCopyDeck(),
    pkg = P._internalPackageOf(f.p);
  const theme = pkg.parts.find(
    (p) =>
      p.contentType ===
      "application/vnd.openxmlformats-officedocument.theme+xml",
  );
  const child = (r, n, ns = NS.dml) => firstChildElement(r, qname("", n, ns));
  for (const [i, shape] of P.getSlideShapes(f.slide).entries()) {
    const part = pkg.getPart(chartRoot(shape)),
      doc = parseXml(new TextDecoder().decode(part.data));
    const series = child(
      child(child(doc.root, "chart", NS.chart), "plotArea", NS.chart),
      i ? "lineChart" : "barChart",
      NS.chart,
    );
    const ser = child(series, "ser", NS.chart),
      sp = child(ser, "spPr", NS.chart),
      solid = child(sp, "solidFill");
    solid.children = parseXml(
      `<a:solidFill xmlns:a="${NS.dml}"><a:schemeClr val="accent1"><a:inv/></a:schemeClr></a:solidFill>`,
    ).root.children;
    part.data = new TextEncoder().encode(serializeXml(doc));
    const colors = structuredClone(
      child(
        child(
          parseXml(new TextDecoder().decode(theme.data)).root,
          "themeElements",
        ),
        "clrScheme",
      ),
    );
    child(child(colors, "accent1"), "srgbClr").attrs.find(
      (a) => a.name.localName === "val",
    ).value = i ? "00FF00" : "FF0000";
    const override = parseXml(`<a:themeOverride xmlns:a="${NS.dml}"/>`);
    override.root.children.push(colors);
    const name = `/assets/chart/theme-${i}.xml`;
    pkg.addPart(
      name,
      "application/vnd.openxmlformats-officedocument.themeOverride+xml",
      new TextEncoder().encode(serializeXml(override)),
    );
    const rels = pkg.getRels(part.name);
    rels.items.push({
      id: "ownedTheme",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/themeOverride",
      target: name,
      targetMode: "Internal",
    });
    pkg.setRels(part.name, rels);
  }
  return f;
}

// Theme-font inheritance and an unmeasured packaged title face exercise every
// part of chart font resolution without depending on the corpus or a local font cache.
export function chartFontDeck() {
  const f = chartCopyDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries()) {
    P.setChartSpec(chart, {
      ...chart.spec,
      textStyle: { font: "+mn-lt" },
      title: `Chart typography ${i + 1}`,
      titleStyle: { font: "Raleway", bold: true, italic: true },
      legend: { position: "b" },
      dataLabels: { showValue: true, textStyle: { font: "Arial" } },
    });
    const name = `/assets/chart/font-${i}.xml`;
    P._internalPackageOf(f.p).addPart(
      name,
      "application/vnd.openxmlformats-officedocument.themeOverride+xml",
      new TextEncoder().encode(
        `<a:themeOverride xmlns:a="${NS.dml}"><a:fontScheme name="Owned chart fonts"><a:majorFont><a:latin typeface="Times New Roman"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${i ? "Georgia" : "Courier New"}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme></a:themeOverride>`,
      ),
    );
    const pkg = P._internalPackageOf(f.p),
      root = chartRoot(chart.shape),
      rels = pkg.getRels(root);
    rels.items.push({
      id: "ownedFonts",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/themeOverride",
      target: name,
      targetMode: "Internal",
    });
    pkg.setRels(root, rels);
  }
  return f;
}

// Legend containers have paint independent of their series' keys and labels.
export function chartLegendPaintDeck() {
  const { p, slide } = chartCopyDeck();
  P.getSlideCharts(slide).forEach((chart, i) => {
    P.setChartSpec(chart, {
      ...chart.spec,
      legend: {
        position: i ? "r" : "b",
        fill: i ? null : "#ECD8B0",
        strokeColor: i ? "#1A8E74" : "#5438A8",
        strokeWidthEmu: i ? 1 : 38100,
        textStyle: { sizePt: 12.5, color: "#112233" },
      },
    });
  });
  return { p, slide };
}

export function chartNumberFormatDeck() {
  const f = chartCopyDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries())
    P.setChartSpec(chart, {
      ...chart.spec,
      kind: "column",
      categories: ["0.125", "0.25", "0.5"],
      categoryNumberFormat: "0.0%",
      categoryAxisNumberFormat: "0.00",
      categoryAxisNumberFormatSourceLinked: !i,
      valueAxis: {
        min: 0,
        max: 0.8,
        majorUnit: 0.2,
        numberFormat: "0.00",
        numberFormatSourceLinked: !i,
      },
      series: [
        {
          name: i ? "Fixed" : "Linked",
          values: [0.2, 0.4, 0.6],
          numberFormat: "0.0%",
          color: i ? "#238F61" : "#713AC8",
          dataLabels: {
            showValue: true,
            numberFormat: "0.00",
            numberFormatSourceLinked: !i,
          },
        },
      ],
      dataLabels: { showValue: true },
    });
  return f;
}

// Binding IDs and relationship order are independent of part type. A decoy
// workbook must remain untouched even when it precedes the actual source.
export function chartWorkbookBindingDeck(kind = "bar") {
  const f = chartCopyDeck(),
    pkg = P._internalPackageOf(f.p);
  for (const [i, chart] of P.getSlideCharts(f.slide).entries()) {
    if (i === 0 && kind !== chart.spec.kind)
      P.setChartSpec(chart, { ...chart.spec, kind });
    const root = chartRoot(chart.shape),
      bound = workbook(f.p, chart.shape),
      rels = pkg.getRels(root),
      id = i ? "WorkbookSource" : "rId7";
    rels.items.find((r) => r.type === REL_TYPES.package).id = id;
    rels.items.find((r) => r.id === "ownedStyle").id = "rId1";
    const decoy = `/assets/chart/unbound-data-${i}.xlsx`;
    pkg.addPart(decoy, bound.contentType, bound.data.slice());
    rels.items.unshift({
      id: "unusedData",
      type: REL_TYPES.package,
      target: decoy,
      targetMode: "Internal",
    });
    pkg.setRels(root, rels);
    const part = pkg.getPart(root),
      doc = parseXml(new TextDecoder().decode(part.data)),
      external = firstChildElement(
        doc.root,
        qname("c", "externalData", NS.chart),
      );
    external.attrs = [{ name: qname("r", "id", NS.officeDocRels), value: id }];
    if (i) external.children = [];
    else
      firstChildElement(
        external,
        qname("c", "autoUpdate", NS.chart),
      ).attrs[0].value = "1";
    part.data = new TextEncoder().encode(serializeXml(doc));
  }
  return f;
}

// c14 (office2010) and legacy preset identities, with native opaque compatibility choices.
export function chartStyleDeck() {
  const f = chartWorkbookBindingDeck();
  for (const [i, chart] of P.getSlideCharts(f.slide).entries()) {
    P.setChartSpec(chart, {
      ...chart.spec,
      chartStyle: i ? 37 : 19,
      ...(i ? {} : { chartStyleVariant: "office2010" }),
    });
    const part = P._internalPackageOf(f.p).getPart(chartRoot(chart.shape)),
      d = parseXml(new TextDecoder().decode(part.data)),
      slot = d.root.children.find(
        (e) =>
          e.kind === "element" &&
          ((e.name.namespaceURI === NS.mc &&
            e.name.localName === "AlternateContent") ||
            (e.name.namespaceURI === NS.chart && e.name.localName === "style")),
      );
    d.root.prefixDecls.set("future", "urn:owned:chart-style");
    slot.attrs.push({
      name: qname("future", "source", "urn:owned:chart-style"),
      value: "future:local",
    });
    if (!i)
      slot.children.unshift(
        parseXml(
          `<mc:Choice xmlns:mc="${NS.mc}" xmlns:future="urn:owned:chart-style" Requires="future"><future:style val="900"/></mc:Choice>`,
        ).root,
      );
    part.data = new TextEncoder().encode(serializeXml(d));
  }
  return f;
}

// Native text bodies retain script fonts, scheme paints, paragraph/body options
// and opaque payloads. Deliberately different defaults expose accidental slot
// reassociation when combo groups or axes are reordered.
export function chartTextDeck(kind = "bar", combo = false) {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0];
  const shape = P.addSlideChart(slide, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(5),
    h: P.inches(4),
    spec: {
      kind,
      categories: ["North", "South", "West"],
      textStyle: { sizePt: 11 },
      legend: { position: "b", textStyle: { sizePt: 12 } },
      categoryAxisLabelStyle: { sizePt: 13 },
      valueAxisLabelStyle: { sizePt: 14 },
      dataLabels: { showValue: true, textStyle: { sizePt: 15 } },
      series: [
        {
          name: "Primary",
          values: [4, 9, -2],
          dataLabels: { showValue: true, textStyle: { sizePt: 16 } },
        },
        ...(combo
          ? [
              {
                name: "Secondary",
                values: [2, 3, 5],
                chartKind: "line",
                secondaryAxis: true,
                dataLabels: { showValue: true, textStyle: { sizePt: 17 } },
              },
            ]
          : []),
      ],
    },
  });
  const part = P._internalPackageOf(p).getPart(chartRoot(shape)),
    d = parseXml(new TextDecoder().decode(part.data)),
    root = d.root;
  root.prefixDecls.set("future", "urn:owned:chart-text");
  const chart = firstChildElement(root, qname("c", "chart", NS.chart)),
    area = firstChildElement(chart, qname("c", "plotArea", NS.chart));
  const hosts = [];
  function collect(e) {
    if (firstChildElement(e, qname("c", "txPr", NS.chart))) hosts.push(e);
    for (const n of e.children) if (n.kind === "element") collect(n);
  }
  collect(root);
  for (const axis of area.children.filter(
    (n) =>
      n.kind === "element" &&
      n.name.namespaceURI === NS.chart &&
      ["catAx", "valAx"].includes(n.name.localName),
  ))
    if (!hosts.includes(axis)) hosts.push(axis);
  for (const [i, host] of hosts.entries()) {
    const properties = `<a:defRPr sz="${1100 + i * 100}" b="${i % 2}" i="0" u="dbl" strike="sngStrike" kern="1200" spc="25" baseline="0"><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill><a:latin typeface="+mn-lt" pitchFamily="34"/><a:ea typeface="Yu Mincho"/><a:cs typeface="Arial"/><a:extLst><a:ext uri="urn:owned:text"><future:payload token="future:local"/></a:ext></a:extLst></a:defRPr>`;
    const txPr = parseXml(
      `<c:txPr xmlns:c="${NS.chart}" xmlns:a="${NS.dml}" xmlns:future="urn:owned:chart-text" future:slot="${i}"><a:bodyPr rot="${host.name.localName.endsWith("Ax") ? -60000000 : 0}" anchor="ctr" anchorCtr="1" wrap="none" rtlCol="1" lIns="7315"/><a:lstStyle/><a:p><a:pPr algn="ctr" rtl="1">${properties}</a:pPr><a:endParaRPr lang="ja-JP" dirty="0"/></a:p></c:txPr>`,
    ).root;
    const old = firstChildElement(host, qname("c", "txPr", NS.chart));
    if (old) host.children = host.children.map((n) => (n === old ? txPr : n));
    else {
      const index = host.children.findIndex(
        (n) =>
          n.kind === "element" &&
          n.name.namespaceURI === NS.chart &&
          n.name.localName === "crossAx",
      );
      host.children.splice(index < 0 ? host.children.length : index, 0, txPr);
    }
  }
  // A native chart-local color map must keep scheme paints meaningful on edit.
  const map = parseXml(
    `<c:clrMapOvr xmlns:c="${NS.chart}" bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent3" accent2="accent2" accent3="accent1" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`,
  ).root;
  root.children.splice(root.children.indexOf(chart), 0, map);
  part.data = new TextEncoder().encode(serializeXml(d));
  return { p, slide, shape };
}

export function chartPaintDeck(kind = "bar", combo = false) {
  const f = chartTextDeck(kind, combo),
    chart = P.getSlideCharts(f.slide)[0];
  P.setChartSpec(chart, {
    ...chart.spec,
    title: "Native paints",
    categoryAxisTitle: "Categories",
    valueAxisTitle: "Values",
    chartAreaFill: "#AC7139",
    chartAreaStrokeColor: "#4F632D",
    chartAreaStrokeWidthEmu: 12700,
    plotAreaFill: "#293847",
    plotAreaStrokeColor: "#82B492",
    plotAreaStrokeWidthEmu: 19050,
    legend: {
      ...chart.spec.legend,
      fill: "#DC8E4A",
      strokeColor: "#241553",
      strokeWidthEmu: 25400,
    },
    categoryAxisLineColor: "#289856",
    categoryAxisLineWidthEmu: 31750,
    valueAxisLineColor: "#D85A40",
    valueAxisLineWidthEmu: 38100,
    categoryAxisMajorGridlines: true,
    categoryAxisMinorGridlines: true,
    valueAxisMajorGridlines: true,
    valueAxisMinorGridlines: true,
    categoryAxisMajorGridlineColor: "#926428",
    categoryAxisMinorGridlineColor: "#662883",
    valueAxisMajorGridlineColor: "#66A381",
    valueAxisMinorGridlineColor: "#925181",
    categoryAxisMajorGridlineWidthEmu: 44450,
    categoryAxisMinorGridlineWidthEmu: 50800,
    valueAxisMajorGridlineWidthEmu: 57150,
    valueAxisMinorGridlineWidthEmu: 63500,
    secondaryCategoryAxisLineColor: "#896722",
    secondaryValueAxisLineColor: "#224D92",
    secondaryCategoryAxisLineWidthEmu: 69850,
    secondaryValueAxisLineWidthEmu: 76200,
    series: chart.spec.series.map((s) => ({
      ...s,
      color: "#268F75",
      lineColor: "#3197BC",
      lineWidthEmu: 82550,
      lineDash: "dash",
      pointColors: ["#59B793", null, "#972E63"],
      pointExplosions:
        kind === "pie" || kind === "doughnut" ? [null, null, 12] : undefined,
      markerSymbol: (s.chartKind ?? kind) === "line" ? "diamond" : undefined,
      markerSizePt: (s.chartKind ?? kind) === "line" ? 7 : undefined,
      trendline: ["bar", "column", "line", "area"].includes(s.chartKind ?? kind)
        ? { type: "linear", color: "#AA5893" }
        : undefined,
    })),
  });
  const part = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)),
    d = parseXml(new TextDecoder().decode(part.data)),
    root = d.root,
    chartNode = firstChildElement(root, qname("c", "chart", NS.chart)),
    area = firstChildElement(chartNode, qname("c", "plotArea", NS.chart)),
    hosts = [];
  root.prefixDecls.set("future", "urn:owned:chart-paint");
  function visit(e) {
    if (firstChildElement(e, qname("c", "spPr", NS.chart))) hosts.push(e);
    for (const n of e.children) if (n.kind === "element") visit(n);
  }
  visit(root);
  // Title and marker paints have no ChartSpec color field, but remain native.
  function addOpaque(e) {
    if (!e || hosts.includes(e)) return;
    hosts.push(e);
  }
  for (const e of [
    firstChildElement(chartNode, qname("c", "title", NS.chart)),
    ...area.children
      .filter(
        (n) =>
          n.kind === "element" && ["catAx", "valAx"].includes(n.name.localName),
      )
      .flatMap((axis) => [
        firstChildElement(axis, qname("c", "title", NS.chart)),
      ]),
  ])
    addOpaque(e);
  function markers(e) {
    if (
      e.name.namespaceURI === NS.chart &&
      e.name.localName === "marker" &&
      (firstChildElement(e, qname("c", "symbol", NS.chart)) ||
        firstChildElement(e, qname("c", "size", NS.chart)))
    )
      addOpaque(e);
    for (const n of e.children) if (n.kind === "element") markers(n);
  }
  markers(root);
  for (const [i, host] of hosts.entries()) {
    const source = parseXml(
      `<c:spPr xmlns:c="${NS.chart}" xmlns:a="${NS.dml}" xmlns:future="urn:owned:chart-paint" bwMode="gray" future:slot="${i}"><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill><a:ln w="${i % 3 === 0 ? 0 : 12700 * (i + 1)}" cap="rnd" cmpd="dbl" algn="in"><a:solidFill><a:schemeClr val="accent2"><a:alpha val="80000"/></a:schemeClr></a:solidFill><a:prstDash val="dash"/><a:round/><a:headEnd type="oval" w="med" len="med"/><a:tailEnd type="triangle"/><a:extLst><a:ext uri="urn:owned:line"><future:line token="future:local"/></a:ext></a:extLst></a:ln><a:effectLst><a:outerShdw blurRad="12700" dist="25400" dir="2700000" algn="ctr" rotWithShape="0"><a:schemeClr val="accent3"><a:alpha val="40000"/></a:schemeClr></a:outerShdw></a:effectLst><a:extLst><a:ext uri="urn:owned:paint"><future:paint token="future:local"/></a:ext></a:extLst></c:spPr>`,
    ).root;
    const old = firstChildElement(host, qname("c", "spPr", NS.chart));
    if (old) host.children = host.children.map((n) => (n === old ? source : n));
    else {
      const at = host.children.findIndex(
        (n) =>
          n.kind === "element" &&
          n.name.namespaceURI === NS.chart &&
          ["txPr", "extLst"].includes(n.name.localName),
      );
      host.children.splice(at < 0 ? host.children.length : at, 0, source);
    }
  }
  part.data = new TextEncoder().encode(serializeXml(d));
  return f;
}

export function chartOpaquePaintDeck(kind = "column", combo = true) {
  const f = chartPaintDeck(kind, combo),
    pkg = P._internalPackageOf(f.p),
    part = pkg.getPart(chartRoot(f.shape)),
    d = parseXml(new TextDecoder().decode(part.data)),
    root = d.root,
    chart = firstChildElement(root, qname("c", "chart", NS.chart)),
    area = firstChildElement(chart, qname("c", "plotArea", NS.chart)),
    group = area.children.find(
      (n) =>
        n.kind === "element" &&
        [
          "barChart",
          "lineChart",
          "pieChart",
          "doughnutChart",
          "areaChart",
        ].includes(n.name.localName),
    ),
    series = firstChildElement(group, qname("c", "ser", NS.chart)),
    point = firstChildElement(series, qname("c", "dPt", NS.chart));
  const replaceFill = (host, payload) => {
    const sp = firstChildElement(host, qname("c", "spPr", NS.chart)),
      fill = parseXml(
        `<a:wrapper xmlns:a="${NS.dml}" xmlns:r="${NS.officeDocRels}">${payload}</a:wrapper>`,
      ).root.children[0];
    sp.children = sp.children.map((n) =>
      n.kind === "element" &&
      n.name.namespaceURI === NS.dml &&
      n.name.localName === "solidFill"
        ? fill
        : n,
    );
  };
  replaceFill(
    root,
    '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="254973"/></a:gs><a:gs pos="100000"><a:srgbClr val="A47928"/></a:gs></a:gsLst><a:lin ang="7200000" scaled="0"/></a:gradFill>',
  );
  replaceFill(
    area,
    '<a:pattFill prst="pct20"><a:fgClr><a:schemeClr val="accent4"/></a:fgClr><a:bgClr><a:schemeClr val="accent5"/></a:bgClr></a:pattFill>',
  );
  replaceFill(series, "<a:grpFill/>");
  if (point)
    replaceFill(
      point,
      '<a:blipFill><a:blip r:embed="ownedPaintImage"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>',
    );
  pkg.addPart(
    "/assets/chart/paint-texture.png",
    "image/png",
    Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
        "base64",
      ),
    ),
  );
  const rels = pkg.getRels(part.name);
  rels.items.push({
    id: "ownedPaintImage",
    type: REL_TYPES.image,
    target: "/assets/chart/paint-texture.png",
    targetMode: "Internal",
  });
  pkg.setRels(part.name, rels);
  part.data = new TextEncoder().encode(serializeXml(d));
  return f;
}

// Native extension records on stable chart and series hosts, including an
// existing image relationship and a prefix referenced only by an opaque value.
export function chartExtensionDeck(kind = "bar", combo = false) {
  const f = chartOpaquePaintDeck(kind, combo),
    part = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)),
    d = parseXml(new TextDecoder().decode(part.data)),
    chart = firstChildElement(d.root, qname("c", "chart", NS.chart)),
    area = firstChildElement(chart, qname("c", "plotArea", NS.chart));
  d.root.prefixDecls.set("ce", "urn:owned:chart-extension");
  d.root.prefixDecls.set("only", "urn:owned:chart-extension-qname");
  const add = (host, payload) =>
    host.children.push(
      parseXml(
        `<c:extLst xmlns:c="${NS.chart}" xmlns:ce="urn:owned:chart-extension" xmlns:r="${NS.officeDocRels}" xmlns:c16="http://schemas.microsoft.com/office/drawing/2014/chart" xmlns:c16r3="http://schemas.microsoft.com/office/drawing/2017/03/chart">${payload}</c:extLst>`,
      ).root,
    );
  add(
    d.root,
    '<c:ext uri="urn:owned:root"><ce:metadata kind="chart-space" choice="only:option"><ce:image r:embed="ownedPaintImage"/></ce:metadata></c:ext>',
  );
  add(
    chart,
    '<c:ext uri="{56B9EC1D-385E-4148-901F-78D8002777C0}"><c16r3:dataDisplayOptions16><c16r3:dispNaAsBlank val="1"/></c16r3:dataDisplayOptions16></c:ext><c:ext uri="urn:owned:chart"><ce:metadata kind="chart" choice="only:option"><!--native payload--><ce:content>Keep &amp; edit</ce:content></ce:metadata></c:ext>',
  );
  let count = 0;
  for (const group of area.children.filter(
    (n) =>
      n.kind === "element" &&
      [
        "barChart",
        "lineChart",
        "areaChart",
        "pieChart",
        "doughnutChart",
      ].includes(n.name.localName),
  ))
    for (const series of group.children.filter(
      (n) => n.kind === "element" && n.name.localName === "ser",
    )) {
      const id = (++count).toString(16).padStart(8, "0");
      add(
        series,
        `<c:ext uri="{C3380CC4-5D6E-409C-BE32-E72D297353CC}"><c16:uniqueId val="{${id}-5341-4DAE-B80A-0037452C98AB}"/></c:ext><c:ext uri="urn:owned:series"><ce:metadata kind="series-${count}" choice="only:option"><ce:image r:embed="ownedPaintImage"/></ce:metadata></c:ext>`,
      );
    }
  const structural = new Set([
    "plotArea",
    "barChart",
    "lineChart",
    "areaChart",
    "pieChart",
    "doughnutChart",
    "catAx",
    "valAx",
    "scaling",
    "title",
    "legend",
    "dLbls",
    "trendline",
    "layout",
  ]);
  const collect = [];
  const visit = (host) => {
    if (
      host.name.namespaceURI === NS.chart &&
      (structural.has(host.name.localName) ||
        (host.name.localName === "marker" &&
          firstChildElement(host, qname("c", "symbol", NS.chart))))
    )
      collect.push(host);
    for (const node of host.children) if (node.kind === "element") visit(node);
  };
  visit(d.root);
  for (const [i, host] of collect.entries())
    add(
      host,
      `<c:ext uri="urn:owned:structural"><ce:metadata kind="${host.name.localName}-${i}" choice="only:option"/></c:ext>`,
    );
  part.data = new TextEncoder().encode(serializeXml(d));
  return f;
}

// Native maximum-label option, with distinct primary/secondary value ranges.
export function chartMaximumLabelsDeck(kind = "column", combo = false) {
  const f = chartExtensionDeck(kind, combo),
    chart = P.getSlideCharts(f.slide)[0];
  P.setChartSpec(chart, {
    ...chart.spec,
    categories: ["Below", "Boundary", "Above"],
    valueAxis: { min: -5, max: 7 },
    legend: { position: null },
    dataLabels: { showValue: true, textStyle: { color: "#123ABC" } },
    series: chart.spec.series.map((series, i) => ({
      ...series,
      values: i === 0 ? [2, 7, 11] : [40, 50, 60],
      dataLabels: { showValue: true, textStyle: { color: "#123ABC" } },
    })),
  });
  const part = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)),
    doc = parseXml(new TextDecoder().decode(part.data)),
    node = firstChildElement(doc.root, qname("c", "chart", NS.chart)),
    ext = firstChildElement(node, qname("c", "extLst", NS.chart));
  node.children.splice(
    ext ? node.children.indexOf(ext) : node.children.length,
    0,
    parseXml(`<c:showDLblsOverMax xmlns:c="${NS.chart}" val="0"/>`).root,
  );
  part.data = new TextEncoder().encode(serializeXml(doc));
  return f;
}

// Native workbook tables/styles and quoted, offset source ranges. ChartSpec
// represents the cached data, but has no edit surface for these sheet features.
export function chartNativeDataDeck(kind = "column", combo = false) {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0],
    shape = P.addSlideChart(slide, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(7),
      h: P.inches(4),
      spec: {
        kind,
        categories: ["North", "South", "West"],
        series: [
          { name: "Sales", values: [3, null, 8], numberFormat: "0.00" },
          ...(["pie", "doughnut"].includes(kind)
            ? []
            : [
                {
                  name: "Costs",
                  values: [2, 6, -1],
                  ...(combo ? { chartKind: "line", secondaryAxis: true } : {}),
                },
              ]),
        ],
        legend: { position: "b" },
      },
    }),
    pkg = P._internalPackageOf(p),
    part = pkg.getPart(chartRoot(shape)),
    d = parseXml(new TextDecoder().decode(part.data));
  d.root.prefixDecls.set("native", "urn:owned:chart-data");
  d.root.prefixDecls.set("choice", "urn:owned:chart-data-choice");
  let index = 0;
  const visit = (host) => {
    if (host.name.namespaceURI === NS.chart && host.name.localName === "ser") {
      const i = index++,
        column = i ? "F" : "E";
      for (const name of ["idx", "order"]) {
        const n = firstChildElement(host, qname("c", name, NS.chart));
        n.attrs = [{ name: qname("", "val", ""), value: String(17 + i * 23) }];
      }
      for (const name of ["tx", "cat", "val"]) {
        const channel = firstChildElement(host, qname("c", name, NS.chart)),
          ref = channel.children.find(
            (n) => n.kind === "element" && n.name.localName.endsWith("Ref"),
          ),
          formula = firstChildElement(ref, qname("c", "f", NS.chart));
        formula.children = [
          {
            kind: "text",
            data: `'Region''s data'!${name === "tx" ? `$${column}$7` : name === "cat" ? "$D$8:$D$10" : `$${column}$8:$${column}$10`}`,
          },
        ];
        ref.children.push(
          parseXml(
            `<c:extLst xmlns:c="${NS.chart}" xmlns:native="urn:owned:chart-data"><c:ext uri="urn:owned:data-${i}-${name}"><native:source choice="choice:keep"/></c:ext></c:extLst>`,
          ).root,
        );
      }
    }
    for (const n of host.children) if (n.kind === "element") visit(n);
  };
  visit(d.root);
  part.data = new TextEncoder().encode(serializeXml(d));
  const book = workbook(p, shape),
    entries = unzipSync(book.data),
    s = "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    r = NS.officeDocRels;
  entries["xl/workbook.xml"] = strToU8(
    strFromU8(entries["xl/workbook.xml"]).replace(
      'name="Sheet1"',
      'name="Region&apos;s data"',
    ),
  );
  entries["xl/worksheets/sheet1.xml"] = strToU8(
    `<worksheet xmlns="${s}" xmlns:r="${r}"><dimension ref="D7:F10"/><sheetViews><sheetView workbookViewId="0" zoomScale="85"/></sheetViews><sheetData><row r="7"><c r="D7" t="inlineStr"><is><t>Region</t></is></c><c r="E7" t="inlineStr"><is><t>Sales</t></is></c><c r="F7" t="inlineStr"><is><t>Costs</t></is></c></row><row r="8"><c r="D8" t="inlineStr"><is><t>North</t></is></c><c r="E8" s="1"><v>3</v></c><c r="F8"><v>2</v></c></row><row r="9"><c r="D9" t="inlineStr"><is><t>South</t></is></c><c r="F9"><v>6</v></c></row><row r="10"><c r="D10" t="inlineStr"><is><t>West</t></is></c><c r="E10" s="1"><v>8</v></c><c r="F10"><v>-1</v></c></row></sheetData><tableParts count="1"><tablePart r:id="tableSource"/></tableParts></worksheet>`,
  );
  entries["xl/worksheets/_rels/sheet1.xml.rels"] = strToU8(
    `<Relationships xmlns="${NS.relationships}"><Relationship Id="tableSource" Type="${r}/table" Target="../tables/table1.xml"/></Relationships>`,
  );
  entries["xl/tables/table1.xml"] = strToU8(
    `<table xmlns="${s}" id="1" name="RegionalResults" displayName="RegionalResults" ref="D7:F10" totalsRowShown="0"><autoFilter ref="D7:F10"/><tableColumns count="3"><tableColumn id="1" name="Region"/><tableColumn id="2" name="Sales"/><tableColumn id="3" name="Costs"/></tableColumns><tableStyleInfo name="TableStyleMedium9" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`,
  );
  entries["[Content_Types].xml"] = strToU8(
    strFromU8(entries["[Content_Types].xml"]).replace(
      "</Types>",
      '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>',
    ),
  );
  book.data = zipSync(entries);
  return { p, slide, shape };
}
