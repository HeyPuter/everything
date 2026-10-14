import { type PatternFillData, readPatternFill } from "./pattern-fill-read.ts";
import { parseGradFill } from "./shape-gradient-read.ts";
import { resolveBlipImage } from "./blip-image.ts";
import {
  readOnlyPartRoot,
  copyPartDocument,
} from "../../internal/parts/read-only-xml.ts";
// Slide-level background.

import {
  type GradientFillOptions,
  readFlip,
  readPosition,
  readRotation,
  readSize,
  setSolidFill,
} from "../../internal/drawingml/index.ts";
import type { Emu } from "../units.ts";
import {
  type ImageFormat,
  contentTypeForFormat,
  detectImageFormat,
  emptyRels,
  extensionForFormat,
  nextRelId,
  partName,
  resolveTarget,
} from "../../internal/opc/index.ts";
import {
  REL_TYPES,
  readShapeTreeFromCsldRoot,
} from "../../internal/presentationml/index.ts";
import type { OpcPackage } from "../../internal/parts/index.ts";
import type { PartName } from "../../internal/opc/index.ts";
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
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  SLIDE_DOCUMENT,
  SLIDE_PART,
  SLIDE_PART_NAME,
  SLIDE_SHAPES,
  type SlideData,
  type SlideLayoutData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import {
  NAME_CSLD,
  commitSlideData,
  refreshSlideData,
  setOpcDefault,
} from "./_helpers.ts";
import { getPresentationTheme, type PresentationTheme } from "./theme.ts";
import { themeForPart, themeForSlide } from "./shape-theme.ts";
import { resolveDrawingOpacity } from "./shape-color.ts";
import {
  NAME_A_GRAD_FILL,
  type ShapeBounds,
  resolveDrawingColor,
} from "./shapes.ts";

import {
  getEffectiveColorMap,
  getLayoutColorMap,
  getMasterColorMap,
} from "./color-map.ts";

const setSlideBackgroundXml = (
  slide: SlideData,
  configure: (bgPr: XmlElement) => void,
): void => {
  const cSld = firstChildElement(slide[SLIDE_DOCUMENT].root, NAME_CSLD);
  if (!cSld) throw new Error("slide has no <p:cSld>");
  const bgName = qname("p", "bg", NS.pml);
  const bgPrName = qname("p", "bgPr", NS.pml);
  let bg = firstChildElement(cSld, bgName);
  if (bg === null) {
    bg = {
      kind: "element",
      name: bgName,
      attrs: [],
      prefixDecls: new Map(),
      children: [],
    };
    cSld.children.unshift(bg);
  }
  bg.children = [];
  const bgPr: XmlElement = {
    kind: "element",
    name: bgPrName,
    attrs: [],
    prefixDecls: new Map(),
    children: [],
  };
  bg.children.push(bgPr);
  configure(bgPr);
  commitSlideData(slide);
  refreshSlideData(slide);
};

/**
 * Reads back the slide's current background. Returns a discriminated
 * union mirroring `getShapeFill`'s shape, plus `inherit` when no
 * `<p:bg>` element is present (the slide picks up its background from
 * the layout / master).
 */
export type SlideBackground =
  | {
      readonly kind: "solid";
      readonly color: string;
      readonly opacity?: number;
    }
  | { readonly kind: "gradient" }
  | { readonly kind: "pattern" }
  | { readonly kind: "image" }
  | { readonly kind: "inherit" };

/**
 * Reads the slide's color-map override (`<p:clrMapOvr><p:overrideClrMapping/>`).
 * The mapping remaps the eight stable ECMA-376 color tokens (`bg1`,
 * `tx1`, `bg2`, `tx2`, `accent1`–`accent6`, `hlink`, `folHlink`) to
 * different theme positions. Returns `null` when the slide uses the
 * master's color map unchanged (the overwhelming common case).
 */
