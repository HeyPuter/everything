// Color transforms and rPr-like element parsing.

import { resolvePresetColor } from "./preset-colors.ts";

import { NAME_A_RPR, requireRun } from "./shape-runs.ts";
import { type TextFormat } from "../../internal/drawingml/index.ts";
import {
  NS,
  type XmlElement,
  firstChildElement,
  getAttrValue,
  qname,
} from "../../internal/xml/index.ts";
import { type SlideShapeData } from "../_internal-symbols.ts";
import { type PresentationTheme } from "./theme.ts";
// -- Color transforms (ECMA-376 §20.1.2.3.x) --------------------------------
//
// DrawingML color elements (`<a:srgbClr>`, `<a:schemeClr>`, `<a:sysClr>`,
// `<a:prstClr>`) may carry one or more transform children — `lumMod`,
// `lumOff`, `shade`, `tint`, `satMod`, `hueMod`, `alpha`, `gray`, `inv`,
// `comp`, etc. — that adjust the base color before it's painted. Real
// templates use them heavily for "tinted accent" backgrounds and "shaded
// hover" states, so any visual-fidelity story has to apply them.
//
// Percentages in the spec use the `ST_Percentage` style — `100000`
// represents 100% — though some third-party tools emit bare floats; we
// accept both forms.

type ColorTransformOp =
  | {
      readonly kind:
        | "lumMod"
        | "lumOff"
        | "shade"
        | "tint"
        | "satMod"
        | "satOff"
        | "hueMod"
        | "hueOff"
        | "alpha"
        | "alphaMod"
        | "alphaOff";
      readonly val: number;
    }
  | { readonly kind: "gray" | "inv" | "comp" };

const COLOR_TRANSFORM_LOCALS: ReadonlySet<string> = new Set([
  "lumMod",
  "lumOff",
  "shade",
  "tint",
  "satMod",
  "satOff",
  "hueMod",
  "hueOff",
  "alpha",
  "alphaMod",
  "alphaOff",
  "gray",
  "inv",
  "comp",
]);

const parseColorTransforms = (
  colorEl: XmlElement,
): readonly ColorTransformOp[] => {
  const out: ColorTransformOp[] = [];
  for (const child of colorEl.children) {
    if (child.kind !== "element" || child.name.namespaceURI !== NS.dml)
      continue;
    const local = child.name.localName;
    if (!COLOR_TRANSFORM_LOCALS.has(local)) continue;
    if (local === "gray" || local === "inv" || local === "comp") {
      out.push({ kind: local });
      continue;
    }
    const raw = getAttrValue(child, qname("", "val", ""));
    if (raw === null) continue;
    const value = raw.trim();
    let n = Number(value.endsWith("%") ? value.slice(0, -1) : value);
    if (!value || !Number.isFinite(n)) continue;
    if (local === "hueOff") {
      // ST_Angle uses 1/60000 degree, not a percentage.
      n /= 60000;
    } else if (value.endsWith("%")) {
      n /= 100;
    } else if (!(value.includes(".") && Math.abs(n) <= 1)) {
      // Integers are thousandths of a percent, including 1 (= 0.001%).
      // Retain support for third-party normalized decimal fractions.
      n /= 100000;
    }
    out.push({
      kind: local as Exclude<ColorTransformOp["kind"], "gray" | "inv" | "comp">,
      val: n,
    });
  }
  return out;
};

const hexToRgb01 = (hex: string): [number, number, number] => {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [
    Number.parseInt(h.slice(0, 2), 16) / 255,
    Number.parseInt(h.slice(2, 4), 16) / 255,
    Number.parseInt(h.slice(4, 6), 16) / 255,
  ];
};

const rgb01ToHex = (r: number, g: number, b: number): string => {
  const clamp = (v: number): number =>
    Math.max(0, Math.min(255, Math.round(v * 255)));
  const part = (n: number): string =>
    n.toString(16).padStart(2, "0").toUpperCase();
  return `#${part(clamp(r))}${part(clamp(g))}${part(clamp(b))}`;
};

