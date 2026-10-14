// Small building blocks shared by the format dialogs and the Format pane:
// labelled number fields with units, selects, checkboxes, color buttons that
// open the palette, sliders paired with a number, segmented choices, tabs,
// collapsible sections, galleries, and a modal dialog with OK and Cancel.
import { el, icon, openMenu, closeMenu } from "../ui.js";
import { colorMenuItems } from "../color-palette.js";
import "./format.css";

let uid = 0;
export const nextId = (prefix = "fmt") => `${prefix}-${++uid}`;

const round = (n, places = 2) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * A number field with a unit ("pt", "%", "°", "in"). Commits on change
 * (Enter, blur, or the steppers) with the value clamped to its range.
 */
export function numberField({
  label,
  value,
  unit = "",
  min = -Infinity,
  max = Infinity,
  step = 1,
  places = 2,
  disabled = false,
  onCommit,
  hideLabel = false,
  id = nextId("num"),
}) {
  const input = el("input", {
    id,
    type: "number",
    class: "input fmt-number",
    inputmode: "decimal",
    step,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    value: value == null || value === "" ? "" : round(value, places),
    "aria-label": hideLabel ? label : null,
    disabled,
  });
  input.addEventListener("change", () => {
    let n = input.valueAsNumber;
    if (!Number.isFinite(n)) {
      input.value = input.defaultValue;
      return;
    }
    // The range can change after the field is made (a unit switch).
    const lo = input.min === "" ? -Infinity : Number(input.min);
    const hi = input.max === "" ? Infinity : Number(input.max);
    n = Math.max(lo, Math.min(hi, n));
    input.value = String(round(n, places));
    input.defaultValue = input.value;
    onCommit?.(n);
  });
  input.defaultValue = input.value;
  const wrap = el(
    "div",
    { class: "fmt-number-wrap" },
    input,
    unit && el("span", { class: "fmt-unit", "aria-hidden": "true" }, unit),
  );
  if (hideLabel) return wrap;
  return el(
    "div",
    { class: "fmt-field" },
    el("label", { for: id }, label),
    wrap,
  );
}

/** A labelled select. `options` are [value, label] pairs. */
export function selectField({
  label,
  value,
  options,
  onChange,
  disabled = false,
  hideLabel = false,
  id = nextId("sel"),
}) {
  const select = el(
    "select",
    {
      id,
      class: "input fmt-select",
      disabled,
      "aria-label": hideLabel ? label : null,
      onchange: (e) => onChange?.(e.target.value),
    },
    ...options.map(([v, text]) => el("option", { value: v }, text)),
  );
  if (value != null && !options.some(([v]) => String(v) === String(value)))
    select.prepend(el("option", { value }, String(value)));
  select.value = value == null ? "" : String(value);
  if (hideLabel) return select;
  return el(
    "div",
    { class: "fmt-field" },
    el("label", { for: id }, label),
    select,
  );
}

/** A checkbox with its label; `mixed` shows the indeterminate state. */
export function checkField({
  label,
  checked,
  mixed = false,
  onChange,
  disabled = false,
}) {
  const input = el("input", { type: "checkbox", checked: !!checked, disabled });
  input.indeterminate = mixed;
  input.addEventListener("change", () => onChange?.(input.checked));
  return el("label", { class: "fmt-check" }, input, el("span", {}, label));
}

