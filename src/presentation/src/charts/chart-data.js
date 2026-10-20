// Chart types and chart data, apart from any interface: the catalogue of
// chart types the Insert Chart dialog offers, the chart definition each one
// makes, and the data sheet's grid with the conversions between the two.
// A chart definition here is the engine's ChartSpec (lib/pptx chartml).

// Generic sample data for a new chart. Every chart starts from these and the
// data sheet opens on them, so the numbers only need to read as a chart.
const SAMPLE_CATEGORIES = [
  "Category 1",
  "Category 2",
  "Category 3",
  "Category 4",
];
const SAMPLE_SERIES = [
  { name: "Series 1", values: [4.1, 2.6, 3.4, 4.6] },
  { name: "Series 2", values: [2.2, 4.3, 1.9, 2.9] },
  { name: "Series 3", values: [1.8, 2.1, 3.2, 4.8] },
];
const SAMPLE_PIE = {
  categories: ["North", "East", "South", "West"],
  series: [{ name: "Share", values: [42, 23, 20, 15] }],
};
const SAMPLE_XY = {
  categories: [],
  series: [
    {
      name: "Y Values",
      xValues: [0.7, 1.8, 2.6, 3.4, 4.1],
      values: [2.7, 3.2, 1.2, 3.9, 2.5],
    },
  ],
};
const SAMPLE_BUBBLE = {
  categories: [],
  series: [
    {
      name: "Y Values",
      xValues: [0.7, 1.8, 2.6],
      values: [2.7, 3.2, 0.8],
      bubbleSizes: [10, 4, 8],
    },
  ],
};

// Each chart type: its family in the dialog's list and the settings that make
// it. `apply(spec)` turns any chart definition into this type, keeping the
// data and formatting that still apply.
export const CHART_FAMILIES = [
  { id: "column", label: "Column", icon: "chartColumn" },
  { id: "line", label: "Line", icon: "chartLine" },
  { id: "pie", label: "Pie", icon: "chartPie" },
  { id: "bar", label: "Bar", icon: "chartBar" },
  { id: "area", label: "Area", icon: "chartArea" },
  { id: "scatter", label: "X Y (Scatter)", icon: "chartScatter" },
  { id: "radar", label: "Radar", icon: "chartRadar" },
  { id: "combo", label: "Combo", icon: "chartCombo" },
];

const grouped = (kind, grouping) => (raw) => {
  const spec = stripFor(toCategories(raw), kind);
  return {
    ...spec,
    kind,
    grouping,
    ...(kind === "bar" || kind === "column"
      ? { overlapPct: grouping === "clustered" ? undefined : 100 }
      : {}),
    series: spec.series.map((series) => {
      const { chartKind, secondaryAxis, ...s } = stripSeries(series, kind);
      return kind === "line" ? s : withoutLineOnlyFields(s);
    }),
  };
};
const withoutLineOnlyFields = ({ markerSymbol, smooth, ...s }) => s;
const markers = (on) => (spec) => ({
  ...spec,
  series: spec.series.map((s) => {
    const { markerSymbol, ...rest } = s;
    return on
      ? markerSymbol && markerSymbol !== "none"
        ? s
        : rest
      : { ...rest, markerSymbol: "none" };
  }),
});
const compose =
  (...steps) =>
  (spec) =>
    steps.reduce((acc, step) => step(acc), spec);

