// Pictures of themes, drawn by the slide renderer from the real theme: a
// small presentation in the theme with one Title Slide, rendered once per
// session for each theme, variant and slide shape. Also the color math the
// galleries use to paint swatches of theme colors.
import { el } from "../ui.js";
import { P, preview } from "../model.js";
import { themeById } from "./catalog.js";
import { applyColors, applyTheme } from "./engine.js";

const pictures = new Map();

/**
 * A slide on `master`'s Title Slide layout (or its first layout with a
 * title) carrying `title` and `subtitle`, drawn by the renderer. A title of
 * "Aa" is a specimen of the heading font: a third of the slide tall.
 */
function specimen(pres, master, title, subtitle) {
  const layouts =
    P.getSlideMasters(pres).find((m) => m.partName === master)?.layouts || [];
  const titled = (l) =>
    P.getSlideShapes(P.getTemplateSlide(pres, l.partName)).some((s) =>
      ["title", "ctrTitle"].includes(P.getShapePlaceholderType(s)),
    );
  const layout =
    layouts.find((l) => l.type === "title") ||
    layouts.find(titled) ||
    layouts[0];
  if (!layout) return null;
  P.addSlide(pres, {
    layout: P.findSlideLayoutByPartName(pres, layout.partName),
  });
  const slide = P.getSlides(pres).at(-1);
  const height = Number(P.getSlideSize(pres)?.height ?? 6858000) / 12700;
  for (const shape of [...P.getSlideShapes(slide)]) {
    const type = P.getShapePlaceholderType(shape);
    const value =
      type === "ctrTitle" || type === "title"
        ? title
        : type === "subTitle"
          ? subtitle
          : "";
    if (!value) {
      P.removeShape(shape);
      continue;
    }
    P.setShapeText(shape, value);
    if (value === "Aa" && value === title) {
      P.setShapeTextAutoFit(shape, "none");
      P.setShapeTextFormat(shape, { size: Math.round(height * 0.32) });
    }
  }
  return preview(pres, P.getSlides(pres).at(-1));
}

/**
 * The picture of `themeId` in `variant`: a Title Slide with `title` (and
 * `subtitle`) in its placeholders, on a 16:9 or 4:3 slide.
 */
export function themePicture(
  themeId,
  variant = 0,
  { aspect = "16:9", title = "Aa", subtitle = "" } = {},
) {
  const key = [themeId, variant, aspect, title, subtitle].join("|");
  if (pictures.has(key)) return pictures.get(key);
  if (!themeById(themeId)) return null;
  const pres = P.createPresentation({ size: aspect });
  const master = applyTheme(pres, themeId, { variant });
  const src = specimen(pres, master, title, subtitle);
  pictures.set(key, src);
  return src;
}

/**
 * The same picture of a master of `pres` (an imported or customized theme):
 * the master and its layouts are copied into a scratch presentation, given
 * `colors` (and their light or dark mapping) when asked, and drawn there.
 * `key` names the master's current state, for the cache.
 */
export function masterPicture(pres, master, key, { colors, dark } = {}) {
  const cacheKey = `master|${key}|${colors ? JSON.stringify(colors) : ""}|${dark}`;
  if (pictures.has(cacheKey)) return pictures.get(cacheKey);
  let src = null;
  try {
    const size = P.getSlideSize(pres);
    const scratch = P.createPresentation();
    if (size)
      P.setSlideSize(scratch, {
        width: Number(size.width),
        height: Number(size.height),
      });
    const copy = P.importSlideMasterFile(
      scratch,
      P.exportThemeFile(pres, master),
    );
    if (colors) applyColors(scratch, [copy], colors, { dark });
    src = specimen(scratch, copy, "Aa", "");
  } catch {
    src = null;
  }
  pictures.set(cacheKey, src);
  return src;
}

/** Theme accents as a strip of six swatches. */
export const accentStrip = (colors) =>
  el(
    "span",
    { class: "theme-accents", "aria-hidden": "true" },
    ...[1, 2, 3, 4, 5, 6].map((n) =>
      el("span", { style: `background:${colors[`accent${n}`]}` }),
    ),
  );

/** A gallery tile: the rendered picture with its accents beneath. */
export function themeTile(themeId, variant = 0, aspect = "16:9") {
  const theme = themeById(themeId);
  const colors = theme.variants[variant]?.colors || theme.variants[0].colors;
  return el(
    "span",
    { class: "theme-tile" },
    el("img", {
      src: themePicture(themeId, variant, { aspect }),
      alt: "",
      draggable: "false",
    }),
    accentStrip(colors),
  );
}

// ---------------------------------------------------------------------------
// Colors: scheme slots and their tints and shades as CSS colors.

const hexToRgb = (hex) =>
  hex
    .replace("#", "")
    .match(/../g)
    .map((c) => parseInt(c, 16));
const rgbToHex = (rgb) =>
  `#${rgb
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
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
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/**
 * A color spec ("accent1/lumMod=75000", "bg2/tint=80000", "#336699") as
 * hex, through `colors` (12 scheme slots) and the light or dark color map.
 * Also returns its alpha.
 */
export function resolveSpec(spec, colors, dark = false) {
  const [head, ...mods] = String(spec).split("/");
  const map = dark
    ? { bg1: "dk1", tx1: "lt1", bg2: "dk2", tx2: "lt2" }
    : { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
  let hex = head.startsWith("#")
    ? head
    : colors[map[head] || head] || "#000000";
  let alpha = 1;
  let rgb = hexToRgb(hex);
  for (const m of mods) {
    const [name, raw] = m.split("=");
    const v = Number(raw) / 100000;
    if (name === "alpha") alpha = v;
    else if (name === "tint") rgb = rgb.map((c) => c + (255 - c) * (1 - v));
    else if (name === "shade") rgb = rgb.map((c) => c * v);
    else if (name === "lumMod" || name === "lumOff") {
      const hsl = rgbToHsl(rgb);
      hsl[2] = name === "lumMod" ? hsl[2] * v : Math.min(1, hsl[2] + v);
      rgb = hslToRgb(hsl);
    }
  }
  hex = rgbToHex(rgb);
  return { hex, alpha };
}

/** CSS for a fill spec (color, gradient or pattern) over `colors`. */
export function fillCss(spec, colors, dark) {
  const css = (s) => {
    const { hex, alpha } = resolveSpec(s, colors, dark);
    if (alpha >= 1) return hex;
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  };
  if (typeof spec === "string") return css(spec);
  if (spec.grad) {
    const stops = spec.grad
      .map(([pos, c]) => `${css(c)} ${Math.round(pos * 100)}%`)
      .join(",");
    if (spec.path === "circle")
      return `radial-gradient(circle at ${(spec.focus?.[0] ?? 0.5) * 100}% ${(spec.focus?.[1] ?? 0.5) * 100}%, ${stops})`;
    if (spec.path) return `radial-gradient(farthest-side at 50% 50%, ${stops})`;
    return `linear-gradient(${(spec.angle ?? 90) + 90}deg, ${stops})`;
  }
  if (spec.pattern) return css(spec.bg);
  return "transparent";
}
