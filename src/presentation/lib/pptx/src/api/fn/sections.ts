// Slide sections (p14 extension).

import {
  NS,
  type XmlElement,
  allChildElements,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  parseXml,
  qname,
  serializeXml,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
  SLIDE_PART_NAME,
  type SlideData,
} from "../_internal-symbols.ts";
import {
  ATTR_ID,
  NAME_SLD_ID,
  NAME_SLD_ID_LST,
  PRES_PART_NAME,
  decode,
  encode,
} from "./_helpers.ts";
import { readPresentationPart } from "../../internal/presentationml/index.ts";
import { getSlides } from "./slide-query.ts";

// ---------------------------------------------------------------------------
// Slide sections (p14 extension).
//
// The p14 extension groups slides into named sections. The
// data lives in `<p:presentation>/<p:extLst>/<p:ext uri="{…}">/<p14:sectionLst>`.
// We expose it as a flat array of `SlideSection` objects, each
// carrying the section name and the slides in display order.

/** One section in the deck. `slides` is a snapshot at read time. */
export interface SlideSection {
  readonly name: string;
  readonly slides: ReadonlyArray<SlideData>;
}

const NS_P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";
const SECTION_LST_EXT_URI = "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}";

const NAME_EXT_LST = qname("p", "extLst", NS.pml);
const NAME_P_EXT = qname("p", "ext", NS.pml);
const NAME_P14_SECTION_LST = qname("p14", "sectionLst", NS_P14);
const NAME_P14_SECTION = qname("p14", "section", NS_P14);
const NAME_P14_SLD_ID_LST = qname("p14", "sldIdLst", NS_P14);
const NAME_P14_SLD_ID = qname("p14", "sldId", NS_P14);
const ATTR_URI = qname("", "uri", "");
const ATTR_NAME_SEC = qname("", "name", "");
const ATTR_ID_SEC = qname("", "id", "");
const ATTR_SLD_ID_REF = qname("", "id", "");

const findSectionLstElement = (presDocRoot: XmlElement): XmlElement | null => {
  const extLst = firstChildElement(presDocRoot, NAME_EXT_LST);
  if (!extLst) return null;
  for (const ext of allChildElements(extLst, NAME_P_EXT)) {
    if (getAttrValue(ext, ATTR_URI) === SECTION_LST_EXT_URI) {
      return firstChildElement(ext, NAME_P14_SECTION_LST);
    }
  }
  return null;
};

const ensureSectionLst = (presDocRoot: XmlElement): XmlElement => {
  let extLst = firstChildElement(presDocRoot, NAME_EXT_LST);
  if (!extLst) {
    extLst = elem(NAME_EXT_LST);
    presDocRoot.children.push(extLst);
  }
  for (const ext of allChildElements(extLst, NAME_P_EXT)) {
    if (getAttrValue(ext, ATTR_URI) === SECTION_LST_EXT_URI) {
      let sectionLst = firstChildElement(ext, NAME_P14_SECTION_LST);
      if (!sectionLst) {
        sectionLst = elem(NAME_P14_SECTION_LST);
        ext.children.push(sectionLst);
      }
      return sectionLst;
    }
  }
  const sectionLst = elem(NAME_P14_SECTION_LST, {
    prefixDecls: new Map([["p14", NS_P14]]),
  });
  const ext = elem(NAME_P_EXT, {
    attrs: [attr(ATTR_URI, SECTION_LST_EXT_URI)],
    children: [sectionLst],
  });
  extLst.children.push(ext);
  return sectionLst;
};

// Slides just appended by addSlide / duplicateSlide / importSlide, by sldId.
// Their first move places them like a new slide, into the section of the
// slide before them, rather than keeping the last section they were added to.
const newSlideIds = new WeakMap<object, Set<string>>();

/**
 * Keeps `<p14:sectionLst>` in step with `<p:sldIdLst>` after a deck edit, on
 * the parsed presentation root the caller is about to serialize. Ids no
 * longer in the deck are dropped, a slide no section lists joins the section
 * of the slide before it, and every section lists its slides in deck order.
 * `moved` is the slide that moved from deck index `from`: it stays in its
 * section when it landed next to it, and otherwise joins the section it
 * landed in (the one below it when it moved up, above it when it moved down).
 * @internal
 */
