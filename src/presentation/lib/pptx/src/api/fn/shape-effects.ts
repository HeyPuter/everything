import { shapeStyleReference } from "./shape-style-reference.ts";
import { iterateShapePropertySources } from "./shape-property-sources.ts";
import { resolveDrawingOpacity } from "./shape-color.ts";

// Shape mutation: shadow + glow effects.

import { resolveShapeColor } from "./shape-color-context.ts";

import {
  type GlowOptions,
  type ShadowOptions,
  clearEffects as clearEffectsImpl,
  setGlow,
  setShadow,
} from "../../internal/drawingml/index.ts";

import {
  NS,
  type XmlElement,
  firstChildElement,
  getAttrValue,
  qname,
} from "../../internal/xml/index.ts";
import {
  type PresentationData,
  SHAPE_ELEMENT,
  SLIDE_SHAPES,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { commitAndRefresh, requireSpPr } from "./_helpers.ts";
// ---------------------------------------------------------------------------
// Effects: shadow + glow.

/**
 * Read-back for `setShapeShadow` / `setShapeGlow`. Returns the kind
 * of effect currently on the shape's `<a:effectLst>`, or `null` when
 * none. Decodes the configured color + numeric parameters when
 * present.
 */
export type ShapeEffect =
  | {
      readonly kind: "shadow";
      readonly color: string;
      readonly blurEmu: number;
      readonly offsetEmu: number;
      readonly angleDeg: number;
      readonly opacity?: number;
    }
  | {
      readonly kind: "glow";
      readonly color: string;
      readonly radiusEmu: number;
    };

/**
 * Discriminated union covering every effect in
 * `CT_EffectStyleItem` (ECMA-376 §20.1.8.x) — outer shadow, inner
 * shadow, glow, reflection, soft-edge, blur. Returned in document
 * order so renderers can chain filters with the same composition
 * the native reference applies.
 *
 * Lengths are EMU; angles are degrees clockwise from 3 o'clock;
 * opacity is a unit fraction (0..1) when the spec exposes one.
 */
export type ShapeEffectAny =
  | {
      readonly kind: "outerShdw";
      readonly color: string;
      readonly opacity?: number;
      readonly blurEmu: number;
      readonly distEmu: number;
      readonly angleDeg: number;
      /** `rotWithShape="0"`: the offset stays fixed on the page when the
       *  shape turns or flips. Omitted when the shadow turns with it. */
      readonly fixedToPage?: true;
      /** `sx`/`sy` (unit fractions, signed) and `kx`/`ky` (degrees), about
       *  the `algn` point of the shape's box. Omitted at their defaults. */
      readonly scaleX?: number;
      readonly scaleY?: number;
      readonly skewXDeg?: number;
      readonly skewYDeg?: number;
      readonly align?: string;
    }
  | {
      readonly kind: "innerShdw";
      readonly color: string;
      readonly opacity?: number;
      readonly blurEmu: number;
      readonly distEmu: number;
      readonly angleDeg: number;
    }
  | {
      readonly kind: "glow";
      readonly color: string;
      readonly opacity?: number;
      readonly radiusEmu: number;
    }
  | {
      readonly kind: "reflection";
      // `opacity` is the far-end alpha (`endA`); `startOpacity` the
      // near-end alpha (`stA`). Both are unit fractions when authored.
      readonly opacity?: number;
      readonly startOpacity?: number;
      // Vertical scale (`sy`) as a signed unit fraction — the file
      // encodes the mirror as a negative `sy` (e.g. -1 = full-height
      // flip), so renderers must honor the sign, not just the magnitude.
      readonly scaleY?: number;
      /** Where the fade ends, as a fraction of the reflected height. */
      readonly endPos?: number;
      readonly blurEmu: number;
      readonly distEmu: number;
      readonly angleDeg: number;
    }
  | { readonly kind: "softEdge"; readonly radiusEmu: number }
  | { readonly kind: "blur"; readonly radiusEmu: number };

export const getShapeEffect = (shape: SlideShapeData): ShapeEffect | null => {
  const spPr = firstChildElement(
    shape[SHAPE_ELEMENT],
    qname("p", "spPr", NS.pml),
  );
  if (!spPr) return null;
  const effectLst = firstChildElement(spPr, qname("a", "effectLst", NS.dml));
  if (!effectLst) return null;

  const readColor = (host: XmlElement): { color: string; opacity?: number } => {
    const srgb = firstChildElement(host, qname("a", "srgbClr", NS.dml));
    if (!srgb) return { color: "" };
    const val = getAttrValue(srgb, qname("", "val", ""));
    const color = val !== null ? `#${val.toUpperCase()}` : "";
    const alpha = firstChildElement(srgb, qname("a", "alpha", NS.dml));
    if (alpha) {
      const a = getAttrValue(alpha, qname("", "val", ""));
      if (a !== null) {
        const n = Number.parseInt(a, 10);
        if (Number.isFinite(n)) return { color, opacity: n / 100000 };
      }
    }
    return { color };
  };

  const outerShdw = firstChildElement(
    effectLst,
    qname("a", "outerShdw", NS.dml),
  );
  if (outerShdw) {
    const blur = Number.parseInt(
      getAttrValue(outerShdw, qname("", "blurRad", "")) ?? "0",
      10,
    );
    const dist = Number.parseInt(
      getAttrValue(outerShdw, qname("", "dist", "")) ?? "0",
      10,
    );
    const dirRaw = Number.parseInt(
      getAttrValue(outerShdw, qname("", "dir", "")) ?? "0",
      10,
    );
    const c = readColor(outerShdw);
    return {
      kind: "shadow",
      color: c.color,
      blurEmu: blur,
      offsetEmu: dist,
      angleDeg: dirRaw / 60000,
      ...(c.opacity !== undefined ? { opacity: c.opacity } : {}),
    };
  }
  const glow = firstChildElement(effectLst, qname("a", "glow", NS.dml));
  if (glow) {
    const rad = Number.parseInt(
      getAttrValue(glow, qname("", "rad", "")) ?? "0",
      10,
    );
    const c = readColor(glow);
    return { kind: "glow", color: c.color, radiusEmu: rad };
  }
  return null;
};

/**
 * Returns every effect attached to the shape's `<a:effectLst>` in
 * document order — outer shadow, inner shadow, glow, reflection,
 * soft edge, blur. Empty array when no effects apply.
 *
 * Companion to `getShapeEffect`, which is the v1 "first effect only"
 * helper. `getShapeEffects` is what renderers want because effects
 * compose into a single filter (shadow + glow, etc.).
 */
// The colour a preset shadow's second, lighter copy takes (measured).
const lighterShadow = (hex: string): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = Number.parseInt(m[1]!, 16);
  return `#${[16, 8, 0]
    .map((shift) => {
      const c = (n >> shift) & 255;
      return Math.round(c + (255 - c) * 0.53)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")
    .toUpperCase()}`;
};

