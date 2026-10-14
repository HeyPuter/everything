// What the Chart Design tab does to a chart definition: colour palettes,
// chart styles, quick layouts, and adding or removing chart elements. Each
// is a pure function from one ChartSpec to the next; `ctx` carries the deck's
// theme colours as #RRGGBB (accents, dark1, light1).
import { cleanSpec, isXYKind } from "./chart-data.js";

const hex = (v) =>
  `#${String(v || "000000")
    .replace("#", "")
    .toUpperCase()}`;
// Mixes a colour toward white (t > 0) or black (t < 0).
export function tint(color, t) {
  const h = hex(color).slice(1);
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const out = ch.map((c) =>
    Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t)),
  );
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}
export function themeContext(theme) {
  const t = theme || {};
  return {
    accents: [1, 2, 3, 4, 5, 6].map((i) => hex(t[`accent${i}`] || "4472C4")),
    dark: hex(t.dark1 || "000000"),
    light: hex(t.light1 || "FFFFFF"),
  };
}

const pies = (spec) => spec.kind === "pie" || spec.kind === "doughnut";
// Charts that colour each point rather than each series.
const byPoint = (spec) =>
  pies(spec) || (spec.varyColors && spec.series.length === 1);

/* ---------- Colours ---------- */
export const COLOR_PALETTES = [
  {
    id: "auto",
    group: "Colorful",
    label: "Theme order",
    order: [0, 1, 2, 3, 4, 5],
  },
  {
    id: "colorful-2",
    group: "Colorful",
    label: "Alternate accents",
    order: [1, 3, 5, 0, 2, 4],
  },
  {
    id: "colorful-3",
    group: "Colorful",
    label: "Cool first",
    order: [2, 4, 0, 5, 1, 3],
  },
  {
    id: "colorful-4",
    group: "Colorful",
    label: "Reversed accents",
    order: [5, 4, 3, 2, 1, 0],
  },
  ...[0, 1, 2, 3, 4, 5].map((a) => ({
    id: `mono-${a + 1}`,
    group: "Monochromatic",
    label: `Shades of accent ${a + 1}`,
    mono: a,
  })),
  {
    id: "mono-gray",
    group: "Monochromatic",
    label: "Shades of gray",
    gray: true,
  },
];
const SHADE_STEPS = [0, -0.25, 0.35, -0.5, 0.6, 0.15];
export function paletteColors(palette, ctx, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (palette.order) {
      const base = ctx.accents[palette.order[i % 6]];
      const round = Math.floor(i / 6);
      out.push(round ? tint(base, round % 2 ? -0.35 : 0.4) : base);
    } else {
      const base = palette.gray ? "#7F7F7F" : ctx.accents[palette.mono];
      out.push(tint(base, SHADE_STEPS[i % SHADE_STEPS.length]));
    }
  }
  return out;
}
export function applyPalette(spec, paletteId, ctx) {
  const palette = COLOR_PALETTES.find((p) => p.id === paletteId);
  if (!palette) return spec;
  if (byPoint(spec)) {
    const n = Math.max(
      spec.categories.length,
      spec.series[0]?.values.length || 0,
    );
    const colors = paletteColors(palette, ctx, n);
    return cleanSpec({
      ...spec,
      series: spec.series.map((s, i) => {
        const { pointColors, ...rest } = s;
        if (palette.id === "auto") return rest;
        return {
          ...rest,
          pointColors: i === 0 || pies(spec) ? colors : undefined,
        };
      }),
    });
  }
  const colors = paletteColors(palette, ctx, spec.series.length);
  return cleanSpec({
    ...spec,
    series: spec.series.map((s, i) => {
      const { color, markerFill, markerStrokeColor, pointColors, ...rest } = s;
      if (palette.id === "auto") return rest;
      const lineLike =
        (s.chartKind || spec.kind) === "line" ||
        spec.kind === "scatter" ||
        spec.kind === "radar";
      return {
        ...rest,
        color: colors[i],
        ...(lineLike && s.lineColor !== null ? { lineColor: colors[i] } : {}),
      };
    }),
  });
}

/* ---------- Chart styles ----------
 * A style sets the look of the chart's background, gridlines, labels and
 * series outlines, replacing whatever the previous style set. Data, titles
 * and colours stay as they are.
 */
