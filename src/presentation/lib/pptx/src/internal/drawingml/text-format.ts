// Character-property authoring for DrawingML runs, fields and line breaks.
//
// The ECMA-376 surface for `CT_TextCharacterProperties` (§17.18.83) is
// huge. We expose the subset that 90% of authoring scripts reach for:
// font face, size, color, bold, italic, underline.
//
// Sizes are pt and accept fractions; serialized as hundredths of a point
// per the schema (`sz="2400"` = 24pt). Colors accept any of:
//
//   - `#RRGGBB` / `RRGGBB` for srgb
//   - `'tx1' | 'tx2' | 'bg1' | 'bg2' | 'accent1'…'accent6'` for theme
//   - `'transparent' | null` to clear
//
// Mutation strategy: walk the `txBody`, ensure each inline has an `a:rPr`,
// then set the relevant attributes / child elements. Existing properties
// not addressed by the format object are preserved.

import {
  NS,
  type XmlAttr,
  type XmlElement,
  attr,
  elem,
  firstChildElement,
  insertChildByRank,
  qname,
} from "../xml/index.ts";
import { fontSizeHundredthPt, textPointSpacing } from "../bounds.ts";
import { buildColorElement, parseColor } from "./color.ts";

const NAME_RPR = qname("a", "rPr", NS.dml);
const NAME_LATIN = qname("a", "latin", NS.dml);
const NAME_EA = qname("a", "ea", NS.dml);
const NAME_CS = qname("a", "cs", NS.dml);
const NAME_SOLID_FILL = qname("a", "solidFill", NS.dml);
const ATTR_SZ = qname("", "sz", "");
const ATTR_B = qname("", "b", "");
const ATTR_I = qname("", "i", "");
const ATTR_U = qname("", "u", "");
const ATTR_STRIKE = qname("", "strike", "");
const ATTR_SPC = qname("", "spc", "");
const ATTR_KERN = qname("", "kern", "");
const ATTR_BASELINE = qname("", "baseline", "");
const ATTR_CAP = qname("", "cap", "");
const ATTR_TYPEFACE = qname("", "typeface", "");
const ATTR_VAL = qname("", "val", "");
const ATTR_LANG = qname("", "lang", "");
const ATTR_ALT_LANG = qname("", "altLang", "");
const NAME_HIGHLIGHT = qname("a", "highlight", NS.dml);

// CT_TextCharacterProperties (a:rPr) is an xsd:sequence: children must appear
// in this order or the run fails dml/pml schema validation. Setters strip the
// existing element then re-insert at the mandated slot via insertChildByRank.
const RPR_CHILD_RANK: Record<string, number> = {
  ln: 0,
  noFill: 1,
  solidFill: 1,
  gradFill: 1,
  blipFill: 1,
  pattFill: 1,
  grpFill: 1,
  effectLst: 2,
  effectDag: 2,
  highlight: 3,
  uLnTx: 4,
  uLn: 4,
  uFillTx: 5,
  uFill: 5,
  latin: 6,
  ea: 7,
  cs: 8,
  sym: 9,
  hlinkClick: 10,
  hlinkMouseOver: 11,
  rtl: 12,
  extLst: 13,
};
export const rprChildRank = (el: XmlElement): number =>
  el.name.namespaceURI === NS.dml
    ? (RPR_CHILD_RANK[el.name.localName] ?? 99)
    : 99;

