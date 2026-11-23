import { getPlaceholderInheritance } from "./placeholder-inheritance.ts";

// Shape mutation: text body, autofit, margins, wrap, anchor.

import {
  type BulletStyle,
  type ParagraphAlignment,
  type TextFormat,
  applyAlignmentToAllParagraphs,
  applyBulletToAllParagraphs,
  applyFormatToAllRuns,
  setTextBody,
} from "../../internal/drawingml/index.ts";
import {
  angle60000,
  emuCoordinate32,
  emuPositiveCoordinate32,
  textColumnCount,
} from "../../internal/bounds.ts";

import {
  NS,
  type XmlElement,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  qname,
} from "../../internal/xml/index.ts";
import {
  type PresentationData,
  SHAPE_ELEMENT,
  SHAPE_SNAPSHOT,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { commitAndRefresh, requireTxBody } from "./_helpers.ts";
const NAME_TX_BODY = qname("p", "txBody", NS.pml);

// ---------------------------------------------------------------------------
// Shape mutation — text.

/**
 * Replaces the shape's visible text with `value`. Newlines start a new
 * paragraph. Existing run/paragraph properties are preserved so font,
 * color, size, alignment, and bullet style stay intact.
 */
export const setShapeText = (
  shape: SlideShapeData,
  value: string,
  options: { bullets?: BulletStyle } = {},
): void => {
  if (shape[SHAPE_SNAPSHOT].kind !== "shape") {
    throw new Error(
      `setShapeText only works on text-bearing shapes; ${shape[SHAPE_SNAPSHOT].kind} is not one`,
    );
  }
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (txBody === null) {
    throw new Error(`shape "${shape[SHAPE_SNAPSHOT].name}" has no <p:txBody>`);
  }
  setTextBody(txBody, value);
  if (options.bullets !== undefined) {
    applyBulletToAllParagraphs(txBody, options.bullets);
  }
  commitAndRefresh(shape);
};

/**
 * Appends `value` to the shape's existing text on a new line. The
 * shape's existing run / paragraph formatting is preserved by
 * `setTextBody`; the new paragraph inherits the same template.
 *
 * Equivalent to `setShapeText(shape, getShapeText(shape) + '\n' + value)`,
 * minus the leading newline when there was no existing text.
 */
export const appendShapeText = (shape: SlideShapeData, value: string): void => {
  if (shape[SHAPE_SNAPSHOT].kind !== "shape") {
    throw new Error(
      `appendShapeText only works on text-bearing shapes; ${shape[SHAPE_SNAPSHOT].kind} is not one`,
    );
  }
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (txBody === null) {
    throw new Error(`shape "${shape[SHAPE_SNAPSHOT].name}" has no <p:txBody>`);
  }
  const existing = shape[SHAPE_SNAPSHOT].text;
  const combined = existing.length === 0 ? value : `${existing}\n${value}`;
  setTextBody(txBody, combined);
  commitAndRefresh(shape);
};

/**
 * Sets the vertical text anchor on the shape's text body
 * (`<a:bodyPr anchor="..."/>`). Choices map to ECMA-376 tokens:
 *
 *   - `'top'`    → `anchor="t"`
 *   - `'center'` → `anchor="ctr"`
 *   - `'bottom'` → `anchor="b"`
 *
 * The bodyPr is created if absent. Throws for non-text-bearing shape
 * kinds.
 */
export type TextAnchor = "top" | "center" | "bottom";

const NAME_A_BODY_PR = qname("a", "bodyPr", NS.dml);

/**
 * Word wrap mode on a text body. `'square'` (the usual default for
 * textboxes) wraps lines at the shape's width; `'none'` lets text
 * overflow horizontally.
 */
export type TextWrap = "none" | "square";

/** Auto-fit mode on a text body. */
export type TextAutoFit =
  | "none" // <a:noAutofit/>
  | "normal" // <a:normAutofit/> — shrink text to fit
  | "shape"; // <a:spAutoFit/> — resize shape to fit text

const AUTO_FIT_LOCALS = new Set(["noAutofit", "normAutofit", "spAutoFit"]);

const requireBodyPr = (shape: SlideShapeData): XmlElement => {
  const txBody = requireTxBody(shape);
  let bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
  if (bodyPr === null) {
    bodyPr = elem(NAME_A_BODY_PR);
    txBody.children.unshift(bodyPr);
  }
  return bodyPr;
};

/**
 * Sets the text-body word-wrap mode.
 *
 *   - `'square'` writes `wrap="square"` — the usual default for textboxes.
 *   - `'none'`   writes `wrap="none"`  — text can overflow horizontally.
 *
 * Throws for non-text-bearing shape kinds.
 */
export const setShapeTextWrap = (
  shape: SlideShapeData,
  wrap: TextWrap,
): void => {
  const bodyPr = requireBodyPr(shape);
  const ATTR_WRAP = qname("", "wrap", "");
  bodyPr.attrs = bodyPr.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && a.name.localName === "wrap"),
  );
  bodyPr.attrs.push(attr(ATTR_WRAP, wrap));
  commitAndRefresh(shape);
};

