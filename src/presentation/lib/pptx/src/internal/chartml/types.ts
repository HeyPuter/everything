// Chart authoring types.
//
// One or more named series of numeric values plotted against shared
// string categories (bar / column / line / pie / doughnut / area), plus
// the xy(z)-tuple kinds (scatter / radar / bubble) the reader and preview
// model. Authoring is supported for the category kinds only; the xy(z)
// kinds are read + render only (see `chart-builder.ts`).

/**
 * Chart type tokens. `bar` / `column` / `line` / `pie` / `doughnut` /
 * `area` are authorable; `scatter` / `radar` / `bubble` are read +
 * render only — the builder rejects them (see `buildChartSpaceDoc`).
 */
export type ChartKind =
  | "bar"
  | "column"
  | "line"
  | "pie"
  | "doughnut"
  | "area"
  | "scatter"
  | "radar"
  | "bubble";

/** An axis crosses its perpendicular axis automatically, at an extreme, or at a value. */
export type ChartAxisCrossing = "autoZero" | "min" | "max" | { at: number };

/** Native tick-label placement, independent of the axis line and tick marks. */
export type ChartAxisTickLabelPosition = "none" | "low" | "high" | "nextTo";

/** One labelled series of numeric values. */
export interface ChartSeries {
  /** Series label rendered in the legend. */
  readonly name: string;
  /**
   * Finite numeric values, one per category. Authoring rejects NaN and
   * infinities before changing the presentation. `null` slots become empty
   * cells in the embedded workbook, drawn according to `dispBlanksAs`.
   * Each series retains its own length: categories beyond that extent do
   * not become blank points. Values beyond the category count are retained,
   * including unlabelled series.
   *
   * For `scatter` / `bubble` kinds there are no categories: `values`
   * holds the series' y-channel (`<c:yVal>`), paired positionally with
   * `xValues`. For `radar` it behaves like `line` (values per category).
   */
  readonly values: ReadonlyArray<number | null>;
  /** Number format of the cached values and their embedded workbook cells. */
  readonly numberFormat?: string;
  /** Cached X-channel number format, for imported read-only XY charts. */
  readonly xNumberFormat?: string;
  /** Cached size-channel number format, for imported read-only bubble charts. */
  readonly bubbleSizeNumberFormat?: string;
  /**
   * X-channel values for `scatter` / `bubble` series (`<c:xVal>`), paired
   * positionally with `values`. Absent for every other kind, where
   * `values` is plotted against the shared `categories`.
   */
  readonly xValues?: ReadonlyArray<number | null>;
  /**
   * Per-point bubble sizes for `bubble` series (`<c:bubbleSize>`), paired
   * positionally with `xValues` / `values`. The renderer scales each
   * bubble's area (or width, per `ChartSpec.bubbleSizeRepresents`) to
   * this magnitude. Absent for non-bubble kinds.
   */
  readonly bubbleSizes?: ReadonlyArray<number | null>;
  /** Optional `#RRGGBB` fill override. Defaults to the theme's accent palette. */
  readonly color?: string;
  /** Outline paint, independent of the fill; `null` authors native a:ln/a:noFill. */
  readonly lineColor?: string | null;
  /**
   * Per-series chart-kind override for combo charts (e.g. a `line`
   * series overlaid on a `column` chart). Series sharing an effective
   * kind are grouped into one plot group (`<c:barChart>` /
   * `<c:lineChart>` / `<c:areaChart>`); the groups share the category
   * axis. Only the category kinds can mix — `bar` / `column` / `line` /
   * `area`. Absent = plotted with the chart's own `kind`.
   */
  readonly chartKind?: "bar" | "column" | "line" | "area";
  /**
   * Plot this series against the secondary value axis — the right-hand
   * axis used by combo charts with mixed units
   * (`<c:valAx>` pair with `axPos="r"` plus a deleted companion
   * `<c:catAx>`). The builder emits the secondary axis pair on demand.
   * Only meaningful for the category kinds; rejected for pie / doughnut.
   */
  readonly secondaryAxis?: boolean;
  /**
   * Optional line stroke width in EMU (`<c:ser><c:spPr><a:ln w="…"/>`).
   * Applies to the series outline. Zero remains distinct from omission,
   * which falls back to the renderer's default for the chart kind.
   */
  readonly lineWidthEmu?: number;
  /**
   * Optional line dash style token (`<c:ser><c:spPr><a:ln><a:prstDash
   * val="…"/>`), e.g. `'dash'`, `'dot'`, `'sysDash'`. Only
   * meaningful for a visible series outline.
   */
  readonly lineDash?: string;
  /**
   * Optional marker style for line / scatter / radar series (`<c:ser><c:marker>`).
   * `none` hides the markers; the others render the matching glyph at
   * each data point. Line series default to `auto`, using the automatic
   * symbol rotation in their plotted group's series order.
   */
  readonly markerSymbol?:
    | "none"
    | "auto"
    | "circle"
    | "square"
    | "diamond"
    | "triangle"
    | "star"
    | "x"
    | "plus"
    | "dash"
    | "dot"
    | "picture";
  /**
   * Authored marker size in points, an integer from 2 to 72
   * (`<c:marker><c:size val="N"/>`). Omission uses chart-style defaults.
   */
  readonly markerSizePt?: number;
  /** Marker fill (`c:marker/c:spPr`), independent of the series fill/line.
   * Null means explicit noFill; omission inherits the chart style. */
  readonly markerFill?: string | null;
  /** Marker outline paint. Null means noFill; omission inherits its style. */
  readonly markerStrokeColor?: string | null;
  /** Marker outline width in EMU. Zero remains distinct from omission. */
  readonly markerStrokeWidthEmu?: number;
  /**
   * Invert bars below the category-axis crossing (bar / column charts).
   * Mirrors `<c:ser><c:invertIfNegative val="0|1"/>`. Explicit false is
   * retained separately from omission, which is treated as enabled.
   */
  readonly invertIfNegative?: boolean;
  /** Solid inverted bar fill (`c14:invertSolidFillFmt`). Omission uses white.
   * Independent of the ordinary series fill and its outline. */
  readonly negativeColor?: string;
  /** Sparse per-point inversion switches (`c:dPt/c:invertIfNegative`).
   * A native dPt with no switch defaults to enabled. Points without a dPt
   * inherit the series setting; absent defaults remain unrepresented here. */
  readonly pointInvertIfNegative?: ReadonlyArray<boolean | null>;
  /**
   * Optional per-data-point color overrides, indexed by point index
   * (`<c:dPt><c:idx val="N"/><c:spPr><a:solidFill>…`). Sparse — only
   * the indices that author an override appear. Pie / doughnut decks
   * almost always emit one of these per slice to break out of the
   * single-series-color default.
   */
  readonly pointColors?: ReadonlyArray<string | null>;
  /**
   * Optional per-data-point pie/doughnut slice explosion percentages
   * (`<c:dPt><c:explosion val="N"/>`). Sparse — only the indices that
   * author an explosion appear. The value is the radial offset as a
   * percentage of the slice radius (`25` ≈ a quarter-radius pull-out).
   */
  readonly pointExplosions?: ReadonlyArray<number | null>;
  /**
   * Line-smoothing toggle (`<c:smooth val="1"/>`) — only meaningful for
   * line / scatter / area series. When `true`, the renderer interpolates
   * a smooth curve through the data points instead of straight segments.
   */
  readonly smooth?: boolean;
  /**
   * Optional trendline overlay. ECMA-376 §21.2.2.211 allows several
   * regression types; we surface the most common subset. The line is
   * painted on top of the series in the renderer.
   */
  readonly trendline?: ChartTrendline;
  /**
   * Per-series data-label toggle overrides. Same shape as the chart-level
   * `ChartSpec.dataLabels`; overrides win when present. Read from
   * `<c:ser><c:dLbls>`.
   */
  readonly dataLabels?: ChartDataLabels;
  /**
   * Error bars (`<c:errBars>`) drawn around each data point. Bar, column,
   * line, area, scatter and bubble series carry them; pie, doughnut and
   * radar series have no slot and reject them.
   */
  readonly errorBars?: ChartErrorBars;
}