/** A row of mutually exclusive choices, a radio group drawn as buttons. */
export function segmented({
  label,
  value,
  options,
  onChange,
  compact = false,
}) {
  const group = el("div", {
    class: `fmt-segmented${compact ? " compact" : ""}`,
    role: "radiogroup",
    "aria-label": label,
  });
  const buttons = options.map(([v, text, ic]) =>
    el(
      "button",
      {
        type: "button",
        role: "radio",
        "aria-checked": String(v === value),
        tabindex:
          v === value || (value == null && v === options[0][0]) ? 0 : -1,
        title: ic ? text : null,
        "aria-label": ic ? text : null,
        onclick: () => choose(v),
      },
      ic ? icon(ic, 16) : text,
    ),
  );
  function choose(v) {
    buttons.forEach((b, i) => {
      const on = options[i][0] === v;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    onChange?.(v);
  }
  group.addEventListener("keydown", (e) => {
    const at = buttons.indexOf(document.activeElement);
    if (at < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
      e.key
    ];
    if (!step) return;
    e.preventDefault();
    const next = buttons[(at + step + buttons.length) % buttons.length];
    next.focus();
    next.click();
  });
  group.append(...buttons);
  return group;
}

/**
 * A slider with its number beside it; both commit on release or Enter.
 * `format` turns the value into what the number box shows.
 */
export function sliderField({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = "",
  disabled = false,
  onCommit,
  onInput,
}) {
  const id = nextId("rng");
  const range = el("input", {
    id,
    type: "range",
    min,
    max,
    step,
    value: value ?? min,
    disabled,
  });
  const number = numberField({
    label,
    value: value ?? min,
    unit,
    min,
    max,
    step,
    disabled,
    hideLabel: true,
    onCommit: (n) => {
      range.value = String(n);
      onCommit?.(n);
    },
  });
  range.addEventListener("input", () => {
    number.querySelector("input").value = range.value;
    onInput?.(Number(range.value));
  });
  range.addEventListener("change", () => onCommit?.(Number(range.value)));
  return el(
    "div",
    { class: "fmt-field fmt-slider" },
    el("label", { for: id }, label),
    el("div", { class: "fmt-slider-row" }, range, number),
  );
}

/** The CSS color a stored color value shows as. */
export function cssColor(value, theme) {
  if (!value) return null;
  if (!String(value).startsWith("scheme:"))
    return value.startsWith("#") ? value : `#${value}`;
  if (!theme) return null;
  const [token, ...mods] = value.slice(7).split("/");
  const key =
    { bg1: "light1", tx1: "dark1", bg2: "light2", tx2: "dark2" }[token] ||
    token;
  let hex = `#${String(theme[key] || "000000").replace("#", "")}`;
  const mod = Object.fromEntries(mods.map((m) => m.split("=")));
  if (mod.lumMod || mod.lumOff)
    hex = lumAdjust(hex, Number(mod.lumMod ?? 100000), Number(mod.lumOff ?? 0));
  return hex;
}
function lumAdjust(hex, lumMod, lumOff) {
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h =
      max === r
        ? (g - b) / d + (g < b ? 6 : 0)
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    h /= 6;
  }
  l = Math.min(1, Math.max(0, (l * lumMod) / 100000 + lumOff / 100000));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
    p = 2 * l - q;
  const hue = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const rgb = s ? [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)] : [l, l, l];
  return `#${rgb
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}

/**
 * A button showing a color that opens the palette. `onPick(value, hex)`
 * receives "#RRGGBB" or a theme reference; `none` and `automatic` add those
 * choices (each `{ label, value }`).
 */
export function colorButton({
  label,
  value,
  theme,
  onPick,
  none = null,
  automatic = null,
  disabled = false,
  hideLabel = false,
}) {
  const id = nextId("clr");
  const shown = cssColor(value, theme);
  const swatch = el("span", {
    class: `fmt-swatch${shown ? "" : automatic && !none ? " auto" : " empty"}`,
    style: shown ? `background:${shown}` : null,
  });
  const button = el(
    "button",
    {
      id,
      type: "button",
      class: "btn secondary fmt-color",
      "aria-haspopup": "menu",
      "aria-label": `${label}: ${shown ? shown.toUpperCase() : none ? none.label : "Automatic"}`,
      disabled,
      onclick: () =>
        openMenu({
          anchor: button,
          label,
          items: colorMenuItems({
            theme,
            current: shown,
            onPick: (v, hex) => {
              swatch.style.background = hex;
              swatch.classList.remove("empty");
              onPick(v, hex);
            },
            none: none && {
              label: none.label,
              icon: "Ban",
              onSelect: () => {
                swatch.classList.add("empty");
                swatch.style.background = "";
                onPick(none.value ?? null, null);
              },
            },
            automatic: automatic && {
              label: automatic.label,
              icon: "o:textColor",
              onSelect: () => {
                const auto = cssColor(automatic.value, theme);
                swatch.style.background = auto || "";
                swatch.classList.toggle("auto", !auto);
                swatch.classList.remove("empty");
                onPick(automatic.value, auto);
              },
            },
          }),
        }),
    },
    swatch,
    el("span", { class: "fmt-caret", "aria-hidden": "true" }),
  );
  if (hideLabel) return button;
  return el(
    "div",
    { class: "fmt-field" },
    el("label", { for: id }, label),
    button,
  );
}

/** Tabs: [{ id, label, render() }]; the panel renders lazily. */
export function tabs(list, { label = "Sections", initial = 0, onChange } = {}) {
  const bar = el("div", {
    class: "fmt-tabs",
    role: "tablist",
    "aria-label": label,
  });
  const panels = el("div", { class: "fmt-tab-panels" });
  const ids = list.map(() => nextId("tab"));
  const buttons = list.map((tab, i) =>
    el(
      "button",
      {
        type: "button",
        role: "tab",
        id: ids[i],
        "aria-controls": `${ids[i]}-panel`,
        onclick: () => select(i, true),
      },
      tab.label,
    ),
  );
  const rendered = [];
  function select(i, focus = false) {
    buttons.forEach((b, k) => {
      b.setAttribute("aria-selected", String(k === i));
      b.tabIndex = k === i ? 0 : -1;
    });
    if (!rendered[i]) {
      rendered[i] = el(
        "div",
        {
          role: "tabpanel",
          id: `${ids[i]}-panel`,
          "aria-labelledby": ids[i],
          class: "fmt-tab-panel",
        },
        list[i].render(),
      );
      panels.append(rendered[i]);
    }
    rendered.forEach((p, k) => p && (p.hidden = k !== i));
    if (focus) buttons[i].focus();
    onChange?.(i);
  }
  bar.addEventListener("keydown", (e) => {
    const at = buttons.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (at < 0 || !step) return;
    e.preventDefault();
    select((at + step + buttons.length) % buttons.length, true);
  });
  bar.append(...buttons);
  select(initial);
  return { node: el("div", { class: "fmt-tabbed" }, bar, panels), select };
}

/** A collapsible section; its open state is kept per key for the session. */
const openSections = new Map();
export function section(title, children, { key = title, open = false } = {}) {
  const details = el(
    "details",
    { class: "fmt-section", "data-section": key },
    el("summary", {}, el("span", {}, title)),
    el("div", { class: "fmt-section-body" }, ...children),
  );
  details.open = openSections.has(key) ? openSections.get(key) : open;
  details.addEventListener("toggle", () => openSections.set(key, details.open));
  // Remembered at once too, so a refresh that follows the click keeps it.
  details
    .querySelector("summary")
    .addEventListener("click", () => openSections.set(key, !details.open));
  return details;
}

/**
 * A grid of choices for menus and galleries with arrow-key navigation:
 * items are { label, render(): Node, checked?, onSelect }.
 */
export function galleryGrid(
  items,
  { label, columns = 4, cellClass = "" } = {},
) {
  const grid = el("div", {
    class: "fmt-gallery",
    role: "group",
    "aria-label": label,
    style: `--fmt-columns:${columns}`,
  });
  const cells = items.map((item) =>
    el(
      "button",
      {
        type: "button",
        class: `fmt-gallery-cell ${cellClass} ${item.checked ? "checked" : ""}`,
        role: "menuitemradio",
        "aria-checked": String(!!item.checked),
        "aria-label": item.label,
        title: item.label,
        tabindex: -1,
        onclick: () => {
          closeMenu();
          item.onSelect();
        },
      },
      item.render(),
    ),
  );
  grid.addEventListener("keydown", (e) => {
    const at = cells.indexOf(document.activeElement);
    const step = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns,
      ArrowUp: -columns,
    }[e.key];
    if (at < 0 || !step) return;
    const next = cells[at + step];
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    next.focus();
  });
  grid.append(...cells);
  return grid;
}

/**
 * A modal dialog with OK and Cancel. `body` is a node; `onOk()` runs on OK
 * and may return false to keep the dialog open. Resolves to whether OK was
 * chosen. `extra` adds buttons to the left of the actions.
 */
export function formatDialog({
  title,
  body,
  onOk,
  okLabel = "OK",
  wide = false,
  extra = [],
  className = "",
}) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const titleId = nextId("dlg");
    const d = el("dialog", {
      class: `dialog format-dialog ${wide ? "wide" : ""} ${className}`,
      "aria-labelledby": titleId,
    });
    const finish = async (ok) => {
      if (ok && onOk && (await onOk()) === false) return;
      d.close();
      d.remove();
      before?.focus?.();
      resolve(ok);
    };
    const form = el(
      "form",
      { class: "format-dialog-body", method: "dialog" },
      body,
      el("button", {
        type: "submit",
        hidden: true,
        tabindex: -1,
        "aria-hidden": "true",
      }),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      finish(true);
    });
    d.append(
      el(
        "div",
        { class: "dialog-head" },
        el("h2", { id: titleId }, title),
        el(
          "button",
          {
            type: "button",
            class: "btn icon-btn",
            "aria-label": "Close",
            title: "Close",
            onclick: () => finish(false),
          },
          icon("X", 18),
        ),
      ),
      form,
      el(
        "div",
        { class: "dialog-actions" },
        extra.length
          ? el("div", { class: "fmt-extra-actions" }, ...extra)
          : null,
        el(
          "button",
          {
            type: "button",
            class: "btn secondary",
            onclick: () => finish(false),
          },
          "Cancel",
        ),
        el(
          "button",
          { type: "button", class: "btn primary", onclick: () => finish(true) },
          okLabel,
        ),
      ),
    );
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    document.body.append(d);
    d.showModal();
    d.querySelector(
      "[autofocus], .format-dialog-body input:not([type=hidden]), .format-dialog-body select, .format-dialog-body button",
    )?.focus();
  });
}

/** Points ⇄ EMU and inches ⇄ EMU. */
export const PT = 12700;
export const IN = 914400;
export const toPt = (emu) => (emu ?? 0) / PT;
export const toIn = (emu) => (emu ?? 0) / IN;