/** Reads back the bodyPr `wrap` attribute, or `null` when absent. */
export const getShapeTextWrap = (shape: SlideShapeData): TextWrap | null => {
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (!txBody) return null;
  const bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
  if (!bodyPr) return null;
  const v = getAttrValue(bodyPr, qname("", "wrap", ""));
  if (v === "none" || v === "square") return v;
  return null;
};

/**
 * Sets the text-body auto-fit mode:
 *
 *   - `'none'`   → `<a:noAutofit/>`
 *   - `'normal'` → `<a:normAutofit/>`   shrink text to fit the shape
 *   - `'shape'`  → `<a:spAutoFit/>`     grow the shape to fit text
 *
 * Replaces any prior auto-fit child on `<a:bodyPr>`. Throws for
 * non-text-bearing shape kinds.
 */
export const setShapeTextAutoFit = (
  shape: SlideShapeData,
  mode: TextAutoFit,
): void => {
  const bodyPr = requireBodyPr(shape);
  bodyPr.children = bodyPr.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        AUTO_FIT_LOCALS.has(c.name.localName)
      ),
  );
  const local =
    mode === "none"
      ? "noAutofit"
      : mode === "normal"
        ? "normAutofit"
        : "spAutoFit";
  bodyPr.children.push(elem(qname("a", local, NS.dml)));
  commitAndRefresh(shape);
};

/**
 * Reads back the bodyPr auto-fit child, or `null` when none is
 * present (a layout-inherited default applies in that case).
 */
export const getShapeTextAutoFit = (
  shape: SlideShapeData,
): TextAutoFit | null => {
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (!txBody) return null;
  const bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
  if (!bodyPr) return null;
  for (const c of bodyPr.children) {
    if (c.kind !== "element" || c.name.namespaceURI !== NS.dml) continue;
    if (c.name.localName === "noAutofit") return "none";
    if (c.name.localName === "normAutofit") return "normal";
    if (c.name.localName === "spAutoFit") return "shape";
  }
  return null;
};

/**
 * Reads the scale parameters stored on `<a:normAutofit>`
 * once an editor has shrunk a text body to fit. Returns `null` if the body
 * doesn't carry `<a:normAutofit>`. The numeric fields are unitless ratios:
 *
 *   - `fontScale`     — multiply every run's font size by this. Default `1`.
 *   - `lnSpcReduction` — subtract from the line-height ratio. Default `0`.
 *
 * Companion to `getShapeTextAutoFit`. Renderers that want to match
 * the saved on-screen text size apply these factors to the
 * authored font sizes; without them, every long title overflows.
 */
export const getShapeTextAutoFitParams = (
  shape: SlideShapeData,
): {
  fontScale: number;
  lnSpcReduction: number;
  hasFontScale: boolean;
} | null => {
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (!txBody) return null;
  const bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
  if (!bodyPr) return null;
  for (const c of bodyPr.children) {
    if (
      c.kind === "element" &&
      c.name.namespaceURI === NS.dml &&
      c.name.localName === "normAutofit"
    ) {
      const fsRaw = getAttrValue(c, qname("", "fontScale", ""));
      const lsRaw = getAttrValue(c, qname("", "lnSpcReduction", ""));
      const fs = fsRaw === null ? 100_000 : Number.parseInt(fsRaw, 10);
      const ls = lsRaw === null ? 0 : Number.parseInt(lsRaw, 10);
      return {
        fontScale: Number.isFinite(fs) ? fs / 100_000 : 1,
        lnSpcReduction: Number.isFinite(ls) ? ls / 100_000 : 0,
        // An explicitly stored 100% is a baked scale, not a request to fit
        // again. Preserve presence separately from the default numeric value.
        hasFontScale: fsRaw !== null && Number.isFinite(fs),
      };
    }
  }
  return null;
};

