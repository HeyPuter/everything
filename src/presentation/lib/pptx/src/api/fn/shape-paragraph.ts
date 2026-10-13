import { readDrawingBullet } from "../../internal/drawingml/text-bullet.ts";
import { shapeRelationshipOwner } from "./shape-source.ts";
import {
  drawingChild,
  listStyleLevel,
  textListStyleSources,
  textFontReferenceDefaults,
} from "./text-inheritance.ts";

// rPr and pPr cascade resolution.

import {
  ATTR_LVL,
  NAME_A_PPR,
  NAME_A_RPR,
  ensureRPr,
  requireParagraph,
  readTextSpacing,
  readParagraphBulletStyle,
  requireRun,
  runsOf,
} from "./shape-runs.ts";
import { parseRPrLikeElement } from "./shape-color.ts";
import { getEffectiveColorMap } from "./color-map.ts";
import { getShapePlaceholderType } from "./shape-read-base.ts";

import {
  type BulletStyle,
  type ParagraphAlignment,
  type TextFormat,
  applyHyperlinkToAllRuns,
  applyRunFormat as applyRunFormatInternal,
} from "../../internal/drawingml/index.ts";
import { emptyRels, nextRelId } from "../../internal/opc/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  NS,
  type XmlElement,
  firstChildElement,
  getAttrValue,
  qname,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  SLIDE_PART_NAME,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { commitAndRefresh, requireTxBody } from "./_helpers.ts";
import { getPresentationTheme, resolveThemeTypeface } from "./theme.ts";
import { themeForShape } from "./shape-theme.ts";
// -- Effective rPr cascade (ECMA-376 §21.1.2.4.7) ---------------------------
//
// A run's effective character properties are resolved by walking the
// inheritance chain — each level fills in fields that no earlier level
// supplied. First-wins per property:
//
//   1. The run's own `<a:rPr>`
//   2. `<a:endParaRPr>` for an empty paragraph's insertion point only
//   3. The paragraph's `<a:pPr><a:defRPr>` (paragraph-level run defaults)
//   4. The text body's `<a:lstStyle><a:lvl{N+1}pPr><a:defRPr>` (N = paragraph level)
//   5. The same path on the matching placeholder in the slide's layout
//   6. The same path on the matching placeholder on the slide master,
//      then the master's `<p:txStyles>` (`titleStyle` / `bodyStyle` / `otherStyle`)
//   7. The theme's `<a:fontScheme>` — font typeface fallback only
//
// Placeholder matching: slide → layout by idx; layout → master by type.

const NAME_A_DEF_RPR = qname("a", "defRPr", NS.dml);
const NAME_A_END_PARA_RPR = qname("a", "endParaRPr", NS.dml);

const mergeRPrLayer = (
  base: Partial<TextFormat>,
  layer: Partial<TextFormat>,
): void => {
  if (base.language === undefined && layer.language !== undefined)
    base.language = layer.language;
  if (
    base.alternateLanguage === undefined &&
    layer.alternateLanguage !== undefined
  )
    base.alternateLanguage = layer.alternateLanguage;
  if (base.font === undefined && layer.font !== undefined)
    base.font = layer.font;
  if (base.fontEastAsian === undefined && layer.fontEastAsian !== undefined) {
    base.fontEastAsian = layer.fontEastAsian;
  }
  if (base.size === undefined && layer.size !== undefined)
    base.size = layer.size;
  // A run's fill is one choice: the nearest solid color or gradient wins.
  if (base.color === undefined && base.gradient === undefined) {
    if (layer.color !== undefined) {
      base.color = layer.color;
      base.colorOpacity = layer.colorOpacity ?? 1;
    } else if (layer.gradient !== undefined) base.gradient = layer.gradient;
  }
  if (base.bold === undefined && layer.bold !== undefined)
    base.bold = layer.bold;
  if (base.italic === undefined && layer.italic !== undefined)
    base.italic = layer.italic;
  if (base.underline === undefined && layer.underline !== undefined) {
    base.underline = layer.underline;
  }
  if (base.strike === undefined && layer.strike !== undefined)
    base.strike = layer.strike;
  if (base.spc === undefined && layer.spc !== undefined) base.spc = layer.spc;
  if (base.kern === undefined && layer.kern !== undefined)
    base.kern = layer.kern;
  if (base.baseline === undefined && layer.baseline !== undefined)
    base.baseline = layer.baseline;
  if (base.cap === undefined && layer.cap !== undefined) base.cap = layer.cap;
  if (base.highlight === undefined && layer.highlight !== undefined) {
    base.highlight = layer.highlight;
  }
  for (const key of [
    "underlineColor",
    "normalizeHeight",
    "outline",
    "effects",
  ] as const)
    if (base[key] === undefined && layer[key] !== undefined)
      (base as Record<string, unknown>)[key] = layer[key];
};