/**
 * Error bars for one series (`<c:errBars>`, ECMA-376 §21.2.2.58).
 *
 *   - `direction` — `'y'` (the default) measures along the value axis;
 *     `'x'` is only meaningful for scatter / bubble series.
 *   - `type` — draw the bar above and below (`'both'`), only above
 *     (`'plus'`) or only below (`'minus'`) the point.
 *   - `valueType` — the amount is a fixed value (`'fixedVal'`), a
 *     percentage of each point (`'percentage'`), a multiple of the
 *     series' standard deviation (`'stdDev'`), or its standard error
 *     (`'stdErr'`, which takes no `value`).
 *   - `value` — the amount for `fixedVal` / `percentage` / `stdDev`;
 *     defaults to 1 for fixed values and standard deviations and 5 for
 *     percentages.
 *   - `noEndCap` — omit the short perpendicular caps.
 *   - `color` — `#RRGGBB` line color (otherwise the text color).
 */
export interface ChartErrorBars {
  readonly direction?: "x" | "y";
  readonly type: "both" | "plus" | "minus";
  readonly valueType: "fixedVal" | "percentage" | "stdDev" | "stdErr";
  readonly value?: number;
  readonly noEndCap?: boolean;
  readonly color?: string;
}

/**
 * A data table under the plot area (`<c:dTable>`, ECMA-376 §21.2.2.54):
 * one row per series and one column per category. Each flag mirrors its
 * native element and defaults to `false` when omitted.
 */
export interface ChartDataTable {
  /** Rules between the series rows. */
  readonly showHorzBorder?: boolean;
  /** Rules between the category columns. */
  readonly showVertBorder?: boolean;
  /** A frame around the table. */
  readonly showOutline?: boolean;
  /** A legend key beside each series name. */
  readonly showKeys?: boolean;
}