/**
 * Reads back the vertical text anchor on the shape's `<a:bodyPr>`.
 * Maps the ECMA-376 tokens back to the public union:
 *
 *   `'t'` → `'top'`, `'ctr'` → `'center'`, `'b'` → `'bottom'`
 *
 * Returns `null` when the bodyPr is absent or has no anchor attribute.
 */
export const getShapeTextAnchor = (
  shape: SlideShapeData,
): TextAnchor | null => {
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (!txBody) return null;
  const bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
  if (!bodyPr) return null;
  const v = getAttrValue(bodyPr, qname("", "anchor", ""));
  if (v === "t") return "top";
  if (v === "ctr") return "center";
  if (v === "b") return "bottom";
  return null;
};

/**
 * Reads back the internal margins of the shape's text frame. Sides
 * that are absent in the XML default to `null` (the built-in
 * default applies for the missing side).
 */
/**
 * Reads the multi-column layout on a text body — `<a:bodyPr
 * numCol="N" spcCol="EMU"/>`. Returns `null` when columns aren't
 * configured (the default single column). `gapEmu` is the
 * inter-column gap in EMU; omitted when `<a:bodyPr>` has no
 * `spcCol` attribute.
 */
export const getShapeTextColumns = (
  shape: SlideShapeData,
): { count: number; gapEmu?: number } | null => {
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (!txBody) return null;
  const bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
  if (!bodyPr) return null;
  const numColRaw = getAttrValue(bodyPr, qname("", "numCol", ""));
  if (numColRaw === null) return null;
  const count = Number.parseInt(numColRaw, 10);
  if (!Number.isFinite(count) || count < 2) return null;
  const gapRaw = getAttrValue(bodyPr, qname("", "spcCol", ""));
  if (gapRaw !== null) {
    const g = Number.parseInt(gapRaw, 10);
    if (Number.isFinite(g)) return { count, gapEmu: g };
  }
  return { count };
};

/**
 * Sets the multi-column layout on the shape's text body — writes
 * `<a:bodyPr numCol="N" [spcCol="EMU"]/>`. Pass `null` to clear both
 * attributes so the text body falls back to the default
 * single column. `count` must be in `2..16` (ST_TextColumnCount caps at
 * 16, and single column is the `null` default). `gapEmu`, when omitted,
 * removes any prior `spcCol`. Throws for non-text-bearing shape kinds.
 */
export const setShapeTextColumns = (
  shape: SlideShapeData,
  columns: { count: number; gapEmu?: number } | null,
): void => {
  const bodyPr = requireBodyPr(shape);
  bodyPr.attrs = bodyPr.attrs.filter(
    (a) =>
      !(
        a.name.namespaceURI === "" &&
        (a.name.localName === "numCol" || a.name.localName === "spcCol")
      ),
  );
  if (columns !== null) {
    if (columns.count < 2) {
      throw new Error(
        `setShapeTextColumns: count must be >= 2 (single column is the default — pass null instead). Got ${columns.count}.`,
      );
    }
    // ST_TextColumnCount caps at 16; spcCol is ST_PositiveCoordinate32.
    const numCol = textColumnCount(columns.count, "setShapeTextColumns: count");
    bodyPr.attrs.push(attr(qname("", "numCol", ""), String(numCol)));
    if (columns.gapEmu !== undefined) {
      const spcCol = emuPositiveCoordinate32(
        columns.gapEmu,
        "setShapeTextColumns: gapEmu",
      );
      bodyPr.attrs.push(attr(qname("", "spcCol", ""), String(spcCol)));
    }
  }
  commitAndRefresh(shape);
};

