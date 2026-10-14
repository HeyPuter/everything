import { resolveTarget } from "../../internal/opc/index.ts";
import { readOnlyPartRoot } from "../../internal/parts/read-only-xml.ts";
import {
  REL_TYPES,
  readShapeTreeFromCsldRoot,
  type SlideShape,
} from "../../internal/presentationml/index.ts";
import {
  NS,
  firstChildElement,
  getAttrValue,
  qname,
  type XmlElement,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  LAYOUT_PART,
  LAYOUT_PART_NAME,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SLIDE_DOCUMENT,
  SLIDE_PART_NAME,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { getSlideLayout } from "./shape-slide-read.ts";

const child = (el: XmlElement, name: string): XmlElement | null =>
  firstChildElement(el, qname("p", name, NS.pml));
const value = (el: XmlElement, name: string): string | null =>
  getAttrValue(el, qname("", name, ""));

const placeholder = (el: XmlElement): XmlElement | null => {
  for (const name of ["nvSpPr", "nvPicPr", "nvCxnSpPr", "nvGraphicFramePr"]) {
    const nv = child(el, name);
    const props = nv && child(nv, "nvPr");
    const ph = props && child(props, "ph");
    if (ph) return ph;
  }
  return null;
};

/** Layout content slots map to the master's body placeholder. */
export const masterPlaceholderType = (type: string): string => {
  switch (type) {
    case "ctrTitle":
      return "title";
    case "obj":
    case "subTitle":
    case "chart":
    case "tbl":
    case "pic":
    case "media":
    case "dgm":
    case "clipArt":
      return "body";
    default:
      return type;
  }
};

interface PlaceholderInheritance {
  readonly layout: SlideShape | null;
  readonly master: SlideShape | null;
  readonly masterRoot: XmlElement | null;
  readonly masterType: string;
}

// Master roots come from readOnlyPartRoot. Replacing a part's bytes produces
// a new root, so indexing by root identity cannot retain stale placeholders.
// Keep relationship resolution outside this cache: rebinding a layout must
// immediately select the new master. Weak keys do not retain closed decks.
const masterPlaceholders = new WeakMap<
  XmlElement,
  ReadonlyMap<string, SlideShape>
>();
const masterPlaceholder = (
  root: XmlElement,
  type: string,
): SlideShape | null => {
  let byType = masterPlaceholders.get(root);
  if (!byType) {
    const index = new Map<string, SlideShape>();
    for (const shape of readShapeTreeFromCsldRoot(root, "sldMaster").shapes) {
      const ph = placeholder(shape.element);
      if (!ph) continue;
      const type = value(ph, "type") ?? "obj";
      // Preserve the original first-in-document-order lookup for duplicate
      // types, including placeholders nested inside groups.
      if (!index.has(type)) index.set(type, shape);
    }
    byType = index;
    masterPlaceholders.set(root, byType);
  }
  return byType.get(type) ?? null;
};

/**
 * Read-only placeholder ancestry. Slide → layout matches idx (default 0),
 * as specified by MS-OI29500 19.3.1.36. Layout → master matches semantic type;
 * its idx belongs to a different namespace and must never select a master slot.
 * Inspect p:ph itself: omitted attributes are valid, unlike a non-placeholder.
 */
export const getPlaceholderInheritance = (
  shape: SlideShapeData,
): PlaceholderInheritance | null => {
  let ph = placeholder(shape[SHAPE_ELEMENT]);
  if (!ph) return null;
  const slide = shape[SHAPE_SLIDE];
  const rootKind = slide[SLIDE_DOCUMENT].root.name.localName;
  let layoutName = slide[SLIDE_PART_NAME];
  let layoutShape: SlideShape | null = null;
  if (rootKind === "sld") {
    const layout = getSlideLayout(slide);
    if (!layout) return null;
    const idx = Number(value(ph, "idx") ?? "0");
    // MS-OI29500 exempts the unassigned index (0xffffffff) from index matching.
    // The native reference bypasses layout properties altogether in this case,
    // inheriting directly from the master by the slide placeholder's type.
    if (idx !== 0xffffffff) {
      layoutShape =
        layout[LAYOUT_PART].shapes.find((candidate) => {
          const candidatePh = placeholder(candidate.element);
          return (
            candidatePh && Number(value(candidatePh, "idx") ?? "0") === idx
          );
        }) ?? null;
      if (!layoutShape) return null;
      ph = placeholder(layoutShape.element)!;
    }
    layoutName = layout[LAYOUT_PART_NAME];
  } else if (rootKind === "sldMaster" || rootKind === "notesMaster") {
    // A master's own placeholders take the text styles of the master they
    // are on; no other part sits above them.
    return {
      layout: null,
      master: null,
      masterRoot: slide[SLIDE_DOCUMENT].root,
      masterType: masterPlaceholderType(value(ph, "type") ?? "obj"),
    };
  } else if (rootKind !== "sldLayout") return null;

  const masterType = masterPlaceholderType(value(ph, "type") ?? "obj");
  const pkg = slide[INTERNAL_PACKAGE];
  const rel = pkg
    .getRels(layoutName)
    ?.items.find(
      (r) => r.type === REL_TYPES.slideMaster && r.targetMode !== "External",
    );
  const part = rel && pkg.getPart(resolveTarget(layoutName, rel.target));
  const masterRoot = part ? readOnlyPartRoot(part) : null;
  const master = masterRoot ? masterPlaceholder(masterRoot, masterType) : null;
  return { layout: layoutShape, master, masterRoot, masterType };
};