// A preset shadow (`<a:prstShdw prst="shdwN">`, ECMA-376 §20.1.8.49) as the
// outer shadows that draw it, offset by its `dist`/`dir`, as the desktop app
// draws each preset: plain drop shadows, perspective shadows laid back from
// or forward of the bottom edge, a larger one behind the shape, and double
// shadows whose second, lighter copy lies under the first (an earlier
// shadow paints over a later one).
const presetShadows = (
  preset: string | null,
  base: {
    readonly color: string;
    readonly opacity?: number;
    readonly distEmu: number;
    readonly angleDeg: number;
  },
): ShapeEffectAny[] => {
  const shadow = (
    extra: {
      scaleX?: number;
      scaleY?: number;
      skewXDeg?: number;
      align?: string;
      distEmu?: number;
      angleDeg?: number;
      color?: string;
    } = {},
  ): ShapeEffectAny => ({
    kind: "outerShdw",
    blurEmu: 0,
    ...base,
    ...extra,
  });
  const light = lighterShadow(base.color);
  switch (preset) {
    case "shdw9":
      // Drawn wholly behind the shape.
      return [];
    case "shdw10":
      return [shadow({ scaleX: 1.25, scaleY: 1.25, align: "br" })];
    case "shdw13":
      return [shadow(), shadow({ distEmu: base.distEmu * 2, color: light })];
    case "shdw17":
    case "shdw18":
      return [
        shadow(),
        shadow({ angleDeg: (base.angleDeg + 180) % 360, color: light }),
      ];
    case "shdw19":
      return [shadow({ scaleY: 0.5, align: "b" })];
    case "shdw20":
      return [shadow({ scaleY: -1, align: "b" })];
    case "shdw3":
    case "shdw11":
      return [shadow({ scaleY: 0.5, skewXDeg: 60, align: "b" })];
    case "shdw4":
    case "shdw12":
      return [shadow({ scaleY: 0.5, skewXDeg: -60, align: "b" })];
    case "shdw7":
    case "shdw15":
      return [shadow({ scaleY: -0.5, skewXDeg: -60, align: "b" })];
    case "shdw8":
    case "shdw16":
      return [shadow({ scaleY: -0.5, skewXDeg: 60, align: "b" })];
    default:
      return [shadow()];
  }
};

