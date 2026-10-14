import { shapeRelationshipOwner } from "./shape-source.ts";
// Shape click action.
import { getSlides } from "./slide-query.ts";

import {
  basename,
  emptyRels,
  nextRelId,
  partName,
  resolveTarget,
} from "../../internal/opc/index.ts";
import type { OpcPackage } from "../../internal/parts/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
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
  type PresentationData,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  SLIDE_PART_NAME,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { commitAndRefresh } from "./_helpers.ts";
// ---------------------------------------------------------------------------
// Shape click action — `<a:hlinkClick>` on the shape's cNvPr.
//
// Two flavors today: open a URL (External rel) or jump to another slide
// in this deck (Internal rel + `action="ppaction://hlinksldjump"`).
//
// The spec also defines preset actions like `nextslide`, `prevslide`,
// `firstslide`, `lastslide`, but they're niche enough to defer until a
// concrete user need shows up.

/** What clicking the shape should do. */
export type ShapeClickAction =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "slide"; readonly slide: SlideData }
  | { readonly kind: "nextSlide" }
  | { readonly kind: "prevSlide" }
  | { readonly kind: "firstSlide" }
  | { readonly kind: "lastSlide" };

export const NAME_HLINK_CLICK_FN = qname("a", "hlinkClick", NS.dml);

// cNvPr lives at different paths depending on shape kind. Returns null
// for kinds we don't know how to navigate yet (groups, etc.).
export const findCNvPr = (shape: SlideShapeData): XmlElement | null => {
  const root = shape[SHAPE_ELEMENT];
  const kind = shape[SHAPE_SNAPSHOT].kind;
  const wrapperName =
    kind === "shape"
      ? "nvSpPr"
      : kind === "picture"
        ? "nvPicPr"
        : kind === "connector"
          ? "nvCxnSpPr"
          : kind === "graphicFrame"
            ? "nvGraphicFramePr"
            : kind === "group"
              ? "nvGrpSpPr"
              : null;
  if (wrapperName === null) return null;
  const wrapper = firstChildElement(root, qname("p", wrapperName, NS.pml));
  if (!wrapper) return null;
  return firstChildElement(wrapper, qname("p", "cNvPr", NS.pml));
};

const removeExistingHlinkClick = (cNvPr: XmlElement): void => {
  cNvPr.children = cNvPr.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        c.name.localName === "hlinkClick"
      ),
  );
};

const findExistingHyperlinkRel = (
  rels: ReturnType<OpcPackage["getRels"]>,
  url: string,
): string | null => {
  if (rels === null) return null;
  const existing = rels.items.find(
    (rl) =>
      rl.type === REL_TYPES.hyperlink &&
      rl.target === url &&
      rl.targetMode === "External",
  );
  return existing?.id ?? null;
};

/**
 * Reads the click action attached to the shape's cNvPr, or `null` if
 * none. Mirrors `setShapeClickAction`:
 *
 *   - `{ kind: 'url', url }`     — `hyperlink` rel + targetMode=External
 *   - `{ kind: 'slide', slide }` — `slide` rel + `ppaction://hlinksldjump`
 *   - `{ kind: 'nextSlide' | 'prevSlide' | 'firstSlide' | 'lastSlide' }`
 *     — preset show-navigation `ppaction`.
 *
 * For `kind: 'slide'`, the matching slide is resolved by part name.
 * Returns `null` for unknown `ppaction` strings.
 */
export const getShapeClickAction = (
  shape: SlideShapeData,
): ShapeClickAction | null => {
  const cNvPr = findCNvPr(shape);
  if (!cNvPr) return null;
  const hlink = firstChildElement(cNvPr, NAME_HLINK_CLICK_FN);
  if (!hlink) return null;
  const action = getAttrValue(hlink, qname("", "action", ""));
  const rId = getAttrValue(hlink, qname("r", "id", NS.officeDocRels));

  if (action === "ppaction://hlinkshowjump?jump=nextslide")
    return { kind: "nextSlide" };
  if (action === "ppaction://hlinkshowjump?jump=previousslide")
    return { kind: "prevSlide" };
  if (action === "ppaction://hlinkshowjump?jump=firstslide")
    return { kind: "firstSlide" };
  if (action === "ppaction://hlinkshowjump?jump=lastslide")
    return { kind: "lastSlide" };

  if (rId !== null && rId !== "") {
    const slide = shape[SHAPE_SLIDE];
    const pkg = slide[INTERNAL_PACKAGE];
    const owner = shapeRelationshipOwner(shape, hlink);
    const rels = pkg.getRels(owner);
    if (!rels) return null;
    const rel = rels.items.find((r) => r.id === rId);
    if (!rel) return null;

    if (action === "ppaction://hlinksldjump" && rel.type === REL_TYPES.slide) {
      // Resolve to the SlideData of the target slide.
      const targetPartName = rel.target.startsWith("/")
        ? partName(rel.target)
        : resolveTarget(owner, rel.target);
      const pres: PresentationData = {
        [INTERNAL_PACKAGE]: pkg,
        _slidesCache: null,
      };
      for (const candidate of getSlides(pres)) {
        if (candidate[SLIDE_PART_NAME] === targetPartName) {
          return { kind: "slide", slide: candidate };
        }
      }
      return null;
    }
    if (rel.type === REL_TYPES.hyperlink && rel.targetMode === "External") {
      return { kind: "url", url: rel.target };
    }
  }
  return null;
};

