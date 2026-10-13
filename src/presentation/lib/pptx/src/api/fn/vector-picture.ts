// Pictures with a vector source and a raster stand-in.
//
// A picture whose drawing is SVG keeps a PNG of it in the blip itself and the
// SVG in the blip's `asvg:svgBlip` extension, as desktop editors write icons
// and inserted SVG files: a reader that knows SVG draws the vector, any other
// draws the PNG. Recolouring an icon or editing an equation replaces both.

import type { Emu } from "../units.ts";
import { buildPicture } from "../../internal/presentationml/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  NS,
  attr,
  elem,
  firstChildElement,
  qname,
  type XmlElement,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  SLIDE_PART_NAME,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import {
  appendAndReturnNewShape,
  commitAndRefresh,
  nextShapeId,
} from "./_helpers.ts";
import {
  blipImageReferences,
  resolveBlipImage,
  setBlipImageReference,
} from "./blip-image.ts";
import { addPackageMediaPart, addSlideRelationship } from "./object-data.ts";

const imagePart = (slide: SlideData, bytes: Uint8Array, svg: boolean) =>
  addSlideRelationship(
    slide,
    REL_TYPES.image,
    addPackageMediaPart(slide[INTERNAL_PACKAGE], bytes, {
      stem: "image",
      extension: svg ? "svg" : "png",
      contentType: svg ? "image/svg+xml" : "image/png",
    }),
  );

/** Points a blip at a PNG and, when given, an SVG preferred over it. */
const pointBlip = (
  slide: SlideData,
  blip: XmlElement,
  png: Uint8Array,
  svg: Uint8Array | null,
): void => {
  const pngId = imagePart(slide, png, false);
  setBlipImageReference(blip, pngId, false);
  if (svg) {
    const svgId = imagePart(slide, svg, true);
    // setBlipImageReference(svg) drops the raster embed; put it back so the
    // blip carries both, the raster for readers without SVG.
    setBlipImageReference(blip, svgId, true);
    blip.attrs.unshift({
      name: qname("r", "embed", NS.officeDocRels),
      value: pngId,
    });
  }
};

const blipOf = (shape: SlideShapeData): XmlElement | null => {
  if (shape[SHAPE_SNAPSHOT].kind !== "picture") return null;
  const fill = firstChildElement(
    shape[SHAPE_ELEMENT],
    qname("p", "blipFill", NS.pml),
  );
  return fill && firstChildElement(fill, qname("a", "blip", NS.dml));
};

/**
 * Adds a picture drawn from `png`, with `svg` as its preferred vector source
 * when given. Returns the new picture.
 */
export const addSlideVectorPicture = (
  slide: SlideData,
  sources: { png: Uint8Array; svg?: Uint8Array | null },
  opts: { x: Emu; y: Emu; w: Emu; h: Emu; name?: string; lockAspect?: boolean },
): SlideShapeData => {
  const pic = buildPicture({
    id: nextShapeId(slide),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    rEmbed: "",
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    lockAspect: opts.lockAspect ?? true,
  });
  const fill = firstChildElement(pic, qname("p", "blipFill", NS.pml))!;
  const blip = firstChildElement(fill, qname("a", "blip", NS.dml))!;
  blip.attrs = [];
  pointBlip(slide, blip, sources.png, sources.svg ?? null);
  return appendAndReturnNewShape(slide, pic);
};

/** Replaces a picture's image (and vector source) keeping everything else. */
export const setShapeVectorPicture = (
  shape: SlideShapeData,
  sources: { png: Uint8Array; svg?: Uint8Array | null },
): void => {
  const blip = blipOf(shape);
  if (!blip) throw new Error("setShapeVectorPicture: not a picture");
  pointBlip(shape[SHAPE_SLIDE], blip, sources.png, sources.svg ?? null);
  commitAndRefresh(shape);
};

/** The picture's SVG source, when it has one. */
export const getShapeSvgSource = (shape: SlideShapeData): Uint8Array | null => {
  const blip = blipOf(shape);
  if (!blip) return null;
  const slide = shape[SHAPE_SLIDE];
  const found = resolveBlipImage(
    slide[INTERNAL_PACKAGE],
    slide[SLIDE_PART_NAME],
    blip,
  );
  return found?.svg ? found.part.data : null;
};

/** The picture's raster image bytes (the PNG stand-in for a vector). */
export const getShapeRasterSource = (
  shape: SlideShapeData,
): Uint8Array | null => {
  const blip = blipOf(shape);
  if (!blip) return null;
  const slide = shape[SHAPE_SLIDE];
  const pkg = slide[INTERNAL_PACKAGE];
  const raster = blipImageReferences(blip).find((r) => !r.svg);
  if (!raster) return null;
  const rel = pkg
    .getRels(slide[SLIDE_PART_NAME])
    ?.items.find((r) => r.id === raster.id && r.targetMode === "Internal");
  if (!rel) return null;
  const found = resolveBlipImage(pkg, slide[SLIDE_PART_NAME], {
    ...blip,
    children: [],
  });
  return found?.part.data ?? null;
};

/**
 * Gives a shape or picture a preset outline (`rect`, `roundRect`, `ellipse`,
 * …), replacing its preset or custom geometry. A picture is clipped to it.
 */
export const setShapePresetGeometry = (
  shape: SlideShapeData,
  preset: string,
): void => {
  const spPr = firstChildElement(shape[SHAPE_ELEMENT], qname("p", "spPr", NS.pml));
  if (!spPr) throw new Error("setShapePresetGeometry: shape has no spPr");
  const geometry = elem(qname("a", "prstGeom", NS.dml), {
    attrs: [attr(qname("", "prst", ""), preset)],
    children: [elem(qname("a", "avLst", NS.dml))],
  });
  const at = spPr.children.findIndex(
    (c) =>
      c.kind === "element" &&
      (c.name.localName === "prstGeom" || c.name.localName === "custGeom"),
  );
  if (at >= 0) spPr.children[at] = geometry;
  else {
    // After the transform, before fills and lines.
    const xfrm = spPr.children.findIndex(
      (c) => c.kind === "element" && c.name.localName === "xfrm",
    );
    spPr.children.splice(xfrm + 1, 0, geometry);
  }
  commitAndRefresh(shape);
};
