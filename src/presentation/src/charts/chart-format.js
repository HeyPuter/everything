// The Format pane for a chart: pick an element of the chart (the whole
// chart, its plot, title, legend, axes, gridlines or a series) and set its
// fill, outline, text and options. Every control applies a change to the
// chart definition through `update(fn, key)`.
import { el } from "../ui.js";
import {
  ERROR_BARS,
  TRENDLINES,
  errorBarState,
  hasAxes,
  labelPositions,
  setErrorBars,
  setTrendline,
  supportsErrorBars,
  supportsTrendline,
  valueAxisVertical,
} from "./chart-styles.js";
import { cleanSpec, isXYKind } from "./chart-data.js";

const PT = 12700;
const pies = (spec) => spec.kind === "pie" || spec.kind === "doughnut";
const kindOf = (spec, s) => s.chartKind || spec.kind;

// The chart's parts a person can format, in the order a chart is read.
export function chartElements(spec) {
  if (!spec) return [];
  const vertical = valueAxisVertical(spec);
  const list = [
    { id: "chartArea", label: "Chart Area" },
    { id: "plotArea", label: "Plot Area" },
  ];
  if (spec.title !== undefined)
    list.push({ id: "title", label: "Chart Title" });
  if (spec.legend?.position !== null)
    list.push({ id: "legend", label: "Legend" });
  if (hasAxes(spec) && spec.kind !== "radar") {
    list.push({
      id: "categoryAxis",
      label: isXYKind(spec.kind)
        ? "Horizontal (Value) Axis"
        : vertical
          ? "Horizontal (Category) Axis"
          : "Vertical (Category) Axis",
    });
    list.push({
      id: "valueAxis",
      label: vertical ? "Vertical (Value) Axis" : "Horizontal (Value) Axis",
    });
    list.push({
      id: "gridlines",
      label: vertical ? "Horizontal Gridlines" : "Vertical Gridlines",
    });
  }
  spec.series.forEach((s, i) =>
    list.push({ id: `series:${i}`, label: `Series "${s.name || i + 1}"` }),
  );
  return list;
}
export function elementLabel(spec, id) {
  return chartElements(spec).find((e) => e.id === id)?.label || "Chart Area";
}

