import { validateChartAxisTickLabelPositions } from "./axis-label-position.ts";
import { validateMarkerSizePt } from "./marker-size.ts";
import { INVERT_SOLID_FILL_NS, INVERT_SOLID_FILL_URI } from "./inversion.ts";
import { validateChartLabelPositions } from "./label-position.ts";
import { validateChartAxisCrossings } from "./axis-crossing.ts";
// Chart XML builder.
//
// Produces a complete `<c:chartSpace>` for one of the supported chart
// kinds (bar / column / line / pie). The chart references an embedded
// xlsx via `<c:externalData r:id="rId1">`; the calling layer is
// responsible for wiring that rel and writing the xlsx bytes. Inline
// `<c:strCache>` / `<c:numCache>` blocks carry the values so readers
// can render the chart without ever opening the workbook.

import { CHART_AUTO_ROTATION } from "./text-rotation.ts";
import { chartStyleElement } from "./chart-style.ts";
import { cellAddr, cellRange } from "./embedded-xlsx.ts";
import { isXYChartKind, xyWorkbookPlan } from "./xy-workbook.ts";
import {
  firstSliceAngle,
  gapAmountPercent,
  holeSizePercent,
  lineWidthEmu as validateLineWidthEmu,
  overlapPercent,
} from "../bounds.ts";
import {
  NS,
  firstChildElement,
  type XmlDocument,
  type XmlElement,
  attr,
  elem,
  qname,
  text,
} from "../xml/index.ts";
import type {
  ChartAxisCrossing,
  ChartErrorBars,
  ChartSeries,
  ChartSpec,
  ChartTextStyle,
} from "./types.ts";

// QNames (chart `c:` namespace) --------------------------------------------

const NS_C = NS.chart;
const NS_A = NS.dml;
const NS_R = NS.officeDocRels;

const c = (
  local: string,
): { prefix: string; localName: string; namespaceURI: string } =>
  qname("c", local, NS_C);
const a = (
  local: string,
): { prefix: string; localName: string; namespaceURI: string } =>
  qname("a", local, NS_A);
const r = (
  local: string,
): { prefix: string; localName: string; namespaceURI: string } =>
  qname("r", local, NS_R);

const ATTR_VAL = qname("", "val", "");
const ATTR_IDX = qname("", "idx", "");

// Helpers ------------------------------------------------------------------

const valNode = (
  name: ReturnType<typeof c>,
  val: string | number,
): XmlElement => elem(name, { attrs: [attr(ATTR_VAL, String(val))] });

const axisCrossingElements = (
  crossing: ChartAxisCrossing | undefined,
): XmlElement[] =>
  crossing === undefined
    ? []
    : [
        valNode(
          c(typeof crossing === "string" ? "crosses" : "crossesAt"),
          typeof crossing === "string" ? crossing : crossing.at,
        ),
      ];

const ptNode = (idx: number, value: string): XmlElement =>
  elem(c("pt"), {
    attrs: [attr(ATTR_IDX, String(idx))],
    children: [elem(c("v"), { children: [text(value)] })],
  });

const strRef = (formula: string, points: ReadonlyArray<string>): XmlElement => {
  const strCache = elem(c("strCache"), {
    children: [
      valNode(c("ptCount"), points.length),
      ...points.map((p, i) => ptNode(i, p)),
    ],
  });
  return elem(c("strRef"), {
    children: [elem(c("f"), { children: [text(formula)] }), strCache],
  });
};

const numRef = (
  formula: string,
  points: ReadonlyArray<number | null>,
  numberFormat = "General",
): XmlElement => {
  const numCache = elem(c("numCache"), {
    children: [
      elem(c("formatCode"), { children: [text(numberFormat)] }),
      valNode(c("ptCount"), points.length),
      ...points
        .map((v, i) => (v === null ? null : ptNode(i, String(v))))
        .filter((n): n is XmlElement => n !== null),
    ],
  });
  // No cells exist for a zero-length channel. A literal empty cache is
  // valid CT_NumData; a reversed range such as B2:B1 is not an empty range.
  if (points.length === 0)
    return elem(c("numLit"), { children: numCache.children });
  return elem(c("numRef"), {
    children: [elem(c("f"), { children: [text(formula)] }), numCache],
  });
};

const numberFormatElement = (
  code: string | undefined,
  linked: boolean | undefined,
): XmlElement[] =>
  code === undefined && linked === undefined
    ? []
    : [
        elem(c("numFmt"), {
          attrs: [
            attr(qname("", "formatCode", ""), code ?? "General"),
            attr(qname("", "sourceLinked", ""), linked === true ? "1" : "0"),
          ],
        }),
      ];

