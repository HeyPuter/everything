// Speaker notes and presentation-level aggregators.

import {
  type PartName,
  emptyRels,
  partName,
  relsPartNameFor,
  resolveTarget,
} from "../../internal/opc/index.ts";
import {
  REL_TYPES,
  buildEmptyNotesSlide,
} from "../../internal/presentationml/index.ts";
import {
  NS,
  firstChildElement,
  parseXml,
  qname,
  serializeXml,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
  SLIDE_PART_NAME,
  SLIDE_SHAPES,
  type SlideCommentData,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { NAME_CSLD, NAME_SP_TREE, decode, encode } from "./_helpers.ts";
import { setTextBody, textBodyText } from "../../internal/drawingml/index.ts";
import {
  editTextBodyRange,
  type TextBodyEdit,
} from "../../internal/drawingml/text-body-edit.ts";
import { getSlides, isSlideHidden } from "./slide-query.ts";
import { getShapeHyperlink, setShapeHyperlink } from "./shapes.ts";
import {
  type SlideChartData,
  findOverlappingShapePairs,
  getSlideCharts,
  getSlideComments,
  hasShapeImage,
  isChartShape,
  isTableShape,
} from "./embedded.ts";
import type { ChartKind } from "../../internal/chartml/index.ts";

// ---------------------------------------------------------------------------
// Speaker notes.

const findNotesPartName = (slide: SlideData): PartName | null => {
  const rels = slide[INTERNAL_PACKAGE].getRels(slide[SLIDE_PART_NAME]);
  if (!rels) return null;
  const notesRel = rels.items.find((r) => r.type === REL_TYPES.notesSlide);
  if (!notesRel) return null;
  return notesRel.target.startsWith("/")
    ? partName(notesRel.target)
    : resolveTarget(slide[SLIDE_PART_NAME], notesRel.target);
};

/**
 * Returns the slide's speaker notes (`null` if none). Pulls plain text
 * from the `body` placeholder; multi-line notes use `\n`.
 */
export const getSlideNotes = (slide: SlideData): string | null => {
  const notesPartName = findNotesPartName(slide);
  if (notesPartName === null) return null;
  const part = slide[INTERNAL_PACKAGE].getPart(notesPartName);
  if (part === null) return null;
  const root = parseXml(decode(part.data)).root;
  const cSld = firstChildElement(root, NAME_CSLD);
  if (!cSld) return null;
  const spTree = firstChildElement(cSld, NAME_SP_TREE);
  if (!spTree) return null;
  for (const child of spTree.children) {
    if (child.kind !== "element" || child.name.namespaceURI !== NS.pml)
      continue;
    if (child.name.localName !== "sp") continue;
    const nvSpPr = firstChildElement(child, qname("p", "nvSpPr", NS.pml));
    if (!nvSpPr) continue;
    const nvPr = firstChildElement(nvSpPr, qname("p", "nvPr", NS.pml));
    if (!nvPr) continue;
    const ph = firstChildElement(nvPr, qname("p", "ph", NS.pml));
    if (!ph) continue;
    const txBody = firstChildElement(child, qname("p", "txBody", NS.pml));
    if (!txBody) continue;
    const lines: string[] = [];
    for (const p of txBody.children) {
      if (
        p.kind !== "element" ||
        p.name.namespaceURI !== NS.dml ||
        p.name.localName !== "p"
      ) {
        continue;
      }
      let line = "";
      for (const r of p.children) {
        if (
          r.kind !== "element" ||
          r.name.namespaceURI !== NS.dml ||
          r.name.localName !== "r"
        ) {
          continue;
        }
        for (const tElement of r.children) {
          if (
            tElement.kind === "element" &&
            tElement.name.namespaceURI === NS.dml &&
            tElement.name.localName === "t"
          ) {
            for (const tc of tElement.children) {
              if (tc.kind === "text") line += tc.data;
            }
          }
        }
      }
      lines.push(line);
    }
    return lines.join("\n");
  }
  return null;
};

/**
 * Sets the slide's speaker notes. Creates the `notesSlide` part and
 * wires up the rels (slide ↔ notesSlide ↔ notesMaster) on first call;
 * subsequent calls just replace the body placeholder text.
 */
/**
 * Returns every slide whose `<p:sldId show="0">` flag is set —
 * complement of `getVisibleSlides`. Useful for audit UIs and
 * batch-unhide operations.
 */
export const getHiddenSlides = (
  pres: PresentationData,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    if (isSlideHidden(slide)) out.push(slide);
  }
  return out;
};