export const getSlideColorMapOverride = (
  slide: SlideData,
): Record<string, string> | null => {
  const root = slide[SLIDE_DOCUMENT].root;
  let ovr: XmlElement | null = null;
  for (const c of root.children) {
    if (c.kind !== "element") continue;
    if (c.name.namespaceURI === NS.pml && c.name.localName === "clrMapOvr") {
      ovr = c;
      break;
    }
  }
  if (!ovr) return null;
  const mapping = firstChildElement(
    ovr,
    qname("a", "overrideClrMapping", NS.dml),
  );
  if (!mapping) return null;
  // overrideClrMapping carries 12 attributes — bg1..folHlink — each
  // pointing to the index the token is remapped to in the theme.
  const out: Record<string, string> = {};
  for (const a of mapping.attrs) {
    if (a.name.namespaceURI !== "") continue;
    out[a.name.localName] = a.value;
  }
  return Object.keys(out).length > 0 ? out : null;
};

/** Supply the theme and effective slide color map to resolve color transforms.
 * Without this context, readers keep returning the authored hex / scheme token.
 * Opacity is returned separately, only when a resolved solid fill is translucent.
 */
export interface SlideBackgroundColorContext {
  readonly theme: PresentationTheme | null;
  readonly clrMap?: Readonly<Record<string, string>> | null;
}

const readBackground = (
  root: XmlElement,
  context?: SlideBackgroundColorContext,
): SlideBackground => {
  const cSld = firstChildElement(root, NAME_CSLD);
  const bg = cSld && firstChildElement(cSld, qname("p", "bg", NS.pml));
  if (!bg) return { kind: "inherit" };
  const readSolid = (fill: XmlElement): SlideBackground | null => {
    for (const child of fill.children) {
      if (child.kind !== "element" || child.name.namespaceURI !== NS.dml)
        continue;
      if (context) {
        const isScheme = child.name.localName === "schemeClr";
        const color = resolveDrawingColor(
          child,
          isScheme ? context.theme : null,
          isScheme ? context.clrMap : undefined,
        );
        if (color !== null) {
          const opacity = resolveDrawingOpacity(child);
          return opacity < 1
            ? { kind: "solid", color, opacity }
            : { kind: "solid", color };
        }
      }
      const value = getAttrValue(child, qname("", "val", ""));
      if (value === null) continue;
      if (child.name.localName === "srgbClr")
        return { kind: "solid", color: `#${value.toUpperCase()}` };
      if (child.name.localName === "schemeClr")
        return { kind: "solid", color: `scheme:${value}` };
    }
    return null;
  };
  // Keep the existing bgRef color approximation. Resolving the referenced
  // theme fill (including gradients) requires the format-scheme style list.
  const ref = firstChildElement(bg, qname("p", "bgRef", NS.pml));
  if (ref) return readSolid(ref) ?? { kind: "inherit" };
  const properties = firstChildElement(bg, qname("p", "bgPr", NS.pml));
  if (!properties) return { kind: "inherit" };
  for (const child of properties.children) {
    if (child.kind !== "element" || child.name.namespaceURI !== NS.dml)
      continue;
    switch (child.name.localName) {
      case "solidFill":
        return readSolid(child) ?? { kind: "solid", color: "" };
      case "gradFill":
        return { kind: "gradient" };
      case "pattFill":
        return { kind: "pattern" };
      case "blipFill":
        return { kind: "image" };
    }
  }
  return { kind: "inherit" };
};

export const getSlideBackground = (
  slide: SlideData,
  context?: SlideBackgroundColorContext,
): SlideBackground => readBackground(slide[SLIDE_DOCUMENT].root, context);

/**
 * A simplified, render-ready view of one of the layout's non-placeholder
 * shapes. Resolves the bounds, preset, fill, and stroke without going
 * through the slide-bound `SlideShapeData` symbols. Returned by
 * `getSlideLayoutBackgroundShapes` for renderers that want to paint the
 * layout's brand-template decoration (corner bars, divider lines, logos
 * as solid rects, etc.) behind the slide's own shapes.
 */