export interface TextFormat {
  /** Text language (`en-US`, `ja-JP`, ...). `null` removes the local override. */
  language?: string | null;
  /** Alternate text language (`a:rPr/@altLang`); `null` removes the override. */
  alternateLanguage?: string | null;
  /** Latin font family (`Calibri`, `Arial`, ...). Sets `<a:latin>`. */
  font?: string;
  /**
   * East Asian font family (`游明朝`, `メイリオ`, ...). Sets `<a:ea>`.
   * Renderers pick this typeface for CJK glyphs independently of `font`
   * (which only governs Latin glyphs) — set both when a run mixes Latin
   * and CJK text and needs a consistent look across the whole run.
   */
  fontEastAsian?: string;
  /** Font size in points; fractional values allowed (`12`, `12.5`). */
  size?: number;
  /**
   * Color. Accepts `#RRGGBB`, `RRGGBB`, an ECMA-376 scheme color token
   * (`tx1`, `accent1`, ...), or `null` to clear.
   */
  color?: string | null;
  /** Solid text color alpha, 0..1. When authoring, provide `color` or an
   * existing local solid fill; OOXML stores alpha on the color itself. */
  colorOpacity?: number;
  bold?: boolean;
  italic?: boolean;
  /**
   * Underline style. `true` is shorthand for `'sng'` (single). Pass the
   * exact `ST_TextUnderlineType` token for other styles (`'dbl'`, `'wavy'`,
   * `'dash'`, ...).
   */
  underline?: boolean | string;
  /**
   * Strikethrough style. `true` is shorthand for `'sngStrike'` (single
   * line). Pass the exact `ST_TextStrikeType` token (`'sngStrike'`,
   * `'dblStrike'`, `'noStrike'`) for other styles. `false` clears.
   */
  strike?: boolean | string;
  /**
   * Character spacing in 1/100 points (`0` = default). Negative values
   * tighten, positive values loosen. Mirrors `<a:rPr spc="…"/>`.
   */
  spc?: number;
  /**
   * Kerning threshold in 1/100 points (`ST_TextNonNegativePoint`, the same
   * unit as `spc`): `0` disables kerning, `1200` = apply kerning for runs
   * ≥12pt. Mirrors `<a:rPr kern="…"/>`.
   */
  kern?: number;
  /**
   * Baseline offset as a fraction of 1 (`0.3` = superscript ~30% up,
   * `-0.25` = subscript). The file stores ST_Percentage; this getter
   * returns the unit-fraction form for ergonomic comparisons.
   */
  baseline?: number;
  /**
   * Capitalization mode: `'none'`, `'small'` (smallCaps), or `'all'`
   * (allCaps). Mirrors `<a:rPr cap="…"/>`.
   */
  cap?: "none" | "small" | "all";
  /**
   * Highlight color (cell-fill style background per run). Same color
   * format as `color`. Mirrors `<a:rPr><a:highlight>…</a:highlight></a:rPr>`.
   */
  highlight?: string | null;
  /**
   * Underline color (`<a:uFill>`). `null` makes the underline follow the
   * text color again.
   */
  underlineColor?: string | null;
  /** Equalize character height (`normalizeH`): every glyph as tall as a capital. */
  normalizeHeight?: boolean;
  /** Text outline (`<a:ln>` on the run). `null` removes it. */
  outline?: TextOutline | null;
  /**
   * Gradient text fill (`<a:gradFill>`), in place of a solid color. `null`
   * removes it (the text then takes `color`, or inherits).
   */
  gradient?: TextGradient | null;
  /** Effects drawn with the letters (`<a:effectLst>`). `null` removes them. */
  effects?: TextEffects | null;
}

/** An outline drawn round each letter. */
export interface TextOutline {
  readonly color: string;
  /** Width in EMU (12700 = 1pt). */
  readonly widthEmu: number;
  /** Optional `ST_PresetLineDashVal` token. */
  readonly dash?: string;
  readonly opacity?: number;
}

/** A linear gradient across the text. */
export interface TextGradient {
  readonly stops: readonly {
    readonly offset: number;
    readonly color: string;
    readonly opacity?: number;
  }[];
  /** Degrees clockwise from 3 o'clock; 90 runs top to bottom. */
  readonly angleDeg: number;
}

/** Shadow, glow and reflection drawn with the text. */
export interface TextEffects {
  readonly shadow?: {
    readonly color: string;
    readonly opacity?: number;
    readonly blurEmu: number;
    readonly distEmu: number;
    readonly angleDeg: number;
    readonly inner?: boolean;
  } | null;
  readonly glow?: {
    readonly color: string;
    readonly opacity?: number;
    readonly radiusEmu: number;
  } | null;
  readonly reflection?: {
    readonly startOpacity: number;
    readonly endPos: number;
    readonly distEmu: number;
    readonly blurEmu: number;
  } | null;
}

const alphaColor = (color: string, opacity?: number): XmlElement => {
  const el = buildColorElement(color);
  if (opacity !== undefined && opacity < 1)
    el.children.push(
      elem(qname("a", "alpha", NS.dml), {
        attrs: [
          attr(
            ATTR_VAL,
            String(Math.round(Math.max(0, Math.min(1, opacity)) * 100000)),
          ),
        ],
      }),
    );
  return el;
};

const intAttr = (name: string, value: number) =>
  attr(qname("", name, ""), String(Math.round(value)));

