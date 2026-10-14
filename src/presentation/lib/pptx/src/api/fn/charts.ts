import { checkChartCacheSize } from "../../internal/chartml/chart-cache.ts";
import { preserveNativeChartAxisGeometry } from "../../internal/chartml/native-axis-geometry.ts";
import { preserveNativeChartPlotGuides } from "../../internal/chartml/native-plot-guides.ts";
import { readChartAxisLines } from "./chart-axis-lines.ts";
import { readChartAreaLine } from "./chart-area-line.ts";
import { readChartPlotGroups } from "./chart-plot-groups.ts";
import {
  validateChartAxisTickLabelPositions,
  preserveNativeChartAxisTickLabelPositions,
} from "../../internal/chartml/axis-label-position.ts";
import {
  validateChartAxisCrossings,
  preserveNativeChartCrossings,
} from "../../internal/chartml/axis-crossing.ts";
import { validateMarkerSizePt } from "../../internal/chartml/marker-size.ts";
import { validateChartLabelPositions } from "../../internal/chartml/label-position.ts";
import { readChartSeriesDisplays } from "../../internal/chartml/blank-display.ts";
import { readChartDataLabelOverrides } from "../../internal/chartml/data-label-overrides.ts";
// Charts (read + write).

import type { Emu } from "../units.ts";
import {
  type PartName,
  basename,
  emptyRels,
  nextRelId,
  partName,
  parseRels,
  resolveTarget,
} from "../../internal/opc/index.ts";
import type { OpcPackage, Part } from "../../internal/parts/index.ts";
import { withPackageTransaction } from "../../internal/parts/package-transaction.ts";
import {
  emuCoordinate,
  emuExtent,
  lineWidthEmu,
} from "../../internal/bounds.ts";
import { CHART_STROKE_WIDTH_FIELDS } from "../../internal/chartml/stroke-width.ts";
import {
  preserveNativeChartPaint,
  preserveNativeChartInversion,
} from "../../internal/chartml/native-paint.ts";
import { updateNativeChartWorkbook } from "../../internal/chartml/native-workbook-data.ts";
import { preserveNativeChartData } from "../../internal/chartml/native-data.ts";
import { preserveNativeChartExtensions } from "../../internal/chartml/native-extensions.ts";
import {
  preserveNativeChartText,
  readNativeChartTextState,
} from "../../internal/chartml/native-text.ts";
import {
  preserveNativeChartStyle,
  validateChartStyle,
} from "../../internal/chartml/chart-style.ts";
import { parseSrgbHex } from "../../internal/drawingml/index.ts";
import { readChartSeriesOpacities } from "./chart-series-opacity.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  type ChartKind,
  type ChartSeries,
  type ChartSpec,
  type ChartTextStyle,
  buildChartSpaceDoc,
  buildEmbeddedXlsx,
  buildEmbeddedXlsxColumns,
  readChartSpec,
} from "../../internal/chartml/index.ts";
import {
  isXYChartKind,
  xyWorkbookPlan,
} from "../../internal/chartml/xy-workbook.ts";
import {
  NS,
  type XmlElement,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  parseXml,
  qname,
  serializeXml,
  text as textNode,
  withInheritedNamespaces,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  SLIDE_PART_NAME,
  SLIDE_SHAPES,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import {
  appendAndReturnNewShape,
  decode,
  encode,
  nextShapeId,
  setOpcDefault,
} from "./_helpers.ts";
import { resolveDeckBodyTextColor } from "./color-map.ts";
import { getSlides } from "./slide-query.ts";
import { themeForChartPart, colorMapForChart } from "./chart-theme.ts";
import { resolveDrawingColor } from "./shape-color.ts";
import {
  readChartAreaPaint,
  readChartPlotAreaPaint,
} from "./chart-area-paint.ts";
// ---------------------------------------------------------------------------
// Charts.
//
// Authoring path for ChartML (`/ppt/charts/chart{N}.xml`) + the embedded
// `/ppt/embeddings/Microsoft_Excel_Worksheet{N}.xlsx` workbook that
// presentation apps require for editing the chart data. See plan §P9
// and §Risks for the scope constraints.
//
// Public surface is intentionally narrow: one `addSlideChart` entry point
// that takes a typed `ChartSpec`. The internal layer handles the chart
// XML, the embedded xlsx ZIP, and all the relationship wiring.

const CHART_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const EMBEDDED_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const allocateChartIndex = (pkg: OpcPackage): number => {
  let next = 1;
  const re = /^\/ppt\/charts\/chart(\d+)\.xml$/;
  for (const p of pkg.parts) {
    const m = p.name.match(re);
    if (m?.[1] !== undefined) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= next) next = n + 1;
    }
  }
  return next;
};

// Embedding names are independent of chart names (including imported graphs).
const allocateChartWorkbookName = (pkg: OpcPackage, start = 1): PartName => {
  let index = start;
  let name: PartName;
  do {
    name = partName(`/ppt/embeddings/Microsoft_Excel_Worksheet${index++}.xlsx`);
  } while (pkg.getPart(name) !== null);
  return name;
};

const NAME_GRAPHIC_FRAME = qname("p", "graphicFrame", NS.pml);
const NAME_NV_GRAPHIC_FRAME_PR = qname("p", "nvGraphicFramePr", NS.pml);
const NAME_C_NV_PR_FN = qname("p", "cNvPr", NS.pml);
const NAME_C_NV_GRAPHIC_FRAME_PR = qname("p", "cNvGraphicFramePr", NS.pml);
const NAME_NV_PR = qname("p", "nvPr", NS.pml);
const NAME_XFRM = qname("p", "xfrm", NS.pml);
const NAME_OFF = qname("a", "off", NS.dml);
const NAME_EXT = qname("a", "ext", NS.dml);
const NAME_GRAPHIC = qname("a", "graphic", NS.dml);
const NAME_GRAPHIC_DATA = qname("a", "graphicData", NS.dml);
const NAME_C_CHART = qname("c", "chart", NS.chart);