export interface SlideLayoutBackgroundShape {
  readonly kind: "shape" | "connector" | "picture" | "group" | "graphicFrame";
  /** Bounds in EMU, or `null` when the shape inherits from its master. */
  readonly bounds: ShapeBounds | null;
  /** Preset geometry token for shapes (`'rect'`, `'roundRect'`, `'ellipse'`, …). */
  readonly preset: string | null;
  /** Fill color resolved to `#RRGGBB` (transforms + theme applied), or `null`. */
  readonly fillHex: string | null;
  /** Stroke color resolved to `#RRGGBB`, or `null`. */
  readonly strokeHex: string | null;
  /** Stroke width in EMU, or `null` when no explicit width is set. */
  readonly strokeWidthEmu: number | null;
  /** Rotation in degrees. */
  readonly rotation: number;
  /** Flip state. */
  readonly flip: { horizontal: boolean; vertical: boolean };
}

/**
 * Returns the non-placeholder shapes on a layout as a render-ready
 * view. Useful for previewing brand-template decoration (corner bars,
 * background rectangles, divider lines) that would otherwise be hidden
 * because they aren't reachable through `getSlideLayoutPlaceholders`.
 *
 * Placeholders are excluded — they're better rendered through the
 * slide's own placeholder bounds (which already cascade through the
 * layout). Picture and group shapes are omitted; their bytes / nested
 * children would need the layout's relationship table to resolve.
 */
export const getSlideLayoutBackgroundShapes = (
  pres: PresentationData,
  layout: SlideLayoutData,
  colorMap?: Readonly<Record<string, string>> | null,
): ReadonlyArray<SlideLayoutBackgroundShape> => {
  const theme =
    themeForPart(pres[INTERNAL_PACKAGE], layout[LAYOUT_PART_NAME])?.theme ??
    getPresentationTheme(pres);
  let effectiveMap = colorMap;
  const out: SlideLayoutBackgroundShape[] = [];
  for (const shape of layout[LAYOUT_PART].shapes) {
    if (shape.placeholderType !== null || shape.placeholderIdx !== null)
      continue;
    if (shape.kind !== "shape" && shape.kind !== "connector") continue;
    const el = shape.element;
    const pos = readPosition(el, shape.kind);
    const size = readSize(el, shape.kind);
    const bounds: ShapeBounds | null =
      pos !== null && size !== null
        ? {
            x: pos.x as Emu,
            y: pos.y as Emu,
            w: size.w as Emu,
            h: size.h as Emu,
          }
        : null;
    const spPr = firstChildElement(el, qname("p", "spPr", NS.pml));
    let preset: string | null = null;
    let fillHex: string | null = null;
    let strokeHex: string | null = null;
    let strokeWidthEmu: number | null = null;
    if (spPr) {
      const prstGeom = firstChildElement(spPr, qname("a", "prstGeom", NS.dml));
      if (prstGeom) preset = getAttrValue(prstGeom, qname("", "prst", ""));
      const solid = firstChildElement(spPr, qname("a", "solidFill", NS.dml));
      if (solid) {
        for (const c of solid.children) {
          if (c.kind !== "element" || c.name.namespaceURI !== NS.dml) continue;
          fillHex = resolveDrawingColor(
            c,
            theme,
            c.name.localName === "schemeClr"
              ? (effectiveMap ??= getLayoutColorMap(pres, layout))
              : undefined,
          );
          break;
        }
      }
      const ln = firstChildElement(spPr, qname("a", "ln", NS.dml));
      if (ln) {
        const w = getAttrValue(ln, qname("", "w", ""));
        if (w !== null) {
          const n = Number.parseInt(w, 10);
          if (Number.isFinite(n)) strokeWidthEmu = n;
        }
        const lnSolid = firstChildElement(ln, qname("a", "solidFill", NS.dml));
        if (lnSolid) {
          for (const c of lnSolid.children) {
            if (c.kind !== "element" || c.name.namespaceURI !== NS.dml)
              continue;
            strokeHex = resolveDrawingColor(
              c,
              theme,
              c.name.localName === "schemeClr"
                ? (effectiveMap ??= getLayoutColorMap(pres, layout))
                : undefined,
            );
            break;
          }
        }
      }
    }
    const rotation = readRotation(el, shape.kind);
    const flip = readFlip(el, shape.kind) ?? {
      horizontal: false,
      vertical: false,
    };
    out.push({
      kind: shape.kind,
      bounds,
      preset,
      fillHex,
      strokeHex,
      strokeWidthEmu,
      rotation,
      flip,
    });
  }
  return out;
};