export const CHART_TYPES = [
  {
    id: "column-clustered",
    family: "column",
    label: "Clustered Column",
    apply: grouped("column", "clustered"),
  },
  {
    id: "column-stacked",
    family: "column",
    label: "Stacked Column",
    apply: grouped("column", "stacked"),
  },
  {
    id: "column-percent",
    family: "column",
    label: "100% Stacked Column",
    apply: grouped("column", "percentStacked"),
  },
  {
    id: "line",
    family: "line",
    label: "Line",
    apply: compose(grouped("line", "standard"), markers(false)),
  },
  {
    id: "line-stacked",
    family: "line",
    label: "Stacked Line",
    apply: compose(grouped("line", "stacked"), markers(false)),
  },
  {
    id: "line-percent",
    family: "line",
    label: "100% Stacked Line",
    apply: compose(grouped("line", "percentStacked"), markers(false)),
  },
  {
    id: "line-markers",
    family: "line",
    label: "Line with Markers",
    apply: compose(grouped("line", "standard"), markers(true)),
  },
  {
    id: "line-stacked-markers",
    family: "line",
    label: "Stacked Line with Markers",
    apply: compose(grouped("line", "stacked"), markers(true)),
  },
  {
    id: "line-percent-markers",
    family: "line",
    label: "100% Stacked Line with Markers",
    apply: compose(grouped("line", "percentStacked"), markers(true)),
  },
  {
    id: "pie",
    family: "pie",
    label: "Pie",
    apply: (spec) => single({ ...spec, kind: "pie" }),
  },
  {
    id: "pie-exploded",
    family: "pie",
    label: "Exploded Pie",
    apply: (spec) => {
      const pie = single({ ...spec, kind: "pie" });
      return {
        ...pie,
        series: pie.series.map((s) => ({
          ...s,
          pointExplosions: s.values.map(() => 12),
        })),
      };
    },
  },
  {
    id: "doughnut",
    family: "pie",
    label: "Doughnut",
    apply: (spec) => ({
      ...single({ ...spec, kind: "doughnut" }, true),
      holeSizePct: spec.holeSizePct ?? 50,
    }),
  },
  {
    id: "bar-clustered",
    family: "bar",
    label: "Clustered Bar",
    apply: grouped("bar", "clustered"),
  },
  {
    id: "bar-stacked",
    family: "bar",
    label: "Stacked Bar",
    apply: grouped("bar", "stacked"),
  },
  {
    id: "bar-percent",
    family: "bar",
    label: "100% Stacked Bar",
    apply: grouped("bar", "percentStacked"),
  },
  {
    id: "area",
    family: "area",
    label: "Area",
    apply: grouped("area", "standard"),
  },
  {
    id: "area-stacked",
    family: "area",
    label: "Stacked Area",
    apply: grouped("area", "stacked"),
  },
  {
    id: "area-percent",
    family: "area",
    label: "100% Stacked Area",
    apply: grouped("area", "percentStacked"),
  },
  {
    id: "scatter",
    family: "scatter",
    label: "Scatter",
    apply: scatter("lineMarker", { line: false, markers: true }),
  },
  {
    id: "scatter-smooth-markers",
    family: "scatter",
    label: "Scatter with Smooth Lines and Markers",
    apply: scatter("smoothMarker", { line: true, markers: true, smooth: true }),
  },
  {
    id: "scatter-smooth",
    family: "scatter",
    label: "Scatter with Smooth Lines",
    apply: scatter("smoothMarker", {
      line: true,
      markers: false,
      smooth: true,
    }),
  },
  {
    id: "scatter-lines-markers",
    family: "scatter",
    label: "Scatter with Straight Lines and Markers",
    apply: scatter("lineMarker", { line: true, markers: true }),
  },
  {
    id: "scatter-lines",
    family: "scatter",
    label: "Scatter with Straight Lines",
    apply: scatter("lineMarker", { line: true, markers: false }),
  },
  {
    id: "bubble",
    family: "scatter",
    label: "Bubble",
    apply: (spec) => {
      const xy = toXY(spec, true);
      return {
        ...stripFor(xy, "bubble"),
        kind: "bubble",
        series: xy.series.map((s) =>
          withoutLineOnlyFields(stripSeries(s, "bubble")),
        ),
      };
    },
  },
  {
    id: "radar",
    family: "radar",
    label: "Radar",
    apply: radar("marker", false),
  },
  {
    id: "radar-markers",
    family: "radar",
    label: "Radar with Markers",
    apply: radar("marker", true),
  },
  {
    id: "radar-filled",
    family: "radar",
    label: "Filled Radar",
    apply: radar("filled", false),
  },
  {
    id: "combo-column-line",
    family: "combo",
    label: "Clustered Column - Line",
    apply: combo((i, n) => (i === n - 1 ? { chartKind: "line" } : {})),
  },
  {
    id: "combo-column-line-secondary",
    family: "combo",
    label: "Clustered Column - Line on Secondary Axis",
    apply: combo((i, n) =>
      i === n - 1 ? { chartKind: "line", secondaryAxis: true } : {},
    ),
  },
  {
    id: "combo-area-column",
    family: "combo",
    label: "Stacked Area - Clustered Column",
    apply: combo(
      (i, n) => (i < Math.ceil(n / 2) ? { chartKind: "area" } : {}),
      "column",
    ),
  },
  {
    id: "combo-custom",
    family: "combo",
    label: "Custom Combination",
    custom: true,
    apply: (spec) => combo(() => ({}))(spec),
  },
];

