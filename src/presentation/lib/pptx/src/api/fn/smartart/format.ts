// Formatting given to single shapes of an authored SmartArt graphic (the
// SmartArt Format tab): a different geometry, a size step, fill (a color or
// a picture), outline, effects, and the text's WordArt fill, outline and
// effects. It is kept on presentation points of the data model
// (`dgm:pt type="pres"` with `presAssocID` naming the data point and
// `presName` naming the shape) and on the data point's text runs, so it
// survives every re-layout, and is drawn into the saved drawing.
import {
  NS,
  type XmlElement,
  firstChildElement,
  getAttrValue,
  qname,
} from "../../../internal/xml/index.ts";
import type { ShapeEffectSpec } from "../shape-effect-format.ts";
import { xmlAttr } from "./xml.ts";

/** One shape's own formatting. Absent fields follow the graphic's style. */
export interface SmartArtShapeFormat {
  /** A preset geometry in place of the layout's. */
  readonly geom?: string;
  /** Size relative to the layout's, around its centre (Larger / Smaller). */
  readonly scale?: number;
  /** A color ("#RRGGBB" or "scheme:accent1/lumMod=75000") or "none". */
  readonly fill?: string;
  /** A picture filling the shape: the media part in the package. */
  readonly picture?: string;
  /** Outline color, or "none". */
  readonly line?: string;
  /** Outline width in EMU. */
  readonly lineWidth?: number;
  readonly effects?: ShapeEffectSpec;
}

/** WordArt-style formatting of an item's text. */
export interface SmartArtTextStyle {
  readonly fill?: string;
  readonly outline?: string;
  readonly outlineWidth?: number;
  readonly effects?: ShapeEffectSpec;
}

const A = (name: string) => qname("", name, "");
const a = (name: string) => qname("a", name, NS.dml);
const kids = (el: XmlElement | null | undefined) =>
  el ? el.children.filter((c): c is XmlElement => c.kind === "element") : [];
const dml = (el: XmlElement, local: string) =>
  el.name.namespaceURI === NS.dml && el.name.localName === local;

// A format being read: fields may be left undefined until cleaned.
type Building<T> = { -readonly [K in keyof T]?: T[K] | undefined };

const isEmpty = (o: object | undefined | null) =>
  !o || Object.values(o).every((v) => v === undefined);

/** Drops empty formats so models compare and serialize cleanly. */
export const cleanFormat = <T extends object>(
  f: T | undefined,
): T | undefined =>
  f && !isEmpty(f)
    ? (Object.fromEntries(
        Object.entries(f).filter(([, v]) => v !== undefined),
      ) as T)
    : undefined;

// ---------------------------------------------------------------- Colors

/** `<a:srgbClr>` / `<a:schemeClr>` for "#RRGGBB[/mod=val…]" or
 *  "scheme:token[/mod=val…]". */
