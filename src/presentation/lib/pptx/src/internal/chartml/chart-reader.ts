import { CHART_PLOT_KINDS } from "./plot-kinds.ts";
export { CHART_PLOT_KINDS } from "./plot-kinds.ts";
import { readChartAxisTickLabelPosition } from "./axis-label-position.ts";
import { readChartAxisCrossing } from "./axis-crossing.ts";
import { readMarkerSizePt } from "./marker-size.ts";
import { invertedSolidFillHost } from "./inversion.ts";
// Chart spec reader — parses `<c:chartSpace>` back into a `ChartSpec`.
//
// Companion to `chart-builder.ts`. Lets callers introspect or edit
// chart data on existing templates without dropping to XML. The reader
// uses inline `<c:strCache>` / `<c:numCache>` blocks rather than the
// embedded workbook — the cache is what readers render from
// anyway, and it's always present in charts @office-kit/pptx emits.

import {
  chartAxisContext,
  chartAxisRoles,
  readChartTickMark as readNativeTickMark,
  readChartUnsignedInt as readUnsignedInt,
} from "./axis-context.ts";
import {
  chartStringCache,
  chartNumberCache,
  readChartCache,
  chartCacheNumber,
  chartCacheText,
  readCacheFormat,
  checkChartCacheSize as checkCacheSize,
} from "./chart-cache.ts";
import { CHART_AUTO_ROTATION } from "./text-rotation.ts";
import { readChartStyle } from "./chart-style.ts";
import { readChartStrokeWidth } from "./stroke-width.ts";
import {
  NS,
  type XmlElement,
  allChildElements,
  firstChildElement,
  getAttrValue,
  qname,
} from "../xml/index.ts";
import type {
  ChartAxisScaling,
  ChartDataLabelPosition,
  ChartDataLabels,
  ChartGrouping,
  ChartKind,
  ChartSeries,
  ChartSpec,
  ChartTextStyle,
  ChartTrendline,
  ChartErrorBars,
  ChartDataTable,
} from "./types.ts";

const NS_C = NS.chart;
const NS_A = NS.dml;

const NAME_CHART_SPACE = qname("c", "chartSpace", NS_C);
const NAME_CHART = qname("c", "chart", NS_C);
const NAME_PLOT_AREA = qname("c", "plotArea", NS_C);
const NAME_SER = qname("c", "ser", NS_C);
const NAME_TX = qname("c", "tx", NS_C);
const NAME_CAT = qname("c", "cat", NS_C);
const NAME_VAL = qname("c", "val", NS_C);
const NAME_TITLE = qname("c", "title", NS_C);
const NAME_RICH = qname("c", "rich", NS_C);
const NAME_T = qname("a", "t", NS_A);
const NAME_P_DML = qname("a", "p", NS_A);
const NAME_R_DML = qname("a", "r", NS_A);
const NAME_SP_PR_C = qname("c", "spPr", NS_C);
const NAME_SOLID_FILL = qname("a", "solidFill", NS_A);