function scatter(scatterStyle, { line, markers: withMarkers, smooth = false }) {
  return (spec) => {
    const xy = toXY(spec, false);
    return {
      ...stripFor(xy, "scatter"),
      kind: "scatter",
      scatterStyle,
      series: xy.series.map((raw) => {
        const s = stripSeries(raw, "scatter");
        const { markerSymbol, smooth: _s, lineColor, ...rest } = s;
        return {
          ...rest,
          ...(line ? (lineColor ? { lineColor } : {}) : { lineColor: null }),
          ...(withMarkers
            ? markerSymbol && markerSymbol !== "none"
              ? { markerSymbol }
              : { markerSymbol: "circle", markerSizePt: rest.markerSizePt ?? 7 }
            : { markerSymbol: "none" }),
          ...(smooth ? { smooth: true } : {}),
        };
      }),
    };
  };
}
function radar(radarStyle, withMarkers) {
  return (spec) => {
    const cat = toCategories(spec);
    return {
      ...stripFor(cat, "radar"),
      kind: "radar",
      radarStyle,
      series: cat.series.map((raw) => {
        const s = stripSeries(raw, "radar");
        const { markerSymbol, smooth, ...rest } = s;
        if (radarStyle === "filled") return rest;
        return withMarkers
          ? markerSymbol && markerSymbol !== "none"
            ? { ...rest, markerSymbol }
            : rest
          : { ...rest, markerSymbol: "none" };
      }),
    };
  };
}
// Combination charts: every series a clustered column unless `pick` gives it
// another kind or the secondary axis.
function combo(pick, base = "column") {
  return (spec) => {
    const n = spec.series.length;
    return withKinds(
      spec,
      spec.series.map((_, i) => {
        const chosen = pick(i, n);
        return {
          kind: chosen.chartKind || base,
          secondary: !!chosen.secondaryAxis,
        };
      }),
    );
  };
}
// A combination chart from each series' kind and axis. The chart's own kind
// is its first series' kind, and each kind's series are kept together in
// the order chosen: the file groups series by kind, so this is the order
// they read back in.
function withKinds(spec, choices) {
  const cat = toCategories(spec);
  const kindOf = (i) => choices[i]?.kind || "column";
  const order = [];
  for (const i of cat.series.keys())
    if (!order.includes(kindOf(i))) order.push(kindOf(i));
  const indices = order.flatMap((k) =>
    [...cat.series.keys()].filter((i) => kindOf(i) === k),
  );
  const base = kindOf(indices[0] ?? 0);
  return {
    ...stripFor(cat, base),
    kind: base,
    grouping: base === "column" || base === "bar" ? "clustered" : "standard",
    series: indices.map((i) => {
      const { chartKind, secondaryAxis, ...s } = stripSeries(
        cat.series[i],
        base,
      );
      const kind = kindOf(i);
      return {
        ...(kind === "line" ? s : withoutLineOnlyFields(s)),
        ...(kind !== base ? { chartKind: kind } : {}),
        ...(choices[i]?.secondary ? { secondaryAxis: true } : {}),
      };
    }),
  };
}
const single = (spec, keepAll = false) => {
  const cat = toCategories(spec);
  const stripped = stripFor(cat, spec.kind);
  const series = cat.series.map((s) =>
    withoutLineOnlyFields(stripSeries(s, spec.kind)),
  );
  return {
    ...stripped,
    kind: spec.kind,
    // A pie shows one series; a doughnut may ring several.
    series: keepAll ? series : series.slice(0, 1),
  };
};

const CATEGORY_KINDS = new Set([
  "bar",
  "column",
  "line",
  "area",
  "pie",
  "doughnut",
  "radar",
]);
export const isXYKind = (kind) => kind === "scatter" || kind === "bubble";