const solidFillSpPr = (color: string): XmlElement => {
  const srgbClr = elem(a("srgbClr"), {
    attrs: [attr(qname("", "val", ""), color.replace(/^#/, "").toUpperCase())],
  });
  const solidFill = elem(a("solidFill"), { children: [srgbClr] });
  return elem(c("spPr"), { children: [solidFill] });
};

// <c:majorGridlines|minorGridlines> with optional spPr/ln/solidFill/srgbClr
// for the gridline color. Centralizes the per-gridline color emit so all
// four axis-gridline slots share the same shape.
const gridlinesElement = (
  local: "majorGridlines" | "minorGridlines",
  color: string | null | undefined,
  widthEmu?: number,
): XmlElement => {
  if (color === undefined && widthEmu === undefined) return elem(c(local));
  return elem(c(local), {
    children: [spPrChildren(undefined, color, widthEmu)],
  });
};

// Generic <c:spPr> with optional fill color + line color. Used for the
// chart-area / plot-area background, where authors set one or both.
const spPrChildren = (
  fill: string | null | undefined,
  stroke: string | null | undefined,
  widthEmu?: number,
): XmlElement => {
  const paint = (color: string | null): XmlElement =>
    color === null
      ? elem(a("noFill"))
      : elem(a("solidFill"), {
          children: [
            elem(a("srgbClr"), {
              attrs: [
                attr(
                  qname("", "val", ""),
                  color.replace(/^#/, "").toUpperCase(),
                ),
              ],
            }),
          ],
        });
  const out: XmlElement[] = [];
  if (fill !== undefined) out.push(paint(fill));
  if (stroke !== undefined || widthEmu !== undefined)
    out.push(
      elem(a("ln"), {
        attrs:
          widthEmu === undefined
            ? []
            : [
                attr(
                  qname("", "w", ""),
                  String(validateLineWidthEmu(widthEmu, "chart stroke width")),
                ),
              ],
        children: stroke === undefined ? [] : [paint(stroke)],
      }),
    );
  return elem(c("spPr"), { children: out });
};

// Default theme accent palette (accent1..accent6 of the built-in default theme).
const DEFAULT_ACCENT_COLORS = [
  "4472C4", // accent1
  "ED7D31", // accent2
  "A5A5A5", // accent3
  "FFC000", // accent4
  "5B9BD5", // accent5
  "70AD47", // accent6
];

// Fill and outline are independent DrawingML paint choices. The legacy
// series color remains the default line color when none is specified.
const seriesSpPr = (color: string, series: ChartSeries): XmlElement => {
  const sp = spPrChildren(
    `#${color}`,
    series.lineColor === undefined ? `#${color}` : series.lineColor,
    series.lineWidthEmu,
  );
  if (series.lineDash !== undefined) {
    const ln = firstChildElement(sp, a("ln"))!;
    ln.children.push(
      elem(a("prstDash"), {
        attrs: [attr(qname("", "val", ""), series.lineDash)],
      }),
    );
  }
  return sp;
};

// Marker paint belongs to its own shape-property host, independently of
// the series' fill and data line. A paint-only marker still needs a host.
const markerElement = (series: ChartSeries): XmlElement | null => {
  const {
    markerSymbol: symbol,
    markerSizePt: sizePt,
    markerFill: fill,
    markerStrokeColor: stroke,
    markerStrokeWidthEmu: width,
  } = series;
  if ([symbol, sizePt, fill, stroke, width].every((v) => v === undefined))
    return null;
  const children: XmlElement[] = [];
  if (symbol !== undefined) children.push(valNode(c("symbol"), symbol));
  if (sizePt !== undefined)
    children.push(valNode(c("size"), validateMarkerSizePt(sizePt)));
  if (fill !== undefined || stroke !== undefined || width !== undefined)
    children.push(spPrChildren(fill, stroke, width));
  return elem(c("marker"), { children });
};

// Build the array of `<c:dPt>` overrides for a series — combines the
// sparse pointColors and pointExplosions maps. Each authored index
// emits a `<c:dPt>` with `<c:idx>` + `<c:bubble3D val="0"/>` (required
// by .pptx readers) + optional explosion + optional spPr/solidFill color.
const dPtElements = (
  colors: ReadonlyArray<string | null> | undefined,
  explosions: ReadonlyArray<number | null> | undefined,
  inversions?: ReadonlyArray<boolean | null>,
): XmlElement[] => {
  const out: XmlElement[] = [];
  const colorLen = colors?.length ?? 0;
  const explLen = explosions?.length ?? 0;
  const max = Math.max(colorLen, explLen, inversions?.length ?? 0);
  for (let i = 0; i < max; i++) {
    const color = colors?.[i] ?? null;
    const expl = explosions?.[i] ?? null;
    const inversion = inversions?.[i] ?? undefined;
    if (
      color === null &&
      (expl === null || !Number.isFinite(expl)) &&
      inversion === undefined
    )
      continue;
    const children: XmlElement[] = [
      valNode(c("idx"), i),
      ...(inversion === undefined
        ? []
        : [valNode(c("invertIfNegative"), inversion ? "1" : "0")]),
      // Readers expect bubble3D=0 on every dPt outside bubble charts.
      valNode(c("bubble3D"), "0"),
    ];
    if (expl !== null) children.push(valNode(c("explosion"), Math.round(expl)));
    if (color !== null) {
      const hex = color.replace(/^#/, "").toUpperCase();
      children.push(solidFillSpPr(hex));
    }
    out.push(elem(c("dPt"), { children }));
  }
  return out;
};

// `<c:trendline>` for a series. Carries trendlineType + optional
// period (movingAvg) / order (poly) / forward / backward / spPr color.
const trendlineElement = (
  tl: NonNullable<NonNullable<ChartSpec["series"][number]["trendline"]>>,
): XmlElement => {
  const children: XmlElement[] = [];
  // CT_Trendline schema order: <c:name> first, before <c:spPr>.
  if (tl.name !== undefined) {
    children.push(elem(c("name"), { children: [text(tl.name)] }));
  }
  if (tl.color !== undefined) {
    const hex = tl.color.replace(/^#/, "").toUpperCase();
    const ln = elem(a("ln"), {
      children: [
        elem(a("solidFill"), {
          children: [
            elem(a("srgbClr"), { attrs: [attr(qname("", "val", ""), hex)] }),
          ],
        }),
      ],
    });
    children.push(elem(c("spPr"), { children: [ln] }));
  }
  children.push(valNode(c("trendlineType"), tl.type));
  if (tl.type === "movingAvg" && tl.period !== undefined) {
    children.push(valNode(c("period"), tl.period));
  }
  if (tl.type === "poly" && tl.order !== undefined) {
    children.push(valNode(c("order"), tl.order));
  }
  if (tl.forward !== undefined)
    children.push(valNode(c("forward"), tl.forward));
  if (tl.backward !== undefined)
    children.push(valNode(c("backward"), tl.backward));
  // CT_Trendline schema order: dispRSqr before dispEq, both after
  // forward/backward and before trendlineLbl/extLst. Both are written even
  // when off: desktop editors show the equation and R² when they are
  // missing.
  children.push(valNode(c("dispRSqr"), tl.displayRSquared ? "1" : "0"));
  children.push(valNode(c("dispEq"), tl.displayEquation ? "1" : "0"));
  return elem(c("trendline"), { children });
};

const ERROR_BAR_TYPES = new Set(["both", "plus", "minus"]);
const ERROR_VALUE_TYPES = new Set([
  "fixedVal",
  "percentage",
  "stdDev",
  "stdErr",
  "cust",
]);

/** Kinds whose series carry `<c:errBars>` (CT_BarSer/LineSer/AreaSer/ScatterSer/BubbleSer). */
const errorBarKind = (kind: string): boolean =>
  ["bar", "column", "line", "area", "scatter", "bubble"].includes(kind);

/** Rejects error bars the schema cannot hold, before anything changes. */
export const validateChartErrorBars = (spec: ChartSpec): void => {
  spec.series.forEach((series, i) => {
    const bars = series.errorBars;
    if (bars === undefined) return;
    const label = `series[${i}].errorBars`;
    const kind = series.chartKind ?? spec.kind;
    if (!errorBarKind(kind))
      throw new TypeError(`${label}: ${kind} series have no error bars`);
    if (!ERROR_BAR_TYPES.has(bars.type))
      throw new RangeError(`${label}.type: expected both, plus or minus`);
    if (!ERROR_VALUE_TYPES.has(bars.valueType))
      throw new RangeError(
        `${label}.valueType: expected fixedVal, percentage, stdDev, stdErr or cust`,
      );
    if (bars.direction !== undefined) {
      if (bars.direction !== "x" && bars.direction !== "y")
        throw new RangeError(`${label}.direction: expected x or y`);
      if (bars.direction === "x" && !isXYChartKind(kind))
        throw new TypeError(
          `${label}.direction: only scatter and bubble series have X error bars`,
        );
    }
    if (
      bars.value !== undefined &&
      (typeof bars.value !== "number" ||
        !Number.isFinite(bars.value) ||
        bars.value < 0)
    )
      throw new RangeError(`${label}.value: expected a finite number >= 0`);
    if (bars.noEndCap !== undefined && typeof bars.noEndCap !== "boolean")
      throw new TypeError(`${label}.noEndCap: expected a boolean`);
    for (const side of ["plus", "minus"] as const) {
      const list = bars[side];
      if (list === undefined) continue;
      if (
        !Array.isArray(list) ||
        list.some(
          (v) => v !== null && (typeof v !== "number" || !Number.isFinite(v)),
        )
      )
        throw new TypeError(
          `${label}.${side}: expected finite numbers or nulls`,
        );
    }
  });
};

// Custom amounts: a range of the data sheet with its cached values, or
// literal values.
const customErrorValues = (
  side: "plus" | "minus",
  values: ReadonlyArray<number | null>,
  ref: string | undefined,
): XmlElement =>
  elem(c(side), {
    children: [
      ref
        ? numRef(ref, values)
        : elem(c("numLit"), {
            children: [
              elem(c("formatCode"), { children: [text("General")] }),
              valNode(c("ptCount"), values.length),
              ...values
                .map((v, i) => (v === null ? null : ptNode(i, String(v))))
                .filter((n): n is XmlElement => n !== null),
            ],
          }),
    ],
  });

/** Default amount of an error bar whose value was not given. */
export const defaultErrorBarValue = (bars: ChartErrorBars): number =>
  bars.valueType === "percentage" ? 5 : 1;

// CT_ErrBars: errDir?, errBarType, errValType, noEndCap?, plus?, minus?,
// val?, spPr?. The direction only exists for XY series.
const errorBarsElement = (bars: ChartErrorBars, xy: boolean): XmlElement => {
  const children: XmlElement[] = [];
  if (xy) children.push(valNode(c("errDir"), bars.direction ?? "y"));
  children.push(
    valNode(c("errBarType"), bars.type),
    valNode(c("errValType"), bars.valueType),
    valNode(c("noEndCap"), bars.noEndCap ? "1" : "0"),
  );
  if (bars.valueType === "cust") {
    if (bars.type !== "minus")
      children.push(customErrorValues("plus", bars.plus ?? [], bars.plusRef));
    if (bars.type !== "plus")
      children.push(
        customErrorValues("minus", bars.minus ?? [], bars.minusRef),
      );
  } else if (bars.valueType !== "stdErr")
    children.push(valNode(c("val"), bars.value ?? defaultErrorBarValue(bars)));
  if (bars.color !== undefined)
    children.push(spPrChildren(undefined, bars.color));
  return elem(c("errBars"), { children });
};

/** Scatter styles that draw no connecting line / no markers. */
const scatterHidesLine = (style: ChartSpec["scatterStyle"]): boolean =>
  style === "marker" || style === "none";
const scatterHidesMarkers = (style: ChartSpec["scatterStyle"]): boolean =>
  style === "line" || style === "smooth" || style === "none";
const scatterSmooth = (style: ChartSpec["scatterStyle"]): boolean =>
  style === "smooth" || style === "smoothMarker";

/**
 * Authored scatter / radar sub-types are carried by the series too: other
 * editors draw a scatter series' line and markers from its own formatting
 * and treat the group style as a hint. A hidden part is therefore written
 * as `<a:ln><a:noFill/>` or `<c:symbol val="none"/>` unless the series
 * says otherwise; the reader folds those implied values away again.
 */
const impliedSeriesStyle = (
  spec: ChartSpec,
  series: ChartSeries,
  kind: string,
): ChartSeries => {
  if (kind === "scatter") {
    const style = spec.scatterStyle ?? "marker";
    return {
      ...series,
      ...(series.lineColor === undefined && scatterHidesLine(style)
        ? { lineColor: null }
        : {}),
      ...(series.markerSymbol === undefined && scatterHidesMarkers(style)
        ? { markerSymbol: "none" as const }
        : {}),
    };
  }
  if (kind === "radar") {
    const style = spec.radarStyle ?? "standard";
    return series.markerSymbol === undefined && style !== "marker"
      ? { ...series, markerSymbol: "none" }
      : series;
  }
  return series;
};

const seriesElement = (
  spec: ChartSpec,
  seriesIdx: number,
  sheet: string,
): XmlElement => {
  const authored = spec.series[seriesIdx];
  if (!authored) throw new Error("seriesElement: out of range");
  // Styling choices belong to this series' plot group, not the chart base kind.
  const kind = authored.chartKind ?? spec.kind;
  const series = impliedSeriesStyle(spec, authored, kind);
  const xy = isXYChartKind(kind);
  const xyColumns = xy ? xyWorkbookPlan(spec).series[seriesIdx]! : null;

  const headerCellFormula = cellAddr(
    sheet,
    0,
    xyColumns ? xyColumns.y : seriesIdx + 1,
  );
  const catRange = cellRange(sheet, 1, 0, spec.categories.length);
  const valueCount = series.values.length;
  const valRange = cellRange(sheet, 1, seriesIdx + 1, valueCount);

  const color =
    series.color !== undefined
      ? series.color.replace(/^#/, "").toUpperCase()
      : (DEFAULT_ACCENT_COLORS[seriesIdx % DEFAULT_ACCENT_COLORS.length] ??
        "4472C4");

  // Numeric caches have their own extent. A missing point within that extent
  // can display as zero; padding to the category count invents additional
  // plotted points and labels for a shorter (or empty) series.

  const children: XmlElement[] = [
    valNode(c("idx"), seriesIdx),
    valNode(c("order"), seriesIdx),
    elem(c("tx"), { children: [strRef(headerCellFormula, [series.name])] }),
  ];
  // A line's legacy color also authors its outline. Other chart kinds keep
  // their omitted outline unless paint, width or dash is explicitly supplied.
  // An authored noFill remains independent of the series' solid fill.
  if (
    kind === "line" ||
    kind === "scatter" ||
    kind === "radar" ||
    series.lineColor !== undefined ||
    series.lineWidthEmu !== undefined ||
    series.lineDash !== undefined
  ) {
    children.push(seriesSpPr(color, series));
  } else {
    children.push(solidFillSpPr(color));
  }
  // invertIfNegative only exists on CT_BarSer (bar/column). Emitting it on a
  // line/pie/area series is schema-invalid, so gate on the bar-family kinds.
  if (
    series.invertIfNegative !== undefined &&
    (kind === "bar" || kind === "column")
  ) {
    children.push(
      valNode(c("invertIfNegative"), series.invertIfNegative ? "1" : "0"),
    );
  }
  // <c:marker> is only valid on the marker-bearing series types
  // (CT_LineSer / CT_ScatterSer / CT_RadarSer). Emitting it on bar/column/
  // pie/doughnut/area produces schema-invalid XML.
  if (kind === "line" || kind === "scatter" || kind === "radar") {
    const mk = markerElement(series);
    if (mk !== null) children.push(mk);
  }
  // <c:dPt> overrides go after invertIfNegative / marker per schema.
  for (const dPt of dPtElements(
    series.pointColors,
    series.pointExplosions,
    kind === "bar" || kind === "column"
      ? series.pointInvertIfNegative
      : undefined,
  )) {
    children.push(dPt);
  }
  const serDLbls = buildDLblsFromLabels(series.dataLabels);
  if (serDLbls !== null) children.push(serDLbls);
  // <c:trendline> exists on CT_BarSer/LineSer/AreaSer/ScatterSer/BubbleSer but
  // NOT on CT_PieSer (pie/doughnut) or CT_RadarSer — emitting it there is
  // schema-invalid, so gate on the trendline-bearing kinds.
  if (
    series.trendline &&
    kind !== "pie" &&
    kind !== "doughnut" &&
    kind !== "radar"
  ) {
    children.push(trendlineElement(series.trendline));
  }
  if (series.errorBars !== undefined && errorBarKind(kind))
    children.push(errorBarsElement(series.errorBars, xy));
  if (xyColumns) {
    // CT_ScatterSer / CT_BubbleSer: xVal?, yVal?, then bubbleSize, smooth.
    if (xyColumns.x !== null && series.xValues !== undefined)
      children.push(
        elem(c("xVal"), {
          children: [
            numRef(
              cellRange(sheet, 1, xyColumns.x, series.xValues.length),
              series.xValues,
              series.xNumberFormat,
            ),
          ],
        }),
      );
    children.push(
      elem(c("yVal"), {
        children: [
          numRef(
            cellRange(sheet, 1, xyColumns.y, series.values.length),
            series.values,
            series.numberFormat,
          ),
        ],
      }),
    );
    if (kind === "bubble") {
      const sizes = series.bubbleSizes ?? [];
      children.push(
        elem(c("bubbleSize"), {
          children: [
            numRef(
              cellRange(sheet, 1, xyColumns.size!, sizes.length),
              sizes,
              series.bubbleSizeNumberFormat,
            ),
          ],
        }),
        valNode(c("bubble3D"), "0"),
      );
    } else {
      children.push(
        valNode(
          c("smooth"),
          (series.smooth ?? scatterSmooth(spec.scatterStyle)) ? "1" : "0",
        ),
      );
    }
    return elem(c("ser"), { children });
  }
  if (spec.categories.length > 0)
    children.push(
      elem(c("cat"), {
        children: [
          spec.categoryNumberFormat === undefined
            ? strRef(catRange, spec.categories)
            : numRef(
                catRange,
                spec.categories.map((v) =>
                  v.trim() === "" ? null : Number(v),
                ),
                spec.categoryNumberFormat,
              ),
        ],
      }),
    );
  children.push(
    elem(c("val"), {
      children: [numRef(valRange, series.values, series.numberFormat)],
    }),
  );
  // Line series always get an explicit <c:smooth>: the schema default for an
  // absent element is val="1", so LibreOffice draws an unauthored line as a
  // smooth curve while other readers draw it straight. Native output always
  // writes the element; doing the same keeps every renderer straight unless
  // smoothing was asked for. (Only CT_LineSer carries smooth — emitting it on
  // a bar/pie series would be schema-invalid.)
  if (kind === "line") {
    children.push(valNode(c("smooth"), series.smooth === true ? "1" : "0"));
  }
  if (
    (kind === "bar" || kind === "column") &&
    series.negativeColor !== undefined
  ) {
    // Native output writes this extension alongside invertIfNegative: the switch
    // enables inversion and this record selects its solid color. Retain both
    // despite MS-ODRAWXML's older mutual-exclusion wording; native open/save
    // controls preserve both and remain editable.
    const sp = solidFillSpPr(
      series.negativeColor.replace(/^#/, "").toUpperCase(),
    );
    sp.name = qname("c14", "spPr", INVERT_SOLID_FILL_NS);
    children.push(
      elem(c("extLst"), {
        children: [
          elem(c("ext"), {
            attrs: [attr(qname("", "uri", ""), INVERT_SOLID_FILL_URI)],
            children: [
              elem(qname("c14", "invertSolidFillFmt", INVERT_SOLID_FILL_NS), {
                children: [sp],
              }),
            ],
          }),
        ],
      }),
    );
  }
  return elem(c("ser"), { children });
};

// Axis ids — arbitrary distinct positive 32-bit integers; readers just
// need them stable within the chart for the `<c:crossAx>` back-pointer.
const CAT_AX_ID = 111111111;
const VAL_AX_ID = 222222222;
// Secondary axis pair for combo charts (series with `secondaryAxis: true`).
const SEC_CAT_AX_ID = 333333333;
const SEC_VAL_AX_ID = 444444444;

interface AxisIdPair {
  readonly cat: number;
  readonly val: number;
}

const PRIMARY_AXES: AxisIdPair = { cat: CAT_AX_ID, val: VAL_AX_ID };
const SECONDARY_AXES: AxisIdPair = { cat: SEC_CAT_AX_ID, val: SEC_VAL_AX_ID };

/** Category kinds that can participate in a combo plot-group split. */
const COMBO_KINDS = new Set<string>(["bar", "column", "line", "area"]);

const effectiveSeriesKind = (spec: ChartSpec, seriesIdx: number): string =>
  spec.series[seriesIdx]?.chartKind ?? spec.kind;

/**
 * Splits the series into plot groups keyed by (effective kind, axis), in
 * the order of each group's first series.
 */
const comboPlotGroups = (
  spec: ChartSpec,
): { kind: string; secondary: boolean; indices: number[] }[] => {
  const groups = new Map<
    string,
    { kind: string; secondary: boolean; indices: number[] }
  >();
  for (let i = 0; i < spec.series.length; i++) {
    const kind = effectiveSeriesKind(spec, i);
    const secondary = spec.series[i]?.secondaryAxis === true;
    const key = `${kind}|${secondary ? "1" : "0"}`;
    const group = groups.get(key);
    if (group) group.indices.push(i);
    else groups.set(key, { kind, secondary, indices: [i] });
  }
  // Model positions follow native group/series order, so groups are written
  // in the order of their first series: the spec's series order survives a
  // read whenever each kind's series are contiguous, and the chart reads
  // back with its first series' kind as the base kind. Renderers choose
  // their own paint order (bars under lines) independently of XML order.
  return [...groups.values()];
};

// Build a `<c:txPr>` block carrying axis tick-label font / color and an
// optional `<a:bodyPr rot="N"/>` rotation. Returns null when neither
// labelStyle nor rotation are set.
const axisTxPrElement = (
  style: ChartTextStyle | undefined,
  rotationDeg: number | null | undefined,
): XmlElement | null => {
  if (style === undefined && rotationDeg === undefined) return null;
  const bodyAttrs: ReturnType<typeof attr>[] = [];
  if (rotationDeg !== undefined) {
    bodyAttrs.push(
      attr(
        qname("", "rot", ""),
        String(
          rotationDeg === null
            ? CHART_AUTO_ROTATION
            : Math.round(rotationDeg * 60000),
        ),
      ),
    );
  }
  bodyAttrs.push(attr(qname("", "vert", ""), "horz"));
  const bodyPr = elem(a("bodyPr"), { attrs: bodyAttrs });
  const { attrs: defAttrs, children: defChildren } = rPrAttrsFromStyle(style);
  const defRPr = elem(a("defRPr"), { attrs: defAttrs, children: defChildren });
  const pPr = elem(a("pPr"), { children: [defRPr] });
  // An empty <a:p> with just pPr is the canonical "defaults only" shape.
  return elem(c("txPr"), {
    children: [bodyPr, elem(a("lstStyle")), elem(a("p"), { children: [pPr] })],
  });
};

const catAxis = (spec: ChartSpec): XmlElement => {
  const catOrientation = spec.categoryAxisOrientation ?? "minMax";
  const children: XmlElement[] = [
    valNode(c("axId"), CAT_AX_ID),
    elem(c("scaling"), {
      children: [valNode(c("orientation"), catOrientation)],
    }),
    valNode(c("delete"), spec.categoryAxisHidden ? "1" : "0"),
    valNode(c("axPos"), spec.kind === "bar" ? "l" : "b"),
  ];
  if (spec.categoryAxisMajorGridlines) {
    children.push(
      gridlinesElement(
        "majorGridlines",
        spec.categoryAxisMajorGridlineColor,
        spec.categoryAxisMajorGridlineWidthEmu,
      ),
    );
  }
  if (spec.categoryAxisMinorGridlines) {
    children.push(
      gridlinesElement(
        "minorGridlines",
        spec.categoryAxisMinorGridlineColor,
        spec.categoryAxisMinorGridlineWidthEmu,
      ),
    );
  }
  if (spec.categoryAxisTitle !== undefined) {
    children.push(
      titleElement(
        spec.categoryAxisTitle,
        spec.categoryAxisTitleStyle,
        spec.categoryAxisTitleRotationDeg,
      ),
    );
  }
  children.push(
    ...numberFormatElement(
      spec.categoryAxisNumberFormat,
      spec.categoryAxisNumberFormatSourceLinked,
    ),
  );
  if (spec.categoryAxisMajorTickMark !== undefined) {
    children.push(valNode(c("majorTickMark"), spec.categoryAxisMajorTickMark));
  }
  if (spec.categoryAxisMinorTickMark !== undefined) {
    children.push(valNode(c("minorTickMark"), spec.categoryAxisMinorTickMark));
  }
  if (spec.categoryAxisTickLabelPos !== undefined) {
    children.push(valNode(c("tickLblPos"), spec.categoryAxisTickLabelPos));
  }
  if (
    spec.categoryAxisLineColor !== undefined ||
    spec.categoryAxisLineWidthEmu !== undefined
  ) {
    children.push(
      spPrChildren(
        undefined,
        spec.categoryAxisLineColor,
        spec.categoryAxisLineWidthEmu,
      ),
    );
  }
  const catTxPr = axisTxPrElement(
    spec.categoryAxisLabelStyle,
    spec.categoryAxisLabelRotationDeg,
  );
  if (catTxPr) children.push(catTxPr);
  children.push(valNode(c("crossAx"), VAL_AX_ID));
  children.push(...axisCrossingElements(spec.categoryAxisCrosses));
  // CT_CatAx schema order: lblAlgn / lblOffset precede the skip pair.
  if (spec.categoryAxisLabelAlign !== undefined) {
    children.push(valNode(c("lblAlgn"), spec.categoryAxisLabelAlign));
  }
  if (spec.categoryAxisLabelOffset !== undefined) {
    children.push(valNode(c("lblOffset"), spec.categoryAxisLabelOffset));
  }
  if (spec.categoryAxisTickLabelSkip !== undefined) {
    children.push(valNode(c("tickLblSkip"), spec.categoryAxisTickLabelSkip));
  }
  if (spec.categoryAxisTickMarkSkip !== undefined) {
    children.push(valNode(c("tickMarkSkip"), spec.categoryAxisTickMarkSkip));
  }
  if (spec.categoryAxisNoMultiLevelLabel !== undefined)
    children.push(
      valNode(
        c("noMultiLvlLbl"),
        spec.categoryAxisNoMultiLevelLabel ? "1" : "0",
      ),
    );
  return elem(c("catAx"), { children });
};

const valAxis = (spec: ChartSpec): XmlElement => {
  // CT_Scaling sequence (dml-chart.xsd): logBase, orientation, max, min, extLst.
  // `max` MUST precede `min` — emitting them in the other order is rejected by
  // the schema ("element max: expected extLst").
  const scalingChildren: XmlElement[] = [];
  if (spec.valueAxis?.logBase !== undefined) {
    scalingChildren.push(valNode(c("logBase"), spec.valueAxis.logBase));
  }
  scalingChildren.push(
    valNode(c("orientation"), spec.valueAxisOrientation ?? "minMax"),
  );
  if (spec.valueAxis?.max !== undefined) {
    scalingChildren.push(valNode(c("max"), spec.valueAxis.max));
  }
  if (spec.valueAxis?.min !== undefined) {
    scalingChildren.push(valNode(c("min"), spec.valueAxis.min));
  }
  const children: XmlElement[] = [
    valNode(c("axId"), VAL_AX_ID),
    elem(c("scaling"), { children: scalingChildren }),
    valNode(c("delete"), spec.valueAxisHidden ? "1" : "0"),
    valNode(c("axPos"), spec.kind === "bar" ? "b" : "l"),
  ];
  if (spec.valueAxisMajorGridlines) {
    children.push(
      gridlinesElement(
        "majorGridlines",
        spec.valueAxisMajorGridlineColor,
        spec.valueAxisMajorGridlineWidthEmu,
      ),
    );
  }
  if (spec.valueAxisMinorGridlines) {
    children.push(
      gridlinesElement(
        "minorGridlines",
        spec.valueAxisMinorGridlineColor,
        spec.valueAxisMinorGridlineWidthEmu,
      ),
    );
  }
  if (spec.valueAxisTitle !== undefined) {
    children.push(
      titleElement(
        spec.valueAxisTitle,
        spec.valueAxisTitleStyle,
        spec.valueAxisTitleRotationDeg,
      ),
    );
  }
  children.push(
    ...numberFormatElement(
      spec.valueAxis?.numberFormat,
      spec.valueAxis?.numberFormatSourceLinked,
    ),
  );
  if (spec.valueAxisMajorTickMark !== undefined) {
    children.push(valNode(c("majorTickMark"), spec.valueAxisMajorTickMark));
  }
  if (spec.valueAxisMinorTickMark !== undefined) {
    children.push(valNode(c("minorTickMark"), spec.valueAxisMinorTickMark));
  }
  if (spec.valueAxisTickLabelPos !== undefined) {
    children.push(valNode(c("tickLblPos"), spec.valueAxisTickLabelPos));
  }
  if (
    spec.valueAxisLineColor !== undefined ||
    spec.valueAxisLineWidthEmu !== undefined
  ) {
    children.push(
      spPrChildren(
        undefined,
        spec.valueAxisLineColor,
        spec.valueAxisLineWidthEmu,
      ),
    );
  }
  const valTxPr = axisTxPrElement(
    spec.valueAxisLabelStyle,
    spec.valueAxisLabelRotationDeg,
  );
  if (valTxPr) children.push(valTxPr);
  children.push(valNode(c("crossAx"), CAT_AX_ID));
  children.push(...axisCrossingElements(spec.valueAxisCrosses));
  if (spec.valueAxisCrossBetween !== undefined) {
    children.push(valNode(c("crossBetween"), spec.valueAxisCrossBetween));
  }
  if (spec.valueAxis?.majorUnit !== undefined) {
    children.push(valNode(c("majorUnit"), spec.valueAxis.majorUnit));
  }
  if (spec.valueAxis?.minorUnit !== undefined) {
    children.push(valNode(c("minorUnit"), spec.valueAxis.minorUnit));
  }
  if (spec.valueAxis?.displayUnits !== undefined) {
    children.push(
      elem(c("dispUnits"), {
        children: [valNode(c("builtInUnit"), spec.valueAxis.displayUnits)],
      }),
    );
  }
  return elem(c("valAx"), { children });
};

// Build `<c:dLbls>` from a ChartDataLabels (showVal / showCatName /
// showSerName / showPercent toggles plus optional numFmt, position,
// separator). Returns `null` when no dataLabels were authored so
// callers know to skip the element entirely.
const buildDLblsFromLabels = (
  dl: ChartSpec["dataLabels"] | undefined,
): XmlElement | null => {
  if (!dl) return null;
  const children: XmlElement[] = [];
  children.push(
    ...numberFormatElement(dl.numberFormat, dl.numberFormatSourceLinked),
  );
  if (dl.textStyle !== undefined) {
    // CT_DLbls schema order places <c:txPr> before <c:dLblPos>; reusing
    // `axisTxPrElement` keeps the formatting consistent with axis / legend.
    const txPr = axisTxPrElement(dl.textStyle, undefined);
    if (txPr !== null) children.push(txPr);
  }
  if (dl.position !== undefined)
    children.push(valNode(c("dLblPos"), dl.position));
  children.push(
    valNode(c("showLegendKey"), "0"),
    valNode(c("showVal"), dl.showValue ? "1" : "0"),
    valNode(c("showCatName"), dl.showCategory ? "1" : "0"),
    valNode(c("showSerName"), dl.showSeriesName ? "1" : "0"),
    valNode(c("showPercent"), dl.showPercent ? "1" : "0"),
    valNode(c("showBubbleSize"), "0"),
  );
  if (dl.separator !== undefined) {
    children.push(elem(c("separator"), { children: [text(dl.separator)] }));
  }
  return elem(c("dLbls"), { children });
};

const dLblsElement = (spec: ChartSpec): XmlElement | null =>
  buildDLblsFromLabels(spec.dataLabels);

const buildBarChart = (
  spec: ChartSpec,
  sheet: string,
  direction: "col" | "bar",
  seriesIndices: ReadonlyArray<number>,
  axes: AxisIdPair,
): XmlElement => {
  const ser = seriesIndices.map((i) => seriesElement(spec, i, sheet));
  const dl = dLblsElement(spec);
  const grouping = spec.grouping ?? "clustered";
  const children: XmlElement[] = [
    valNode(c("barDir"), direction),
    valNode(c("grouping"), grouping),
    valNode(c("varyColors"), spec.varyColors ? "1" : "0"),
    ...ser,
    ...(dl ? [dl] : []),
  ];
  if (spec.gapWidthPct !== undefined) {
    children.push(
      valNode(
        c("gapWidth"),
        gapAmountPercent(spec.gapWidthPct, "chart: gapWidthPct"),
      ),
    );
  }
  // Stacked / 100%-stacked bars must overlap fully (overlap=100), otherwise
  // readers draw each series in its own sub-slot and the "stack" spreads
  // sideways across the category. Native output always writes overlap=100 for
  // these groupings; default to it when the caller didn't set an explicit
  // overlap. Clustered keeps the reader default (no element emitted).
  const overlapPct =
    spec.overlapPct ??
    (grouping === "stacked" || grouping === "percentStacked" ? 100 : undefined);
  if (overlapPct !== undefined) {
    children.push(
      valNode(c("overlap"), overlapPercent(overlapPct, "chart: overlapPct")),
    );
  }
  children.push(valNode(c("axId"), axes.cat), valNode(c("axId"), axes.val));
  return elem(c(direction === "col" ? "barChart" : "barChart"), { children });
};

const buildLineChart = (
  spec: ChartSpec,
  sheet: string,
  seriesIndices: ReadonlyArray<number>,
  axes: AxisIdPair,
): XmlElement => {
  const ser = seriesIndices.map((i) => seriesElement(spec, i, sheet));
  const dl = dLblsElement(spec);
  const children: XmlElement[] = [
    valNode(
      c("grouping"),
      spec.grouping === "clustered"
        ? "standard"
        : (spec.grouping ?? "standard"),
    ),
    valNode(c("varyColors"), spec.varyColors ? "1" : "0"),
    ...ser,
    ...(dl ? [dl] : []),
  ];
  if (spec.dropLines) children.push(elem(c("dropLines")));
  if (spec.hiLowLines) children.push(elem(c("hiLowLines")));
  if (spec.upDownBars)
    children.push(
      elem(c("upDownBars"), {
        children: [
          valNode(c("gapWidth"), 150),
          elem(c("upBars")),
          elem(c("downBars")),
        ],
      }),
    );
  // Retain the native flag without inventing an element for omission. Readers
  // ignore this flag for visibility; per-series symbol='none' hides markers.
  if (spec.lineMarkers !== undefined)
    children.push(valNode(c("marker"), spec.lineMarkers ? "1" : "0"));
  children.push(valNode(c("axId"), axes.cat), valNode(c("axId"), axes.val));
  return elem(c("lineChart"), { children });
};

const buildPieChart = (spec: ChartSpec, sheet: string): XmlElement => {
  if (spec.series.length !== 1) {
    throw new Error("pie chart requires exactly one series");
  }
  const ser = seriesElement(spec, 0, sheet);
  const dl = dLblsElement(spec);
  const children: XmlElement[] = [
    valNode(c("varyColors"), "1"),
    ser,
    ...(dl ? [dl] : []),
  ];
  if (spec.firstSliceAngleDeg !== undefined) {
    children.push(
      valNode(
        c("firstSliceAng"),
        firstSliceAngle(spec.firstSliceAngleDeg, "chart: firstSliceAngleDeg"),
      ),
    );
  }
  return elem(c("pieChart"), { children });
};

const buildDoughnutChart = (spec: ChartSpec, sheet: string): XmlElement => {
  const series = spec.series.map((_, i) => seriesElement(spec, i, sheet));
  const dl = dLblsElement(spec);
  const children: XmlElement[] = [
    valNode(c("varyColors"), "1"),
    ...series,
    ...(dl ? [dl] : []),
  ];
  if (spec.firstSliceAngleDeg !== undefined) {
    children.push(
      valNode(
        c("firstSliceAng"),
        firstSliceAngle(spec.firstSliceAngleDeg, "chart: firstSliceAngleDeg"),
      ),
    );
  }
  const holeSize = holeSizePercent(
    spec.holeSizePct ?? 50,
    "chart: holeSizePct",
  );
  // The native reference writes zero after opening an omitted holeSize.
  // Author that native zero-hole state by omission, retaining the schema's
  // explicit 1..90 range.
  if (holeSize !== 0) children.push(valNode(c("holeSize"), holeSize));
  return elem(c("doughnutChart"), { children });
};

const buildAreaChart = (
  spec: ChartSpec,
  sheet: string,
  seriesIndices: ReadonlyArray<number>,
  axes: AxisIdPair,
): XmlElement => {
  const ser = seriesIndices.map((i) => seriesElement(spec, i, sheet));
  const dl = dLblsElement(spec);
  return elem(c("areaChart"), {
    children: [
      valNode(
        c("grouping"),
        spec.grouping === "clustered"
          ? "standard"
          : (spec.grouping ?? "standard"),
      ),
      valNode(c("varyColors"), spec.varyColors ? "1" : "0"),
      ...ser,
      ...(dl ? [dl] : []),
      ...(spec.dropLines ? [elem(c("dropLines"))] : []),
      valNode(c("axId"), axes.cat),
      valNode(c("axId"), axes.val),
    ],
  });
};

/** Data tables pair series with categories: category charts with axes only. */
export const chartHasDataTableSlot = (kind: string): boolean =>
  ["bar", "column", "line", "area"].includes(kind);

const buildScatterChart = (spec: ChartSpec, sheet: string): XmlElement => {
  const dl = dLblsElement(spec);
  return elem(c("scatterChart"), {
    children: [
      valNode(c("scatterStyle"), spec.scatterStyle ?? "marker"),
      valNode(c("varyColors"), spec.varyColors ? "1" : "0"),
      ...spec.series.map((_, i) => seriesElement(spec, i, sheet)),
      ...(dl ? [dl] : []),
      valNode(c("axId"), CAT_AX_ID),
      valNode(c("axId"), VAL_AX_ID),
    ],
  });
};

const buildBubbleChart = (spec: ChartSpec, sheet: string): XmlElement => {
  const dl = dLblsElement(spec);
  const children: XmlElement[] = [
    valNode(c("varyColors"), spec.varyColors ? "1" : "0"),
    ...spec.series.map((_, i) => seriesElement(spec, i, sheet)),
    ...(dl ? [dl] : []),
  ];
  if (spec.bubbleScale !== undefined) {
    const scale = spec.bubbleScale;
    if (!Number.isInteger(scale) || scale < 0 || scale > 300)
      throw new RangeError("bubbleScale: expected an integer from 0 to 300");
    children.push(valNode(c("bubbleScale"), scale));
  }
  children.push(valNode(c("showNegBubbles"), "0"));
  if (spec.bubbleSizeRepresents !== undefined)
    children.push(
      valNode(
        c("sizeRepresents"),
        spec.bubbleSizeRepresents === "width" ? "w" : "area",
      ),
    );
  children.push(valNode(c("axId"), CAT_AX_ID), valNode(c("axId"), VAL_AX_ID));
  return elem(c("bubbleChart"), { children });
};

const buildRadarChart = (spec: ChartSpec, sheet: string): XmlElement => {
  const dl = dLblsElement(spec);
  return elem(c("radarChart"), {
    children: [
      valNode(c("radarStyle"), spec.radarStyle ?? "standard"),
      valNode(c("varyColors"), spec.varyColors ? "1" : "0"),
      ...spec.series.map((_, i) => seriesElement(spec, i, sheet)),
      ...(dl ? [dl] : []),
      valNode(c("axId"), CAT_AX_ID),
      valNode(c("axId"), VAL_AX_ID),
    ],
  });
};

/**
 * The horizontal axis of an XY chart is a value axis carrying the
 * category-axis fields: CT_ValAx shares CT_CatAx's leading sequence up to
 * the crossings, then takes crossBetween instead of the label options.
 */
const xValueAxis = (spec: ChartSpec): XmlElement => {
  const axis = catAxis(spec);
  const crossAt = axis.children.findIndex(
    (n) =>
      n.kind === "element" &&
      n.name.namespaceURI === NS_C &&
      n.name.localName === "crossAx",
  );
  const crossings = axisCrossingElements(spec.categoryAxisCrosses).length;
  axis.children = [
    ...axis.children.slice(0, crossAt + 1 + crossings),
    valNode(c("crossBetween"), "midCat"),
  ];
  axis.name = c("valAx");
  return axis;
};

/** One combo plot group, dispatched by its effective kind. */
const buildComboGroupChart = (
  spec: ChartSpec,
  sheet: string,
  kind: string,
  seriesIndices: ReadonlyArray<number>,
  axes: AxisIdPair,
): XmlElement => {
  switch (kind) {
    case "column":
      return buildBarChart(spec, sheet, "col", seriesIndices, axes);
    case "bar":
      return buildBarChart(spec, sheet, "bar", seriesIndices, axes);
    case "line":
      return buildLineChart(spec, sheet, seriesIndices, axes);
    case "area":
      return buildAreaChart(spec, sheet, seriesIndices, axes);
    default:
      throw new Error(
        `combo chart: series chartKind '${kind}' is not authorable`,
      );
  }
};

/**
 * Secondary values use the opposite plot side: right for vertical values,
 * top for horizontal bars. Its scaling direction is independent.
 */
const secondaryValAxis = (spec: ChartSpec): XmlElement =>
  elem(c("valAx"), {
    children: [
      valNode(c("axId"), SEC_VAL_AX_ID),
      elem(c("scaling"), {
        children: [
          valNode(
            c("orientation"),
            spec.secondaryValueAxisOrientation ?? "minMax",
          ),
        ],
      }),
      valNode(c("delete"), "0"),
      valNode(c("axPos"), spec.kind === "bar" ? "t" : "r"),
      ...numberFormatElement(
        spec.secondaryValueAxisNumberFormat,
        spec.secondaryValueAxisNumberFormatSourceLinked,
      ),
      ...(spec.secondaryValueAxisTickLabelPos !== undefined
        ? [valNode(c("tickLblPos"), spec.secondaryValueAxisTickLabelPos)]
        : []),
      ...(spec.secondaryValueAxisLineColor !== undefined ||
      spec.secondaryValueAxisLineWidthEmu !== undefined
        ? [
            spPrChildren(
              undefined,
              spec.secondaryValueAxisLineColor,
              spec.secondaryValueAxisLineWidthEmu,
            ),
          ]
        : []),
      valNode(c("crossAx"), SEC_CAT_AX_ID),
      ...axisCrossingElements(spec.secondaryValueAxisCrosses ?? "max"),
      ...(spec.secondaryValueAxisCrossBetween !== undefined
        ? [valNode(c("crossBetween"), spec.secondaryValueAxisCrossBetween)]
        : []),
    ],
  });

/**
 * Deleted companion category axis for the secondary pair. Readers
 * require every plot group's axId pair to resolve to a cat+val pair,
 * so the secondary group gets its own (hidden) category axis.
 */
const secondaryCatAxis = (spec: ChartSpec): XmlElement =>
  elem(c("catAx"), {
    children: [
      valNode(c("axId"), SEC_CAT_AX_ID),
      elem(c("scaling"), {
        children: [
          valNode(
            c("orientation"),
            spec.secondaryCategoryAxisOrientation ?? "minMax",
          ),
        ],
      }),
      valNode(c("delete"), "1"),
      valNode(c("axPos"), spec.kind === "bar" ? "r" : "b"),
      ...numberFormatElement(
        spec.secondaryCategoryAxisNumberFormat,
        spec.secondaryCategoryAxisNumberFormatSourceLinked,
      ),
      ...(spec.secondaryCategoryAxisTickLabelPos !== undefined
        ? [valNode(c("tickLblPos"), spec.secondaryCategoryAxisTickLabelPos)]
        : []),
      ...(spec.secondaryCategoryAxisLineColor !== undefined ||
      spec.secondaryCategoryAxisLineWidthEmu !== undefined
        ? [
            spPrChildren(
              undefined,
              spec.secondaryCategoryAxisLineColor,
              spec.secondaryCategoryAxisLineWidthEmu,
            ),
          ]
        : []),
      valNode(c("crossAx"), SEC_VAL_AX_ID),
      ...axisCrossingElements(spec.secondaryCategoryAxisCrosses),
    ],
  });

// Builds an <a:rPr ...><a:solidFill><a:srgbClr/></a:solidFill></a:rPr>
// payload from a ChartTextStyle. Returns the rPr children to splice
// into the parent run / def-run-properties node.
const rPrAttrsFromStyle = (
  style: ChartTextStyle | undefined,
): {
  attrs: ReturnType<typeof attr>[];
  children: XmlElement[];
} => {
  const attrs: ReturnType<typeof attr>[] = [];
  const children: XmlElement[] = [];
  if (style?.sizePt !== undefined) {
    attrs.push(
      attr(qname("", "sz", ""), String(Math.round(style.sizePt * 100))),
    );
  }
  if (style?.bold === true) attrs.push(attr(qname("", "b", ""), "1"));
  if (style?.bold === false) attrs.push(attr(qname("", "b", ""), "0"));
  if (style?.italic === true) attrs.push(attr(qname("", "i", ""), "1"));
  if (style?.italic === false) attrs.push(attr(qname("", "i", ""), "0"));
  if (style?.color !== undefined) {
    const hex = style.color.startsWith("#")
      ? style.color.slice(1)
      : style.color;
    children.push(
      elem(a("solidFill"), {
        children: [
          elem(a("srgbClr"), {
            attrs: [attr(qname("", "val", ""), hex.toUpperCase())],
          }),
        ],
      }),
    );
  }
  // <a:latin> / <a:ea> follow the fill group in CT_TextCharacterProperties;
  // ea carries the same face so CJK glyphs aren't dropped to the renderer's
  // latin-only fallback (the latin slot is ignored for east-asian script).
  if (style?.font !== undefined) {
    const typeface = attr(qname("", "typeface", ""), style.font);
    children.push(elem(a("latin"), { attrs: [typeface] }));
    children.push(elem(a("ea"), { attrs: [typeface] }));
  }
  return { attrs, children };
};

const titleElement = (
  title: string,
  style?: ChartTextStyle,
  rotationDeg?: number,
): XmlElement => {
  // defRPr stays 1400 (14pt) as the legacy default; the run-level
  // <a:rPr> carries authored overrides so renderers honor them.
  const rPr = elem(a("defRPr"), { attrs: [attr(qname("", "sz", ""), "1400")] });
  const pPr = elem(a("pPr"), { children: [rPr] });
  const { attrs: runAttrs, children: runChildren } = rPrAttrsFromStyle(style);
  const runRPr = elem(a("rPr"), {
    attrs: [attr(qname("", "lang", ""), "en-US"), ...runAttrs],
    children: runChildren,
  });
  const tRun = elem(a("r"), {
    children: [runRPr, elem(a("t"), { children: [text(title)] })],
  });
  const para = elem(a("p"), { children: [pPr, tRun] });
  const rotStr =
    rotationDeg !== undefined && rotationDeg !== 0
      ? String(Math.round(rotationDeg * 60000))
      : "0";
  const rich = elem(c("rich"), {
    children: [
      elem(a("bodyPr"), {
        attrs: [
          attr(qname("", "rot", ""), rotStr),
          attr(qname("", "spcFirstLastPara", ""), "1"),
          attr(qname("", "vertOverflow", ""), "ellipsis"),
          attr(qname("", "vert", ""), "horz"),
          attr(qname("", "wrap", ""), "square"),
          attr(qname("", "anchor", ""), "ctr"),
          attr(qname("", "anchorCtr", ""), "1"),
        ],
      }),
      elem(a("lstStyle")),
      para,
    ],
  });
  return elem(c("title"), {
    children: [elem(c("tx"), { children: [rich] }), valNode(c("overlay"), "0")],
  });
};

/**
 * Builds a complete `<c:chartSpace>` document for `spec`. The caller
 * supplies the owner-local workbook relationship ID. Newly authored
 * charts default to rId1; edits must use the native binding's ID.
 */
export const buildChartSpaceDoc = (
  spec: ChartSpec,
  externalDataRelationshipId = "rId1",
): XmlDocument => {
  validateChartLabelPositions(spec);
  validateChartAxisCrossings(spec);
  validateChartAxisTickLabelPositions(spec);
  validateChartErrorBars(spec);
  const sheet = "Sheet1";

  const usesComboFields = spec.series.some(
    (series) => series.chartKind !== undefined || series.secondaryAxis === true,
  );
  if (usesComboFields && !COMBO_KINDS.has(spec.kind)) {
    throw new Error(
      `chart kind '${spec.kind}' does not support per-series chartKind / secondaryAxis (combo charts require a bar / column / line / area base kind)`,
    );
  }

  const allIndices = spec.series.map((_, i) => i);
  let plottedGroups: XmlElement[];
  let hasSecondary = false;
  switch (spec.kind) {
    case "column":
    case "bar":
    case "line":
    case "area": {
      if (usesComboFields) {
        const groups = comboPlotGroups(spec);
        hasSecondary = groups.some((group) => group.secondary);
        plottedGroups = groups.map((group) =>
          buildComboGroupChart(
            spec,
            sheet,
            group.kind,
            group.indices,
            group.secondary ? SECONDARY_AXES : PRIMARY_AXES,
          ),
        );
      } else {
        plottedGroups = [
          buildComboGroupChart(
            spec,
            sheet,
            spec.kind,
            allIndices,
            PRIMARY_AXES,
          ),
        ];
      }
      break;
    }
    case "pie":
      plottedGroups = [buildPieChart(spec, sheet)];
      break;
    case "doughnut":
      plottedGroups = [buildDoughnutChart(spec, sheet)];
      break;
    case "scatter":
      plottedGroups = [buildScatterChart(spec, sheet)];
      break;
    case "bubble":
      plottedGroups = [buildBubbleChart(spec, sheet)];
      break;
    case "radar":
      plottedGroups = [buildRadarChart(spec, sheet)];
      break;
    default: {
      const exhaustive: never = spec.kind;
      throw new Error(`unsupported chart kind: ${String(exhaustive)}`);
    }
  }

  const axisless = spec.kind === "pie" || spec.kind === "doughnut";
  const plotAreaChildren: XmlElement[] = [elem(c("layout")), ...plottedGroups];
  if (!axisless) {
    plotAreaChildren.push(
      isXYChartKind(spec.kind) ? xValueAxis(spec) : catAxis(spec),
      valAxis(spec),
    );
    if (hasSecondary) {
      plotAreaChildren.push(secondaryValAxis(spec), secondaryCatAxis(spec));
    }
  }
  // CT_PlotArea: the data table follows the axes and precedes spPr.
  if (spec.dataTable !== undefined && chartHasDataTableSlot(spec.kind)) {
    const table = spec.dataTable;
    plotAreaChildren.push(
      elem(c("dTable"), {
        children: (
          [
            ["showHorzBorder", table.showHorzBorder],
            ["showVertBorder", table.showVertBorder],
            ["showOutline", table.showOutline],
            ["showKeys", table.showKeys],
          ] as const
        )
          .filter(([, on]) => on !== undefined)
          .map(([name, on]) => valNode(c(name), on ? "1" : "0")),
      }),
    );
  }
  // <c:plotArea><c:spPr><a:solidFill> + optional <a:ln><a:solidFill>.
  if (
    spec.plotAreaFill !== undefined ||
    spec.plotAreaStrokeColor !== undefined ||
    spec.plotAreaStrokeWidthEmu !== undefined
  ) {
    plotAreaChildren.push(
      spPrChildren(
        spec.plotAreaFill,
        spec.plotAreaStrokeColor,
        spec.plotAreaStrokeWidthEmu,
      ),
    );
  }
  const plotArea = elem(c("plotArea"), { children: plotAreaChildren });

  const chartChildren: XmlElement[] = [];
  if (spec.title !== undefined) {
    const titleEl = titleElement(spec.title, spec.titleStyle);
    // <c:title> can also carry <c:overlay val="1"/> — append it after
    // the <c:tx> child but before the synthesized overlay node from
    // titleElement so we don't end up with two overlay elements.
    if (spec.titleOverlay !== undefined) {
      const filtered = titleEl.children.filter(
        (c2) =>
          !(
            c2.kind === "element" &&
            c2.name.namespaceURI === NS_C &&
            c2.name.localName === "overlay"
          ),
      );
      titleEl.children = [
        ...filtered,
        valNode(c("overlay"), spec.titleOverlay ? "1" : "0"),
      ];
    }
    chartChildren.push(titleEl);
  }
  chartChildren.push(
    valNode(c("autoTitleDeleted"), spec.title !== undefined ? "0" : "1"),
    plotArea,
  );
  // <c:legend> after plotArea but before plotVisOnly / dispBlanksAs.
  // Skip entirely when `position` is explicitly null (author wants no
  // legend at all).
  if (spec.legend !== undefined && spec.legend.position !== null) {
    const legendChildren: XmlElement[] = [
      valNode(c("legendPos"), spec.legend.position),
    ];
    for (const idx of spec.legend.hiddenIndices ?? []) {
      legendChildren.push(
        elem(c("legendEntry"), {
          children: [valNode(c("idx"), idx), valNode(c("delete"), "1")],
        }),
      );
    }
    legendChildren.push(valNode(c("overlay"), spec.legend.overlay ? "1" : "0"));
    if (
      spec.legend.fill !== undefined ||
      spec.legend.strokeColor !== undefined ||
      spec.legend.strokeWidthEmu !== undefined
    ) {
      legendChildren.push(
        spPrChildren(
          spec.legend.fill,
          spec.legend.strokeColor,
          spec.legend.strokeWidthEmu,
        ),
      );
    }
    // <c:legend><c:txPr> carries authored legend font / color.
    if (spec.legend.textStyle !== undefined) {
      const txPr = axisTxPrElement(spec.legend.textStyle, undefined);
      if (txPr !== null) legendChildren.push(txPr);
    }
    chartChildren.push(elem(c("legend"), { children: legendChildren }));
  }
  chartChildren.push(
    valNode(c("plotVisOnly"), spec.plotVisibleCellsOnly === false ? "0" : "1"),
    valNode(c("dispBlanksAs"), spec.dispBlanksAs ?? "gap"),
  );
  if (spec.showDataLabelsOverMaximum !== undefined)
    chartChildren.push(
      valNode(
        c("showDLblsOverMax"),
        spec.showDataLabelsOverMaximum ? "1" : "0",
      ),
    );
  const chart = elem(c("chart"), { children: chartChildren });

  const externalData = elem(c("externalData"), {
    attrs: [attr(r("id"), externalDataRelationshipId)],
    children: [valNode(c("autoUpdate"), "0")],
  });

  // <c:chartSpace><c:spPr> sits at the root and styles the entire card.
  // CT_ChartSpace schema order: date1904 → lang → roundedCorners →
  // style → chart.
  const rootChildren: XmlElement[] = [];
  if (spec.date1904) rootChildren.push(valNode(c("date1904"), "1"));
  if (spec.language !== undefined)
    rootChildren.push(valNode(c("lang"), spec.language));
  if (spec.roundedCorners !== undefined)
    rootChildren.push(
      valNode(c("roundedCorners"), spec.roundedCorners ? "1" : "0"),
    );
  const style = chartStyleElement(spec);
  if (style) rootChildren.push(style);
  rootChildren.push(chart);
  if (
    spec.chartAreaFill !== undefined ||
    spec.chartAreaStrokeColor !== undefined ||
    spec.chartAreaStrokeWidthEmu !== undefined
  ) {
    rootChildren.push(
      spPrChildren(
        spec.chartAreaFill,
        spec.chartAreaStrokeColor,
        spec.chartAreaStrokeWidthEmu,
      ),
    );
  }
  const textPr = axisTxPrElement(spec.textStyle, undefined);
  if (textPr) rootChildren.push(textPr);
  rootChildren.push(externalData);
  const root = elem(c("chartSpace"), {
    prefixDecls: new Map([
      ["c", NS_C],
      ["a", NS_A],
      ["r", NS_R],
    ]),
    children: rootChildren,
  });

  return {
    kind: "document",
    decl: { version: "1.0", encoding: "UTF-8", standalone: "yes" },
    prolog: [],
    root,
    epilog: [],
  };
};

export type { ChartKind, ChartSpec } from "./types.ts";
