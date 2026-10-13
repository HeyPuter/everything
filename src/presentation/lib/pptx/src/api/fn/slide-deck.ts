// Deck manipulation: add, remove, reorder, duplicate, import, merge.

import {
  type PartName,
  dirname,
  emptyRels,
  nextRelId,
  partName,
  relsPartNameFor,
  resolveTarget,
} from "../../internal/opc/index.ts";
import type { OpcPackage } from "../../internal/parts/index.ts";
import {
  REL_TYPES,
  buildSlideFromLayout,
} from "../../internal/presentationml/index.ts";
import {
  NS,
  type XmlDocument,
  type XmlElement,
  allChildElements,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  parseXml,
  serializeXml,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  LAYOUT_PART,
  LAYOUT_PART_NAME,
  type PresentationData,
  SLIDE_DOCUMENT,
  SLIDE_PART_NAME,
  type SlideData,
  type SlideLayoutData,
} from "../_internal-symbols.ts";
import {
  ATTR_ID,
  ATTR_R_ID,
  NAME_CSLD,
  NAME_PRESENTATION,
  NAME_SLD_ID,
  NAME_SLD_ID_LST,
  NAME_SLD_MASTER_ID_LST,
  NAME_SP_TREE,
  PRES_PART_NAME,
  SLD_ID_MAX,
  SLD_ID_MIN,
  SLIDE_CONTENT_TYPE,
  decode,
  encode,
} from "./_helpers.ts";
import {
  findSlideLayoutByType,
  getSlideLayoutType,
  getSlideLayouts,
  getSlideLayoutPlaceholders,
} from "./layouts.ts";
import { getSlides } from "./slide-query.ts";
import { readSlideEntries, requireUniqueSlideEntries } from "./slide-list.ts";
import { setSlideBody, setSlideTitle } from "./embedded.ts";
import {
  createTextStyleCopy,
  preserveImportedText,
  importTextReferences,
} from "./text-style-import.ts";
import { preserveImportedGeometry } from "./shape-geometry-import.ts";
import {
  createPaintStyleCopy,
  preserveImportedPaint,
} from "./paint-style-import.ts";
import { preserveImportedTableStyles } from "./table-style-import.ts";
import { createTextFieldCopy } from "./text-field-copy.ts";
import {
  copyDiagramRelationships,
  isDiagramRelationship,
} from "./diagram-copy.ts";
import { copyChartRelationships } from "./chart-copy.ts";
import { detachCopiedSlideComments } from "./comment-threads.ts";
import { withPackageTransaction } from "../../internal/parts/package-transaction.ts";
import { copyPartGraph } from "../../internal/parts/copy-graph.ts";

const SLIDE_RESOURCE_TYPES = new Set<string>([
  REL_TYPES.image,
  REL_TYPES.audio,
  REL_TYPES.video,
  REL_TYPES.media,
]);