const buildChartGraphicFrame = (opts: {
  id: number;
  name: string;
  x: Emu;
  y: Emu;
  w: Emu;
  h: Emu;
  rEmbed: string;
}): XmlElement => {
  const cNvPr = elem(NAME_C_NV_PR_FN, {
    attrs: [
      attr(qname("", "id", ""), String(opts.id)),
      attr(qname("", "name", ""), opts.name),
    ],
  });
  const nvGraphicFramePr = elem(NAME_NV_GRAPHIC_FRAME_PR, {
    children: [cNvPr, elem(NAME_C_NV_GRAPHIC_FRAME_PR), elem(NAME_NV_PR)],
  });
  // Round to whole EMU; fractional ST_Coordinate values corrupt the file.
  const off = elem(NAME_OFF, {
    attrs: [
      attr(
        qname("", "x", ""),
        String(emuCoordinate(opts.x, "addSlideChart: x")),
      ),
      attr(
        qname("", "y", ""),
        String(emuCoordinate(opts.y, "addSlideChart: y")),
      ),
    ],
  });
  const ext = elem(NAME_EXT, {
    attrs: [
      attr(qname("", "cx", ""), String(emuExtent(opts.w, "addSlideChart: w"))),
      attr(qname("", "cy", ""), String(emuExtent(opts.h, "addSlideChart: h"))),
    ],
  });
  const xfrm = elem(NAME_XFRM, { children: [off, ext] });
  const chartRef = elem(NAME_C_CHART, {
    prefixDecls: new Map([
      ["c", NS.chart],
      ["r", NS.officeDocRels],
    ]),
    attrs: [attr(qname("r", "id", NS.officeDocRels), opts.rEmbed)],
  });
  const graphicData = elem(NAME_GRAPHIC_DATA, {
    attrs: [attr(qname("", "uri", ""), NS.chart)],
    children: [chartRef],
  });
  const graphic = elem(NAME_GRAPHIC, { children: [graphicData] });
  return elem(NAME_GRAPHIC_FRAME, {
    children: [nvGraphicFramePr, xfrm, graphic],
  });
};

// The chart builder emits every authored color as `<a:srgbClr>`, so chart
// colors must be sRGB hex (`#RRGGBB` or `RRGGBB`) — scheme tokens like
// `accent1` are not valid here. Without this gate an invalid string was
// written verbatim into `val="…"`, producing a chart .pptx readers silently
// dropped (or repaired). Validate at the authoring boundary so callers get
// a clear error instead of a broken deck. The `#` prefix is optional; the
// builder normalizes it.
const checkChartColor = (
  value: string | null | undefined,
  label: string,
): void => {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || parseSrgbHex(value) === null) {
    throw new Error(
      `${label}: invalid chart color ${JSON.stringify(value)} — expected an sRGB hex like "#4472C4" or "4472C4"`,
    );
  }
};