export const syncSlideSections = (
  pres: PresentationData,
  root: XmlElement,
  change: { added?: string; moved?: { id: string; from: number } } = {},
): void => {
  const pkg = pres[INTERNAL_PACKAGE];
  const sectionLst = findSectionLstElement(root);
  const sections = sectionLst
    ? allChildElements(sectionLst, NAME_P14_SECTION)
    : [];
  if (!sections.length) {
    newSlideIds.delete(pkg);
    return;
  }
  const list = firstChildElement(root, NAME_SLD_ID_LST);
  const order: string[] = [];
  for (const el of list ? allChildElements(list, NAME_SLD_ID) : []) {
    const id = getAttrValue(el, ATTR_ID);
    if (id !== null) order.push(id);
  }
  const inDeck = new Set(order);
  const fresh = newSlideIds.get(pkg) ?? new Set<string>();
  for (const id of fresh) if (!inDeck.has(id)) fresh.delete(id);
  const sectionOf = new Map<string, number>();
  sections.forEach((sec, i) => {
    const ids = firstChildElement(sec, NAME_P14_SLD_ID_LST);
    for (const el of ids ? allChildElements(ids, NAME_P14_SLD_ID) : []) {
      const id = getAttrValue(el, ATTR_SLD_ID_REF);
      if (id !== null && inDeck.has(id) && !sectionOf.has(id))
        sectionOf.set(id, i);
    }
  });
  const moved = change.moved;
  let own: number | undefined;
  if (moved) {
    own = fresh.delete(moved.id) ? undefined : sectionOf.get(moved.id);
    sectionOf.delete(moved.id);
  }
  let previous = 0;
  for (const id of order) {
    if (id === moved?.id) continue;
    if (!sectionOf.has(id)) sectionOf.set(id, previous);
    previous = sectionOf.get(id)!;
  }
  if (moved) {
    const at = order.indexOf(moved.id);
    const above = at > 0 ? sectionOf.get(order[at - 1]!) : undefined;
    const below = sectionOf.get(order[at + 1] ?? "");
    const up = own !== undefined && at < moved.from;
    sectionOf.set(
      moved.id,
      own !== undefined && (own === above || own === below)
        ? own
        : ((up ? (below ?? above) : (above ?? below)) ?? 0),
    );
  }
  sections.forEach((sec, i) => {
    let ids = firstChildElement(sec, NAME_P14_SLD_ID_LST);
    if (!ids) sec.children.push((ids = elem(NAME_P14_SLD_ID_LST)));
    ids.children = order
      .filter((id) => sectionOf.get(id) === i)
      .map((id) =>
        elem(NAME_P14_SLD_ID, { attrs: [attr(ATTR_SLD_ID_REF, id)] }),
      );
  });
  if (change.added !== undefined) fresh.add(change.added);
  newSlideIds.set(pkg, fresh);
};

/**
 * Returns every section defined in `<p14:sectionLst>`, with each
 * section's slides resolved to `SlideData` handles via the
 * presentation's `<p:sldIdLst>`. Sections referencing missing slides
 * are dropped silently; empty arrays are preserved.
 *
 * Returns an empty array when no sectionLst is present.
 */
export const getSlideSections = (
  pres: PresentationData,
): ReadonlyArray<SlideSection> => {
  const pkg = pres[INTERNAL_PACKAGE];
  const presPart = pkg.getPart(PRES_PART_NAME);
  if (!presPart) return [];
  const doc = parseXml(decode(presPart.data));
  const sectionLst = findSectionLstElement(doc.root);
  if (!sectionLst) return [];

  // Build a map from `sldId` to SlideData by walking the deck.
  const slideById = new Map<string, SlideData>();
  const presRels = pkg.getRels(PRES_PART_NAME);
  if (presRels) {
    const presModel = readPresentationPart(doc.root);
    const slides = getSlides(pres);
    // Map presModel.slides[i].id → slides[i] (they're in the same order).
    for (let i = 0; i < presModel.slides.length && i < slides.length; i++) {
      slideById.set(String(presModel.slides[i]!.id), slides[i]!);
    }
  }

  const out: SlideSection[] = [];
  for (const sec of allChildElements(sectionLst, NAME_P14_SECTION)) {
    const name = getAttrValue(sec, ATTR_NAME_SEC) ?? "";
    const sldIdLst = firstChildElement(sec, NAME_P14_SLD_ID_LST);
    const slides: SlideData[] = [];
    if (sldIdLst) {
      for (const sldId of allChildElements(sldIdLst, NAME_P14_SLD_ID)) {
        const id = getAttrValue(sldId, ATTR_SLD_ID_REF);
        if (id !== null) {
          const slide = slideById.get(id);
          if (slide) slides.push(slide);
        }
      }
    }
    out.push({ name, slides });
  }
  return out;
};