/**
 * Returns every slide in document order whose `<p:sldId show="0">`
 * flag is *not* set. Convenience over `getSlides(pres).filter(s =>
 * !isSlideHidden(s))` — useful when an export pipeline needs to
 * skip hidden slides without touching the `show` attribute itself.
 */
export const getVisibleSlides = (
  pres: PresentationData,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    if (!isSlideHidden(slide)) out.push(slide);
  }
  return out;
};

/**
 * Returns every slide carrying at least one chart graphic frame.
 * Built on `isChartShape`.
 */
export const getSlidesWithCharts = (
  pres: PresentationData,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    if (slide[SLIDE_SHAPES].some((s) => isChartShape(s))) out.push(slide);
  }
  return out;
};

/**
 * Filters `getSlidesWithCharts` to slides carrying at least one chart
 * of the given `kind` (`'bar'`, `'column'`, `'line'`, `'pie'`,
 * `'doughnut'`, `'area'`). Reads each chart's spec via `getSlideCharts`
 * so the predicate respects what the renderers actually see.
 */
export const findSlidesWithChartKind = (
  pres: PresentationData,
  kind: ChartKind,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    for (const c of getSlideCharts(slide)) {
      if (c.spec?.kind === kind) {
        out.push(slide);
        break;
      }
    }
  }
  return out;
};

/**
 * Presentation-level version of `findChartsWithTrendlines`. Returns
 * every slide carrying at least one chart with a trendline on any
 * series. Useful for "audit every trendline in this deck" workflows
 * before publishing.
 */
export const findSlidesWithChartTrendlines = (
  pres: PresentationData,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    for (const c of getSlideCharts(slide)) {
      if (c.spec === null) continue;
      if (c.spec.series.some((s) => s.trendline !== undefined)) {
        out.push(slide);
        break;
      }
    }
  }
  return out;
};

/**
 * Returns every slide where at least two shapes have overlapping
 * bounding boxes. Built on `findOverlappingShapePairs`. Useful for
 * deck-wide layout audits — surfacing slides that may have stacked
 * or accidentally-colliding content for human review.
 */
export const getSlidesWithOverlap = (
  pres: PresentationData,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    if (findOverlappingShapePairs(slide).length > 0) out.push(slide);
  }
  return out;
};

/**
 * Returns every slide carrying at least one table graphic frame.
 * Built on `isTableShape`.
 */
export const getSlidesWithTables = (
  pres: PresentationData,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    if (slide[SLIDE_SHAPES].some((s) => isTableShape(s))) out.push(slide);
  }
  return out;
};

/**
 * Returns every slide carrying at least one image-bearing shape
 * (a `<p:pic>` picture or a regular shape with `<a:blipFill>`).
 * Built on `hasShapeImage`.
 */
export const getSlidesWithImages = (
  pres: PresentationData,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    if (slide[SLIDE_SHAPES].some((s) => hasShapeImage(s))) out.push(slide);
  }
  return out;
};

/**
 * Returns every slide that has at least one comment attached.
 * Convenience over `getSlides(pres).filter(s =>
 * getSlideComments(s).length > 0)`.
 */
export const getSlidesWithComments = (
  pres: PresentationData,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    if (getSlideComments(slide).length > 0) out.push(slide);
  }
  return out;
};

/**
 * One entry per slide with non-empty notes, carrying its 0-based
 * slide index and the notes text. Useful for "export speaker
 * notes to a separate document" workflows that need both the
 * notes and the slide they belong to.
 */
