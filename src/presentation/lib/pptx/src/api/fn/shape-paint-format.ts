// Paints the Format pane sets beyond solid colors: a gradient line, how a
// picture fills a shape (stretched with offsets, or tiled), picture
// corrections, color and artistic effects, recoloring, the slide-background
// fill, the aspect-ratio lock, and theme style-matrix references.

import {
  NS,
  type XmlElement,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  qname,
} from "../../internal/xml/index.ts";
import { buildColorElement } from "../../internal/drawingml/color.ts";
import {
  type GradientFillOptions,
  setGradientFill,
} from "../../internal/drawingml/fill.ts";
import {
  type PresentationData,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { commitAndRefresh, requireSpPr } from "./_helpers.ts";
import { parseGradFill } from "./shape-gradient-read.ts";
import { getPresentationTheme } from "./theme.ts";
import { getEffectiveColorMap } from "./color-map.ts";

const a = (name: string) => qname("a", name, NS.dml);
const A = (name: string) => qname("", name, "");
const a14 = (name: string) => qname("a14", name, NS.a14);

const dmlChild = (host: XmlElement | null, name: string) =>
  host ? firstChildElement(host, a(name)) : null;

const without = (host: XmlElement, names: readonly string[]) => {
  host.children = host.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        names.includes(c.name.localName)
      ),
  );
};