const validateChartSpec = (spec: ChartSpec): void => {
  validateChartStyle(spec);
  validateChartLabelPositions(spec);
  validateChartAxisCrossings(spec);
  validateChartAxisTickLabelPositions(spec);
  for (const key of [
    "showDataLabelsOverMaximum",
    "roundedCorners",
    "lineMarkers",
    "categoryAxisNoMultiLevelLabel",
  ] as const)
    if (spec[key] !== undefined && typeof spec[key] !== "boolean")
      throw new TypeError(`${key}: expected a boolean`);
  for (const key of CHART_STROKE_WIDTH_FIELDS) {
    const width = spec[key];
    if (width !== undefined) lineWidthEmu(width, key);
  }
  checkChartColor(
    spec.secondaryValueAxisLineColor,
    "secondaryValueAxisLineColor",
  );
  checkChartColor(
    spec.secondaryCategoryAxisLineColor,
    "secondaryCategoryAxisLineColor",
  );
  for (const key of [
    "categoryAxisOrientation",
    "secondaryCategoryAxisOrientation",
    "valueAxisOrientation",
    "secondaryValueAxisOrientation",
  ] as const) {
    const orientation = spec[key];
    if (
      orientation !== undefined &&
      orientation !== "minMax" &&
      orientation !== "maxMin"
    ) {
      throw new RangeError(
        `${key}: expected minMax or maxMin (OOXML ST_Orientation)`,
      );
    }
  }
  for (const key of [
    "valueAxisCrossBetween",
    "secondaryValueAxisCrossBetween",
  ] as const) {
    const mode = spec[key];
    if (mode !== undefined && mode !== "between" && mode !== "midCat") {
      throw new RangeError(
        `${key}: expected between or midCat (OOXML ST_CrossBetween)`,
      );
    }
  }
  for (const key of [
    "categoryAxisTickLabelSkip",
    "categoryAxisTickMarkSkip",
  ] as const) {
    const skip = spec[key];
    if (
      skip !== undefined &&
      (!Number.isInteger(skip) || skip < 1 || skip > 0xffffffff)
    ) {
      throw new RangeError(
        `${key}: expected an integer from 1 to 4294967295 (OOXML ST_Skip)`,
      );
    }
  }
  const checkFormat = (code: unknown, linked: unknown, label: string) => {
    if (code !== undefined && typeof code !== "string")
      throw new TypeError(`${label}: expected a number-format string`);
    if (linked !== undefined && typeof linked !== "boolean")
      throw new TypeError(`${label}SourceLinked: expected a boolean`);
  };
  checkFormat(
    spec.valueAxis?.numberFormat,
    spec.valueAxis?.numberFormatSourceLinked,
    "valueAxis.numberFormat",
  );
  for (const prefix of [
    "categoryAxis",
    "secondaryCategoryAxis",
    "secondaryValueAxis",
  ] as const)
    checkFormat(
      spec[`${prefix}NumberFormat`],
      spec[`${prefix}NumberFormatSourceLinked`],
      `${prefix}NumberFormat`,
    );
  checkFormat(spec.categoryNumberFormat, undefined, "categoryNumberFormat");
  checkFormat(
    spec.dataLabels?.numberFormat,
    spec.dataLabels?.numberFormatSourceLinked,
    "dataLabels.numberFormat",
  );
  if (spec.categoryNumberFormat !== undefined)
    for (const category of spec.categories) {
      const value = category.trim();
      if (
        value !== "" &&
        (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
          !Number.isFinite(Number(value)))
      )
        throw new TypeError(
          "categoryNumberFormat: numeric categories require finite numeric values or blanks",
        );
    }
  spec.series.forEach((series, i) => {
    if (
      series.invertIfNegative !== undefined &&
      typeof series.invertIfNegative !== "boolean"
    )
      throw new TypeError(`series[${i}].invertIfNegative: expected a boolean`);
    // Both the chart cache and its workbook carry this data. Invalid numbers
    // would be serialized as NaN/Infinity and read back as blank points. Keep
    // existing null/missing-slot gaps, but reject invalid data before mutation.
    series.values.forEach((value, j) => {
      if (value !== null && value !== undefined && !Number.isFinite(value))
        throw new TypeError(
          `series[${i}].values[${j}]: expected a finite number or a blank`,
        );
    });
    checkFormat(series.numberFormat, undefined, `series[${i}].numberFormat`);
    checkFormat(
      series.dataLabels?.numberFormat,
      series.dataLabels?.numberFormatSourceLinked,
      `series[${i}].dataLabels.numberFormat`,
    );
  });
  checkChartColor(spec.legend?.fill, "legend.fill");
  checkChartColor(spec.legend?.strokeColor, "legend.strokeColor");
  if (spec.legend?.strokeWidthEmu !== undefined)
    lineWidthEmu(spec.legend.strokeWidthEmu, "legend.strokeWidthEmu");
  checkChartColor(spec.textStyle?.color, "addSlideChart: textStyle.color");
  checkChartColor(spec.plotAreaFill, "addSlideChart: plotAreaFill");
  checkChartColor(
    spec.plotAreaStrokeColor,
    "addSlideChart: plotAreaStrokeColor",
  );
  checkChartColor(spec.chartAreaFill, "addSlideChart: chartAreaFill");
  checkChartColor(
    spec.chartAreaStrokeColor,
    "addSlideChart: chartAreaStrokeColor",
  );
  checkChartColor(
    spec.valueAxisMajorGridlineColor,
    "addSlideChart: valueAxisMajorGridlineColor",
  );
  checkChartColor(
    spec.valueAxisMinorGridlineColor,
    "addSlideChart: valueAxisMinorGridlineColor",
  );
  checkChartColor(
    spec.categoryAxisMajorGridlineColor,
    "addSlideChart: categoryAxisMajorGridlineColor",
  );
  checkChartColor(
    spec.categoryAxisMinorGridlineColor,
    "addSlideChart: categoryAxisMinorGridlineColor",
  );
  checkChartColor(spec.valueAxisLineColor, "addSlideChart: valueAxisLineColor");
  checkChartColor(
    spec.categoryAxisLineColor,
    "addSlideChart: categoryAxisLineColor",
  );
  spec.series.forEach((series, i) => {
    checkChartColor(series.color, `addSlideChart: series[${i}].color`);
    if (series.negativeColor === null)
      throw new TypeError(
        `series[${i}].negativeColor: expected an sRGB hex color`,
      );
    checkChartColor(series.negativeColor, `series[${i}].negativeColor`);
    if (series.pointInvertIfNegative !== undefined) {
      if (!Array.isArray(series.pointInvertIfNegative))
        throw new TypeError(
          `series[${i}].pointInvertIfNegative: expected an array`,
        );
      checkChartCacheSize(series.pointInvertIfNegative.length);
      series.pointInvertIfNegative.forEach((value, j) => {
        if (value !== null && value !== undefined && typeof value !== "boolean")
          throw new TypeError(
            `series[${i}].pointInvertIfNegative[${j}]: expected a boolean or a blank`,
          );
      });
    }
    checkChartColor(series.lineColor, `addSlideChart: series[${i}].lineColor`);
    checkChartColor(
      series.markerFill,
      `addSlideChart: series[${i}].markerFill`,
    );
    checkChartColor(
      series.markerStrokeColor,
      `addSlideChart: series[${i}].markerStrokeColor`,
    );
    if (series.markerSizePt !== undefined)
      validateMarkerSizePt(series.markerSizePt);
    if (series.markerStrokeWidthEmu !== undefined)
      lineWidthEmu(
        series.markerStrokeWidthEmu,
        `addSlideChart: series[${i}].markerStrokeWidthEmu`,
      );
    if (series.lineWidthEmu !== undefined)
      lineWidthEmu(
        series.lineWidthEmu,
        `addSlideChart: series[${i}].lineWidthEmu`,
      );
    checkChartColor(
      series.trendline?.color,
      `addSlideChart: series[${i}].trendline.color`,
    );
    checkChartColor(
      series.errorBars?.color,
      `addSlideChart: series[${i}].errorBars.color`,
    );
    series.pointColors?.forEach((c, j) => {
      checkChartColor(c, `addSlideChart: series[${i}].pointColors[${j}]`);
    });
  });
};

