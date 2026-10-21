// The colour palette the ribbon's colour commands open: the theme's ten
// colours with five lighter and darker steps of each, the standard colours,
// the colours used recently, and a picker for any other. Theme colours are
// written as references to the theme with luminance modifiers, so they
// follow a later change of theme.
import { el, closeMenu } from "./ui.js";

const THEME_SLOTS = [
  ["bg1", "light1", "Background 1"],
  ["tx1", "dark1", "Text 1"],
  ["bg2", "light2", "Background 2"],
  ["tx2", "dark2", "Text 2"],
  ["accent1", "accent1", "Accent 1"],
  ["accent2", "accent2", "Accent 2"],
  ["accent3", "accent3", "Accent 3"],
  ["accent4", "accent4", "Accent 4"],
  ["accent5", "accent5", "Accent 5"],
  ["accent6", "accent6", "Accent 6"],
];
export const STANDARD_COLORS = [
  ["#C00000", "Dark Red"],
  ["#FF0000", "Red"],
  ["#FFC000", "Orange"],
  ["#FFFF00", "Yellow"],
  ["#92D050", "Light Green"],
  ["#00B050", "Green"],
  ["#00B0F0", "Light Blue"],
  ["#0070C0", "Blue"],
  ["#002060", "Dark Blue"],
  ["#7030A0", "Purple"],
];

const hexToRgb = (hex) => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
const rgbToHex = (rgb) =>
  "#" +
  rgb
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();
function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? (g - b) / d + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}
// Applies luminance modulation and offset (in 1000ths of a percent) in HSL
// space, as DrawingML defines them.
export function modulate(hex, lumMod = 100000, lumOff = 0) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const next = Math.min(
    1,
    Math.max(0, (l * lumMod) / 100000 + lumOff / 100000),
  );
  return rgbToHex(hslToRgb([h, s, next]));
}
// The five steps below a theme colour, as [label, lumMod, lumOff]: lighter
// steps for dark colours, darker ones for light colours, both otherwise.
function steps(hex) {
  const l = rgbToHsl(hexToRgb(hex))[2];
  if (l < 0.2)
    return [
      ["Lighter 90%", 10000, 90000],
      ["Lighter 75%", 25000, 75000],
      ["Lighter 50%", 50000, 50000],
      ["Lighter 25%", 75000, 25000],
      ["Lighter 10%", 90000, 10000],
    ];
  if (l > 0.8)
    return [
      ["Darker 5%", 95000, 0],
      ["Darker 15%", 85000, 0],
      ["Darker 25%", 75000, 0],
      ["Darker 35%", 65000, 0],
      ["Darker 50%", 50000, 0],
    ];
  return [
    ["Lighter 80%", 20000, 80000],
    ["Lighter 60%", 40000, 60000],
    ["Lighter 40%", 60000, 40000],
    ["Darker 25%", 75000, 0],
    ["Darker 50%", 50000, 0],
  ];
}
const recent = [];
function remember(value, hex, label) {
  const at = recent.findIndex((entry) => entry.hex === hex);
  if (at >= 0) recent.splice(at, 1);
  recent.unshift({ value, hex, label });
  recent.length = Math.min(recent.length, 10);
}

