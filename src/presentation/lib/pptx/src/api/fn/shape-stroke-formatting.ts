import type { ArrowOptions, LineDash } from "../../internal/drawingml/index.ts";
import {
  NS,
  firstChildElement,
  getAttrValue,
  qname,
  type XmlElement,
} from "../../internal/xml/index.ts";
import type { SlideShapeData } from "../_internal-symbols.ts";
import { shapeLineSources } from "./shape-stroke-width.ts";
import { effectiveGeometryElement } from "./shape-geometry.ts";

export type ShapeStrokeDash =
  | { readonly kind: "preset"; readonly value: LineDash }
  | {
      readonly kind: "custom";
      readonly stops: readonly {
        readonly dash: number;
        readonly space: number;
      }[];
    };
export type ShapeStrokeJoin =
  | { readonly kind: "round" | "bevel" }
  | { readonly kind: "miter"; readonly limit?: number };
export interface ShapeStrokeFormatting {
  readonly cap: "flat" | "rnd" | "sq" | null;
  readonly dash: ShapeStrokeDash | null;
  readonly join: ShapeStrokeJoin | null;
  readonly compound: "sng" | "dbl" | "thickThin" | "thinThick" | "tri" | null;
  /** Pen alignment (`algn`): centred on the path, or inside the shape. */
  readonly align: "ctr" | "in" | null;
  readonly head: ArrowOptions | null;
  readonly tail: ArrowOptions | null;
}
const value = (el: XmlElement, name: string) =>
  getAttrValue(el, qname("", name, ""));
const child = (el: XmlElement, name: string) =>
  firstChildElement(el, qname("a", name, NS.dml));
const token = <T extends string>(
  raw: string | null,
  valid: readonly T[],
): T | null => (valid.includes(raw as T) ? (raw as T) : null);
const presets: readonly LineDash[] = [
  "solid",
  "dot",
  "dash",
  "lgDash",
  "dashDot",
  "lgDashDot",
  "lgDashDotDot",
  "sysDash",
  "sysDot",
  "sysDashDot",
  "sysDashDotDot",
];

