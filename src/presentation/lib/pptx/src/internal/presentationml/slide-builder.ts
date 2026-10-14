// Builds the XML payload for a new slide from scratch.
//
// A new slide from a layout is a minimal `<p:sld>` whose
// shape tree contains only the placeholder stubs the layout exposes
// (title, body, footer, etc.). Each stub carries a `<p:ph>` element with
// the layout's same idx/type so the slide inherits geometry, fill, and
// default text style from the layout. The stub's `<p:spPr/>` is empty
// (no `<a:xfrm>`), and its `<p:txBody>` carries one empty `<a:p/>` so
// the placeholder is mutable via `setText` immediately.
//
// We do NOT copy the layout shape itself — that would freeze the
// inheritance and silently desync the slide from layout changes.

import {
  type XmlDocument,
  type XmlElement,
  NS,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  qname,
  text as textNode,
} from "../xml/index.ts";

const NAME_SLD = qname("p", "sld", NS.pml);
const NAME_CSLD = qname("p", "cSld", NS.pml);
const NAME_SP_TREE = qname("p", "spTree", NS.pml);
const NAME_NV_GRP_SP_PR = qname("p", "nvGrpSpPr", NS.pml);
const NAME_C_NV_PR = qname("p", "cNvPr", NS.pml);
const NAME_C_NV_GRP_SP_PR = qname("p", "cNvGrpSpPr", NS.pml);
const NAME_NV_PR = qname("p", "nvPr", NS.pml);
const NAME_GRP_SP_PR = qname("p", "grpSpPr", NS.pml);
const NAME_SP = qname("p", "sp", NS.pml);
const NAME_NV_SP_PR = qname("p", "nvSpPr", NS.pml);
const NAME_C_NV_SP_PR = qname("p", "cNvSpPr", NS.pml);
const NAME_SP_PR = qname("p", "spPr", NS.pml);
const NAME_TX_BODY = qname("p", "txBody", NS.pml);
const NAME_PH = qname("p", "ph", NS.pml);
const NAME_BODY_PR = qname("a", "bodyPr", NS.dml);
const NAME_LST_STYLE = qname("a", "lstStyle", NS.dml);
const NAME_P = qname("a", "p", NS.dml);
const NAME_SP_LOCKS = qname("a", "spLocks", NS.dml);
const ATTR_ID = qname("", "id", "");
const ATTR_NAME = qname("", "name", "");
const ATTR_TYPE = qname("", "type", "");
const ATTR_IDX = qname("", "idx", "");
const ATTR_NO_GRP = qname("", "noGrp", "");

/** Placeholder types that belong to the header and footer row. */
export const FOOTER_TYPES: ReadonlySet<string> = new Set([
  "dt",
  "ftr",
  "sldNum",
  "hdr",
]);

/**
 * Builds a `<p:sld>` document containing the canonical slide-root group
 * (id=1, name="") and one placeholder stub per `<p:ph>` found on
 * `layoutSpTree`.
 *
 * The stubs reuse the layout's `<p:ph>` idx/type attributes verbatim, and
 * the names (`"Title 1"`, `"Content Placeholder 2"`) are built from the
 * placeholder type and an incrementing index.
 */
export const buildSlideFromLayout = (layoutSpTree: XmlElement): XmlDocument => {
  // Walk the layout's shape tree to find placeholders.
  const placeholders: Array<{ type: string | null; idx: string | null }> = [];
  for (const child of layoutSpTree.children) {
    if (child.kind !== "element") continue;
    if (child.name.namespaceURI !== NS.pml || child.name.localName !== "sp")
      continue;
    const nvSpPr = firstChildElement(child, NAME_NV_SP_PR);
    if (nvSpPr === null) continue;
    const nvPr = firstChildElement(nvSpPr, NAME_NV_PR);
    if (nvPr === null) continue;
    const ph = firstChildElement(nvPr, NAME_PH);
    if (ph === null) continue;
    // The date, footer, slide-number and header placeholders are not put on
    // a new slide: they appear only once the deck turns them on.
    const type = getAttrValue(ph, ATTR_TYPE);
    if (type !== null && FOOTER_TYPES.has(type)) continue;
    placeholders.push({
      type: getAttrValue(ph, ATTR_TYPE),
      idx: getAttrValue(ph, ATTR_IDX),
    });
  }

  // Shape-id allocator: id=1 is the slide-root group, id=2+ are the
  // placeholder stubs. The emission order is `nvGrpSpPr` (root
  // group metadata) → `grpSpPr` (root group properties) → placeholder
  // shapes as siblings, following the CT_GroupShape sequence.
  let nextShapeId = 2;
  const stubs: XmlElement[] = [];
  for (const ph of placeholders) {
    stubs.push(buildPlaceholderStub(nextShapeId, ph.type, ph.idx));
    nextShapeId++;
  }

  const spTree = elem(NAME_SP_TREE, {
    children: [buildNvGrpSpPr(1), buildGrpSpPr(), ...stubs],
  });
  const cSld = elem(NAME_CSLD, { children: [spTree] });
  const sld = elem(NAME_SLD, {
    prefixDecls: new Map([
      ["a", NS.dml],
      ["r", NS.officeDocRels],
      ["p", NS.pml],
    ]),
    children: [cSld],
  });
  return {
    kind: "document",
    decl: { version: "1.0", encoding: "UTF-8", standalone: "yes" },
    prolog: [],
    root: sld,
    epilog: [],
  };
};