/** A single trendline overlay for a series. */
export interface ChartTrendline {
  /**
   * Optional custom label for the trendline (`<c:trendline><c:name>…`).
   * Defaults to the auto-generated label
   * (e.g. "Linear (X)" / "MA(5) (X)") when omitted.
   */
  readonly name?: string;
  /** Regression type — linear / exp / log / poly / power / movingAvg. */
  readonly type: "linear" | "exp" | "log" | "poly" | "power" | "movingAvg";
  /**
   * Forward extension (`<c:forward val="N"/>`) — the trendline runs N
   * data-point periods past the last point. Used to project future
   * values from the regression line.
   */
  readonly forward?: number;
  /**
   * Backward extension (`<c:backward val="N"/>`) — the trendline runs N
   * data-point periods before the first point.
   */
  readonly backward?: number;
  /** Optional moving-average period (only meaningful for type='movingAvg'). */
  readonly period?: number;
  /** Polynomial order (only meaningful for type='poly'). */
  readonly order?: number;
  /** Override stroke color; defaults to the series color. */
  readonly color?: string;
  /**
   * Show the regression equation next to the trendline
   * (`<c:dispEq val="1"/>`). Defaults to `false`.
   */
  readonly displayEquation?: boolean;
  /**
   * Show the R² coefficient next to the trendline
   * (`<c:dispRSqr val="1"/>`). Defaults to `false`.
   */
  readonly displayRSquared?: boolean;
}

/**
 * Per-series data-label toggles read from `<c:dLbls>` (ECMA-376
 * §21.2.2.55). All four toggles default to `false` — renderers paint
 * labels only when the corresponding flag is `true`.
 */
/**
 * `<c:dLblPos val="…"/>` — where the data label sits relative to its
 * data point. The context restrictions in MS-OI29500 §2.1.1456 narrow
 * ST_DLblPos for per-series labels:
 *
 *   - bar / column: `'ctr' | 'inEnd' | 'outEnd' | 'inBase'`
 *   - stacked / percent-stacked bar / column omit `'outEnd'`
 *   - line / scatter / bubble: `'ctr' | 't' | 'b' | 'l' | 'r'`
 *   - pie: `'ctr' | 'inEnd' | 'outEnd' | 'bestFit'`
 *
 * The native reference enforces the same restrictions for group-level labels.
 * Area, doughnut and radar charts require omission at both scopes, including for their
 * automatic positions. Authoring rejects incompatible positions atomically;
 * imported native XML remains unchanged through untouched saves.
 */
export type ChartDataLabelPosition =
  "ctr" | "inEnd" | "outEnd" | "inBase" | "t" | "b" | "l" | "r" | "bestFit";

export interface ChartDataLabels {
  // `ChartSpec` is bidirectional (authored into `addSlideChart`, read back from
  // `getShapeChartSpec`), and the reader always emits all four toggles, so they
  // are required: a sparse `{ showValue: true }` would widen what every reader
  // gets. Set the ones you want on and the rest to `false`.
  /** Numeric value of each data point. */
  readonly showValue: boolean;
  /** Category label of each data point. */
  readonly showCategory: boolean;
  /** Series name on each data point. */
  readonly showSeriesName: boolean;
  /** Percentage of total (for pie / doughnut). */
  readonly showPercent: boolean;
  /**
   * Number-format code from `<c:dLbls><c:numFmt formatCode="…"/>`. When
   * set, value labels are projected through this SpreadsheetML format
   * (same subset the value axis honors: `"0%"`, `"#,##0"`, `"$#,##0"`,
   * `"0.00"`). Independent of `ChartAxisScaling.numberFormat`.
   */
  readonly numberFormat?: string;
  /** Link value-label formatting to each series' source cells. */
  readonly numberFormatSourceLinked?: boolean;
  /**
   * Position of the label relative to its data point — from
   * `<c:dLbls><c:dLblPos val="…"/>`.
   * Omission retains the native automatic position: line labels use Right,
   * and area labels center within their series' band. Rendering does not
   * materialize those defaults in the model or exported XML.
   */
  readonly position?: ChartDataLabelPosition;
  /**
   * Separator between concatenated label parts when more than one of
   * `showValue` / `showCategory` / `showSeriesName` / `showPercent` is
   * set. Read from `<c:dLbls><c:separator>…</c:separator>` (a
   * leaf-text-only element). Common values: `" "` (default), `", "`,
   * `"\n"`, `"; "`.
   */
  readonly separator?: string;
  /**
   * Default-run text style for the labels — projected from
   * `<c:dLbls><c:txPr>…<a:defRPr/>…</c:txPr>`. Applies to whichever
   * label parts are turned on by the `show*` toggles. Independent of
   * the chart-title style and the axis-label style.
   */
  readonly textStyle?: ChartTextStyle;
}

/**
 * Authored value-axis scaling (`<c:valAx><c:scaling><c:min/>/<c:max/></c:scaling>`)
 * plus tick-spacing hints. When omitted, renderers compute the range
 * and tick spacing from the series values.
 */