// Wraps a layout / master part as a read-only `SlideData` so its decorative
// shapes can be read (and rendered) through the very same `getShape*` helpers
// as slide shapes — crucially, picture relationships (logos) resolve against
// THIS part's rels. The handle is for reading only; mutating helpers would
// commit against a part this wrapper doesn't track.
const partDecorationShapes = (
  pkg: OpcPackage,
  thePartName: PartName,
  csldType: "sldLayout" | "sldMaster",
): ReadonlyArray<SlideShapeData> => {
  const part = pkg.getPart(thePartName);
  if (part === null) return [];
  const doc = copyPartDocument(part);
  const { shapes } = readShapeTreeFromCsldRoot(doc.root, csldType);
  const data: SlideData = {
    [INTERNAL_PACKAGE]: pkg,
    [SLIDE_PART_NAME]: thePartName,
    [SLIDE_DOCUMENT]: doc,
    [SLIDE_PART]: { shapes, root: doc.root },
    [SLIDE_SHAPES]: [],
  };
  // Decoration only: placeholders are rendered through the slide's own
  // placeholders (which already cascade through the layout/master).
  data[SLIDE_SHAPES] = shapes
    .filter((s) => s.placeholderType === null && s.placeholderIdx === null)
    .map((snap) => ({
      [SHAPE_SLIDE]: data,
      [SHAPE_ELEMENT]: snap.element,
      [SHAPE_SNAPSHOT]: snap,
    }));
  return data[SLIDE_SHAPES];
};

/**
 * Non-placeholder decorative shapes on a slide layout — corner bars, divider
 * lines, **logos**, watermark text — as full `SlideShapeData` bound to the
 * layout part. Unlike `getSlideLayoutBackgroundShapes` (a flat summary that
 * drops pictures and groups), these work with every `getShape*` reader, so a
 * renderer can paint them with real geometry, fills, text and picture bytes.
 *
 * For reading / rendering only — the handles are bound to the layout part, not
 * a slide, so the mutating `setShape*` helpers should not be used on them.
 */
export const getSlideLayoutShapes = (
  pres: PresentationData,
  layout: SlideLayoutData,
): ReadonlyArray<SlideShapeData> =>
  partDecorationShapes(
    pres[INTERNAL_PACKAGE],
    layout[LAYOUT_PART_NAME],
    "sldLayout",
  );

/**
 * Non-placeholder decorative shapes on the layout's slide master — the
 * template decoration shared by every layout (background logos, divider lines,
 * etc.). Same render-ready `SlideShapeData` view as `getSlideLayoutShapes`.
 */
export const getSlideMasterShapes = (
  pres: PresentationData,
  layout: SlideLayoutData,
): ReadonlyArray<SlideShapeData> => {
  const pkg = pres[INTERNAL_PACKAGE];
  const layoutName = layout[LAYOUT_PART_NAME];
  const rels = pkg.getRels(layoutName);
  const masterRel = rels?.items.find((r) => r.type === REL_TYPES.slideMaster);
  if (!masterRel) return [];
  const masterName = masterRel.target.startsWith("/")
    ? partName(masterRel.target)
    : resolveTarget(layoutName, masterRel.target);
  return partDecorationShapes(pkg, masterName, "sldMaster");
};

/**
 * Reads the slide layout's background. Same discriminated union as
 * `getSlideBackground` for slides — renderers fall back to this when
 * the slide's own background reports `'inherit'`. Walking one further
 * level to the master is left to callers (the same shape applies).
 */
/**
 * Reads the slide layout's pattern background when its `<p:bg>` is a
 * `<p:bgPr><a:pattFill>`. Same shape as `getSlideBackgroundPatternFill`
 * for slides.
 */