/**
 * Sets (or clears) the click action on the shape. Side effects:
 *
 *   - For `kind: 'url'`, a `hyperlink` rel is added (or reused) on the
 *     slide's rels with `targetMode="External"`. `<a:hlinkClick r:id=…/>`
 *     points at it.
 *   - For `kind: 'slide'`, a `slide` rel is added pointing at the
 *     target slide's part. The `<a:hlinkClick>` carries
 *     `action="ppaction://hlinksldjump"`.
 *   - For the preset navigations (`nextSlide`, `prevSlide`, ...), no rel
 *     is allocated; just the `action` attribute carries the preset.
 *   - `null` removes any existing `<a:hlinkClick>`.
 *
 * The shape must be one of `shape | picture | connector | graphicFrame`.
 * Groups don't carry their own click action in our model.
 */
export const setShapeClickAction = (
  shape: SlideShapeData,
  action: ShapeClickAction | null,
): void => {
  const cNvPr = findCNvPr(shape);
  if (!cNvPr) {
    throw new Error(
      `setShapeClickAction: ${shape[SHAPE_SNAPSHOT].kind} shape has no cNvPr to attach to`,
    );
  }

  removeExistingHlinkClick(cNvPr);

  if (action === null) {
    commitAndRefresh(shape);
    return;
  }

  const slide = shape[SHAPE_SLIDE];
  const pkg = slide[INTERNAL_PACKAGE];

  let rId: string | null = null;
  let actionAttr: string | null = null;

  switch (action.kind) {
    case "url": {
      const rels = pkg.getRels(slide[SLIDE_PART_NAME]) ?? emptyRels();
      const reused = findExistingHyperlinkRel(rels, action.url);
      if (reused !== null) {
        rId = reused;
      } else {
        const newId = nextRelId(rels.items.map((r) => r.id));
        rels.items.push({
          id: newId,
          type: REL_TYPES.hyperlink,
          target: action.url,
          targetMode: "External",
        });
        pkg.setRels(slide[SLIDE_PART_NAME], rels);
        rId = newId;
      }
      break;
    }
    case "slide": {
      const target = action.slide[SLIDE_PART_NAME];
      const targetBase = basename(target);
      const rels = pkg.getRels(slide[SLIDE_PART_NAME]) ?? emptyRels();
      const existing = rels.items.find(
        (rl) =>
          rl.type === REL_TYPES.slide &&
          rl.target === `../slides/${targetBase}` &&
          rl.targetMode === "Internal",
      );
      if (existing) {
        rId = existing.id;
      } else {
        const newId = nextRelId(rels.items.map((r) => r.id));
        rels.items.push({
          id: newId,
          type: REL_TYPES.slide,
          target: `../slides/${targetBase}`,
          targetMode: "Internal",
        });
        pkg.setRels(slide[SLIDE_PART_NAME], rels);
        rId = newId;
      }
      actionAttr = "ppaction://hlinksldjump";
      break;
    }
    case "nextSlide":
      actionAttr = "ppaction://hlinkshowjump?jump=nextslide";
      break;
    case "prevSlide":
      actionAttr = "ppaction://hlinkshowjump?jump=previousslide";
      break;
    case "firstSlide":
      actionAttr = "ppaction://hlinkshowjump?jump=firstslide";
      break;
    case "lastSlide":
      actionAttr = "ppaction://hlinkshowjump?jump=lastslide";
      break;
  }

  const attrs = [] as Array<ReturnType<typeof attr>>;
  if (rId !== null) attrs.push(attr(qname("r", "id", NS.officeDocRels), rId));
  else attrs.push(attr(qname("r", "id", NS.officeDocRels), ""));
  if (actionAttr !== null)
    attrs.push(attr(qname("", "action", ""), actionAttr));

  // The click action comes first among cNvPr's children (before any hover
  // action and the extension list).
  const at = cNvPr.children.findIndex(
    (c) =>
      c.kind === "element" &&
      (c.name.localName === "hlinkHover" || c.name.localName === "extLst"),
  );
  cNvPr.children.splice(
    at < 0 ? cNvPr.children.length : at,
    0,
    elem(NAME_HLINK_CLICK_FN, {
      attrs,
    }),
  );

  commitAndRefresh(shape);
};