/**
 * Resolves a run's effective character properties by walking the
 * ECMA-376 §21.1.2.4.7 inheritance chain — run rPr →
 * pPr defRPr → text-body lstStyle → layout placeholder lstStyle →
 * master placeholder lstStyle + master txStyles → theme fontScheme.
 *
 * Each property (font, size, color, bold, italic, underline) is
 * resolved independently: the innermost layer that supplies a value
 * wins for that one property.
 *
 * Returns a non-null `TextFormat`; fields the cascade couldn't
 * resolve are simply absent (the renderer falls back to placeholder
 * defaults).
 *
 * Use `getShapeRunFormat` if you only want the literal `<a:rPr>` on
 * the run without inheritance.
 * Supply `colorMap` when rendering template decorations in another slide's
 * context; otherwise colors use the shape's own slide/layout/master mapping.
 */
const NAME_TX_BODY = qname("p", "txBody", NS.pml);

export const getShapeRunFormatEffective = (
  pres: PresentationData,
  shape: SlideShapeData,
  paragraphIndex: number,
  runIndex: number,
  colorMap?: Readonly<Record<string, string>> | null,
): TextFormat => {
  const paragraph = requireParagraph(shape, paragraphIndex);
  const runs = runsOf(paragraph);
  // Empty placeholders inherit insertion-point formatting via endParaRPr.
  const run =
    runs.length === 0 && runIndex === 0
      ? null
      : requireRun(shape, paragraphIndex, runIndex);
  return resolveRunFormat(pres, shape, paragraph, run, colorMap);
};

/**
 * Effective character formatting for a cached `<a:fld>` value (date, slide
 * number, etc.). Field indices count fields only, leaving regular run indices
 * unchanged. Reading formatting never updates the cached value or field ID.
 */
export const getShapeFieldFormatEffective = (
  pres: PresentationData,
  shape: SlideShapeData,
  paragraphIndex: number,
  fieldIndex: number,
  colorMap?: Readonly<Record<string, string>> | null,
): TextFormat => {
  const paragraph = requireParagraph(shape, paragraphIndex);
  const inline = paragraph.children.filter(
    (c): c is XmlElement =>
      c.kind === "element" &&
      c.name.namespaceURI === NS.dml &&
      ["r", "fld", "br"].includes(c.name.localName),
  );
  const fields = inline.filter((c) => c.name.localName === "fld");
  const field = fields[fieldIndex];
  if (!field) throw new RangeError(`field index ${fieldIndex} is out of range`);
  return resolveRunFormat(pres, shape, paragraph, field, colorMap);
};

/** Effective formatting of an explicit line break, for empty-line metrics. */
export const getShapeBreakFormatEffective = (
  pres: PresentationData,
  shape: SlideShapeData,
  paragraphIndex: number,
  breakIndex: number,
  colorMap?: Readonly<Record<string, string>> | null,
): TextFormat => {
  const paragraph = requireParagraph(shape, paragraphIndex);
  const breaks = paragraph.children.filter(
    (c): c is XmlElement =>
      c.kind === "element" &&
      c.name.namespaceURI === NS.dml &&
      c.name.localName === "br",
  );
  const br = breaks[breakIndex];
  if (!br) throw new RangeError(`break index ${breakIndex} is out of range`);
  return resolveRunFormat(pres, shape, paragraph, br, colorMap);
};