// Settings that belong to some kinds only; the engine refuses or ignores the
// rest, and a later change back would otherwise pick up stale values.
const ONLY = {
  grouping: ["bar", "column", "line", "area"],
  overlapPct: ["bar", "column"],
  gapWidthPct: ["bar", "column"],
  holeSizePct: ["doughnut"],
  firstSliceAngleDeg: ["pie", "doughnut"],
  scatterStyle: ["scatter"],
  radarStyle: ["radar"],
  bubbleScale: ["bubble"],
  bubbleSizeRepresents: ["bubble"],
  lineMarkers: ["line"],
  dropLines: ["line", "area"],
  hiLowLines: ["line"],
  upDownBars: ["line"],
  dataTable: ["bar", "column", "line", "area"],
};
function stripFor(spec, kind) {
  const out = { ...spec };
  for (const [key, kinds] of Object.entries(ONLY))
    if (!kinds.includes(kind)) delete out[key];
  for (const key of Object.keys(out))
    if (out[key] === undefined) delete out[key];
  return out;
}
function stripSeries(series, kind) {
  const out = { ...series };
  if (!isXYKind(kind)) {
    delete out.xValues;
    delete out.bubbleSizes;
  }
  if (kind !== "bubble") delete out.bubbleSizes;
  if (kind !== "pie" && kind !== "doughnut") delete out.pointExplosions;
  if (["pie", "doughnut", "radar"].includes(kind)) {
    delete out.trendline;
    delete out.errorBars;
    delete out.secondaryAxis;
    delete out.chartKind;
  }
  if (kind !== "bar" && kind !== "column") {
    delete out.invertIfNegative;
    delete out.negativeColor;
    delete out.pointInvertIfNegative;
  }
  return out;
}

// X/Y data from category data: categories that read as numbers become the
// x values, otherwise the points are numbered.
function toXY(spec, bubble) {
  if (isXYKind(spec.kind)) {
    return {
      ...spec,
      series: spec.series.map((s) => ({
        ...s,
        xValues: s.xValues ?? s.values.map((_, i) => i + 1),
        ...(bubble
          ? {
              bubbleSizes:
                s.bubbleSizes ?? s.values.map((v) => Math.abs(v ?? 0) || 1),
            }
          : {}),
      })),
    };
  }
  const numeric = spec.categories.length
    ? spec.categories.every(
        (c) => c.trim() !== "" && Number.isFinite(Number(c)),
      )
    : false;
  const xs = (n) =>
    Array.from({ length: n }, (_, i) =>
      numeric && i < spec.categories.length
        ? Number(spec.categories[i])
        : i + 1,
    );
  return {
    ...spec,
    categories: [],
    categoryNumberFormat: undefined,
    series: spec.series.map((s) => ({
      ...s,
      xValues: xs(s.values.length),
      ...(bubble
        ? { bubbleSizes: s.values.map((v) => Math.abs(v ?? 0) || 1) }
        : {}),
    })),
  };
}
// Category data from X/Y data: the first series' x values label the points.
function toCategories(spec) {
  if (!isXYKind(spec.kind)) return spec;
  const first = spec.series[0];
  const xs = first?.xValues ?? [];
  return {
    ...spec,
    categories: xs.map((x) => (x == null ? "" : String(x))),
    series: spec.series.map(({ xValues, bubbleSizes, ...s }) => s),
  };
}

export const chartType = (id) => CHART_TYPES.find((t) => t.id === id) || null;
export const chartFamily = (id) =>
  CHART_FAMILIES.find((f) => f.id === id) || null;

// The sample chart each type starts with in the Insert Chart dialog.
export function sampleSpec(typeId) {
  const type = chartType(typeId) || CHART_TYPES[0];
  const base =
    type.family === "pie"
      ? SAMPLE_PIE
      : type.id === "bubble"
        ? SAMPLE_BUBBLE
        : type.family === "scatter"
          ? SAMPLE_XY
          : { categories: SAMPLE_CATEGORIES, series: SAMPLE_SERIES };
  const spec = {
    kind:
      type.id === "bubble"
        ? "bubble"
        : type.family === "scatter"
          ? "scatter"
          : "column",
    categories: [...base.categories],
    series: base.series.map((s) => ({
      ...s,
      values: [...s.values],
      ...(s.xValues ? { xValues: [...s.xValues] } : {}),
      ...(s.bubbleSizes ? { bubbleSizes: [...s.bubbleSizes] } : {}),
    })),
    title: "Chart Title",
    legend: { position: type.family === "pie" ? "r" : "b" },
  };
  return cleanSpec(withBarDefaults(null, type.apply(spec)));
}