const STYLE_FIELDS = [
  "plotAreaFill",
  "plotAreaStrokeColor",
  "chartAreaFill",
  "chartAreaStrokeColor",
  "chartAreaStrokeWidthEmu",
  "valueAxisMajorGridlines",
  "valueAxisMinorGridlines",
  "categoryAxisMajorGridlines",
  "valueAxisMajorGridlineColor",
  "valueAxisMinorGridlineColor",
  "categoryAxisMajorGridlineColor",
  "gapWidthPct",
  "roundedCorners",
  "textStyle",
  "valueAxisLineColor",
  "categoryAxisLineColor",
];
const PT = 12700;
const baseStyle = (spec) => {
  const out = { ...spec };
  for (const key of STYLE_FIELDS) delete out[key];
  out.series = spec.series.map((s) => {
    const { lineWidthEmu, markerSizePt, ...rest } = s;
    // A scatter series without a line keeps having none.
    if (
      rest.lineColor !== null &&
      !["line", "scatter", "radar"].includes(s.chartKind || spec.kind)
    )
      delete rest.lineColor;
    return rest;
  });
  return out;
};
const withSeries = (spec, fn) => ({
  ...spec,
  series: spec.series.map((s, i) => fn(s, i, s.chartKind || spec.kind)),
});
const isBarLike = (kind) => kind === "bar" || kind === "column";
const isLineLike = (kind) =>
  kind === "line" || kind === "scatter" || kind === "radar";
const labels = (spec, extra = {}) => ({
  showValue: !pies(spec),
  showCategory: false,
  showSeriesName: false,
  showPercent: pies(spec),
  ...(pies(spec)
    ? { position: "bestFit" }
    : isBarLike(spec.kind)
      ? { position: "outEnd" }
      : spec.kind === "area" || spec.kind === "radar"
        ? {}
        : { position: "t" }),
  ...extra,
});

export const CHART_STYLES = [
  {
    id: "style-1",
    label: "Plain",
    description: "Light gridlines on a clear background.",
    apply: (spec) => ({
      ...baseStyle(spec),
      valueAxisMajorGridlines: !pies(spec),
    }),
  },
  {
    id: "style-2",
    label: "Labeled values",
    description: "Values written on the data, without gridlines.",
    apply: (spec) => ({
      ...baseStyle(spec),
      valueAxisMajorGridlines: false,
      dataLabels: labels(spec),
      ...(isBarLike(spec.kind) ? { gapWidthPct: 80 } : {}),
    }),
  },
  {
    id: "style-3",
    label: "Shaded plot",
    description: "A tinted plot area with white gridlines.",
    apply: (spec, ctx) => ({
      ...baseStyle(spec),
      plotAreaFill: pies(spec) ? undefined : tint(ctx.dark, 0.93),
      valueAxisMajorGridlines: !pies(spec),
      valueAxisMajorGridlineColor: "#FFFFFF",
    }),
  },
  {
    id: "style-4",
    label: "Bold blocks",
    description: "Wide bars and thick lines with no gridlines.",
    apply: (spec) =>
      withSeries(
        {
          ...baseStyle(spec),
          valueAxisMajorGridlines: false,
          ...(isBarLike(spec.kind) ? { gapWidthPct: 40 } : {}),
        },
        (s, i, kind) =>
          isLineLike(kind) && s.lineColor !== null
            ? { ...s, lineWidthEmu: Math.round(4.5 * PT), markerSizePt: 9 }
            : s,
      ),
  },
  {
    id: "style-5",
    label: "Separated",
    description: "White outlines part the bars and slices.",
    apply: (spec) =>
      withSeries(
        { ...baseStyle(spec), valueAxisMajorGridlines: !pies(spec) },
        (s, i, kind) =>
          isLineLike(kind)
            ? s
            : {
                ...s,
                lineColor: "#FFFFFF",
                lineWidthEmu: Math.round(1.5 * PT),
              },
      ),
  },
  {
    id: "style-6",
    label: "Dark",
    description: "Light text and marks on a dark background.",
    apply: (spec, ctx) => ({
      ...baseStyle(spec),
      chartAreaFill: tint(ctx.dark, 0.18),
      textStyle: { color: "#F2F2F2" },
      valueAxisMajorGridlines: !pies(spec),
      valueAxisMajorGridlineColor: tint(ctx.dark, 0.35),
    }),
  },
  {
    id: "style-7",
    label: "Fine grid",
    description: "Major and minor gridlines for reading values closely.",
    apply: (spec) => ({
      ...baseStyle(spec),
      valueAxisMajorGridlines: !pies(spec),
      valueAxisMinorGridlines: !pies(spec),
      valueAxisMinorGridlineColor: "#EDEDED",
      categoryAxisMajorGridlines: !pies(spec) && !isBarLike(spec.kind),
    }),
  },
  {
    id: "style-8",
    label: "Framed",
    description: "A rounded outline around the whole chart.",
    apply: (spec, ctx) => ({
      ...baseStyle(spec),
      chartAreaStrokeColor: tint(ctx.dark, 0.6),
      chartAreaStrokeWidthEmu: Math.round(1 * PT),
      roundedCorners: true,
      valueAxisMajorGridlines: !pies(spec),
    }),
  },
  {
    id: "style-9",
    label: "Accent wash",
    description: "A soft wash of the first accent behind the data.",
    apply: (spec, ctx) => ({
      ...baseStyle(spec),
      chartAreaFill: tint(ctx.accents[0], 0.88),
      valueAxisMajorGridlines: !pies(spec),
      valueAxisMajorGridlineColor: tint(ctx.accents[0], 0.6),
    }),
  },
  {
    id: "style-10",
    label: "Labels, no grid",
    description: "Labeled data on a clean background with lighter axes.",
    apply: (spec) => ({
      ...baseStyle(spec),
      valueAxisMajorGridlines: false,
      valueAxisLineColor: "#BFBFBF",
      categoryAxisLineColor: "#BFBFBF",
      dataLabels: labels(spec, pies(spec) ? { showCategory: true } : {}),
    }),
  },
  {
    id: "style-11",
    label: "Outlined",
    description: "Pale fills with outlines in the series colour.",
    apply: (spec, ctx) =>
      withSeries(
        { ...baseStyle(spec), valueAxisMajorGridlines: !pies(spec) },
        (s, i, kind) => {
          if (isLineLike(kind) || pies(spec)) return s;
          const base = s.color || ctx.accents[i % 6];
          return {
            ...s,
            color: tint(base, 0.65),
            lineColor: base,
            lineWidthEmu: Math.round(1.5 * PT),
          };
        },
      ),
  },
  {
    id: "style-12",
    label: "Dark labeled",
    description: "A dark background with values written on the data.",
    apply: (spec, ctx) => ({
      ...baseStyle(spec),
      chartAreaFill: tint(ctx.dark, 0.12),
      textStyle: { color: "#FFFFFF" },
      valueAxisMajorGridlines: false,
      dataLabels: labels(spec, { textStyle: { color: "#FFFFFF" } }),
    }),
  },
];
export function applyChartStyle(spec, styleId, ctx) {
  const style = CHART_STYLES.find((s) => s.id === styleId);
  return style ? cleanSpec(style.apply(spec, ctx)) : spec;
}