export const getSlideLayoutBackgroundPatternFill = (
  pres: PresentationData,
  layout: SlideLayoutData,
  colorMap?: Readonly<Record<string, string>> | null,
): PatternFillData | null => {
  const cSld = firstChildElement(layout[LAYOUT_PART].root, NAME_CSLD);
  if (!cSld) return null;
  const bg = firstChildElement(cSld, qname("p", "bg", NS.pml));
  if (!bg) return null;
  const bgPr = firstChildElement(bg, qname("p", "bgPr", NS.pml));
  if (!bgPr) return null;
  const pattFill = firstChildElement(bgPr, qname("a", "pattFill", NS.dml));
  if (!pattFill) return null;
  const theme =
    themeForPart(pres[INTERNAL_PACKAGE], layout[LAYOUT_PART_NAME])?.theme ??
    getPresentationTheme(pres);
  let effectiveMap = colorMap;
  return readPatternFill(pattFill, (c) =>
    resolveDrawingColor(
      c,
      theme,
      c.name.localName === "schemeClr"
        ? (effectiveMap ??= getLayoutColorMap(pres, layout))
        : undefined,
    ),
  );
};

/**
 * Reads the slide master's pattern background. Companion to
 * `getSlideLayoutBackgroundPatternFill`.
 */
export const getSlideMasterBackgroundPatternFill = (
  pres: PresentationData,
  layout: SlideLayoutData,
  colorMap?: Readonly<Record<string, string>> | null,
): PatternFillData | null => {
  const pkg = pres[INTERNAL_PACKAGE];
  const layoutPartName = partName(layout[LAYOUT_PART_NAME]);
  const layoutRels = pkg.getRels(layoutPartName);
  if (!layoutRels) return null;
  const masterRel = layoutRels.items.find(
    (r) => r.type === REL_TYPES.slideMaster,
  );
  if (!masterRel) return null;
  const masterPart = pkg.getPart(
    resolveTarget(layoutPartName, masterRel.target),
  );
  if (!masterPart) return null;
  const masterRoot = readOnlyPartRoot(masterPart);
  const cSld = firstChildElement(masterRoot, NAME_CSLD);
  if (!cSld) return null;
  const bg = firstChildElement(cSld, qname("p", "bg", NS.pml));
  if (!bg) return null;
  const bgPr = firstChildElement(bg, qname("p", "bgPr", NS.pml));
  if (!bgPr) return null;
  const pattFill = firstChildElement(bgPr, qname("a", "pattFill", NS.dml));
  if (!pattFill) return null;
  const theme =
    themeForPart(pkg, masterPart.name)?.theme ?? getPresentationTheme(pres);
  let effectiveMap = colorMap;
  return readPatternFill(pattFill, (c) =>
    resolveDrawingColor(
      c,
      theme,
      c.name.localName === "schemeClr"
        ? (effectiveMap ??= getMasterColorMap(masterRoot))
        : undefined,
    ),
  );
};

/**
 * Reads the slide layout's gradient background when its `<p:bg>` is a
 * `<p:bgPr><a:gradFill>`. Same shape as `getSlideBackgroundGradientFill`
 * for slides.
 */
export const getSlideLayoutBackgroundGradientFill = (
  layout: SlideLayoutData,
  context?: SlideBackgroundColorContext,
): GradientFillOptions | null => {
  const cSld = firstChildElement(layout[LAYOUT_PART].root, NAME_CSLD);
  if (!cSld) return null;
  const bg = firstChildElement(cSld, qname("p", "bg", NS.pml));
  if (!bg) return null;
  const bgPr = firstChildElement(bg, qname("p", "bgPr", NS.pml));
  if (!bgPr) return null;
  const gradFill = firstChildElement(bgPr, NAME_A_GRAD_FILL);
  if (!gradFill) return null;
  // Shared with shapes, so the path focus (fillToRect) is kept too.
  return parseGradFill(gradFill, context);
};

/**
 * Reads the slide master's gradient background when present. Mirrors
 * `getSlideLayoutBackgroundGradientFill`; returns `null` for any other
 * background kind. Useful for closing the bg cascade — slides that
 * report `'gradient'` inherit can now get the master's gradient
 * projected via `gradientDef`.
 */