/** Builds a run-level `<a:effectLst>` in the schema's effect order. */
export const buildTextEffectList = (effects: TextEffects): XmlElement => {
  const children: XmlElement[] = [];
  if (effects.glow)
    children.push(
      elem(qname("a", "glow", NS.dml), {
        attrs: [intAttr("rad", effects.glow.radiusEmu)],
        children: [alphaColor(effects.glow.color, effects.glow.opacity)],
      }),
    );
  if (effects.shadow?.inner)
    children.push(
      elem(qname("a", "innerShdw", NS.dml), {
        attrs: [
          intAttr("blurRad", effects.shadow.blurEmu),
          intAttr("dist", effects.shadow.distEmu),
          intAttr(
            "dir",
            (((effects.shadow.angleDeg % 360) + 360) % 360) * 60000,
          ),
        ],
        children: [alphaColor(effects.shadow.color, effects.shadow.opacity)],
      }),
    );
  else if (effects.shadow)
    children.push(
      elem(qname("a", "outerShdw", NS.dml), {
        attrs: [
          intAttr("blurRad", effects.shadow.blurEmu),
          intAttr("dist", effects.shadow.distEmu),
          intAttr(
            "dir",
            (((effects.shadow.angleDeg % 360) + 360) % 360) * 60000,
          ),
          attr(qname("", "algn", ""), "tl"),
          attr(qname("", "rotWithShape", ""), "0"),
        ],
        children: [alphaColor(effects.shadow.color, effects.shadow.opacity)],
      }),
    );
  if (effects.reflection)
    children.push(
      elem(qname("a", "reflection", NS.dml), {
        attrs: [
          intAttr("blurRad", effects.reflection.blurEmu),
          intAttr("stA", effects.reflection.startOpacity * 100000),
          intAttr("endPos", effects.reflection.endPos * 100000),
          intAttr("dist", effects.reflection.distEmu),
          intAttr("dir", 5400000),
          intAttr("sy", -100000),
          attr(qname("", "algn", ""), "bl"),
          attr(qname("", "rotWithShape", ""), "0"),
        ],
      }),
    );
  return elem(qname("a", "effectLst", NS.dml), { children });
};

const FILL_NAMES = [
  "noFill",
  "solidFill",
  "gradFill",
  "blipFill",
  "pattFill",
  "grpFill",
];
const dropChildren = (rPr: XmlElement, names: readonly string[]) => {
  rPr.children = rPr.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        names.includes(c.name.localName)
      ),
  );
};

const applyExtendedRunFormat = (rPr: XmlElement, format: TextFormat) => {
  if (format.underlineColor !== undefined) {
    dropChildren(rPr, ["uFillTx", "uFill"]);
    if (format.underlineColor !== null)
      insertChildByRank(
        rPr,
        elem(qname("a", "uFill", NS.dml), {
          children: [
            elem(NAME_SOLID_FILL, {
              children: [buildColorElement(format.underlineColor)],
            }),
          ],
        }),
        rprChildRank,
      );
  }
  if (format.normalizeHeight !== undefined)
    rPr.attrs = setOrRemoveAttr(
      rPr.attrs,
      qname("", "normalizeH", ""),
      format.normalizeHeight ? "1" : null,
    );
  if (format.outline !== undefined) {
    dropChildren(rPr, ["ln"]);
    if (format.outline !== null) {
      const children: XmlElement[] = [
        elem(NAME_SOLID_FILL, {
          children: [alphaColor(format.outline.color, format.outline.opacity)],
        }),
      ];
      if (format.outline.dash)
        children.push(
          elem(qname("a", "prstDash", NS.dml), {
            attrs: [attr(ATTR_VAL, format.outline.dash)],
          }),
        );
      insertChildByRank(
        rPr,
        elem(qname("a", "ln", NS.dml), {
          attrs: [
            intAttr(
              "w",
              Math.max(0, Math.min(20116800, format.outline.widthEmu)),
            ),
          ],
          children,
        }),
        rprChildRank,
      );
    }
  }
  if (format.gradient !== undefined) {
    dropChildren(rPr, ["gradFill"]);
    if (format.gradient !== null) {
      if (format.gradient.stops.length < 2)
        throw new Error("a text gradient needs two or more stops");
      dropChildren(rPr, FILL_NAMES);
      const stops = format.gradient.stops.map((stop) =>
        elem(qname("a", "gs", NS.dml), {
          attrs: [
            intAttr("pos", Math.max(0, Math.min(1, stop.offset)) * 100000),
          ],
          children: [alphaColor(stop.color, stop.opacity)],
        }),
      );
      insertChildByRank(
        rPr,
        elem(qname("a", "gradFill", NS.dml), {
          attrs: [attr(qname("", "rotWithShape", ""), "1")],
          children: [
            elem(qname("a", "gsLst", NS.dml), { children: stops }),
            elem(qname("a", "lin", NS.dml), {
              attrs: [
                intAttr(
                  "ang",
                  (((format.gradient.angleDeg % 360) + 360) % 360) * 60000,
                ),
                attr(qname("", "scaled", ""), "0"),
              ],
            }),
          ],
        }),
        rprChildRank,
      );
    }
  }
  if (format.effects !== undefined) {
    dropChildren(rPr, ["effectLst", "effectDag"]);
    if (
      format.effects &&
      (format.effects.shadow ||
        format.effects.glow ||
        format.effects.reflection)
    )
      insertChildByRank(rPr, buildTextEffectList(format.effects), rprChildRank);
  }
};