const ATTR_VAL = qname("", "val", "");
// CT_Boolean defaults val to true on a present element. Keep false distinct
// from omission: readers can apply different defaults to absent options.
export const readBoolean = (
  element: XmlElement | null,
): boolean | undefined => {
  if (!element) return undefined;
  const value = getAttrValue(element, ATTR_VAL)?.replace(
    /^[\t\n\r ]+|[\t\n\r ]+$/g,
    "",
  );
  if (value === undefined || value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
};
// Color resolution belongs to the host theme context. The reader selects the
// native DrawingML color choice once for every solid fill, including text/lines.
export type ChartColorResolver = (color: XmlElement) => string | null;
const directColor: ChartColorResolver = (color) => {
  if (color.name.localName !== "srgbClr") return null;
  const v = getAttrValue(color, ATTR_VAL);
  return v === null ? null : `#${v.toUpperCase()}`;
};
export const readChartSolidPaint = (
  parent: XmlElement,
  resolve: ChartColorResolver,
): string | undefined => {
  const solid = firstChildElement(parent, NAME_SOLID_FILL);
  if (!solid) return undefined;
  const color = solid.children.find(
    (c): c is XmlElement =>
      c.kind === "element" &&
      c.name.namespaceURI === NS_A &&
      [
        "srgbClr",
        "schemeClr",
        "sysClr",
        "prstClr",
        "hslClr",
        "scrgbClr",
      ].includes(c.name.localName),
  );
  return color ? (resolve(color) ?? undefined) : undefined;
};

// A missing/unsupported paint differs from an explicit invisible outline.
export const readChartPaint = (
  parent: XmlElement,
  resolve: ChartColorResolver,
): string | null | undefined =>
  firstChildElement(parent, qname("a", "noFill", NS_A))
    ? null
    : readChartSolidPaint(parent, resolve);

/** Kinds a combo plot group can carry (mirrors `ChartSeries.chartKind`). */
const isComboSeriesKind = (
  kind: ChartKind,
): kind is "bar" | "column" | "line" | "area" =>
  kind === "bar" || kind === "column" || kind === "line" || kind === "area";

const findFirst = (
  parent: XmlElement,
  names: ReadonlyArray<string>,
): XmlElement | null => {
  for (const c of parent.children) {
    if (c.kind !== "element" || c.name.namespaceURI !== NS_C) continue;
    if (names.includes(c.name.localName)) return c;
  }
  return null;
};

// References, literals and the first category level share the same sparse
// point rules. Materialize blanks only when a caller requests the model.
const readStringRef = (parent: XmlElement): string[] | null => {
  const cache = chartStringCache(parent);
  return cache ? readChartCache(cache) : null;
};
const readNumRef = (parent: XmlElement): Array<number | null> | null => {
  const cache = chartNumberCache(parent);
  return cache ? readChartCache(cache).map(chartCacheNumber) : null;
};

// General is an authored format, and sourceLinked is independent of its code.
// CT_NumFmt defaults an omitted sourceLinked attribute to true (ISO 29500).
export const readNumberFormat = (
  parent: XmlElement | null,
): Pick<ChartAxisScaling, "numberFormat" | "numberFormatSourceLinked"> => {
  const node = parent && firstChildElement(parent, qname("c", "numFmt", NS_C));
  if (!node) return {};
  const numberFormat = getAttrValue(node, qname("", "formatCode", ""));
  const linked = getAttrValue(node, qname("", "sourceLinked", ""))?.trim();
  const numberFormatSourceLinked =
    linked === undefined || linked === "1" || linked === "true"
      ? true
      : linked === "0" || linked === "false"
        ? false
        : undefined;
  return {
    ...(numberFormat !== null ? { numberFormat } : {}),
    ...(numberFormatSourceLinked !== undefined
      ? { numberFormatSourceLinked }
      : {}),
  };
};

const readSeriesName = (ser: XmlElement): string => {
  const tx = firstChildElement(ser, NAME_TX);
  if (!tx) return "";
  const strs = readStringRef(tx);
  if (strs !== null) return strs[0] ?? "";
  const direct = firstChildElement(tx, qname("c", "v", NS_C));
  return direct ? chartCacheText(direct) : "";
};

// Walks `<c:ser><c:dPt>` overrides and returns sparse per-point arrays
// for color (`<c:spPr><a:solidFill>`) and explosion
// (`<c:explosion val="N"/>`). Returns `undefined` for each side when no
// dPt authors the corresponding attribute.
const readDataPointOverrides = (
  ser: XmlElement,
  resolveColor: ChartColorResolver,
): {
  readonly colors: ReadonlyArray<string | null> | undefined;
  readonly explosions: ReadonlyArray<number | null> | undefined;
  readonly inversions: ReadonlyArray<boolean | null> | undefined;
} => {
  const colors: Array<string | null> = [];
  const explosions: Array<number | null> = [];
  const inversions: Array<boolean | null> = [];
  let anyColor = false;
  let anyExplosion = false;
  for (const c of ser.children) {
    if (
      c.kind !== "element" ||
      c.name.namespaceURI !== NS_C ||
      c.name.localName !== "dPt"
    )
      continue;
    const idxEl = firstChildElement(c, qname("c", "idx", NS_C));
    if (!idxEl) continue;
    const idx = readUnsignedInt(getAttrValue(idxEl, ATTR_VAL));
    if (idx === null) continue;
    const inversion = readBoolean(
      firstChildElement(c, qname("c", "invertIfNegative", NS_C)),
    );
    if (inversion !== undefined) {
      checkCacheSize(idx + 1);
      inversions[idx] = inversion;
    }
    const spPr = firstChildElement(c, NAME_SP_PR_C);
    const color = spPr ? readChartSolidPaint(spPr, resolveColor) : undefined;
    if (color !== undefined) {
      checkCacheSize(idx + 1);
      colors[idx] = color;
      anyColor = true;
    }
    const explEl = firstChildElement(c, qname("c", "explosion", NS_C));
    if (explEl) {
      const v = getAttrValue(explEl, ATTR_VAL);
      if (v !== null) {
        const n = readUnsignedInt(v);
        if (n !== null && n > 0) {
          checkCacheSize(idx + 1);
          explosions[idx] = n;
          anyExplosion = true;
        }
      }
    }
  }
  return {
    colors: anyColor ? colors : undefined,
    explosions: anyExplosion ? explosions : undefined,
    inversions: inversions.length ? inversions : undefined,
  };
};

// `<c:trendline>` is a sibling of `<c:val>` inside `<c:ser>`. Read the
// type token and (where relevant) the period / polynomial order. Color
// comes from `<c:trendline><c:spPr><a:ln><a:solidFill>` when authored.
const readTrendline = (
  ser: XmlElement,
  resolveColor: ChartColorResolver,
): ChartTrendline | undefined => {
  const tl = firstChildElement(ser, qname("c", "trendline", NS_C));
  if (!tl) return undefined;
  // <c:trendline><c:name>…</c:name> — optional custom label.
  let name: string | undefined;
  const nameEl = firstChildElement(tl, qname("c", "name", NS_C));
  if (nameEl) {
    let acc = "";
    for (const child of nameEl.children) {
      if (child.kind === "text" || child.kind === "cdata") acc += child.data;
    }
    if (acc.length > 0) name = acc;
  }
  const typeEl = firstChildElement(tl, qname("c", "trendlineType", NS_C));
  const tToken = typeEl ? getAttrValue(typeEl, ATTR_VAL) : null;
  let type: ChartTrendline["type"];
  switch (tToken) {
    case "exp":
    case "log":
    case "poly":
    case "power":
    case "movingAvg":
    case "linear":
      type = tToken;
      break;
    default:
      type = "linear";
  }
  let period: number | undefined;
  if (type === "movingAvg") {
    const pEl = firstChildElement(tl, qname("c", "period", NS_C));
    if (pEl) {
      const v = getAttrValue(pEl, ATTR_VAL);
      if (v !== null) {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) period = n;
      }
    }
  }
  let order: number | undefined;
  if (type === "poly") {
    const oEl = firstChildElement(tl, qname("c", "order", NS_C));
    if (oEl) {
      const v = getAttrValue(oEl, ATTR_VAL);
      if (v !== null) {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n) && n >= 2) order = n;
      }
    }
  }
  // Line color via <c:spPr><a:ln><a:solidFill><a:srgbClr>.
  let color: string | undefined;
  const spPr = firstChildElement(tl, NAME_SP_PR_C);
  if (spPr) {
    const ln = firstChildElement(spPr, qname("a", "ln", NS_A));
    if (ln) {
      color = readChartSolidPaint(ln, resolveColor);
    }
  }
  // <c:forward val="N"/> / <c:backward val="N"/> extend the trendline
  // N periods past the last / before the first data point.
  const readExtension = (local: string): number | undefined => {
    const el = firstChildElement(tl, qname("c", local, NS_C));
    if (!el) return undefined;
    const raw = getAttrValue(el, ATTR_VAL);
    if (raw === null) return undefined;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const forward = readExtension("forward");
  const backward = readExtension("backward");
  // <c:dispEq val="1"/> and <c:dispRSqr val="1"/> show the regression
  // equation / R² coefficient next to the line. Default false.
  const readDispBool = (local: string): boolean | undefined => {
    const el = firstChildElement(tl, qname("c", local, NS_C));
    if (!el) return undefined;
    const v = getAttrValue(el, ATTR_VAL);
    return v === null || v === "1" || v === "true" ? true : undefined;
  };
  const displayEquation = readDispBool("dispEq");
  const displayRSquared = readDispBool("dispRSqr");
  return {
    ...(name !== undefined ? { name } : {}),
    type,
    ...(period !== undefined ? { period } : {}),
    ...(order !== undefined ? { order } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(forward !== undefined ? { forward } : {}),
    ...(backward !== undefined ? { backward } : {}),
    ...(displayEquation === true ? { displayEquation: true } : {}),
    ...(displayRSquared === true ? { displayRSquared: true } : {}),
  };
};

const readSeriesColor = (
  ser: XmlElement,
  resolveColor: ChartColorResolver,
): string | undefined => {
  const spPr = firstChildElement(ser, NAME_SP_PR_C);
  return spPr ? readChartSolidPaint(spPr, resolveColor) : undefined;
};

// Per-series marker symbol + size from <c:ser><c:marker>.
const readSeriesMarker = (
  ser: XmlElement,
  resolveColor: ChartColorResolver,
): Pick<
  ChartSeries,
  | "markerSymbol"
  | "markerSizePt"
  | "markerFill"
  | "markerStrokeColor"
  | "markerStrokeWidthEmu"
> => {
  const m = firstChildElement(ser, qname("c", "marker", NS_C));
  if (!m) return {};
  const out: {
    markerSymbol?: NonNullable<ChartSeries["markerSymbol"]>;
    markerSizePt?: number;
    markerFill?: string | null;
    markerStrokeColor?: string | null;
    markerStrokeWidthEmu?: number;
  } = {};
  const symEl = firstChildElement(m, qname("c", "symbol", NS_C));
  if (symEl) {
    const v = getAttrValue(symEl, ATTR_VAL);
    if (
      v === "none" ||
      v === "auto" ||
      v === "circle" ||
      v === "square" ||
      v === "diamond" ||
      v === "triangle" ||
      v === "star" ||
      v === "x" ||
      v === "plus" ||
      v === "dash" ||
      v === "dot" ||
      v === "picture"
    ) {
      out.markerSymbol = v;
    }
  }
  const sizeEl = firstChildElement(m, qname("c", "size", NS_C));
  if (sizeEl) {
    const n = readMarkerSizePt(getAttrValue(sizeEl, ATTR_VAL));
    if (n !== undefined) out.markerSizePt = n;
  }
  const sp = firstChildElement(m, NAME_SP_PR_C);
  const ln = sp && firstChildElement(sp, qname("a", "ln", NS_A));
  const fill = sp ? readChartPaint(sp, resolveColor) : undefined;
  const stroke = ln ? readChartPaint(ln, resolveColor) : undefined;
  const width = readChartStrokeWidth(m);
  if (fill !== undefined) out.markerFill = fill;
  if (stroke !== undefined) out.markerStrokeColor = stroke;
  if (width !== undefined) out.markerStrokeWidthEmu = width;
  return out;
};

// Series outlines keep their paint and width independently of the fill.
const readSeriesLineProps = (
  ser: XmlElement,
  resolveColor: ChartColorResolver,
): Pick<ChartSeries, "lineColor" | "lineWidthEmu" | "lineDash"> => {
  const spPr = firstChildElement(ser, NAME_SP_PR_C);
  const ln = spPr && firstChildElement(spPr, qname("a", "ln", NS_A));
  if (!ln) return {};
  const lineColor = readChartPaint(ln, resolveColor);
  const lineWidthEmu = readChartStrokeWidth(ser);
  const dash = firstChildElement(ln, qname("a", "prstDash", NS_A));
  const lineDash = dash && getAttrValue(dash, ATTR_VAL);
  return {
    ...(lineColor !== undefined ? { lineColor } : {}),
    ...(lineWidthEmu !== undefined ? { lineWidthEmu } : {}),
    ...(lineDash != null ? { lineDash } : {}),
  };
};

// <c:errBars> — the editable model holds one set per series. An XY series
// may carry an X and a Y set; the Y set (the usual one) is preferred.
const readErrorBars = (
  ser: XmlElement,
  resolveColor: ChartColorResolver,
): ChartErrorBars | undefined => {
  const all = allChildElements(ser, qname("c", "errBars", NS_C));
  const token = (el: XmlElement, local: string): string | null => {
    const child = firstChildElement(el, qname("c", local, NS_C));
    return child && getAttrValue(child, ATTR_VAL);
  };
  const bars = all.find((el) => (token(el, "errDir") ?? "y") === "y") ?? all[0];
  if (!bars) return undefined;
  const direction = token(bars, "errDir") === "x" ? "x" : undefined;
  const rawType = token(bars, "errBarType");
  const type: ChartErrorBars["type"] =
    rawType === "plus" || rawType === "minus" ? rawType : "both";
  const rawValueType = token(bars, "errValType");
  const valueType: ChartErrorBars["valueType"] =
    rawValueType === "percentage" ||
    rawValueType === "stdDev" ||
    rawValueType === "stdErr"
      ? rawValueType
      : "fixedVal";
  const rawValue = token(bars, "val");
  const parsed = rawValue === null ? NaN : Number(rawValue);
  const defaultValue = valueType === "percentage" ? 5 : 1;
  const value =
    valueType !== "stdErr" &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed !== defaultValue
      ? parsed
      : undefined;
  const noEndCap = readBoolean(
    firstChildElement(bars, qname("c", "noEndCap", NS_C)),
  );
  const spPr = firstChildElement(bars, NAME_SP_PR_C);
  const ln = spPr && firstChildElement(spPr, qname("a", "ln", NS_A));
  const color = ln ? readChartSolidPaint(ln, resolveColor) : undefined;
  return {
    ...(direction !== undefined ? { direction } : {}),
    type,
    valueType,
    ...(value !== undefined ? { value } : {}),
    ...(noEndCap === true ? { noEndCap } : {}),
    ...(color !== undefined ? { color } : {}),
  };
};

// <c:dTable> flags, each present only when authored.
const readDataTable = (plotArea: XmlElement): ChartDataTable | undefined => {
  const table = firstChildElement(plotArea, qname("c", "dTable", NS_C));
  if (!table) return undefined;
  const out: {
    showHorzBorder?: boolean;
    showVertBorder?: boolean;
    showOutline?: boolean;
    showKeys?: boolean;
  } = {};
  for (const key of [
    "showHorzBorder",
    "showVertBorder",
    "showOutline",
    "showKeys",
  ] as const) {
    const on = readBoolean(firstChildElement(table, qname("c", key, NS_C)));
    if (on !== undefined) out[key] = on;
  }
  return out;
};

const readTitle = (chart: XmlElement): string | undefined => {
  const title = firstChildElement(chart, NAME_TITLE);
  if (!title) return undefined;
  const tx = firstChildElement(title, NAME_TX);
  if (!tx) return undefined;
  // `<c:tx>` may carry either `<c:rich>` (literal) or `<c:strRef>` (cell
  // reference, with its `<c:strCache>` holding the resolved string).
  // Authors who type the title directly emit rich; chart wizards that
  // wire the title to a cell emit strRef. Accept both.
  const rich = firstChildElement(tx, NAME_RICH);
  if (rich) {
    let acc = "";
    for (const p of allChildElements(rich, NAME_P_DML)) {
      for (const r of allChildElements(p, NAME_R_DML)) {
        const tEl = firstChildElement(r, NAME_T);
        if (!tEl) continue;
        for (const child of tEl.children) {
          if (child.kind === "text" || child.kind === "cdata")
            acc += child.data;
        }
      }
    }
    if (acc.length > 0) return acc;
  }
  const cells = readStringRef(tx);
  if (cells && cells.length > 0) {
    const text = cells.filter((s) => s.length > 0).join(" ");
    if (text.length > 0) return text;
  }
  return undefined;
};

const NAME_A_RPR = qname("a", "rPr", NS_A);
const NAME_A_DEF_RPR = qname("a", "defRPr", NS_A);
const NAME_A_PPR = qname("a", "pPr", NS_A);
const NAME_A_LATIN = qname("a", "latin", NS_A);
const ATTR_TYPEFACE = qname("", "typeface", "");

// Reads `<a:rPr>` / `<a:defRPr>` attributes (size in 100ths of a pt,
// bold / italic) plus the first solidFill color inside it. Returns an
// undefined-only style when nothing is authored — callers should drop
// the style entirely in that case.
const readRunStyle = (
  rPr: XmlElement,
  resolveColor: ChartColorResolver,
): ChartTextStyle | undefined => {
  let font: string | undefined;
  let sizePt: number | undefined;
  let bold: boolean | undefined;
  let italic: boolean | undefined;
  let color: string | undefined;
  const szRaw = getAttrValue(rPr, qname("", "sz", ""));
  if (szRaw !== null) {
    const n = Number.parseInt(szRaw, 10);
    if (Number.isFinite(n) && n > 0) sizePt = n / 100;
  }
  const bRaw = getAttrValue(rPr, qname("", "b", ""));
  if (bRaw !== null) bold = bRaw === "1" || bRaw === "true";
  const iRaw = getAttrValue(rPr, qname("", "i", ""));
  if (iRaw !== null) italic = iRaw === "1" || iRaw === "true";
  color = readChartSolidPaint(rPr, resolveColor);
  // The latin slot is the authoritative font face on the round-trip; the
  // ea slot carries the same value (written by the builder) so reading
  // latin alone recovers the authored `font`.
  const latin = firstChildElement(rPr, NAME_A_LATIN);
  if (latin) {
    const tf = getAttrValue(latin, ATTR_TYPEFACE);
    if (tf !== null && tf !== "") font = tf;
  }
  if (
    font === undefined &&
    sizePt === undefined &&
    bold === undefined &&
    italic === undefined &&
    color === undefined
  ) {
    return undefined;
  }
  return {
    ...(font !== undefined ? { font } : {}),
    ...(sizePt !== undefined ? { sizePt } : {}),
    ...(bold !== undefined ? { bold } : {}),
    ...(italic !== undefined ? { italic } : {}),
    ...(color !== undefined ? { color } : {}),
  };
};

// Reads the first authored `<a:rPr>` (or `<a:pPr><a:defRPr>`) inside a
// chart label's `<c:rich>` block. Used for the chart title (and reusable
// for axis labels later). Returns `undefined` when nothing is authored.
export const readChartTextStyle = (
  richHost: XmlElement,
  resolveColor: ChartColorResolver,
): ChartTextStyle | undefined => {
  for (const p of allChildElements(richHost, NAME_P_DML)) {
    for (const r of allChildElements(p, NAME_R_DML)) {
      const rPr = firstChildElement(r, NAME_A_RPR);
      if (rPr) {
        const s = readRunStyle(rPr, resolveColor);
        if (s) return s;
      }
    }
    const pPr = firstChildElement(p, NAME_A_PPR);
    if (pPr) {
      const defRPr = firstChildElement(pPr, NAME_A_DEF_RPR);
      if (defRPr) {
        const s = readRunStyle(defRPr, resolveColor);
        if (s) return s;
      }
    }
  }
  return undefined;
};

// Extracts the authored text style from a `<c:title>` element. Used for
// both the chart-level title and axis titles, which share the
// `<c:tx><c:rich>` shape.
const readTitleStyleOf = (
  titleEl: XmlElement,
  resolveColor: ChartColorResolver,
): ChartTextStyle | undefined => {
  const tx = firstChildElement(titleEl, NAME_TX);
  if (!tx) return undefined;
  const rich = firstChildElement(tx, NAME_RICH);
  if (!rich) return undefined;
  return readChartTextStyle(rich, resolveColor);
};

const readTitleStyle = (
  chart: XmlElement,
  resolveColor: ChartColorResolver,
): ChartTextStyle | undefined => {
  const title = firstChildElement(chart, NAME_TITLE);
  if (!title) return undefined;
  return readTitleStyleOf(title, resolveColor);
};

// Reads `<c:title><c:tx><c:rich><a:bodyPr rot="N"/>` and converts from
// the OOXML 60000ths-of-a-degree unit to plain degrees. Returns
// `undefined` when the rotation is absent (the renderer's default
// applies).
const readTitleRotationDeg = (titleEl: XmlElement): number | undefined => {
  const tx = firstChildElement(titleEl, NAME_TX);
  if (!tx) return undefined;
  const rich = firstChildElement(tx, NAME_RICH);
  if (!rich) return undefined;
  const bodyPr = firstChildElement(rich, qname("a", "bodyPr", NS_A));
  if (!bodyPr) return undefined;
  const v = getAttrValue(bodyPr, qname("", "rot", ""));
  if (v === null) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n / 60000 : undefined;
};

// `<c:dLbls><c:dLblPos val="…"/>` — the chart-kind-dependent enum that
// names where labels sit relative to their data point. Returns
// `undefined` for unknown tokens so callers fall back to their default.
const readDataLabelPosition = (
  dLbls: XmlElement,
): ChartDataLabelPosition | undefined => {
  const el = firstChildElement(dLbls, qname("c", "dLblPos", NS_C));
  if (!el) return undefined;
  const v = getAttrValue(el, ATTR_VAL);
  switch (v) {
    case "ctr":
    case "inEnd":
    case "outEnd":
    case "inBase":
    case "t":
    case "b":
    case "l":
    case "r":
    case "bestFit":
      return v;
    default:
      return undefined;
  }
};

// `<c:dLbls><c:separator>…</c:separator>` — leaf text content; common
// values are `" "`, `", "`, `"\n"`, `"; "`.
export const readDataLabelSeparator = (
  dLbls: XmlElement,
): string | undefined => {
  const el = firstChildElement(dLbls, qname("c", "separator", NS_C));
  if (!el) return undefined;
  let acc = "";
  for (const c of el.children) {
    if (c.kind === "text" || c.kind === "cdata") acc += c.data;
  }
  return acc;
};

/**
 * Parses a `<c:chartSpace>` element into a typed `ChartSpec`. Throws if
 * the root or any required child is missing. Returns `null` only when
 * the chart is structurally well-formed but uses a kind we don't model
 * (so callers can fall through to pass-through).
 */
export const readChartSpec = (
  root: XmlElement,
  resolveColor: ChartColorResolver = directColor,
): ChartSpec | null => {
  if (root.name.namespaceURI !== NS_C || root.name.localName !== "chartSpace") {
    throw new Error(
      `expected <c:chartSpace> root, got <${root.name.prefix}:${root.name.localName}>`,
    );
  }
  void NAME_CHART_SPACE;
  const chart = firstChildElement(root, NAME_CHART);
  if (!chart) throw new Error("<c:chartSpace> has no <c:chart>");
  const plotArea = firstChildElement(chart, NAME_PLOT_AREA);
  if (!plotArea) throw new Error("<c:chart> has no <c:plotArea>");

  // Collect every "plotted" plot-group element the plotArea carries, in
  // document order. Combo charts emit several (`<c:barChart>` +
  // `<c:lineChart>` …); single-kind charts emit one.
  interface PlotGroup {
    readonly element: XmlElement;
    readonly kind: ChartKind;
  }
  const kindByLocalName = new Map(
    CHART_PLOT_KINDS.map((entry) => [entry.localName, entry] as const),
  );
  const plotGroups: PlotGroup[] = [];
  for (const child of plotArea.children) {
    if (child.kind !== "element" || child.name.namespaceURI !== NS_C) continue;
    const mapped = kindByLocalName.get(child.name.localName);
    if (!mapped) continue;
    let groupKind: ChartKind = mapped.kind;
    // Resolve bar vs column on a `barChart` / `bar3DChart`.
    if (mapped.localName === "barChart" || mapped.localName === "bar3DChart") {
      const barDir = firstChildElement(child, qname("c", "barDir", NS_C));
      const v = barDir !== null ? getAttrValue(barDir, ATTR_VAL) : null;
      groupKind = v === "bar" ? "bar" : "column";
    }
    plotGroups.push({ element: child, kind: groupKind });
  }
  const firstGroup = plotGroups[0];
  if (!firstGroup) return null;
  const plotted = firstGroup.element;
  const kind = firstGroup.kind;

  const { readAxisId, groupAxisIds, groupUsesSecondaryAxis, axisForGroups } =
    chartAxisContext(plotArea, plotGroups);

  // Read every <c:ser> from every plot group, tagging series from
  // non-first groups with their group's kind / axis so the round-trip
  // preserves the combo layout.
  const series: ChartSeries[] = [];
  let categoriesFromFirst: string[] | null = null;
  let categoryNumberFormat: string | undefined;
  const serEntries: {
    ser: XmlElement;
    groupKind: ChartKind;
    secondary: boolean;
  }[] = [];
  for (const group of plotGroups) {
    const secondary = groupUsesSecondaryAxis(group.element);
    for (const ser of allChildElements(group.element, NAME_SER)) {
      serEntries.push({ ser, groupKind: group.kind, secondary });
    }
  }
  for (const { ser, groupKind, secondary } of serEntries) {
    const name = readSeriesName(ser);
    const cat = firstChildElement(ser, NAME_CAT);
    if (cat !== null && categoriesFromFirst === null) {
      // `<c:cat>` is usually `<c:strRef>` (text categories), but date /
      // numeric categories serialize as `<c:numRef>`. Fall back to the
      // numeric channel formatted as a string so date / number cats
      // still appear on the axis instead of disappearing entirely.
      categoriesFromFirst = readStringRef(cat) ?? null;
      if (categoriesFromFirst === null) {
        const nums = readNumRef(cat);
        if (nums !== null) {
          categoryNumberFormat = readCacheFormat(cat) ?? "General";
          categoriesFromFirst = nums.map((n) =>
            n === null || !Number.isFinite(n) ? "" : String(n),
          );
        }
      }
    }
    let valEl = firstChildElement(ser, NAME_VAL);
    // Scatter / bubble carry their y-channel on <c:yVal> rather than
    // <c:val>; their x-channel is <c:xVal> and bubble's per-point size
    // is <c:bubbleSize>. Radar / line use <c:val> against shared cats.
    if (!valEl) {
      valEl = firstChildElement(ser, qname("c", "yVal", NS_C));
    }
    const values = valEl !== null ? readNumRef(valEl) : null;
    const numberFormat = readCacheFormat(valEl);
    const xValEl = firstChildElement(ser, qname("c", "xVal", NS_C));
    const xValues = xValEl !== null ? readNumRef(xValEl) : null;
    const bubbleSizeEl = firstChildElement(ser, qname("c", "bubbleSize", NS_C));
    const bubbleSizes = bubbleSizeEl !== null ? readNumRef(bubbleSizeEl) : null;
    const color = readSeriesColor(ser, resolveColor);
    const { lineColor, lineWidthEmu, lineDash } = readSeriesLineProps(
      ser,
      resolveColor,
    );
    const marker = readSeriesMarker(ser, resolveColor);
    const invertEl = firstChildElement(
      ser,
      qname("c", "invertIfNegative", NS_C),
    );
    const invertIfNegative = readBoolean(invertEl);
    const negativeFill = invertedSolidFillHost(ser);
    const negativeColor = negativeFill
      ? readChartSolidPaint(negativeFill, resolveColor)
      : undefined;
    // <c:dPt> data-point overrides — sparse maps idx → color / explosion.
    const {
      colors: pointColors,
      explosions: pointExplosions,
      inversions: pointInvertIfNegative,
    } = readDataPointOverrides(ser, resolveColor);
    // <c:smooth val="1"/> — line / area / scatter only.
    const smoothEl = firstChildElement(ser, qname("c", "smooth", NS_C));
    const smooth =
      smoothEl !== null && getAttrValue(smoothEl, ATTR_VAL) !== "0";
    const trendline = readTrendline(ser, resolveColor);
    const errorBars = readErrorBars(ser, resolveColor);
    // Per-series <c:dLbls> overrides the chart-level toggles for this
    // one series.
    const serDLblsEl = firstChildElement(ser, qname("c", "dLbls", NS_C));
    let serDataLabels: ChartDataLabels | undefined;
    if (serDLblsEl) {
      const readToggle = (local: string): boolean => {
        const el = firstChildElement(serDLblsEl, qname("c", local, NS_C));
        if (!el) return false;
        const v = getAttrValue(el, ATTR_VAL);
        return v === null || v === "1" || v === "true";
      };
      const format = readNumberFormat(serDLblsEl);
      const position = readDataLabelPosition(serDLblsEl);
      const separator = readDataLabelSeparator(serDLblsEl);
      const txPrEl = firstChildElement(serDLblsEl, qname("c", "txPr", NS_C));
      const textStyle = txPrEl
        ? readChartTextStyle(txPrEl, resolveColor)
        : undefined;
      serDataLabels = {
        showValue: readToggle("showVal"),
        showCategory: readToggle("showCatName"),
        showSeriesName: readToggle("showSerName"),
        showPercent: readToggle("showPercent"),
        ...format,
        ...(position !== undefined ? { position } : {}),
        ...(separator !== undefined ? { separator } : {}),
        ...(textStyle !== undefined ? { textStyle } : {}),
      };
    }
    const xNumberFormat = readCacheFormat(xValEl);
    const bubbleSizeNumberFormat = readCacheFormat(bubbleSizeEl);
    series.push({
      name,
      values: values ?? [],
      ...(numberFormat !== undefined ? { numberFormat } : {}),
      ...(xNumberFormat !== undefined ? { xNumberFormat } : {}),
      ...(bubbleSizeNumberFormat !== undefined
        ? { bubbleSizeNumberFormat }
        : {}),
      ...(groupKind !== kind && isComboSeriesKind(groupKind)
        ? { chartKind: groupKind }
        : {}),
      ...(secondary ? { secondaryAxis: true } : {}),
      ...(xValues !== null ? { xValues } : {}),
      ...(bubbleSizes !== null ? { bubbleSizes } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(lineColor !== undefined ? { lineColor } : {}),
      ...(lineWidthEmu !== undefined ? { lineWidthEmu } : {}),
      ...(lineDash !== undefined ? { lineDash } : {}),
      ...marker,
      ...(invertIfNegative !== undefined ? { invertIfNegative } : {}),
      ...(negativeColor !== undefined ? { negativeColor } : {}),
      ...(pointInvertIfNegative !== undefined ? { pointInvertIfNegative } : {}),
      ...(pointColors !== undefined ? { pointColors } : {}),
      ...(pointExplosions !== undefined ? { pointExplosions } : {}),
      ...(smoothEl !== null ? { smooth } : {}),
      ...(trendline !== undefined ? { trendline } : {}),
      ...(errorBars !== undefined ? { errorBars } : {}),
      ...(serDataLabels !== undefined ? { dataLabels: serDataLabels } : {}),
    });
  }

  const categories = categoriesFromFirst ?? [];
  const title = readTitle(chart);
  const titleStyle = readTitleStyle(chart, resolveColor);

  // <c:dLbls> can sit either on the plotted-kind element (`barChart`,
  // `lineChart`, …) for chart-level defaults or on each `<c:ser>` for
  // per-series overrides. Surface the plotted-kind defaults; per-series
  // toggles are deferred until renderers care.
  const dLbls = firstChildElement(plotted, qname("c", "dLbls", NS_C));
  let dataLabels: ChartDataLabels | undefined;
  if (dLbls) {
    const readToggle = (local: string): boolean => {
      const el = firstChildElement(dLbls, qname("c", local, NS_C));
      if (!el) return false;
      const v = getAttrValue(el, ATTR_VAL);
      // Absent val attribute defaults to true per the schema's CT_Boolean.
      return v === null || v === "1" || v === "true";
    };
    const format = readNumberFormat(dLbls);
    const position = readDataLabelPosition(dLbls);
    const separator = readDataLabelSeparator(dLbls);
    const txPrEl = firstChildElement(dLbls, qname("c", "txPr", NS_C));
    const textStyle = txPrEl
      ? readChartTextStyle(txPrEl, resolveColor)
      : undefined;
    dataLabels = {
      showValue: readToggle("showVal"),
      showCategory: readToggle("showCatName"),
      showSeriesName: readToggle("showSerName"),
      showPercent: readToggle("showPercent"),
      ...format,
      ...(position !== undefined ? { position } : {}),
      ...(separator !== undefined ? { separator } : {}),
      ...(textStyle !== undefined ? { textStyle } : {}),
    };
  }

  // <c:valAx> lives on the plotArea (not on the plotted-kind element).
  // Pull its <c:scaling><c:min/>/<c:max/> as the authored axis range,
  // plus optional <c:majorUnit> / <c:minorUnit> tick spacing.
  let valueAxis: ChartAxisScaling | undefined;
  // XY plots have two valAx nodes on one system. Physical axis position
  // identifies their roles independently of XML order or left/right side.
  const numericXY = kind === "scatter" || kind === "bubble";
  const {
    value: valAx,
    category: catAx,
    secondaryValue: secondaryValAx,
    secondaryCategory: secondaryCatAx,
  } = chartAxisRoles(plotArea, { axisForGroups }, numericXY);
  const sourceFormat = (
    axis: XmlElement | null,
    category: boolean,
  ): string | undefined => {
    const id =
      axis && readAxisId(firstChildElement(axis, qname("c", "axId", NS_C)));
    if (id == null) return undefined;
    const group = plotGroups.find((g) => groupAxisIds(g.element).includes(id));
    const ser = group && firstChildElement(group.element, NAME_SER);
    if (!ser) return undefined;
    const channel = category
      ? firstChildElement(ser, numericXY ? qname("c", "xVal", NS_C) : NAME_CAT)
      : (firstChildElement(ser, NAME_VAL) ??
        firstChildElement(ser, qname("c", "yVal", NS_C)));
    return readCacheFormat(channel);
  };
  if (valAx) {
    let min: number | undefined;
    let max: number | undefined;
    let majorUnit: number | undefined;
    let minorUnit: number | undefined;
    let logBase: number | undefined;
    let displayUnits: ChartAxisScaling["displayUnits"];
    const scaling = firstChildElement(valAx, qname("c", "scaling", NS_C));
    const readNumOn = (
      parent: XmlElement,
      local: string,
    ): number | undefined => {
      const el = firstChildElement(parent, qname("c", local, NS_C));
      if (!el) return undefined;
      const v = getAttrValue(el, ATTR_VAL);
      if (v === null) return undefined;
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : undefined;
    };
    if (scaling) {
      min = readNumOn(scaling, "min");
      max = readNumOn(scaling, "max");
      // <c:logBase val="N"/> — N must be in [2, 1000] (ST_LogBase).
      const lb = readNumOn(scaling, "logBase");
      if (lb !== undefined && lb >= 2 && lb <= 1000) logBase = lb;
    }
    majorUnit = readNumOn(valAx, "majorUnit");
    minorUnit = readNumOn(valAx, "minorUnit");
    // <c:dispUnits><c:builtInUnit val="hundreds|thousands|…"/>
    const dispUnits = firstChildElement(valAx, qname("c", "dispUnits", NS_C));
    if (dispUnits) {
      const builtIn = firstChildElement(
        dispUnits,
        qname("c", "builtInUnit", NS_C),
      );
      if (builtIn) {
        const v = getAttrValue(builtIn, ATTR_VAL);
        switch (v) {
          case "hundreds":
          case "thousands":
          case "tenThousands":
          case "hundredThousands":
          case "millions":
          case "tenMillions":
          case "hundredMillions":
          case "billions":
          case "trillions":
            displayUnits = v;
            break;
        }
      }
    }
    const format = readNumberFormat(valAx);
    const sourceNumberFormat = sourceFormat(valAx, false);
    const sourceFormatProps =
      sourceNumberFormat !== undefined &&
      (format.numberFormatSourceLinked === true ||
        (format.numberFormat === undefined && sourceNumberFormat !== "General"))
        ? { sourceNumberFormat }
        : {};
    if (
      min !== undefined ||
      max !== undefined ||
      majorUnit !== undefined ||
      minorUnit !== undefined ||
      Object.keys(format).length > 0 ||
      Object.keys(sourceFormatProps).length > 0 ||
      logBase !== undefined ||
      displayUnits !== undefined
    ) {
      valueAxis = {
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(majorUnit !== undefined ? { majorUnit } : {}),
        ...(minorUnit !== undefined ? { minorUnit } : {}),
        ...format,
        ...sourceFormatProps,
        ...(logBase !== undefined ? { logBase } : {}),
        ...(displayUnits !== undefined ? { displayUnits } : {}),
      };
    }
  }

  // <c:grouping val="clustered|stacked|percentStacked|standard"/>
  // sits as a direct child of the plotted-kind element. Restrict this
  // chart-wide legacy field to the kinds that actually carry it.
  let grouping: ChartGrouping | undefined;
  if (
    kind === "column" ||
    kind === "bar" ||
    kind === "area" ||
    kind === "line"
  ) {
    const groupingEl = firstChildElement(plotted, qname("c", "grouping", NS_C));
    if (groupingEl) {
      const g = getAttrValue(groupingEl, ATTR_VAL);
      if (
        g === "clustered" ||
        g === "stacked" ||
        g === "percentStacked" ||
        g === "standard"
      ) {
        grouping = g;
      }
    }
  }

  // <c:dropLines> and <c:hiLowLines> on the plotted-kind element.
  // Legacy editable flags describe the first native plot. The read-only
  // rendering view resolves independent plot ownership and DrawingML paint.
  const dropLinesEl = firstChildElement(plotted, qname("c", "dropLines", NS_C));
  const hiLowLinesEl = firstChildElement(
    plotted,
    qname("c", "hiLowLines", NS_C),
  );
  const dropLines = dropLinesEl !== null ? true : undefined;
  const linePlot = plotGroups.find((group) => group.kind === "line");
  const upDownBars =
    linePlot &&
    firstChildElement(linePlot.element, qname("c", "upDownBars", NS_C))
      ? true
      : undefined;
  const dataTable = readDataTable(plotArea);
  const hiLowLines = hiLowLinesEl !== null ? true : undefined;

  // Preserve the raw Show Marker flag, including absence. Readers ignore it
  // for actual marker visibility (MS-OE376 §2.1.1517); series symbols decide.
  const lineMarkers =
    kind === "line"
      ? readBoolean(firstChildElement(plotted, qname("c", "marker", NS_C)))
      : undefined;

  // <c:gapWidth> and <c:overlap> live on the plotted-kind element and
  // tune the bar / column spacing. Defaults: gapWidth=150
  // (1.5× bar width gap), overlap=0 (clustered) or 100 (stacked).
  let gapWidthPct: number | undefined;
  let overlapPct: number | undefined;
  if (kind === "column" || kind === "bar") {
    const gwEl = firstChildElement(plotted, qname("c", "gapWidth", NS_C));
    if (gwEl) {
      const v = getAttrValue(gwEl, ATTR_VAL);
      if (v !== null) {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n)) gapWidthPct = n;
      }
    }
    const ovEl = firstChildElement(plotted, qname("c", "overlap", NS_C));
    if (ovEl) {
      const v = getAttrValue(ovEl, ATTR_VAL);
      if (v !== null) {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n)) overlapPct = n;
      }
    }
  }

  // Axis titles — <c:catAx><c:title> and <c:valAx><c:title>. Both
  // use the same rich-text container as the chart title, so reuse
  // readTitle's projection.
  let categoryAxisTitle: string | undefined;
  let categoryAxisTitleStyle: ChartTextStyle | undefined;
  let categoryAxisTitleRotationDeg: number | undefined;
  let categoryAxisLabelStyle: ChartTextStyle | undefined;
  let categoryAxisLabelRotationDeg: number | null | undefined;
  let valueAxisLabelRotationDeg: number | null | undefined;
  let valueAxisMajorTickMark: ChartSpec["valueAxisMajorTickMark"];
  let categoryAxisMajorTickMark: ChartSpec["categoryAxisMajorTickMark"];
  let valueAxisMinorTickMark: ChartSpec["valueAxisMinorTickMark"];
  let categoryAxisMinorTickMark: ChartSpec["categoryAxisMinorTickMark"];
  const readTickMarkLocal = (
    axis: XmlElement,
    local: "majorTickMark" | "minorTickMark",
  ): "in" | "out" | "cross" | "none" | undefined => {
    return readNativeTickMark(firstChildElement(axis, qname("c", local, NS_C)));
  };
  const readTickMark = (
    axis: XmlElement,
  ): "in" | "out" | "cross" | "none" | undefined =>
    readTickMarkLocal(axis, "majorTickMark");
  let valueAxisTitle: string | undefined;
  let valueAxisTitleStyle: ChartTextStyle | undefined;
  let valueAxisTitleRotationDeg: number | undefined;
  let valueAxisLabelStyle: ChartTextStyle | undefined;
  let categoryAxisHidden: boolean | undefined;
  let valueAxisHidden: boolean | undefined;
  let categoryAxisTickLabelSkip: number | undefined;
  let categoryAxisTickMarkSkip: number | undefined;
  let categoryAxisLabelOffset: number | undefined;
  let categoryAxisLabelAlign: ChartSpec["categoryAxisLabelAlign"];
  let categoryAxisNumberFormat: string | undefined;
  let categoryAxisNoMultiLevelLabel: boolean | undefined;
  let categoryAxisLineColor: string | null | undefined;
  let valueAxisLineColor: string | null | undefined;
  let categoryAxisMajorGridlines: boolean | undefined;
  let categoryAxisMinorGridlines: boolean | undefined;
  let categoryAxisMajorGridlineColor: string | null | undefined;
  let categoryAxisMinorGridlineColor: string | null | undefined;
  let valueAxisMinorGridlineColor: string | null | undefined;
  const readSpPrFill = (parent: XmlElement): string | null | undefined => {
    const spPr = firstChildElement(parent, NAME_SP_PR_C);
    return spPr ? readChartPaint(spPr, resolveColor) : undefined;
  };
  const readSpPrStrokeColor = (
    parent: XmlElement,
  ): string | null | undefined => {
    const spPr = firstChildElement(parent, NAME_SP_PR_C);
    const ln = spPr && firstChildElement(spPr, qname("a", "ln", NS_A));
    return ln ? readChartPaint(ln, resolveColor) : undefined;
  };
  const isHidden = (axis: XmlElement): boolean | undefined => {
    const d = firstChildElement(axis, qname("c", "delete", NS_C));
    if (!d) return undefined;
    const v = getAttrValue(d, ATTR_VAL);
    return v === null || v === "1" || v === "true";
  };
  let categoryAxisOrientation: "minMax" | "maxMin" | undefined;
  let valueAxisOrientation: "minMax" | "maxMin" | undefined;
  const valueAxisCrosses = readChartAxisCrossing(valAx);
  const categoryAxisCrosses = readChartAxisCrossing(catAx);
  const secondaryCategoryAxisCrosses = readChartAxisCrossing(secondaryCatAx);
  const readCrossBetween = (axis: XmlElement | null) => {
    const el =
      axis && firstChildElement(axis, qname("c", "crossBetween", NS_C));
    const v = el && getAttrValue(el, ATTR_VAL);
    return v === "between" || v === "midCat" ? v : undefined;
  };
  const valueAxisCrossBetween = readCrossBetween(valAx);
  const readAxisOrientation = (
    axis: XmlElement,
  ): "minMax" | "maxMin" | undefined => {
    const scaling = firstChildElement(axis, qname("c", "scaling", NS_C));
    if (!scaling) return undefined;
    const orientationEl = firstChildElement(
      scaling,
      qname("c", "orientation", NS_C),
    );
    if (!orientationEl) return undefined;
    // A present CT_Orientation element defaults val to minMax.
    const v = getAttrValue(orientationEl, ATTR_VAL) ?? "minMax";
    if (v === "minMax" || v === "maxMin") return v;
    return undefined;
  };
  const secondaryCategoryAxisOrientation = secondaryCatAx
    ? readAxisOrientation(secondaryCatAx)
    : undefined;
  const secondaryValueAxisLineColor = secondaryValAx
    ? readSpPrStrokeColor(secondaryValAx)
    : undefined;
  const secondaryCategoryAxisLineColor = secondaryCatAx
    ? readSpPrStrokeColor(secondaryCatAx)
    : undefined;
  const gridlineWidth = (axis: XmlElement | null, name: string) =>
    readChartStrokeWidth(
      axis && firstChildElement(axis, qname("c", name, NS_C)),
    );
  const strokeWidths = {
    categoryAxisLineWidthEmu: readChartStrokeWidth(catAx),
    valueAxisLineWidthEmu: readChartStrokeWidth(valAx),
    categoryAxisMajorGridlineWidthEmu: gridlineWidth(catAx, "majorGridlines"),
    categoryAxisMinorGridlineWidthEmu: gridlineWidth(catAx, "minorGridlines"),
    valueAxisMajorGridlineWidthEmu: gridlineWidth(valAx, "majorGridlines"),
    valueAxisMinorGridlineWidthEmu: gridlineWidth(valAx, "minorGridlines"),
    secondaryCategoryAxisLineWidthEmu: readChartStrokeWidth(secondaryCatAx),
    secondaryValueAxisLineWidthEmu: readChartStrokeWidth(secondaryValAx),
    plotAreaStrokeWidthEmu: readChartStrokeWidth(plotArea),
    chartAreaStrokeWidthEmu: readChartStrokeWidth(root),
  };
  const secondaryValueAxisCrossBetween = readCrossBetween(secondaryValAx);
  const secondaryValueAxisCrosses = readChartAxisCrossing(secondaryValAx);
  const categoryAxisTickLabelPos = readChartAxisTickLabelPosition(catAx);
  const valueAxisTickLabelPos = readChartAxisTickLabelPosition(valAx);
  const secondaryCategoryAxisTickLabelPos =
    readChartAxisTickLabelPosition(secondaryCatAx);
  const secondaryValueAxisTickLabelPos =
    readChartAxisTickLabelPosition(secondaryValAx);
  const secondaryValueAxisOrientation = secondaryValAx
    ? readAxisOrientation(secondaryValAx)
    : undefined;
  if (catAx) {
    const t = readTitle(catAx);
    if (t !== undefined) categoryAxisTitle = t;
    const catTitleEl = firstChildElement(catAx, NAME_TITLE);
    if (catTitleEl) {
      categoryAxisTitleStyle = readTitleStyleOf(catTitleEl, resolveColor);
      categoryAxisTitleRotationDeg = readTitleRotationDeg(catTitleEl);
    }
    const catTxPr = firstChildElement(catAx, qname("c", "txPr", NS_C));
    if (catTxPr) {
      categoryAxisLabelStyle = readChartTextStyle(catTxPr, resolveColor);
      // <c:txPr><a:bodyPr rot="N"/> — N is in 60000ths of a degree.
      const bodyPr = firstChildElement(catTxPr, qname("a", "bodyPr", NS_A));
      if (bodyPr) {
        const rotRaw = getAttrValue(bodyPr, qname("", "rot", ""));
        if (rotRaw !== null) {
          const n = Number.parseInt(rotRaw, 10);
          if (Number.isFinite(n))
            categoryAxisLabelRotationDeg =
              n === CHART_AUTO_ROTATION ? null : n / 60000;
        }
      }
    }
    categoryAxisHidden = isHidden(catAx);
    categoryAxisLineColor = readSpPrStrokeColor(catAx);
    const catMajorGl = firstChildElement(
      catAx,
      qname("c", "majorGridlines", NS_C),
    );
    categoryAxisMajorGridlines = catMajorGl !== null;
    if (catMajorGl)
      categoryAxisMajorGridlineColor = readSpPrStrokeColor(catMajorGl);
    const catMinorGl = firstChildElement(
      catAx,
      qname("c", "minorGridlines", NS_C),
    );
    categoryAxisMinorGridlines = catMinorGl !== null;
    if (catMinorGl)
      categoryAxisMinorGridlineColor = readSpPrStrokeColor(catMinorGl);
    categoryAxisOrientation = readAxisOrientation(catAx);
    categoryAxisMajorTickMark = readTickMark(catAx);
    categoryAxisMinorTickMark = readTickMarkLocal(catAx, "minorTickMark");
    const readSkip = (local: "tickLblSkip" | "tickMarkSkip") => {
      const el = firstChildElement(catAx, qname("c", local, NS_C));
      const n = el && readUnsignedInt(getAttrValue(el, ATTR_VAL));
      // ST_Skip is unsignedInt with minInclusive=1. Preserve authored 1.
      return n !== null && n !== undefined && n >= 1 ? n : undefined;
    };
    categoryAxisTickLabelSkip = readSkip("tickLblSkip");
    categoryAxisTickMarkSkip = readSkip("tickMarkSkip");
    const lblOffsetEl = firstChildElement(catAx, qname("c", "lblOffset", NS_C));
    if (lblOffsetEl) {
      const v = getAttrValue(lblOffsetEl, ATTR_VAL);
      if (v !== null) {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n) && n !== 100) categoryAxisLabelOffset = n;
      }
    }
    const lblAlgnEl = firstChildElement(catAx, qname("c", "lblAlgn", NS_C));
    if (lblAlgnEl) {
      const v = getAttrValue(lblAlgnEl, ATTR_VAL);
      if (v === "ctr" || v === "l" || v === "r") categoryAxisLabelAlign = v;
    }
    categoryAxisNumberFormat = readNumberFormat(catAx).numberFormat;
    const noMultiLvlEl = firstChildElement(
      catAx,
      qname("c", "noMultiLvlLbl", NS_C),
    );
    categoryAxisNoMultiLevelLabel = readBoolean(noMultiLvlEl);
  }
  // <c:majorGridlines> / <c:minorGridlines> presence governs visibility.
  // Surface as explicit booleans so renderers can branch on "absent
  // means hidden" (matches ECMA-376 §21.2.2.122).
  let valueAxisMajorGridlines: boolean | undefined;
  let valueAxisMinorGridlines: boolean | undefined;
  let valueAxisMajorGridlineColor: string | null | undefined;
  if (valAx) {
    const t = readTitle(valAx);
    if (t !== undefined) valueAxisTitle = t;
    const valTitleEl = firstChildElement(valAx, NAME_TITLE);
    if (valTitleEl) {
      valueAxisTitleStyle = readTitleStyleOf(valTitleEl, resolveColor);
      valueAxisTitleRotationDeg = readTitleRotationDeg(valTitleEl);
    }
    const valTxPr = firstChildElement(valAx, qname("c", "txPr", NS_C));
    if (valTxPr) {
      valueAxisLabelStyle = readChartTextStyle(valTxPr, resolveColor);
      const bodyPr = firstChildElement(valTxPr, qname("a", "bodyPr", NS_A));
      if (bodyPr) {
        const rotRaw = getAttrValue(bodyPr, qname("", "rot", ""));
        if (rotRaw !== null) {
          const n = Number.parseInt(rotRaw, 10);
          if (Number.isFinite(n))
            valueAxisLabelRotationDeg =
              n === CHART_AUTO_ROTATION ? null : n / 60000;
        }
      }
    }
    valueAxisHidden = isHidden(valAx);
    valueAxisLineColor = readSpPrStrokeColor(valAx);
    valueAxisOrientation = readAxisOrientation(valAx);
    valueAxisMajorTickMark = readTickMark(valAx);
    valueAxisMinorTickMark = readTickMarkLocal(valAx, "minorTickMark");
    const majorGl = firstChildElement(
      valAx,
      qname("c", "majorGridlines", NS_C),
    );
    valueAxisMajorGridlines = majorGl !== null;
    if (majorGl) valueAxisMajorGridlineColor = readSpPrStrokeColor(majorGl);
    const minorGl = firstChildElement(
      valAx,
      qname("c", "minorGridlines", NS_C),
    );
    valueAxisMinorGridlines = minorGl !== null;
    if (minorGl) valueAxisMinorGridlineColor = readSpPrStrokeColor(minorGl);
  }

  const plotAreaFill = readSpPrFill(plotArea);
  const plotAreaStrokeColor = readSpPrStrokeColor(plotArea);
  const chartAreaFill = readSpPrFill(root);
  const chartAreaStrokeColor = readSpPrStrokeColor(root);

  // <c:dispBlanksAs val="…"/> sits on the chart element. Controls how
  // null gaps in line / area series render: 'gap' (default), 'zero', or
  // 'span'.
  let dispBlanksAs: ChartSpec["dispBlanksAs"];
  const dbaEl = firstChildElement(chart, qname("c", "dispBlanksAs", NS_C));
  if (dbaEl) {
    const v = getAttrValue(dbaEl, ATTR_VAL);
    if (v === "gap" || v === "zero" || v === "span") dispBlanksAs = v;
  }
  // CT_Boolean defaults val to true only when its parent is present.
  // Retain explicit false and omission independently; invalid tokens do not
  // become a guessed boolean. XML Schema boolean whitespace is collapsed.
  const maximumLabels = firstChildElement(
    chart,
    qname("c", "showDLblsOverMax", NS_C),
  );
  const showDataLabelsOverMaximum = readBoolean(maximumLabels);
  // <c:plotVisOnly val="0|1"/> — default is 1. Surface as
  // `plotVisibleCellsOnly: false` only when explicitly 0 so the round-trip
  // doesn't add a redundant `false` for every default-shaped chart.
  let plotVisibleCellsOnly: boolean | undefined;
  const pvoEl = firstChildElement(chart, qname("c", "plotVisOnly", NS_C));
  if (pvoEl) {
    const v = getAttrValue(pvoEl, ATTR_VAL);
    if (v === "0" || v === "false") plotVisibleCellsOnly = false;
  }
  const rcEl = firstChildElement(root, qname("c", "roundedCorners", NS_C));
  const roundedCorners = readBoolean(rcEl);
  // Preset identity, including the c14 alternate-content representation.
  const chartStyle = readChartStyle(root);
  // <c:chartSpace><c:lang val="…"/> + <c:date1904 val="…"/> — authoring
  // metadata. Surface for round-trip fidelity.
  let language: string | undefined;
  const langEl = firstChildElement(root, qname("c", "lang", NS_C));
  if (langEl) {
    const v = getAttrValue(langEl, ATTR_VAL);
    if (v !== null && v.length > 0) language = v;
  }
  let date1904: boolean | undefined;
  const dateEl = firstChildElement(root, qname("c", "date1904", NS_C));
  if (dateEl) {
    const v = getAttrValue(dateEl, ATTR_VAL)?.replace(
      /^[\t\n\r ]+|[\t\n\r ]+$/g,
      "",
    );
    // CT_Boolean defaults val to true when its element is present.
    if (v === undefined || v === "1" || v === "true") date1904 = true;
  }

  // <c:legend> sits on the chart element (not the plotArea). Read the
  // position; it defaults to 'r' (right) when the element is
  // present but has no legendPos. Absent legend element means renderers
  // fall back to whatever they show by default.
  let legend: ChartSpec["legend"];
  const legendEl = firstChildElement(chart, qname("c", "legend", NS_C));
  if (legendEl) {
    const posEl = firstChildElement(legendEl, qname("c", "legendPos", NS_C));
    const tok = posEl ? getAttrValue(posEl, ATTR_VAL) : null;
    const ovEl = firstChildElement(legendEl, qname("c", "overlay", NS_C));
    const overlay = ovEl ? getAttrValue(ovEl, ATTR_VAL) !== "0" : false;
    const txPr = firstChildElement(legendEl, qname("c", "txPr", NS_C));
    const textStyle = txPr ? readChartTextStyle(txPr, resolveColor) : undefined;
    // <c:legendEntry><c:idx val="N"/><c:delete val="1"/> — legend-entry indices
    // the author wants suppressed from the legend (trendlines often hide).
    const hiddenIndices: number[] = [];
    for (const c of legendEl.children) {
      if (
        c.kind !== "element" ||
        c.name.namespaceURI !== NS_C ||
        c.name.localName !== "legendEntry"
      )
        continue;
      const idxEl = firstChildElement(c, qname("c", "idx", NS_C));
      const delEl = firstChildElement(c, qname("c", "delete", NS_C));
      if (!idxEl || !delEl) continue;
      const delV = getAttrValue(delEl, ATTR_VAL);
      const isDeleted = delV === null || delV === "1" || delV === "true";
      if (!isDeleted) continue;
      const idxV = getAttrValue(idxEl, ATTR_VAL);
      if (idxV === null) continue;
      const n = Number.parseInt(idxV, 10);
      if (Number.isFinite(n) && n >= 0) hiddenIndices.push(n);
    }
    const position: "r" | "t" | "b" | "l" | "tr" =
      tok === "r" || tok === "t" || tok === "b" || tok === "l" || tok === "tr"
        ? tok
        : "r";
    const fill = readSpPrFill(legendEl);
    const strokeColor = readSpPrStrokeColor(legendEl);
    const strokeWidthEmu = readChartStrokeWidth(legendEl);
    legend = {
      position,
      ...(fill !== undefined ? { fill } : {}),
      ...(strokeColor !== undefined ? { strokeColor } : {}),
      ...(strokeWidthEmu !== undefined ? { strokeWidthEmu } : {}),
      ...(overlay ? { overlay } : {}),
      ...(textStyle !== undefined ? { textStyle } : {}),
      ...(hiddenIndices.length > 0 ? { hiddenIndices } : {}),
    };
  }

  // <c:barChart><c:varyColors val="1"/> etc. — single-series charts use
  // it to color each data point uniquely.
  let varyColors: boolean | undefined;
  const vcEl = firstChildElement(plotted, qname("c", "varyColors", NS_C));
  if (vcEl) {
    const v = getAttrValue(vcEl, ATTR_VAL);
    varyColors = v === null || v === "1" || v === "true";
  }

  // <c:title><c:overlay val="1"/>
  let titleOverlay: boolean | undefined;
  const titleEl = firstChildElement(chart, NAME_TITLE);
  if (titleEl) {
    const ovEl = firstChildElement(titleEl, qname("c", "overlay", NS_C));
    if (ovEl) {
      titleOverlay = getAttrValue(ovEl, ATTR_VAL) !== "0";
    }
  }

  // Pie-specific extras: starting angle + doughnut hole size.
  let firstSliceAngleDeg: number | undefined;
  let holeSizePct: number | undefined;
  if (kind === "pie" || kind === "doughnut") {
    const fsAng = firstChildElement(plotted, qname("c", "firstSliceAng", NS_C));
    if (fsAng) {
      const v = getAttrValue(fsAng, ATTR_VAL);
      if (v !== null) {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n)) firstSliceAngleDeg = ((n % 360) + 360) % 360;
      }
    }
    if (kind === "doughnut") {
      // Omission is treated as no hole and canonicalized to val=0.
      holeSizePct = 0;
      const hs = firstChildElement(plotted, qname("c", "holeSize", NS_C));
      if (hs) {
        const v = getAttrValue(hs, ATTR_VAL);
        if (v !== null) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n)) holeSizePct = Math.max(0, Math.min(90, n));
        }
      }
    }
  }

  // Scatter / radar / bubble sub-type + bubble sizing, all read from the
  // plotted-kind element.
  let scatterStyle: ChartSpec["scatterStyle"];
  let radarStyle: ChartSpec["radarStyle"];
  let bubbleScale: number | undefined;
  let bubbleSizeRepresents: ChartSpec["bubbleSizeRepresents"];
  if (kind === "scatter") {
    const el = firstChildElement(plotted, qname("c", "scatterStyle", NS_C));
    if (el) {
      const v = getAttrValue(el, ATTR_VAL);
      if (
        v === "none" ||
        v === "line" ||
        v === "lineMarker" ||
        v === "marker" ||
        v === "smooth" ||
        v === "smoothMarker"
      ) {
        scatterStyle = v;
      }
    }
  } else if (kind === "radar") {
    const el = firstChildElement(plotted, qname("c", "radarStyle", NS_C));
    if (el) {
      const v = getAttrValue(el, ATTR_VAL);
      if (v === "standard" || v === "marker" || v === "filled") radarStyle = v;
    }
  } else if (kind === "bubble") {
    const bsEl = firstChildElement(plotted, qname("c", "bubbleScale", NS_C));
    if (bsEl) {
      const v = getAttrValue(bsEl, ATTR_VAL);
      if (v !== null) {
        const n = Number.parseInt(v, 10);
        // ST_BubbleScale spans 0..300; clamp out-of-range author values.
        if (Number.isFinite(n) && n >= 0) bubbleScale = Math.min(300, n);
      }
    }
    const srEl = firstChildElement(plotted, qname("c", "sizeRepresents", NS_C));
    if (srEl) {
      const v = getAttrValue(srEl, ATTR_VAL);
      // ST_SizeRepresents tokens are 'area' and 'w'; surface 'w' as 'width'.
      if (v === "area") bubbleSizeRepresents = "area";
      else if (v === "w") bubbleSizeRepresents = "width";
    }
  }

  const axisFormatProps = (
    axis: XmlElement | null,
    category: boolean,
    prefix: string,
  ) => {
    const format = readNumberFormat(axis),
      cached = sourceFormat(axis, category);
    return {
      ...(format.numberFormat !== undefined
        ? { [`${prefix}NumberFormat`]: format.numberFormat }
        : {}),
      ...(format.numberFormatSourceLinked !== undefined
        ? {
            [`${prefix}NumberFormatSourceLinked`]:
              format.numberFormatSourceLinked,
          }
        : {}),
      ...(cached !== undefined &&
      (format.numberFormatSourceLinked === true ||
        (format.numberFormat === undefined && cached !== "General"))
        ? { [`${prefix}SourceNumberFormat`]: cached }
        : {}),
    };
  };
  const textPr = firstChildElement(root, qname("c", "txPr", NS_C));
  const textStyle = textPr
    ? readChartTextStyle(textPr, resolveColor)
    : undefined;
  const spec: ChartSpec = {
    kind,
    categories,
    ...(categoryNumberFormat !== undefined ? { categoryNumberFormat } : {}),
    ...axisFormatProps(catAx, true, "categoryAxis"),
    ...axisFormatProps(secondaryCatAx, true, "secondaryCategoryAxis"),
    ...axisFormatProps(secondaryValAx, false, "secondaryValueAxis"),
    series,
    ...(textStyle !== undefined ? { textStyle } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(titleStyle !== undefined ? { titleStyle } : {}),
    ...(dataLabels !== undefined ? { dataLabels } : {}),
    ...(valueAxis !== undefined ? { valueAxis } : {}),
    ...(grouping !== undefined ? { grouping } : {}),
    ...(dropLines !== undefined ? { dropLines } : {}),
    ...(hiLowLines !== undefined ? { hiLowLines } : {}),
    ...(upDownBars !== undefined ? { upDownBars } : {}),
    ...(dataTable !== undefined ? { dataTable } : {}),
    ...(lineMarkers !== undefined ? { lineMarkers } : {}),
    ...(gapWidthPct !== undefined ? { gapWidthPct } : {}),
    ...(overlapPct !== undefined ? { overlapPct } : {}),
    ...(legend !== undefined ? { legend } : {}),
    ...(titleOverlay !== undefined ? { titleOverlay } : {}),
    ...(varyColors !== undefined ? { varyColors } : {}),
    ...(dispBlanksAs !== undefined ? { dispBlanksAs } : {}),
    ...(showDataLabelsOverMaximum !== undefined
      ? { showDataLabelsOverMaximum }
      : {}),
    ...(plotVisibleCellsOnly === false ? { plotVisibleCellsOnly: false } : {}),
    ...(roundedCorners !== undefined ? { roundedCorners } : {}),
    ...chartStyle,
    ...(language !== undefined ? { language } : {}),
    ...(date1904 === true ? { date1904: true } : {}),
    ...(plotAreaFill !== undefined ? { plotAreaFill } : {}),
    ...(plotAreaStrokeColor !== undefined ? { plotAreaStrokeColor } : {}),
    ...(chartAreaFill !== undefined ? { chartAreaFill } : {}),
    ...(chartAreaStrokeColor !== undefined ? { chartAreaStrokeColor } : {}),
    ...(categoryAxisTitle !== undefined ? { categoryAxisTitle } : {}),
    ...(categoryAxisTitleStyle !== undefined ? { categoryAxisTitleStyle } : {}),
    ...(categoryAxisTitleRotationDeg !== undefined
      ? { categoryAxisTitleRotationDeg }
      : {}),
    ...(categoryAxisLabelStyle !== undefined ? { categoryAxisLabelStyle } : {}),
    ...(categoryAxisLabelRotationDeg !== undefined
      ? { categoryAxisLabelRotationDeg }
      : {}),
    ...(valueAxisTitle !== undefined ? { valueAxisTitle } : {}),
    ...(valueAxisTitleStyle !== undefined ? { valueAxisTitleStyle } : {}),
    ...(valueAxisTitleRotationDeg !== undefined
      ? { valueAxisTitleRotationDeg }
      : {}),
    ...(valueAxisLabelStyle !== undefined ? { valueAxisLabelStyle } : {}),
    ...(categoryAxisHidden !== undefined ? { categoryAxisHidden } : {}),
    ...(valueAxisHidden !== undefined ? { valueAxisHidden } : {}),
    ...(valueAxisMajorGridlines !== undefined
      ? { valueAxisMajorGridlines }
      : {}),
    ...(valueAxisMajorGridlineColor !== undefined
      ? { valueAxisMajorGridlineColor }
      : {}),
    ...(valueAxisMajorTickMark !== undefined ? { valueAxisMajorTickMark } : {}),
    ...(valueAxisMinorTickMark !== undefined ? { valueAxisMinorTickMark } : {}),
    ...(valueAxisLabelRotationDeg !== undefined
      ? { valueAxisLabelRotationDeg }
      : {}),
    ...(categoryAxisMajorTickMark !== undefined
      ? { categoryAxisMajorTickMark }
      : {}),
    ...(categoryAxisMinorTickMark !== undefined
      ? { categoryAxisMinorTickMark }
      : {}),
    ...(valueAxisMinorGridlines !== undefined
      ? { valueAxisMinorGridlines }
      : {}),
    ...(categoryAxisTickLabelSkip !== undefined
      ? { categoryAxisTickLabelSkip }
      : {}),
    ...(categoryAxisTickMarkSkip !== undefined
      ? { categoryAxisTickMarkSkip }
      : {}),
    ...(categoryAxisTickLabelPos !== undefined
      ? { categoryAxisTickLabelPos }
      : {}),
    ...(valueAxisTickLabelPos !== undefined ? { valueAxisTickLabelPos } : {}),
    ...(secondaryCategoryAxisTickLabelPos !== undefined
      ? { secondaryCategoryAxisTickLabelPos }
      : {}),
    ...(secondaryValueAxisTickLabelPos !== undefined
      ? { secondaryValueAxisTickLabelPos }
      : {}),
    ...(categoryAxisLabelOffset !== undefined
      ? { categoryAxisLabelOffset }
      : {}),
    ...(categoryAxisLabelAlign !== undefined ? { categoryAxisLabelAlign } : {}),
    ...(categoryAxisNumberFormat !== undefined
      ? { categoryAxisNumberFormat }
      : {}),
    ...(categoryAxisNoMultiLevelLabel !== undefined
      ? { categoryAxisNoMultiLevelLabel }
      : {}),
    ...(categoryAxisLineColor !== undefined ? { categoryAxisLineColor } : {}),
    ...(valueAxisLineColor !== undefined ? { valueAxisLineColor } : {}),
    ...(secondaryValueAxisLineColor !== undefined
      ? { secondaryValueAxisLineColor }
      : {}),
    ...(secondaryCategoryAxisLineColor !== undefined
      ? { secondaryCategoryAxisLineColor }
      : {}),
    ...Object.fromEntries(
      Object.entries(strokeWidths).filter(([, width]) => width !== undefined),
    ),
    ...(categoryAxisMajorGridlines === true
      ? { categoryAxisMajorGridlines: true }
      : {}),
    ...(categoryAxisMinorGridlines === true
      ? { categoryAxisMinorGridlines: true }
      : {}),
    ...(categoryAxisMajorGridlineColor !== undefined
      ? { categoryAxisMajorGridlineColor }
      : {}),
    ...(categoryAxisMinorGridlineColor !== undefined
      ? { categoryAxisMinorGridlineColor }
      : {}),
    ...(valueAxisMinorGridlineColor !== undefined
      ? { valueAxisMinorGridlineColor }
      : {}),
    ...(categoryAxisOrientation !== undefined
      ? { categoryAxisOrientation }
      : {}),
    ...(secondaryCategoryAxisOrientation !== undefined
      ? { secondaryCategoryAxisOrientation }
      : {}),
    ...(valueAxisOrientation !== undefined ? { valueAxisOrientation } : {}),
    ...(secondaryValueAxisOrientation !== undefined
      ? { secondaryValueAxisOrientation }
      : {}),
    ...(valueAxisCrosses !== undefined ? { valueAxisCrosses } : {}),
    ...(categoryAxisCrosses !== undefined ? { categoryAxisCrosses } : {}),
    ...(secondaryValueAxisCrosses !== undefined
      ? { secondaryValueAxisCrosses }
      : {}),
    ...(secondaryCategoryAxisCrosses !== undefined
      ? { secondaryCategoryAxisCrosses }
      : {}),
    ...(valueAxisCrossBetween !== undefined ? { valueAxisCrossBetween } : {}),
    ...(secondaryValueAxisCrossBetween !== undefined
      ? { secondaryValueAxisCrossBetween }
      : {}),
    ...(firstSliceAngleDeg !== undefined ? { firstSliceAngleDeg } : {}),
    ...(holeSizePct !== undefined ? { holeSizePct } : {}),
    ...(scatterStyle !== undefined ? { scatterStyle } : {}),
    ...(radarStyle !== undefined ? { radarStyle } : {}),
    ...(bubbleScale !== undefined ? { bubbleScale } : {}),
    ...(bubbleSizeRepresents !== undefined ? { bubbleSizeRepresents } : {}),
  };
  return foldImpliedSeriesStyle(spec);
};