/**
 * Adds a chart to the slide. Returns the new shape handle (kind
 * `graphicFrame`). Supported chart kinds today: `bar`, `column`,
 * `line`, `pie` — see `ChartSpec.kind`.
 *
 * Side effects:
 *
 *   - Allocates `/ppt/charts/chart{N}.xml` for the chart definition.
 *   - Allocates `/ppt/embeddings/Microsoft_Excel_Worksheet{N}.xlsx` as
 *     a placeholder workbook (single sheet, header row + one row per
 *     category). Readers render from the inline `<c:strCache>` /
 *     `<c:numCache>` so the workbook is for data editing only.
 *   - Slide → chart and chart → workbook rels are wired with fresh rIds.
 *   - `<a:graphicFrame>` is appended to the slide's `<p:spTree>`.
 *
 * Constraints:
 *
 *   - `pie` charts require exactly one series.
 *   - Category labels may be absent or shorter than the numeric values.
 *     Each series retains its own numeric extent, including empty series.
 */
// A chart inherits no master text style, so any label without an authored
// color falls back to the `tx1` token — which a deck with an inverted color
// map paints the same as the surface, hiding axis labels, the legend, and data
// labels. Bake the deck's resolved body-text color onto every text style the
// caller left unset (authored colors always win).
const withChartDefaultTextColor = (
  spec: ChartSpec,
  color: string | null,
): ChartSpec => {
  color = spec.textStyle?.color ?? color;
  if (color === null) return spec;
  const withColor = (style: ChartTextStyle | undefined): ChartTextStyle =>
    style === undefined
      ? { color }
      : style.color === undefined
        ? { ...style, color }
        : style;
  return {
    ...spec,
    categoryAxisLabelStyle: withColor(spec.categoryAxisLabelStyle),
    valueAxisLabelStyle: withColor(spec.valueAxisLabelStyle),
    ...(spec.title !== undefined
      ? { titleStyle: withColor(spec.titleStyle) }
      : {}),
    ...(spec.legend !== undefined
      ? {
          legend: {
            ...spec.legend,
            textStyle: withColor(spec.legend.textStyle),
          },
        }
      : {}),
    ...(spec.dataLabels !== undefined
      ? {
          dataLabels: {
            ...spec.dataLabels,
            textStyle: withColor(spec.dataLabels.textStyle),
          },
        }
      : {}),
  };
};

// The worksheet must back every cached point, including values beyond the
// labelled categories. Reuse this layout for creation and subsequent edits.
const chartWorkbook = (spec: ChartSpec): Uint8Array => {
  if (isXYChartKind(spec.kind))
    return buildEmbeddedXlsxColumns(xyWorkbookPlan(spec).columns, {
      ...(spec.date1904 !== undefined ? { date1904: spec.date1904 } : {}),
    });
  const count = spec.series.reduce(
    (length, series) => Math.max(length, series.values.length),
    spec.categories.length,
  );
  return buildEmbeddedXlsx(
    spec.series.map((series) => series.name),
    Array.from({ length: count }, (_, i) => ({
      label: spec.categories[i] ?? "",
      values: spec.series.map((series) => series.values[i] ?? null),
    })),
    {
      seriesNumberFormats: spec.series.map((series) => series.numberFormat),
      ...(spec.categoryNumberFormat !== undefined
        ? { categoryNumberFormat: spec.categoryNumberFormat }
        : {}),
      ...(spec.date1904 !== undefined ? { date1904: spec.date1904 } : {}),
    },
  );
};

export const addSlideChart = (
  slide: SlideData,
  opts: {
    spec: ChartSpec;
    x: Emu;
    y: Emu;
    w: Emu;
    h: Emu;
    name?: string;
  },
): SlideShapeData => {
  validateChartSpec(opts.spec);
  const spec = withChartDefaultTextColor(
    opts.spec,
    resolveDeckBodyTextColor(slide),
  );
  const pkg = slide[INTERNAL_PACKAGE];
  const chartN = allocateChartIndex(pkg);
  const chartPartName = partName(`/ppt/charts/chart${chartN}.xml`);
  const xlsxPartName = allocateChartWorkbookName(pkg, chartN);

  const xlsxBytes = chartWorkbook(spec);

  // Build the chart XML and serialize.
  const chartDoc = buildChartSpaceDoc(spec);
  const chartBytes = encode(serializeXml(chartDoc));

  // Add the chart part + its rel → embedded xlsx.
  pkg.addPart(chartPartName, CHART_CONTENT_TYPE, chartBytes);

  // The xlsx is a binary part; xlsx is already an OPC zip so we add a
  // Content_Types override (no Default, since `.xlsx` shouldn't override
  // unrelated archive entries even though there's only one such part
  // here in practice).
  pkg.addPart(xlsxPartName, EMBEDDED_XLSX_CONTENT_TYPE, xlsxBytes);

  // Make sure `.rels` is a recognized Default (it always is by the time
  // we get here, but be defensive for new packages).
  setOpcDefault(
    pkg,
    "rels",
    "application/vnd.openxmlformats-package.relationships+xml",
  );

  const chartRels = emptyRels();
  chartRels.items.push({
    id: "rId1",
    type: REL_TYPES.package,
    target: `../embeddings/${basename(xlsxPartName)}`,
    targetMode: "Internal",
  });
  pkg.setRels(chartPartName, chartRels);

  // Slide → chart rel.
  const slideRels = pkg.getRels(slide[SLIDE_PART_NAME]) ?? emptyRels();
  const slideChartRId = nextRelId(slideRels.items.map((r) => r.id));
  slideRels.items.push({
    id: slideChartRId,
    type: REL_TYPES.chart,
    target: `../charts/chart${chartN}.xml`,
    targetMode: "Internal",
  });
  pkg.setRels(slide[SLIDE_PART_NAME], slideRels);

  // Build and append the <p:graphicFrame> wrapper.
  const frame = buildChartGraphicFrame({
    id: nextShapeId(slide),
    name: opts.name ?? `Chart ${chartN}`,
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    rEmbed: slideChartRId,
  });
  return appendAndReturnNewShape(slide, frame);
};