/**
 * Insertion-point formatting for an empty paragraph or its trailing empty line.
 * Explicit end properties override the final inline item's formatting; absent
 * properties continue through the paragraph/layout/master cascade.
 */
export const getShapeParagraphEndFormatEffective = (
  pres: PresentationData,
  shape: SlideShapeData,
  paragraphIndex: number,
  colorMap?: Readonly<Record<string, string>> | null,
): TextFormat => {
  const paragraph = requireParagraph(shape, paragraphIndex);
  const last = paragraph.children
    .filter(
      (c): c is XmlElement =>
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        ["r", "fld", "br"].includes(c.name.localName),
    )
    .at(-1);
  return resolveRunFormat(pres, shape, paragraph, last ?? null, colorMap, true);
};

const resolveRunFormat = (
  pres: PresentationData,
  shape: SlideShapeData,
  paragraph: XmlElement,
  run: XmlElement | null,
  colorMap?: Readonly<Record<string, string>> | null,
  paragraphEnd = false,
): TextFormat => {
  const result: Partial<TextFormat> = {};

  // Theme is consulted (a) at each layer to resolve scheme tokens and
  // color transforms eagerly, so the cascade can pick the innermost layer
  // that produces a concrete color, and (b) for typeface fallback at
  // layer 7. Reading once up-front keeps the per-layer cost flat.
  const theme = themeForShape(shape)?.theme ?? getPresentationTheme(pres);
  const slide = shape[SHAPE_SLIDE];
  let clrMap: Readonly<Record<string, string>> | undefined;
  const ctx = {
    theme,
    get clrMap() {
      return colorMap ?? (clrMap ??= getEffectiveColorMap(slide));
    },
  };

  // Paragraph level (0..8). `<a:pPr lvl="..">`; absent = 0.
  const pPr = firstChildElement(paragraph, NAME_A_PPR);
  let level = 0;
  if (pPr) {
    const lvlAttr = getAttrValue(pPr, ATTR_LVL);
    if (lvlAttr !== null) {
      const parsed = Number.parseInt(lvlAttr, 10);
      if (Number.isFinite(parsed)) level = parsed;
    }
  }

  // endParaRPr stores formatting for newly inserted text (21.1.2.2.3),
  // not the last existing run or field. The native reference keeps
  // existing text's size, face and color even when the paragraph end differs.
  if (paragraphEnd || run === null) {
    const endRPr = firstChildElement(paragraph, NAME_A_END_PARA_RPR);
    if (endRPr) mergeRPrLayer(result, parseRPrLikeElement(endRPr, ctx));
  }

  // Existing text ignores end properties. At the insertion point, the final
  // inline item supplies any properties not explicitly set by endParaRPr.
  const runRPr = run ? firstChildElement(run, NAME_A_RPR) : null;
  if (runRPr) mergeRPrLayer(result, parseRPrLikeElement(runRPr, ctx));

  // 3. Paragraph-level defaults (pPr/defRPr).
  if (pPr) {
    const defRPr = firstChildElement(pPr, NAME_A_DEF_RPR);
    if (defRPr) mergeRPrLayer(result, parseRPrLikeElement(defRPr, ctx));
  }

  // 4–6. The shape, matching placeholders, and master text style.
  for (const source of textListStyleSources(shape)) {
    const defaults = drawingChild(
      listStyleLevel(source.element, level),
      "defRPr",
    );
    if (defaults) mergeRPrLayer(result, parseRPrLikeElement(defaults, ctx));
  }

  const fontReference = textFontReferenceDefaults(shape);
  if (fontReference)
    mergeRPrLayer(result, parseRPrLikeElement(fontReference.element, ctx));

  // 7. Theme fontScheme — typeface resolution.
  //
  // The master often writes its `<a:latin typeface="+mj-lt"/>` /
  // `+mn-lt` placeholder tokens instead of a concrete face. Those
  // tokens must be resolved against the theme to produce a real
  // typeface; otherwise renderers see literal `+mj-lt` and fall
  // back to a generic font.
  //
  // When no layer in the cascade supplied a font at all, pick the
  // major font for title-class placeholders and the minor font for
  // everything else (theme major/minor font defaults).
  const phType = getShapePlaceholderType(shape);
  const fonts = themeForShape(shape)?.fonts;
  if (fonts) {
    if (typeof result.font === "string" && result.font.startsWith("+")) {
      const resolved = resolveThemeTypeface(result.font, fonts);
      if (resolved) result.font = resolved;
    }
    if (result.font === undefined) {
      const useMajor = phType === "title" || phType === "ctrTitle";
      const fallback = useMajor ? fonts.majorLatin : fonts.minorLatin;
      if (fallback) result.font = fallback;
    }
    if (
      typeof result.fontEastAsian === "string" &&
      result.fontEastAsian.startsWith("+")
    ) {
      const resolved = resolveThemeTypeface(result.fontEastAsian, fonts);
      if (resolved) result.fontEastAsian = resolved;
    }
    if (result.fontEastAsian === undefined) {
      const useMajor = phType === "title" || phType === "ctrTitle";
      const fallback = useMajor ? fonts.majorEastAsian : fonts.minorEastAsian;
      if (fallback) result.fontEastAsian = fallback;
    }
  }

  return result as TextFormat;
};