export const getSlideMasterBackgroundGradientFill = (
  pres: PresentationData,
  layout: SlideLayoutData,
  context?: SlideBackgroundColorContext,
): GradientFillOptions | null => {
  const pkg = pres[INTERNAL_PACKAGE];
  const layoutPartName = partName(layout[LAYOUT_PART_NAME]);
  const layoutRels = pkg.getRels(layoutPartName);
  if (!layoutRels) return null;
  const masterRel = layoutRels.items.find(
    (r) => r.type === REL_TYPES.slideMaster,
  );
  if (!masterRel) return null;
  const masterPart = pkg.getPart(
    resolveTarget(layoutPartName, masterRel.target),
  );
  if (!masterPart) return null;
  const masterRoot = readOnlyPartRoot(masterPart);
  const cSld = firstChildElement(masterRoot, NAME_CSLD);
  if (!cSld) return null;
  const bg = firstChildElement(cSld, qname("p", "bg", NS.pml));
  if (!bg) return null;
  const bgPr = firstChildElement(bg, qname("p", "bgPr", NS.pml));
  if (!bgPr) return null;
  const gradFill = firstChildElement(bgPr, NAME_A_GRAD_FILL);
  if (!gradFill) return null;
  // Shared with shapes, so the path focus (fillToRect) is kept too.
  return parseGradFill(gradFill, context);
};

/**
 * Reads the slide master's background. Same discriminated union as
 * `getSlideBackground` / `getSlideLayoutBackground`. Walks one rel up
 * from the layout to find the master, then reads `<p:bg>` (either
 * `<p:bgPr>` explicit fill or `<p:bgRef>` theme reference).
 *
 * Slides that report `'inherit'` on both their own background and the
 * layout's commonly inherit the brand fill from the master — this
 * closes the third level of the cascade.
 */
export const getSlideMasterBackground = (
  pres: PresentationData,
  layout: SlideLayoutData,
  context?: SlideBackgroundColorContext,
): SlideBackground => {
  const pkg = pres[INTERNAL_PACKAGE];
  const layoutPartName = partName(layout[LAYOUT_PART_NAME]);
  const layoutRels = pkg.getRels(layoutPartName);
  if (!layoutRels) return { kind: "inherit" };
  const masterRel = layoutRels.items.find(
    (r) => r.type === REL_TYPES.slideMaster,
  );
  if (!masterRel) return { kind: "inherit" };
  const masterPart = pkg.getPart(
    resolveTarget(layoutPartName, masterRel.target),
  );
  if (!masterPart) return { kind: "inherit" };
  const masterRoot = readOnlyPartRoot(masterPart);
  return readBackground(masterRoot, context);
};

export const getSlideLayoutBackground = (
  layout: SlideLayoutData,
  context?: SlideBackgroundColorContext,
): SlideBackground => readBackground(layout[LAYOUT_PART].root, context);

/**
 * Returns the gradient stops + path when the slide carries a
 * `<p:bgPr><a:gradFill>` background. Returns `null` for any other
 * background kind. Shape identical to `getShapeGradientFill` so renderers
 * can use the same projection logic for slide backgrounds.
 */
export const getSlideBackgroundGradientFill = (
  slide: SlideData,
  context?: SlideBackgroundColorContext,
): GradientFillOptions | null => {
  const cSld = firstChildElement(slide[SLIDE_DOCUMENT].root, NAME_CSLD);
  if (!cSld) return null;
  const bg = firstChildElement(cSld, qname("p", "bg", NS.pml));
  if (!bg) return null;
  const bgPr = firstChildElement(bg, qname("p", "bgPr", NS.pml));
  if (!bgPr) return null;
  const gradFill = firstChildElement(bgPr, NAME_A_GRAD_FILL);
  if (!gradFill) return null;
  // Reuse the same algorithm `getShapeGradientFill` does. The gradFill
  // element shape is identical between shape and slide backgrounds.
  // Shared with shapes, so the path focus (fillToRect) is kept too.
  return parseGradFill(gradFill, context);
};

/**
 * Returns the pattern preset + theme-resolved colors when the slide
 * carries a `<p:bgPr><a:pattFill>` background. Returns `null` for any
 * other background kind. Shape mirrors `getShapePatternFill`.
 */