export const colorStringXml = (value: string, alpha?: number): string => {
  const [head = "", ...mods] = value.split("/");
  const scheme = head.startsWith("scheme:");
  const val = scheme
    ? head.slice(7)
    : head.replace(/^#/, "").toUpperCase().padStart(6, "0").slice(0, 6);
  const children = mods
    .map((m) => m.split("="))
    .filter(([name, v]) => /^[a-zA-Z]+$/.test(name ?? "") && v !== undefined)
    .map(([name, v]) => `<a:${name} val="${xmlAttr(v!)}"/>`);
  if (alpha !== undefined && alpha < 1)
    children.push(
      `<a:alpha val="${Math.round(Math.max(0, alpha) * 100000)}"/>`,
    );
  const tag = scheme ? "schemeClr" : "srgbClr";
  return `<a:${tag} val="${xmlAttr(val)}"${children.length ? `>${children.join("")}</a:${tag}>` : "/>"}`;
};

/** The color string of a color element and its opacity (alpha). */
const readColor = (
  parent: XmlElement | null,
): { color: string; opacity: number } | null => {
  const el = kids(parent).find((c) => dml(c, "srgbClr") || dml(c, "schemeClr"));
  if (!el) return null;
  const val = getAttrValue(el, A("val")) ?? "";
  let opacity = 1;
  const mods: string[] = [];
  for (const m of kids(el)) {
    const v = getAttrValue(m, A("val")) ?? "";
    if (m.name.localName === "alpha") opacity = Number(v) / 100000;
    else mods.push(`${m.name.localName}=${v}`);
  }
  const head = dml(el, "srgbClr") ? `#${val.toUpperCase()}` : `scheme:${val}`;
  return { color: [head, ...mods].join("/"), opacity };
};

// ---------------------------------------------------------------- Effects

const emu = (n: number) => Math.max(0, Math.round(n));
const dir = (deg: number) =>
  Math.round((((deg % 360) + 360) % 360) * 60000) % 21600000;

/** `<a:effectLst>` for effects (in schema order), or "" when none. */
export const effectsXml = (spec: ShapeEffectSpec | undefined): string => {
  if (!spec) return "";
  const out: string[] = [];
  if (spec.glow)
    out.push(
      `<a:glow rad="${emu(spec.glow.radiusEmu)}">${colorStringXml(spec.glow.color, spec.glow.opacity)}</a:glow>`,
    );
  const s = spec.shadow;
  if (s?.type === "inner")
    out.push(
      `<a:innerShdw blurRad="${emu(s.blurEmu)}" dist="${emu(s.distEmu)}" dir="${dir(s.angleDeg)}">${colorStringXml(s.color, s.opacity)}</a:innerShdw>`,
    );
  else if (s) {
    const scaled = s.scale !== undefined && s.scale !== 1;
    const sc = scaled
      ? ` sx="${Math.round(s.scale! * 100000)}" sy="${Math.round(s.scale! * 100000)}"`
      : "";
    out.push(
      `<a:outerShdw blurRad="${emu(s.blurEmu)}" dist="${emu(s.distEmu)}" dir="${dir(s.angleDeg)}"${sc} algn="${scaled ? "ctr" : "tl"}" rotWithShape="0">${colorStringXml(s.color, s.opacity)}</a:outerShdw>`,
    );
  }
  const r = spec.reflection;
  if (r)
    out.push(
      `<a:reflection blurRad="${emu(r.blurEmu)}" stA="${Math.round(r.startOpacity * 100000)}" stPos="0" endA="300" endPos="${Math.round(r.endPos * 100000)}" dist="${emu(r.distEmu)}" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/>`,
    );
  if (spec.softEdge)
    out.push(`<a:softEdge rad="${emu(spec.softEdge.radiusEmu)}"/>`);
  return out.length ? `<a:effectLst>${out.join("")}</a:effectLst>` : "";
};

const num = (el: XmlElement, name: string, fallback = 0) => {
  const v = Number(getAttrValue(el, A(name)));
  return Number.isFinite(v) ? v : fallback;
};

/** The effects an `<a:effectLst>` holds, in the Format tab's terms. */
export const readEffects = (list: XmlElement | null): ShapeEffectSpec => {
  const out: {
    -readonly [K in keyof ShapeEffectSpec]: ShapeEffectSpec[K];
  } = {};
  for (const e of kids(list)) {
    const c = readColor(e) ?? { color: "#000000", opacity: 1 };
    if (dml(e, "glow")) out.glow = { ...c, radiusEmu: num(e, "rad") };
    else if (dml(e, "outerShdw") || dml(e, "innerShdw")) {
      const sx = num(e, "sx", 100000);
      out.shadow = {
        type: dml(e, "outerShdw") ? "outer" : "inner",
        ...c,
        blurEmu: num(e, "blurRad"),
        distEmu: num(e, "dist"),
        angleDeg: num(e, "dir") / 60000,
        ...(sx !== 100000 ? { scale: sx / 100000 } : {}),
      };
    } else if (dml(e, "reflection"))
      out.reflection = {
        startOpacity: num(e, "stA", 100000) / 100000,
        endPos: num(e, "endPos", 100000) / 100000,
        distEmu: num(e, "dist"),
        blurEmu: num(e, "blurRad"),
      };
    else if (dml(e, "softEdge")) out.softEdge = { radiusEmu: num(e, "rad") };
  }
  return out;
};

// ---------------------------------------------------------------- Shapes

/**
 * The fill of a picture: stretched over the shape, cropped to cover it
 * when the picture's size is known (`crop` as fractions per side).
 */
export const pictureFillXml = (
  relId: string,
  crop: { l: number; t: number; r: number; b: number } | null,
): string => {
  const pct = (v: number) => Math.round(v * 100000);
  const rect = crop
    ? `<a:srcRect l="${pct(crop.l)}" t="${pct(crop.t)}" r="${pct(crop.r)}" b="${pct(crop.b)}"/>`
    : "<a:srcRect/>";
  return `<a:blipFill rotWithShape="1"><a:blip xmlns:r="${NS.officeDocRels}" r:embed="${xmlAttr(relId)}"/>${rect}<a:stretch><a:fillRect/></a:stretch></a:blipFill>`;
};

/** The parts of `<dgm:spPr>` a format sets: geometry, fill, line, effects. */
export const formatSpPrXml = (
  f: SmartArtShapeFormat,
  pictureRel: (part: string) => string | null,
): string => {
  const geom = f.geom
    ? `<a:prstGeom prst="${xmlAttr(f.geom)}"><a:avLst/></a:prstGeom>`
    : "";
  const rel = f.picture ? pictureRel(f.picture) : null;
  const fill = rel
    ? pictureFillXml(rel, null)
    : f.fill === "none"
      ? "<a:noFill/>"
      : f.fill
        ? `<a:solidFill>${colorStringXml(f.fill)}</a:solidFill>`
        : "";
  const line =
    f.line === "none"
      ? "<a:ln><a:noFill/></a:ln>"
      : f.line || f.lineWidth
        ? `<a:ln${f.lineWidth ? ` w="${emu(f.lineWidth)}"` : ""}>${f.line ? `<a:solidFill>${colorStringXml(f.line)}</a:solidFill>` : ""}</a:ln>`
        : "";
  return geom + fill + line + effectsXml(f.effects);
};

/** Reads a presentation point's `<dgm:spPr>` and `<dgm:prSet>`. */
export const readShapeFormat = (
  spPr: XmlElement | null,
  prSet: XmlElement | null,
  pictureOf: (relId: string) => string | null,
): SmartArtShapeFormat | undefined => {
  const out: Building<SmartArtShapeFormat> = {};
  for (const c of kids(spPr)) {
    if (dml(c, "prstGeom")) out.geom = getAttrValue(c, A("prst")) ?? undefined;
    else if (dml(c, "noFill")) out.fill = "none";
    else if (dml(c, "solidFill")) out.fill = readColor(c)?.color;
    else if (dml(c, "blipFill")) {
      const blip = firstChildElement(c, a("blip"));
      const id =
        blip && getAttrValue(blip, qname("r", "embed", NS.officeDocRels));
      const part = id ? pictureOf(id) : null;
      if (part) out.picture = part;
    } else if (dml(c, "ln")) {
      if (firstChildElement(c, a("noFill"))) out.line = "none";
      else {
        const solid = firstChildElement(c, a("solidFill"));
        if (solid) out.line = readColor(solid)?.color;
      }
      const w = getAttrValue(c, A("w"));
      if (w !== null && Number(w) > 0) out.lineWidth = Number(w);
    } else if (dml(c, "effectLst")) {
      const fx = readEffects(c);
      if (!isEmpty(fx)) out.effects = fx;
    }
  }
  const scale = prSet
    ? Number(getAttrValue(prSet, A("custScaleX")) ?? NaN)
    : NaN;
  if (Number.isFinite(scale) && scale > 0 && scale !== 100000)
    out.scale = Math.round(scale / 1000) / 100;
  return cleanFormat(out as SmartArtShapeFormat);
};

// ---------------------------------------------------------------- Text

/** Children of `<a:rPr>` for a text style: line, fill, effects. */
export const textStyleRunXml = (style: SmartArtTextStyle | undefined) => {
  if (!style) return { line: "", fill: "", effects: "" };
  const line =
    style.outline === "none"
      ? "<a:ln><a:noFill/></a:ln>"
      : style.outline
        ? `<a:ln${style.outlineWidth ? ` w="${emu(style.outlineWidth)}"` : ""}><a:solidFill>${colorStringXml(style.outline)}</a:solidFill></a:ln>`
        : "";
  const fill =
    style.fill === "none"
      ? "<a:noFill/>"
      : style.fill
        ? `<a:solidFill>${colorStringXml(style.fill)}</a:solidFill>`
        : "";
  return { line, fill, effects: effectsXml(style.effects) };
};

/** The text style of a data point: its first run's properties. */
export const readTextStyle = (
  text: XmlElement | null,
): SmartArtTextStyle | undefined => {
  let rPr: XmlElement | null = null;
  for (const p of kids(text))
    if (dml(p, "p"))
      for (const r of kids(p))
        if (!rPr && dml(r, "r")) rPr = firstChildElement(r, a("rPr")) ?? null;
  if (!rPr) return undefined;
  const out: Building<SmartArtTextStyle> = {};
  for (const c of kids(rPr)) {
    if (dml(c, "solidFill")) out.fill = readColor(c)?.color;
    else if (dml(c, "noFill")) out.fill = "none";
    else if (dml(c, "ln")) {
      const solid = firstChildElement(c, a("solidFill"));
      if (firstChildElement(c, a("noFill"))) out.outline = "none";
      else if (solid) out.outline = readColor(solid)?.color;
      const w = getAttrValue(c, A("w"));
      if (w !== null && Number(w) > 0) out.outlineWidth = Number(w);
    } else if (dml(c, "effectLst")) {
      const fx = readEffects(c);
      if (!isEmpty(fx)) out.effects = fx;
    }
  }
  return cleanFormat(out as SmartArtTextStyle);
};