// -- Effective pPr cascade --------------------------------------------------
//
// Mirror of the rPr cascade for paragraph-level properties: alignment,
// indents, line spacing, paragraph spacing, rtl. Walks the same layers:
//
//   1. The paragraph's own `<a:pPr>`
//   2. The text body's `<a:lstStyle><a:lvl{N+1}pPr>` (paragraph defaults)
//   3. The matching layout placeholder's lstStyle
//   4. The matching master placeholder's lstStyle, then
//      `<p:txStyles>/{title|body|other}Style/<a:lvl{N+1}pPr>`
//
// Each property merges independently — innermost layer that supplies a
// value wins for that one property.

/** Effective paragraph properties returned by `getParagraphPropertiesEffective`. */
export interface ParagraphProperties {
  /** Horizontal alignment per `ParagraphAlignment`. */
  align: ParagraphAlignment | null;
  /** Outline level (0..8). 0 = top-level paragraph. */
  level: number;
  /** Left indent in EMU. */
  marL: number | null;
  /** Right indent in EMU. */
  marR: number | null;
  /** First-line indent in EMU; negative for hanging indents. */
  indent: number | null;
  /** Line spacing — either a percent multiplier or a fixed point value. */
  lineSpacing:
    | { readonly kind: "pct"; readonly value: number }
    | { readonly kind: "pts"; readonly value: number }
    | null;
  /** Space before the paragraph in points. */
  spcBefPts: number | null;
  /** Percentage spacing before, as a multiple of the first natural line height. */
  spcBefPct?: number;
  /** Percentage spacing after, as a multiple of the last natural line height. */
  spcAftPct?: number;
  /** Space after the paragraph in points. */
  spcAftPts: number | null;
  /** Right-to-left paragraph (`<a:pPr rtl="1"/>`). */
  rtl: boolean | null;
  /**
   * Bullet resolved through the cascade (`<a:buChar>` / `<a:buAutoNum>` /
   * `<a:buNone>`). Master `bodyStyle` levels author the default
   * "•", so body placeholders get their bullet from here even when no
   * slide-level `<a:pPr>` carries one.
   */
  bullet: BulletStyle | null;
}

/**
 * Maps an OOXML `algn` token to the friendly `ParagraphAlignment` form the
 * rest of the API speaks. Exported so the table-cell reader normalises the
 * same way the shape-text cascade does.
 *
 * @internal
 */
export const ALIGN_TOKEN_MAP: Record<string, ParagraphProperties["align"]> = {
  l: "left",
  ctr: "center",
  r: "right",
  just: "justify",
  justLow: "justify",
  dist: "distribute",
  thaiDist: "distribute",
};