/* ---------- Quick layouts ----------
 * A layout chooses which elements the chart shows: title, legend, labels,
 * axis titles, gridlines and data table.
 */
const ELEMENT_FIELDS = [
  "title",
  "titleOverlay",
  "legend",
  "dataLabels",
  "categoryAxisTitle",
  "valueAxisTitle",
  "valueAxisMajorGridlines",
  "valueAxisMinorGridlines",
  "categoryAxisMajorGridlines",
  "dataTable",
];
const layout = (id, label, parts) => ({ id, label, parts });
export const QUICK_LAYOUTS = [
  layout("layout-1", "Title and legend at the right", {
    title: true,
    legend: "r",
    grid: true,
  }),
  layout("layout-2", "Title, legend at the top and value labels", {
    title: true,
    legend: "t",
    labels: true,
  }),
  layout("layout-3", "Title and legend at the bottom", {
    title: true,
    legend: "b",
    grid: true,
  }),
  layout("layout-4", "Legend at the bottom and value labels", {
    legend: "b",
    labels: true,
  }),
  layout("layout-5", "Title and data table", {
    title: true,
    table: true,
    grid: true,
    axisTitles: "value",
  }),
  layout("layout-6", "Title, axis titles and legend", {
    title: true,
    legend: "r",
    axisTitles: "both",
    grid: true,
  }),
  layout("layout-7", "Axis titles, legend and fine gridlines", {
    legend: "r",
    axisTitles: "both",
    grid: true,
    minor: true,
  }),
  layout("layout-8", "Title and axis titles, no legend", {
    title: true,
    axisTitles: "both",
  }),
  layout("layout-9", "Title, axis titles, legend and gridlines", {
    title: true,
    legend: "r",
    axisTitles: "both",
    grid: true,
    vertical: true,
  }),
  layout("layout-10", "Title with labels on the data, no legend", {
    title: true,
    labels: true,
    categoryLabels: true,
  }),
  layout("layout-11", "Legend at the right only", { legend: "r" }),
];
export function applyQuickLayout(spec, layoutId) {
  const l = QUICK_LAYOUTS.find((q) => q.id === layoutId);
  if (!l) return spec;
  const p = l.parts;
  const out = { ...spec };
  const keepTitle = spec.title || "Chart Title";
  for (const key of ELEMENT_FIELDS) delete out[key];
  if (p.title) out.title = keepTitle;
  out.legend = p.legend
    ? { ...(spec.legend || {}), position: p.legend }
    : { position: null };
  const axes = !pies(spec) && spec.kind !== "radar";
  if (p.labels)
    out.dataLabels = {
      ...labels(spec),
      ...(p.categoryLabels ? { showCategory: true } : {}),
    };
  if (axes && p.axisTitles) {
    out.valueAxisTitle = spec.valueAxisTitle || "Axis Title";
    if (p.axisTitles === "both")
      out.categoryAxisTitle = spec.categoryAxisTitle || "Axis Title";
  }
  if (axes) {
    out.valueAxisMajorGridlines = !!p.grid;
    if (p.minor) out.valueAxisMinorGridlines = true;
    if (p.vertical) out.categoryAxisMajorGridlines = true;
  }
  if (p.table && supportsDataTable(spec)) {
    out.dataTable = {
      showHorzBorder: true,
      showVertBorder: true,
      showOutline: true,
      showKeys: true,
    };
    out.legend = { position: null };
  }
  return cleanSpec(out);
}
export const supportsDataTable = (spec) =>
  ["bar", "column", "line", "area"].includes(spec.kind);