// Re-export chart types for consumers.
export type { ChartKind, ChartSeries, ChartSpec };

/**
 * A chart sitting on a slide. `shape` is the `<p:graphicFrame>`
 * wrapper; `spec` is the chart definition parsed from the linked
 * `/ppt/charts/chart{N}.xml` part. `null` `spec` means the chart uses
 * a kind we don't model (callers can fall through to pass-through).
 */
export interface SlideChartData {
  readonly shape: SlideShapeData;
  readonly spec: ChartSpec | null;
}

const NAME_A_GRAPHIC_FN = qname("a", "graphic", NS.dml);
const NAME_A_GRAPHIC_DATA_FN = qname("a", "graphicData", NS.dml);
const NAME_C_CHART_FN = qname("c", "chart", NS.chart);

/**
 * Resolves the chart part backing a graphic-frame shape, or `null` if
 * the shape isn't a chart wrapper.
 */
export const resolveChartPartName = (
  slide: SlideData,
  shape: SlideShapeData,
): { partName: PartName; rId: string } | null => {
  if (shape[SHAPE_SNAPSHOT].kind !== "graphicFrame") return null;
  const graphic = firstChildElement(shape[SHAPE_ELEMENT], NAME_A_GRAPHIC_FN);
  if (!graphic) return null;
  const graphicData = firstChildElement(graphic, NAME_A_GRAPHIC_DATA_FN);
  if (!graphicData) return null;
  const chartRef = firstChildElement(graphicData, NAME_C_CHART_FN);
  if (!chartRef) return null;
  const rId = getAttrValue(chartRef, qname("r", "id", NS.officeDocRels));
  if (rId === null) return null;
  const slideRels = slide[INTERNAL_PACKAGE].getRels(slide[SLIDE_PART_NAME]);
  if (!slideRels) return null;
  const rel = slideRels.items.find((r) => r.id === rId);
  if (!rel) return null;
  const partNameValue = rel.target.startsWith("/")
    ? partName(rel.target)
    : resolveTarget(slide[SLIDE_PART_NAME], rel.target);
  return { partName: partNameValue, rId };
};

const hasXYChannels = (root: XmlElement): boolean => {
  let found = false;
  const visit = (el: XmlElement): void => {
    for (const node of el.children) {
      if (found || node.kind !== "element") continue;
      if (
        node.name.namespaceURI === NS.chart &&
        ["xVal", "yVal", "bubbleSize"].includes(node.name.localName)
      ) {
        found = true;
        return;
      }
      visit(node);
    }
  };
  visit(root);
  return found;
};

/**
 * Replaces the chart definition on an existing graphic-frame chart
 * shape. Updates the inline `<c:strCache>` / `<c:numCache>` blocks so
 * readers render the new data without opening the embedded
 * workbook. The shape's geometry (position / size / rotation) is
 * preserved verbatim.
 *
 * The embedded xlsx backs chart data editing in presentation apps. Appearance-only
 * edits retain the native workbook and data-reference channels. Data edits
 * update native value cells and caches while retaining workbook objects and
 * styles. Formula-backed or conflicting targets receive separate data cells
 * in the same workbook. Numeric format edits retain other cell formatting.
 * Unreadable packages are rebuilt from the complete spec. The native
 * externalData relationship selects the workbook; linked external sources
 * retain their binding/options and receive cache changes only.
 * Native chart/legend/axis/data-label text-property bodies retain unrelated
 * body, paragraph and run properties; represented uniform style changes apply
 * only to the changed fields. Chart-local color mappings remain in effect.
 *
 * Pass any `ChartSpec`, including a different `kind` from the
 * original; this acts as "change my column chart to a line chart with
 * fresh data."
 */