export const parsePPrLikeElement = (
  pPr: XmlElement,
): Partial<ParagraphProperties> => {
  const out: Partial<ParagraphProperties> = {};
  const rawLevel = getAttrValue(pPr, ATTR_LVL);
  if (rawLevel !== null && /^\+?\d+$/.test(rawLevel.trim())) {
    const level = Number(rawLevel);
    if (Number.isInteger(level) && level >= 0 && level <= 8) out.level = level;
  }
  const algn = getAttrValue(pPr, qname("", "algn", ""));
  if (algn !== null && ALIGN_TOKEN_MAP[algn] !== undefined)
    out.align = ALIGN_TOKEN_MAP[algn];
  const marL = getAttrValue(pPr, qname("", "marL", ""));
  if (marL !== null) {
    const n = Number.parseInt(marL, 10);
    if (Number.isFinite(n)) out.marL = n;
  }
  const marR = getAttrValue(pPr, qname("", "marR", ""));
  if (marR !== null) {
    const n = Number.parseInt(marR, 10);
    if (Number.isFinite(n)) out.marR = n;
  }
  const indent = getAttrValue(pPr, qname("", "indent", ""));
  if (indent !== null) {
    const n = Number.parseInt(indent, 10);
    if (Number.isFinite(n)) out.indent = n;
  }
  const rtl = getAttrValue(pPr, qname("", "rtl", ""));
  if (rtl !== null) out.rtl = rtl === "1" || rtl === "true";
  const line = readTextSpacing(pPr, "lnSpc");
  if (line) out.lineSpacing = line;
  for (const side of ["spcBef", "spcAft"] as const) {
    const spacing = readTextSpacing(pPr, side);
    if (!spacing) continue;
    out[`${side}Pts`] = spacing.kind === "pts" ? spacing.value : null;
    if (spacing.kind === "pct") out[`${side}Pct`] = spacing.value;
  }
  // Bullet: buNone / buChar / buAutoNum are mutually exclusive children.
  // Normalisation mirrors getParagraphBullet so both readers speak the same
  // BulletStyle vocabulary.
  for (const c of pPr.children) {
    if (c.kind !== "element" || c.name.namespaceURI !== NS.dml) continue;
    const bullet = readDrawingBullet(c);
    if (bullet !== null) out.bullet = bullet;
  }
  return out;
};

const mergePPrLayer = (
  base: Partial<ParagraphProperties>,
  layer: Partial<ParagraphProperties>,
): void => {
  if (base.align === undefined && layer.align !== undefined)
    base.align = layer.align;
  if (base.marL === undefined && layer.marL !== undefined)
    base.marL = layer.marL;
  if (base.marR === undefined && layer.marR !== undefined)
    base.marR = layer.marR;
  if (base.indent === undefined && layer.indent !== undefined)
    base.indent = layer.indent;
  if (base.rtl === undefined && layer.rtl !== undefined) base.rtl = layer.rtl;
  if (base.lineSpacing === undefined && layer.lineSpacing !== undefined) {
    base.lineSpacing = layer.lineSpacing;
  }
  if (base.spcBefPts === undefined && layer.spcBefPts !== undefined) {
    base.spcBefPts = layer.spcBefPts;
    if (layer.spcBefPct !== undefined) base.spcBefPct = layer.spcBefPct;
  }
  if (base.spcAftPts === undefined && layer.spcAftPts !== undefined) {
    base.spcAftPts = layer.spcAftPts;
    if (layer.spcAftPct !== undefined) base.spcAftPct = layer.spcAftPct;
  }
  if (base.bullet === undefined && layer.bullet !== undefined)
    base.bullet = layer.bullet;
};

/**
 * Resolves a paragraph's effective properties by walking the same
 * inheritance chain `getShapeRunFormatEffective` uses, but for the
 * paragraph-level surface:
 *
 *   - alignment, indent (left / right / first-line), line spacing,
 *     paragraph spacing (before / after), rtl.
 *
 * Each property is resolved independently; the innermost layer that
 * sets it wins. Fields the cascade can't resolve come through as `null`
 * so renderers know to fall back to their own defaults.
 *
 * Companion to `getParagraphAlignment` / `getParagraphLineSpacing` /
 * `getParagraphIndent` / `getParagraphSpacing`, which only surface the
 * literal `<a:pPr>` and skip the layout / master cascade.
 */