/**
 * Reads the shape's text-body rotation from `<a:bodyPr rot="N"/>`.
 * `rot` is stored in 60000ths of a degree (OOXML angle units); the
 * returned value is in degrees. Positive values rotate clockwise per
 * the OOXML convention. Returns `null` when the attribute is
 * absent.
 *
 * Distinct from the shape's own `<p:xfrm rot=…>` (the geometry
 * rotation surfaced via the shape's `rotation`); `bodyPr rot` rotates
 * the text body inside the shape without rotating the shape itself.
 */
export const getShapeTextBodyRotationDeg = (
  shape: SlideShapeData,
): number | null => {
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (!txBody) return null;
  const bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
  if (!bodyPr) return null;
  const v = getAttrValue(bodyPr, qname("", "rot", ""));
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n / 60000 : null;
};

/**
 * Sets the shape's text-body rotation (`<a:bodyPr rot="N"/>`), measured
 * in degrees. Positive rotates clockwise per the OOXML convention.
 * Passing `null` clears the attribute so the shape inherits the default
 * (`0`). Throws for non-text-bearing shape kinds.
 *
 * Companion to `setShapeRotation`, which rotates the *whole* shape
 * via `<p:xfrm rot>`. `bodyPr rot` rotates only the text inside.
 */
export const setShapeTextBodyRotationDeg = (
  shape: SlideShapeData,
  rotationDeg: number | null,
): void => {
  const bodyPr = requireBodyPr(shape);
  // Strip any prior rot attribute.
  bodyPr.attrs = bodyPr.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && a.name.localName === "rot"),
  );
  if (rotationDeg !== null && rotationDeg !== 0) {
    // `rot` is ST_Angle in 1/60000 degree (xsd:int); guard the *60000 overflow.
    const rot = angle60000(
      rotationDeg * 60000,
      "setShapeTextBodyRotationDeg: rotationDeg",
    );
    bodyPr.attrs.push(attr(qname("", "rot", ""), String(rot)));
  }
  commitAndRefresh(shape);
};

/**
 * Reads the shape's text-direction token from `<a:bodyPr vert="…"/>`.
 * Per ECMA-376 §17.18.93 `ST_TextVerticalType`:
 *
 *   - `horz` — default left-to-right, top-to-bottom (returns `null`).
 *   - `vert` — 90° rotation, lines run top-to-bottom, columns right-to-left.
 *   - `vert270` — 270° rotation, lines top-to-bottom, columns left-to-right.
 *   - `wordArtVert` — characters not rotated, stacked vertically.
 *   - `eaVert` — East-Asian vertical: characters upright, columns right-to-left.
 *   - `mongolianVert` — Mongolian: rotated 90°, columns left-to-right.
 *   - `wordArtVertRtl` — RTL word-art stacked vertically.
 *
 * Returns `null` when the attribute is absent or set to the default
 * `horz`.
 */
/**
 * Whether the shape's text stays upright when the shape is turned
 * (`<a:bodyPr upright="1">`, "Do not rotate text"). Literal value only.
 */
export const getShapeTextUpright = (shape: SlideShapeData): boolean => {
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  const bodyPr = txBody && firstChildElement(txBody, NAME_A_BODY_PR);
  const v = bodyPr && getAttrValue(bodyPr, qname("", "upright", ""));
  return v === "1" || v === "true";
};

export const getShapeTextDirection = (
  shape: SlideShapeData,
):
  | "vert"
  | "vert270"
  | "wordArtVert"
  | "eaVert"
  | "mongolianVert"
  | "wordArtVertRtl"
  | null => {
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (!txBody) return null;
  const bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
  if (!bodyPr) return null;
  const v = getAttrValue(bodyPr, qname("", "vert", ""));
  if (
    v === "vert" ||
    v === "vert270" ||
    v === "wordArtVert" ||
    v === "eaVert" ||
    v === "mongolianVert" ||
    v === "wordArtVertRtl"
  )
    return v;
  return null;
};

/**
 * Sets the shape's text-direction via `<a:bodyPr vert="…"/>`. See
 * `getShapeTextDirection` for the meaning of each value. Passing `null`
 * clears the attribute and restores layout/master inheritance. `'horz'`
 * writes an explicit horizontal override, including when the template uses
 * vertical text. Throws for non-text-bearing shape kinds.
 */