/* ---------- Chart elements ---------- */
// Whether the value axis runs up the side (column, line...) or along the
// bottom (bar), which decides what "horizontal gridlines" are.
export const valueAxisVertical = (spec) => spec.kind !== "bar";
export const hasAxes = (spec) => !pies(spec);

export function setElement(spec, element, value) {
  const out = { ...spec };
  switch (element) {
    case "title":
      if (value === "none") {
        delete out.title;
        delete out.titleOverlay;
      } else {
        out.title = spec.title || "Chart Title";
        if (value === "overlay") out.titleOverlay = true;
        else delete out.titleOverlay;
      }
      break;
    case "legend":
      out.legend =
        value === "none"
          ? { ...(spec.legend || {}), position: null }
          : { ...(spec.legend || {}), position: value };
      break;
    case "dataLabels":
      if (value === "none") {
        delete out.dataLabels;
        out.series = spec.series.map(({ dataLabels, ...s }) => s);
      } else {
        const current = elementState(spec, "dataLabels") !== "none";
        const { position, ...next } = current ? spec.dataLabels : labels(spec);
        out.dataLabels = value === "show" ? next : { ...next, position: value };
      }
      break;
    case "categoryAxis":
      if (value) delete out.categoryAxisHidden;
      else out.categoryAxisHidden = true;
      break;
    case "valueAxis":
      if (value) delete out.valueAxisHidden;
      else out.valueAxisHidden = true;
      break;
    case "categoryAxisTitle":
      if (value) out.categoryAxisTitle = spec.categoryAxisTitle || "Axis Title";
      else delete out.categoryAxisTitle;
      break;
    case "valueAxisTitle":
      if (value) out.valueAxisTitle = spec.valueAxisTitle || "Axis Title";
      else delete out.valueAxisTitle;
      break;
    case "valueMajorGrid":
      out.valueAxisMajorGridlines = !!value;
      break;
    case "valueMinorGrid":
      out.valueAxisMinorGridlines = !!value;
      break;
    case "categoryMajorGrid":
      out.categoryAxisMajorGridlines = !!value;
      break;
    case "categoryMinorGrid":
      out.categoryAxisMinorGridlines = !!value;
      break;
    case "dataTable":
      if (value === "none") delete out.dataTable;
      else
        out.dataTable = {
          showHorzBorder: true,
          showVertBorder: true,
          showOutline: true,
          showKeys: value === "keys",
        };
      break;
    case "dropLines":
      if (value) out.dropLines = true;
      else delete out.dropLines;
      break;
    case "hiLowLines":
      if (value) out.hiLowLines = true;
      else delete out.hiLowLines;
      break;
    case "upDownBars":
      if (value) out.upDownBars = true;
      else delete out.upDownBars;
      break;
    default:
      return spec;
  }
  return cleanSpec(out);
}
export function elementState(spec, element) {
  switch (element) {
    case "title":
      return spec.title === undefined
        ? "none"
        : spec.titleOverlay
          ? "overlay"
          : "above";
    case "legend":
      return spec.legend?.position ?? (spec.legend ? "none" : "r");
    case "dataLabels": {
      const dl = spec.dataLabels;
      const on =
        dl &&
        (dl.showValue ||
          dl.showCategory ||
          dl.showSeriesName ||
          dl.showPercent);
      return on ? dl.position || "show" : "none";
    }
    case "categoryAxis":
      return !spec.categoryAxisHidden;
    case "valueAxis":
      return !spec.valueAxisHidden;
    case "categoryAxisTitle":
      return spec.categoryAxisTitle !== undefined;
    case "valueAxisTitle":
      return spec.valueAxisTitle !== undefined;
    case "valueMajorGrid":
      return spec.valueAxisMajorGridlines ?? !pies(spec);
    case "valueMinorGrid":
      return !!spec.valueAxisMinorGridlines;
    case "categoryMajorGrid":
      return !!spec.categoryAxisMajorGridlines;
    case "categoryMinorGrid":
      return !!spec.categoryAxisMinorGridlines;
    case "dataTable":
      return spec.dataTable
        ? spec.dataTable.showKeys
          ? "keys"
          : "plain"
        : "none";
    case "dropLines":
      return !!spec.dropLines;
    case "hiLowLines":
      return !!spec.hiLowLines;
    case "upDownBars":
      return !!spec.upDownBars;
    default:
      return null;
  }
}
// Data label positions each kind of chart offers.
export function labelPositions(spec) {
  if (pies(spec))
    return spec.kind === "doughnut"
      ? [["show", "Show"]]
      : [
          ["ctr", "Center"],
          ["inEnd", "Inside End"],
          ["outEnd", "Outside End"],
          ["bestFit", "Best Fit"],
        ];
  if (isBarLike(spec.kind))
    return spec.grouping && spec.grouping !== "clustered"
      ? [
          ["ctr", "Center"],
          ["inEnd", "Inside End"],
          ["inBase", "Inside Base"],
        ]
      : [
          ["ctr", "Center"],
          ["inEnd", "Inside End"],
          ["inBase", "Inside Base"],
          ["outEnd", "Outside End"],
        ];
  if (spec.kind === "area" || spec.kind === "radar") return [["show", "Show"]];
  return [
    ["ctr", "Center"],
    ["l", "Left"],
    ["r", "Right"],
    ["t", "Above"],
    ["b", "Below"],
  ];
}

