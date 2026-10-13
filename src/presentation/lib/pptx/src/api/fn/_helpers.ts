// Cross-cutting helpers shared by the split fn modules.
//
// Helpers used by only one module live with that module. Anything
// referenced from two or more split files is centralized here.

import type { OpcPackage } from "../../internal/parts/index.ts";
import { readSlidePart } from "../../internal/presentationml/index.ts";
import {
  NS,
  type XmlElement,
  firstChildElement,
  qname,
  serializeXml,
} from "../../internal/xml/index.ts";
import { partName } from "../../internal/opc/index.ts";
import {
  INTERNAL_PACKAGE,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  SLIDE_DOCUMENT,
  SLIDE_PART,
  SLIDE_PART_NAME,
  SLIDE_SHAPES,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
export const decode = (b: Uint8Array): string => TEXT_DECODER.decode(b);
export const encode = (s: string): Uint8Array => TEXT_ENCODER.encode(s);

export const SLIDE_LAYOUT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";
export const SLIDE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
export const PRES_PART_NAME = partName("/ppt/presentation.xml");

export const NAME_PRESENTATION = qname("p", "presentation", NS.pml);
export const NAME_SLD_MASTER_ID_LST = qname("p", "sldMasterIdLst", NS.pml);
export const NAME_SLD_ID_LST = qname("p", "sldIdLst", NS.pml);
export const NAME_SLD_ID = qname("p", "sldId", NS.pml);
export const NAME_CSLD = qname("p", "cSld", NS.pml);
export const NAME_SP_TREE = qname("p", "spTree", NS.pml);
export const ATTR_ID = qname("", "id", "");
export const ATTR_R_ID = qname("r", "id", NS.officeDocRels);

// .pptx readers accept sldIds only in [256, 2³¹−1024]. See plan §Risks.
export const SLD_ID_MIN = 256;
export const SLD_ID_MAX = 2147482623;

// @internal — used by mutation functions to write SlideData state back
// into the package and rebuild the typed view. Free functions, no class
// dependency.

export const commitSlideData = (slide: SlideData): void => {
  const xml = serializeXml(slide[SLIDE_DOCUMENT]);
  const part = slide[INTERNAL_PACKAGE].getPart(slide[SLIDE_PART_NAME]);
  if (!part) throw new Error(`slide part missing: ${slide[SLIDE_PART_NAME]}`);
  part.data = encode(xml);
  // An editing view over a layout or master stays the part's view after
  // its own edits; any other change to the part makes a fresh one.
  const view = templateViews.get(part);
  if (view?.slide === slide) view.data = part.data;
};

/**
 * Editing views over layout / master parts (`getTemplateSlide`), by part,
 * with the bytes each view was read from or last committed.
 */
export const templateViews = new WeakMap<
  object,
  { data: Uint8Array; slide: SlideData }
>();

export const refreshSlideData = (slide: SlideData): void => {
  const fresh = readSlidePart(slide[SLIDE_DOCUMENT].root);
  slide[SLIDE_PART] = fresh;
  const shapes = slide[SLIDE_SHAPES];
  for (let i = 0; i < shapes.length; i++) {
    const next = fresh.shapes[i];
    const existing = shapes[i];
    if (!next || !existing) continue;
    existing[SHAPE_ELEMENT] = next.element;
    existing[SHAPE_SNAPSHOT] = next;
  }
};

// Rebuild shape handles entirely — used when the shape count changes
// (e.g. removeShape). Existing SlideShapeData identities are dropped;
// SHAPE_SLIDE back-pointers stay consistent because the SlideData
// reference is preserved.
export const rebuildShapesFromDocument = (slide: SlideData): void => {
  const fresh = readSlidePart(slide[SLIDE_DOCUMENT].root);
  slide[SLIDE_PART] = fresh;
  const shapes: SlideShapeData[] = [];
  for (const snap of fresh.shapes) {
    shapes.push({
      [SHAPE_SLIDE]: slide,
      [SHAPE_ELEMENT]: snap.element,
      [SHAPE_SNAPSHOT]: snap,
    });
  }
  slide[SLIDE_SHAPES] = shapes;
};

const NAME_TX_BODY = qname("p", "txBody", NS.pml);

export const requireSpPr = (shape: SlideShapeData): XmlElement => {
  const kind = shape[SHAPE_SNAPSHOT].kind;
  if (kind !== "shape" && kind !== "picture" && kind !== "connector") {
    throw new Error(`fill/stroke is not supported on ${kind} shapes`);
  }
  const spPrName = qname("p", "spPr", NS.pml);
  const el = shape[SHAPE_ELEMENT];
  let spPr = firstChildElement(el, spPrName);
  if (spPr === null) {
    spPr = {
      kind: "element",
      name: spPrName,
      attrs: [],
      prefixDecls: new Map(),
      children: [],
    };
    el.children.push(spPr);
  }
  return spPr;
};

export const requireTxBody = (shape: SlideShapeData): XmlElement => {
  if (shape[SHAPE_SNAPSHOT].kind !== "shape") {
    throw new Error(
      `text operations require a shape kind; ${shape[SHAPE_SNAPSHOT].kind} is not text-bearing`,
    );
  }
  const txBody = firstChildElement(shape[SHAPE_ELEMENT], NAME_TX_BODY);
  if (txBody === null) {
    throw new Error(`shape "${shape[SHAPE_SNAPSHOT].name}" has no <p:txBody>`);
  }
  return txBody;
};

export const commitAndRefresh = (shape: SlideShapeData): void => {
  commitSlideData(shape[SHAPE_SLIDE]);
  refreshSlideData(shape[SHAPE_SLIDE]);
};

export const requireSpTree = (slide: SlideData): XmlElement => {
  const cSld = firstChildElement(slide[SLIDE_DOCUMENT].root, NAME_CSLD);
  if (!cSld) throw new Error("slide has no <p:cSld>");
  const spTree = firstChildElement(cSld, NAME_SP_TREE);
  if (!spTree) throw new Error("slide has no <p:spTree>");
  return spTree;
};

export const nextShapeId = (slide: SlideData): number => {
  let maxId = 0;
  for (const s of slide[SLIDE_PART].shapes) {
    if (s.id > maxId) maxId = s.id;
  }
  return Math.max(maxId, 1) + 1;
};

export const appendAndReturnNewShape = (
  slide: SlideData,
  child: XmlElement,
): SlideShapeData => {
  const spTree = requireSpTree(slide);
  spTree.children.push(child);
  commitSlideData(slide);
  const previousLength = slide[SLIDE_SHAPES].length;
  rebuildShapesFromDocument(slide);
  const created = slide[SLIDE_SHAPES][previousLength];
  if (!created) throw new Error("appendShape: post-condition failed");
  return created;
};

export const setOpcDefault = (
  pkg: OpcPackage,
  extension: string,
  contentType: string,
): void => {
  const has = pkg.contentTypes.defaults.some(
    (d) => d.extension.toLowerCase() === extension,
  );
  if (!has) pkg.contentTypes.defaults.push({ extension, contentType });
};