export const setShapeTextDirection = (
  shape: SlideShapeData,
  direction:
    | "horz"
    | "vert"
    | "vert270"
    | "wordArtVert"
    | "eaVert"
    | "mongolianVert"
    | "wordArtVertRtl"
    | null,
): void => {
  const bodyPr = requireBodyPr(shape);
  bodyPr.attrs = bodyPr.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && a.name.localName === "vert"),
  );
  if (direction !== null) {
    bodyPr.attrs.push(attr(qname("", "vert", ""), direction));
  }
  commitAndRefresh(shape);
};

export const getShapeTextMargins = (
  shape: SlideShapeData,
): {
  readonly left: number | null;
  readonly top: number | null;
  readonly right: number | null;
  readonly bottom: number | null;
} | null => {
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (!txBody) return null;
  const bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
  if (!bodyPr) return null;
  const readSide = (local: string): number | null => {
    const v = getAttrValue(bodyPr, qname("", local, ""));
    if (v === null) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    left: readSide("lIns"),
    top: readSide("tIns"),
    right: readSide("rIns"),
    bottom: readSide("bIns"),
  };
};

/**
 * Resolves the effective `<a:bodyPr>` properties — anchor, wrap, vertical
 * direction, and inset margins — by walking the layout / master cascade
 * the same way `getShapeRunFormatEffective` walks rPr. Returns the
 * innermost value that the cascade supplies, or `null` for properties
 * neither the shape nor any inherited placeholder authors.
 *
 * Companion to `getShapeTextAnchor` / `getShapeTextWrap` /
 * `getShapeTextDirection` / `getShapeTextMargins`, which only report the
 * literal value on the shape itself.
 */
export const getShapeBodyPrEffective = (
  pres: PresentationData,
  shape: SlideShapeData,
): {
  anchor: TextAnchor | null;
  wrap: TextWrap | null;
  vert: ReturnType<typeof getShapeTextDirection>;
  compatibleLineSpacing: boolean | null;
  includeOuterSpacing: boolean | null;
  /** `anchorCtr`: the text's bounding box is centered across the shape. */
  anchorCenter: boolean | null;
  margins: {
    left: number | null;
    top: number | null;
    right: number | null;
    bottom: number | null;
  };
} => {
  const result = {
    anchor: null as TextAnchor | null,
    wrap: null as TextWrap | null,
    vert: null as ReturnType<typeof getShapeTextDirection>,
    compatibleLineSpacing: null as boolean | null,
    includeOuterSpacing: null as boolean | null,
    anchorCenter: null as boolean | null,
    margins: {
      left: null as number | null,
      top: null as number | null,
      right: null as number | null,
      bottom: null as number | null,
    },
  };
  // The public direction reader represents horizontal text as null. Keep
  // presence separately so an explicit horz stops the inheritance cascade.
  let directionResolved = false;
  const parseBodyPr = (bodyPr: XmlElement): void => {
    for (const [attribute, property] of [
      ["compatLnSpc", "compatibleLineSpacing"],
      ["spcFirstLastPara", "includeOuterSpacing"],
      ["anchorCtr", "anchorCenter"],
    ] as const) {
      if (result[property] !== null) continue;
      const value = getAttrValue(bodyPr, qname("", attribute, ""));
      if (value === "1" || value === "true") result[property] = true;
      else if (value === "0" || value === "false") result[property] = false;
    }
    if (result.anchor === null) {
      const a = getAttrValue(bodyPr, qname("", "anchor", ""));
      if (a === "t") result.anchor = "top";
      else if (a === "ctr") result.anchor = "center";
      else if (a === "b") result.anchor = "bottom";
    }
    if (result.wrap === null) {
      const w = getAttrValue(bodyPr, qname("", "wrap", ""));
      if (w === "square") result.wrap = "square";
      else if (w === "none") result.wrap = "none";
    }
    if (!directionResolved) {
      const v = getAttrValue(bodyPr, qname("", "vert", ""));
      if (v === "horz") directionResolved = true;
      if (
        v === "vert" ||
        v === "vert270" ||
        v === "wordArtVert" ||
        v === "eaVert" ||
        v === "mongolianVert" ||
        v === "wordArtVertRtl"
      ) {
        result.vert = v;
        directionResolved = true;
      }
    }
    for (const side of ["l", "t", "r", "b"] as const) {
      const target =
        side === "l"
          ? "left"
          : side === "t"
            ? "top"
            : side === "r"
              ? "right"
              : "bottom";
      if (result.margins[target] !== null) continue;
      const v = getAttrValue(bodyPr, qname("", `${side}Ins`, ""));
      if (v === null) continue;
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) result.margins[target] = n;
    }
  };

  // 1. The shape's own bodyPr.
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (txBody) {
    const bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
    if (bodyPr) parseBodyPr(bodyPr);
  }

  const inheritance = getPlaceholderInheritance(shape);
  if (inheritance) {
    for (const ancestor of [inheritance.layout, inheritance.master]) {
      if (!ancestor) continue;
      const body = firstChildElement(ancestor.element, NAME_TX_BODY);
      const properties = body && firstChildElement(body, NAME_A_BODY_PR);
      if (properties) parseBodyPr(properties);
    }
  }
  return result;
};