// Menu items for a colour command. `theme` is the deck's theme
// (P.getPresentationTheme), `onPick(value, hex)` applies a colour, where
// value is "#RRGGBB" or "scheme:accent1/lumMod=75000"; `none` adds a "No
// Fill"-style first entry, `extra` more items at the end.
export function colorMenuItems({
  theme,
  onPick,
  none = null,
  automatic = null,
  extra = [],
  current = null,
}) {
  const swatch = (value, hex, label) =>
    el("button", {
      type: "button",
      class: `palette-swatch ${current && current.toUpperCase() === hex ? "current" : ""}`,
      style: `background:${hex}`,
      "aria-label": label,
      title: label,
      role: "menuitem",
      tabindex: -1,
      onclick: () => {
        closeMenu();
        remember(value, hex, label);
        onPick(value, hex);
      },
    });
  const grid = el("div", {
    class: "palette",
    role: "group",
    "aria-label": "Colors",
    "data-arrow-keys": "",
  });
  if (theme) {
    grid.append(el("div", { class: "palette-heading" }, "Theme Colors"));
    const base = el("div", { class: "palette-row" });
    const shades = el("div", { class: "palette-columns" });
    for (const [token, key, name] of THEME_SLOTS) {
      const hex = `#${String(theme[key] || "000000")
        .replace("#", "")
        .toUpperCase()}`;
      base.append(swatch(`scheme:${token}`, hex, name));
      const column = el("div", { class: "palette-column" });
      for (const [step, mod, off] of steps(hex)) {
        const value = `scheme:${token}/lumMod=${mod}${off ? `/lumOff=${off}` : ""}`;
        column.append(
          swatch(value, modulate(hex, mod, off), `${name}, ${step}`),
        );
      }
      shades.append(column);
    }
    grid.append(base, shades);
  }
  grid.append(el("div", { class: "palette-heading" }, "Standard Colors"));
  grid.append(
    el(
      "div",
      { class: "palette-row" },
      ...STANDARD_COLORS.map(([hex, name]) => swatch(hex, hex, name)),
    ),
  );
  if (recent.length) {
    grid.append(el("div", { class: "palette-heading" }, "Recent Colors"));
    grid.append(
      el(
        "div",
        { class: "palette-row" },
        ...recent.map(({ value, hex, label }) => swatch(value, hex, label)),
      ),
    );
  }
  // Arrow keys move through the swatches as a grid.
  grid.addEventListener("keydown", (e) => {
    const all = [...grid.querySelectorAll(".palette-swatch")];
    const at = all.indexOf(document.activeElement);
    if (at < 0) return;
    const rects = all.map((node) => node.getBoundingClientRect());
    const here = rects[at];
    let best = null;
    const dir = {
      ArrowRight: [1, 0],
      ArrowLeft: [-1, 0],
      ArrowDown: [0, 1],
      ArrowUp: [0, -1],
    }[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    let bestScore = Infinity;
    rects.forEach((r, i) => {
      const dx = r.left - here.left,
        dy = r.top - here.top;
      if (dir[0] && Math.sign(dx) !== dir[0]) return;
      if (dir[1] && Math.sign(dy) !== dir[1]) return;
      const score = dir[0]
        ? Math.abs(dx) + Math.abs(dy) * 4
        : Math.abs(dy) + Math.abs(dx) * 4;
      if (score < bestScore) {
        bestScore = score;
        best = all[i];
      }
    });
    best?.focus();
  });
  const picker = () => {
    const input = el("input", { type: "color", class: "palette-picker" });
    input.value =
      current && /^#[0-9a-f]{6}$/i.test(current) ? current : "#000000";
    document.body.append(input);
    const done = () => {
      input.remove();
    };
    input.addEventListener("change", () => {
      const hex = input.value.toUpperCase();
      remember(hex, hex, hex);
      onPick(hex, hex);
      done();
    });
    input.addEventListener("cancel", done);
    input.click();
  };
  return [
    ...(automatic ? [{ ...automatic }, { separator: true }] : []),
    { custom: grid },
    { separator: true },
    ...(none ? [{ ...none }] : []),
    { label: "More Colors…", icon: "o:colors", onSelect: picker },
    ...(window.EyeDropper
      ? [
          {
            label: "Eyedropper",
            icon: "Pipette",
            onSelect: async () => {
              try {
                const { sRGBHex } = await new window.EyeDropper().open();
                const hex = sRGBHex.toUpperCase();
                remember(hex, hex, hex);
                onPick(hex, hex);
              } catch {}
            },
          },
        ]
      : []),
    ...extra,
  ];
}