// Parses an `<a:effectLst>` element into the typed effect union.
// Pulled out of `getShapeEffects` so the cascade-aware variant can
// reuse it.
const parseEffectLst = (
  effectLst: XmlElement,
  resolveColor: (color: XmlElement) => string | null,
): ShapeEffectAny[] => {
  const readEffectColor = (
    host: XmlElement,
  ): { color: string; opacity?: number } => {
    let inner: XmlElement | null = null;
    for (const c of host.children) {
      if (c.kind !== "element" || c.name.namespaceURI !== NS.dml) continue;
      if (
        c.name.localName === "srgbClr" ||
        c.name.localName === "schemeClr" ||
        c.name.localName === "sysClr" ||
        c.name.localName === "prstClr" ||
        c.name.localName === "scrgbClr" ||
        c.name.localName === "hslClr"
      ) {
        inner = c;
        break;
      }
    }
    if (!inner) return { color: "" };
    const resolvedOpacity = resolveDrawingOpacity(inner);
    const opacity =
      resolvedOpacity !== 1 ||
      inner.children.some(
        (c) =>
          c.kind === "element" &&
          c.name.namespaceURI === NS.dml &&
          ["alpha", "alphaMod", "alphaOff"].includes(c.name.localName),
      )
        ? resolvedOpacity
        : undefined;
    const hex = resolveColor(inner);
    return { color: hex ?? "", ...(opacity !== undefined ? { opacity } : {}) };
  };

  const out: ShapeEffectAny[] = [];
  for (const child of effectLst.children) {
    if (child.kind !== "element" || child.name.namespaceURI !== NS.dml)
      continue;
    const local = child.name.localName;
    if (local === "outerShdw" || local === "innerShdw") {
      const blur =
        Number.parseInt(
          getAttrValue(child, qname("", "blurRad", "")) ?? "0",
          10,
        ) || 0;
      const dist =
        Number.parseInt(
          getAttrValue(child, qname("", "dist", "")) ?? "0",
          10,
        ) || 0;
      const dir =
        Number.parseInt(getAttrValue(child, qname("", "dir", "")) ?? "0", 10) ||
        0;
      const c = readEffectColor(child);
      const base = {
        color: c.color,
        blurEmu: blur,
        distEmu: dist,
        angleDeg: dir / 60000,
        ...(c.opacity !== undefined ? { opacity: c.opacity } : {}),
      };
      if (local === "innerShdw") {
        out.push({ kind: local, ...base });
        continue;
      }
      const intAttr = (name: string, fallback: number): number => {
        const n = Number.parseInt(
          getAttrValue(child, qname("", name, "")) ?? "",
          10,
        );
        return Number.isFinite(n) ? n : fallback;
      };
      const rot = getAttrValue(child, qname("", "rotWithShape", ""));
      const sx = intAttr("sx", 100000) / 100000,
        sy = intAttr("sy", 100000) / 100000;
      const kx = intAttr("kx", 0) / 60000,
        ky = intAttr("ky", 0) / 60000;
      const algn = getAttrValue(child, qname("", "algn", ""));
      out.push({
        kind: local,
        ...base,
        ...(rot === "0" || rot === "false"
          ? { fixedToPage: true as const }
          : {}),
        ...(sx !== 1 ? { scaleX: sx } : {}),
        ...(sy !== 1 ? { scaleY: sy } : {}),
        ...(kx ? { skewXDeg: kx } : {}),
        ...(ky ? { skewYDeg: ky } : {}),
        ...(algn ? { align: algn } : {}),
      });
    } else if (local === "prstShdw") {
      const int = (name: string) =>
        Number.parseInt(getAttrValue(child, qname("", name, "")) ?? "0", 10) ||
        0;
      const c = readEffectColor(child);
      out.push(
        ...presetShadows(getAttrValue(child, qname("", "prst", "")), {
          // The schema's default colour is black.
          color: c.color || "#000000",
          ...(c.opacity !== undefined ? { opacity: c.opacity } : {}),
          distEmu: int("dist"),
          angleDeg: int("dir") / 60000,
        }),
      );
    } else if (local === "glow") {
      const rad =
        Number.parseInt(getAttrValue(child, qname("", "rad", "")) ?? "0", 10) ||
        0;
      const c = readEffectColor(child);
      out.push({
        kind: "glow",
        color: c.color,
        radiusEmu: rad,
        ...(c.opacity !== undefined ? { opacity: c.opacity } : {}),
      });
    } else if (local === "reflection") {
      const blur =
        Number.parseInt(
          getAttrValue(child, qname("", "blurRad", "")) ?? "0",
          10,
        ) || 0;
      const dist =
        Number.parseInt(
          getAttrValue(child, qname("", "dist", "")) ?? "0",
          10,
        ) || 0;
      const dir =
        Number.parseInt(getAttrValue(child, qname("", "dir", "")) ?? "0", 10) ||
        0;
      // `stA`/`endA` are ST_PositiveFixedPercentage (0..100000); `sy` is
      // ST_Percentage and may be negative to encode the mirror flip.
      const pctFraction = (name: string): number | undefined => {
        const raw = getAttrValue(child, qname("", name, ""));
        if (raw === null) return undefined;
        let n = Number.parseFloat(raw);
        if (!Number.isFinite(n)) return undefined;
        if (Math.abs(n) > 1) n = n / 100000;
        return n;
      };
      const opacity = pctFraction("endA");
      const startOpacity = pctFraction("stA");
      const scaleY = pctFraction("sy");
      const endPos = pctFraction("endPos");
      out.push({
        kind: "reflection",
        blurEmu: blur,
        distEmu: dist,
        angleDeg: dir / 60000,
        ...(opacity !== undefined ? { opacity } : {}),
        ...(startOpacity !== undefined ? { startOpacity } : {}),
        ...(scaleY !== undefined ? { scaleY } : {}),
        ...(endPos !== undefined ? { endPos } : {}),
      });
    } else if (local === "softEdge") {
      const rad =
        Number.parseInt(getAttrValue(child, qname("", "rad", "")) ?? "0", 10) ||
        0;
      out.push({ kind: "softEdge", radiusEmu: rad });
    } else if (local === "blur") {
      const rad =
        Number.parseInt(getAttrValue(child, qname("", "rad", "")) ?? "0", 10) ||
        0;
      out.push({ kind: "blur", radiusEmu: rad });
    }
  }
  return out;
};