export const getParagraphPropertiesEffective = (
  pres: PresentationData,
  shape: SlideShapeData,
  paragraphIndex: number,
): ParagraphProperties => {
  const paragraph = requireParagraph(shape, paragraphIndex);
  const pPr = firstChildElement(paragraph, NAME_A_PPR);

  let level = 0;
  if (pPr) {
    const lvlAttr = getAttrValue(pPr, ATTR_LVL);
    if (lvlAttr !== null) {
      const parsed = Number.parseInt(lvlAttr, 10);
      if (Number.isFinite(parsed)) level = parsed;
    }
  }

  const result: Partial<ParagraphProperties> = {};

  // 1. Paragraph's own pPr.
  if (pPr) mergePPrLayer(result, parsePPrLikeElement(pPr));

  // 2–4. The same nearest-first list styles used for character properties.
  for (const source of textListStyleSources(shape)) {
    const defaults = listStyleLevel(source.element, level);
    if (defaults) mergePPrLayer(result, parsePPrLikeElement(defaults));
  }

  return {
    align: result.align ?? null,
    level,
    marL: result.marL ?? null,
    marR: result.marR ?? null,
    indent: result.indent ?? null,
    lineSpacing: result.lineSpacing ?? null,
    spcBefPts: result.spcBefPts ?? null,
    spcAftPts: result.spcAftPts ?? null,
    ...(result.spcBefPct !== undefined ? { spcBefPct: result.spcBefPct } : {}),
    ...(result.spcAftPct !== undefined ? { spcAftPct: result.spcAftPct } : {}),
    rtl: result.rtl ?? null,
    bullet: result.bullet ?? null,
  };
};

/** Resolves bullet color, size and font through the paragraph/list/template
 * cascade. Follow-text choices stop the corresponding inherited override;
 * null values ask the renderer to use the first text run's properties. */
export const getParagraphBulletStyleEffective = (
  pres: PresentationData,
  shape: SlideShapeData,
  paragraphIndex: number,
  colorMap?: Readonly<Record<string, string>> | null,
): ReturnType<typeof readParagraphBulletStyle> => {
  const paragraph = requireParagraph(shape, paragraphIndex);
  const own = firstChildElement(paragraph, NAME_A_PPR);
  const rawLevel = own && getAttrValue(own, ATTR_LVL);
  const level = rawLevel === null ? 0 : Number.parseInt(rawLevel, 10) || 0;
  const layers = [
    ...(own ? [own] : []),
    ...textListStyleSources(shape).flatMap((source) => {
      const layer = listStyleLevel(source.element, level);
      return layer ? [layer] : [];
    }),
  ];
  const result: ReturnType<typeof readParagraphBulletStyle> = {
    color: null,
    sizePct: null,
    sizePts: null,
    font: null,
  };
  let color = false,
    size = false,
    font = false;
  for (const layer of layers) {
    const values = readParagraphBulletStyle(pres, shape, layer, colorMap);
    if (
      !color &&
      (drawingChild(layer, "buClr") || drawingChild(layer, "buClrTx"))
    ) {
      color = true;
      result.color = values.color;
      if (values.colorOpacity !== undefined)
        result.colorOpacity = values.colorOpacity;
    }
    if (
      !size &&
      ["buSzPct", "buSzPts", "buSzTx"].some((name) => drawingChild(layer, name))
    ) {
      size = true;
      result.sizePct = values.sizePct;
      result.sizePts = values.sizePts;
    }
    if (
      !font &&
      (drawingChild(layer, "buFont") || drawingChild(layer, "buFontTx"))
    ) {
      font = true;
      result.font = resolveThemeTypeface(
        values.font,
        themeForShape(shape)?.fonts,
      );
    }
    if (color && size && font) break;
  }
  return result;
};

/**
 * Applies `format` to a single run. Run-property attributes not
 * addressed by `format` are preserved — partial updates compose.
 *
 * Example: bold the second word of the first paragraph:
 *
 *   setShapeRunFormat(shape, 0, 1, { bold: true, color: '#FF0000' });
 */