// The writer spells a scatter / radar sub-type on each series as well (a
// hidden line, no markers, smoothing). Those series values say nothing the
// group style does not, so the model keeps just the style.
const foldImpliedSeriesStyle = (spec: ChartSpec): ChartSpec => {
  if (spec.kind !== "scatter" && spec.kind !== "radar") return spec;
  const scatter = spec.kind === "scatter";
  const style = scatter ? (spec.scatterStyle ?? "marker") : spec.radarStyle;
  const hidesLine = scatter && (style === "marker" || style === "none");
  const hidesMarkers = scatter
    ? style === "line" || style === "smooth" || style === "none"
    : style !== "marker";
  const smooth = style === "smooth" || style === "smoothMarker";
  return {
    ...spec,
    series: spec.series.map((series) => {
      const out: { -readonly [K in keyof ChartSeries]?: ChartSeries[K] } = {
        ...series,
      };
      if (
        hidesLine &&
        out.lineColor === null &&
        out.lineWidthEmu === undefined &&
        out.lineDash === undefined
      )
        delete out.lineColor;
      if (
        hidesMarkers &&
        out.markerSymbol === "none" &&
        out.markerSizePt === undefined &&
        out.markerFill === undefined &&
        out.markerStrokeColor === undefined &&
        out.markerStrokeWidthEmu === undefined
      )
        delete out.markerSymbol;
      if (scatter && out.smooth === smooth) delete out.smooth;
      return out as ChartSeries;
    }),
  };
};
