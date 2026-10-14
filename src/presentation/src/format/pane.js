// The Format pane's detailed sections: Fill & Line, Effects, Size &
// Properties, Picture, and Text Options. Each section reads the selected
// object's settings and writes a change as one undoable step. The pane's
// basic controls (colour, font, position) stay where they were; these
// sections sit beneath them, grouped, with a bar that jumps between groups.
import { el } from "../ui.js";
import {
  IN,
  PT,
  checkField,
  colorButton,
  cssColor,
  numberField,
  section,
  segmented,
  selectField,
  sliderField,
} from "./controls.js";
import {
  BEVELS,
  GLOW_ACCENTS,
  REFLECTION_PRESETS,
  ROTATION_PRESETS,
  SHADOW_PRESETS,
  SOFT_EDGE_SIZES,
} from "./effects.js";
import { nativePatternPaths } from "../../lib/pptx-preview/src/pattern-cells.ts";
import { TEXTURES, textureBytes } from "./textures.js";
import { imageSize } from "./image-size.js";

export const PATTERNS = [
  "pct5",
  "pct10",
  "pct20",
  "pct25",
  "pct30",
  "pct40",
  "pct50",
  "pct60",
  "pct70",
  "pct75",
  "pct80",
  "pct90",
  "ltHorz",
  "ltVert",
  "ltDnDiag",
  "ltUpDiag",
  "smGrid",
  "smCheck",
  "dkHorz",
  "dkVert",
  "dkDnDiag",
  "dkUpDiag",
  "lgGrid",
  "lgCheck",
  "narHorz",
  "narVert",
  "wdDnDiag",
  "wdUpDiag",
  "dotGrid",
  "solidDmnd",
  "dashHorz",
  "dashVert",
  "dashDnDiag",
  "dashUpDiag",
  "openDmnd",
  "dotDmnd",
  "smConfetti",
  "lgConfetti",
  "horzBrick",
  "diagBrick",
  "weave",
  "plaid",
  "divot",
  "shingle",
  "wave",
  "trellis",
  "zigZag",
  "sphere",
];

const DASHES = [
  ["solid", "Solid"],
  ["sysDot", "Round dot"],
  ["sysDash", "Square dot"],
  ["dash", "Dash"],
  ["dashDot", "Dash dot"],
  ["lgDash", "Long dash"],
  ["lgDashDot", "Long dash dot"],
  ["lgDashDotDot", "Long dash dot dot"],
];
const COMPOUNDS = [
  ["sng", "Single"],
  ["dbl", "Double"],
  ["thickThin", "Thick thin"],
  ["thinThick", "Thin thick"],
  ["tri", "Triple"],
];
const ARROW_TYPES = [
  ["none", "None"],
  ["triangle", "Triangle"],
  ["arrow", "Open arrow"],
  ["stealth", "Stealth"],
  ["diamond", "Diamond"],
  ["oval", "Oval"],
];
const ARROW_SIZES = [
  ["sm", "Small"],
  ["med", "Medium"],
  ["lg", "Large"],
];
const MATERIALS = [
  ["matte", "Matte"],
  ["warmMatte", "Warm matte"],
  ["plastic", "Plastic"],
  ["metal", "Metal"],
  ["dkEdge", "Dark edge"],
  ["softEdge", "Soft edge"],
  ["flat", "Flat"],
  ["softmetal", "Soft metal"],
  ["clear", "Clear"],
  ["powder", "Powder"],
  ["translucentPowder", "Translucent powder"],
];
const LIGHTS = [
  ["threePt", "Three point"],
  ["balanced", "Balanced"],
  ["soft", "Soft"],
  ["harsh", "Harsh"],
  ["flood", "Flood"],
  ["contrasting", "Contrasting"],
  ["morning", "Morning"],
  ["sunrise", "Sunrise"],
  ["sunset", "Sunset"],
  ["chilly", "Chilly"],
  ["freezing", "Freezing"],
  ["flat", "Flat"],
  ["twoPt", "Two point"],
  ["glow", "Glow"],
  ["brightRoom", "Bright room"],
];
export const ARTISTIC = [
  ["none", "None"],
  ["artisticBlur", "Blur"],
  ["artisticPencilGrayscale", "Pencil grayscale"],
  ["artisticPencilSketch", "Pencil sketch"],
  ["artisticLineDrawing", "Line drawing"],
  ["artisticPhotocopy", "Photocopy"],
  ["artisticGlowEdges", "Glowing edges"],
  ["artisticFilmGrain", "Film grain"],
  ["artisticCutout", "Cutout"],
  ["artisticPaintStrokes", "Paint strokes"],
  ["artisticMarker", "Marker"],
  ["artisticWatercolorSponge", "Watercolor sponge"],
  ["artisticPastelsSmooth", "Pastels smooth"],
];

const pct = (n) => Math.round((n ?? 0) * 100);
const hexOf = (v, theme) => cssColor(v, theme) || "#000000";

/** Mixes a hex color toward white (amount > 0) or black (< 0). */
export function shade(hex, amount) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const out = rgb.map((c) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)),
  );
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Gradient presets in a theme color: [label, (hex) => GradientFillOptions]. */
export const GRADIENT_PRESETS = [
  [
    "Light to color",
    (c) => ({
      stops: [
        { offset: 0, color: shade(c, 0.75) },
        { offset: 1, color: c },
      ],
      angleDeg: 90,
    }),
  ],
  [
    "Color to dark",
    (c) => ({
      stops: [
        { offset: 0, color: c },
        { offset: 1, color: shade(c, -0.45) },
      ],
      angleDeg: 90,
    }),
  ],
  [
    "Soft band",
    (c) => ({
      stops: [
        { offset: 0, color: shade(c, 0.5) },
        { offset: 0.5, color: c },
        { offset: 1, color: shade(c, 0.5) },
      ],
      angleDeg: 90,
    }),
  ],
  [
    "Diagonal",
    (c) => ({
      stops: [
        { offset: 0, color: shade(c, 0.4) },
        { offset: 1, color: shade(c, -0.3) },
      ],
      angleDeg: 45,
    }),
  ],
  [
    "Radial glow",
    (c) => ({
      stops: [
        { offset: 0, color: shade(c, 0.7) },
        { offset: 1, color: c },
      ],
      path: "circle",
      focus: { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 },
    }),
  ],
  [
    "Rectangular",
    (c) => ({
      stops: [
        { offset: 0, color: shade(c, 0.6) },
        { offset: 1, color: shade(c, -0.2) },
      ],
      path: "rect",
      focus: { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 },
    }),
  ],
  [
    "Fade out",
    (c) => ({
      stops: [
        { offset: 0, color: c },
        { offset: 1, color: c, opacity: 0 },
      ],
      angleDeg: 0,
    }),
  ],
];

const LINEAR_DIRECTIONS = [
  ["Linear down", 90],
  ["Linear diagonal down right", 45],
  ["Linear right", 0],
  ["Linear diagonal up right", 315],
  ["Linear up", 270],
  ["Linear diagonal up left", 225],
  ["Linear left", 180],
  ["Linear diagonal down left", 135],
];
const FOCUS_DIRECTIONS = [
  ["From center", { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 }],
  ["From top left corner", { left: 0, top: 0, right: 1, bottom: 1 }],
  ["From top right corner", { left: 1, top: 0, right: 0, bottom: 1 }],
  ["From bottom left corner", { left: 0, top: 1, right: 1, bottom: 0 }],
  ["From bottom right corner", { left: 1, top: 1, right: 0, bottom: 0 }],
];