// `nvGrpSpPr` for the slide root group: id=1, name="" (readers expect
// the empty name; other writers' non-empty names get treated as quirky).
const buildNvGrpSpPr = (id: number): XmlElement =>
  elem(NAME_NV_GRP_SP_PR, {
    children: [
      elem(NAME_C_NV_PR, {
        attrs: [attr(ATTR_ID, String(id)), attr(ATTR_NAME, "")],
      }),
      elem(NAME_C_NV_GRP_SP_PR),
      elem(NAME_NV_PR),
    ],
  });

const buildGrpSpPr = (): XmlElement => elem(NAME_GRP_SP_PR);

// Returns a placeholder-shape stub: <p:sp> with cNvPr, nvSpPr, ph, empty
// spPr, and an empty txBody. Geometry, fill, and default style all flow
// from the corresponding layout placeholder via inheritance.
const buildPlaceholderStub = (
  id: number,
  phType: string | null,
  phIdx: string | null,
): XmlElement => {
  const phAttrs = [];
  if (phType !== null) phAttrs.push(attr(ATTR_TYPE, phType));
  if (phIdx !== null) phAttrs.push(attr(ATTR_IDX, phIdx));

  const ph = elem(NAME_PH, { attrs: phAttrs });
  const nvPr = elem(NAME_NV_PR, { children: [ph] });
  const cNvSpPr = elem(NAME_C_NV_SP_PR, {
    children: [elem(NAME_SP_LOCKS, { attrs: [attr(ATTR_NO_GRP, "1")] })],
  });
  const name = inferPlaceholderName(id, phType);
  const cNvPr = elem(NAME_C_NV_PR, {
    attrs: [attr(ATTR_ID, String(id)), attr(ATTR_NAME, name)],
  });
  const nvSpPr = elem(NAME_NV_SP_PR, { children: [cNvPr, cNvSpPr, nvPr] });
  const spPr = elem(NAME_SP_PR);
  const txBody = elem(NAME_TX_BODY, {
    children: [
      elem(NAME_BODY_PR),
      elem(NAME_LST_STYLE),
      elem(NAME_P, { children: [textNode("")] }),
    ],
  });
  return elem(NAME_SP, { children: [nvSpPr, spPr, txBody] });
};

/**
 * Maps a placeholder type to a conventional human-readable name. The
 * `id` becomes part of the name to keep them unique within the slide.
 */
const inferPlaceholderName = (id: number, phType: string | null): string => {
  switch (phType) {
    case "title":
      return `Title ${id - 1}`;
    case "ctrTitle":
      return `Centered Title ${id - 1}`;
    case "subTitle":
      return `Subtitle ${id - 1}`;
    case "body":
      return `Content Placeholder ${id - 1}`;
    case "pic":
      return `Picture Placeholder ${id - 1}`;
    case "chart":
      return `Chart Placeholder ${id - 1}`;
    case "tbl":
      return `Table Placeholder ${id - 1}`;
    case "dt":
      return `Date Placeholder ${id - 1}`;
    case "sldNum":
      return `Slide Number Placeholder ${id - 1}`;
    case "ftr":
      return `Footer Placeholder ${id - 1}`;
    case "hdr":
      return `Header Placeholder ${id - 1}`;
    case null:
    case "obj":
      return `Content Placeholder ${id - 1}`;
    default:
      return `Placeholder ${id - 1}`;
  }
};