// ST_PositivePercentage: transitional thousandths of a percent or strict
// percentage syntax. Ratios are relative to the effective stroke width.
const percentage = (raw: string | null): number | null => {
  if (raw === null) return null;
  const text = raw.trim();
  if (/^\+?\d+$/.test(text)) {
    const n = Number(text);
    return Number.isSafeInteger(n) ? n / 100000 : null;
  }
  if (/^\+?\d+(?:\.\d+)?%$/.test(text)) {
    const n = Number(text.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  return null;
};
export const readStrokeDash = (line: XmlElement): ShapeStrokeDash | null => {
  for (const el of line.children) {
    if (el.kind !== "element" || el.name.namespaceURI !== NS.dml) continue;
    if (el.name.localName === "prstDash") {
      const preset = token(value(el, "val"), presets);
      if (preset) return { kind: "preset", value: preset };
    }
    if (el.name.localName === "custDash") {
      const stops: { dash: number; space: number }[] = [];
      let valid = true;
      for (const stop of el.children) {
        if (
          stop.kind !== "element" ||
          stop.name.namespaceURI !== NS.dml ||
          stop.name.localName !== "ds"
        )
          continue;
        const dash = percentage(value(stop, "d")),
          space = percentage(value(stop, "sp"));
        if (dash === null || space === null) {
          valid = false;
          break;
        }
        stops.push({ dash, space });
      }
      if (valid) return { kind: "custom", stops };
    }
  }
  return null;
};
export const readStrokeJoin = (line: XmlElement): ShapeStrokeJoin | null => {
  for (const el of line.children) {
    if (el.kind !== "element" || el.name.namespaceURI !== NS.dml) continue;
    if (el.name.localName === "round" || el.name.localName === "bevel")
      return { kind: el.name.localName };
    if (el.name.localName === "miter") {
      const limit = percentage(value(el, "lim"));
      // CT_LineJoinMiterProperties defaults lim to 800000 (800%). Native
      // reference PDF output likewise uses 8, rather than SVG's default 4.
      return { kind: "miter", limit: limit ?? 8 };
    }
  }
  return null;
};

// MS-OI29500 2.1.1305 (20.1.8.52): miter joins are used for these
// ST_ShapeType presets even when round is specified. Native reference
// controls confirm the same rule for an omitted join, with the default miter
// limit of eight.
// https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/562a55ee-ce0a-42b9-a8ef-9df10db1a07e
const miteredRoundPresets = new Set([
  "cube",
  "moon",
  "chevron",
  "ellipseRibbon",
  "ellipseRibbon2",
  "plus",
  "rightArrow",
  "stripedRightArrow",
  "notchedRightArrow",
  "leftArrowCallout",
  "leftRightArrowCallout",
  "upDownArrowCallout",
  "quadArrowCallout",
  "star4",
  "star5",
  "star8",
  "star10",
  "star12",
  "star16",
  "star24",
  "star32",
  "upArrow",
  "downArrow",
  "upDownArrow",
  "leftUpArrow",
  "bentUpArrow",
  "mathPlus",
  "mathMinus",
  "mathMultiply",
  "mathEqual",
  "mathNotEqual",
]);

/** Native painted join, including the default and MS-OI29500 preset rules.
 * Explicit bevel/miter choices (and their limits) inherit independently from
 * line fill/width. Raw local/effective-formatting readers stay unspecified when
 * the XML is unspecified; this read never materializes a default into it. */
export const getShapeStrokeJoinResolved = (
  shape: SlideShapeData,
): ShapeStrokeJoin => {
  let join: ShapeStrokeJoin | null = null;
  for (const line of shapeLineSources(shape)) {
    join = readStrokeJoin(line);
    if (join) break;
  }
  if (join && join.kind !== "round") return join;
  const geometry = effectiveGeometryElement(shape),
    preset =
      geometry?.name.localName === "prstGeom" ? value(geometry, "prst") : null;
  return preset && miteredRoundPresets.has(preset)
    ? { kind: "miter", limit: 8 }
    : { kind: "round" };
};
export const readStrokeEnd = (
  line: XmlElement,
  name: "headEnd" | "tailEnd",
): ArrowOptions | null => {
  const end = child(line, name);
  if (!end) return null;
  // CT_LineEndProperties defaults to no arrow, medium dimensions. An explicit
  // empty end blocks a more distant end rather than borrowing its type.
  const type = token(value(end, "type") ?? "none", [
    "none",
    "triangle",
    "stealth",
    "diamond",
    "oval",
    "arrow",
  ] as const);
  if (!type) return null;
  const width = token(value(end, "w"), ["sm", "med", "lg"] as const),
    length = token(value(end, "len"), ["sm", "med", "lg"] as const);
  return { type, ...(width ? { width } : {}), ...(length ? { length } : {}) };
};
export const readStrokeCap = (line: XmlElement): ShapeStrokeFormatting["cap"] =>
  token(value(line, "cap"), ["flat", "rnd", "sq"] as const);
export const readStrokeCompound = (
  line: XmlElement,
): ShapeStrokeFormatting["compound"] =>
  token(value(line, "cmpd"), [
    "sng",
    "dbl",
    "thickThin",
    "thinThick",
    "tri",
  ] as const);

/** Effective line decorations, independent of the outline's fill/width.
 * Property choices at the nearest source win as a whole, including solid
 * dashes and explicit no-arrow ends. Null means unspecified throughout the
 * cascade. Does not change authored XML or the local-property readers. */
export const getShapeStrokeFormattingEffective = (
  shape: SlideShapeData,
): ShapeStrokeFormatting => {
  const result: {
    -readonly [K in keyof ShapeStrokeFormatting]: ShapeStrokeFormatting[K];
  } = {
    cap: null,
    dash: null,
    join: null,
    compound: null,
    align: null,
    head: null,
    tail: null,
  };
  for (const line of shapeLineSources(shape)) {
    result.cap ??= readStrokeCap(line);
    result.dash ??= readStrokeDash(line);
    result.join ??= readStrokeJoin(line);
    result.compound ??= readStrokeCompound(line);
    result.align ??= token(value(line, "algn"), ["ctr", "in"] as const);
    result.head ??= readStrokeEnd(line, "headEnd");
    result.tail ??= readStrokeEnd(line, "tailEnd");
    if (Object.values(result).every((v) => v !== null)) break;
  }
  return result;
};