export interface ChartAxisScaling {
  readonly min?: number;
  readonly max?: number;
  /** Major tick spacing (`<c:majorUnit val="N"/>`). */
  readonly majorUnit?: number;
  /** Minor tick spacing (`<c:minorUnit val="N"/>`). */
  readonly minorUnit?: number;
  /**
   * Number-format code from `<c:numFmt formatCode="…"/>`. Common
   * values: `"0%"`, `"0.0%"`, `"#,##0"`, `"$#,##0"`, `"yyyy-mm-dd"`.
   * Renderers project a subset of SpreadsheetML formats to label text.
   */
  readonly numberFormat?: string;
  /** Native c:numFmt@sourceLinked; omitted authored formats remain unlinked. */
  readonly numberFormatSourceLinked?: boolean;
  /** Resolved cached format of this axis' first referenced source series. */
  readonly sourceNumberFormat?: string;
  /**
   * Logarithmic base for the axis from `<c:scaling><c:logBase val="N"/>`.
   * Typical values are `2`, `10`, `Math.E`. When set, the renderer
   * projects values through `Math.log(v) / Math.log(logBase)` before
   * mapping to plot coordinates. Linear when omitted.
   */
  readonly logBase?: number;
  /**
   * Authored display-units scale from `<c:dispUnits><c:builtInUnit val="…"/>`.
   * Token values map to divisors:
   *
   *   - `'hundreds'` (100), `'thousands'` (1e3), `'tenThousands'` (1e4),
   *     `'hundredThousands'` (1e5), `'millions'` (1e6),
   *     `'tenMillions'` (1e7), `'hundredMillions'` (1e8),
   *     `'billions'` (1e9), `'trillions'` (1e12)
   *
   * Renderers divide axis labels by the divisor and may append a unit
   * suffix ("K", "M", "B") for readability.
   */
  readonly displayUnits?:
    | "hundreds"
    | "thousands"
    | "tenThousands"
    | "hundredThousands"
    | "millions"
    | "tenMillions"
    | "hundredMillions"
    | "billions"
    | "trillions";
}

/**
 * Bar / column grouping per ECMA-376 §21.2.2.76 (`ST_BarGrouping`):
 *
 *   - `clustered` — bars within a category sit side-by-side (the default).
 *   - `stacked` — series values sit on top of each other; the y-axis spans
 *     0..max(sum of each category).
 *   - `percentStacked` — series values normalize to 100% per category.
 *   - `standard` — only meaningful for the 3D variants; renderers treat
 *     it as `clustered`.
 */
export type ChartGrouping =
  "clustered" | "stacked" | "percentStacked" | "standard";

/**
 * Authored text style for a chart label (title / axis title / etc.).
 * Read from the label's first `<a:rPr>` (and `<a:defRPr>` as fallback).
 * All fields are optional — absent fields mean "fall back to the
 * renderer's default for this label position."
 */
export interface ChartTextStyle {
  /**
   * Font face applied to both the latin and east-asian typeface slots —
   * `<a:rPr><a:latin typeface="…"/><a:ea typeface="…"/>`. East-asian is
   * set alongside latin so a Japanese / CJK family (e.g. `'Yu Gothic'`)
   * renders the labels instead of the renderer's latin-only fallback.
   * Uses the latin/ea pairing found in native output for CJK chart fonts.
   */
  readonly font?: string;
  /** Font size in points. From `<a:rPr sz="N"/>` where N is in 100ths of a pt. */
  readonly sizePt?: number;
  /** Bold flag from `<a:rPr b="1"/>`. */
  readonly bold?: boolean;
  /** Italic flag from `<a:rPr i="1"/>`. */
  readonly italic?: boolean;
  /** Fill color as `#RRGGBB` from `<a:rPr><a:solidFill><a:srgbClr/></a:solidFill>`. */
  readonly color?: string;
}