const setOrRemoveAttr = (
  attrs: XmlAttr[],
  name: ReturnType<typeof qname>,
  value: string | null,
): XmlAttr[] => {
  const filtered = attrs.filter(
    (a) =>
      a.name.localName !== name.localName ||
      a.name.namespaceURI !== name.namespaceURI,
  );
  if (value !== null) filtered.push(attr(name, value));
  return filtered;
};

const setSolidFill = (rPr: XmlElement, value: string | null): void => {
  // Remove any existing fill choice first: a run holds one.
  rPr.children = rPr.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        (c.name.localName === "solidFill" ||
          (value !== null &&
            (c.name.localName === "gradFill" ||
              c.name.localName === "noFill" ||
              c.name.localName === "pattFill")))
      ),
  );
  if (value === null) return;
  const fill = elem(NAME_SOLID_FILL, { children: [buildColorElement(value)] });
  insertChildByRank(rPr, fill, rprChildRank);
};

const setLatin = (rPr: XmlElement, font: string | null): void => {
  rPr.children = rPr.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        c.name.localName === "latin"
      ),
  );
  if (font === null) return;
  insertChildByRank(
    rPr,
    elem(NAME_LATIN, { attrs: [attr(ATTR_TYPEFACE, font)] }),
    rprChildRank,
  );
};

const setEastAsian = (rPr: XmlElement, font: string | null): void => {
  rPr.children = rPr.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        c.name.localName === "ea"
      ),
  );
  if (font === null) return;
  insertChildByRank(
    rPr,
    elem(NAME_EA, { attrs: [attr(ATTR_TYPEFACE, font)] }),
    rprChildRank,
  );
};

const setHighlight = (rPr: XmlElement, value: string | null): void => {
  rPr.children = rPr.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        c.name.localName === "highlight"
      ),
  );
  if (value === null) return;
  if (parseColor(value) === null)
    throw new Error(`unrecognized highlight color: ${value}`);
  insertChildByRank(
    rPr,
    elem(NAME_HIGHLIGHT, { children: [buildColorElement(value)] }),
    rprChildRank,
  );
};

