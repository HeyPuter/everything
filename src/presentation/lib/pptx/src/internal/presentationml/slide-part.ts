// Read-only view over a slide part (`/ppt/slides/slideN.xml`).
//
// ECMA-376 Part 1 §19.3.1.38 — `<p:sld>` wraps a common slide data block
// (`p:cSld`) containing a shape tree (`p:spTree`). The shape tree children
// are the slide's drawable objects:
//
//   - `p:sp` — shape (rect, ellipse, custom geometry; may carry text)
//   - `p:pic` — picture (image fill from a relationship)
//   - `p:grpSp` — group of nested shape-tree children
//   - `p:graphicFrame` — wraps a non-DrawingML graphic (table, chart, SmartArt)
//   - `p:cxnSp` — connector (line linking two shapes)
//
// Each carries non-visual properties under `p:nvSpPr`/`p:nvPicPr`/etc.
// containing `p:cNvPr` (id + name), and visual properties under
// `p:spPr`/`p:grpSpPr` (geometry + fill). At this phase we expose:
//
//   - The classified shape array,
//   - each shape's id, name, placeholder type (if any),
//   - text content for shapes that carry an `a:txBody`.
//
// Geometry, fill, effects, and full authoring are deferred. They live in
// drawingml/ once we need them.

import { textBodyText } from "../drawingml/index.ts";
import { NS, firstChildElement, getAttrValue, qname } from "../xml/index.ts";
import type { XmlElement } from "../xml/index.ts";

export type ShapeKind =
  "shape" | "picture" | "group" | "graphicFrame" | "connector";

export interface SlideShape {
  readonly kind: ShapeKind;
  /** OOXML internal numeric id, unique within the slide's shape tree. */
  readonly id: number;
  /** Human-readable name (`Title 1`, `Content Placeholder 2`, ...). */
  readonly name: string;
  /**
   * Placeholder type (`title`, `body`, `ctrTitle`, ...) when the shape is a
   * placeholder; `null` for regular shapes and pictures. From `p:ph/@type`.
   */
  readonly placeholderType: string | null;
  /**
   * Placeholder index, used to bind the slide-level shape to its same-idx
   * counterpart on the slide layout / master.
   */
  readonly placeholderIdx: number | null;
  /** All visible text concatenated. `''` if the shape has no text body. */
  readonly text: string;
  /**
   * The underlying XML element for this shape. Higher layers walk this when
   * they need formatting / geometry information not yet promoted to the
   * typed view.
   */
  readonly element: XmlElement;
}

export interface SlidePart {
  readonly shapes: ReadonlyArray<SlideShape>;
  readonly root: XmlElement;
}

const NAME_CSLD = qname("p", "cSld", NS.pml);
const NAME_SP_TREE = qname("p", "spTree", NS.pml);
const NAME_NV_SP_PR = qname("p", "nvSpPr", NS.pml);
const NAME_NV_PIC_PR = qname("p", "nvPicPr", NS.pml);
const NAME_NV_GRP_SP_PR = qname("p", "nvGrpSpPr", NS.pml);
const NAME_NV_GRAPHIC_FRAME_PR = qname("p", "nvGraphicFramePr", NS.pml);
const NAME_NV_CXN_SP_PR = qname("p", "nvCxnSpPr", NS.pml);
const NAME_C_NV_PR = qname("p", "cNvPr", NS.pml);
const NAME_NV_PR = qname("p", "nvPr", NS.pml);
const NAME_PH = qname("p", "ph", NS.pml);
// PresentationML defines its own `txBody` element inside `p:sp` (ECMA-376
// Part 1 §19.3.1.51) — the wrapper is in the `p:` namespace, even though
// the children (a:bodyPr, a:p, a:r, a:t) come from DrawingML.
const NAME_TX_BODY = qname("p", "txBody", NS.pml);
const ATTR_ID = qname("", "id", "");
const ATTR_NAME = qname("", "name", "");
const ATTR_TYPE = qname("", "type", "");
const ATTR_IDX = qname("", "idx", "");

const NV_BY_KIND: Record<ShapeKind, ReturnType<typeof qname>> = {
  shape: NAME_NV_SP_PR,
  picture: NAME_NV_PIC_PR,
  group: NAME_NV_GRP_SP_PR,
  graphicFrame: NAME_NV_GRAPHIC_FRAME_PR,
  connector: NAME_NV_CXN_SP_PR,
};

const classify = (element: XmlElement): ShapeKind | null => {
  if (element.name.namespaceURI !== NS.pml) return null;
  switch (element.name.localName) {
    case "sp":
      return "shape";
    case "pic":
      return "picture";
    case "grpSp":
      return "group";
    case "graphicFrame":
      return "graphicFrame";
    case "cxnSp":
      return "connector";
    default:
      return null;
  }
};