/* ---------- Trendlines and error bars ---------- */
export const TRENDLINES = [
  ["linear", "Linear", { type: "linear" }],
  ["exp", "Exponential", { type: "exp" }],
  ["forecast", "Linear Forecast", { type: "linear", forward: 2 }],
  ["movingAvg", "Moving Average", { type: "movingAvg", period: 2 }],
];
export const supportsTrendline = (spec) => !pies(spec) && spec.kind !== "radar";
export function setTrendline(spec, which, seriesIndex = null) {
  const choice = TRENDLINES.find(([id]) => id === which);
  return cleanSpec({
    ...spec,
    series: spec.series.map((s, i) => {
      if (seriesIndex !== null && i !== seriesIndex) return s;
      const { trendline, ...rest } = s;
      if (!choice) return rest;
      // Exponential fits need positive values; the others take any.
      if (choice[0] === "exp" && s.values.some((v) => v != null && v <= 0))
        return rest;
      return { ...rest, trendline: { ...choice[2] } };
    }),
  });
}
export const ERROR_BARS = [
  ["stdErr", "Standard Error", { type: "both", valueType: "stdErr" }],
  [
    "percentage",
    "Percentage",
    { type: "both", valueType: "percentage", value: 5 },
  ],
  [
    "stdDev",
    "Standard Deviation",
    { type: "both", valueType: "stdDev", value: 1 },
  ],
];
export const supportsErrorBars = (spec) => !pies(spec) && spec.kind !== "radar";
export function setErrorBars(spec, which) {
  const choice = ERROR_BARS.find(([id]) => id === which);
  return cleanSpec({
    ...spec,
    series: spec.series.map((s) => {
      const { errorBars, ...rest } = s;
      return choice ? { ...rest, errorBars: { ...choice[2] } } : rest;
    }),
  });
}
export function errorBarState(spec) {
  const e = spec.series.find((s) => s.errorBars)?.errorBars;
  if (!e) return "none";
  return e.valueType === "stdErr"
    ? "stdErr"
    : e.valueType === "percentage"
      ? "percentage"
      : e.valueType === "stdDev"
        ? "stdDev"
        : "custom";
}
export const isXY = (spec) => isXYKind(spec.kind);