export const rgbToHsl = (
  r: number,
  g: number,
  b: number,
): [number, number, number] => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
};

const hueToRgb = (p: number, q: number, t: number): number => {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};

const hslToRgb = (
  h: number,
  s: number,
  l: number,
): [number, number, number] => {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hueToRgb(p, q, h + 1 / 3),
    hueToRgb(p, q, h),
    hueToRgb(p, q, h - 1 / 3),
  ];
};

// <a:tint> / <a:shade> are applied in LINEAR-LIGHT RGB, not in sRGB —
// this contradicts the literal ECMA-376 "N% of input + (100-N)% white/black"
// wording, but it is what the native reference and LibreOffice render
// (a 75% tint of black is mid-gray ~#8B8B8B, not the sRGB-lerp #404040). The
// next reader will expect the sRGB formula, hence this note.
const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

const applyColorTransforms = (
  rgb: [number, number, number],
  transforms: readonly ColorTransformOp[],
): [number, number, number] => {
  if (transforms.length === 0) return rgb;
  let [r, g, b] = rgb;
  for (const t of transforms) {
    switch (t.kind) {
      case "inv":
        // DrawingML inversion operates on linear RGB, like tint and shade.
        r = linearToSrgb(1 - srgbToLinear(r));
        g = linearToSrgb(1 - srgbToLinear(g));
        b = linearToSrgb(1 - srgbToLinear(b));
        break;
      case "gray": {
        const y = 0.3 * r + 0.59 * g + 0.11 * b;
        r = g = b = y;
        break;
      }
      case "comp": {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb((h + 0.5) % 1, s, l);
        break;
      }
      case "shade":
        // Mix toward black in linear light: out = srgb(linear(base) * val)
        r = linearToSrgb(srgbToLinear(r) * t.val);
        g = linearToSrgb(srgbToLinear(g) * t.val);
        b = linearToSrgb(srgbToLinear(b) * t.val);
        break;
      case "tint":
        // Mix toward white in linear light: out = srgb(linear(base)*val + (1-val))
        r = linearToSrgb(srgbToLinear(r) * t.val + (1 - t.val));
        g = linearToSrgb(srgbToLinear(g) * t.val + (1 - t.val));
        b = linearToSrgb(srgbToLinear(b) * t.val + (1 - t.val));
        break;
      case "lumMod":
      case "lumOff": {
        const [h, s, l] = rgbToHsl(r, g, b);
        const newL = Math.max(
          0,
          Math.min(1, t.kind === "lumMod" ? l * t.val : l + t.val),
        );
        [r, g, b] = hslToRgb(h, s, newL);
        break;
      }
      case "satMod":
      case "satOff": {
        const [h, s, l] = rgbToHsl(r, g, b);
        // Signed saturation outside [0, 1] is permitted and RGB is clipped
        // before the next transform. For achromatic input the conversion uses
        // an undefined-hue sentinel (-1), rather than red (0). Native controls
        // distinguish gray + satOff from a nearly gray chromatic input, and
        // hueOff before saturation from hueOff after it. Keep this compatibility
        // behavior local to saturation; ordinary HSL colors retain normal hue.
        const newS = t.kind === "satMod" ? s * t.val : s + t.val;
        // At either luminance endpoint chroma is zero regardless of saturation.
        // Avoid roundoff creating a tiny chroma that a following HSL operation
        // could magnify (for example white → satOff → lumOff).
        const rgb: [number, number, number] =
          l === 0 || l === 1 ? [l, l, l] : hslToRgb(s === 0 ? -1 : h, newS, l);
        r = Math.max(0, Math.min(1, rgb[0]));
        g = Math.max(0, Math.min(1, rgb[1]));
        b = Math.max(0, Math.min(1, rgb[2]));
        break;
      }
      case "hueMod":
      case "hueOff": {
        const [h, s, l] = rgbToHsl(r, g, b);
        const newH =
          (((t.kind === "hueMod" ? h * t.val : h + t.val / 360) % 1) + 1) % 1;
        [r, g, b] = hslToRgb(newH, s, l);
        break;
      }
      // alpha / alphaMod / alphaOff intentionally don't touch RGB — they
      // surface as `fill-opacity`, not as a tinted color.
    }
  }
  return [r, g, b];
};