const set = (key, value) => (spec) => {
  const out = { ...spec };
  if (value === undefined) delete out[key];
  else out[key] = value;
  return cleanSpec(out);
};
const setStyle = (key, patch) => (spec) => {
  const next = { ...(spec[key] || {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  return set(key, Object.keys(next).length ? next : undefined)(spec);
};
const setSeries = (i, patch) => (spec) =>
  cleanSpec({
    ...spec,
    series: spec.series.map((s, j) => {
      if (j !== i) return s;
      const next = { ...s, ...patch };
      for (const k of Object.keys(patch))
        if (patch[k] === undefined) delete next[k];
      return next;
    }),
  });
const setLegend = (patch) => (spec) => {
  const next = { position: "r", ...(spec.legend || {}), ...patch };
  for (const k of Object.keys(patch))
    if (patch[k] === undefined) delete next[k];
  return set("legend", next)(spec);
};

// The pane's contents for one element. `h` carries the editor's field
// helpers: field, colorInput, numInput.
export function chartFormatSection({ spec, element, choose, update, h, ctx }) {
  const nodes = [];
  const elements = chartElements(spec);
  if (!elements.some((e) => e.id === element)) element = "chartArea";
  nodes.push(
    el("h3", {}, "Chart"),
    h.field(
      "Chart element",
      el(
        "select",
        {
          class: "input",
          "aria-label": "Chart element",
          onchange: (e) => choose(e.target.value),
        },
        ...elements.map((e) =>
          el("option", { value: e.id, selected: e.id === element }, e.label),
        ),
      ),
    ),
  );
  const key = (k) => `chart:${element}:${k}`;
  const color = (label, value, apply, { auto = true, none = true } = {}) => {
    const wrap = el("div", { class: "chart-color-row" });
    wrap.append(
      h.colorInput(
        label,
        value || null,
        (c) => update(apply(c.toUpperCase()), key(label)),
        {
          empty: value === null ? "None" : "Automatic",
          fallback: "#808080",
        },
      ),
    );
    const buttons = el("div", { class: "chart-color-actions" });
    if (auto)
      buttons.append(
        el(
          "button",
          {
            type: "button",
            class: "text-button",
            "aria-label": `${label}: automatic`,
            onclick: () => update(apply(undefined)),
          },
          "Automatic",
        ),
      );
    if (none)
      buttons.append(
        el(
          "button",
          {
            type: "button",
            class: "text-button",
            "aria-label": `${label}: none`,
            onclick: () => update(apply(null)),
          },
          "None",
        ),
      );
    wrap.append(buttons);
    return wrap;
  };
  const check = (label, checked, apply) =>
    el(
      "label",
      { class: "check-field" },
      el("input", {
        type: "checkbox",
        checked: !!checked,
        onchange: (e) => update(apply(e.target.checked)),
      }),
      el("span", {}, label),
    );
  const select = (label, value, options, apply) =>
    h.field(
      label,
      el(
        "select",
        {
          class: "input",
          "aria-label": label,
          onchange: (e) => update(apply(e.target.value)),
        },
        ...options.map(([v, l]) =>
          el("option", { value: v, selected: String(v) === String(value) }, l),
        ),
      ),
    );
  const text = (label, value, apply) =>
    h.field(
      label,
      el("input", {
        class: "input",
        value: value ?? "",
        "aria-label": label,
        onchange: (e) => update(apply(e.target.value)),
      }),
    );
  const optionalNumber = (
    label,
    value,
    apply,
    { min = -1e9, max = 1e9, step = 1 } = {},
  ) =>
    h.field(
      label,
      el("input", {
        type: "number",
        class: "input",
        value: value ?? "",
        min,
        max,
        step,
        placeholder: "Auto",
        "aria-label": label,
        onchange: (e) => {
          const raw = e.target.value.trim();
          const n = raw === "" ? undefined : Number(raw);
          if (n !== undefined && !Number.isFinite(n)) return;
          update(apply(n));
        },
      }),
    );
  const textStyle = (styleKey, label) => {
    const style = spec[styleKey] || {};
    return [
      el("h3", {}, label),
      h.numInput(
        `${label} size (pt)`,
        style.sizePt ?? (styleKey === "titleStyle" ? 14 : 10),
        (n) =>
          update(setStyle(styleKey, { sizePt: n }), key(`${styleKey}-size`)),
        6,
        72,
        1,
      ),
      el(
        "div",
        { class: "chart-check-row" },
        check("Bold", style.bold, (on) =>
          setStyle(styleKey, { bold: on || undefined }),
        ),
        check("Italic", style.italic, (on) =>
          setStyle(styleKey, { italic: on || undefined }),
        ),
      ),
      color(
        `${label} color`,
        style.color,
        (c) => setStyle(styleKey, { color: c ?? undefined }),
        { none: false },
      ),
    ];
  };

  switch (element) {
    case "chartArea":
      nodes.push(
        el("h3", {}, "Fill and outline"),
        color("Chart fill", spec.chartAreaFill, (c) => set("chartAreaFill", c)),
        color("Chart outline", spec.chartAreaStrokeColor, (c) =>
          set("chartAreaStrokeColor", c),
        ),
        h.numInput(
          "Outline width (pt)",
          (spec.chartAreaStrokeWidthEmu ?? 9525) / PT,
          (n) =>
            update(
              set("chartAreaStrokeWidthEmu", Math.round(n * PT)),
              key("w"),
            ),
          0,
          20,
          0.25,
        ),
        check("Rounded corners", spec.roundedCorners, (on) =>
          set("roundedCorners", on || undefined),
        ),
        ...textStyle("textStyle", "All text"),
      );
      if (spec.kind === "doughnut")
        nodes.push(
          h.numInput(
            "Hole size (%)",
            spec.holeSizePct ?? 50,
            (n) => update(set("holeSizePct", Math.round(n)), key("hole")),
            10,
            90,
            1,
          ),
        );
      if (pies(spec))
        nodes.push(
          h.numInput(
            "First slice angle (°)",
            spec.firstSliceAngleDeg ?? 0,
            (n) =>
              update(set("firstSliceAngleDeg", Math.round(n)), key("angle")),
            0,
            360,
            1,
          ),
        );
      if (spec.kind === "bar" || spec.kind === "column")
        nodes.push(
          el("h3", {}, "Bars"),
          h.numInput(
            "Gap width (%)",
            spec.gapWidthPct ?? 150,
            (n) => update(set("gapWidthPct", Math.round(n)), key("gap")),
            0,
            500,
            5,
          ),
          h.numInput(
            "Series overlap (%)",
            spec.overlapPct ??
              (spec.grouping && spec.grouping !== "clustered" ? 100 : 0),
            (n) => update(set("overlapPct", Math.round(n)), key("overlap")),
            -100,
            100,
            5,
          ),
          check("Vary colors by point", spec.varyColors, (on) =>
            set("varyColors", on || undefined),
          ),
        );
      if (!pies(spec) && !isXYKind(spec.kind))
        nodes.push(
          select(
            "Show empty cells as",
            spec.dispBlanksAs || "gap",
            [
              ["gap", "Gaps"],
              ["zero", "Zero"],
              ["span", "Connect data points with line"],
            ],
            (v) => set("dispBlanksAs", v),
          ),
        );
      break;
    case "plotArea":
      nodes.push(
        el("h3", {}, "Fill and outline"),
        color("Plot fill", spec.plotAreaFill, (c) => set("plotAreaFill", c)),
        color("Plot outline", spec.plotAreaStrokeColor, (c) =>
          set("plotAreaStrokeColor", c),
        ),
      );
      break;
    case "title":
      nodes.push(
        el("h3", {}, "Title"),
        text("Title text", spec.title, (v) => set("title", v)),
        check("Overlay on the chart", spec.titleOverlay, (on) =>
          set("titleOverlay", on || undefined),
        ),
        ...textStyle("titleStyle", "Title text"),
      );
      break;
    case "legend":
      nodes.push(
        el("h3", {}, "Legend"),
        select(
          "Legend position",
          spec.legend?.position || "r",
          [
            ["t", "Top"],
            ["b", "Bottom"],
            ["l", "Left"],
            ["r", "Right"],
            ["tr", "Top Right"],
          ],
          (v) => setLegend({ position: v }),
        ),
        check("Overlay on the chart", spec.legend?.overlay, (on) =>
          setLegend({ overlay: on || undefined }),
        ),
        color("Legend fill", spec.legend?.fill, (c) => setLegend({ fill: c })),
        color("Legend outline", spec.legend?.strokeColor, (c) =>
          setLegend({ strokeColor: c }),
        ),
        h.numInput(
          "Legend text size (pt)",
          spec.legend?.textStyle?.sizePt ?? 10,
          (n) =>
            update(
              setLegend({
                textStyle: { ...(spec.legend?.textStyle || {}), sizePt: n },
              }),
              key("size"),
            ),
          6,
          48,
          1,
        ),
      );
      break;
    case "valueAxis": {
      const axis = spec.valueAxis || {};
      const setAxis = (patch) => (s) => {
        const next = { ...(s.valueAxis || {}), ...patch };
        for (const k of Object.keys(next))
          if (next[k] === undefined) delete next[k];
        return set("valueAxis", Object.keys(next).length ? next : undefined)(s);
      };
      nodes.push(
        el("h3", {}, "Bounds and units"),
        el(
          "div",
          { class: "field-grid" },
          optionalNumber("Minimum", axis.min, (n) => setAxis({ min: n })),
          optionalNumber("Maximum", axis.max, (n) => setAxis({ max: n })),
          optionalNumber(
            "Major unit",
            axis.majorUnit,
            (n) => setAxis({ majorUnit: n && n > 0 ? n : undefined }),
            { min: 0, step: 0.1 },
          ),
          optionalNumber(
            "Minor unit",
            axis.minorUnit,
            (n) => setAxis({ minorUnit: n && n > 0 ? n : undefined }),
            { min: 0, step: 0.1 },
          ),
        ),
        select(
          "Display units",
          axis.displayUnits || "",
          [
            ["", "None"],
            ["hundreds", "Hundreds"],
            ["thousands", "Thousands"],
            ["millions", "Millions"],
            ["billions", "Billions"],
          ],
          (v) => setAxis({ displayUnits: v || undefined }),
        ),
        select(
          "Number format",
          axis.numberFormat || "",
          [
            ["", "Linked to data"],
            ["General", "General"],
            ["0", "Number, no decimals"],
            ["0.0", "Number, 1 decimal"],
            ["0.00", "Number, 2 decimals"],
            ["#,##0", "Thousands separator"],
            ["0%", "Percentage"],
            ["$#,##0", "Currency"],
          ],
          (v) =>
            setAxis(
              v
                ? { numberFormat: v, numberFormatSourceLinked: false }
                : {
                    numberFormat: undefined,
                    numberFormatSourceLinked: undefined,
                  },
            ),
        ),
        check("Logarithmic scale", axis.logBase, (on) =>
          setAxis({ logBase: on ? 10 : undefined }),
        ),
        check(
          "Values in reverse order",
          spec.valueAxisOrientation === "maxMin",
          (on) => set("valueAxisOrientation", on ? "maxMin" : undefined),
        ),
        check("Hide this axis", spec.valueAxisHidden, (on) =>
          set("valueAxisHidden", on || undefined),
        ),
        text("Axis title", spec.valueAxisTitle, (v) =>
          set("valueAxisTitle", v || undefined),
        ),
        color("Axis line", spec.valueAxisLineColor, (c) =>
          set("valueAxisLineColor", c),
        ),
        select(
          "Major tick marks",
          spec.valueAxisMajorTickMark || "none",
          [
            ["none", "None"],
            ["out", "Outside"],
            ["in", "Inside"],
            ["cross", "Cross"],
          ],
          (v) => set("valueAxisMajorTickMark", v),
        ),
        ...textStyle("valueAxisLabelStyle", "Axis labels"),
      );
      break;
    }
    case "categoryAxis":
      nodes.push(
        el("h3", {}, "Axis options"),
        check(
          isXYKind(spec.kind)
            ? "Values in reverse order"
            : "Categories in reverse order",
          spec.categoryAxisOrientation === "maxMin",
          (on) => set("categoryAxisOrientation", on ? "maxMin" : undefined),
        ),
        check("Hide this axis", spec.categoryAxisHidden, (on) =>
          set("categoryAxisHidden", on || undefined),
        ),
        text("Axis title", spec.categoryAxisTitle, (v) =>
          set("categoryAxisTitle", v || undefined),
        ),
        color("Axis line", spec.categoryAxisLineColor, (c) =>
          set("categoryAxisLineColor", c),
        ),
        ...(isXYKind(spec.kind)
          ? []
          : [
              optionalNumber(
                "Label every",
                spec.categoryAxisTickLabelSkip,
                (n) =>
                  set(
                    "categoryAxisTickLabelSkip",
                    n && n >= 1 ? Math.round(n) : undefined,
                  ),
                { min: 1, step: 1 },
              ),
            ]),
        select(
          "Major tick marks",
          spec.categoryAxisMajorTickMark || "none",
          [
            ["none", "None"],
            ["out", "Outside"],
            ["in", "Inside"],
            ["cross", "Cross"],
          ],
          (v) => set("categoryAxisMajorTickMark", v),
        ),
        ...textStyle("categoryAxisLabelStyle", "Axis labels"),
      );
      break;
    case "gridlines":
      nodes.push(
        el("h3", {}, "Gridlines"),
        check("Major gridlines", spec.valueAxisMajorGridlines ?? true, (on) =>
          set("valueAxisMajorGridlines", on),
        ),
        color(
          "Major gridline color",
          spec.valueAxisMajorGridlineColor,
          (c) => set("valueAxisMajorGridlineColor", c),
          { none: false },
        ),
        h.numInput(
          "Major gridline width (pt)",
          (spec.valueAxisMajorGridlineWidthEmu ?? 9525) / PT,
          (n) =>
            update(
              set("valueAxisMajorGridlineWidthEmu", Math.round(n * PT)),
              key("gw"),
            ),
          0,
          10,
          0.25,
        ),
        check("Minor gridlines", spec.valueAxisMinorGridlines, (on) =>
          set("valueAxisMinorGridlines", on),
        ),
        color(
          "Minor gridline color",
          spec.valueAxisMinorGridlineColor,
          (c) => set("valueAxisMinorGridlineColor", c),
          { none: false },
        ),
        check(
          "Gridlines across categories",
          spec.categoryAxisMajorGridlines,
          (on) => set("categoryAxisMajorGridlines", on),
        ),
      );
      break;
    default: {
      const i = Number(element.split(":")[1]);
      const s = spec.series[i];
      if (!s) break;
      const kind = kindOf(spec, s);
      const lineLike =
        kind === "line" || kind === "scatter" || kind === "radar";
      nodes.push(
        el("h3", {}, "Series"),
        text("Series name", s.name, (v) => setSeries(i, { name: v })),
      );
      if (pies(spec)) {
        nodes.push(
          h.numInput(
            "Point explosion (%)",
            Math.max(0, ...(s.pointExplosions || [0]).map((v) => v || 0)),
            (n) =>
              update(
                setSeries(i, {
                  pointExplosions:
                    n > 0 ? s.values.map(() => Math.round(n)) : undefined,
                }),
                key("explode"),
              ),
            0,
            100,
            1,
          ),
        );
        const n = Math.max(spec.categories.length, s.values.length);
        nodes.push(el("h3", {}, "Slice colors"));
        for (let p = 0; p < n; p++)
          nodes.push(
            color(
              `Slice "${spec.categories[p] ?? p + 1}"`,
              s.pointColors?.[p] ?? undefined,
              (c) => {
                const colors = Array.from(
                  { length: n },
                  (_, j) => s.pointColors?.[j] ?? null,
                );
                colors[p] = c ?? null;
                return setSeries(i, {
                  pointColors: colors.some((v) => v) ? colors : undefined,
                });
              },
              { none: false },
            ),
          );
      } else {
        if (!lineLike || spec.radarStyle === "filled")
          nodes.push(
            color(
              "Fill",
              s.color,
              (c) => setSeries(i, { color: c ?? undefined }),
              { none: false },
            ),
          );
        nodes.push(
          color(lineLike ? "Line" : "Outline", s.lineColor, (c) =>
            setSeries(
              i,
              lineLike && c ? { lineColor: c, color: c } : { lineColor: c },
            ),
          ),
          h.numInput(
            lineLike ? "Line width (pt)" : "Outline width (pt)",
            (s.lineWidthEmu ?? (lineLike ? 28575 : 0)) / PT,
            (n) =>
              update(
                setSeries(i, { lineWidthEmu: Math.round(n * PT) }),
                key("lw"),
              ),
            0,
            20,
            0.25,
          ),
          select(
            "Dash type",
            s.lineDash || "solid",
            [
              ["solid", "Solid"],
              ["dash", "Dash"],
              ["sysDot", "Round dot"],
              ["sysDash", "Square dot"],
              ["dashDot", "Dash dot"],
              ["lgDash", "Long dash"],
            ],
            (v) => setSeries(i, { lineDash: v === "solid" ? undefined : v }),
          ),
        );
        if (lineLike && spec.radarStyle !== "filled")
          nodes.push(
            select(
              "Marker",
              s.markerSymbol || "auto",
              [
                ["auto", "Automatic"],
                ["none", "None"],
                ["circle", "Circle"],
                ["square", "Square"],
                ["diamond", "Diamond"],
                ["triangle", "Triangle"],
                ["x", "X"],
                ["plus", "Plus"],
                ["star", "Star"],
              ],
              (v) =>
                setSeries(i, { markerSymbol: v === "auto" ? undefined : v }),
            ),
            h.numInput(
              "Marker size",
              s.markerSizePt ?? 5,
              (n) =>
                update(
                  setSeries(i, {
                    markerSizePt: Math.round(Math.max(2, Math.min(72, n))),
                  }),
                  key("ms"),
                ),
              2,
              72,
              1,
            ),
            check("Smoothed line", s.smooth, (on) =>
              setSeries(i, { smooth: on || undefined }),
            ),
          );
        if (kind === "bar" || kind === "column")
          nodes.push(
            check("Invert if negative", s.invertIfNegative, (on) =>
              setSeries(i, { invertIfNegative: on }),
            ),
          );
        if (
          !isXYKind(spec.kind) &&
          spec.kind !== "radar" &&
          spec.series.length > 1
        )
          nodes.push(
            check("Plot on secondary axis", s.secondaryAxis, (on) =>
              setSeries(i, { secondaryAxis: on || undefined }),
            ),
          );
      }
      // Labels for this series.
      const dl = s.dataLabels || spec.dataLabels || {};
      const setLabels = (patch) => (sp) => {
        const base = {
          showValue: false,
          showCategory: false,
          showSeriesName: false,
          showPercent: false,
          ...(sp.series[i].dataLabels || sp.dataLabels || {}),
          ...patch,
        };
        if (base.position === "") delete base.position;
        return setSeries(i, { dataLabels: base })(sp);
      };
      nodes.push(
        el("h3", {}, "Data labels"),
        el(
          "div",
          { class: "chart-check-grid" },
          check("Value", dl.showValue, (on) => setLabels({ showValue: on })),
          check("Category name", dl.showCategory, (on) =>
            setLabels({ showCategory: on }),
          ),
          check("Series name", dl.showSeriesName, (on) =>
            setLabels({ showSeriesName: on }),
          ),
          ...(pies(spec)
            ? [
                check("Percentage", dl.showPercent, (on) =>
                  setLabels({ showPercent: on }),
                ),
              ]
            : []),
        ),
      );
      const positions = labelPositions(spec).filter(([v]) => v !== "show");
      if (positions.length)
        nodes.push(
          select(
            "Label position",
            dl.position || "",
            [["", "Automatic"], ...positions],
            (v) => setLabels({ position: v }),
          ),
        );
      if (supportsTrendline(spec) && !pies(spec))
        nodes.push(
          el("h3", {}, "Analysis"),
          select(
            "Trendline",
            s.trendline
              ? s.trendline.forward
                ? "forecast"
                : s.trendline.type
              : "none",
            [["none", "None"], ...TRENDLINES.map(([id, label]) => [id, label])],
            (v) => (sp) => setTrendline(sp, v, i),
          ),
        );
      if (supportsErrorBars(spec))
        nodes.push(
          select(
            "Error bars",
            s.errorBars ? errorBarState({ series: [s] }) : "none",
            [["none", "None"], ...ERROR_BARS.map(([id, label]) => [id, label])],
            (v) => (sp) => {
              const all = setErrorBars(sp, v);
              return setSeries(i, { errorBars: all.series[i].errorBars })(sp);
            },
          ),
        );
    }
  }
  return nodes;
}