// The type a chart definition is, as near as the catalogue has it.
export function detectChartType(spec) {
  if (!spec) return null;
  const kinds = spec.series.map((s) => s.chartKind || spec.kind);
  if (new Set(kinds).size > 1 || spec.series.some((s) => s.secondaryAxis)) {
    const n = kinds.length;
    const half = Math.ceil(n / 2);
    const plain = (i) => !spec.series[i].secondaryAxis;
    if (
      kinds.every((k, i) => (i === n - 1 ? k === "line" : k === "column")) &&
      kinds.slice(0, -1).every((_, i) => plain(i))
    )
      return spec.series[n - 1].secondaryAxis
        ? "combo-column-line-secondary"
        : "combo-column-line";
    if (
      kinds.every((k, i) => (i < half ? k === "area" : k === "column")) &&
      kinds.every((_, i) => plain(i))
    )
      return "combo-area-column";
    return "combo-custom";
  }
  const grouping = spec.grouping;
  const suffix =
    grouping === "stacked"
      ? "-stacked"
      : grouping === "percentStacked"
        ? "-percent"
        : "";
  const anyMarkers = spec.series.some(
    (s) => s.markerSymbol === undefined || s.markerSymbol !== "none",
  );
  switch (spec.kind) {
    case "column":
    case "bar":
      return `${spec.kind}${suffix || "-clustered"}`;
    case "area":
      return `area${suffix}`;
    case "line":
      return `line${suffix}${anyMarkers ? "-markers" : ""}`;
    case "pie":
      return spec.series[0]?.pointExplosions?.some((v) => v > 0)
        ? "pie-exploded"
        : "pie";
    case "doughnut":
      return "doughnut";
    case "radar":
      return spec.radarStyle === "filled"
        ? "radar-filled"
        : anyMarkers
          ? "radar-markers"
          : "radar";
    case "bubble":
      return "bubble";
    case "scatter": {
      const lines = spec.series.some((s) => s.lineColor !== null);
      const smooth =
        spec.scatterStyle === "smooth" ||
        spec.scatterStyle === "smoothMarker" ||
        spec.series.some((s) => s.smooth);
      if (!lines) return "scatter";
      if (smooth)
        return anyMarkers ? "scatter-smooth-markers" : "scatter-smooth";
      return anyMarkers ? "scatter-lines-markers" : "scatter-lines";
    }
    default:
      return null;
  }
}

// A bar series without an invertIfNegative setting draws its negative bars
// inverted (white), as desktop editors do with files that omit it, so bars
// this editor makes say "not inverted" as those editors write it. A series
// that was already a bar keeps whatever it had.
const BAR_LIKE = new Set(["bar", "column"]);
export function withBarDefaults(prev, next) {
  return {
    ...next,
    series: next.series.map((s, i) => {
      if (s.invertIfNegative !== undefined) return s;
      if (!BAR_LIKE.has(s.chartKind || next.kind)) return s;
      const before =
        prev?.series.find((x) => x.name === s.name) ?? prev?.series[i];
      if (before && BAR_LIKE.has(before.chartKind || prev.kind)) return s;
      return { ...s, invertIfNegative: false };
    }),
  };
}

