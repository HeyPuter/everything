// SmartArt color schemes and styles: how each kind of shape in a layout is
// painted. Colors are theme references, so a diagram follows its deck's
// theme; previews resolve them against a palette.

/** A theme color reference with DrawingML color transforms. */
export interface ColorRef {
  readonly val: string;
  readonly lumMod?: number;
  readonly lumOff?: number;
  readonly alpha?: number;
}

export type Fill =
  | { readonly kind: "solid"; readonly color: ColorRef }
  | {
      readonly kind: "gradient";
      readonly from: ColorRef;
      readonly to: ColorRef;
    };

export interface Paint {
  readonly fill: Fill | null;
  readonly line: { readonly color: ColorRef; readonly w: number } | null;
  readonly text: ColorRef;
  readonly shadow: {
    readonly blur: number;
    readonly dist: number;
    readonly alpha: number;
  } | null;
}

/**
 * What a shape is for, which decides its paint:
 * - node: a primary item shape;
 * - hub: an emphasized item (a hub, a root, a result);
 * - child: a secondary shape holding an item's sub-points;
 * - text: text set straight on the slide;
 * - trans: an arrow or other shape between items;
 * - bg: a large background shape behind items;
 * - line: a connector or rule (stroke only);
 * - pic: a picture placeholder;
 * - venn: a translucent overlapping shape.
 */
export type Role =
  "node" | "hub" | "child" | "text" | "trans" | "bg" | "line" | "pic" | "venn";

interface SchemeDef {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  /** The color of the item at `i` of `n`. */
  readonly main: (i: number, n: number) => ColorRef;
  /** Light shapes with colored outlines instead of colored fills. */
  readonly outline?: boolean;
}

const ACCENTS = [1, 2, 3, 4, 5, 6].map((n) => `accent${n}`);
const tint = (c: ColorRef, amount: number): ColorRef => ({
  val: c.val,
  lumMod: Math.round((1 - amount) * 100000),
  lumOff: Math.round(amount * 100000),
});
const shade = (c: ColorRef, amount: number): ColorRef => ({
  val: c.val,
  lumMod: Math.round((1 - amount) * 100000),
});
const plain = (val: string): ColorRef => ({ val });
const span = (i: number, n: number) => (n <= 1 ? 0 : i / (n - 1));

const SCHEMES: SchemeDef[] = [
  {
    id: "primary-dark",
    name: "Dark Fill",
    group: "Primary Theme Colors",
    main: () => plain("dk1"),
  },
  {
    id: "primary-dark2",
    name: "Second Dark Fill",
    group: "Primary Theme Colors",
    main: () => plain("dk2"),
  },
  {
    id: "primary-outline",
    name: "Dark Outline",
    group: "Primary Theme Colors",
    main: () => plain("dk1"),
    outline: true,
  },
  {
    id: "colorful",
    name: "All Accents",
    group: "Colorful",
    main: (i) => plain(ACCENTS[i % 6]!),
  },
  {
    id: "colorful-shifted",
    name: "All Accents, Shifted",
    group: "Colorful",
    main: (i) => plain(ACCENTS[(i + 1) % 6]!),
  },
  ...[
    [1, 2],
    [3, 4],
    [5, 6],
  ].map(([a, b]) => ({
    id: `colorful-${a}${b}`,
    name: `Accents ${a} and ${b}`,
    group: "Colorful",
    main: (i: number) => plain(`accent${i % 2 ? b : a}`),
  })),
  ...ACCENTS.flatMap((accent, k) => [
    {
      id: accent,
      name: `Accent ${k + 1} Fill`,
      group: `Accent ${k + 1}`,
      main: () => plain(accent),
    },
    {
      id: `${accent}-shades`,
      name: `Accent ${k + 1} Fading`,
      group: `Accent ${k + 1}`,
      main: (i: number, n: number) => {
        const t = span(i, n);
        return t === 0 ? plain(accent) : tint(plain(accent), 0.55 * t);
      },
    },
    {
      id: `${accent}-deepening`,
      name: `Accent ${k + 1} Deepening`,
      group: `Accent ${k + 1}`,
      main: (i: number, n: number) => {
        const t = span(i, n);
        return t === 0 ? plain(accent) : shade(plain(accent), 0.45 * t);
      },
    },
    {
      id: `${accent}-outline`,
      name: `Accent ${k + 1} Outline`,
      group: `Accent ${k + 1}`,
      main: () => plain(accent),
      outline: true,
    },
  ]),
];