export const getSlideBackgroundPatternFill = (
  pres: PresentationData,
  slide: SlideData,
  colorMap?: Readonly<Record<string, string>> | null,
): PatternFillData | null => {
  const cSld = firstChildElement(slide[SLIDE_DOCUMENT].root, NAME_CSLD);
  if (!cSld) return null;
  const bg = firstChildElement(cSld, qname("p", "bg", NS.pml));
  if (!bg) return null;
  const bgPr = firstChildElement(bg, qname("p", "bgPr", NS.pml));
  if (!bgPr) return null;
  const pattFill = firstChildElement(bgPr, qname("a", "pattFill", NS.dml));
  if (!pattFill) return null;
  const theme = themeForSlide(slide)?.theme ?? getPresentationTheme(pres);
  let effectiveMap = colorMap;
  return readPatternFill(pattFill, (c) =>
    resolveDrawingColor(
      c,
      theme,
      c.name.localName === "schemeClr"
        ? (effectiveMap ??= getEffectiveColorMap(slide))
        : undefined,
    ),
  );
};

/**
 * Returns the embedded image bytes when the slide carries a
 * `<p:bgPr><a:blipFill>` background, or `null` for any other background
 * kind (solid / gradient / pattern / inherit) or when neither its preferred
 * SVG source nor raster compatibility source resolves to embedded media.
 * External image references aren't followed.
 *
 * Companion to `getSlideBackground`, which only reports the
 * discriminated `kind`. Renderers that want to actually paint the
 * background image (preview generators, snapshot tools) call this.
 */
export const getSlideBackgroundImageBytes = (
  slide: SlideData,
): Uint8Array | null => {
  const cSld = firstChildElement(slide[SLIDE_DOCUMENT].root, NAME_CSLD);
  if (!cSld) return null;
  const bg = firstChildElement(cSld, qname("p", "bg", NS.pml));
  if (!bg) return null;
  const bgPr = firstChildElement(bg, qname("p", "bgPr", NS.pml));
  if (!bgPr) return null;
  const blipFill = firstChildElement(bgPr, qname("a", "blipFill", NS.dml));
  if (!blipFill) return null;
  const blip = firstChildElement(blipFill, qname("a", "blip", NS.dml));
  if (!blip) return null;
  const pkg = slide[INTERNAL_PACKAGE];
  return resolveBlipImage(pkg, slide[SLIDE_PART_NAME], blip)?.part.data ?? null;
};

/**
 * Reads the slide layout's background image bytes when its `<p:bg>` is
 * a `<p:bgPr><a:blipFill>`. Same shape as `getSlideBackgroundImageBytes`
 * for slides. Returns `null` when the layout has no image background.
 */
export const getSlideLayoutBackgroundImageBytes = (
  pres: PresentationData,
  layout: SlideLayoutData,
): Uint8Array | null => {
  const cSld = firstChildElement(layout[LAYOUT_PART].root, NAME_CSLD);
  if (!cSld) return null;
  const bg = firstChildElement(cSld, qname("p", "bg", NS.pml));
  if (!bg) return null;
  const bgPr = firstChildElement(bg, qname("p", "bgPr", NS.pml));
  if (!bgPr) return null;
  const blipFill = firstChildElement(bgPr, qname("a", "blipFill", NS.dml));
  if (!blipFill) return null;
  const blip = firstChildElement(blipFill, qname("a", "blip", NS.dml));
  if (!blip) return null;
  const pkg = pres[INTERNAL_PACKAGE];
  const layoutPartName = partName(layout[LAYOUT_PART_NAME]);
  return resolveBlipImage(pkg, layoutPartName, blip)?.part.data ?? null;
};

/**
 * Reads the slide master's background image bytes (via the layout's
 * master rel). Companion to `getSlideLayoutBackgroundImageBytes`.
 */