const extractShape = (element: XmlElement, kind: ShapeKind): SlideShape => {
  const nvContainer = firstChildElement(element, NV_BY_KIND[kind]);
  let id = 0;
  let name = "";
  let placeholderType: string | null = null;
  let placeholderIdx: number | null = null;

  if (nvContainer !== null) {
    const cNvPr = firstChildElement(nvContainer, NAME_C_NV_PR);
    if (cNvPr !== null) {
      const idRaw = getAttrValue(cNvPr, ATTR_ID);
      if (idRaw !== null) id = Number.parseInt(idRaw, 10);
      const nameRaw = getAttrValue(cNvPr, ATTR_NAME);
      if (nameRaw !== null) name = nameRaw;
    }
    const nvPr = firstChildElement(nvContainer, NAME_NV_PR);
    if (nvPr !== null) {
      const ph = firstChildElement(nvPr, NAME_PH);
      if (ph !== null) {
        // <p:ph type="..." idx="..."/>; both attributes are optional. When
        // both are absent the shape is a placeholder with default semantics
        // (a body placeholder per the spec) — we mirror that with type=null
        // and let the caller resolve via the layout's same-idx slot.
        placeholderType = getAttrValue(ph, ATTR_TYPE);
        const idxRaw = getAttrValue(ph, ATTR_IDX);
        if (idxRaw !== null) placeholderIdx = Number.parseInt(idxRaw, 10);
      }
    }
  }

  let text = "";
  if (kind === "shape") {
    const txBody = firstChildElement(element, NAME_TX_BODY);
    if (txBody !== null) text = textBodyText(txBody);
  }

  return { kind, id, name, placeholderType, placeholderIdx, text, element };
};

const collectShapes = (
  spTree: XmlElement,
  out: SlideShape[],
  recurseIntoGroups: boolean,
): void => {
  for (const child of spTree.children) {
    if (child.kind !== "element") continue;
    const kind = classify(child);
    if (kind === null) continue;
    out.push(extractShape(child, kind));
    if (kind === "group" && recurseIntoGroups) {
      collectShapes(child, out, recurseIntoGroups);
    }
  }
};

/**
 * Reads the immediate child shapes of a `<p:grpSp>` (group shape)
 * without recursing further. Used by `getGroupChildren` on the public
 * surface to expose group contents to renderers.
 *
 * Throws if `element` isn't a `<p:grpSp>`.
 */
export const readGroupChildren = (element: XmlElement): SlideShape[] => {
  if (
    element.name.namespaceURI !== NS.pml ||
    element.name.localName !== "grpSp"
  ) {
    throw new Error(
      `readGroupChildren: expected <p:grpSp>, got <${element.name.prefix}:${element.name.localName}>`,
    );
  }
  const out: SlideShape[] = [];
  collectShapes(element, out, false);
  return out;
};

/**
 * Reads the shape tree from a slide / layout / master root element.
 * Exported so the sibling readers (`readSlideLayoutPart`,
 * `readSlideMasterPart`) can reuse it.
 */
/** Root elements whose `<p:cSld>` holds a shape tree. */
export type ShapeTreeRoot =
  | "sld"
  | "sldLayout"
  | "sldMaster"
  | "notesMaster"
  | "handoutMaster"
  | "notes";
const TEMPLATE_ROOTS: ReadonlySet<ShapeTreeRoot> = new Set([
  "sldLayout",
  "sldMaster",
  "notesMaster",
  "handoutMaster",
  "notes",
]);

export const readShapeTreeFromCsldRoot = (
  root: XmlElement,
  expectedLocalName: ShapeTreeRoot,
  options: { recurseIntoGroups?: boolean } = {},
): { shapes: SlideShape[]; cSld: XmlElement } => {
  if (
    root.name.namespaceURI !== NS.pml ||
    root.name.localName !== expectedLocalName
  ) {
    throw new Error(
      `expected <p:${expectedLocalName}>, got <${root.name.prefix}:${root.name.localName}>`,
    );
  }
  const cSld = firstChildElement(root, NAME_CSLD);
  if (cSld === null)
    throw new Error(`<p:${expectedLocalName}>: missing <p:cSld>`);
  const spTree = firstChildElement(cSld, NAME_SP_TREE);
  if (spTree === null) throw new Error("<p:cSld>: missing <p:spTree>");
  const shapes: SlideShape[] = [];
  collectShapes(spTree, shapes, options.recurseIntoGroups ?? true);
  return { shapes, cSld };
};

/**
 * Parses a slide root element (`p:sld`) into the typed view above.
 *
 * `recurseIntoGroups` controls whether group descendants are flattened into
 * the returned `shapes` array. The default is `true` because most callers
 * just want a flat enumeration.
 */
export const readSlidePart = (
  root: XmlElement,
  options: { recurseIntoGroups?: boolean } = {},
): SlidePart => {
  // Layouts, masters and the notes / handout masters share the slide's
  // `<p:cSld>` grammar, so an editing view over one reads the same way.
  const kind = TEMPLATE_ROOTS.has(root.name.localName as ShapeTreeRoot)
    ? (root.name.localName as ShapeTreeRoot)
    : "sld";
  const { shapes } = readShapeTreeFromCsldRoot(root, kind, options);
  return { shapes, root };
};

/**
 * Returns the concatenated visible text of a slide. Useful for snapshot
 * tests and quick inspection.
 */
export const slideText = (slide: SlidePart, joiner = "\n"): string =>
  slide.shapes
    .map((s) => s.text)
    .filter((t) => t.length > 0)
    .join(joiner);