/**
 * Replaces the deck's section list with `sections`. Each section is
 * given a fresh GUID `id` attribute (native output carries one per
 * section; we synthesize a deterministic-ish one based on index +
 * timestamp for v1).
 *
 * Pass `[]` to clear all sections — the helper drops the
 * `<p14:sectionLst>` extension entirely when no sections remain.
 */
export const setSlideSections = (
  pres: PresentationData,
  sections: ReadonlyArray<{ name: string; slides: ReadonlyArray<SlideData> }>,
): void => {
  const pkg = pres[INTERNAL_PACKAGE];
  const presPart = pkg.getPart(PRES_PART_NAME);
  if (!presPart) throw new Error("presentation.xml is missing");
  const doc = parseXml(decode(presPart.data));
  newSlideIds.delete(pkg);

  // Build a reverse map from SlideData identity → sldId.
  const idBySlide = new Map<SlideData, string>();
  const presModel = readPresentationPart(doc.root);
  const slides = getSlides(pres);
  for (let i = 0; i < presModel.slides.length && i < slides.length; i++) {
    idBySlide.set(slides[i]!, String(presModel.slides[i]!.id));
  }

  // Reach for the matching slide id by part name, since SlideData
  // identity may have been rebuilt across calls.
  const idByPartName = new Map<string, string>();
  if (presModel.slides.length > 0) {
    const presRels = pkg.getRels(PRES_PART_NAME);
    if (presRels) {
      for (const s of presModel.slides) {
        const rel = presRels.items.find((r) => r.id === s.rId);
        if (!rel) continue;
        const slideName = rel.target.startsWith("/")
          ? rel.target
          : `/ppt/${rel.target}`;
        idByPartName.set(slideName, String(s.id));
      }
    }
  }
  const sldIdFor = (slide: SlideData): string | null => {
    const direct = idBySlide.get(slide);
    if (direct) return direct;
    return idByPartName.get(slide[SLIDE_PART_NAME]) ?? null;
  };

  if (sections.length === 0) {
    // Drop the sectionLst entirely.
    const extLst = firstChildElement(doc.root, NAME_EXT_LST);
    if (extLst) {
      extLst.children = extLst.children.filter(
        (c) =>
          !(
            c.kind === "element" &&
            c.name.namespaceURI === NS.pml &&
            c.name.localName === "ext" &&
            getAttrValue(c, ATTR_URI) === SECTION_LST_EXT_URI
          ),
      );
      // Drop the empty extLst itself if no other extensions remain.
      if (extLst.children.length === 0) {
        doc.root.children = doc.root.children.filter((c) => c !== extLst);
      }
    }
    presPart.data = encode(serializeXml(doc));
    return;
  }

  const sectionLst = ensureSectionLst(doc.root);
  sectionLst.children = sections.map((section, i) => {
    // Synthesize a GUID-shaped id from index + timestamp.
    const ts = Date.now().toString(16).padStart(8, "0").slice(-8).toUpperCase();
    const id = `{${ts.slice(0, 8)}-${String(i).padStart(4, "0")}-4000-8000-000000000000}`;
    const sldIds: XmlElement[] = [];
    for (const slide of section.slides) {
      const sldId = sldIdFor(slide);
      if (sldId !== null) {
        sldIds.push(
          elem(NAME_P14_SLD_ID, { attrs: [attr(ATTR_SLD_ID_REF, sldId)] }),
        );
      }
    }
    return elem(NAME_P14_SECTION, {
      attrs: [attr(ATTR_NAME_SEC, section.name), attr(ATTR_ID_SEC, id)],
      children: [elem(NAME_P14_SLD_ID_LST, { children: sldIds })],
    });
  });

  presPart.data = encode(serializeXml(doc));
};
