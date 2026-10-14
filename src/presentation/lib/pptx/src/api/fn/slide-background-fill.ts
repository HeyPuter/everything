// Slide backgrounds beyond a solid color: gradients, patterns, and pictures
// stretched or tiled as a texture, with their transparency. These work on
// slides and on the editing views of layouts and masters alike.

import {
  type GradientFillOptions,
  type PatternFillOptions,
  setGradientFill,
  setPatternFill,
} from "../../internal/drawingml/index.ts";
import { partName, resolveTarget } from "../../internal/opc/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import { readOnlyPartRoot } from "../../internal/parts/read-only-xml.ts";
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
  INTERNAL_PACKAGE,
  LAYOUT_PART,
  LAYOUT_PART_NAME,
  type PresentationData,
  SLIDE_DOCUMENT,
  type SlideData,
  type SlideLayoutData,
} from "../_internal-symbols.ts";
import { NAME_CSLD, commitSlideData, refreshSlideData } from "./_helpers.ts";
import { setSlideBackgroundImage } from "./slide-background.ts";

const pq = (local: string) => qname("p", local, NS.pml);
const aq = (local: string) => qname("a", local, NS.dml);
const plain = (local: string) => qname("", local, "");

const writeBackground = (
  slide: SlideData,
  configure: (bgPr: XmlElement) => void,
): void => {
  const cSld = firstChildElement(slide[SLIDE_DOCUMENT].root, NAME_CSLD);
  if (!cSld) throw new Error("slide has no <p:cSld>");
  cSld.children = cSld.children.filter(
    (c) => !(c.kind === "element" && c.name.localName === "bg"),
  );
  const bgPr = elem(pq("bgPr"));
  configure(bgPr);
  // CT_BackgroundProperties: a fill, then the (here empty) effect list.
  bgPr.children.push(elem(aq("effectLst")));
  cSld.children.unshift(elem(pq("bg"), { children: [bgPr] }));
  commitSlideData(slide);
  refreshSlideData(slide);
};

/**
 * Sets a gradient background (linear at `angleDeg`, or `path` circle /
 * rect / shape). Stop colors take `#RRGGBB` or theme colors (`scheme:accent1`,
 * with tints and shades such as `scheme:accent1/lumMod=75000`).
 */
export const setSlideBackgroundGradient = (
  slide: SlideData,
  options: GradientFillOptions,
): void => writeBackground(slide, (bgPr) => setGradientFill(bgPr, options));

/** Sets a preset pattern background (`pct20`, `dkUpDiag`, `wave`, …). */
export const setSlideBackgroundPattern = (
  slide: SlideData,
  options: PatternFillOptions,
): void => writeBackground(slide, (bgPr) => setPatternFill(bgPr, options));

/** How a picture background is laid out and how see-through it is. */
export interface SlideBackgroundPictureOptions {
  /**
   * Tile the picture as a texture. Offsets are in EMU, scales are fractions
   * (1 = the picture's own size), `align` is where tiling starts.
   */
  readonly tile?: {
    readonly offsetX?: number;
    readonly offsetY?: number;
    readonly scaleX?: number;
    readonly scaleY?: number;
    readonly align?: "tl" | "t" | "tr" | "l" | "ctr" | "r" | "bl" | "b" | "br";
    readonly flip?: "none" | "x" | "y" | "xy";
  } | null;
  /**
   * Stretch the picture over the slide, each edge inset by a fraction of the
   * slide (negative values reach past it). Used when `tile` is not given.
   */
  readonly stretch?: {
    readonly left?: number;
    readonly top?: number;
    readonly right?: number;
    readonly bottom?: number;
  };
  /** 0 (opaque) to 1 (invisible). */
  readonly transparency?: number;
}

const pct = (v: number | undefined) => String(Math.round((v ?? 0) * 100000));

const writePictureOptions = (
  blipFill: XmlElement,
  options: SlideBackgroundPictureOptions,
): void => {
  const blip = firstChildElement(blipFill, aq("blip"));
  if (blip && options.transparency !== undefined) {
    blip.children = blip.children.filter(
      (c) => !(c.kind === "element" && c.name.localName === "alphaModFix"),
    );
    const t = Math.min(1, Math.max(0, options.transparency));
    if (t > 0)
      blip.children.unshift(
        elem(aq("alphaModFix"), {
          attrs: [attr(plain("amt"), String(Math.round((1 - t) * 100000)))],
        }),
      );
  }
  if (options.tile === undefined && options.stretch === undefined) return;
  blipFill.children = blipFill.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        (c.name.localName === "tile" || c.name.localName === "stretch")
      ),
  );
  if (options.tile) {
    const t = options.tile;
    blipFill.children.push(
      elem(aq("tile"), {
        attrs: [
          attr(plain("tx"), String(Math.round(t.offsetX ?? 0))),
          attr(plain("ty"), String(Math.round(t.offsetY ?? 0))),
          attr(plain("sx"), pct(t.scaleX ?? 1)),
          attr(plain("sy"), pct(t.scaleY ?? 1)),
          attr(plain("flip"), t.flip ?? "none"),
          attr(plain("algn"), t.align ?? "tl"),
        ],
      }),
    );
  } else {
    const s = options.stretch ?? {};
    const attrs = (
      [
        ["l", s.left],
        ["t", s.top],
        ["r", s.right],
        ["b", s.bottom],
      ] as const
    )
      .filter(([, v]) => v)
      .map(([k, v]) => attr(plain(k), pct(v)));
    blipFill.children.push(
      elem(aq("stretch"), { children: [elem(aq("fillRect"), { attrs })] }),
    );
  }
};