// Turns a chart into another type, keeping its data and the formatting that
// still applies.
export function convertChart(spec, typeId) {
  const type = chartType(typeId);
  if (!type) return spec;
  return cleanSpec(withBarDefaults(spec, type.apply(spec)));
}
// Custom combinations: the kind and axis of each series, by index.
export function comboSpec(spec, choices) {
  return cleanSpec(withBarDefaults(spec, withKinds(spec, choices)));
}
// Data label positions a kind of chart allows; area, doughnut and radar
// charts take none. A position the chart can no longer have is dropped.
function allowedPositions(kind, grouping) {
  if (kind === "area" || kind === "doughnut" || kind === "radar") return [];
  if (kind === "bar" || kind === "column")
    return grouping === "stacked" || grouping === "percentStacked"
      ? ["inBase", "inEnd", "ctr"]
      : ["inBase", "inEnd", "outEnd", "ctr"];
  if (kind === "pie") return ["bestFit", "outEnd", "inEnd", "ctr"];
  return ["l", "r", "b", "t", "ctr"];
}
function fixLabels(labels, kinds, grouping) {
  if (!labels || labels.position === undefined) return labels;
  if (
    kinds.every((k) => allowedPositions(k, grouping).includes(labels.position))
  )
    return labels;
  const { position, ...rest } = labels;
  return rest;
}
// No undefined members: the engine's validation reads presence, not value.
export function cleanSpec(spec) {
  const out = {};
  for (const [key, value] of Object.entries(spec))
    if (value !== undefined) out[key] = value;
  const kinds = spec.series.length
    ? [...new Set(spec.series.map((s) => s.chartKind || spec.kind))]
    : [spec.kind];
  if (out.dataLabels)
    out.dataLabels = fixLabels(out.dataLabels, kinds, spec.grouping);
  out.series = spec.series.map((s) => {
    const series = {};
    for (const [key, value] of Object.entries(s))
      if (value !== undefined) series[key] = value;
    if (series.dataLabels)
      series.dataLabels = fixLabels(
        series.dataLabels,
        [s.chartKind || spec.kind],
        spec.grouping,
      );
    return series;
  });
  return out;
}

/* ---------- The data sheet's grid ----------
 * The grid is rows of cell strings, as a spreadsheet shows them. Category
 * charts: the first row names the series, the first column the categories.
 * X/Y charts: the first column holds the x values and each further column
 * a series' y values (bubble charts follow each with a size column).
 */