export const setChartSpec = (chart: SlideChartData, spec: ChartSpec): void => {
  validateChartSpec(spec);
  const slide = chart.shape[SHAPE_SLIDE];
  const pkg = slide[INTERNAL_PACKAGE];
  const resolved = resolveChartPartName(slide, chart.shape);
  if (!resolved) {
    throw new Error("setChartSpec: shape is not a chart graphic frame");
  }

  const chartPart = pkg.getPart(resolved.partName);
  if (!chartPart) {
    throw new Error(`setChartSpec: chart part ${resolved.partName} not found`);
  }
  const original = parseXml(decode(chartPart.data));
  const externalData = firstChildElement(
    original.root,
    qname("c", "externalData", NS.chart),
  );
  const chartRels = pkg.getRels(resolved.partName) ?? emptyRels();
  let workbook: Part | null = null;
  let addWorkbook = false;
  let changeRelationships = false;
  let workbookName: PartName | undefined;
  let workbookId: string;

  const id =
    externalData &&
    getAttrValue(externalData, qname("r", "id", NS.officeDocRels));
  const rel = chartRels.items.find(
    (r) => r.id === id && r.type === REL_TYPES.package,
  );
  if (rel) {
    workbookId = rel.id;
    if (rel.targetMode === "Internal") {
      workbook = pkg.getPart(resolveTarget(resolved.partName, rel.target));
      if (workbook?.contentType !== EMBEDDED_XLSX_CONTENT_TYPE) {
        // A missing backing part can be recreated from the newly authored
        // data. For XLS/XLSM/other formats, keep the original bytes and author
        // a separate correctly typed XLSX instead of corrupting their format.
        workbookName = allocateChartWorkbookName(pkg);
        rel.target = workbookName;
        addWorkbook = changeRelationships = true;
        workbook = null;
      }
    }
    // Linked external workbooks remain linked; only the owned chart cache
    // changes. No remote workbook is read or written.
  } else {
    // No valid bound workbook: an unbound package relationship or a wrong-type
    // reference may belong to another opaque payload. Never guess or overwrite
    // it. Author a fresh backing workbook and a correctly typed binding.
    workbookName = allocateChartWorkbookName(pkg);
    workbookId = nextRelId(chartRels.items.map((r) => r.id));
    chartRels.items.push({
      id: workbookId,
      type: REL_TYPES.package,
      target: workbookName,
      targetMode: "Internal",
    });
    addWorkbook = changeRelationships = true;
  }

  const doc = buildChartSpaceDoc(spec, workbookId);
  // XY channels (xVal / yVal / bubbleSize) have no categorical cell plan:
  // moving to, from or between XY kinds rewrites the workbook from the spec.
  const xyData = isXYChartKind(spec.kind) || hasXYChannels(original.root);
  const retainData =
    !addWorkbook &&
    !xyData &&
    preserveNativeChartData(original.root, doc.root, spec);
  const editedWorkbook =
    workbook && !retainData && !xyData
      ? updateNativeChartWorkbook(workbook.data, original.root, doc.root, spec)
      : null;
  preserveNativeChartStyle(original.root, doc.root, spec);
  preserveNativeChartAxisGeometry(original.root, doc.root, spec);
  preserveNativeChartCrossings(original.root, doc.root, spec);
  preserveNativeChartAxisTickLabelPositions(original.root, doc.root, spec);
  let resolveTextColor: ReturnType<typeof chartColorResolver>;
  try {
    resolveTextColor = chartColorResolver(
      slide,
      resolved.partName,
      original.root,
    );
  } catch {
    // An unreadable theme must not prevent replacing chart data from a complete
    // spec. Direct colors remain interpretable; unresolved scheme paints remain
    // native unless the caller supplies an explicit represented color override.
    resolveTextColor = (color) => resolveDrawingColor(color, null);
  }
  const previous = readNativeChartTextState(original.root, resolveTextColor);
  if (previous)
    preserveNativeChartText(original.root, doc.root, previous, spec);
  preserveNativeChartPaint(original.root, doc.root, spec, resolveTextColor);
  preserveNativeChartPlotGuides(original.root, doc.root, spec);
  preserveNativeChartExtensions(original.root, doc.root);
  preserveNativeChartInversion(original.root, doc.root, spec, resolveTextColor);
  const colorMap = firstChildElement(
    original.root,
    qname("c", "clrMapOvr", NS.chart),
  );
  if (colorMap) {
    // Native scheme colors in retained text/paint use the chart-local mapping.
    // ChartSpec has no mapping edit, so retain this chart-space slot verbatim.
    const chartIndex = doc.root.children.findIndex(
      (n) =>
        n.kind === "element" &&
        n.name.namespaceURI === NS.chart &&
        n.name.localName === "chart",
    );
    doc.root.children.splice(
      chartIndex,
      0,
      withInheritedNamespaces(colorMap, [original.root]),
    );
  }
  if (externalData) {
    // Preserve native autoUpdate (including omission) and owner namespace
    // bindings instead of reauthoring the external data node's options.
    doc.root.children = doc.root.children.map((node) =>
      node.kind === "element" &&
      node.name.namespaceURI === NS.chart &&
      node.name.localName === "externalData"
        ? withInheritedNamespaces(
            {
              ...externalData,
              attrs: [
                ...externalData.attrs.filter(
                  (a) =>
                    a.name.namespaceURI !== NS.officeDocRels ||
                    a.name.localName !== "id",
                ),
                attr(qname("r", "id", NS.officeDocRels), workbookId),
              ],
            },
            [original.root],
          )
        : node,
    );
  }
  const chartBytes = encode(serializeXml(doc));
  const xlsxBytes =
    addWorkbook || (workbook && !retainData)
      ? (editedWorkbook ?? chartWorkbook(spec))
      : undefined;
  if (workbook && xlsxBytes && xlsxBytes !== workbook.data && rel) {
    // A workbook can be referenced by more than one chart or OLE object.
    // Fork the selected binding before editing so other consumers keep their data.
    const shared = pkg.parts.some((p) => {
      if (!p.name.toLowerCase().endsWith(".rels")) return false;
      const owner =
        p.name.toLowerCase() === "/_rels/.rels"
          ? "/"
          : p.name.replace(/\/_rels\/([^/]+)\.rels$/i, "/$1");
      if (owner === p.name) return false;
      try {
        return parseRels(decode(p.data)).items.some(
          (r) =>
            r.targetMode === "Internal" &&
            !(owner === resolved.partName && r.id === workbookId) &&
            resolveTarget(
              owner === "/" ? "/" : partName(owner),
              r.target,
            ).toLowerCase() === workbook!.name.toLowerCase(),
        );
      } catch {
        return true;
      } // An unreadable relationship part may contain another consumer.
    });
    if (shared) {
      workbookName = allocateChartWorkbookName(pkg);
      rel.target = workbookName;
      addWorkbook = changeRelationships = true;
    }
  }
  withPackageTransaction(pkg, () => {
    if (addWorkbook && workbookName && xlsxBytes) {
      pkg.addPart(workbookName, EMBEDDED_XLSX_CONTENT_TYPE, xlsxBytes);
    } else if (workbook && xlsxBytes) workbook.data = xlsxBytes;
    if (changeRelationships) pkg.setRels(resolved.partName, chartRels);
    chartPart.data = chartBytes;
  });
};