/** A pattern drawn small, for the pattern picker. */
export function patternSwatch(preset, fg = "#000000", bg = "#FFFFFF") {
  const paths = nativePatternPaths(preset);
  const node = el("span", {
    class: "fmt-pattern-swatch",
    "aria-hidden": "true",
  });
  const id = `pt-${preset}-${Math.random().toString(36).slice(2, 7)}`;
  node.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><defs><pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="${bg}"/>${paths ? `<path d="${paths.foreground}" fill="${fg}"/>${paths.half ? `<path d="${paths.half}" fill="${fg}" fill-opacity="0.5"/>` : ""}` : ""}</pattern></defs><rect width="24" height="24" fill="url(#${id})"/></svg>`;
  return node;
}

// The group bar and group headings.
function groupHeading(id, title) {
  return el("h3", { class: "fmt-group-heading", id: `fmt-group-${id}` }, title);
}

/**
 * Builds the detailed format sections for one object. Returns nodes for the
 * inspector to append.
 */
export function formatPaneSections(ctx, obj) {
  const { P } = ctx;
  const pres = ctx.pres();
  const theme = ctx.theme();
  const kind = P.getShapeKind(obj);
  const isPicture = kind === "picture";
  const isShape = kind === "shape";
  const isLine = kind === "connector";
  const textCapable = ctx.canEditText(obj) && !ctx.isTable(obj);
  const imageFilled =
    isShape && P.getShapeFillEffective(pres, obj)?.kind === "image";
  const groups = [];
  const edit = (fn, key) =>
    ctx.mutateShape(
      obj,
      fn,
      key ? { coalesce: ctx.coalesce(key, obj) } : undefined,
    );
  const nodes = [];

  // ---- Fill & Line ---------------------------------------------------------
  if (isShape || isPicture || isLine) {
    groups.push(["fill", "Fill & Line"]);
    nodes.push(groupHeading("fill", "Fill & Line"));
    if (isShape) nodes.push(fillSection(ctx, obj, edit, theme));
    nodes.push(lineSection(ctx, obj, edit, theme, { isLine }));
  }

  // ---- Effects -------------------------------------------------------------
  if (isShape || isPicture || isLine) {
    groups.push(["effects", "Effects"]);
    nodes.push(
      groupHeading("effects", "Effects"),
      ...effectSections(ctx, obj, edit, theme),
    );
  }

  // ---- Size & Properties ---------------------------------------------------
  groups.push(["size", "Size & Properties"]);
  nodes.push(
    groupHeading("size", "Size & Properties"),
    sizeSection(ctx, obj, edit),
  );
  if (textCapable) nodes.push(textBoxSection(ctx, obj, edit));
  if (!isPicture) nodes.push(altTextSection(ctx, obj, edit));

  // ---- Picture -------------------------------------------------------------
  if (isPicture || imageFilled) {
    groups.push(["picture", "Picture"]);
    nodes.push(
      groupHeading("picture", "Picture"),
      ...pictureSections(ctx, obj, edit, { isPicture }),
    );
  }

  // ---- Text Options --------------------------------------------------------
  if (textCapable) {
    groups.push(["text", "Text Options"]);
    nodes.push(
      groupHeading("text", "Text Options"),
      ...textOptionSections(ctx, obj, theme),
    );
  }

  const bar = el(
    "nav",
    { class: "fmt-group-bar", "aria-label": "Format groups" },
    ...groups.map(([id, title]) =>
      el(
        "button",
        {
          type: "button",
          class: "fmt-group-link",
          onclick: (e) => {
            const panel = e.currentTarget.closest("#inspector") || document;
            const heading = panel.querySelector(`#fmt-group-${id}`);
            heading?.scrollIntoView({ block: "start", behavior: "smooth" });
            const first = heading?.nextElementSibling;
            if (first?.tagName === "DETAILS") first.open = true;
          },
        },
        title,
      ),
    ),
  );
  return [
    el("div", { class: "fmt-pane", "data-format-pane": "" }, bar, ...nodes),
  ];
}

// Opens the section a menu's "Options…" item points at.
export function revealSection(key) {
  const node = document.querySelector(
    `#inspector details[data-section="${key}"]`,
  );
  if (!node) return false;
  node.open = true;
  node.scrollIntoView({ block: "start" });
  node.querySelector("input,select,button")?.focus({ preventScroll: true });
  return true;
}

// ---------------------------------------------------------------------------
// Fill

function fillKindOf(ctx, obj) {
  const { P } = ctx;
  if (P.getShapeBackgroundFill(obj)) return "background";
  const fill = P.getShapeFillEffective(ctx.pres(), obj);
  return (
    {
      solid: "solid",
      gradient: "gradient",
      pattern: "pattern",
      image: "picture",
      none: "none",
    }[fill?.kind] || "none"
  );
}

function fillSection(ctx, obj, edit, theme) {
  const { P } = ctx;
  const pres = ctx.pres();
  const kind = fillKindOf(ctx, obj);
  const accent = hexOf("scheme:accent1", theme);
  const body = [];
  body.push(
    segmentedField(
      "Fill type",
      kind,
      [
        ["none", "No fill"],
        ["solid", "Solid"],
        ["gradient", "Gradient"],
        ["picture", "Picture or texture"],
        ["pattern", "Pattern"],
        ["background", "Slide background"],
      ],
      (v) => {
        if (v === kind) return;
        edit((s) => {
          if (P.getShapeBackgroundFill(s)) P.setShapeBackgroundFill(s, false);
          const current =
            hexOf(P.getShapeFillColorResolvedEffective(pres, s), theme) ||
            accent;
          if (v === "none") P.setShapeNoFill(s);
          else if (v === "solid") P.setShapeFill(s, current);
          else if (v === "gradient")
            P.setShapeGradientFill(s, GRADIENT_PRESETS[0][1](current));
          else if (v === "pattern")
            P.setShapePatternFill(s, {
              preset: "pct50",
              foreground: current,
              background: "#FFFFFF",
            });
          else if (v === "picture")
            P.setShapeImageFill(s, textureBytes(TEXTURES[0][0]));
          else if (v === "background") P.setShapeBackgroundFill(s, true);
        });
      },
    ),
  );
  if (kind === "solid") {
    const fill = P.getShapeFillEffective(pres, obj);
    const color = P.getShapeFillColorResolvedEffective(pres, obj) || accent;
    const opacity = fill?.opacity ?? 1;
    body.push(
      colorButton({
        label: "Fill color",
        hideLabel: false,
        value: color,
        theme,
        onPick: (v) =>
          edit((s) => P.setShapeFill(s, withAlpha(v, opacity, theme))),
      }),
      sliderField({
        label: "Fill transparency",
        value: pct(1 - opacity),
        unit: "%",
        onCommit: (n) =>
          edit(
            (s) => P.setShapeFill(s, withAlpha(color, 1 - n / 100, theme)),
            "fill-alpha",
          ),
      }),
    );
  }
  if (kind === "gradient")
    body.push(...gradientEditor(ctx, obj, edit, theme, accent));
  if (kind === "pattern") body.push(...patternEditor(ctx, obj, edit, theme));
  if (kind === "picture") body.push(...pictureFillEditor(ctx, obj, edit));
  return section("Fill", body, { key: "fill", open: true });
}

// A color value carrying an alpha modifier, as the engine writes it.
function withAlpha(value, opacity, theme) {
  const base = String(value).split("/")[0];
  const hex = base.startsWith("scheme:") ? base : cssColor(base, theme) || base;
  if (opacity >= 0.999) return hex;
  const mods = String(value)
    .split("/")
    .slice(1)
    .filter((m) => !m.startsWith("alpha="));
  return [
    hex,
    ...mods,
    `alpha=${Math.round(Math.max(0, opacity) * 100000)}`,
  ].join("/");
}

function segmentedField(label, value, options, onChange) {
  return el(
    "div",
    { class: "fmt-field" },
    el("span", { class: "fmt-label" }, label),
    segmented({ label, value, options, onChange, compact: true }),
  );
}