export function gridLayout(spec) {
  return spec.kind === "bubble"
    ? "bubble"
    : isXYKind(spec.kind)
      ? "xy"
      : "category";
}
const cell = (v) => (v == null || Number.isNaN(v) ? "" : String(v));
export function specToGrid(spec) {
  const layout = gridLayout(spec);
  if (layout === "category") {
    const rows = Math.max(
      spec.categories.length,
      ...spec.series.map((s) => s.values.length),
      0,
    );
    const grid = [["", ...spec.series.map((s) => s.name)]];
    for (let r = 0; r < rows; r++)
      grid.push([
        spec.categories[r] ?? "",
        ...spec.series.map((s) => cell(s.values[r])),
      ]);
    return grid;
  }
  const rows = Math.max(...spec.series.map((s) => s.values.length), 0);
  const xs = spec.series[0]?.xValues ?? [];
  const header = ["X Values"];
  for (const s of spec.series) {
    header.push(s.name);
    if (layout === "bubble") header.push("Size");
  }
  const grid = [header];
  for (let r = 0; r < rows; r++) {
    const row = [cell(xs[r])];
    for (const s of spec.series) {
      row.push(cell(s.values[r]));
      if (layout === "bubble") row.push(cell(s.bubbleSizes?.[r]));
    }
    grid.push(row);
  }
  return grid;
}
// A cell's number: blank is a gap; anything that isn't a number is too.
export function parseNumber(text) {
  const t = String(text ?? "")
    .trim()
    .replace(/[\s,](?=\d{3}\b)/g, "")
    .replace(/%$/, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
// The chart definition with the grid's data. Series keep their formatting
// by position; new series take the automatic colours.
export function gridToSpec(grid, spec) {
  const layout = gridLayout(spec);
  const header = grid[0] || [];
  const body = trimEmptyRows(grid.slice(1));
  if (layout === "category") {
    const names = header.slice(1);
    const count = trimEmptyTail(
      names,
      body.map((r) => r.slice(1)),
    );
    const series = [];
    for (let c = 0; c < count; c++) {
      const prior = spec.series[c] || {};
      series.push({
        ...prior,
        name: names[c] || `Series ${c + 1}`,
        values: body.map((row) => parseNumber(row[c + 1])),
      });
    }
    const categories = body.map((row) => String(row[0] ?? ""));
    const out = {
      ...spec,
      categories,
      series: series.length
        ? series
        : spec.series
            .slice(0, 1)
            .map((s) => ({ ...s, values: categories.map(() => null) })),
    };
    // A pie shows its first series only.
    if (spec.kind === "pie") out.series = out.series.slice(0, 1);
    if (
      out.categoryNumberFormat !== undefined &&
      !categories.every((c) => c.trim() === "" || Number.isFinite(Number(c)))
    )
      delete out.categoryNumberFormat;
    return cleanSpec(withBarDefaults(spec, refreshErrorRanges(out, grid)));
  }
  const step = layout === "bubble" ? 2 : 1;
  const names = [];
  for (let c = 1; c < header.length; c += step) names.push(header[c]);
  const columns = body.map((r) => r.slice(1));
  let count = names.length;
  while (
    count > 1 &&
    !names[count - 1] &&
    columns.every((r) => !String(r[(count - 1) * step] ?? "").trim())
  )
    count--;
  const xs = body.map((row) => parseNumber(row[0]));
  const series = [];
  for (let i = 0; i < count; i++) {
    const prior = spec.series[i] || {};
    const col = 1 + i * step;
    series.push({
      ...prior,
      name: names[i] || `Series ${i + 1}`,
      xValues: xs.map((x, r) => x ?? r + 1),
      values: body.map((row) => parseNumber(row[col])),
      ...(layout === "bubble"
        ? { bubbleSizes: body.map((row) => parseNumber(row[col + 1])) }
        : {}),
    });
  }
  return cleanSpec(
    refreshErrorRanges({ ...spec, categories: [], series }, grid),
  );
}
/* ---------- Ranges of the data sheet ----------
 * Custom error amounts may come from a range of the data sheet ("C2:C4",
 * "=Sheet1!$C$2:$C$4"): one column or one row of the grid above, where
 * row 1 is the header row and column A the first column.
 */
const RANGE =
  /^=?\s*(?:(?:'[^']+'|[A-Za-z0-9_. ]+)!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?\s*$/i;
const columnIndex = (letters) =>
  [...letters.toUpperCase()].reduce(
    (n, ch) => n * 26 + ch.charCodeAt(0) - 64,
    0,
  ) - 1;
const columnLetters = (index) => {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
/** The range as the chart file writes it ("Sheet1!$C$2:$C$4"), or null. */
export function normalizeSheetRange(text) {
  const m = RANGE.exec(String(text ?? ""));
  if (!m) return null;
  const [, c1, r1, c2 = c1, r2 = r1] = m;
  const a = { c: columnIndex(c1), r: Number(r1) },
    b = { c: columnIndex(c2), r: Number(r2) };
  if (a.r < 1 || b.r < 1 || (a.c !== b.c && a.r !== b.r)) return null;
  const cell = ({ c, r }) => `$${columnLetters(c)}$${r}`;
  return `Sheet1!${cell(a)}:${cell(b)}`;
}
/** The numbers in a one-column or one-row range of the grid, or null. */
export function sheetRangeValues(ref, grid) {
  const m = RANGE.exec(String(ref ?? ""));
  if (!m) return null;
  const [, c1, r1, c2 = c1, r2 = r1] = m;
  const ca = columnIndex(c1),
    cb = columnIndex(c2),
    ra = Number(r1),
    rb = Number(r2);
  if (ca !== cb && ra !== rb) return null;
  const out = [];
  if (ca === cb)
    for (let r = Math.min(ra, rb); r <= Math.max(ra, rb); r++)
      out.push(parseNumber(grid[r - 1]?.[ca]));
  else
    for (let c = Math.min(ca, cb); c <= Math.max(ca, cb); c++)
      out.push(parseNumber(grid[ra - 1]?.[c]));
  return out;
}
/**
 * Custom error amounts typed as numbers ("1, 2.5, 3") or as a range of the
 * data sheet. Returns `{ values, ref? }`, or null when unreadable.
 */
export function parseErrorAmounts(text, spec) {
  const t = String(text ?? "").trim();
  if (!t) return { values: [] };
  const ref = normalizeSheetRange(t);
  if (ref) return { values: sheetRangeValues(ref, specToGrid(spec)), ref };
  const values = t
    .replace(/^\{|\}$/g, "")
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((v) => parseNumber(v));
  return values.every((v) => v !== null) ? { values } : null;
}
/** Re-reads custom error amounts that come from data sheet ranges. */
export function refreshErrorRanges(spec, grid = specToGrid(spec)) {
  let changed = false;
  const series = spec.series.map((s) => {
    const bars = s.errorBars;
    if (bars?.valueType !== "cust" || (!bars.plusRef && !bars.minusRef))
      return s;
    const next = { ...bars };
    for (const side of ["plus", "minus"]) {
      const ref = bars[`${side}Ref`];
      const values = ref ? sheetRangeValues(ref, grid) : null;
      if (values) next[side] = values;
    }
    changed = true;
    return { ...s, errorBars: next };
  });
  return changed ? { ...spec, series } : spec;
}

function trimEmptyRows(rows) {
  let end = rows.length;
  while (end > 1 && rows[end - 1].every((v) => !String(v ?? "").trim())) end--;
  return rows.slice(0, end);
}
function trimEmptyTail(names, rows) {
  let count = names.length;
  while (
    count > 1 &&
    !String(names[count - 1] ?? "").trim() &&
    rows.every((r) => !String(r[count - 1] ?? "").trim())
  )
    count--;
  return count;
}

// X/Y charts plot their columns as series, and a pie plots one series only:
// its categories turned into series would leave it one value to show.
export const canSwitchRowColumn = (kind) => !isXYKind(kind) && kind !== "pie";
// Swap what the rows and the columns plot: categories become series and
// series categories.
export function switchRowColumn(spec) {
  if (!canSwitchRowColumn(spec.kind)) return spec;
  const count = Math.max(
    spec.categories.length,
    ...spec.series.map((s) => s.values.length),
  );
  const categories = spec.series.map((s) => s.name);
  const series = Array.from({ length: count }, (_, r) => {
    const prior = spec.series[r] || {};
    const {
      name,
      values,
      pointColors,
      pointExplosions,
      dataLabels,
      ...format
    } = prior;
    return {
      ...(r < spec.series.length ? format : {}),
      name: spec.categories[r] ?? `Series ${r + 1}`,
      values: spec.series.map((s) => s.values[r] ?? null),
    };
  });
  const out = { ...spec, categories, series };
  delete out.categoryNumberFormat;
  return cleanSpec(withBarDefaults(spec, out));
}

// Tab-separated text, as spreadsheets put on the clipboard, into rows.
export function parseTsv(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  const s = String(text).replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === "\t") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
export function toTsv(rows) {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const t = String(v ?? "");
          return /[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
        })
        .join("\t"),
    )
    .join("\n");
}
// Writes a block of cells into the grid at (row, col), growing it as needed.
export function pasteBlock(grid, row, col, block) {
  const out = grid.map((r) => [...r]);
  const width = Math.max(
    out[0]?.length || 0,
    col + Math.max(0, ...block.map((r) => r.length)),
  );
  while (out.length < row + block.length) out.push([]);
  for (const r of out) while (r.length < width) r.push("");
  block.forEach((cells, i) =>
    cells.forEach((v, j) => {
      out[row + i][col + j] = v;
    }),
  );
  return out;
}
export function insertRow(grid, at) {
  const width = grid[0]?.length || 1;
  const out = grid.map((r) => [...r]);
  out.splice(Math.max(1, at), 0, Array(width).fill(""));
  return out;
}
export function deleteRow(grid, at) {
  if (at < 1 || grid.length <= 2) return grid;
  return grid.filter((_, i) => i !== at);
}
export function insertColumn(grid, at) {
  return grid.map((r) => {
    const out = [...r];
    out.splice(Math.max(1, at), 0, "");
    return out;
  });
}
export function deleteColumn(grid, at) {
  if (at < 1 || (grid[0]?.length || 0) <= 2) return grid;
  return grid.map((r) => r.filter((_, i) => i !== at));
}
export const CATEGORY_KIND_SET = CATEGORY_KINDS;