const backgroundBlipFill = (root: XmlElement): XmlElement | null => {
  const cSld = firstChildElement(root, NAME_CSLD);
  const bg = cSld && firstChildElement(cSld, pq("bg"));
  const bgPr = bg && firstChildElement(bg, pq("bgPr"));
  return (bgPr && firstChildElement(bgPr, aq("blipFill"))) ?? null;
};

/**
 * Sets a picture background, stretched (the default) or tiled as a texture,
 * with the given transparency.
 */
export const setSlideBackgroundPicture = (
  slide: SlideData,
  bytes: Uint8Array,
  options: SlideBackgroundPictureOptions = {},
): void => {
  setSlideBackgroundImage(slide, bytes);
  const fill = backgroundBlipFill(slide[SLIDE_DOCUMENT].root);
  if (!fill) return;
  const cSld = firstChildElement(slide[SLIDE_DOCUMENT].root, NAME_CSLD)!;
  const bgPr = firstChildElement(
    firstChildElement(cSld, pq("bg"))!,
    pq("bgPr"),
  )!;
  if (!firstChildElement(bgPr, aq("effectLst")))
    bgPr.children.push(elem(aq("effectLst")));
  writePictureOptions(fill, {
    stretch: {},
    ...options,
  });
  commitSlideData(slide);
  refreshSlideData(slide);
};

/**
 * Changes how the current picture background is laid out or how see-through
 * it is, keeping the picture. Does nothing when the background is not a
 * picture.
 */
export const setSlideBackgroundPictureOptions = (
  slide: SlideData,
  options: SlideBackgroundPictureOptions,
): boolean => {
  const fill = backgroundBlipFill(slide[SLIDE_DOCUMENT].root);
  if (!fill) return false;
  writePictureOptions(fill, options);
  commitSlideData(slide);
  refreshSlideData(slide);
  return true;
};

/** The layout and transparency of a picture background, as read. */
export interface SlideBackgroundPictureFill {
  readonly tile: {
    readonly offsetX: number;
    readonly offsetY: number;
    readonly scaleX: number;
    readonly scaleY: number;
    readonly align: string;
    readonly flip: string;
  } | null;
  readonly stretch: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  readonly transparency: number;
}

const num = (el: XmlElement | null, name: string, fallback: number): number => {
  const v = el ? getAttrValue(el, plain(name)) : null;
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const readPictureFill = (
  root: XmlElement,
): SlideBackgroundPictureFill | null => {
  const fill = backgroundBlipFill(root);
  if (!fill) return null;
  const blip = firstChildElement(fill, aq("blip"));
  const alpha = blip && firstChildElement(blip, aq("alphaModFix"));
  const tile = firstChildElement(fill, aq("tile"));
  const stretch = firstChildElement(fill, aq("stretch"));
  const rect = stretch && firstChildElement(stretch, aq("fillRect"));
  return {
    tile: tile
      ? {
          offsetX: num(tile, "tx", 0),
          offsetY: num(tile, "ty", 0),
          scaleX: num(tile, "sx", 100000) / 100000,
          scaleY: num(tile, "sy", 100000) / 100000,
          align: getAttrValue(tile, plain("algn")) ?? "tl",
          flip: getAttrValue(tile, plain("flip")) ?? "none",
        }
      : null,
    stretch: {
      left: num(rect, "l", 0) / 100000,
      top: num(rect, "t", 0) / 100000,
      right: num(rect, "r", 0) / 100000,
      bottom: num(rect, "b", 0) / 100000,
    },
    transparency: alpha ? 1 - num(alpha, "amt", 100000) / 100000 : 0,
  };
};

/** How the slide's own picture background is laid out, or `null`. */
export const getSlideBackgroundPictureFill = (
  slide: SlideData,
): SlideBackgroundPictureFill | null =>
  readPictureFill(slide[SLIDE_DOCUMENT].root);

/** How the layout's picture background is laid out, or `null`. */
export const getSlideLayoutBackgroundPictureFill = (
  layout: SlideLayoutData,
): SlideBackgroundPictureFill | null =>
  readPictureFill(layout[LAYOUT_PART].root);

/** How the picture background of the layout's master is laid out, or `null`. */
export const getSlideMasterBackgroundPictureFill = (
  pres: PresentationData,
  layout: SlideLayoutData,
): SlideBackgroundPictureFill | null => {
  const pkg = pres[INTERNAL_PACKAGE];
  const layoutName = partName(layout[LAYOUT_PART_NAME]);
  const rel = pkg
    .getRels(layoutName)
    ?.items.find((r) => r.type === REL_TYPES.slideMaster);
  const master = rel && pkg.getPart(resolveTarget(layoutName, rel.target));
  return master ? readPictureFill(readOnlyPartRoot(master)) : null;
};