function gradientEditor(ctx, obj, edit, theme, accent) {
  const { P } = ctx;
  const pres = ctx.pres();
  const g =
    P.getShapeGradientFillEffective(pres, obj) ||
    GRADIENT_PRESETS[0][1](accent);
  const stops = g.stops.map((s) => ({
    offset: s.offset,
    color: hexOf(s.color, theme),
    opacity: s.opacity ?? 1,
  }));
  const type =
    g.path === "circle"
      ? "radial"
      : g.path === "rect"
        ? "rectangular"
        : g.path === "shape"
          ? "path"
          : "linear";
  const write = (next, key) =>
    edit((s) => P.setShapeGradientFill(s, next), key);
  const current = () => ({
    stops: stops.map((s) => ({
      offset: s.offset,
      color: s.color,
      ...(s.opacity < 1 ? { opacity: s.opacity } : {}),
    })),
    ...(type === "linear"
      ? { angleDeg: g.angleDeg ?? 90 }
      : { path: g.path, ...(g.focus ? { focus: g.focus } : {}) }),
  });
  let selected = Math.min(stops.length - 1, ctx.state.gradientStop ?? 0);
  const bar = el("div", {
    class: "fmt-gradient-bar",
    role: "group",
    "aria-label": "Gradient stops",
    style: `background:linear-gradient(90deg, ${stops
      .slice()
      .sort((a, b) => a.offset - b.offset)
      .map(
        (s) =>
          `${s.color}${
            s.opacity < 1
              ? Math.round(s.opacity * 255)
                  .toString(16)
                  .padStart(2, "0")
              : ""
          } ${pct(s.offset)}%`,
      )
      .join(", ")})`,
  });
  stops.forEach((s, i) =>
    bar.append(
      el("button", {
        type: "button",
        class: `fmt-gradient-stop${i === selected ? " selected" : ""}`,
        style: `left:${pct(s.offset)}%;background:${s.color}`,
        "aria-label": `Stop ${i + 1} of ${stops.length} at ${pct(s.offset)}%`,
        "aria-pressed": String(i === selected),
        onclick: () => {
          ctx.state.gradientStop = i;
          ctx.renderInspector();
        },
      }),
    ),
  );
  const stop = stops[selected];
  const out = [
    selectField({
      label: "Preset gradients",
      value: "",
      options: [
        ["", "Choose a preset…"],
        ...GRADIENT_PRESETS.map(([label], i) => [String(i), label]),
      ],
      onChange: (v) =>
        v !== "" &&
        write(GRADIENT_PRESETS[Number(v)][1](stop?.color || accent)),
    }),
    selectField({
      label: "Gradient type",
      value: type,
      options: [
        ["linear", "Linear"],
        ["radial", "Radial"],
        ["rectangular", "Rectangular"],
        ["path", "Path"],
      ],
      onChange: (v) => {
        const base = { stops: current().stops };
        write(
          v === "linear"
            ? { ...base, angleDeg: 90 }
            : {
                ...base,
                path: { radial: "circle", rectangular: "rect", path: "shape" }[
                  v
                ],
                focus: FOCUS_DIRECTIONS[0][1],
              },
        );
      },
    }),
    type === "linear"
      ? el(
          "div",
          { class: "fmt-row" },
          selectField({
            label: "Direction",
            value: String(
              LINEAR_DIRECTIONS.find(
                ([, a]) => Math.abs(a - (g.angleDeg ?? 90)) < 0.5,
              )?.[1] ?? "",
            ),
            options: [
              ["", "Custom"],
              ...LINEAR_DIRECTIONS.map(([label, a]) => [String(a), label]),
            ],
            onChange: (v) =>
              v !== "" && write({ ...current(), angleDeg: Number(v) }),
          }),
          numberField({
            label: "Gradient angle",
            value: g.angleDeg ?? 90,
            unit: "°",
            min: 0,
            max: 359.9,
            step: 5,
            onCommit: (n) =>
              write({ ...current(), angleDeg: n }, "gradient-angle"),
          }),
        )
      : type !== "path"
        ? selectField({
            label: "Direction",
            value: String(
              FOCUS_DIRECTIONS.findIndex(
                ([, f]) => JSON.stringify(f) === JSON.stringify(g.focus),
              ),
            ),
            options: FOCUS_DIRECTIONS.map(([label], i) => [String(i), label]),
            onChange: (v) =>
              write({ ...current(), focus: FOCUS_DIRECTIONS[Number(v)][1] }),
          })
        : null,
    bar,
    el(
      "div",
      { class: "fmt-row" },
      el(
        "button",
        {
          type: "button",
          class: "btn secondary small",
          "aria-label": "Add gradient stop",
          disabled: stops.length >= 10,
          onclick: () => {
            const sorted = stops.slice().sort((a, b) => a.offset - b.offset);
            const a = sorted[Math.max(0, sorted.indexOf(stop) - 0)];
            const b = sorted[sorted.indexOf(stop) + 1] || a;
            stops.push({
              offset: (a.offset + b.offset) / 2 || 0.5,
              color: a.color,
              opacity: a.opacity,
            });
            ctx.state.gradientStop = stops.length - 1;
            write(current());
          },
        },
        "Add stop",
      ),
      el(
        "button",
        {
          type: "button",
          class: "btn secondary small",
          "aria-label": "Remove gradient stop",
          disabled: stops.length <= 2,
          onclick: () => {
            stops.splice(selected, 1);
            ctx.state.gradientStop = Math.max(0, selected - 1);
            write(current());
          },
        },
        "Remove stop",
      ),
    ),
  ];
  if (stop)
    out.push(
      colorButton({
        label: "Stop color",
        value: stop.color,
        theme,
        onPick: (v) => {
          stop.color = hexOf(v, theme);
          write(current());
        },
      }),
      sliderField({
        label: "Stop position",
        value: pct(stop.offset),
        unit: "%",
        onCommit: (n) => {
          stop.offset = n / 100;
          write(current(), "gradient-position");
        },
      }),
      sliderField({
        label: "Stop transparency",
        value: pct(1 - stop.opacity),
        unit: "%",
        onCommit: (n) => {
          stop.opacity = 1 - n / 100;
          write(current(), "gradient-alpha");
        },
      }),
      sliderField({
        label: "Stop brightness",
        value: 0,
        min: -100,
        max: 100,
        unit: "%",
        onCommit: (n) => {
          stop.color = shade(stop.color, n / 100);
          write(current(), "gradient-brightness");
        },
      }),
    );
  return out.filter(Boolean);
}

function patternEditor(ctx, obj, edit, theme) {
  const { P } = ctx;
  const pat = P.getShapePatternFillEffective(ctx.pres(), obj);
  const fg = hexOf(pat?.foreground ?? pat?.fg ?? "#000000", theme);
  const bg = hexOf(pat?.background ?? pat?.bg ?? "#FFFFFF", theme);
  const preset = pat?.preset ?? "pct50";
  const write = (next) =>
    edit((s) =>
      P.setShapePatternFill(s, {
        preset,
        foreground: fg,
        background: bg,
        ...next,
      }),
    );
  const grid = el("div", {
    class: "fmt-pattern-grid",
    role: "radiogroup",
    "aria-label": "Pattern",
  });
  const cells = PATTERNS.map((p) =>
    el(
      "button",
      {
        type: "button",
        role: "radio",
        class: "fmt-pattern-cell",
        "aria-checked": String(p === preset),
        "aria-label": `Pattern ${p}`,
        title: p,
        tabindex: p === preset ? 0 : -1,
        onclick: () => write({ preset: p }),
      },
      patternSwatch(p, fg, bg),
    ),
  );
  if (!cells.some((c) => c.tabIndex === 0)) cells[0].tabIndex = 0;
  grid.addEventListener("keydown", (e) => {
    const at = cells.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 }[
      e.key
    ];
    if (at < 0 || !step || !cells[at + step]) return;
    e.preventDefault();
    cells[at + step].focus();
  });
  grid.append(...cells);
  return [
    grid,
    el(
      "div",
      { class: "fmt-row" },
      colorButton({
        label: "Foreground",
        value: fg,
        theme,
        onPick: (v) => write({ foreground: hexOf(v, theme) }),
      }),
      colorButton({
        label: "Background",
        value: bg,
        theme,
        onPick: (v) => write({ background: hexOf(v, theme) }),
      }),
    ),
  ];
}