/** Mutates `rPr` in place per `format`. */
export const applyRunFormat = (rPr: XmlElement, format: TextFormat): void => {
  let opacityColor: XmlElement | undefined;
  if (format.colorOpacity !== undefined) {
    if (
      !Number.isFinite(format.colorOpacity) ||
      format.colorOpacity < 0 ||
      format.colorOpacity > 1
    )
      throw new RangeError("text colorOpacity must be between 0 and 1");
    if (typeof format.color === "string" && !parseColor(format.color))
      throw new Error(`unrecognized color: ${format.color}`);
    opacityColor = firstChildElement(rPr, NAME_SOLID_FILL)?.children.find(
      (c): c is XmlElement =>
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        [
          "srgbClr",
          "scrgbClr",
          "hslClr",
          "sysClr",
          "schemeClr",
          "prstClr",
        ].includes(c.name.localName),
    );
    if (format.color === null || (format.color === undefined && !opacityColor))
      throw new Error(
        "text colorOpacity requires a color or an existing local solid fill",
      );
  }
  let attrs = rPr.attrs;
  if (format.language !== undefined)
    attrs = setOrRemoveAttr(attrs, ATTR_LANG, format.language);
  if (format.alternateLanguage !== undefined)
    attrs = setOrRemoveAttr(attrs, ATTR_ALT_LANG, format.alternateLanguage);
  if (format.size !== undefined) {
    // Hundredths of a point per the schema (ST_TextFontSize: 1..4000 pt).
    const sz = fontSizeHundredthPt(
      format.size * 100,
      "setShapeRunFormat: size",
    );
    attrs = setOrRemoveAttr(attrs, ATTR_SZ, String(sz));
  }
  if (format.bold !== undefined) {
    attrs = setOrRemoveAttr(attrs, ATTR_B, format.bold ? "1" : "0");
  }
  if (format.italic !== undefined) {
    attrs = setOrRemoveAttr(attrs, ATTR_I, format.italic ? "1" : "0");
  }
  if (format.underline !== undefined) {
    const value =
      format.underline === false
        ? "none"
        : format.underline === true
          ? "sng"
          : format.underline;
    attrs = setOrRemoveAttr(attrs, ATTR_U, value);
  }
  if (format.strike !== undefined) {
    const value =
      format.strike === false
        ? "noStrike"
        : format.strike === true
          ? "sngStrike"
          : format.strike;
    attrs = setOrRemoveAttr(attrs, ATTR_STRIKE, value);
  }
  if (format.spc !== undefined) {
    const spc = textPointSpacing(format.spc, "setShapeRunFormat: spc");
    attrs = setOrRemoveAttr(attrs, ATTR_SPC, String(spc));
  }
  if (format.kern !== undefined) {
    attrs = setOrRemoveAttr(attrs, ATTR_KERN, String(Math.round(format.kern)));
  }
  if (format.baseline !== undefined) {
    // ST_Percentage; we accept the unit-fraction form on the public API
    // and serialize as the on-the-wire hundredths-of-percent integer.
    const pct = Math.round(format.baseline * 100000);
    attrs = setOrRemoveAttr(attrs, ATTR_BASELINE, String(pct));
  }
  if (format.cap !== undefined) {
    attrs = setOrRemoveAttr(attrs, ATTR_CAP, format.cap);
  }
  rPr.attrs = attrs;

  if (format.font !== undefined) setLatin(rPr, format.font);
  if (format.fontEastAsian !== undefined)
    setEastAsian(rPr, format.fontEastAsian);
  if (format.color !== undefined) setSolidFill(rPr, format.color);
  if (format.colorOpacity !== undefined) {
    // A supplied color replaces the local fill; otherwise use the existing
    // color choice validated above, rather than an extension/unknown child.
    const color =
      format.color !== undefined
        ? (firstChildElement(rPr, NAME_SOLID_FILL)!.children[0] as XmlElement)
        : opacityColor!;
    color.children = color.children.filter(
      (c) =>
        !(
          c.kind === "element" &&
          c.name.namespaceURI === NS.dml &&
          ["alpha", "alphaMod", "alphaOff"].includes(c.name.localName)
        ),
    );
    color.children.push(
      elem(qname("a", "alpha", NS.dml), {
        attrs: [
          attr(ATTR_VAL, String(Math.round(format.colorOpacity * 100000))),
        ],
      }),
    );
  }
  if (format.highlight !== undefined) setHighlight(rPr, format.highlight);
  applyExtendedRunFormat(rPr, format);

  void NAME_CS;
};

/**
 * Walks `txBody`, ensuring every run, field and break has an `<a:rPr>` carrying the
 * supplied format. Existing run-property attributes not addressed by
 * `format` are preserved.
 */
export const applyFormatToAllRuns = (
  txBody: XmlElement,
  format: TextFormat,
): void => {
  // Character elements live two levels deep (txBody > p > r/fld/br).
  for (const p of txBody.children) {
    if (
      p.kind !== "element" ||
      p.name.namespaceURI !== NS.dml ||
      p.name.localName !== "p"
    ) {
      continue;
    }
    for (const r of p.children) {
      if (
        r.kind !== "element" ||
        r.name.namespaceURI !== NS.dml ||
        !["r", "fld", "br"].includes(r.name.localName)
      ) {
        continue;
      }
      let rPr = firstChildElement(r, NAME_RPR);
      if (rPr === null) {
        rPr = elem(NAME_RPR);
        // rPr must be the first child of the run per the schema.
        r.children.unshift(rPr);
      }
      applyRunFormat(rPr, format);
    }
  }
};