export const getShapeEffects = (
  pres: PresentationData,
  shape: SlideShapeData,
  colorMap?: Readonly<Record<string, string>> | null,
): readonly ShapeEffectAny[] => {
  const spPr = firstChildElement(
    shape[SHAPE_ELEMENT],
    qname("p", "spPr", NS.pml),
  );
  if (!spPr) return [];
  const effectLst = firstChildElement(spPr, qname("a", "effectLst", NS.dml));
  if (!effectLst) return [];
  return parseEffectLst(effectLst, (color) =>
    resolveShapeColor(pres, shape, color, colorMap),
  );
};

/**
 * Every shape on the slide whose `<a:effectLst>` carries an effect
 * of the given `kind` (`'outerShdw'`, `'innerShdw'`, `'glow'`,
 * `'reflection'`, `'softEdge'`, `'blur'`). Pure presence check — only
 * looks at the shape's own effect list, not the layout / master
 * cascade. Pair with `findShapesByEffect(pres, slide, 'softEdge')`
 * style call sites for visual-effect audits.
 */
export const findShapesByEffect = (
  pres: PresentationData,
  slide: SlideData,
  kind: ShapeEffectAny["kind"],
): ReadonlyArray<SlideShapeData> => {
  const out: SlideShapeData[] = [];
  for (const shape of slide[SLIDE_SHAPES]) {
    if (getShapeEffects(pres, shape).some((e) => e.kind === kind))
      out.push(shape);
  }
  return out;
};