function pictureFillEditor(ctx, obj, edit) {
  const { P } = ctx;
  const mode = P.getShapeImageFillMode(obj) || {
    mode: "stretch",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  };
  const out = [
    el(
      "div",
      { class: "fmt-row" },
      el(
        "button",
        {
          type: "button",
          class: "btn secondary",
          onclick: async () => {
            const bytes = await ctx.pickImageBytes();
            if (bytes) edit((s) => P.setShapeImageFill(s, bytes));
          },
        },
        "Insert picture…",
      ),
      selectField({
        label: "Texture",
        value: "",
        options: [
          ["", "Choose a texture…"],
          ...TEXTURES.map(([id, label]) => [id, label]),
        ],
        onChange: (v) =>
          v &&
          edit((s) => {
            P.setShapeImageFill(s, textureBytes(v));
            P.setShapeImageFillMode(s, {
              mode: "tile",
              offsetX: 0,
              offsetY: 0,
              scaleX: 1,
              scaleY: 1,
              align: "tl",
              mirror: "none",
            });
          }),
      }),
    ),
    checkField({
      label: "Tile picture as texture",
      checked: mode.mode === "tile",
      onChange: (on) =>
        edit((s) =>
          P.setShapeImageFillMode(
            s,
            on
              ? {
                  mode: "tile",
                  offsetX: 0,
                  offsetY: 0,
                  scaleX: 1,
                  scaleY: 1,
                  align: "tl",
                  mirror: "none",
                }
              : { mode: "stretch", left: 0, top: 0, right: 0, bottom: 0 },
          ),
        ),
    }),
  ];
  if (mode.mode === "tile") {
    const write = (patch) =>
      edit((s) => P.setShapeImageFillMode(s, { ...mode, ...patch }), "tile");
    out.push(
      el(
        "div",
        { class: "fmt-row" },
        numberField({
          label: "Offset X",
          value: mode.offsetX / PT,
          unit: "pt",
          min: -1000,
          max: 1000,
          onCommit: (n) => write({ offsetX: Math.round(n * PT) }),
        }),
        numberField({
          label: "Offset Y",
          value: mode.offsetY / PT,
          unit: "pt",
          min: -1000,
          max: 1000,
          onCommit: (n) => write({ offsetY: Math.round(n * PT) }),
        }),
      ),
      el(
        "div",
        { class: "fmt-row" },
        numberField({
          label: "Scale X",
          value: pct(mode.scaleX),
          unit: "%",
          min: 1,
          max: 1000,
          onCommit: (n) => write({ scaleX: n / 100 }),
        }),
        numberField({
          label: "Scale Y",
          value: pct(mode.scaleY),
          unit: "%",
          min: 1,
          max: 1000,
          onCommit: (n) => write({ scaleY: n / 100 }),
        }),
      ),
      el(
        "div",
        { class: "fmt-row" },
        selectField({
          label: "Alignment",
          value: mode.align,
          options: [
            ["tl", "Top left"],
            ["t", "Top"],
            ["tr", "Top right"],
            ["l", "Left"],
            ["ctr", "Center"],
            ["r", "Right"],
            ["bl", "Bottom left"],
            ["b", "Bottom"],
            ["br", "Bottom right"],
          ],
          onChange: (v) => write({ align: v }),
        }),
        selectField({
          label: "Mirror type",
          value: mode.mirror,
          options: [
            ["none", "None"],
            ["x", "Horizontal"],
            ["y", "Vertical"],
            ["xy", "Both"],
          ],
          onChange: (v) => write({ mirror: v }),
        }),
      ),
    );
  } else {
    const write = (patch) =>
      edit((s) => P.setShapeImageFillMode(s, { ...mode, ...patch }), "stretch");
    out.push(
      el(
        "div",
        { class: "fmt-row" },
        ...["left", "right", "top", "bottom"].map((side) =>
          numberField({
            label: `Offset ${side}`,
            value: pct(mode[side]),
            unit: "%",
            min: -500,
            max: 99,
            onCommit: (n) => write({ [side]: n / 100 }),
          }),
        ),
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line

function lineSection(ctx, obj, edit, theme, { isLine }) {
  const { P } = ctx;
  const pres = ctx.pres();
  const stroke = P.getShapeStrokeEffective(pres, obj);
  const gradient = P.getShapeLineGradient(pres, obj);
  const fmt = P.getShapeStrokeFormattingEffective(obj);
  const kind = gradient
    ? "gradient"
    : stroke.kind === "solid"
      ? "solid"
      : "none";
  const color =
    P.getShapeStrokeColorResolvedEffective(pres, obj) ||
    hexOf("scheme:tx1", theme);
  const widthPt = (stroke.widthEmu ?? P.getShapeStrokeWidth(obj) ?? 12700) / PT;
  const opacity = stroke.opacity ?? 1;
  const ensure = (s) => {
    if (
      P.getShapeStroke(s).kind !== "solid" &&
      !P.getShapeLineGradient(pres, s)
    )
      P.setShapeStroke(s, { color, widthEmu: Math.round(widthPt * PT) });
  };
  const body = [
    segmentedField(
      "Line type",
      kind,
      [
        ["none", "No line"],
        ["solid", "Solid"],
        ["gradient", "Gradient"],
      ],
      (v) =>
        edit((s) => {
          if (v === "none") return P.setShapeNoStroke(s);
          if (v === "solid") {
            if (gradient) P.setShapeLineGradient(s, null);
            else
              P.setShapeStroke(s, {
                color,
                widthEmu: Math.round(widthPt * PT),
              });
            return;
          }
          ensure(s);
          P.setShapeLineGradient(
            s,
            GRADIENT_PRESETS[0][1](cssColor(color, theme) || "#000000"),
          );
        }),
    ),
  ];
  if (kind !== "none") {
    if (kind === "solid")
      body.push(
        colorButton({
          label: "Line color",
          value: color,
          theme,
          onPick: (v) =>
            edit((s) =>
              P.setShapeStroke(s, {
                color: withAlpha(v, opacity, theme),
                widthEmu: Math.round(widthPt * PT),
              }),
            ),
        }),
        sliderField({
          label: "Line transparency",
          value: pct(1 - opacity),
          unit: "%",
          onCommit: (n) =>
            edit(
              (s) =>
                P.setShapeStroke(s, {
                  color: withAlpha(color, 1 - n / 100, theme),
                  widthEmu: Math.round(widthPt * PT),
                }),
              "line-alpha",
            ),
        }),
      );
    else {
      const g = gradient;
      body.push(
        el(
          "div",
          { class: "fmt-row" },
          colorButton({
            label: "Line start color",
            value: hexOf(g.stops[0].color, theme),
            theme,
            onPick: (v) =>
              edit((s) =>
                P.setShapeLineGradient(s, {
                  ...g,
                  stops: [
                    { ...g.stops[0], color: hexOf(v, theme) },
                    ...g.stops.slice(1),
                  ],
                }),
              ),
          }),
          colorButton({
            label: "Line end color",
            value: hexOf(g.stops.at(-1).color, theme),
            theme,
            onPick: (v) =>
              edit((s) =>
                P.setShapeLineGradient(s, {
                  ...g,
                  stops: [
                    ...g.stops.slice(0, -1),
                    { ...g.stops.at(-1), color: hexOf(v, theme) },
                  ],
                }),
              ),
          }),
        ),
        numberField({
          label: "Line gradient angle",
          value: g.angleDeg ?? 0,
          unit: "°",
          min: 0,
          max: 359.9,
          step: 5,
          onCommit: (n) =>
            edit((s) =>
              P.setShapeLineGradient(s, { stops: g.stops, angleDeg: n }),
            ),
        }),
      );
    }
    body.push(
      el(
        "div",
        { class: "fmt-row" },
        numberField({
          label: "Line width",
          value: widthPt,
          unit: "pt",
          min: 0,
          max: 1584,
          step: 0.25,
          onCommit: (n) =>
            edit((s) => {
              if (gradient) {
                const ln = P.getShapeLineGradient(pres, s);
                P.setShapeStroke(s, {
                  color: cssColor(ln.stops[0].color, theme),
                  widthEmu: Math.round(n * PT),
                });
                P.setShapeLineGradient(s, ln);
              } else
                P.setShapeStroke(s, { color, widthEmu: Math.round(n * PT) });
            }, "line-width"),
        }),
        selectField({
          label: "Compound type",
          value: fmt.compound ?? "sng",
          options: COMPOUNDS,
          onChange: (v) =>
            edit((s) => (ensure(s), P.setShapeStrokeCompound(s, v))),
        }),
      ),
      el(
        "div",
        { class: "fmt-row" },
        selectField({
          label: "Dash type",
          value: fmt.dash?.kind === "preset" ? fmt.dash.value : "solid",
          options: DASHES,
          onChange: (v) => edit((s) => (ensure(s), P.setShapeStrokeDash(s, v))),
        }),
        selectField({
          label: "Cap type",
          value: fmt.cap ?? "flat",
          options: [
            ["flat", "Flat"],
            ["rnd", "Round"],
            ["sq", "Square"],
          ],
          onChange: (v) => edit((s) => (ensure(s), P.setShapeStrokeCap(s, v))),
        }),
        selectField({
          label: "Join type",
          value: fmt.join?.kind ?? fmt.join ?? "round",
          options: [
            ["round", "Round"],
            ["bevel", "Bevel"],
            ["miter", "Miter"],
          ],
          onChange: (v) => edit((s) => (ensure(s), P.setShapeStrokeJoin(s, v))),
        }),
      ),
    );
    const arrows = (end, label) => {
      const current = fmt[end] || { type: "none" };
      const write = (patch) =>
        edit(
          (s) => (
            ensure(s),
            P.setShapeStrokeArrow(s, end, {
              type: current.type,
              width: current.width ?? "med",
              length: current.length ?? "med",
              ...patch,
            })
          ),
        );
      return el(
        "div",
        { class: "fmt-row" },
        selectField({
          label: `${label} arrow type`,
          value: current.type ?? "none",
          options: ARROW_TYPES,
          onChange: (v) => write({ type: v }),
        }),
        selectField({
          label: `${label} arrow size`,
          value: `${current.width ?? "med"}|${current.length ?? "med"}`,
          options: ARROW_SIZES.flatMap(([w, wl]) =>
            ARROW_SIZES.map(([l, ll]) => [
              `${w}|${l}`,
              `${wl} width, ${ll.toLowerCase()} length`,
            ]),
          ),
          onChange: (v) => {
            const [width, length] = v.split("|");
            write({ width, length });
          },
        }),
      );
    };
    if (isLine || P.getShapeKind(obj) === "shape")
      body.push(arrows("head", "Begin"), arrows("tail", "End"));
  }
  return section("Line", body, { key: "line", open: true });
}

// ---------------------------------------------------------------------------
// Effects

function effectSections(ctx, obj, edit, theme) {
  const { P } = ctx;
  const pres = ctx.pres();
  const spec = P.getShapeEffectSpec(pres, obj);
  const three = P.getShape3D(obj);
  const write = (patch, key) =>
    edit((s) => P.setShapeEffectSpec(pres, s, patch), key);
  const write3D = (patch, key) => edit((s) => P.setShape3D(s, patch), key);
  const out = [];

  // Shadow
  const s = spec.shadow;
  const shadowBody = [
    selectField({
      label: "Shadow presets",
      value: s
        ? String(
            SHADOW_PRESETS.findIndex(
              ([, , p]) =>
                p.type === s.type &&
                Math.abs(p.angleDeg - s.angleDeg) < 1 &&
                Math.abs(p.distEmu - s.distEmu) < PT,
            ),
          )
        : "none",
      options: [
        ["none", "No shadow"],
        ["-1", "Custom"],
        ...SHADOW_PRESETS.map(([, label], i) => [String(i), label]),
      ],
      onChange: (v) =>
        v !== "-1" &&
        write({ shadow: v === "none" ? null : SHADOW_PRESETS[Number(v)][2] }),
    }),
  ];
  if (s) {
    const ws = (patch, key) => write({ shadow: { ...s, ...patch } }, key);
    shadowBody.push(
      segmentedField(
        "Shadow placement",
        s.type,
        [
          ["outer", "Outside"],
          ["inner", "Inside"],
        ],
        (v) => ws({ type: v }),
      ),
      colorButton({
        label: "Shadow color",
        value: s.color,
        theme,
        onPick: (v) => ws({ color: hexOf(v, theme) }),
      }),
      sliderField({
        label: "Shadow transparency",
        value: pct(1 - s.opacity),
        unit: "%",
        onCommit: (n) => ws({ opacity: 1 - n / 100 }, "shadow-alpha"),
      }),
      s.type === "outer"
        ? sliderField({
            label: "Shadow size",
            value: pct(s.scale ?? 1),
            min: 1,
            max: 200,
            unit: "%",
            onCommit: (n) => ws({ scale: n / 100 }, "shadow-size"),
          })
        : null,
      sliderField({
        label: "Shadow blur",
        value: s.blurEmu / PT,
        max: 100,
        unit: "pt",
        onCommit: (n) => ws({ blurEmu: Math.round(n * PT) }, "shadow-blur"),
      }),
      sliderField({
        label: "Shadow angle",
        value: Math.round(s.angleDeg),
        max: 359,
        unit: "°",
        onCommit: (n) => ws({ angleDeg: n }, "shadow-angle"),
      }),
      sliderField({
        label: "Shadow distance",
        value: s.distEmu / PT,
        max: 200,
        unit: "pt",
        onCommit: (n) => ws({ distEmu: Math.round(n * PT) }, "shadow-distance"),
      }),
    );
  }
  out.push(section("Shadow", shadowBody.filter(Boolean), { key: "shadow" }));

  // Reflection
  const r = spec.reflection;
  const reflectionBody = [
    selectField({
      label: "Reflection presets",
      value: r
        ? String(
            REFLECTION_PRESETS.findIndex(
              ([, p]) =>
                Math.abs(p.endPos - r.endPos) < 0.02 &&
                Math.abs(p.distEmu - r.distEmu) < PT / 2,
            ),
          )
        : "none",
      options: [
        ["none", "No reflection"],
        ["-1", "Custom"],
        ...REFLECTION_PRESETS.map(([label], i) => [String(i), label]),
      ],
      onChange: (v) =>
        v !== "-1" &&
        write({
          reflection: v === "none" ? null : REFLECTION_PRESETS[Number(v)][1],
        }),
    }),
  ];
  if (r) {
    const wr = (patch, key) => write({ reflection: { ...r, ...patch } }, key);
    reflectionBody.push(
      sliderField({
        label: "Reflection transparency",
        value: pct(1 - r.startOpacity),
        unit: "%",
        onCommit: (n) => wr({ startOpacity: 1 - n / 100 }, "refl-alpha"),
      }),
      sliderField({
        label: "Reflection size",
        value: pct(r.endPos),
        min: 1,
        unit: "%",
        onCommit: (n) => wr({ endPos: n / 100 }, "refl-size"),
      }),
      sliderField({
        label: "Reflection distance",
        value: r.distEmu / PT,
        max: 100,
        unit: "pt",
        onCommit: (n) => wr({ distEmu: Math.round(n * PT) }, "refl-dist"),
      }),
      sliderField({
        label: "Reflection blur",
        value: r.blurEmu / PT,
        max: 100,
        step: 0.5,
        unit: "pt",
        onCommit: (n) => wr({ blurEmu: Math.round(n * PT) }, "refl-blur"),
      }),
    );
  }
  out.push(section("Reflection", reflectionBody, { key: "reflection" }));

  // Glow
  const g = spec.glow;
  const glowBody = [
    selectField({
      label: "Glow presets",
      value: g ? "custom" : "none",
      options: [
        ["none", "No glow"],
        ["custom", "Custom"],
        ...[5, 8, 11, 18].flatMap((size) =>
          GLOW_ACCENTS.map((a) => [
            `${size}|${a}`,
            `${size} pt, Accent ${a.slice(-1)}`,
          ]),
        ),
      ],
      onChange: (v) => {
        if (v === "custom") return;
        if (v === "none") return write({ glow: null });
        const [size, accent] = v.split("|");
        write({
          glow: {
            color: `scheme:${accent}`,
            opacity: 0.6,
            radiusEmu: Number(size) * PT,
          },
        });
      },
    }),
  ];
  if (g) {
    const wg = (patch, key) => write({ glow: { ...g, ...patch } }, key);
    glowBody.push(
      colorButton({
        label: "Glow color",
        value: g.color,
        theme,
        onPick: (v) => wg({ color: hexOf(v, theme) }),
      }),
      sliderField({
        label: "Glow size",
        value: g.radiusEmu / PT,
        max: 150,
        unit: "pt",
        onCommit: (n) => wg({ radiusEmu: Math.round(n * PT) }, "glow-size"),
      }),
      sliderField({
        label: "Glow transparency",
        value: pct(1 - g.opacity),
        unit: "%",
        onCommit: (n) => wg({ opacity: 1 - n / 100 }, "glow-alpha"),
      }),
    );
  }
  out.push(section("Glow", glowBody, { key: "glow" }));

  // Soft edges
  const se = spec.softEdge;
  out.push(
    section(
      "Soft Edges",
      [
        selectField({
          label: "Soft edge presets",
          value: se
            ? String(
                SOFT_EDGE_SIZES.find(
                  (n) => Math.abs(n * PT - se.radiusEmu) < PT / 4,
                ) ?? "custom",
              )
            : "none",
          options: [
            ["none", "No soft edges"],
            ["custom", "Custom"],
            ...SOFT_EDGE_SIZES.map((n) => [String(n), `${n} pt`]),
          ],
          onChange: (v) =>
            v !== "custom" &&
            write({
              softEdge: v === "none" ? null : { radiusEmu: Number(v) * PT },
            }),
        }),
        se &&
          sliderField({
            label: "Soft edge size",
            value: se.radiusEmu / PT,
            max: 100,
            unit: "pt",
            onCommit: (n) =>
              write(
                { softEdge: n ? { radiusEmu: Math.round(n * PT) } : null },
                "soft-size",
              ),
          }),
      ].filter(Boolean),
      { key: "softEdges" },
    ),
  );

  // 3-D Format
  const bevel = (which, label) => {
    const b = three[which];
    return [
      selectField({
        label: `${label} bevel`,
        value: b?.preset ?? "none",
        options: [["none", "None"], ...BEVELS],
        onChange: (v) =>
          write3D({
            [which]:
              v === "none"
                ? null
                : {
                    preset: v,
                    widthEmu: b?.widthEmu ?? 6 * PT,
                    heightEmu: b?.heightEmu ?? 6 * PT,
                  },
          }),
      }),
      b &&
        el(
          "div",
          { class: "fmt-row" },
          numberField({
            label: `${label} bevel width`,
            value: b.widthEmu / PT,
            unit: "pt",
            min: 0,
            max: 1584,
            onCommit: (n) =>
              write3D({ [which]: { ...b, widthEmu: Math.round(n * PT) } }),
          }),
          numberField({
            label: `${label} bevel height`,
            value: b.heightEmu / PT,
            unit: "pt",
            min: 0,
            max: 1584,
            onCommit: (n) =>
              write3D({ [which]: { ...b, heightEmu: Math.round(n * PT) } }),
          }),
        ),
    ];
  };
  out.push(
    section(
      "3-D Format",
      [
        ...bevel("bevelTop", "Top"),
        ...bevel("bevelBottom", "Bottom"),
        el(
          "div",
          { class: "fmt-row" },
          colorButton({
            label: "Depth color",
            value: three.depthColor ?? null,
            theme,
            automatic: { label: "Automatic", value: null },
            onPick: (v) => write3D({ depthColor: v && hexOf(v, theme) }),
          }),
          numberField({
            label: "Depth size",
            value: three.depthEmu / PT,
            unit: "pt",
            min: 0,
            max: 1584,
            onCommit: (n) => write3D({ depthEmu: Math.round(n * PT) }),
          }),
        ),
        el(
          "div",
          { class: "fmt-row" },
          colorButton({
            label: "Contour color",
            value: three.contourColor ?? null,
            theme,
            automatic: { label: "Automatic", value: null },
            onPick: (v) => write3D({ contourColor: v && hexOf(v, theme) }),
          }),
          numberField({
            label: "Contour size",
            value: three.contourEmu / PT,
            unit: "pt",
            min: 0,
            max: 1584,
            onCommit: (n) => write3D({ contourEmu: Math.round(n * PT) }),
          }),
        ),
        el(
          "div",
          { class: "fmt-row" },
          selectField({
            label: "Material",
            value: three.material,
            options: MATERIALS,
            onChange: (v) => write3D({ material: v }),
          }),
          selectField({
            label: "Lighting",
            value: three.lightRig,
            options: LIGHTS,
            onChange: (v) => write3D({ lightRig: v }),
          }),
        ),
        numberField({
          label: "Lighting angle",
          value: three.lightAngle ?? 0,
          unit: "°",
          min: 0,
          max: 359.9,
          step: 5,
          onCommit: (n) => write3D({ lightAngle: n }),
        }),
        three.present &&
          el(
            "button",
            {
              type: "button",
              class: "btn secondary",
              onclick: () => edit((s) => P.setShape3D(s, null)),
            },
            "Reset 3-D",
          ),
      ].filter(Boolean),
      { key: "format3d" },
    ),
  );

  // 3-D Rotation
  out.push(
    section(
      "3-D Rotation",
      [
        selectField({
          label: "Rotation presets",
          value: three.camera,
          options: [
            ["orthographicFront", "No rotation"],
            ...ROTATION_PRESETS.map(([group, preset, label]) => [
              preset,
              `${group}: ${label.split(": ").pop()}`,
            ]),
          ],
          onChange: (v) => write3D({ camera: v, rotX: 0, rotY: 0, rotZ: 0 }),
        }),
        el(
          "div",
          { class: "fmt-row" },
          numberField({
            label: "X rotation",
            value: three.rotX,
            unit: "°",
            min: 0,
            max: 359.9,
            step: 10,
            onCommit: (n) => write3D({ rotX: n }),
          }),
          numberField({
            label: "Y rotation",
            value: three.rotY,
            unit: "°",
            min: 0,
            max: 359.9,
            step: 10,
            onCommit: (n) => write3D({ rotY: n }),
          }),
          numberField({
            label: "Z rotation",
            value: three.rotZ,
            unit: "°",
            min: 0,
            max: 359.9,
            step: 10,
            onCommit: (n) => write3D({ rotZ: n }),
          }),
        ),
        numberField({
          label: "Perspective",
          value: three.fov ?? 45,
          unit: "°",
          min: 0,
          max: 120,
          step: 5,
          disabled: !three.camera.startsWith("perspective"),
          onCommit: (n) => write3D({ fov: n }),
        }),
        el(
          "p",
          { class: "helper" },
          "The slide shows 3-D rotation as a flat projection; the file keeps the full setting.",
        ),
      ],
      { key: "rotation3d" },
    ),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Size & Properties

function sizeSection(ctx, obj, edit) {
  const { P } = ctx;
  const b = ctx.slideBounds(obj);
  const locked = P.getShapeAspectLock(obj);
  const out = [];
  if (b) {
    const original = ctx.originalSize(obj) || { w: b.w, h: b.h };
    const scaleW = (b.w / original.w) * 100;
    const scaleH = (b.h / original.h) * 100;
    const setScale = (axis, n) =>
      edit((s) => {
        const cur = ctx.slideBounds(s);
        const next = { ...cur };
        const factor = n / 100;
        if (axis === "w" || P.getShapeAspectLock(s))
          next.w = Math.max(
            1,
            Math.round(
              original.w *
                (axis === "w"
                  ? factor
                  : (factor * original.h * cur.w) / (cur.h * original.w)),
            ),
          );
        if (axis === "h" || P.getShapeAspectLock(s))
          next.h = Math.max(
            1,
            Math.round(
              original.h *
                (axis === "h"
                  ? factor
                  : (factor * original.w * cur.h) / (cur.w * original.h)),
            ),
          );
        ctx.setSlideBounds(s, next);
      });
    const fromCenter = !!ctx.state.positionFromCenter;
    const ox = fromCenter ? b.w / 2 : 0;
    const oy = fromCenter ? b.h / 2 : 0;
    out.push(
      el(
        "div",
        { class: "fmt-row" },
        numberField({
          label: "Scale height",
          value: scaleH,
          unit: "%",
          min: 1,
          max: 10000,
          step: 5,
          places: 0,
          onCommit: (n) => setScale("h", n),
        }),
        numberField({
          label: "Scale width",
          value: scaleW,
          unit: "%",
          min: 1,
          max: 10000,
          step: 5,
          places: 0,
          onCommit: (n) => setScale("w", n),
        }),
      ),
      checkField({
        label: "Lock aspect ratio",
        checked: locked,
        onChange: (on) => edit((s) => P.setShapeAspectLock(s, on)),
      }),
      el(
        "div",
        { class: "fmt-row" },
        numberField({
          label: "Horizontal position",
          value: (b.x + ox) / IN,
          unit: "in",
          min: -100,
          max: 100,
          step: 0.1,
          onCommit: (n) =>
            edit((s) =>
              ctx.setSlideBounds(s, {
                ...ctx.slideBounds(s),
                x: Math.round(n * IN - ox),
              }),
            ),
        }),
        numberField({
          label: "Vertical position",
          value: (b.y + oy) / IN,
          unit: "in",
          min: -100,
          max: 100,
          step: 0.1,
          onCommit: (n) =>
            edit((s) =>
              ctx.setSlideBounds(s, {
                ...ctx.slideBounds(s),
                y: Math.round(n * IN - oy),
              }),
            ),
        }),
      ),
      selectField({
        label: "Position from",
        value: fromCenter ? "center" : "corner",
        options: [
          ["corner", "Top left corner"],
          ["center", "Center"],
        ],
        onChange: (v) => {
          ctx.state.positionFromCenter = v === "center";
          ctx.renderInspector();
        },
      }),
    );
  }
  return section("Size", out, { key: "size" });
}

function textBoxSection(ctx, obj, edit) {
  const { P } = ctx;
  const pres = ctx.pres();
  let body = {};
  try {
    body = P.getShapeBodyPrEffective(pres, obj) || {};
  } catch {}
  const margins = body.margins || {};
  const autofit = P.getShapeTextAutoFit(obj) || "none";
  const wrap = (P.getShapeTextWrap(obj) || body.wrap || "square") !== "none";
  const dir = P.getShapeTextDirection(obj) || "horz";
  const cols = P.getShapeTextColumns(obj);
  const margin = (side, label, fallback) =>
    numberField({
      label,
      value: (margins[side] ?? fallback) / IN,
      unit: "in",
      min: 0,
      max: 20,
      step: 0.05,
      onCommit: (n) =>
        edit((s) => {
          const current = P.getShapeBodyPrEffective(pres, s)?.margins || {};
          P.setShapeTextMargins(s, {
            left: current.left ?? 91440,
            right: current.right ?? 91440,
            top: current.top ?? 45720,
            bottom: current.bottom ?? 45720,
            [side]: Math.round(n * IN),
          });
        }),
    });
  return section(
    "Text Box",
    [
      el(
        "div",
        { class: "fmt-row" },
        selectField({
          label: "Vertical alignment",
          value: body.anchor || "top",
          options: [
            ["top", "Top"],
            ["center", "Middle"],
            ["bottom", "Bottom"],
          ],
          onChange: (v) => edit((s) => P.setShapeTextAnchor(s, v)),
        }),
        selectField({
          label: "Text direction",
          value: dir,
          options: [
            ["horz", "Horizontal"],
            ["vert", "Rotate all text 90°"],
            ["vert270", "Rotate all text 270°"],
            ["wordArtVert", "Stacked"],
          ],
          onChange: (v) => edit((s) => P.setShapeTextDirection(s, v)),
        }),
      ),
      el(
        "div",
        { class: "fmt-field" },
        el("span", { class: "fmt-label" }, "Autofit"),
        segmented({
          label: "Autofit",
          value: autofit,
          options: [
            ["none", "Do not autofit"],
            ["normal", "Shrink text on overflow"],
            ["shape", "Resize shape to fit text"],
          ],
          onChange: (v) => edit((s) => P.setShapeTextAutoFit(s, v)),
        }),
      ),
      el(
        "div",
        { class: "fmt-row" },
        margin("left", "Left margin", 91440),
        margin("right", "Right margin", 91440),
      ),
      el(
        "div",
        { class: "fmt-row" },
        margin("top", "Top margin", 45720),
        margin("bottom", "Bottom margin", 45720),
      ),
      checkField({
        label: "Wrap text in shape",
        checked: wrap,
        onChange: (on) =>
          edit((s) => P.setShapeTextWrap(s, on ? "square" : "none")),
      }),
      el(
        "button",
        {
          type: "button",
          class: "btn secondary",
          onclick: () => ctx.openColumns(obj),
        },
        `Columns… (${cols?.count || 1})`,
      ),
    ],
    { key: "textBox" },
  );
}

function altTextSection(ctx, obj, edit) {
  const { P } = ctx;
  return section(
    "Alt Text",
    [
      el(
        "label",
        { class: "fmt-field" },
        el("span", { class: "fmt-label" }, "Title"),
        el("input", {
          class: "input",
          "aria-label": "Alt text title",
          value: P.getShapeAltTitle?.(obj) || "",
          onchange: (e) => {
            const v = e.target.value;
            edit((s) => P.setShapeAltTitle(s, v || null));
          },
        }),
      ),
      el(
        "label",
        { class: "fmt-field" },
        el("span", { class: "fmt-label" }, "Description"),
        el("textarea", {
          class: "input",
          rows: 3,
          "aria-label": "Alt text description",
          value: P.getShapeDescription(obj) || "",
          onchange: (e) => {
            const v = e.target.value;
            edit((s) => P.setShapeDescription(s, v));
          },
        }),
      ),
    ],
    { key: "altText" },
  );
}

// ---------------------------------------------------------------------------
// Picture

export const SHARPEN_PRESETS = [-50, -25, 0, 25, 50];
export const BRIGHTNESS_CONTRAST = [-40, -20, 0, 20, 40];
export const SATURATION_PRESETS = [0, 33, 66, 100, 133, 166, 200, 300, 400];
export const TEMPERATURE_PRESETS = [
  4700, 5300, 5900, 6500, 7200, 7800, 8800, 10000, 11200,
];

export function recolorPresets(theme) {
  const accent = (n) => hexOf(`scheme:accent${n}`, theme);
  return [
    ["No recolor", { kind: "none" }],
    ["Grayscale", { kind: "grayscale" }],
    ["Sepia", { kind: "duotone", dark: "#3B2A17", light: "#F2E3C6" }],
    ["Washout", { kind: "washout" }],
    ["Black and white: 25%", { kind: "blackWhite", threshold: 0.25 }],
    ["Black and white: 50%", { kind: "blackWhite", threshold: 0.5 }],
    ["Black and white: 75%", { kind: "blackWhite", threshold: 0.75 }],
    ...[1, 2, 3, 4, 5, 6].flatMap((n) => [
      [
        `Accent ${n} dark`,
        { kind: "duotone", dark: shade(accent(n), -0.7), light: accent(n) },
      ],
      [
        `Accent ${n} light`,
        { kind: "duotone", dark: accent(n), light: shade(accent(n), 0.85) },
      ],
    ]),
  ];
}

function pictureSections(ctx, obj, edit, { isPicture }) {
  const { P } = ctx;
  const theme = ctx.theme();
  const adj = P.getShapePictureAdjustments(obj);
  const writeAdj = (patch, key) =>
    edit((s) => P.setShapePictureAdjustments(s, patch), key);
  const out = [];
  const brightness = isPicture ? (P.getShapeImageBrightness(obj) ?? 0) : 0;
  const contrast = isPicture ? (P.getShapeImageContrast(obj) ?? 0) : 0;
  out.push(
    section(
      "Picture Corrections",
      [
        sliderField({
          label: "Sharpness",
          value: pct(adj.sharpness ?? 0),
          min: -100,
          max: 100,
          unit: "%",
          onCommit: (n) => writeAdj({ sharpness: n / 100 }, "sharpness"),
        }),
        isPicture &&
          sliderField({
            label: "Picture brightness",
            value: pct(brightness),
            min: -100,
            max: 100,
            unit: "%",
            onCommit: (n) =>
              edit(
                (s) => P.setShapeImageBrightness(s, n ? n / 100 : null),
                "pic-brightness",
              ),
          }),
        isPicture &&
          sliderField({
            label: "Picture contrast",
            value: pct(contrast),
            min: -100,
            max: 100,
            unit: "%",
            onCommit: (n) =>
              edit(
                (s) => P.setShapeImageContrast(s, n ? n / 100 : null),
                "pic-contrast",
              ),
          }),
        el(
          "button",
          {
            type: "button",
            class: "btn secondary",
            onclick: () =>
              edit((s) => {
                P.setShapePictureAdjustments(s, { sharpness: null });
                if (isPicture) {
                  P.setShapeImageBrightness(s, null);
                  P.setShapeImageContrast(s, null);
                }
              }),
          },
          "Reset corrections",
        ),
      ].filter(Boolean),
      { key: "corrections" },
    ),
  );
  const recolor = P.getShapePictureRecolor(obj);
  const presets = recolorPresets(theme);
  out.push(
    section(
      "Picture Color",
      [
        sliderField({
          label: "Saturation",
          value: pct(adj.saturation ?? 1),
          max: 400,
          unit: "%",
          onCommit: (n) => writeAdj({ saturation: n / 100 }, "saturation"),
        }),
        sliderField({
          label: "Temperature",
          value: adj.temperature ?? 6500,
          min: 1500,
          max: 11500,
          step: 100,
          unit: "K",
          onCommit: (n) => writeAdj({ temperature: n }, "temperature"),
        }),
        selectField({
          label: "Recolor",
          value: String(
            presets.findIndex(
              ([, p]) => JSON.stringify(p) === JSON.stringify(recolor),
            ),
          ),
          options: [
            ["-1", "Custom"],
            ...presets.map(([label], i) => [String(i), label]),
          ],
          onChange: (v) =>
            v !== "-1" &&
            edit((s) => P.setShapePictureRecolor(s, presets[Number(v)][1])),
        }),
      ],
      { key: "pictureColor" },
    ),
  );
  out.push(
    section(
      "Artistic Effects",
      [
        selectField({
          label: "Artistic effect",
          value: adj.artistic?.effect ?? "none",
          options: ARTISTIC,
          onChange: (v) =>
            writeAdj({
              artistic:
                v === "none"
                  ? null
                  : { effect: v, amount: adj.artistic?.amount ?? 0.5 },
            }),
        }),
        adj.artistic &&
          sliderField({
            label: "Effect amount",
            value: pct(adj.artistic.amount),
            unit: "%",
            onCommit: (n) =>
              writeAdj(
                { artistic: { ...adj.artistic, amount: n / 100 } },
                "artistic",
              ),
          }),
      ].filter(Boolean),
      { key: "artistic" },
    ),
  );
  if (isPicture) out.push(cropSection(ctx, obj, edit));
  return out;
}

export const ASPECT_RATIOS = [
  ["1:1", 1, 1],
  ["2:3", 2, 3],
  ["3:2", 3, 2],
  ["3:4", 3, 4],
  ["4:3", 4, 3],
  ["3:5", 3, 5],
  ["5:3", 5, 3],
  ["4:5", 4, 5],
  ["5:4", 5, 4],
  ["9:16", 9, 16],
  ["16:9", 16, 9],
  ["16:10", 16, 10],
];

/**
 * The crop that gives a picture of natural size `img` the aspect ratio
 * `ratio` (width / height) at the center, as srcRect fractions.
 */
export function cropToAspect(img, ratio) {
  const current = img.w / img.h;
  if (Math.abs(current - ratio) < 1e-6)
    return { left: 0, top: 0, right: 0, bottom: 0 };
  if (current > ratio) {
    const keep = ratio / current;
    const side = (1 - keep) / 2;
    return { left: side, right: side, top: 0, bottom: 0 };
  }
  const keep = current / ratio;
  const side = (1 - keep) / 2;
  return { left: 0, right: 0, top: side, bottom: side };
}

/** Crop for Fill (cover the box) or Fit (the whole picture, letterboxed). */
export function fillOrFit(img, box, mode) {
  const ratio = box.w / box.h;
  if (mode === "fill") return { crop: cropToAspect(img, ratio), box };
  const imgRatio = img.w / img.h;
  const w = imgRatio > ratio ? box.w : box.h * imgRatio;
  const h = imgRatio > ratio ? box.w / imgRatio : box.h;
  return {
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    box: { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h },
  };
}

function cropSection(ctx, obj, edit) {
  const { P } = ctx;
  const bytes = P.getShapeImageBytes?.(obj);
  const natural = bytes ? imageSize(bytes) : null;
  const geometry = P.getShapeGeometryEffective(ctx.pres(), obj);
  return section(
    "Crop",
    [
      el(
        "div",
        { class: "fmt-row" },
        el(
          "button",
          {
            type: "button",
            class: "btn secondary",
            "aria-haspopup": "menu",
            onclick: (e) => ctx.openCropToShape(e.currentTarget),
          },
          `Crop to shape (${geometry?.kind === "preset" ? geometry.preset : "custom"})`,
        ),
      ),
      selectField({
        label: "Aspect ratio",
        value: "",
        options: [
          ["", natural ? "Choose a ratio…" : "Picture size unknown"],
          ...ASPECT_RATIOS.map(([label]) => [label, label]),
        ],
        disabled: !natural,
        onChange: (v) => {
          const [, w, h] = ASPECT_RATIOS.find(([label]) => label === v) || [];
          if (!w) return;
          edit((s) => {
            const crop = cropToAspect(natural, w / h);
            P.setShapeImageCrop(
              s,
              Object.values(crop).some(Boolean) ? crop : null,
            );
            const b = ctx.slideBounds(s);
            const nextH = (b.w * h) / w;
            ctx.setSlideBounds(s, {
              ...b,
              y: b.y + (b.h - nextH) / 2,
              h: nextH,
            });
          });
        },
      }),
      el(
        "div",
        { class: "fmt-row" },
        ...["fill", "fit"].map((mode) =>
          el(
            "button",
            {
              type: "button",
              class: "btn secondary",
              disabled: !natural,
              onclick: () =>
                edit((s) => {
                  const result = fillOrFit(natural, ctx.slideBounds(s), mode);
                  P.setShapeImageCrop(
                    s,
                    Object.values(result.crop).some(Boolean)
                      ? result.crop
                      : null,
                  );
                  ctx.setSlideBounds(s, result.box);
                }),
            },
            mode === "fill" ? "Fill" : "Fit",
          ),
        ),
      ),
    ],
    { key: "crop" },
  );
}

// ---------------------------------------------------------------------------
// Text Options

function textOptionSections(ctx, obj, theme) {
  const f = ctx.textFormat(obj) || {};
  const apply = (format) => ctx.applyText(obj, format);
  const fillKind = f.gradient
    ? "gradient"
    : f.colorOpacity === 0
      ? "none"
      : "solid";
  const fillBody = [
    segmentedField(
      "Text fill",
      fillKind,
      [
        ["none", "No fill"],
        ["solid", "Solid"],
        ["gradient", "Gradient"],
      ],
      (v) => {
        const base = cssColor(f.color, theme) || hexOf("scheme:tx1", theme);
        if (v === "none")
          apply({ gradient: null, color: base, colorOpacity: 0 });
        else if (v === "solid")
          apply({ gradient: null, color: base, colorOpacity: 1 });
        else
          apply({
            gradient: {
              stops: [
                { offset: 0, color: base },
                { offset: 1, color: shade(base, 0.5) },
              ],
              angleDeg: 90,
            },
          });
      },
    ),
  ];
  if (fillKind === "solid")
    fillBody.push(
      colorButton({
        label: "Text fill color",
        value: f.color,
        theme,
        onPick: (v) => apply({ color: v }),
      }),
      sliderField({
        label: "Text transparency",
        value: pct(1 - (f.colorOpacity ?? 1)),
        unit: "%",
        onCommit: (n) =>
          apply({ color: f.color || "#000000", colorOpacity: 1 - n / 100 }),
      }),
    );
  if (fillKind === "gradient") {
    const g = f.gradient;
    fillBody.push(
      el(
        "div",
        { class: "fmt-row" },
        colorButton({
          label: "Text gradient start",
          value: g.stops[0].color,
          theme,
          onPick: (v) =>
            apply({
              gradient: {
                ...g,
                stops: [
                  { ...g.stops[0], color: hexOf(v, theme) },
                  ...g.stops.slice(1),
                ],
              },
            }),
        }),
        colorButton({
          label: "Text gradient end",
          value: g.stops.at(-1).color,
          theme,
          onPick: (v) =>
            apply({
              gradient: {
                ...g,
                stops: [
                  ...g.stops.slice(0, -1),
                  { ...g.stops.at(-1), color: hexOf(v, theme) },
                ],
              },
            }),
        }),
      ),
      numberField({
        label: "Text gradient angle",
        value: g.angleDeg,
        unit: "°",
        min: 0,
        max: 359.9,
        step: 15,
        onCommit: (n) => apply({ gradient: { ...g, angleDeg: n } }),
      }),
    );
  }
  const outline = f.outline;
  const outlineBody = [
    segmentedField(
      "Text outline",
      outline ? "solid" : "none",
      [
        ["none", "No line"],
        ["solid", "Solid"],
      ],
      (v) =>
        apply({
          outline:
            v === "none"
              ? null
              : {
                  color: hexOf("scheme:accent1", theme),
                  widthEmu: Math.round(0.75 * PT),
                },
        }),
    ),
  ];
  if (outline)
    outlineBody.push(
      colorButton({
        label: "Text outline color",
        value: outline.color,
        theme,
        onPick: (v) =>
          apply({ outline: { ...outline, color: hexOf(v, theme) } }),
      }),
      el(
        "div",
        { class: "fmt-row" },
        numberField({
          label: "Text outline width",
          value: outline.widthEmu / PT,
          unit: "pt",
          min: 0,
          max: 100,
          step: 0.25,
          onCommit: (n) =>
            apply({ outline: { ...outline, widthEmu: Math.round(n * PT) } }),
        }),
        selectField({
          label: "Text outline dash",
          value: outline.dash || "solid",
          options: DASHES,
          onChange: (v) =>
            apply({
              outline: { ...outline, dash: v === "solid" ? undefined : v },
            }),
        }),
      ),
    );
  const fx = f.effects || {};
  const effectsBody = [
    selectField({
      label: "Text shadow",
      value: fx.shadow ? "on" : "none",
      options: [
        ["none", "No shadow"],
        ["on", "Offset: Bottom Right"],
        ["soft", "Soft below"],
        ["inner", "Inside"],
      ],
      onChange: (v) =>
        apply({
          effects: {
            ...fx,
            shadow:
              v === "none"
                ? null
                : v === "inner"
                  ? {
                      color: "#000000",
                      opacity: 0.5,
                      blurEmu: 2 * PT,
                      distEmu: PT,
                      angleDeg: 45,
                      inner: true,
                    }
                  : v === "soft"
                    ? {
                        color: "#000000",
                        opacity: 0.3,
                        blurEmu: 6 * PT,
                        distEmu: 4 * PT,
                        angleDeg: 90,
                      }
                    : {
                        color: "#000000",
                        opacity: 0.4,
                        blurEmu: 3 * PT,
                        distEmu: 2 * PT,
                        angleDeg: 45,
                      },
          },
        }),
    }),
    selectField({
      label: "Text glow",
      value: fx.glow ? String(Math.round(fx.glow.radiusEmu / PT)) : "none",
      options: [
        ["none", "No glow"],
        ...[5, 8, 11, 18].map((n) => [String(n), `${n} pt`]),
      ],
      onChange: (v) =>
        apply({
          effects: {
            ...fx,
            glow:
              v === "none"
                ? null
                : {
                    color: hexOf("scheme:accent1", theme),
                    opacity: 0.6,
                    radiusEmu: Number(v) * PT,
                  },
          },
        }),
    }),
    fx.glow &&
      colorButton({
        label: "Text glow color",
        value: fx.glow.color,
        theme,
        onPick: (v) =>
          apply({
            effects: { ...fx, glow: { ...fx.glow, color: hexOf(v, theme) } },
          }),
      }),
    selectField({
      label: "Text reflection",
      value: fx.reflection ? "on" : "none",
      options: [
        ["none", "No reflection"],
        ["on", "Tight reflection"],
        ["half", "Half reflection"],
      ],
      onChange: (v) =>
        apply({
          effects: {
            ...fx,
            reflection:
              v === "none"
                ? null
                : {
                    startOpacity: 0.5,
                    endPos: v === "half" ? 0.55 : 0.35,
                    distEmu: 0,
                    blurEmu: 0.5 * PT,
                  },
          },
        }),
    }),
  ].filter(Boolean);
  return [
    section("Text Fill", fillBody, { key: "textFill" }),
    section("Text Outline", outlineBody, { key: "textOutline" }),
    section("Text Effects", effectsBody, { key: "textEffects" }),
  ];
}