/** Full chart specification. */
export interface ChartSpec {
  readonly kind: ChartKind;
  /** Category labels along the x-axis (or pie slice labels for `kind: 'pie'`). May be empty or shorter than series values. */
  readonly categories: ReadonlyArray<string>;
  /** Numeric category cache/workbook format; presence authors numeric categories. */
  readonly categoryNumberFormat?: string;
  readonly series: ReadonlyArray<ChartSeries>;
  /** Optional chart title rendered above the plot area. */
  readonly title?: string;
  /** Optional font / color overrides for the chart title. */
  readonly titleStyle?: ChartTextStyle;
  /** Default chart text properties from `<c:chartSpace><c:txPr>`. Local styles override individual fields. */
  readonly textStyle?: ChartTextStyle;
  /** Optional chart-level data-label toggles. */
  readonly dataLabels?: ChartDataLabels;
  /** Optional value-axis scaling override (min / max). */
  readonly valueAxis?: ChartAxisScaling;
  /** Plot-area solid color. `null` authors native `a:noFill`; omitted or
   * unsupported paint is `undefined` and retains the inherited/default paint. */
  readonly plotAreaFill?: string | null;
  /** Plot-area outline color; `null` explicitly authors an `a:ln/a:noFill`. */
  readonly plotAreaStrokeColor?: string | null;
  /** Authored plot-area outline width in EMU (`<c:plotArea><c:spPr><a:ln w>`). */
  readonly plotAreaStrokeWidthEmu?: number;
  /** Chart-area solid color. `null` means native `a:noFill` (transparent);
   * `undefined` retains the inherited/default chart background. */
  readonly chartAreaFill?: string | null;
  /** Chart-area outline color; `null` explicitly authors an `a:ln/a:noFill`. */
  readonly chartAreaStrokeColor?: string | null;
  /** Authored chart-area outline width in EMU (`<c:chartSpace><c:spPr><a:ln w>`). */
  readonly chartAreaStrokeWidthEmu?: number;
  /** Optional axis title text (`<c:catAx><c:title>` / `<c:valAx><c:title>`). */
  readonly categoryAxisTitle?: string;
  /** Authored font / color on the category-axis title (same `<a:rPr>` shape as `titleStyle`). */
  readonly categoryAxisTitleStyle?: ChartTextStyle;
  /**
   * Rotation of the category-axis title, in degrees clockwise. Maps
   * to `<c:catAx><c:title><c:tx><c:rich><a:bodyPr rot="N"/>` (the OOXML
   * value is in 60000ths of a degree, but the API surface uses plain
   * degrees). Omit to inherit the default (`0`).
   */
  readonly categoryAxisTitleRotationDeg?: number;
  /** Authored font / color on the category-axis *tick labels* — `<c:catAx><c:txPr>`. */
  readonly categoryAxisLabelStyle?: ChartTextStyle;
  /**
   * Authored rotation on the category-axis tick labels, in degrees. From
   * `<c:catAx><c:txPr><a:bodyPr rot="N"/>` where N is in 60000ths of a
   * degree. Positive values rotate clockwise (DrawingML convention),
   * matching the SVG `transform=rotate()` sense. `null` preserves native
   * automatic orientation, resolved from label extents by the renderer.
   * `undefined` retains native omission and also uses automatic preview layout.
   */
  readonly categoryAxisLabelRotationDeg?: number | null;
  readonly valueAxisTitle?: string;
  /** Authored font / color on the value-axis title. */
  readonly valueAxisTitleStyle?: ChartTextStyle;
  /**
   * Rotation of the value-axis title, in degrees clockwise. Native files
   * often carry `-90` (or `vert270`) so the title reads bottom-to-top
   * alongside the axis. Maps to `<c:valAx><c:title><c:tx><c:rich>
   * <a:bodyPr rot="N"/>` (60000ths of a degree on the wire).
   */
  readonly valueAxisTitleRotationDeg?: number;
  /** Authored font / color on the value-axis *tick labels* — `<c:valAx><c:txPr>`. */
  readonly valueAxisLabelStyle?: ChartTextStyle;
  /**
   * Authored rotation on the value-axis tick labels, in degrees. From
   * `<c:valAx><c:txPr><a:bodyPr rot="N"/>` (N in 60000ths of a degree).
   * Same sense as `categoryAxisLabelRotationDeg`; `null` is native automatic
   * orientation rather than an authored numeric angle. `undefined` retains
   * native omission and uses automatic preview layout.
   */
  readonly valueAxisLabelRotationDeg?: number | null;
  /** When `true`, value axis is hidden (`<c:valAx><c:delete val="1"/>`). */
  readonly valueAxisHidden?: boolean;
  /** When `true`, category axis is hidden (`<c:catAx><c:delete val="1"/>`). */
  readonly categoryAxisHidden?: boolean;
  /** When the value-axis emits `<c:majorGridlines/>` — its gridlines are visible. */
  readonly valueAxisMajorGridlines?: boolean;
  /**
   * Major-tick mark mode on the value axis (`<c:valAx><c:majorTickMark val="…"/>`).
   * Omission remains undefined in the model and renders as `cross`:
   *
   *   - `'out'` — outside the plot edge
   *   - `'in'` — inside the plot
   *   - `'cross'` — across the axis line
   *   - `'none'` — no tick marks
   */
  readonly valueAxisMajorTickMark?: "in" | "out" | "cross" | "none";
  /**
   * Major-tick mark mode on the category axis (`<c:catAx><c:majorTickMark>`).
   * A present element without val reads as `cross` (CT_TickMark default);
   * an omitted element remains undefined and renders as `cross`.
   */
  readonly categoryAxisMajorTickMark?: "in" | "out" | "cross" | "none";
  /** Minor-tick mode on the value axis; omitted declarations render as `cross`. */
  readonly valueAxisMinorTickMark?: "in" | "out" | "cross" | "none";
  /** Minor-tick mode on the category axis; omitted declarations render as `cross`. */
  readonly categoryAxisMinorTickMark?: "in" | "out" | "cross" | "none";
  /**
   * Authored color on the value-axis major gridlines — `<c:valAx>
   * <c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="…"/>`.
   * Returned as `#RRGGBB`. `undefined` falls back to the renderer's
   * default (a light gray); `null` represents explicit `<a:noFill/>`.
   */
  readonly valueAxisMajorGridlineColor?: string | null;
  /** Companion authored color on the value-axis minor gridlines. */
  readonly valueAxisMinorGridlineColor?: string | null;
  /** Authored color on the category-axis major gridlines (same shape as `valueAxisMajorGridlineColor`). */
  readonly categoryAxisMajorGridlineColor?: string | null;
  /** Authored color on the category-axis minor gridlines. */
  readonly categoryAxisMinorGridlineColor?: string | null;
  /**
   * Authored color on the value-axis line itself — `<c:valAx><c:spPr>
   * <a:ln><a:solidFill><a:srgbClr val="…"/>`. Returned as `#RRGGBB`.
   * `undefined` falls back to the renderer's default axis stroke; `null`
   * represents explicit `<a:noFill/>` on the line.
   */
  readonly valueAxisLineColor?: string | null;
  /** Authored color on the category-axis line (same shape as `valueAxisLineColor`). */
  readonly categoryAxisLineColor?: string | null;
  /** Axis-line widths in EMU; explicit zero is retained, omission inherits defaults. */
  readonly valueAxisLineWidthEmu?: number;
  readonly categoryAxisLineWidthEmu?: number;
  /** Independent secondary axis line paint, including explicit noFill (`null`). */
  readonly secondaryValueAxisLineColor?: string | null;
  readonly secondaryCategoryAxisLineColor?: string | null;
  readonly secondaryValueAxisLineWidthEmu?: number;
  readonly secondaryCategoryAxisLineWidthEmu?: number;
  /** Authored gridline widths in EMU (`<c:majorGridlines|minorGridlines><c:spPr><a:ln w>`). */
  readonly valueAxisMajorGridlineWidthEmu?: number;
  readonly valueAxisMinorGridlineWidthEmu?: number;
  readonly categoryAxisMajorGridlineWidthEmu?: number;
  readonly categoryAxisMinorGridlineWidthEmu?: number;
  /** When the value-axis emits `<c:minorGridlines/>` — minor gridlines are visible. */
  readonly valueAxisMinorGridlines?: boolean;
  /**
   * Whether the category axis emits `<c:majorGridlines/>`. Sounds odd
   * for column charts (where category gridlines are vertical, between
   * categories) but bar charts put the cat axis on the vertical edge
   * and use these as horizontal guide lines per category band.
   */
  readonly categoryAxisMajorGridlines?: boolean;
  /** Companion `<c:minorGridlines/>` on the category axis. */
  readonly categoryAxisMinorGridlines?: boolean;
  /**
   * Category-axis tick label skip step (`<c:catAx><c:tickLblSkip val="N"/>`):
   * render every Nth category label. Commonly 2 / 5 / 10 on dense
   * time-series charts to keep labels from overlapping. Authored values
   * must be integers from 1 to 4294967295 (OOXML ST_Skip).
   */
  readonly categoryAxisTickLabelSkip?: number;
  /**
   * Category-axis tick *mark* skip (`<c:catAx><c:tickMarkSkip val="N"/>`):
   * draw every Nth tick mark independently of the label-skip stride.
   * Useful when you want fewer label collisions but the same dense
   * tick lattice; defaults to 1 (every tick). Authored values must be
   * integers from 1 to 4294967295 (OOXML ST_Skip).
   */
  readonly categoryAxisTickMarkSkip?: number;
  /**
   * Tick-label position on the primary category axis (the X axis of native
   * XY charts). `none` hides labels while retaining the axis and tick marks;
   * `low` / `high` select the low / high end of the perpendicular axis,
   * respecting its direction; `nextTo` places labels next to the crossing.
   * Omission retains native automatic behavior, separately from explicit nextTo.
   */
  readonly categoryAxisTickLabelPos?: ChartAxisTickLabelPosition;
  /** Same setting on the primary value axis (the Y axis of native XY charts). */
  readonly valueAxisTickLabelPos?: ChartAxisTickLabelPosition;
  /** Independent label position on the secondary category / X axis. */
  readonly secondaryCategoryAxisTickLabelPos?: ChartAxisTickLabelPosition;
  /** Independent label position on the secondary value / Y axis. */
  readonly secondaryValueAxisTickLabelPos?: ChartAxisTickLabelPosition;
  /**
   * Category-label distance as a percentage —
   * `<c:catAx><c:lblOffset val="N"/>` where N is
   * 0..1000 (default 100). Larger values push category labels further
   * from the axis. ECMA-376 §21.2.2.91 does not define the percentage's
   * physical basis; it must not be interpreted as a percentage of font size.
   */
  readonly categoryAxisLabelOffset?: number;
  /**
   * Multi-line category-label alignment relative to the tick mark —
   * `<c:catAx><c:lblAlgn val="ctr|l|r"/>`. Defaults to
   * `ctr` when omitted; the authored value wins.
   */
  readonly categoryAxisLabelAlign?: "ctr" | "l" | "r";
  /**
   * Number-format code for the category-axis tick labels —
   * `<c:catAx><c:numFmt formatCode="…"/>`. Most useful on date-style
   * categories (`"mm/dd/yyyy"`, `"mmm"`, etc.) but accepts any SpreadsheetML
   * format string. Independent of `valueAxis.numberFormat` (which
   * targets the value axis).
   */
  readonly categoryAxisNumberFormat?: string;
  readonly categoryAxisNumberFormatSourceLinked?: boolean;
  /** Cached numeric category/X format resolved through this axis' references. */
  readonly categoryAxisSourceNumberFormat?: string;
  readonly secondaryValueAxisNumberFormat?: string;
  readonly secondaryValueAxisNumberFormatSourceLinked?: boolean;
  readonly secondaryValueAxisSourceNumberFormat?: string;
  readonly secondaryCategoryAxisNumberFormat?: string;
  readonly secondaryCategoryAxisNumberFormatSourceLinked?: boolean;
  readonly secondaryCategoryAxisSourceNumberFormat?: string;
  /**
   * Toggle multi-level (hierarchical) category labels —
   * `<c:catAx><c:noMultiLvlLbl val="0|1"/>`. Explicit false permits
   * multi-level labels to stack. Set to `true` to flatten
   * hierarchical categories into a single row.
   */
  readonly categoryAxisNoMultiLevelLabel?: boolean;
  /**
   * Category-axis order — `'minMax'` (the data's natural order) or
   * `'maxMin'` (reversed). For bar charts native files typically carry
   * `maxMin` so the first category sits at the top instead of the
   * bottom; honour the authored value when present.
   */
  readonly categoryAxisOrientation?: "minMax" | "maxMin";
  /**
   * Category order for the independent secondary axis pair used by combo
   * series with `secondaryAxis: true`. Omitted means that axis's own
   * `minMax` default, independently of the primary category orientation.
   */
  readonly secondaryCategoryAxisOrientation?: "minMax" | "maxMin";
  /** Same for the value axis. */
  readonly valueAxisOrientation?: "minMax" | "maxMin";
  /** Direction of the independent secondary value axis in combo charts. */
  readonly secondaryValueAxisOrientation?: "minMax" | "maxMin";
  /**
   * Where the value axis crosses the category axis. Maps to crosses or
   * crossesAt on c:valAx. The setting is interpreted on the perpendicular
   * axis (MS-OE376 2.1.1464). In category charts numeric values are 1-based
   * category numbers; native XY charts use the other numeric axis's scale.
   * For categories, autoZero/min select the first boundary and max the last.
   * This is independent of categoryAxisCrosses and both axis directions.
   */
  readonly valueAxisCrosses?: ChartAxisCrossing;
  /**
   * Where the category axis crosses the value axis. Maps to crosses or
   * crossesAt on c:catAx (or the native date axis), independently of valAx.
   * Numeric values use the value scale. autoZero selects zero when in range,
   * otherwise its nearer extreme. Omission retains native automatic behavior.
   */
  readonly categoryAxisCrosses?: ChartAxisCrossing;
  /**
   * Crossing on the independent secondary value axis in combo charts. New
   * secondary pairs default to max; native omission is retained during edits.
   */
  readonly secondaryValueAxisCrosses?: ChartAxisCrossing;
  /** Crossing on the independent secondary category axis in combo charts. */
  readonly secondaryCategoryAxisCrosses?: ChartAxisCrossing;
  /**
   * Whether categories occupy bands (`between`) or lie on the plot's
   * endpoints (`midCat`). Maps to `<c:valAx><c:crossBetween>` on the
   * crossing value axis. Omitted behavior is application-defined; the
   * preview uses bands for bar/column/line and endpoints for area.
   */
  readonly valueAxisCrossBetween?: "between" | "midCat";
  /** Category spacing for the independent secondary axis pair in combos. */
  readonly secondaryValueAxisCrossBetween?: "between" | "midCat";
  /**
   * When `false`, plot data from hidden cells in the embedded workbook
   * — maps to `<c:plotVisOnly val="0"/>`. The default is
   * `true` (only plot visible cells), so omitting this field emits
   * `val="1"` to stay round-trip-safe with existing .pptx files.
   */
  readonly plotVisibleCellsOnly?: boolean;
  /**
   * Renders the chart area with rounded corners
   * (`<c:chartSpace><c:roundedCorners val="0|1"/>`). Explicit true/false
   * are retained separately from native omission.
   */
  readonly roundedCorners?: boolean;
  /**
   * Built-in chart-style preset
   * (`<c:chartSpace><c:style val="N"/>`), 1–48. Encodes a curated combo
   * of theme accent colors, gradients, effects, and font sizes identified
   * by a preset number. Surfaced for round-trip fidelity; renderers in
   * @office-kit/pptx don't (yet) interpret it.
   */
  readonly chartStyle?: number;
  /**
   * c14 (2010 extension) preset variant. The same 1–48 chartStyle ID is serialized as
   * c14:style (ID + 100), with its required matching legacy fallback. Omission
   * selects the legacy variant for new charts. Native style identity is retained through edits;
   * preview does not yet implement either preset's complete appearance.
   */
  readonly chartStyleVariant?: "office2010";
  /**
   * Language code for the chart's number / date formatters
   * (`<c:chartSpace><c:lang val="…"/>`). Authoring apps write the user's
   * UI language (e.g. `'en-US'`, `'ja-JP'`). Carried for
   * round-trip fidelity; renderers in @office-kit/pptx don't act on it yet.
   */
  readonly language?: string;
  /**
   * `<c:chartSpace><c:date1904 val="…"/>` — the workbook date-system flag.
   * `false` (the default) uses the 1900-epoch; `true` uses 1904.
   * Surfaced for round-trip fidelity; renderers don't act on it yet.
   */
  readonly date1904?: boolean;
  /** Bar / column / area grouping mode. Absent for line / pie. */
  readonly grouping?: ChartGrouping;
  /**
   * Drop lines (`<c:dropLines>`) — vertical guide lines from each data
   * point down to the value axis. Common on line / area charts.
   */
  readonly dropLines?: boolean;
  /**
   * High-low lines (`<c:hiLowLines>`) — vertical lines spanning the
   * highest and lowest series value at each category. Used by stock
   * charts and side-by-side line charts.
   */
  readonly hiLowLines?: boolean;
  /**
   * Up/down bars (`<c:upDownBars>`) on a line chart: between the first
   * and last series at each category, light where the last series is
   * higher and dark where it is lower.
   */
  readonly upDownBars?: boolean;
  /**
   * Data table under the plot area (`<c:dTable>`). Absent means no table.
   * Only charts with axes (not pie / doughnut / radar) show one.
   */
  readonly dataTable?: ChartDataTable;
  /**
   * Native chart-level Show Marker flag (`<c:lineChart><c:marker
   * val="0|1"/>`). Retained for interoperability; readers ignore this
   * flag (MS-OE376 §2.1.1517). To hide line markers, set each series'
   * `markerSymbol` to `none`. Omission preserves the absent element.
   */
  readonly lineMarkers?: boolean;
  /**
   * Gap between adjacent bar groups in `<c:gapWidth val="N"/>` units
   * (0..500, percent of bar width). Default 150 (= 1.5×).
   */
  readonly gapWidthPct?: number;
  /**
   * Overlap of adjacent bars within a category in `<c:overlap val="N"/>`
   * percent (-100..100). Negative pulls bars apart, positive overlaps.
   * Defaults to 0 (clustered) / 100 (stacked).
   */
  readonly overlapPct?: number;
  /**
   * Optional legend configuration. `position` mirrors
   * `<c:legend><c:legendPos val="…"/>` — `'r'` (right) is the default,
   * `'t'`, `'b'`, `'l'`, `'tr'` (top-right) the other tokens. `null`
   * for `position` means no legend at all (the chart explicitly hides
   * it). `undefined` overall means the chart didn't author a legend
   * element — renderers should fall back to their own default.
   */
  readonly legend?: {
    position: "r" | "t" | "b" | "l" | "tr" | null;
    /** When `true`, legend overlays the plot area instead of taking a strip. */
    readonly overlay?: boolean;
    /** Legend background paint; null authors native a:noFill. */
    readonly fill?: string | null;
    /** Legend outline paint, independent of its keys; null authors a:ln/a:noFill. */
    readonly strokeColor?: string | null;
    /** Legend outline width in EMU; zero remains distinct from omission. */
    readonly strokeWidthEmu?: number;
    /**
     * Authored font / color on the legend's text. From `<c:legend><c:txPr>`'s
     * first `<a:p><a:pPr><a:defRPr>` (or `<a:r><a:rPr>` as fallback). Same
     * shape as `titleStyle`.
     */
    readonly textStyle?: ChartTextStyle;
    /**
     * Native legend-entry indices hidden via `<c:legend><c:legendEntry>
     * <c:idx val="N"/><c:delete val="1"/></c:legendEntry>`. These address
     * positions in the automatic legend order, which can differ from the
     * series array. Filtering an entry does not remove its plotted data.
     * Common use: keep a trendline series in the data but drop its
     * legend entry.
     */
    readonly hiddenIndices?: ReadonlyArray<number>;
  };
  /** When `true`, the chart title overlays the plot area instead of taking a strip. */
  readonly titleOverlay?: boolean;
  /**
   * `<c:barChart><c:varyColors val="1"/>` etc. — when `true` and the
   * chart has a single series, each data point gets a distinct color
   * from the palette. Pie / doughnut already vary colors implicitly;
   * this flag is most useful for single-series bar / column.
   */
  readonly varyColors?: boolean;
  /**
   * `<c:dispBlanksAs val="…"/>` — how line / area renderers should
   * treat `null` values in series:
   *
   *   - `'gap'`  — leave a gap (the default)
   *   - `'zero'` — substitute zero
   *   - `'span'` — connect the surrounding points across the gap
   */
  readonly dispBlanksAs?: "gap" | "zero" | "span";
  /**
   * `<c:showDLblsOverMax>` — false suppresses a data label whose plotted
   * value exceeds its value-axis maximum. True allows such labels. Applies
   * to 2D Cartesian charts; pie/doughnut have no value axis. Omission leaves
   * labels unrestricted by this option.
   */
  readonly showDataLabelsOverMaximum?: boolean;
  /**
   * Pie / doughnut: angle (in degrees, 0–360) at which the first slice
   * starts, measured clockwise from 12 o'clock. Mirrors
   * `<c:firstSliceAng val="…"/>`. Default 0 = start at the top.
   */
  readonly firstSliceAngleDeg?: number;
  /**
   * Doughnut hole size as a percent of the outer radius (0..90).
   * Mirrors `<c:holeSize val="…"/>`. New charts default to 50; native
   * omission is the zero-hole state, which is authored by omission.
   */
  readonly holeSizePct?: number;
  /**
   * Scatter sub-type from `<c:scatterChart><c:scatterStyle val="…"/>`
   * (ECMA-376 ST_ScatterStyle). Governs whether the renderer connects
   * points with straight / smoothed lines and whether it draws markers:
   *
   *   - `'marker'` (and the renderer's default when absent) — markers only
   *   - `'line'` / `'smooth'` — connecting line only
   *   - `'lineMarker'` / `'smoothMarker'` — line + markers
   *   - `'none'` — neither
   */
  readonly scatterStyle?:
    "none" | "line" | "lineMarker" | "marker" | "smooth" | "smoothMarker";
  /**
   * Radar sub-type from `<c:radarChart><c:radarStyle val="…"/>`
   * (ECMA-376 ST_RadarStyle): `'standard'` (polyline only), `'marker'`
   * (polyline + point markers), or `'filled'` (the polygon is filled at
   * reduced opacity).
   */
  readonly radarStyle?: "standard" | "marker" | "filled";
  /**
   * Bubble-size scale percentage from `<c:bubbleChart><c:bubbleScale
   * val="N"/>` (0..300, default 100). Scales every bubble's
   * rendered radius proportionally.
   */
  readonly bubbleScale?: number;
  /**
   * Whether a bubble's `<c:bubbleSize>` maps to the bubble's area or its
   * width — `<c:bubbleChart><c:sizeRepresents val="area|w"/>` (ECMA-376
   * ST_SizeRepresents; the `'w'` token is surfaced as `'width'`).
   * The default is `'area'`, so radius scales with `sqrt(size)`;
   * `'width'` scales radius linearly with size.
   */
  readonly bubbleSizeRepresents?: "area" | "width";
}
