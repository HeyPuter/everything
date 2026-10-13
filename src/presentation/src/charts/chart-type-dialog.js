// The chart type picker, for Insert Chart and Change Chart Type: chart
// families down the side, the family's types as pictures across the top, and
// a live preview of the chart as it will look. A custom combination lets
// each series take its own kind and axis.
import { el, dialog } from "../ui.js";
import { icon } from "../ui.js";
import {
  CHART_FAMILIES,
  CHART_TYPES,
  chartType,
  comboSpec,
  convertChart,
  sampleSpec,
} from "./chart-data.js";
import { chartThumbSvg } from "./chart-thumbs.js";
import { chartImage } from "./chart-render.js";

const svgNode = (markup) => {
  const t = document.createElement("template");
  t.innerHTML = markup;
  return t.content.firstChild;
};
const COMBO_KINDS = [
  ["column", "Clustered Column"],
  ["line", "Line"],
  ["area", "Area"],
];

// Resolves to the chart definition chosen, or null. With `spec`, the
// chart's own data is shown in each type; without, sample data.
export async function chooseChartType({
  title = "Insert Chart",
  confirm = "Insert",
  spec = null,
  current = "column-clustered",
  theme = null,
  accents = undefined,
  aspect = 16 / 9,
}) {
  let typeId = chartType(current) ? current : "column-clustered";
  let family = chartType(typeId).family;
  const seriesCount = spec ? spec.series.length : 3;
  let combo = Array.from({ length: seriesCount }, (_, i) => {
    const s = spec?.series[i];
    return {
      kind:
        s?.chartKind ||
        (spec && spec.kind !== "column" && ["line", "area"].includes(spec.kind)
          ? spec.kind
          : i === seriesCount - 1
            ? "line"
            : "column"),
      secondary: !!s?.secondaryAxis,
    };
  });
  const specFor = (id) => {
    const type = chartType(id);
    if (type.custom) {
      const base = spec || sampleSpec("column-clustered");
      return comboSpec(base, combo);
    }
    return spec ? convertChart(spec, id) : sampleSpec(id);
  };

  const families = el("div", {
    class: "chart-families",
    role: "tablist",
    "aria-orientation": "vertical",
    "aria-label": "Chart families",
  });
  const subtypes = el("div", { class: "chart-subtypes", role: "radiogroup" });
  const name = el("h3", { class: "chart-type-name", id: "chart-type-name" });
  const image = el("img", { class: "chart-type-preview", alt: "" });
  const note = el("p", { class: "chart-type-note helper" });
  const comboBox = el("div", { class: "chart-combo" });
  const main = el(
    "div",
    {
      class: "chart-type-main",
      role: "tabpanel",
      "aria-labelledby": "chart-type-name",
    },
    subtypes,
    name,
    el("div", { class: "chart-type-stage" }, image),
    note,
    comboBox,
  );
  const body = el(
    "form",
    { class: "dialog-body chart-type-picker" },
    families,
    main,
  );

  function drawFamilies() {
    families.replaceChildren(
      ...CHART_FAMILIES.map((f) =>
        el(
          "button",
          {
            type: "button",
            role: "tab",
            class: "chart-family",
            "aria-selected": String(f.id === family),
            tabindex: f.id === family ? 0 : -1,
            "data-family": f.id,
            onclick: () => pickFamily(f.id),
          },
          icon(`o:${f.icon}`, 20),
          el("span", {}, f.label),
        ),
      ),
    );
  }
  function pickFamily(id, focus = false) {
    family = id;
    if (chartType(typeId).family !== id)
      typeId = CHART_TYPES.find((t) => t.family === id).id;
    drawFamilies();
    drawTypes();
    if (focus) families.querySelector('[aria-selected="true"]')?.focus();
  }
  function drawTypes() {
    const list = CHART_TYPES.filter((t) => t.family === family);
    subtypes.setAttribute(
      "aria-label",
      `${CHART_FAMILIES.find((f) => f.id === family).label} chart types`,
    );
    subtypes.replaceChildren(
      ...list.map((t) =>
        el(
          "button",
          {
            type: "button",
            role: "radio",
            class: "chart-subtype",
            "aria-checked": String(t.id === typeId),
            "aria-label": t.label,
            title: t.label,
            tabindex: t.id === typeId ? 0 : -1,
            "data-type": t.id,
            onclick: () => pickType(t.id),
            ondblclick: () => {
              pickType(t.id);
              body
                .closest("dialog")
                ?.querySelector(".dialog-actions .primary")
                ?.click();
            },
          },
          svgNode(chartThumbSvg(t.id, accents)),
        ),
      ),
    );
    drawPreview();
  }
  function pickType(id, focus = false) {
    typeId = id;
    for (const b of subtypes.children) {
      const on = b.dataset.type === id;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    drawPreview();
  }
  function drawPreview() {
    const type = chartType(typeId);
    name.textContent = type.label;
    let next = null;
    try {
      next = specFor(typeId);
    } catch {}
    const url = next && chartImage(next, { theme, aspect });
    image.hidden = !url;
    if (url) image.src = url;
    image.alt = `Preview of a ${type.label.toLowerCase()} chart`;
    note.textContent =
      type.family === "pie" &&
      (spec?.series.length ?? 1) > 1 &&
      type.id !== "doughnut"
        ? "A pie chart shows the first series only."
        : "";
    comboBox.replaceChildren();
    if (type.custom) drawCombo();
  }
  function drawCombo() {
    const names = spec
      ? spec.series.map((s) => s.name)
      : sampleSpec("column-clustered").series.map((s) => s.name);
    comboBox.append(
      el("h4", {}, "Choose the chart type and axis for each series"),
      el(
        "div",
        { class: "chart-combo-rows", role: "group", "aria-label": "Series" },
        ...names.map((n, i) =>
          el(
            "div",
            { class: "chart-combo-row" },
            el("span", { class: "chart-combo-name" }, n),
            el(
              "select",
              {
                class: "input",
                "aria-label": `Chart type for ${n}`,
                onchange: (e) => {
                  combo[i] = { ...combo[i], kind: e.target.value };
                  drawPreviewOnly();
                },
              },
              ...COMBO_KINDS.map(([v, l]) =>
                el("option", { value: v, selected: combo[i].kind === v }, l),
              ),
            ),
            el(
              "label",
              { class: "check-field" },
              el("input", {
                type: "checkbox",
                checked: combo[i].secondary,
                "aria-label": `Secondary axis for ${n}`,
                onchange: (e) => {
                  combo[i] = { ...combo[i], secondary: e.target.checked };
                  drawPreviewOnly();
                },
              }),
              el("span", {}, "Secondary axis"),
            ),
          ),
        ),
      ),
    );
  }
  function drawPreviewOnly() {
    try {
      const url = chartImage(specFor(typeId), { theme, aspect });
      image.hidden = !url;
      if (url) image.src = url;
    } catch {}
  }

  // Arrow keys move within the family list and the type pictures.
  families.addEventListener("keydown", (e) => {
    const ids = CHART_FAMILIES.map((f) => f.id);
    const at = ids.indexOf(family);
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      pickFamily(e.key === "Home" ? ids[0] : ids[ids.length - 1], true);
      return;
    }
    if (!step) return;
    e.preventDefault();
    pickFamily(ids[(at + step + ids.length) % ids.length], true);
  });
  subtypes.addEventListener("keydown", (e) => {
    const ids = CHART_TYPES.filter((t) => t.family === family).map((t) => t.id);
    const at = ids.indexOf(typeId);
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    pickType(ids[(at + step + ids.length) % ids.length], true);
  });

  drawFamilies();
  drawTypes();
  const result = dialog({ title, body, confirm });
  body.closest("dialog")?.classList.add("chart-type-dialog");
  requestAnimationFrame(() =>
    subtypes.querySelector('[aria-checked="true"]')?.focus(),
  );
  if (!(await result)) return null;
  try {
    return { typeId, spec: specFor(typeId) };
  } catch {
    return null;
  }
}