export interface PresentationNotesEntry {
  readonly slideIndex: number;
  readonly notes: string;
}

/**
 * One entry per chart in the deck, carrying both the chart and the
 * 0-based slide it was attached to.
 */
export interface PresentationChartEntry {
  readonly slideIndex: number;
  readonly chart: SlideChartData;
}

/**
 * One entry per image-bearing shape in the deck, carrying the
 * shape (picture or image-filled) and the 0-based slide it lives
 * on. Sibling of `getAllCharts` / `getAllTables`.
 */
export interface PresentationImageEntry {
  readonly slideIndex: number;
  readonly shape: SlideShapeData;
}

/**
 * Returns every image-bearing shape across the deck (pictures and
 * shapes with `<a:blipFill>`), paired with its 0-based slide
 * index. Built on `hasShapeImage`.
 */
export const getAllImages = (
  pres: PresentationData,
): ReadonlyArray<PresentationImageEntry> => {
  const out: PresentationImageEntry[] = [];
  const slides = getSlides(pres);
  for (let i = 0; i < slides.length; i++) {
    for (const shape of slides[i]![SLIDE_SHAPES]) {
      if (hasShapeImage(shape)) out.push({ slideIndex: i, shape });
    }
  }
  return out;
};

/**
 * One entry per table in the deck, carrying the table shape and
 * the 0-based slide it sits on. Sibling of `getAllCharts`.
 */
export interface PresentationTableEntry {
  readonly slideIndex: number;
  readonly table: SlideShapeData;
}

/**
 * Returns every table across every slide in the deck, paired with
 * the 0-based index of its slide. Built on `isTableShape`.
 */
export const getAllTables = (
  pres: PresentationData,
): ReadonlyArray<PresentationTableEntry> => {
  const out: PresentationTableEntry[] = [];
  const slides = getSlides(pres);
  for (let i = 0; i < slides.length; i++) {
    for (const shape of slides[i]![SLIDE_SHAPES]) {
      if (isTableShape(shape)) out.push({ slideIndex: i, table: shape });
    }
  }
  return out;
};

/**
 * Returns every chart across every slide in the deck, paired with
 * the 0-based index of its slide. Useful for chart-inventory UIs
 * and bulk chart-update pipelines.
 */
export const getAllCharts = (
  pres: PresentationData,
): ReadonlyArray<PresentationChartEntry> => {
  const out: PresentationChartEntry[] = [];
  const slides = getSlides(pres);
  for (let i = 0; i < slides.length; i++) {
    for (const c of getSlideCharts(slides[i]!)) {
      out.push({ slideIndex: i, chart: c });
    }
  }
  return out;
};

/**
 * One entry per external hyperlink found in a shape's text body,
 * carrying the URL, the linked shape, and the 0-based slide index.
 * Each hyperlinked shape is reported once (the URL of its first
 * `<a:hlinkClick>` run).
 */
export interface PresentationHyperlinkEntry {
  readonly slideIndex: number;
  readonly shape: SlideShapeData;
  readonly url: string;
}

/**
 * Returns every external hyperlink in the deck — one entry per
 * shape whose text body carries an `<a:hlinkClick>`. Useful for
 * "link audit" passes before publishing, and for building a
 * deck-wide table of contents of outbound URLs.
 */
export const getAllHyperlinks = (
  pres: PresentationData,
): ReadonlyArray<PresentationHyperlinkEntry> => {
  const out: PresentationHyperlinkEntry[] = [];
  const slides = getSlides(pres);
  for (let i = 0; i < slides.length; i++) {
    for (const shape of slides[i]![SLIDE_SHAPES]) {
      const url = getShapeHyperlink(shape);
      if (url !== null) out.push({ slideIndex: i, shape, url });
    }
  }
  return out;
};