/**
 * Returns every chart on the slide, with its `ChartSpec` parsed from
 * the linked chart part. Skips graphic frames that don't carry a
 * `<c:chart>` reference (e.g. tables, diagrams).
 */
/**
 * For a graphic-frame shape that wraps a chart, returns the parsed
 * `ChartSpec`. Returns `null` when the shape isn't a chart wrapper
 * or the chart uses a kind we don't model (e.g. surface, radar).
 *
 * Convenience over `getSlideCharts(...).find((c) => c.shape === shape)`
 * when the caller already has the shape in hand (e.g. iterating
 * `getSlideShapes`).
 */
/**
 * Convenience over `getShapeChartSpec(shape)?.kind ?? null`. Returns
 * the chart's `ChartKind` ('bar', 'line', 'pie', …) when the shape
 * is a chart wrapper, or `null` for non-charts and charts whose
 * kind isn't modeled yet.
 */
export const getShapeChartKind = (shape: SlideShapeData): ChartKind | null => {
  const spec = getShapeChartSpec(shape);
  return spec === null ? null : spec.kind;
};

/**
 * Returns the categories axis labels of a chart shape, or `null`
 * if the shape isn't a chart wrapper or its kind isn't modeled.
 * Convenience over `getShapeChartSpec(shape)?.categories ?? null`.
 */
export const getShapeChartCategories = (
  shape: SlideShapeData,
): ReadonlyArray<string> | null => {
  const spec = getShapeChartSpec(shape);
  return spec === null ? null : spec.categories;
};

/**
 * Returns the chart's series-name list (in spec order). `null`
 * when the shape isn't a chart wrapper or the kind isn't modeled.
 */
export const getShapeChartSeriesNames = (
  shape: SlideShapeData,
): ReadonlyArray<string> | null => {
  const spec = getShapeChartSpec(shape);
  return spec === null ? null : spec.series.map((s) => s.name);
};

/**
 * Returns the values for the named series on a chart shape, or
 * `null` when the shape isn't a chart, the kind isn't modeled, or
 * no series matches `seriesName`.
 *
 * For `scatter` / `bubble` charts the returned array is the series'
 * y-channel (`<c:yVal>`); the paired x-channel and bubble sizes are on
 * the full spec via `getShapeChartSpec` (`series[].xValues` /
 * `series[].bubbleSizes`).
 */
export const getShapeChartSeriesValues = (
  shape: SlideShapeData,
  seriesName: string,
): ReadonlyArray<number | null> | null => {
  const spec = getShapeChartSpec(shape);
  if (spec === null) return null;
  const series = spec.series.find((s) => s.name === seriesName);
  return series ? series.values : null;
};

const chartColorResolver = (
  slide: SlideData,
  part: PartName,
  root: XmlElement,
) => {
  const theme = themeForChartPart(slide, part).theme,
    mapping = colorMapForChart(slide, root);
  return (color: XmlElement) => resolveDrawingColor(color, theme, mapping);
};
const readChartSpecInContext = (
  slide: SlideData,
  part: PartName,
  root: XmlElement,
): ChartSpec | null =>
  readChartSpec(root, chartColorResolver(slide, part, root));

const readShapeChart = <T>(
  shape: SlideShapeData,
  project: (
    root: XmlElement,
    spec: ChartSpec,
    slide: SlideData,
    part: PartName,
  ) => T,
): T | null => {
  const slide = shape[SHAPE_SLIDE];
  const resolved = resolveChartPartName(slide, shape);
  if (!resolved) return null;
  const part = slide[INTERNAL_PACKAGE].getPart(resolved.partName);
  if (!part) return null;
  try {
    const root = parseXml(decode(part.data)).root;
    const spec = readChartSpecInContext(slide, resolved.partName, root);
    return spec && project(root, spec, slide, resolved.partName);
  } catch {
    return null;
  }
};

export const getShapeChartSpec = (shape: SlideShapeData): ChartSpec | null =>
  readShapeChart(shape, (_root, spec) => spec);

/** @internal Rendering defaults must not overwrite authored settings or data. */
export const chartRenderingView = (shape: SlideShapeData) =>
  readShapeChart(shape, (root, spec, slide, part) => ({
    spec,
    seriesDisplays: readChartSeriesDisplays(root),
    dataLabelOverrides:
      spec.kind === "radar"
        ? readChartDataLabelOverrides(
            root,
            chartColorResolver(slide, part, root),
          )
        : [],
    seriesOpacities: readChartSeriesOpacities(slide, part, root, spec),
    plotGroups: readChartPlotGroups(slide, part, root, spec),
    areaPaint: readChartAreaPaint(slide, part, root, spec),
    plotAreaPaint: readChartPlotAreaPaint(slide, part, root, spec),
    axisLines: readChartAxisLines(
      slide,
      part,
      root,
      spec,
      chartColorResolver(slide, part, root),
    ),
    areaLine: readChartAreaLine(slide, part, root, spec, "chart"),
    plotAreaLine: readChartAreaLine(slide, part, root, spec, "plot"),
  }));