/**
 * Same as `getShapeEffects` but walks the layout → master placeholder
 * cascade when the shape itself has no `<a:effectLst>`. Inherits
 * "all or nothing" — once any layer supplies an effect list, that
 * list is used; layers further down aren't merged in (effect lists
 * override rather than compose).
 */
export const getShapeEffectsEffective = (
  pres: PresentationData,
  shape: SlideShapeData,
  colorMap?: Readonly<Record<string, string>> | null,
): readonly ShapeEffectAny[] => {
  const readEffectsOn = (el: XmlElement): readonly ShapeEffectAny[] | null => {
    const spPr = firstChildElement(el, qname("p", "spPr", NS.pml));
    if (!spPr) return null;
    const eff = firstChildElement(spPr, qname("a", "effectLst", NS.dml));
    // A present effect list is an atomic override, including an empty list
    // or unsupported effects. An effectDag is the other schema choice and
    // likewise blocks the ancestor list; its raw graph remains preserved.
    if (!eff)
      return firstChildElement(spPr, qname("a", "effectDag", NS.dml))
        ? []
        : null;
    return parseEffectLst(eff, (color) =>
      resolveShapeColor(pres, shape, color, colorMap),
    );
  };

  for (const source of iterateShapePropertySources(shape)) {
    const direct = readEffectsOn(source.element);
    if (direct !== null) return direct;
    const style = shapeStyleReference(shape, source, "effectRef");
    if (style)
      return style.element.name.localName === "effectLst"
        ? parseEffectLst(style.element, (color) =>
            resolveShapeColor(pres, shape, color, colorMap),
          )
        : [];
  }
  return [];
};

/**
 * Sets an outer drop shadow on the shape. Defaults: black, 4pt blur,
 * 3pt offset, 45° (down-right). Pass `opacity` (0–1) to soften the
 * shadow.
 */
export const setShapeShadow = (
  shape: SlideShapeData,
  options: ShadowOptions = {},
): void => {
  setShadow(requireSpPr(shape), options);
  commitAndRefresh(shape);
};

/**
 * Sets a glow around the shape. The radius is in EMU (default 5pt =
 * 63500). Mutually exclusive with `setShapeShadow` in v1 — calling
 * either replaces the prior `<a:effectLst>` entirely.
 */
export const setShapeGlow = (
  shape: SlideShapeData,
  options: GlowOptions,
): void => {
  setGlow(requireSpPr(shape), options);
  commitAndRefresh(shape);
};

/** Removes any effects (shadow / glow / future presets) from the shape. */
export const clearShapeEffects = (shape: SlideShapeData): void => {
  clearEffectsImpl(requireSpPr(shape));
  commitAndRefresh(shape);
};