/** Resolves alpha, alphaMod and alphaOff in document order, separately from RGB. */
export const resolveDrawingOpacity = (colorEl: XmlElement): number => {
  // Most text colors have no transforms; avoid allocating a transform list
  // for each layer of every run's inherited formatting.
  if (colorEl.children.length === 0) return 1;
  let opacity = 1;
  for (const transform of parseColorTransforms(colorEl)) {
    switch (transform.kind) {
      case "alpha":
        opacity = transform.val;
        break;
      case "alphaMod":
        opacity *= transform.val;
        break;
      case "alphaOff":
        opacity += transform.val;
        break;
      default:
        continue;
    }
    opacity = Math.max(0, Math.min(1, opacity));
  }
  return opacity;
};

const SCHEME_TOKEN_TO_THEME_KEY: Record<
  string,
  keyof Omit<PresentationTheme, "name">
> = {
  tx1: "dark1",
  dk1: "dark1",
  bg1: "light1",
  lt1: "light1",
  tx2: "dark2",
  dk2: "dark2",
  bg2: "light2",
  lt2: "light2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hlink: "hyperlink",
  folHlink: "followedHyperlink",
};

/**
 * Resolves a scheme token (`tx1`, `bg1`, `accent1`, …) to its `#RRGGBB`.
 *
 * When `clrMap` is supplied, the slide token is first remapped through it
 * (`<p:clrMap>` / `<a:overrideClrMapping>`) — `tx1` may point at `dk1` or
 * `lt1` depending on the deck — and only then indexed into the theme. Without
 * a map the token is indexed directly, preserving the historical behavior
 * (correct for the standard map, the overwhelming common case).
 *
 * @internal
 */
export const resolveSchemeToken = (
  token: string,
  theme: PresentationTheme | null,
  clrMap?: Readonly<Record<string, string>> | null,
): string | null => {
  if (!theme) return null;
  const mapped = clrMap?.[token] ?? token;
  const key =
    SCHEME_TOKEN_TO_THEME_KEY[mapped] ?? SCHEME_TOKEN_TO_THEME_KEY[token];
  if (!key) return null;
  const hex = theme[key];
  if (typeof hex !== "string") return null;
  const normalized = hex.startsWith("#") ? hex : `#${hex}`;
  return /^#[0-9A-Fa-f]{6}$/.test(normalized) ? normalized.toUpperCase() : null;
};

const resolveByteColor = (
  colorEl: XmlElement,
  theme: PresentationTheme | null,
  clrMap?: Readonly<Record<string, string>> | null,
): string | null => {
  const local = colorEl.name.localName;
  if (local === "srgbClr" || local === "sysClr") {
    const value = getAttrValue(
      colorEl,
      qname("", local === "sysClr" ? "lastClr" : "val", ""),
    );
    return value ? `#${value.toUpperCase()}` : null;
  }
  const token = getAttrValue(colorEl, qname("", "val", ""));
  if (local === "schemeClr")
    return token ? resolveSchemeToken(token, theme, clrMap) : null;
  if (local === "prstClr")
    return token === null ? null : resolvePresetColor(token);
  return null;
};

/**
 * Resolves a DrawingML color element (`<a:srgbClr>` / `<a:schemeClr>` /
 * `<a:sysClr>` / `<a:prstClr>`) with all its `<a:lumMod>` / `<a:tint>` /
 * `<a:shade>` / `<a:satMod>` etc. transform children applied. Returns
 * `null` when the color is a scheme token and no theme is supplied to
 * resolve it.
 *
 * Exposed because both run-format and fill-format code paths need to
 * apply the same transform pipeline; keeping a single implementation
 * means future spec-coverage additions only have to land in one place.
 */