/**
 * Dense per-slide hyperlink count array. Counts shapes whose
 * `getShapeHyperlink` is non-null, mirroring `getAllHyperlinks` but
 * cheaper when the caller only wants per-slide counts. Rounds out the
 * deck-density family alongside the chart / table / image / shape /
 * text / comment counters.
 */
export const getPresentationHyperlinkCountsBySlide = (
  pres: PresentationData,
): ReadonlyArray<number> =>
  getSlides(pres).map(
    (s) =>
      s[SLIDE_SHAPES].filter((sh) => getShapeHyperlink(sh) !== null).length,
  );

/**
 * Returns every distinct external URL referenced by any shape in
 * the deck, in first-seen order. Sibling of `getAllHyperlinks`
 * (which keeps duplicates and slide indices). Useful for "are
 * these URLs all live?" audits where checking each URL once is
 * enough.
 */
export const getDistinctHyperlinkUrls = (
  pres: PresentationData,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slide of getSlides(pres)) {
    for (const shape of slide[SLIDE_SHAPES]) {
      const url = getShapeHyperlink(shape);
      if (url !== null && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
  }
  return out;
};

/**
 * Returns every slide carrying at least one shape with an external
 * hyperlink. Built on `findHyperlinkedShapes`. Useful for navigation
 * UIs that want to surface only the slides containing outbound URLs.
 */
export const getSlidesWithHyperlinks = (
  pres: PresentationData,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    if (slide[SLIDE_SHAPES].some((s) => getShapeHyperlink(s) !== null)) {
      out.push(slide);
    }
  }
  return out;
};

/**
 * Returns every slide containing at least one shape whose external
 * hyperlink matches `needle` (substring or `RegExp`). Sibling of
 * `findSlidesByText` for outbound-URL audits — e.g. "every slide
 * that links to old.docs.example.com".
 */
export const findSlidesByHyperlink = (
  pres: PresentationData,
  needle: string | RegExp,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    for (const shape of slide[SLIDE_SHAPES]) {
      const url = getShapeHyperlink(shape);
      if (url === null) continue;
      const hit =
        typeof needle === "string" ? url.includes(needle) : needle.test(url);
      if (hit) {
        out.push(slide);
        break;
      }
    }
  }
  return out;
};

/**
 * Bulk URL migration. Re-points every shape across the deck whose
 * first hyperlink exactly equals `from` to instead point at `to`.
 * Returns the number of shapes updated. Built on
 * `setShapeHyperlink`, so each update goes through the standard
 * rels-allocation path and stays schema-valid.
 *
 * Matching is exact (case-sensitive). To migrate by pattern, use
 * `findSlidesByHyperlink` to locate slides and rewrite each shape
 * yourself.
 */
export const replaceHyperlink = (
  pres: PresentationData,
  from: string,
  to: string,
): number => {
  let n = 0;
  for (const slide of getSlides(pres)) {
    for (const shape of slide[SLIDE_SHAPES]) {
      if (getShapeHyperlink(shape) === from) {
        setShapeHyperlink(shape, to);
        n++;
      }
    }
  }
  return n;
};

/**
 * Removes every external hyperlink across the deck — useful for
 * sanitizing a template before sharing, or for stripping outbound
 * URLs from an exported preview. Returns the number of shapes
 * cleared. Each call goes through `setShapeHyperlink(_, null)`.
 */
export const clearAllHyperlinks = (pres: PresentationData): number => {
  let n = 0;
  for (const slide of getSlides(pres)) {
    for (const shape of slide[SLIDE_SHAPES]) {
      if (getShapeHyperlink(shape) !== null) {
        setShapeHyperlink(shape, null);
        n++;
      }
    }
  }
  return n;
};

/**
 * Slide-scoped sibling of `clearAllHyperlinks`. Removes every
 * external hyperlink on this slide and returns the number of
 * shapes cleared.
 */
export const clearSlideHyperlinks = (slide: SlideData): number => {
  let n = 0;
  for (const shape of slide[SLIDE_SHAPES]) {
    if (getShapeHyperlink(shape) !== null) {
      setShapeHyperlink(shape, null);
      n++;
    }
  }
  return n;
};