export const setShapeTextAnchor = (
  shape: SlideShapeData,
  anchor: TextAnchor,
): void => {
  const txBody = requireTxBody(shape);
  let bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
  if (bodyPr === null) {
    bodyPr = elem(NAME_A_BODY_PR);
    txBody.children.unshift(bodyPr);
  }
  const token = anchor === "top" ? "t" : anchor === "center" ? "ctr" : "b";
  const ATTR_ANCHOR = qname("", "anchor", "");
  // Replace any existing anchor attribute.
  bodyPr.attrs = bodyPr.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && a.name.localName === "anchor"),
  );
  bodyPr.attrs.push(attr(ATTR_ANCHOR, token));
  commitAndRefresh(shape);
};

/**
 * Sets the internal margins of the shape's text frame in EMU. Each
 * side is independent; omitted sides keep their current value (or the
 * layout-inherited default when the attribute is absent).
 *
 * Defaults for a textbox (ECMA-376 21.1.2.1.1): left/right 91440 (0.1in),
 * top/bottom 45720 (0.05in).
 *
 *   setShapeTextMargins(shape, { left: 0, right: 0 }); // flush-left text
 */
export const setShapeTextMargins = (
  shape: SlideShapeData,
  margins: { left?: number; top?: number; right?: number; bottom?: number },
): void => {
  const txBody = requireTxBody(shape);
  let bodyPr = firstChildElement(txBody, NAME_A_BODY_PR);
  if (bodyPr === null) {
    bodyPr = elem(NAME_A_BODY_PR);
    txBody.children.unshift(bodyPr);
  }
  const writes: Array<{ name: string; value: number }> = [];
  if (margins.left !== undefined)
    writes.push({ name: "lIns", value: margins.left });
  if (margins.top !== undefined)
    writes.push({ name: "tIns", value: margins.top });
  if (margins.right !== undefined)
    writes.push({ name: "rIns", value: margins.right });
  if (margins.bottom !== undefined)
    writes.push({ name: "bIns", value: margins.bottom });

  const localsToClear = new Set(writes.map((w) => w.name));
  bodyPr.attrs = bodyPr.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && localsToClear.has(a.name.localName)),
  );
  for (const w of writes) {
    // Insets are ST_Coordinate32 (xsd:int EMU).
    const emu = emuCoordinate32(w.value, `setShapeTextMargins: ${w.name}`);
    bodyPr.attrs.push(attr(qname("", w.name, ""), String(emu)));
  }
  commitAndRefresh(shape);
};

/** Sets the bullet style on every paragraph in the shape's text body. */
export const setShapeBullets = (
  shape: SlideShapeData,
  style: BulletStyle,
): void => {
  applyBulletToAllParagraphs(requireTxBody(shape), style);
  commitAndRefresh(shape);
};

/** Sets the horizontal alignment of every paragraph in the shape's text. */
export const setShapeAlignment = (
  shape: SlideShapeData,
  align: ParagraphAlignment,
): void => {
  applyAlignmentToAllParagraphs(requireTxBody(shape), align);
  commitAndRefresh(shape);
};

/**
 * Applies `format` to every run in the shape's text. Run-property
 * attributes not addressed by `format` are preserved, so partial
 * updates compose.
 */
export const setShapeTextFormat = (
  shape: SlideShapeData,
  format: TextFormat,
): void => {
  applyFormatToAllRuns(requireTxBody(shape), format);
  commitAndRefresh(shape);
};