const resolveDrawingColorValue = (
  colorEl: XmlElement,
  theme: PresentationTheme | null,
  clrMap?: Readonly<Record<string, string>> | null,
): string | [number, number, number] | null => {
  if (colorEl.name.namespaceURI !== NS.dml) return null;
  const local = colorEl.name.localName;
  const baseHex = resolveByteColor(colorEl, theme, clrMap);
  let baseRgb: [number, number, number] | null = null;
  if (local === "scrgbClr") {
    const channel = (name: string): number | null => {
      const raw = getAttrValue(colorEl, qname("", name, ""));
      if (raw === null) return null;
      const n = Number.parseFloat(raw);
      return Number.isFinite(n)
        ? Math.max(0, Math.min(1, n / (raw.endsWith("%") ? 100 : 100000)))
        : null;
    };
    const r = channel("r"),
      g = channel("g"),
      b = channel("b");
    if (r !== null && g !== null && b !== null)
      baseRgb = [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
  } else if (local === "hslClr") {
    const hue = getAttrValue(colorEl, qname("", "hue", ""));
    const sat = getAttrValue(colorEl, qname("", "sat", ""));
    const lum = getAttrValue(colorEl, qname("", "lum", ""));
    if (hue !== null && sat !== null && lum !== null) {
      const h = Number(hue) / 21600000;
      const s = Number.parseFloat(sat) / (sat.endsWith("%") ? 100 : 100000);
      const l = Number.parseFloat(lum) / (lum.endsWith("%") ? 100 : 100000);
      if ([h, s, l].every(Number.isFinite))
        baseRgb = hslToRgb(
          ((h % 1) + 1) % 1,
          Math.max(0, Math.min(1, s)),
          Math.max(0, Math.min(1, l)),
        );
    }
  }
  const transforms = parseColorTransforms(colorEl);
  // Keep the common byte-color fast path allocation-free when untransformed.
  if (baseHex && transforms.length === 0) return baseHex;
  if (!baseRgb && baseHex && /^#[0-9a-f]{6}$/i.test(baseHex))
    baseRgb = hexToRgb01(baseHex);
  if (!baseRgb) return null;
  return applyColorTransforms(baseRgb, transforms);
};

/** Full-precision sRGB components for consumers which continue color math. */
export const resolveDrawingColorRgb = (
  colorEl: XmlElement,
  theme: PresentationTheme | null,
  clrMap?: Readonly<Record<string, string>> | null,
): [number, number, number] | null => {
  const color = resolveDrawingColorValue(colorEl, theme, clrMap);
  if (typeof color !== "string") return color;
  return /^#[0-9a-f]{6}$/i.test(color) ? hexToRgb01(color) : null;
};

/** Quantize only after the complete transform sequence. HSL/scRGB colors can
 * contain precision which affects later transforms and diagram interpolation. */
export const resolveDrawingColor = (
  colorEl: XmlElement,
  theme: PresentationTheme | null,
  clrMap?: Readonly<Record<string, string>> | null,
): string | null => {
  if (colorEl.name.namespaceURI !== NS.dml) return null;
  if (colorEl.children.length === 0) {
    const byteColor = resolveByteColor(colorEl, theme, clrMap);
    if (byteColor) return byteColor;
  }
  const color = resolveDrawingColorValue(colorEl, theme, clrMap);
  return typeof color === "string"
    ? color
    : color
      ? rgb01ToHex(...color)
      : null;
};

// Reads any element shaped like `CT_TextCharacterProperties` (the schema
// shared by `<a:rPr>`, `<a:defRPr>`, and `<a:endParaRPr>`) into a partial
// TextFormat. Used by both the literal-only `getShapeRunFormat` and the
// inheritance-aware `getShapeRunFormatEffective`.
//
// When `ctx.theme` is provided, scheme tokens are resolved to concrete
// `#RRGGBB` and color transforms (`<a:lumMod>` etc.) are applied. Without
// a theme, transforms are not applied and theme tokens are passed through
// verbatim — this preserves the legacy `getShapeRunFormat` behavior.
// The color inside a fill-like element (`solidFill`, `gs`, an effect), read
// the way the run's own color is: resolved with a theme, else literal.
const readInnerColor = (
  host: XmlElement | null,
  ctx?: {
    readonly theme: PresentationTheme | null;
    readonly clrMap?: Readonly<Record<string, string>>;
  },
): { color: string; opacity: number } | null => {
  if (!host) return null;
  const color = host.children.find(
    (c): c is XmlElement =>
      c.kind === "element" &&
      c.name.namespaceURI === NS.dml &&
      [
        "srgbClr",
        "schemeClr",
        "sysClr",
        "prstClr",
        "scrgbClr",
        "hslClr",
      ].includes(c.name.localName),
  );
  if (!color) return null;
  const opacity = resolveDrawingOpacity(color);
  if (ctx) {
    const hex = resolveDrawingColor(
      color,
      ctx.theme,
      color.name.localName === "schemeClr" ? ctx.clrMap : undefined,
    );
    if (hex !== null) return { color: hex, opacity };
  }
  const v = getAttrValue(color, qname("", "val", ""));
  if (v === null) return null;
  return {
    color: color.name.localName === "srgbClr" ? `#${v.toUpperCase()}` : v,
    opacity,
  };
};

const intOf = (el: XmlElement, name: string): number => {
  const n = Number.parseInt(getAttrValue(el, qname("", name, "")) ?? "", 10);
  return Number.isFinite(n) ? n : 0;
};

// Underline color, equal-height glyphs, outline, gradient fill and effects.
const readExtendedRunFormat = (
  rPr: XmlElement,
  out: Partial<TextFormat>,
  ctx?: {
    readonly theme: PresentationTheme | null;
    readonly clrMap?: Readonly<Record<string, string>>;
  },
): void => {
  const child = (name: string) =>
    firstChildElement(rPr, qname("a", name, NS.dml));
  const normalizeH = getAttrValue(rPr, qname("", "normalizeH", ""));
  if (normalizeH !== null)
    out.normalizeHeight = normalizeH === "1" || normalizeH === "true";
  if (child("uFillTx")) out.underlineColor = null;
  const uFill = child("uFill");
  if (uFill) {
    const color = readInnerColor(
      firstChildElement(uFill, qname("a", "solidFill", NS.dml)),
      ctx,
    );
    if (color) out.underlineColor = color.color;
  }
  const ln = child("ln");
  if (ln) {
    if (firstChildElement(ln, qname("a", "noFill", NS.dml))) out.outline = null;
    else {
      const color = readInnerColor(
        firstChildElement(ln, qname("a", "solidFill", NS.dml)),
        ctx,
      );
      if (color) {
        const dash = firstChildElement(ln, qname("a", "prstDash", NS.dml));
        const dashValue = dash && getAttrValue(dash, qname("", "val", ""));
        out.outline = {
          color: color.color,
          widthEmu:
            getAttrValue(ln, qname("", "w", "")) === null
              ? 12700
              : intOf(ln, "w"),
          ...(color.opacity < 1 ? { opacity: color.opacity } : {}),
          ...(dashValue ? { dash: dashValue } : {}),
        };
      }
    }
  }
  const grad = child("gradFill");
  if (grad) {
    const gsLst = firstChildElement(grad, qname("a", "gsLst", NS.dml));
    const stops = (gsLst?.children ?? []).flatMap((gs) => {
      if (gs.kind !== "element" || gs.name.localName !== "gs") return [];
      const color = readInnerColor(gs, ctx);
      return color
        ? [
            {
              offset: intOf(gs, "pos") / 100000,
              color: color.color,
              ...(color.opacity < 1 ? { opacity: color.opacity } : {}),
            },
          ]
        : [];
    });
    const lin = firstChildElement(grad, qname("a", "lin", NS.dml));
    if (stops.length >= 2)
      out.gradient = {
        stops,
        angleDeg: lin ? intOf(lin, "ang") / 60000 : 90,
      };
  }
  const effectLst = child("effectLst");
  if (effectLst) {
    const effects: {
      -readonly [K in keyof NonNullable<TextFormat["effects"]>]: NonNullable<
        TextFormat["effects"]
      >[K];
    } = {};
    for (const e of effectLst.children) {
      if (e.kind !== "element" || e.name.namespaceURI !== NS.dml) continue;
      const name = e.name.localName;
      if (name === "outerShdw" || name === "innerShdw") {
        const color = readInnerColor(e, ctx);
        effects.shadow = {
          color: color?.color ?? "#000000",
          ...(color && color.opacity < 1 ? { opacity: color.opacity } : {}),
          blurEmu: intOf(e, "blurRad"),
          distEmu: intOf(e, "dist"),
          angleDeg: intOf(e, "dir") / 60000,
          ...(name === "innerShdw" ? { inner: true } : {}),
        };
      } else if (name === "glow") {
        const color = readInnerColor(e, ctx);
        effects.glow = {
          color: color?.color ?? "#000000",
          ...(color && color.opacity < 1 ? { opacity: color.opacity } : {}),
          radiusEmu: intOf(e, "rad"),
        };
      } else if (name === "reflection") {
        const stA = getAttrValue(e, qname("", "stA", ""));
        const endPos = getAttrValue(e, qname("", "endPos", ""));
        effects.reflection = {
          startOpacity: stA === null ? 1 : intOf(e, "stA") / 100000,
          endPos: endPos === null ? 1 : intOf(e, "endPos") / 100000,
          distEmu: intOf(e, "dist"),
          blurEmu: intOf(e, "blurRad"),
        };
      }
    }
    out.effects = effects;
  }
};

export const parseRPrLikeElement = (
  rPr: XmlElement,
  ctx?: {
    readonly theme: PresentationTheme | null;
    readonly clrMap?: Readonly<Record<string, string>>;
  },
): Partial<TextFormat> => {
  const out: Partial<TextFormat> = {};
  const language = getAttrValue(rPr, qname("", "lang", ""));
  if (language !== null) out.language = language;
  const alternateLanguage = getAttrValue(rPr, qname("", "altLang", ""));
  if (alternateLanguage !== null) out.alternateLanguage = alternateLanguage;
  const sz = getAttrValue(rPr, qname("", "sz", ""));
  if (sz !== null) {
    const n = Number.parseInt(sz, 10);
    if (Number.isFinite(n)) out.size = n / 100;
  }
  const b = getAttrValue(rPr, qname("", "b", ""));
  if (b !== null) out.bold = b !== "0";
  const i = getAttrValue(rPr, qname("", "i", ""));
  if (i !== null) out.italic = i !== "0";
  const u = getAttrValue(rPr, qname("", "u", ""));
  if (u !== null) {
    if (u === "none") out.underline = false;
    else if (u === "sng") out.underline = true;
    else out.underline = u;
  }
  const strike = getAttrValue(rPr, qname("", "strike", ""));
  if (strike !== null) {
    if (strike === "noStrike") out.strike = false;
    else if (strike === "sngStrike") out.strike = true;
    else out.strike = strike;
  }
  const spc = getAttrValue(rPr, qname("", "spc", ""));
  if (spc !== null) {
    const n = Number.parseInt(spc, 10);
    if (Number.isFinite(n)) out.spc = n;
  }
  const kern = getAttrValue(rPr, qname("", "kern", ""));
  if (kern !== null) {
    const n = Number.parseInt(kern, 10);
    if (Number.isFinite(n)) out.kern = n;
  }
  const baselineAttr = getAttrValue(rPr, qname("", "baseline", ""));
  if (baselineAttr !== null) {
    // ST_Percentage: 100000 = 100%; tolerate bare floats.
    let n = Number.parseFloat(baselineAttr);
    if (Number.isFinite(n)) {
      if (Math.abs(n) > 1) n = n / 100000;
      out.baseline = n;
    }
  }
  const cap = getAttrValue(rPr, qname("", "cap", ""));
  if (cap === "none" || cap === "small" || cap === "all") {
    out.cap = cap;
  }
  // <a:highlight><a:srgbClr val="…"/></a:highlight>
  const highlight = firstChildElement(rPr, qname("a", "highlight", NS.dml));
  if (highlight !== null) {
    let hlChild: XmlElement | null = null;
    for (const c of highlight.children) {
      if (c.kind !== "element" || c.name.namespaceURI !== NS.dml) continue;
      hlChild = c;
      break;
    }
    if (hlChild) {
      if (ctx) {
        const hex = resolveDrawingColor(
          hlChild,
          ctx.theme,
          hlChild.name.localName === "schemeClr" ? ctx.clrMap : undefined,
        );
        if (hex !== null) out.highlight = hex;
      } else if (hlChild.name.localName === "srgbClr") {
        const v = getAttrValue(hlChild, qname("", "val", ""));
        if (v !== null) out.highlight = `#${v.toUpperCase()}`;
      } else if (hlChild.name.localName === "schemeClr") {
        const v = getAttrValue(hlChild, qname("", "val", ""));
        if (v !== null) out.highlight = v;
      }
    }
  }
  const solidFill = firstChildElement(rPr, qname("a", "solidFill", NS.dml));
  if (solidFill !== null) {
    // Find the inner color element (srgbClr / schemeClr / sysClr / prstClr).
    // CT_SolidColorFillProperties holds exactly one EG_ColorChoice child.
    let colorChild: XmlElement | null = null;
    for (const c of solidFill.children) {
      if (c.kind !== "element" || c.name.namespaceURI !== NS.dml) continue;
      colorChild = c;
      break;
    }
    if (colorChild) {
      // Alpha belongs to the selected fill, not an independent inherited
      // attribute. Explicit opaque colors must reset translucent defaults.
      out.colorOpacity = resolveDrawingOpacity(colorChild);
      if (ctx) {
        // Apply transforms + resolve scheme tokens to hex.
        const hex = resolveDrawingColor(
          colorChild,
          ctx.theme,
          colorChild.name.localName === "schemeClr" ? ctx.clrMap : undefined,
        );
        if (hex !== null) out.color = hex;
        else if (colorChild.name.localName === "schemeClr") {
          // Theme not provided / token not in scheme — surface the raw token.
          const v = getAttrValue(colorChild, qname("", "val", ""));
          if (v !== null) out.color = v;
        }
      } else {
        // Legacy `getShapeRunFormat` path: no transforms, scheme tokens
        // emitted as bare strings to match prior public behavior.
        if (colorChild.name.localName === "srgbClr") {
          const v = getAttrValue(colorChild, qname("", "val", ""));
          if (v !== null) out.color = `#${v.toUpperCase()}`;
        } else if (colorChild.name.localName === "schemeClr") {
          const v = getAttrValue(colorChild, qname("", "val", ""));
          if (v !== null) out.color = v;
        }
      }
    }
  }
  const latin = firstChildElement(rPr, qname("a", "latin", NS.dml));
  if (latin !== null) {
    const t = getAttrValue(latin, qname("", "typeface", ""));
    if (t !== null) out.font = t;
  }
  readExtendedRunFormat(rPr, out, ctx);
  const ea = firstChildElement(rPr, qname("a", "ea", NS.dml));
  if (ea !== null) {
    const t = getAttrValue(ea, qname("", "typeface", ""));
    if (t !== null) out.fontEastAsian = t;
  }
  return out;
};

/**
 * Reads back the format of a single run. Returns `null` when the run
 * has no `<a:rPr>` (it inherits its format from the paragraph /
 * layout / master). Boolean attributes that are explicitly `"0"`
 * decode to `false`.
 *
 * Use `getShapeRunFormatEffective` if you want the resolved format
 * after walking the placeholder / lstStyle / master inheritance chain.
 */
export const getShapeRunFormat = (
  shape: SlideShapeData,
  paragraphIndex: number,
  runIndex: number,
): TextFormat | null => {
  const run = requireRun(shape, paragraphIndex, runIndex);
  const rPr = firstChildElement(run, NAME_A_RPR);
  if (rPr === null) return null;
  return parseRPrLikeElement(rPr) as TextFormat;
};