const withDeckCopy = <T>(pres: PresentationData, operation: () => T): T => {
  const previous = pres._slidesCache;
  try {
    return withPackageTransaction(pres[INTERNAL_PACKAGE], operation);
  } catch (error) {
    pres._slidesCache = previous;
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Deck manipulation.

const mutableSlideList = (pres: PresentationData) => {
  const pkg = pres[INTERNAL_PACKAGE];
  const presPart = pkg.getPart(PRES_PART_NAME);
  if (!presPart) throw new Error("presentation.xml missing");
  const presRels = pkg.getRels(PRES_PART_NAME);
  if (!presRels) throw new Error("presentation.xml has no rels");
  const presDoc = parseXml(decode(presPart.data));
  const { list, entries } = readSlideEntries(pkg, presDoc.root, presRels);
  requireUniqueSlideEntries(entries, presRels);
  const byName = new Map(entries.map((e) => [e.part.name.toLowerCase(), e]));
  return { pkg, presPart, presRels, presDoc, list, entries, byName };
};

const entryForSlide = (
  context: ReturnType<typeof mutableSlideList>,
  slide: SlideData,
) => {
  if (slide[INTERNAL_PACKAGE] !== context.pkg)
    throw new Error("slide belongs to another presentation");
  const entry = context.byName.get(slide[SLIDE_PART_NAME].toLowerCase());
  if (!entry) throw new Error("slide is not in this presentation's order");
  return entry;
};

const ensureSldIdLst = (presentationRoot: XmlElement): XmlElement => {
  const existing = firstChildElement(presentationRoot, NAME_SLD_ID_LST);
  if (existing !== null) return existing;
  const fresh = elem(NAME_SLD_ID_LST);
  const masterLst = firstChildElement(presentationRoot, NAME_SLD_MASTER_ID_LST);
  if (masterLst === null) {
    presentationRoot.children.unshift(fresh);
    return fresh;
  }
  const idx = presentationRoot.children.indexOf(masterLst);
  presentationRoot.children.splice(idx + 1, 0, fresh);
  return fresh;
};

const allocateSldId = (sldIdLst: XmlElement): number => {
  let max = SLD_ID_MIN - 1;
  for (const sldId of allChildElements(sldIdLst, NAME_SLD_ID)) {
    const raw = getAttrValue(sldId, ATTR_ID);
    if (raw === null) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const next = Math.max(SLD_ID_MIN, max + 1);
  if (next > SLD_ID_MAX) {
    throw new Error(
      `sldId allocator exhausted (next would be ${next}, max ${SLD_ID_MAX})`,
    );
  }
  return next;
};

const allocateSlideN = (pkg: OpcPackage): number => {
  let next = 1;
  for (const p of pkg.parts) {
    const m = p.name.match(/^\/ppt\/slides\/slide(\d+)\.xml$/);
    if (m?.[1] !== undefined) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= next) next = n + 1;
    }
  }
  return next;
};

const requirePresentationDoc = (pkg: OpcPackage): XmlDocument => {
  const presPart = pkg.getPart(PRES_PART_NAME);
  if (!presPart) throw new Error("presentation.xml is missing");
  const doc = parseXml(decode(presPart.data));
  if (
    doc.root.name.namespaceURI !== NAME_PRESENTATION.namespaceURI ||
    doc.root.name.localName !== "presentation"
  ) {
    throw new Error("presentation.xml root is not <p:presentation>");
  }
  return doc;
};

/**
 * Adds a new slide bound to `layout`. Returns the new `SlideData`.
 *
 * Allocates a fresh part name, sldId, and rId; clones layout
 * placeholders into the slide; writes `[Content_Types].xml`, the
 * slide's `.rels`, presentation's `.rels`, and `<p:sldIdLst>`. The
 * deck-cache on `pres` is invalidated so the next `getSlides` call
 * sees the new entry.
 */
/**
 * Convenience over `addSlide` that picks a layout automatically:
 *
 *   1. The layout with `<p:sldLayout type="blank">`, if present.
 *   2. Otherwise, the first available layout (alphabetical by
 *      part name).
 *
 * Throws when the package carries no layouts at all (which would
 * be a structurally-broken deck).
 */
export const addBlankSlide = (pres: PresentationData): SlideData => {
  const blank = findSlideLayoutByType(pres, "blank");
  if (blank) return addSlide(pres, { layout: blank });
  const layouts = getSlideLayouts(pres);
  if (layouts.length === 0) {
    throw new Error(
      "addBlankSlide: package has no slide layouts to inherit from",
    );
  }
  return addSlide(pres, { layout: layouts[0]! });
};

/**
 * Sugar over `addSlide` + `setSlideTitle` + `setSlideBody` for the
 * "title + body" pattern. Picks the `obj` (Title and Content)
 * layout when present, falling back to the first layout with a
 * body placeholder.
 *
 * Throws if no layout in the package offers a body slot.
 */
export const addContentSlide = (
  pres: PresentationData,
  opts: { title?: string; body?: string },
): SlideData => {
  const objLayout = findSlideLayoutByType(pres, "obj");
  const layout =
    objLayout ??
    getSlideLayouts(pres).find((l) =>
      getSlideLayoutPlaceholders(l).some(
        (p) => p.type === null || p.type === "body",
      ),
    );
  if (!layout) {
    throw new Error("addContentSlide: no layout with a body placeholder found");
  }
  const slide = addSlide(pres, { layout });
  if (opts.title !== undefined) setSlideTitle(slide, opts.title);
  if (opts.body !== undefined) setSlideBody(slide, opts.body);
  return slide;
};

/**
 * Sugar over `addSlide` + `setSlideTitle` for the section-divider
 * pattern. Picks `<p:sldLayout type="secHead">` when present (the
 * section-header layout); otherwise falls back to a
 * `title`-typed layout or the first available layout.
 */
export const addSectionHeaderSlide = (
  pres: PresentationData,
  title: string,
): SlideData => {
  const layout =
    findSlideLayoutByType(pres, "secHead") ??
    findSlideLayoutByType(pres, "title") ??
    getSlideLayouts(pres)[0];
  if (!layout) {
    throw new Error(
      "addSectionHeaderSlide: package has no slide layouts to inherit from",
    );
  }
  const slide = addSlide(pres, { layout });
  setSlideTitle(slide, title);
  return slide;
};

/**
 * Sugar over `addSlide` + `setSlideTitle` for the common
 * "title slide + set heading" pattern. Picks the `title` layout
 * first, then falls back to the first non-blank layout.
 *
 * Throws when the package carries no layouts at all.
 */
export const addTitleSlide = (
  pres: PresentationData,
  title: string,
): SlideData => {
  const titleLayout =
    findSlideLayoutByType(pres, "title") ??
    findSlideLayoutByType(pres, "obj") ??
    null;
  const layout =
    titleLayout ??
    getSlideLayouts(pres).find((l) => getSlideLayoutType(l) !== "blank") ??
    getSlideLayouts(pres)[0];
  if (!layout) {
    throw new Error(
      "addTitleSlide: package has no slide layouts to inherit from",
    );
  }
  const slide = addSlide(pres, { layout });
  setSlideTitle(slide, title);
  return slide;
};

export const addSlide = (
  pres: PresentationData,
  options: { layout: SlideLayoutData },
): SlideData => {
  const pkg = pres[INTERNAL_PACKAGE];
  const layout = options.layout;
  const layoutPart = layout[LAYOUT_PART];
  const layoutPartName = layout[LAYOUT_PART_NAME];

  const presDoc = requirePresentationDoc(pkg);
  const presPart = pkg.getPart(PRES_PART_NAME);
  if (!presPart) throw new Error("presentation.xml is missing");

  const sldIdLst = ensureSldIdLst(presDoc.root);
  const newSldId = allocateSldId(sldIdLst);
  const slideN = allocateSlideN(pkg);
  const newSlidePartName = partName(`/ppt/slides/slide${slideN}.xml`);

  const layoutCsld = firstChildElement(layoutPart.root, NAME_CSLD);
  if (!layoutCsld) throw new Error(`layout ${layoutPartName} missing <p:cSld>`);
  const layoutSpTree = firstChildElement(layoutCsld, NAME_SP_TREE);
  if (!layoutSpTree)
    throw new Error(`layout ${layoutPartName} missing <p:spTree>`);

  const slideDoc = buildSlideFromLayout(layoutSpTree);
  const slideBytes = encode(serializeXml(slideDoc));
  pkg.addPart(newSlidePartName, SLIDE_CONTENT_TYPE, slideBytes);

  const slideRels = emptyRels();
  slideRels.items.push({
    id: "rId1",
    type: REL_TYPES.slideLayout,
    target: layoutPartName,
    targetMode: "Internal",
  });
  pkg.setRels(newSlidePartName, slideRels);

  const presRels = pkg.getRels(PRES_PART_NAME) ?? emptyRels();
  const newRId = nextRelId(presRels.items.map((r) => r.id));
  presRels.items.push({
    id: newRId,
    type: REL_TYPES.slide,
    target: `slides/slide${slideN}.xml`,
    targetMode: "Internal",
  });
  pkg.setRels(PRES_PART_NAME, presRels);

  sldIdLst.children.push(
    elem(NAME_SLD_ID, {
      attrs: [attr(ATTR_ID, String(newSldId)), attr(ATTR_R_ID, newRId)],
    }),
  );
  presPart.data = encode(serializeXml(presDoc));

  pres._slidesCache = null;
  const slides = getSlides(pres);
  const last = slides[slides.length - 1];
  if (!last)
    throw new Error("addSlide: post-condition failed; slide not in cache");
  return last;
};

/**
 * Removes the given slide from the deck. Removes the `<p:sldId>`, the
 * `presentation.xml.rels` entry, and the slide part + its `.rels` part.
 *
 * Media parts are intentionally NOT cleaned up — they may be shared
 * with other slides. The freed `sldId` is NOT reused on subsequent
 * `addSlide` calls (reader compatibility, see plan §Risks).
 */
export const removeSlide = (pres: PresentationData, slide: SlideData): void => {
  const context = mutableSlideList(pres);
  const { pkg, presPart, presRels, presDoc, list } = context;
  const { element, rel, part } = entryForSlide(context, slide);
  // Validate everything above before changing either relationship or slide data.
  list!.children = list!.children.filter((c) => c !== element);
  presRels.items = presRels.items.filter((r) => {
    if (r.id === rel.id) return false;
    if (r.type !== REL_TYPES.slide || r.targetMode === "External") return true;
    // Also remove unused aliases to this part, so deleting the slide does not
    // leave new dangling presentation relationships.
    try {
      return (
        resolveTarget(PRES_PART_NAME, r.target).toLowerCase() !==
        part.name.toLowerCase()
      );
    } catch {
      return true; // Unrelated, unreferenced malformed relationships stay intact.
    }
  });
  presPart.data = encode(serializeXml(presDoc));
  pkg.setRels(PRES_PART_NAME, presRels);
  pkg.removePart(relsPartNameFor(part.name));
  pkg.removePart(part.name);
  pres._slidesCache = null;
};

/**
 * Reorders every slide in the deck via a custom comparator. The
 * comparator is invoked with two `SlideData` handles and returns the
 * usual `Array.prototype.sort` ordering (-1 / 0 / 1).
 *
 *   sortSlides(pres, (a, b) => getSlideTitle(a)?.localeCompare(getSlideTitle(b) ?? '') ?? 0);
 *
 * Internally walks `<p:sldIdLst>` and re-emits its `<p:sldId>` children
 * in the new order. Slide parts and rels are untouched — only the
 * order in which they play changes.
 */
export const sortSlides = (
  pres: PresentationData,
  compareFn: (a: SlideData, b: SlideData) => number,
): void => {
  const context = mutableSlideList(pres);
  const { presPart, presDoc, list, entries } = context;
  if (!list) return;
  const sorted = [...getSlides(pres)].sort(compareFn);
  const ordered = sorted.map((slide) => entryForSlide(context, slide).element);
  if (
    ordered.length !== entries.length ||
    new Set(ordered).size !== entries.length
  )
    throw new Error("presentation slide order changed while sorting");
  // Keep comments, whitespace and extension nodes in their original slots.
  const elements = new Set(entries.map((e) => e.element));
  let i = 0;
  list.children = list.children.map((c) =>
    c.kind === "element" && elements.has(c) ? ordered[i++]! : c,
  );
  presPart.data = encode(serializeXml(presDoc));
  pres._slidesCache = null;
};

/**
 * Reverses the slide order across the whole deck. Built on
 * `sortSlides` for predictable rels behavior.
 */
export const reverseSlides = (pres: PresentationData): void => {
  const indexBy = new Map<SlideData, number>();
  for (const [i, slide] of getSlides(pres).entries()) indexBy.set(slide, i);
  sortSlides(pres, (a, b) => (indexBy.get(b) ?? 0) - (indexBy.get(a) ?? 0));
};

/**
 * Swaps the positions of the slides at `indexA` and `indexB`.
 * No-op when the indices are equal. Throws on out-of-range indices.
 * Implemented on top of `moveSlide` for predictable rels behavior.
 */
export const swapSlides = (
  pres: PresentationData,
  indexA: number,
  indexB: number,
): void => {
  if (indexA === indexB) return;
  const slides = getSlides(pres);
  const a = slides[indexA];
  const b = slides[indexB];
  if (!a)
    throw new RangeError(
      `swapSlides: indexA ${indexA} out of range (have ${slides.length})`,
    );
  if (!b)
    throw new RangeError(
      `swapSlides: indexB ${indexB} out of range (have ${slides.length})`,
    );
  // Move the lower-index slide to the higher index first so the
  // remaining slide stays at its original index.
  const [lo, hi] = indexA < indexB ? [indexA, indexB] : [indexB, indexA];
  moveSlide(pres, slides[lo]!, hi);
  // After the first move, the slide originally at hi is now at hi-1.
  const refreshed = getSlides(pres);
  moveSlide(pres, refreshed[hi - 1]!, lo);
};

/**
 * Reorders a slide. The slide's identity (part, rels, sldId) is
 * unchanged — only `<p:sldIdLst>`'s child order changes.
 */
export const moveSlide = (
  pres: PresentationData,
  slide: SlideData,
  toIndex: number,
): void => {
  const context = mutableSlideList(pres);
  const { presPart, presDoc, list: sldIdLst } = context;
  const { element: target } = entryForSlide(context, slide);
  if (!sldIdLst) throw new Error("presentation.xml has no <p:sldIdLst>");

  const remaining = sldIdLst.children.filter((c) => c !== target);
  const remainingSldIds = remaining.filter(
    (c): c is XmlElement =>
      c.kind === "element" &&
      c.name.namespaceURI === NS.pml &&
      c.name.localName === "sldId",
  );
  const clamped = Math.max(0, Math.min(toIndex, remainingSldIds.length));
  if (clamped === remainingSldIds.length) {
    remaining.push(target);
  } else {
    const before = remainingSldIds[clamped];
    const insertAt =
      before === undefined ? remaining.length : remaining.indexOf(before);
    remaining.splice(insertAt, 0, target);
  }
  sldIdLst.children = remaining;
  presPart.data = encode(serializeXml(presDoc));
  pres._slidesCache = null;
};

/**
 * Duplicates a slide. Returns the new `SlideData` appended to deck order.
 *
 * Part bytes are cloned, rebasing text-field identity collisions. Relationships
 * retain their destinations even if the source lives in another directory;
 * media parts are shared. Charts and diagrams get independent dependency graphs;
 * diagrams share one field mapping between semantic data and saved drawings.
 */
export const duplicateSlide = (
  pres: PresentationData,
  slide: SlideData,
): SlideData => withDeckCopy(pres, () => duplicateSlideUnchecked(pres, slide));

const duplicateSlideUnchecked = (
  pres: PresentationData,
  slide: SlideData,
): SlideData => {
  const context = mutableSlideList(pres);
  const { pkg, presPart, presDoc, presRels } = context;
  const { part: sourcePart } = entryForSlide(context, slide);
  const sourcePartName = sourcePart.name;
  const sldIdLst = context.list!;
  const sourceRels = pkg.getRels(sourcePartName);
  // A slide can live outside /ppt/slides. Keep internal targets attached to
  // the same parts when the duplicate is placed in the standard directory.
  const copiedRels = sourceRels && {
    items: sourceRels.items.map((r) => ({
      ...r,
      target:
        r.targetMode === "External" || dirname(sourcePartName) === "/ppt/slides"
          ? r.target
          : resolveTarget(sourcePartName, r.target),
    })),
  };
  const newSldId = allocateSldId(sldIdLst);

  const slideN = allocateSlideN(pkg);
  const newSlidePartName = partName(`/ppt/slides/slide${slideN}.xml`);
  // Validate all slide allocations/targets before a diagram graph can mutate
  // the package, including exhausted sldId space.
  const fieldCopy = createTextFieldCopy(pkg);
  const body = fieldCopy.bytes(sourcePart);
  const diagrams = sourceRels
    ? copyDiagramRelationships(
        pkg,
        sourcePartName,
        sourceRels,
        pkg,
        (id) => id,
        undefined,
        undefined,
        fieldCopy,
      )
    : null;
  if (diagrams && copiedRels)
    copiedRels.items = copiedRels.items.map((r) => ({
      ...r,
      target: diagrams.get(r.id)?.target ?? r.target,
    }));
  const charts = sourceRels
    ? copyChartRelationships(
        pkg,
        sourcePartName,
        sourceRels,
        pkg,
        (id) => id,
        undefined,
        undefined,
        fieldCopy,
      )
    : null;
  if (charts && copiedRels)
    copiedRels.items = copiedRels.items.map((r) => ({
      ...r,
      target: charts.get(r.id)?.target ?? r.target,
    }));
  pkg.addPart(newSlidePartName, sourcePart.contentType, new Uint8Array(body));

  if (copiedRels) pkg.setRels(newSlidePartName, copiedRels);

  const newRId = nextRelId(presRels.items.map((r) => r.id));
  presRels.items.push({
    id: newRId,
    type: REL_TYPES.slide,
    target: `slides/slide${slideN}.xml`,
    targetMode: "Internal",
  });
  pkg.setRels(PRES_PART_NAME, presRels);

  sldIdLst.children.push(
    elem(NAME_SLD_ID, {
      attrs: [attr(ATTR_ID, String(newSldId)), attr(ATTR_R_ID, newRId)],
    }),
  );
  presPart.data = encode(serializeXml(presDoc));

  pres._slidesCache = null;
  const slides = getSlides(pres);
  const dup = slides[slides.length - 1];
  if (!dup) throw new Error("duplicateSlide: post-condition failed");
  // A copy starts without comments, and never shares its source's part.
  detachCopiedSlideComments(dup);
  return dup;
};

/**
 * Convenience over `addSlide` + `moveSlide`. Inserts the new slide
 * at the given 0-based index (clamped to `[0, getSlides(pres).length]`).
 */
export const addSlideAt = (
  pres: PresentationData,
  atIndex: number,
  options: { layout: SlideLayoutData },
): SlideData => {
  const slide = addSlide(pres, options);
  moveSlide(pres, slide, atIndex);
  const slides = getSlides(pres);
  const clamped = Math.max(0, Math.min(atIndex, slides.length - 1));
  return slides[clamped]!;
};

/**
 * Convenience over `duplicateSlide` + `moveSlide`. Duplicates `slide`
 * and inserts the duplicate at `atIndex` instead of at the end.
 */
export const duplicateSlideAt = (
  pres: PresentationData,
  atIndex: number,
  slide: SlideData,
): SlideData => {
  const dup = duplicateSlide(pres, slide);
  moveSlide(pres, dup, atIndex);
  const slides = getSlides(pres);
  const clamped = Math.max(0, Math.min(atIndex, slides.length - 1));
  return slides[clamped]!;
};

// Collects every relationship id referenced (r:id / r:embed / r:link) anywhere
// in `el`'s subtree. Relationship-typed attributes live in the officeDocRels
// namespace regardless of local name.
const collectRelRefs = (el: XmlElement, into: Set<string>): void => {
  for (const a of el.attrs) {
    if (a.name.namespaceURI === NS.officeDocRels) into.add(a.value);
  }
  for (const c of el.children) {
    if (c.kind === "element") collectRelRefs(c, into);
  }
};

// importSlide carries images, hyperlinks, charts and diagrams across. OLE
// is still unsupported here. A `<p:graphicFrame>` that
// still points at a dropped rel would be a dangling r:id — readers report
// the whole package corrupt. Drop those frames so the imported slide stays valid
// Unsupported frames are removed only when their relationships were dropped.
// Chart relationships and complete native graphs are retained. Recurses through groups.
const pruneDanglingGraphicFrames = (
  el: XmlElement,
  keptRelIds: Set<string>,
): void => {
  el.children = el.children.filter((c) => {
    if (c.kind !== "element") return true;
    if (c.name.namespaceURI === NS.pml && c.name.localName === "graphicFrame") {
      const refs = new Set<string>();
      collectRelRefs(c, refs);
      for (const id of refs) {
        if (!keptRelIds.has(id)) return false;
      }
    }
    return true;
  });
  for (const c of el.children) {
    if (c.kind === "element") pruneDanglingGraphicFrames(c, keptRelIds);
  }
};

/**
 * Imports a slide from another presentation into `targetPres`. The
 * slide's body is copied; image, audio, video and media relationships retain
 * their resource sharing and content types with collision-safe part names.
 * External resources remain linked and are never fetched. A missing internal
 * resource rejects the transfer atomically. The new slide is bound to the
 * supplied `targetLayout` so it still renders without the original deck's
 * layouts. Table styles are inlined
 * with source theme colors and fonts so target style IDs cannot alter them.
 * Set `preserveTextFormatting` to keep source text-body, paragraph and run
 * styles when changing templates (used by the object clipboard). By default,
 * text continues to inherit the supplied layout and destination theme.
 * Diagram palettes, explicit colors and authored theme-font typefaces participate
 * in these options. Diagram paint preservation imports referenced theme matrix
 * entries; implicit diagram fontRef defaults are not materialized yet.
 * `preservePaintFormatting` similarly retains source fills, outlines and
 * effects, resolving style-matrix and theme references to native properties.
 * Inherited geometry and bounds are made local by default for copies into a
 * different layout. Set `preserveGeometry: false` to keep the authored geometry
 * hierarchy, for example when using a layout copied by `importSlideTemplate`.
 * Local paths, adjustments and transform components remain unchanged; missing
 * properties continue to follow the supplied template, including future edits.
 * SmartArt retains its semantic data, layout, styles, saved drawing and their
 * dependencies. Charts retain their ChartML, workbook, styling, images and
 * extension graphs; formatting preservation retains native theme overrides.
 *
 * Limitations (v1):
 *
 *   - Image, audio, video, chart and diagram dependencies are copied. Other
 *     slide rels (oleObjects, comments) are dropped from the imported slide.
 *   - Hyperlinks (external URLs) are preserved.
 *   - Slide → notesSlide is dropped (notes don't follow imports).
 *
 * Returns the new `SlideData` appended to `targetPres`.
 */
export const importSlide = (
  targetPres: PresentationData,
  sourceSlide: SlideData,
  targetLayout: SlideLayoutData,
  options: {
    preserveTextFormatting?: boolean;
    preservePaintFormatting?: boolean;
    preserveGeometry?: boolean;
  } = {},
): SlideData =>
  withDeckCopy(targetPres, () =>
    importSlideUnchecked(targetPres, sourceSlide, targetLayout, options),
  );

const importSlideUnchecked = (
  targetPres: PresentationData,
  sourceSlide: SlideData,
  targetLayout: SlideLayoutData,
  options: {
    preserveTextFormatting?: boolean;
    preservePaintFormatting?: boolean;
    preserveGeometry?: boolean;
  },
): SlideData => {
  const sourcePkg = sourceSlide[INTERNAL_PACKAGE];
  const sourcePartName = sourceSlide[SLIDE_PART_NAME];
  const sourcePart = sourcePkg.getPart(sourcePartName);
  if (!sourcePart)
    throw new Error(`importSlide: source ${sourcePartName} not found`);
  const sourceRels = sourcePkg.getRels(sourcePartName);

  const targetPkg = targetPres[INTERNAL_PACKAGE];
  const layoutPartName = targetLayout[LAYOUT_PART_NAME];
  if (targetPkg.getPart(layoutPartName) === null) {
    throw new Error(
      `importSlide: layout ${layoutPartName} not in target package`,
    );
  }
  const presPart = targetPkg.getPart(PRES_PART_NAME);
  if (!presPart) throw new Error("presentation.xml missing in target");
  const presDoc = parseXml(decode(presPart.data));
  const sldIdLst = ensureSldIdLst(presDoc.root);
  const newSldId = allocateSldId(sldIdLst);
  const fieldCopy = createTextFieldCopy(targetPkg);

  const slideN = allocateSlideN(targetPkg);
  const newSlidePartName = partName(`/ppt/slides/slide${slideN}.xml`);

  // Copy the source slide bytes verbatim.
  targetPkg.addPart(
    newSlidePartName,
    sourcePart.contentType,
    new Uint8Array(sourcePart.data),
  );

  // Build the new slide's rels:
  //   - one slideLayout pointing at the supplied target layout
  //   - image/audio/video/media rels with their native resources imported
  //   - external hyperlink rels copied verbatim
  //   - diagram rels pointing to a copy of their complete dependency graph
  const newRels = emptyRels();
  // The copied slide body keeps its original `r:embed` / `r:link` ids, so image
  // and hyperlink rels are preserved verbatim below. The layout rel is NOT
  // referenced from the body (readers resolve it by relationship type), so
  // we can give it any id — but it must not collide with a preserved source id.
  // Allocating past the source max keeps every rId on the new slide unique.
  const layoutRelId = nextRelId(sourceRels?.items.map((r) => r.id) ?? []);
  newRels.items.push({
    id: layoutRelId,
    type: REL_TYPES.slideLayout,
    target: layoutPartName,
    targetMode: "Internal",
  });

  if (sourceRels !== null) {
    // Copy all resource roots together: two relationship IDs may refer to one
    // native asset. OPC allocation reserves case-insensitive names, relationship
    // part names and dangling targets. Do not change an extension default in the
    // destination; the graph copier registers content-type overrides as needed.
    const resourceRoots = sourceRels.items
      .filter(
        (r) => SLIDE_RESOURCE_TYPES.has(r.type) && r.targetMode === "Internal",
      )
      .map((r) => resolveTarget(sourcePartName, r.target));
    const resources = resourceRoots.length
      ? copyPartGraph(sourcePkg, targetPkg, resourceRoots)
      : new Map<string, PartName>();
    let diagrams: ReturnType<typeof copyDiagramRelationships>;
    const charts = copyChartRelationships(
      sourcePkg,
      sourcePartName,
      sourceRels,
      targetPkg,
      (id) => id,
      undefined,
      { sourceSlide, ...options },
      fieldCopy,
    );
    for (const rel of sourceRels.items) {
      if (rel.type === REL_TYPES.slideLayout) continue; // handled above
      if (rel.type === REL_TYPES.notesSlide) continue;
      if (SLIDE_RESOURCE_TYPES.has(rel.type)) {
        newRels.items.push({
          ...rel,
          target:
            rel.targetMode === "External"
              ? rel.target
              : resources.get(
                  resolveTarget(sourcePartName, rel.target).toLowerCase(),
                )!,
        });
        continue;
      }
      if (rel.type === REL_TYPES.hyperlink) {
        newRels.items.push({ ...rel });
        continue;
      }
      if (rel.type === REL_TYPES.chart) {
        const chart = charts?.get(rel.id);
        if (chart) newRels.items.push(chart);
        continue;
      }
      if (isDiagramRelationship(rel.type)) {
        // Ordinary slides keep their existing import path. Diagram parts
        // need a graph copy only once, when the first diagram rel is reached.
        diagrams ??= copyDiagramRelationships(
          sourcePkg,
          sourcePartName,
          sourceRels,
          targetPkg,
          (id) => id,
          undefined,
          {
            sourceSlide,
            sourceRoot: sourceSlide[SLIDE_DOCUMENT].root,
            ...options,
            targetThemeOwner: layoutPartName,
          },
          fieldCopy,
        );
        const diagram = diagrams?.get(rel.id);
        if (diagram) newRels.items.push(diagram);
        continue;
      }
      // Other internal rels (oleObject/comments/etc) are dropped in v1.
    }
  }
  targetPkg.setRels(newSlidePartName, newRels);

  // The verbatim body may still reference a dropped rel (e.g. an OLE frame's
  // object reference). Strip any graphicFrame whose r:id is no longer in
  // the slide's rels so we never emit a dangling relationship. Only re-serialize
  // when there is actually a dangling reference, to keep the common (frame-less)
  // import byte-for-byte identical.
  const newPart = targetPkg.getPart(newSlidePartName);
  if (newPart) {
    const bodyDoc = parseXml(decode(newPart.data));
    const textCopy = createTextStyleCopy();
    const hasInheritedText =
      options.preserveTextFormatting === true &&
      preserveImportedText(sourceSlide, bodyDoc.root, textCopy);
    const hasInheritedPaint =
      options.preservePaintFormatting === true &&
      preserveImportedPaint(
        sourceSlide,
        bodyDoc.root,
        createPaintStyleCopy(textCopy.references),
      );
    if (hasInheritedText || hasInheritedPaint) {
      importTextReferences(
        bodyDoc.root,
        textCopy,
        sourcePkg,
        sourcePartName,
        targetPkg,
        newRels,
      );
      targetPkg.setRels(newSlidePartName, newRels);
    }
    const keptRelIds = new Set(newRels.items.map((r) => r.id));
    const bodyRefs = new Set<string>();
    collectRelRefs(bodyDoc.root, bodyRefs);
    let hasDangling = false;
    for (const id of bodyRefs) {
      if (!keptRelIds.has(id)) {
        hasDangling = true;
        break;
      }
    }
    const hasInheritedGeometry =
      options.preserveGeometry !== false &&
      preserveImportedGeometry(sourceSlide, bodyDoc.root);
    if (hasDangling) pruneDanglingGraphicFrames(bodyDoc.root, keptRelIds);
    const hasTableStyles = preserveImportedTableStyles(
      sourceSlide,
      bodyDoc.root,
    );
    const hasFieldCollisions = fieldCopy.rewrite(bodyDoc.root);
    if (
      hasDangling ||
      hasTableStyles ||
      hasInheritedGeometry ||
      hasInheritedText ||
      hasInheritedPaint ||
      hasFieldCollisions
    ) {
      newPart.data = encode(serializeXml(bodyDoc));
    }
  }

  // presentation → slide rel + sldIdLst entry.
  const presRels = targetPkg.getRels(PRES_PART_NAME) ?? emptyRels();
  const newRId = nextRelId(presRels.items.map((r) => r.id));
  presRels.items.push({
    id: newRId,
    type: REL_TYPES.slide,
    target: `slides/slide${slideN}.xml`,
    targetMode: "Internal",
  });
  targetPkg.setRels(PRES_PART_NAME, presRels);

  sldIdLst.children.push(
    elem(NAME_SLD_ID, {
      attrs: [attr(ATTR_ID, String(newSldId)), attr(ATTR_R_ID, newRId)],
    }),
  );
  presPart.data = encode(serializeXml(presDoc));

  targetPres._slidesCache = null;
  const slides = getSlides(targetPres);
  const last = slides[slides.length - 1];
  if (!last) throw new Error("importSlide: post-condition failed");
  // Comments stay with the source; drop the pointer at them.
  detachCopiedSlideComments(last);
  return last;
};

/**
 * Appends every slide from `sourcePres` into `targetPres`, in source
 * order. Built on top of `importSlide`: media and diagrams are propagated, charts
 * are dropped (not yet supported across decks), and the slide's
 * layout is rebound to `targetLayout` on the target side.
 *
 * `targetLayout` can be a single layout used for every imported
 * slide (common), or a function called once per source slide for
 * per-slide layout selection.
 *
 * Returns the imported slides in target order.
 */
export const mergePresentations = (
  targetPres: PresentationData,
  sourcePres: PresentationData,
  targetLayout:
    | SlideLayoutData
    | ((sourceSlide: SlideData, index: number) => SlideLayoutData),
): ReadonlyArray<SlideData> => {
  const sourceSlides = getSlides(sourcePres);
  const out: SlideData[] = [];
  const resolveLayout =
    typeof targetLayout === "function"
      ? targetLayout
      : (): SlideLayoutData => targetLayout;
  for (let i = 0; i < sourceSlides.length; i++) {
    const src = sourceSlides[i]!;
    const layout = resolveLayout(src, i);
    out.push(importSlide(targetPres, src, layout));
  }
  return out;
};