/**
 * One entry per comment in the deck, carrying both the comment and
 * the 0-based slide it was attached to.
 */
export interface PresentationCommentEntry {
  readonly slideIndex: number;
  readonly comment: SlideCommentData;
}

/**
 * Returns every comment across every slide in the deck, each paired
 * with the 0-based index of its slide. Useful for review-summary
 * UIs that show all annotations in one chronological list.
 */
export const getAllComments = (
  pres: PresentationData,
): ReadonlyArray<PresentationCommentEntry> => {
  const out: PresentationCommentEntry[] = [];
  const slides = getSlides(pres);
  for (let i = 0; i < slides.length; i++) {
    for (const c of getSlideComments(slides[i]!)) {
      out.push({ slideIndex: i, comment: c });
    }
  }
  return out;
};

/**
 * Returns every slide's speaker notes alongside its 0-based index.
 * Skips slides whose notes are empty / unset.
 */
export const getAllNotes = (
  pres: PresentationData,
): ReadonlyArray<PresentationNotesEntry> => {
  const out: PresentationNotesEntry[] = [];
  const slides = getSlides(pres);
  for (let i = 0; i < slides.length; i++) {
    const notes = getSlideNotes(slides[i]!);
    if (notes !== null && notes.length > 0) out.push({ slideIndex: i, notes });
  }
  return out;
};

/**
 * Returns every slide in the presentation that carries non-empty
 * speaker notes. Convenience over `getSlides(pres).filter(s =>
 * getSlideNotes(s) !== null && getSlideNotes(s) !== '')`.
 */
export const getSlidesWithNotes = (
  pres: PresentationData,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    const notes = getSlideNotes(slide);
    if (notes !== null && notes.length > 0) out.push(slide);
  }
  return out;
};

/**
 * Predicate sibling of `getSlideNotes`. Returns `true` when the
 * slide carries a non-empty `notesSlide` body — i.e. whatever
 * `getSlideNotes(slide)` would surface is a non-empty string.
 *
 * Cheap to call in hot loops where the caller only needs to know
 * "are there any notes here?" without materializing the text.
 */
export const hasSlideNotes = (slide: SlideData): boolean => {
  const notes = getSlideNotes(slide);
  return notes !== null && notes.length > 0;
};

/**
 * Code-point length of the slide's speaker notes, or `0` when the
 * slide has no notes. Counts via `Array.from`, so surrogate-pair
 * characters (emoji, supplementary CJK) count as 1 — matches
 * `getSlideTextLength`.
 */
export const getSlideNotesLength = (slide: SlideData): number => {
  const notes = getSlideNotes(slide);
  return notes === null ? 0 : Array.from(notes).length;
};

/**
 * Concatenated speaker notes from every slide, joined with the
 * given `separator` (defaults to a form-feed, `\f`). Slides with
 * no notes contribute the empty string. Sibling of
 * `getPresentationText` — useful for search-indexing notes
 * across a whole deck.
 */
export const getPresentationNotesText = (
  pres: PresentationData,
  separator: string = "\f",
): string => {
  const parts: string[] = [];
  for (const slide of getSlides(pres)) parts.push(getSlideNotes(slide) ?? "");
  return parts.join(separator);
};

/**
 * Total code-point length of speaker notes across every slide.
 * Sibling of `getPresentationTextLength`; counts surrogate-pair
 * characters as 1 each. Cheaper than `getPresentationNotesText`
 * when the caller only needs the size.
 */
export const getPresentationNotesLength = (pres: PresentationData): number => {
  let n = 0;
  for (const slide of getSlides(pres)) n += getSlideNotesLength(slide);
  return n;
};

/**
 * Dense per-slide notes-length array. Code-point length per
 * `getSlideNotesLength` (`0` when the slide has no notes part). Pair
 * with `getPresentationTextLengthsBySlide` for handout / talk-track
 * audits — slides with no on-screen text but heavy speaker notes are
 * often the slow part of a presentation.
 */