const intOf = (el: XmlElement | null, name: string, fallback = 0) => {
  if (!el) return fallback;
  const n = Number.parseInt(getAttrValue(el, A(name)) ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

// ---------------------------------------------------------------------------
// Gradient line

const LINE_FILLS = ["noFill", "solidFill", "gradFill", "pattFill"];

/** The gradient a shape's line is painted with, colors resolved. */
export const getShapeLineGradient = (
  pres: PresentationData,
  shape: SlideShapeData,
): GradientFillOptions | null => {
  const spPr = firstChildElement(
    shape[SHAPE_ELEMENT],
    qname("p", "spPr", NS.pml),
  );
  const grad = dmlChild(dmlChild(spPr, "ln"), "gradFill");
  if (!grad) return null;
  const slide = shape[SHAPE_SLIDE];
  return parseGradFill(grad, {
    get theme() {
      return getPresentationTheme(pres);
    },
    get clrMap() {
      return getEffectiveColorMap(slide);
    },
  });
};

/**
 * Paints the shape's line with a gradient (`null` returns it to a solid
 * line of the first stop's color). The width, dash, caps and arrows stay.
 */
export const setShapeLineGradient = (
  shape: SlideShapeData,
  gradient: GradientFillOptions | null,
): void => {
  const spPr = requireSpPr(shape);
  let ln = dmlChild(spPr, "ln");
  if (!ln) {
    ln = elem(a("ln"), { attrs: [attr(A("w"), "12700")] });
    const at = spPr.children.findIndex(
      (c) =>
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        ["effectLst", "effectDag", "scene3d", "sp3d", "extLst"].includes(
          c.name.localName,
        ),
    );
    spPr.children.splice(at < 0 ? spPr.children.length : at, 0, ln);
  }
  const previous = getShapeLineGradientRaw(ln);
  without(ln, LINE_FILLS);
  const holder = elem(a("x"));
  if (gradient) setGradientFill(holder, gradient);
  else
    holder.children.push(
      elem(a("solidFill"), {
        children: [buildColorElement(previous ?? "#000000")],
      }),
    );
  // The line's fill comes first among its children.
  ln.children.unshift(...holder.children);
  commitAndRefresh(shape);
};

const getShapeLineGradientRaw = (ln: XmlElement): string | null => {
  const grad = dmlChild(ln, "gradFill");
  const gs = dmlChild(dmlChild(grad, "gsLst"), "gs");
  const color = gs?.children.find((c): c is XmlElement => c.kind === "element");
  const val = color && getAttrValue(color, A("val"));
  if (!color || !val) return null;
  return color.name.localName === "srgbClr" ? `#${val}` : `scheme:${val}`;
};

// ---------------------------------------------------------------------------
// How a picture fills a shape

const blipFillOf = (shape: SlideShapeData): XmlElement | null => {
  if (shape[SHAPE_SNAPSHOT].kind === "picture")
    return firstChildElement(
      shape[SHAPE_ELEMENT],
      qname("p", "blipFill", NS.pml),
    );
  const spPr = firstChildElement(
    shape[SHAPE_ELEMENT],
    qname("p", "spPr", NS.pml),
  );
  return dmlChild(spPr, "blipFill");
};

/** Stretched with edge offsets (fractions of the shape; negative extends), or tiled. */
export type ImageFillMode =
  | {
      readonly mode: "stretch";
      readonly left: number;
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
    }
  | {
      readonly mode: "tile";
      /** Offsets in EMU. */
      readonly offsetX: number;
      readonly offsetY: number;
      /** Scale as a fraction (1 = the image's own size). */
      readonly scaleX: number;
      readonly scaleY: number;
      /** `tl`, `t`, `tr`, `l`, `ctr`, `r`, `bl`, `b`, `br`. */
      readonly align: string;
      /** `none`, `x`, `y`, `xy`. */
      readonly mirror: string;
    };

export const getShapeImageFillMode = (
  shape: SlideShapeData,
): ImageFillMode | null => {
  const fill = blipFillOf(shape);
  if (!fill) return null;
  const tile = dmlChild(fill, "tile");
  if (tile)
    return {
      mode: "tile",
      offsetX: intOf(tile, "tx"),
      offsetY: intOf(tile, "ty"),
      scaleX: intOf(tile, "sx", 100000) / 100000,
      scaleY: intOf(tile, "sy", 100000) / 100000,
      align: getAttrValue(tile, A("algn")) ?? "tl",
      mirror: getAttrValue(tile, A("flip")) ?? "none",
    };
  const rect = dmlChild(dmlChild(fill, "stretch"), "fillRect");
  return {
    mode: "stretch",
    left: intOf(rect, "l") / 100000,
    top: intOf(rect, "t") / 100000,
    right: intOf(rect, "r") / 100000,
    bottom: intOf(rect, "b") / 100000,
  };
};

/** Sets how the picture fills the shape. The shape must have a picture fill. */
export const setShapeImageFillMode = (
  shape: SlideShapeData,
  mode: ImageFillMode,
): void => {
  const fill = blipFillOf(shape);
  if (!fill) throw new Error("the shape has no picture fill");
  without(fill, ["tile", "stretch"]);
  const pct = (n: number) => String(Math.round(n * 100000));
  const next =
    mode.mode === "tile"
      ? elem(a("tile"), {
          attrs: [
            attr(A("tx"), String(Math.round(mode.offsetX))),
            attr(A("ty"), String(Math.round(mode.offsetY))),
            attr(A("sx"), pct(mode.scaleX)),
            attr(A("sy"), pct(mode.scaleY)),
            attr(A("flip"), mode.mirror),
            attr(A("algn"), mode.align),
          ],
        })
      : elem(a("stretch"), {
          children: [
            elem(a("fillRect"), {
              attrs: (
                [
                  ["l", mode.left],
                  ["t", mode.top],
                  ["r", mode.right],
                  ["b", mode.bottom],
                ] as const
              )
                .filter(([, v]) => v)
                .map(([k, v]) => attr(A(k), pct(v))),
            }),
          ],
        });
  // tile/stretch follow blip and srcRect.
  fill.children.push(next);
  commitAndRefresh(shape);
};

// ---------------------------------------------------------------------------
// Picture corrections, color and artistic effects

const IMG_PROPS_URI = "{BEBA8EAE-BF5A-486C-A8C5-ECC9F3942E4B}";

export const ARTISTIC_EFFECTS = [
  "artisticBlur",
  "artisticPencilGrayscale",
  "artisticPencilSketch",
  "artisticLineDrawing",
  "artisticPhotocopy",
  "artisticGlowEdges",
  "artisticFilmGrain",
  "artisticCutout",
  "artisticPaintStrokes",
  "artisticMarker",
  "artisticWatercolorSponge",
  "artisticPastelsSmooth",
] as const;

/** Picture adjustments stored as picture-layer effects. */
export interface PictureAdjustments {
  /** Saturation as a multiple (1 = unchanged, 0 = gray, 4 = vivid). */
  readonly saturation?: number | null;
  /** Color temperature in kelvin (6500 = unchanged), 1500..11500. */
  readonly temperature?: number | null;
  /** Sharpen (positive) or soften (negative), -1..1. */
  readonly sharpness?: number | null;
  /** One artistic effect, by element name, with its strength 0..1. */
  readonly artistic?: {
    readonly effect: (typeof ARTISTIC_EFFECTS)[number];
    readonly amount: number;
  } | null;
}

const pictureBlip = (shape: SlideShapeData): XmlElement | null =>
  dmlChild(blipFillOf(shape), "blip");

const imgLayerOf = (blip: XmlElement | null): XmlElement | null => {
  const extLst = dmlChild(blip, "extLst");
  for (const ext of extLst?.children ?? []) {
    if (ext.kind !== "element" || getAttrValue(ext, A("uri")) !== IMG_PROPS_URI)
      continue;
    const props = firstChildElement(ext, a14("imgProps"));
    return props && firstChildElement(props, a14("imgLayer"));
  }
  return null;
};

export const getShapePictureAdjustments = (
  shape: SlideShapeData,
): Required<PictureAdjustments> => {
  const out: {
    saturation: number | null;
    temperature: number | null;
    sharpness: number | null;
    artistic: NonNullable<PictureAdjustments["artistic"]> | null;
  } = { saturation: null, temperature: null, sharpness: null, artistic: null };
  const layer = imgLayerOf(pictureBlip(shape));
  for (const effect of layer?.children ?? []) {
    if (effect.kind !== "element" || effect.name.localName !== "imgEffect")
      continue;
    const inner = effect.children.find(
      (c): c is XmlElement => c.kind === "element",
    );
    if (!inner || inner.name.namespaceURI !== NS.a14) continue;
    const name = inner.name.localName;
    if (name === "saturation")
      out.saturation = intOf(inner, "sat", 100000) / 100000;
    else if (name === "colorTemperature")
      out.temperature = intOf(inner, "colorTemp", 6500);
    else if (name === "sharpenSoften")
      out.sharpness = intOf(inner, "amount") / 100000;
    else if ((ARTISTIC_EFFECTS as readonly string[]).includes(name)) {
      const attrName = inner.attrs[0]?.name.localName;
      const raw = attrName ? intOf(inner, attrName, 50) : 50;
      out.artistic = {
        effect: name as (typeof ARTISTIC_EFFECTS)[number],
        amount: ARTISTIC_SCALE[name]
          ? Math.max(0, Math.min(1, raw / ARTISTIC_SCALE[name]![1]))
          : 0.5,
      };
    }
  }
  return out;
};

// The attribute each artistic effect takes, and its range.
const ARTISTIC_SCALE: Record<string, [string, number]> = {
  artisticBlur: ["radius", 100],
  artisticPencilGrayscale: ["pencilSize", 100],
  artisticPencilSketch: ["pressure", 100],
  artisticLineDrawing: ["pencilSize", 100],
  artisticPhotocopy: ["detail", 10],
  artisticGlowEdges: ["width", 10],
  artisticFilmGrain: ["grainSize", 100],
  artisticCutout: ["numberOfShades", 6],
  artisticPaintStrokes: ["intensity", 10],
  artisticMarker: ["size", 100],
  artisticWatercolorSponge: ["brushSize", 10],
  artisticPastelsSmooth: ["scaling", 100],
};

/** Merges picture adjustments; `null` removes one. */
export const setShapePictureAdjustments = (
  shape: SlideShapeData,
  patch: PictureAdjustments,
): void => {
  const blip = pictureBlip(shape);
  if (!blip) throw new Error("the shape has no picture");
  const next = { ...getShapePictureAdjustments(shape), ...patch };
  let extLst = dmlChild(blip, "extLst");
  if (extLst)
    extLst.children = extLst.children.filter(
      (c) =>
        !(c.kind === "element" && getAttrValue(c, A("uri")) === IMG_PROPS_URI),
    );
  const effects: XmlElement[] = [];
  const effect = (child: XmlElement) =>
    effects.push(elem(a14("imgEffect"), { children: [child] }));
  if (next.artistic) {
    const [attrName, max] = ARTISTIC_SCALE[next.artistic.effect]!;
    effect(
      elem(a14(next.artistic.effect), {
        attrs: [
          attr(
            A(attrName),
            String(
              Math.round(Math.max(0, Math.min(1, next.artistic.amount)) * max),
            ),
          ),
        ],
      }),
    );
  }
  if (next.sharpness != null && next.sharpness !== 0)
    effect(
      elem(a14("sharpenSoften"), {
        attrs: [
          attr(
            A("amount"),
            String(
              Math.round(Math.max(-1, Math.min(1, next.sharpness)) * 100000),
            ),
          ),
        ],
      }),
    );
  if (next.temperature != null && next.temperature !== 6500)
    effect(
      elem(a14("colorTemperature"), {
        attrs: [
          attr(
            A("colorTemp"),
            String(
              Math.round(Math.max(1500, Math.min(11500, next.temperature))),
            ),
          ),
        ],
      }),
    );
  if (next.saturation != null && next.saturation !== 1)
    effect(
      elem(a14("saturation"), {
        attrs: [
          attr(
            A("sat"),
            String(
              Math.round(Math.max(0, Math.min(4, next.saturation)) * 100000),
            ),
          ),
        ],
      }),
    );
  if (effects.length) {
    if (!extLst) {
      extLst = elem(a("extLst"));
      blip.children.push(extLst);
    }
    const props = elem(a14("imgProps"), {
      children: [elem(a14("imgLayer"), { children: effects })],
    });
    props.prefixDecls.set("a14", NS.a14);
    extLst.children.unshift(
      elem(a("ext"), {
        attrs: [attr(A("uri"), IMG_PROPS_URI)],
        children: [props],
      }),
    );
  } else if (extLst && !extLst.children.length) without(blip, ["extLst"]);
  commitAndRefresh(shape);
};

/** A picture's recoloring, in the blip's own color effects. */
export type PictureRecolor =
  | { readonly kind: "none" }
  | { readonly kind: "grayscale" }
  | { readonly kind: "blackWhite"; readonly threshold: number }
  | { readonly kind: "washout" }
  | {
      readonly kind: "duotone";
      readonly dark: string;
      readonly light: string;
    };

const RECOLOR_ELEMENTS = ["grayscl", "biLevel", "duotone"];

export const getShapePictureRecolor = (
  shape: SlideShapeData,
): PictureRecolor => {
  const blip = pictureBlip(shape);
  if (!blip) return { kind: "none" };
  if (dmlChild(blip, "grayscl")) return { kind: "grayscale" };
  const bi = dmlChild(blip, "biLevel");
  if (bi)
    return {
      kind: "blackWhite",
      threshold: intOf(bi, "thresh", 50000) / 100000,
    };
  const duo = dmlChild(blip, "duotone");
  if (duo) {
    const colors = duo.children.filter(
      (c): c is XmlElement => c.kind === "element",
    );
    const read = (c: XmlElement | undefined) => {
      const v = c && getAttrValue(c, A("val"));
      if (!c || !v) return "#000000";
      return c.name.localName === "srgbClr" ? `#${v}` : `scheme:${v}`;
    };
    return { kind: "duotone", dark: read(colors[0]), light: read(colors[1]) };
  }
  const lum = dmlChild(blip, "lum");
  if (
    lum &&
    intOf(lum, "bright") === 70000 &&
    intOf(lum, "contrast") === -70000
  )
    return { kind: "washout" };
  return { kind: "none" };
};

/** Recolors a picture. Washout uses brightness and contrast. */
export const setShapePictureRecolor = (
  shape: SlideShapeData,
  recolor: PictureRecolor,
): void => {
  const blip = pictureBlip(shape);
  if (!blip) throw new Error("the shape has no picture");
  const wasWashout = getShapePictureRecolor(shape).kind === "washout";
  without(blip, RECOLOR_ELEMENTS);
  if (wasWashout || recolor.kind === "washout") without(blip, ["lum"]);
  // Color effects sit before the blip's extension list.
  const at = blip.children.findIndex(
    (c) =>
      c.kind === "element" &&
      c.name.namespaceURI === NS.dml &&
      c.name.localName === "extLst",
  );
  const insert = (el: XmlElement) =>
    blip.children.splice(at < 0 ? blip.children.length : at, 0, el);
  if (recolor.kind === "grayscale") insert(elem(a("grayscl")));
  else if (recolor.kind === "blackWhite")
    insert(
      elem(a("biLevel"), {
        attrs: [
          attr(
            A("thresh"),
            String(
              Math.round(Math.max(0, Math.min(1, recolor.threshold)) * 100000),
            ),
          ),
        ],
      }),
    );
  else if (recolor.kind === "washout")
    insert(
      elem(a("lum"), {
        attrs: [attr(A("bright"), "70000"), attr(A("contrast"), "-70000")],
      }),
    );
  else if (recolor.kind === "duotone")
    insert(
      elem(a("duotone"), {
        children: [
          buildColorElement(recolor.dark),
          buildColorElement(recolor.light),
        ],
      }),
    );
  commitAndRefresh(shape);
};

// ---------------------------------------------------------------------------
// Slide background fill and the aspect-ratio lock

/** Whether the shape is filled with the slide's background (`useBgFill`). */
export const getShapeBackgroundFill = (shape: SlideShapeData): boolean =>
  shape[SHAPE_SNAPSHOT].kind === "shape" &&
  ["1", "true"].includes(
    getAttrValue(shape[SHAPE_ELEMENT], A("useBgFill")) ?? "",
  );

/**
 * Fills the shape with the slide's background, as if it were a window onto
 * it that hides what lies beneath. Turning it on removes the shape's own fill.
 */
export const setShapeBackgroundFill = (
  shape: SlideShapeData,
  on: boolean,
): void => {
  if (shape[SHAPE_SNAPSHOT].kind !== "shape")
    throw new Error("only shapes take the slide background as their fill");
  const el = shape[SHAPE_ELEMENT];
  el.attrs = el.attrs.filter(
    (x) => !(x.name.namespaceURI === "" && x.name.localName === "useBgFill"),
  );
  if (on) {
    el.attrs.push(attr(A("useBgFill"), "1"));
    without(requireSpPr(shape), [
      "noFill",
      "solidFill",
      "gradFill",
      "blipFill",
      "pattFill",
      "grpFill",
    ]);
  }
  commitAndRefresh(shape);
};

const locksOf = (shape: SlideShapeData, create: boolean): XmlElement | null => {
  const kind = shape[SHAPE_SNAPSHOT].kind;
  const holderName =
    kind === "picture"
      ? "cNvPicPr"
      : kind === "connector"
        ? "cNvCxnSpPr"
        : kind === "group"
          ? "cNvGrpSpPr"
          : kind === "graphicFrame"
            ? "cNvGraphicFramePr"
            : "cNvSpPr";
  const locksName =
    kind === "picture"
      ? "picLocks"
      : kind === "connector"
        ? "cxnSpLocks"
        : kind === "group"
          ? "grpSpLocks"
          : kind === "graphicFrame"
            ? "graphicFrameLocks"
            : "spLocks";
  const nv = shape[SHAPE_ELEMENT].children.find(
    (c): c is XmlElement =>
      c.kind === "element" &&
      c.name.namespaceURI === NS.pml &&
      c.name.localName.startsWith("nv"),
  );
  if (!nv) return null;
  let holder = firstChildElement(nv, qname("p", holderName, NS.pml));
  if (!holder) {
    if (!create) return null;
    holder = elem(qname("p", holderName, NS.pml));
    // The holder follows cNvPr.
    nv.children.splice(1, 0, holder);
  }
  let locks = firstChildElement(holder, a(locksName));
  if (!locks && create) {
    locks = elem(a(locksName));
    holder.children.unshift(locks);
  }
  return locks;
};

/** Whether resizing keeps the object's proportions (`noChangeAspect`). */
export const getShapeAspectLock = (shape: SlideShapeData): boolean => {
  const locks = locksOf(shape, false);
  return (
    !!locks &&
    ["1", "true"].includes(getAttrValue(locks, A("noChangeAspect")) ?? "")
  );
};

export const setShapeAspectLock = (
  shape: SlideShapeData,
  on: boolean,
): void => {
  const locks = locksOf(shape, true);
  if (!locks) throw new Error("the object has no non-visual properties");
  locks.attrs = locks.attrs.filter(
    (x) =>
      !(x.name.namespaceURI === "" && x.name.localName === "noChangeAspect"),
  );
  if (on) locks.attrs.push(attr(A("noChangeAspect"), "1"));
  commitAndRefresh(shape);
};

// ---------------------------------------------------------------------------
// Theme style references

/** One reference into the theme's style matrix, with the color it takes. */
export interface StyleMatrixRef {
  /** 0 = none; 1..3 subtle → intense (fills 1001.. use the background list). */
  readonly idx: number;
  /** `#RRGGBB` or a scheme reference such as `scheme:accent2/lumMod=75000`. */
  readonly color: string;
}

/**
 * Styles a shape from the theme's style matrix (`<p:style>`): its fill,
 * line and effects follow the theme's subtle-to-intense entries in the
 * given colors, and its text takes `fontColor` in the theme's minor font.
 * The shape's own fill, line and effects are removed so the style shows.
 */
export const setShapeStyleMatrix = (
  shape: SlideShapeData,
  refs: {
    readonly fill: StyleMatrixRef;
    readonly line: StyleMatrixRef;
    readonly effect: StyleMatrixRef;
    readonly fontColor: string;
  },
): void => {
  if (shape[SHAPE_SNAPSHOT].kind !== "shape")
    throw new Error("only shapes take a theme style");
  const spPr = requireSpPr(shape);
  without(spPr, [
    "noFill",
    "solidFill",
    "gradFill",
    "blipFill",
    "pattFill",
    "grpFill",
    "ln",
    "effectLst",
    "effectDag",
  ]);
  const el = shape[SHAPE_ELEMENT];
  el.attrs = el.attrs.filter(
    (x) => !(x.name.namespaceURI === "" && x.name.localName === "useBgFill"),
  );
  el.children = el.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.pml &&
        c.name.localName === "style"
      ),
  );
  const ref = (name: string, r: StyleMatrixRef) =>
    elem(a(name), {
      attrs: [attr(A("idx"), String(Math.max(0, Math.round(r.idx))))],
      children: [buildColorElement(r.color)],
    });
  const style = elem(qname("p", "style", NS.pml), {
    children: [
      ref("lnRef", refs.line),
      ref("fillRef", refs.fill),
      ref("effectRef", refs.effect),
      elem(a("fontRef"), {
        attrs: [attr(A("idx"), "minor")],
        children: [buildColorElement(refs.fontColor)],
      }),
    ],
  });
  // p:style follows spPr and precedes txBody.
  const at = el.children.findIndex(
    (c) =>
      c.kind === "element" &&
      c.name.namespaceURI === NS.pml &&
      c.name.localName === "spPr",
  );
  el.children.splice(at + 1, 0, style);
  commitAndRefresh(shape);
};