export const setShapeRunFormat = (
  shape: SlideShapeData,
  paragraphIndex: number,
  runIndex: number,
  format: TextFormat,
): void => {
  const run = requireRun(shape, paragraphIndex, runIndex);
  const rPr = ensureRPr(run);
  applyRunFormatInternal(rPr, format);
  commitAndRefresh(shape);
};

/**
 * Applies character formatting to one live field without changing its ID,
 * type, cached text or other metadata. Field indices count `<a:fld>` only,
 * independently of ordinary run indices, as in getShapeFieldFormatEffective.
 */
export const setShapeFieldFormat = (
  shape: SlideShapeData,
  paragraphIndex: number,
  fieldIndex: number,
  format: TextFormat,
): void => {
  const paragraph = requireParagraph(shape, paragraphIndex);
  const fields = paragraph.children.filter(
    (c): c is XmlElement =>
      c.kind === "element" &&
      c.name.namespaceURI === NS.dml &&
      c.name.localName === "fld",
  );
  const field = fields[fieldIndex];
  if (!field) throw new RangeError(`field index ${fieldIndex} is out of range`);
  applyRunFormatInternal(ensureRPr(field), format);
  commitAndRefresh(shape);
};

/**
 * Reads the external URL the first run in the shape's text-body links
 * to (set via `setShapeHyperlink`). Returns `null` when no run carries
 * an `<a:hlinkClick r:id=…/>` or the rId resolves to a non-hyperlink
 * target.
 */
export const getShapeHyperlink = (shape: SlideShapeData): string | null => {
  if (shape[SHAPE_SNAPSHOT].kind !== "shape") return null;
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (!txBody) return null;
  for (const p of txBody.children) {
    if (
      p.kind !== "element" ||
      p.name.namespaceURI !== NS.dml ||
      p.name.localName !== "p"
    )
      continue;
    for (const r of p.children) {
      if (
        r.kind !== "element" ||
        r.name.namespaceURI !== NS.dml ||
        r.name.localName !== "r"
      )
        continue;
      const rPr = firstChildElement(r, qname("a", "rPr", NS.dml));
      if (!rPr) continue;
      const hlink = firstChildElement(rPr, qname("a", "hlinkClick", NS.dml));
      if (!hlink) continue;
      const rId = getAttrValue(hlink, qname("r", "id", NS.officeDocRels));
      if (!rId) continue;
      const slide = shape[SHAPE_SLIDE];
      const rels = slide[INTERNAL_PACKAGE].getRels(
        shapeRelationshipOwner(shape, hlink),
      );
      if (!rels) continue;
      const rel = rels.items.find((x) => x.id === rId);
      if (rel?.type === REL_TYPES.hyperlink && rel.targetMode === "External") {
        return rel.target;
      }
    }
  }
  return null;
};

/**
 * Sets an external hyperlink on every run in the shape's text. Allocates
 * (or reuses) a `hyperlink` relationship on the slide's `.rels`. Pass
 * `null` to clear.
 */
export const setShapeHyperlink = (
  shape: SlideShapeData,
  url: string | null,
  tooltip?: string,
): void => {
  const slide = shape[SHAPE_SLIDE];
  const txBody = requireTxBody(shape);
  if (url === null) {
    applyHyperlinkToAllRuns(txBody, null);
  } else {
    const pkg = slide[INTERNAL_PACKAGE];
    const rels = pkg.getRels(slide[SLIDE_PART_NAME]) ?? emptyRels();
    const existing = rels.items.find(
      (r) =>
        r.type === REL_TYPES.hyperlink &&
        r.target === url &&
        r.targetMode === "External",
    );
    const rId =
      existing?.id ??
      (() => {
        const nextId = nextRelId(rels.items.map((r) => r.id));
        rels.items.push({
          id: nextId,
          type: REL_TYPES.hyperlink,
          target: url,
          targetMode: "External",
        });
        pkg.setRels(slide[SLIDE_PART_NAME], rels);
        return nextId;
      })();
    applyHyperlinkToAllRuns(txBody, rId, tooltip);
  }
  commitAndRefresh(shape);
};