export const getPresentationNotesLengthsBySlide = (
  pres: PresentationData,
): ReadonlyArray<number> => getSlides(pres).map((s) => getSlideNotesLength(s));

/**
 * Returns every slide whose `<p:spTree>` carries no shapes (per
 * `getSlideShapes`). Useful as a "find the section dividers I forgot
 * to fill in" pre-publish check.
 */
export const getEmptySlides = (
  pres: PresentationData,
): ReadonlyArray<SlideData> => {
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    if (slide[SLIDE_SHAPES].length === 0) out.push(slide);
  }
  return out;
};

/**
 * Appends `text` to the slide's existing notes on its own line.
 * Equivalent to `setSlideNotes(slide, (getSlideNotes(slide) ?? '') + '\n' + text)`,
 * minus the leading newline when there were no notes yet.
 */
export const appendSlideNotes = (slide: SlideData, text: string): void => {
  const existing = getSlideNotes(slide);
  const value =
    existing === null || existing.length === 0 ? text : `${existing}\n${text}`;
  setSlideNotes(slide, value);
};

/** Applies sequential range edits in the notes' visible text (as an editing
 * history records them, see `TextBodyEdit`), keeping the runs and paragraph
 * properties outside the edited ranges. `text` is the text the edits end at.
 * Throws, leaving the notes as they were, when the slide has no notes body or
 * the edits do not start from its text or do not end at `text`. */
export const editSlideNotes = (
  slide: SlideData,
  edits: readonly TextBodyEdit[],
  text: string,
): void => {
  const notesPartName = findNotesPartName(slide);
  const part =
    notesPartName === null
      ? null
      : slide[INTERNAL_PACKAGE].getPart(notesPartName);
  if (part === null) throw new Error("slide has no notes to edit");
  const doc = parseXml(decode(part.data));
  const spTree = firstChildElement(
    firstChildElement(doc.root, NAME_CSLD) ?? doc.root,
    NAME_SP_TREE,
  );
  // The same body placeholder getSlideNotes and setSlideNotes use.
  const body = spTree?.children
    .filter((child) => child.kind === "element")
    .filter(
      (child) =>
        child.name.namespaceURI === NS.pml && child.name.localName === "sp",
    )
    .map((sp) => {
      const nvPr = firstChildElement(
        firstChildElement(sp, qname("p", "nvSpPr", NS.pml)) ?? sp,
        qname("p", "nvPr", NS.pml),
      );
      return nvPr && firstChildElement(nvPr, qname("p", "ph", NS.pml))
        ? firstChildElement(sp, qname("p", "txBody", NS.pml))
        : null;
    })
    .find((txBody) => txBody);
  if (!body) throw new Error("notesSlide has no body placeholder to edit");
  for (const edit of edits) editTextBodyRange(body, edit);
  if (textBodyText(body) !== text)
    throw new Error("notes edits do not match the notes' text");
  part.data = encode(serializeXml(doc));
};