export const SMARTART_COLOR_SCHEMES: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly group: string;
}> = SCHEMES.map(({ id, name, group }) => ({ id, name, group }));

export const DEFAULT_SMARTART_COLORS = "accent1";

interface StyleDef {
  readonly id: string;
  readonly name: string;
  readonly line: "none" | "light" | "bold";
  readonly shadow: "none" | "soft" | "strong";
  readonly gradient: boolean;
}

const STYLES: StyleDef[] = [
  { id: "flat", name: "Flat", line: "none", shadow: "none", gradient: false },
  {
    id: "subtle",
    name: "Subtle",
    line: "light",
    shadow: "none",
    gradient: false,
  },
  {
    id: "outlined",
    name: "Outlined",
    line: "bold",
    shadow: "none",
    gradient: false,
  },
  {
    id: "shadow",
    name: "Soft Shadow",
    line: "light",
    shadow: "soft",
    gradient: false,
  },
  {
    id: "polished",
    name: "Polished",
    line: "light",
    shadow: "none",
    gradient: true,
  },
  {
    id: "intense",
    name: "Intense",
    line: "light",
    shadow: "strong",
    gradient: true,
  },
];

export const SMARTART_STYLES: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
}> = STYLES.map(({ id, name }) => ({ id, name }));

export const DEFAULT_SMARTART_STYLE = "subtle";

export const schemeOf = (id: string): SchemeDef =>
  SCHEMES.find((s) => s.id === id) ??
  SCHEMES.find((s) => s.id === DEFAULT_SMARTART_COLORS)!;
export const styleOf = (id: string): StyleDef =>
  STYLES.find((s) => s.id === id) ??
  STYLES.find((s) => s.id === DEFAULT_SMARTART_STYLE)!;

const LIGHT = plain("lt1");
const DARK = plain("dk1");
const SLIDE_TEXT = plain("tx1");

/** The paint for a shape with `role`, the `i`th of `n` items. */
export const paintFor = (
  schemeId: string,
  styleId: string,
  role: Role,
  i: number,
  n: number,
): Paint => {
  const scheme = schemeOf(schemeId);
  const style = styleOf(styleId);
  const main = scheme.main(i, n);
  const lineW = style.line === "bold" ? 28575 : 12700;
  const shadow =
    style.shadow === "none"
      ? null
      : style.shadow === "soft"
        ? { blur: 50800, dist: 25400, alpha: 0.32 }
        : { blur: 76200, dist: 38100, alpha: 0.45 };
  const solid = (color: ColorRef): Fill =>
    style.gradient
      ? { kind: "gradient", from: tint(color, 0.25), to: shade(color, 0.12) }
      : { kind: "solid", color };
  const strongLine =
    style.line === "none"
      ? null
      : { color: style.line === "bold" ? shade(main, 0.25) : LIGHT, w: lineW };
  switch (role) {
    case "node":
    case "hub": {
      const color = role === "hub" ? shade(main, 0.2) : main;
      if (scheme.outline)
        return {
          fill: { kind: "solid", color: LIGHT },
          line: { color, w: style.line === "bold" ? 38100 : 19050 },
          text: DARK,
          shadow,
        };
      return { fill: solid(color), line: strongLine, text: LIGHT, shadow };
    }
    case "venn":
      return {
        fill: { kind: "solid", color: { ...main, alpha: 55000 } },
        line: style.line === "none" ? null : { color: LIGHT, w: lineW },
        text: scheme.outline ? DARK : LIGHT,
        shadow: null,
      };
    case "child":
      return {
        fill: { kind: "solid", color: { ...tint(main, 0.8), alpha: 92000 } },
        line: style.line === "none" ? null : { color: main, w: lineW },
        text: DARK,
        shadow: style.shadow === "strong" ? shadow : null,
      };
    case "trans":
      return {
        fill: { kind: "solid", color: tint(main, 0.4) },
        line: null,
        text: LIGHT,
        shadow: null,
      };
    case "bg":
      return {
        fill: { kind: "solid", color: tint(main, 0.8) },
        line: null,
        text: DARK,
        shadow: null,
      };
    case "line":
      return {
        fill: null,
        line: {
          color: shade(main, 0.1),
          w: style.line === "bold" ? 25400 : 15875,
        },
        text: SLIDE_TEXT,
        shadow: null,
      };
    case "pic":
      return {
        fill: { kind: "solid", color: tint(main, 0.6) },
        line: strongLine,
        text: DARK,
        shadow,
      };
    case "text":
    default:
      return { fill: null, line: null, text: SLIDE_TEXT, shadow: null };
  }
};