/**
 * Returns every chart on the slide that carries a series whose name
 * equals `seriesName` exactly. Useful for "find the revenue chart"
 * patterns where chart kind alone isn't unique. Skips charts whose
 * kind isn't modeled.
 */
export const findChartsBySeriesName = (
  slide: SlideData,
  seriesName: string,
): ReadonlyArray<SlideChartData> => {
  const out: SlideChartData[] = [];
  for (const chart of getSlideCharts(slide)) {
    if (chart.spec === null) continue;
    if (chart.spec.series.some((s) => s.name === seriesName)) out.push(chart);
  }
  return out;
};

/**
 * Returns every chart on the slide that carries at least one
 * `<c:trendline>` on any of its series. Useful for deck-audit reports
 * — trendlines are easy to add and easy to forget, and authors often
 * want to inventory them before publishing. Skips charts whose kind
 * isn't modeled.
 */
export const findChartsWithTrendlines = (
  slide: SlideData,
): ReadonlyArray<SlideChartData> => {
  const out: SlideChartData[] = [];
  for (const chart of getSlideCharts(slide)) {
    if (chart.spec === null) continue;
    if (chart.spec.series.some((s) => s.trendline !== undefined))
      out.push(chart);
  }
  return out;
};

/**
 * Returns every chart on the slide whose `dataLabels` (chart-level)
 * or any series-level `dataLabels` enable at least one of `showValue`,
 * `showCategory`, `showSeriesName`, or `showPercent`. Useful for
 * "which charts show numbers next to the data?" audits — purely
 * presence-based; doesn't validate numberFormat or position. Charts
 * whose kind isn't modeled are skipped.
 */
export const findChartsWithDataLabels = (
  slide: SlideData,
): ReadonlyArray<SlideChartData> => {
  const out: SlideChartData[] = [];
  const hasLabel = (dl: ChartSpec["dataLabels"] | undefined): boolean =>
    dl !== undefined &&
    Boolean(
      dl.showValue || dl.showCategory || dl.showSeriesName || dl.showPercent,
    );
  for (const chart of getSlideCharts(slide)) {
    if (chart.spec === null) continue;
    if (hasLabel(chart.spec.dataLabels)) {
      out.push(chart);
      continue;
    }
    if (chart.spec.series.some((s) => hasLabel(s.dataLabels))) {
      out.push(chart);
    }
  }
  return out;
};

/**
 * Returns the first chart on the slide whose parsed `kind` matches
 * `kind` (e.g. `'bar'`, `'line'`, `'pie'`). Returns `null` when no
 * chart on the slide has that kind, or when every chart on the slide
 * uses a kind this version doesn't yet model.
 */
export const findChartByKind = (
  slide: SlideData,
  kind: ChartKind,
): SlideChartData | null => {
  for (const chart of getSlideCharts(slide)) {
    if (chart.spec !== null && chart.spec.kind === kind) return chart;
  }
  return null;
};

/**
 * Histogram of chart kinds across the whole deck. Returns a frozen
 * `Record<ChartKind, number>` with every kind present (zeros for any
 * absent kind). Useful for deck-audit reports (e.g. "how many pie
 * charts does this presentation have?") without iterating every slide
 * by hand.
 *
 * Charts whose spec doesn't parse — typically a kind this version
 * doesn't yet model — are skipped silently, mirroring
 * `findChartByKind`'s null-spec handling.
 */
export const getPresentationChartKindCounts = (
  pres: PresentationData,
): Readonly<Record<ChartKind, number>> => {
  const counts: Record<ChartKind, number> = {
    bar: 0,
    column: 0,
    line: 0,
    pie: 0,
    doughnut: 0,
    area: 0,
    scatter: 0,
    radar: 0,
    bubble: 0,
  };
  for (const slide of getSlides(pres)) {
    for (const chart of getSlideCharts(slide)) {
      if (chart.spec === null) continue;
      counts[chart.spec.kind]++;
    }
  }
  return counts;
};

/**
 * Dense per-slide chart count array, 0-based by slide index. Counts
 * every chart returned by `getSlideCharts` regardless of whether its
 * `spec` parsed — useful for "which slides carry charts the renderer
 * doesn't yet model?" audits. Pair with
 * `getPresentationChartKindCounts` for kind-level totals.
 */
export const getPresentationChartCountsBySlide = (
  pres: PresentationData,
): ReadonlyArray<number> =>
  getSlides(pres).map((s) => getSlideCharts(s).length);

export const getSlideCharts = (
  slide: SlideData,
): ReadonlyArray<SlideChartData> => {
  const pkg = slide[INTERNAL_PACKAGE];
  const out: SlideChartData[] = [];
  for (const shape of slide[SLIDE_SHAPES]) {
    const resolved = resolveChartPartName(slide, shape);
    if (!resolved) continue;
    const chartPart = pkg.getPart(resolved.partName);
    if (!chartPart) continue;
    let spec: ChartSpec | null;
    try {
      const root = parseXml(decode(chartPart.data)).root;
      spec = readChartSpecInContext(slide, resolved.partName, root);
    } catch {
      spec = null;
    }
    out.push({ shape, spec });
  }
  return out;
};

void textNode;