export const setSlideNotes = (slide: SlideData, value: string): void => {
  const pkg = slide[INTERNAL_PACKAGE];
  const notesPartName = findNotesPartName(slide);
  if (notesPartName !== null) {
    const part = pkg.getPart(notesPartName);
    if (part === null)
      throw new Error(`notes rel points at missing part ${notesPartName}`);
    const doc = parseXml(decode(part.data));
    const cSld = firstChildElement(doc.root, NAME_CSLD);
    if (!cSld) throw new Error("notesSlide has no <p:cSld>");
    const spTree = firstChildElement(cSld, NAME_SP_TREE);
    if (!spTree) throw new Error("notesSlide has no <p:spTree>");
    for (const child of spTree.children) {
      if (child.kind !== "element" || child.name.namespaceURI !== NS.pml)
        continue;
      if (child.name.localName !== "sp") continue;
      const nvSpPr = firstChildElement(child, qname("p", "nvSpPr", NS.pml));
      if (!nvSpPr) continue;
      const nvPr = firstChildElement(nvSpPr, qname("p", "nvPr", NS.pml));
      if (!nvPr) continue;
      const ph = firstChildElement(nvPr, qname("p", "ph", NS.pml));
      if (!ph) continue;
      const txBody = firstChildElement(child, qname("p", "txBody", NS.pml));
      if (!txBody) continue;
      setTextBody(txBody, value);
      part.data = encode(serializeXml(doc));
      return;
    }
    throw new Error("notesSlide has no body placeholder to fill");
  }

  // Create a new notesSlide part.
  const notesMasterPart = pkg.parts.find((p) =>
    p.contentType.endsWith("notesMaster+xml"),
  );
  let nextN = 1;
  const pattern = /^\/ppt\/notesSlides\/notesSlide(\d+)\.xml$/;
  for (const p of pkg.parts) {
    const m = p.name.match(pattern);
    if (m?.[1] !== undefined) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= nextN) nextN = n + 1;
    }
  }
  const notesName = partName(`/ppt/notesSlides/notesSlide${nextN}.xml`);
  const doc = buildEmptyNotesSlide(value);
  pkg.addPart(
    notesName,
    "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml",
    encode(serializeXml(doc)),
  );

  const notesRels = emptyRels();
  const slideBase = slide[SLIDE_PART_NAME].split("/").pop() ?? "slide.xml";
  notesRels.items.push({
    id: "rId1",
    type: REL_TYPES.slide,
    target: `../slides/${slideBase}`,
    targetMode: "Internal",
  });
  if (notesMasterPart) {
    const notesMasterBase =
      notesMasterPart.name.split("/").pop() ?? "notesMaster1.xml";
    notesRels.items.push({
      id: "rId2",
      type: REL_TYPES.notesMaster,
      target: `../notesMasters/${notesMasterBase}`,
      targetMode: "Internal",
    });
  }
  pkg.setRels(notesName, notesRels);

  const slideRels = pkg.getRels(slide[SLIDE_PART_NAME]) ?? emptyRels();
  const existingIds = slideRels.items.map((r) => r.id);
  let n = 1;
  while (existingIds.includes(`rId${n}`)) n++;
  slideRels.items.push({
    id: `rId${n}`,
    type: REL_TYPES.notesSlide,
    target: `../notesSlides/notesSlide${nextN}.xml`,
    targetMode: "Internal",
  });
  pkg.setRels(slide[SLIDE_PART_NAME], slideRels);
};

/**
 * Removes the slide's speaker-notes part entirely. Drops the
 * `notesSlide` part + its `.rels`, and unwires the slide → notesSlide
 * relationship. No-op when the slide has no notes.
 *
 * The shared `notesMaster` part is left alone; other slides may still
 * reference it.
 */
export const removeSlideNotes = (slide: SlideData): void => {
  const notesPartName = findNotesPartName(slide);
  if (notesPartName === null) return;
  const pkg = slide[INTERNAL_PACKAGE];
  pkg.removePart(notesPartName);
  pkg.removePart(relsPartNameFor(notesPartName));
  const slideRels = pkg.getRels(slide[SLIDE_PART_NAME]);
  if (slideRels === null) return;
  slideRels.items = slideRels.items.filter(
    (r) => r.type !== REL_TYPES.notesSlide,
  );
  pkg.setRels(slide[SLIDE_PART_NAME], slideRels);
};

/**
 * Removes the speaker-notes part from every slide that has one.
 * Built on `removeSlideNotes`. Returns the number of slides
 * stripped. Useful as a privacy/sharing helper before exporting a
 * deck whose notes contain internal commentary.
 */
export const clearAllSlideNotes = (pres: PresentationData): number => {
  let n = 0;
  for (const slide of getSlides(pres)) {
    if (findNotesPartName(slide) === null) continue;
    removeSlideNotes(slide);
    n++;
  }
  return n;
};