/** A palette for resolving theme colors in previews. */
export interface SmartArtPalette {
  readonly accents: ReadonlyArray<string>;
  readonly dk1: string;
  readonly lt1: string;
  readonly dk2?: string;
  readonly lt2?: string;
}

export const DEFAULT_PALETTE: SmartArtPalette = {
  accents: ["#3E6FB0", "#E07B39", "#8A8F98", "#E8B530", "#4A90C8", "#5FA55A"],
  dk1: "#1F1F1F",
  lt1: "#FFFFFF",
  dk2: "#2B3A4A",
  lt2: "#E8E8E8",
};

const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1]!, 16) : 0x808080;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const rgbToHsl = ([r, g, b]: [number, number, number]) => {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l] as const;
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? (g - b) / d + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4;
  return [h / 6, s, l] as const;
};
const hslToHex = (h: number, s: number, l: number): string => {
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r = l,
    g = l,
    b = l;
  if (s) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  return (
    "#" +
    [r, g, b]
      .map((c) =>
        Math.round(Math.min(1, Math.max(0, c)) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  ).toUpperCase();
};

/** Resolves a color reference against a palette: [hex, opacity]. */
export const resolveColor = (
  color: ColorRef,
  palette: SmartArtPalette = DEFAULT_PALETTE,
): [string, number] => {
  const base = (() => {
    const m = /^accent([1-6])$/.exec(color.val);
    if (m)
      return palette.accents[Number(m[1]) - 1] ?? DEFAULT_PALETTE.accents[0]!;
    switch (color.val) {
      case "dk1":
      case "tx1":
        return palette.dk1;
      case "lt1":
      case "bg1":
        return palette.lt1;
      case "dk2":
      case "tx2":
        return palette.dk2 ?? palette.dk1;
      case "lt2":
      case "bg2":
        return palette.lt2 ?? palette.lt1;
      default:
        return palette.dk1;
    }
  })();
  let hex = base.startsWith("#")
    ? base.toUpperCase()
    : `#${base.toUpperCase()}`;
  if (color.lumMod !== undefined || color.lumOff !== undefined) {
    const [h, s, l] = rgbToHsl(hexToRgb(hex));
    const next = Math.min(
      1,
      Math.max(
        0,
        (l * (color.lumMod ?? 100000)) / 100000 + (color.lumOff ?? 0) / 100000,
      ),
    );
    hex = hslToHex(h, s, next);
  }
  return [hex, color.alpha === undefined ? 1 : color.alpha / 100000];
};

/** DrawingML markup for a color reference. */
export const colorXml = (color: ColorRef): string => {
  const mods = [
    color.lumMod !== undefined ? `<a:lumMod val="${color.lumMod}"/>` : "",
    color.lumOff !== undefined ? `<a:lumOff val="${color.lumOff}"/>` : "",
    color.alpha !== undefined ? `<a:alpha val="${color.alpha}"/>` : "",
  ].join("");
  return mods
    ? `<a:schemeClr val="${color.val}">${mods}</a:schemeClr>`
    : `<a:schemeClr val="${color.val}"/>`;
};

/** The scheme's representative colors for the colors definition part. */
export const schemeColors = (schemeId: string) => {
  const scheme = schemeOf(schemeId);
  return {
    outline: !!scheme.outline,
    sample: (n: number) =>
      Array.from({ length: n }, (_, i) => scheme.main(i, n)),
    tint,
    shade,
  };
};