export const getSlideMasterBackgroundImageBytes = (
  pres: PresentationData,
  layout: SlideLayoutData,
): Uint8Array | null => {
  const pkg = pres[INTERNAL_PACKAGE];
  const layoutPartName = partName(layout[LAYOUT_PART_NAME]);
  const layoutRels = pkg.getRels(layoutPartName);
  if (!layoutRels) return null;
  const masterRel = layoutRels.items.find(
    (r) => r.type === REL_TYPES.slideMaster,
  );
  if (!masterRel) return null;
  const masterPartName = resolveTarget(layoutPartName, masterRel.target);
  const masterPart = pkg.getPart(masterPartName);
  if (!masterPart) return null;
  const masterRoot = readOnlyPartRoot(masterPart);
  const cSld = firstChildElement(masterRoot, NAME_CSLD);
  if (!cSld) return null;
  const bg = firstChildElement(cSld, qname("p", "bg", NS.pml));
  if (!bg) return null;
  const bgPr = firstChildElement(bg, qname("p", "bgPr", NS.pml));
  if (!bgPr) return null;
  const blipFill = firstChildElement(bgPr, qname("a", "blipFill", NS.dml));
  if (!blipFill) return null;
  const blip = firstChildElement(blipFill, qname("a", "blip", NS.dml));
  if (!blip) return null;
  return resolveBlipImage(pkg, masterPartName, blip)?.part.data ?? null;
};

/** Sets a solid fill on the slide's background. */
export const setSlideBackground = (slide: SlideData, color: string): void => {
  setSlideBackgroundXml(slide, (bgPr) => setSolidFill(bgPr, color));
};

/**
 * Sets a picture as the slide's background. Embeds `bytes` as a new
 * media part, wires a slide → image rel, and replaces any prior
 * background with a `<p:bgPr><a:blipFill><a:blip r:embed="…"/>
 * <a:stretch><a:fillRect/></a:stretch></a:blipFill></p:bgPr>` payload.
 *
 * Format is detected from magic bytes; pass `options.format` to
 * override.
 */
export const setSlideBackgroundImage = (
  slide: SlideData,
  bytes: Uint8Array,
  options: { format?: ImageFormat } = {},
): void => {
  const format = options.format ?? detectImageFormat(bytes);
  if (format === null) {
    throw new Error(
      "setSlideBackgroundImage: could not detect image format. Pass options.format explicitly.",
    );
  }
  const contentType = contentTypeForFormat(format);
  const extension = extensionForFormat(format);
  const pkg = slide[INTERNAL_PACKAGE];

  // Allocate media part name.
  let nextN = 1;
  const mediaPattern = /^\/ppt\/media\/image(\d+)\./;
  for (const p of pkg.parts) {
    const m = p.name.match(mediaPattern);
    if (m?.[1] !== undefined) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= nextN) nextN = n + 1;
    }
  }
  const newMediaName = partName(`/ppt/media/image${nextN}.${extension}`);
  setOpcDefault(pkg, extension, contentType);
  pkg.addPart(newMediaName, contentType, bytes);

  // Slide → image rel.
  const rels = pkg.getRels(slide[SLIDE_PART_NAME]) ?? emptyRels();
  const newRId = nextRelId(rels.items.map((r) => r.id));
  rels.items.push({
    id: newRId,
    type: REL_TYPES.image,
    target: `../media/image${nextN}.${extension}`,
    targetMode: "Internal",
  });
  pkg.setRels(slide[SLIDE_PART_NAME], rels);

  setSlideBackgroundXml(slide, (bgPr) => {
    const blip = elem(qname("a", "blip", NS.dml), {
      attrs: [attr(qname("r", "embed", NS.officeDocRels), newRId)],
    });
    const stretch = elem(qname("a", "stretch", NS.dml), {
      children: [elem(qname("a", "fillRect", NS.dml))],
    });
    bgPr.children.push(
      elem(qname("a", "blipFill", NS.dml), { children: [blip, stretch] }),
    );
  });
};

/** Clears any explicit slide background, restoring layout inheritance. */
export const clearSlideBackground = (slide: SlideData): void => {
  const cSld = firstChildElement(slide[SLIDE_DOCUMENT].root, NAME_CSLD);
  if (!cSld) return;
  cSld.children = cSld.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.pml &&
        c.name.localName === "bg"
      ),
  );
  commitSlideData(slide);
  refreshSlideData(slide);
};
