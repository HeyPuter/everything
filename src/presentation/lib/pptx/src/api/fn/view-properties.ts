// Document view properties (`/ppt/viewProps.xml`, CT_ViewProperties).
//
// The part records how the deck was last viewed: the view it was left in,
// the drawing guides placed on the slides, the grid spacing and whether
// objects snap to it. Everything else in the part (pane sizes, scales,
// extensions) is preserved untouched when these values are written.

import { nextRelId, resolveTarget } from "../../internal/opc/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  NS,
  type XmlElement,
  allChildElements,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  insertChildByRank,
  parseXml,
  qname,
  serializeXml,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
} from "../_internal-symbols.ts";
import { PRES_PART_NAME, decode, encode } from "./_helpers.ts";
import { partName } from "../../internal/opc/index.ts";

/** The views a file can say it was last left in (ST_ViewType). */
export type LastView =
  | "sldView"
  | "sldMasterView"
  | "notesView"
  | "handoutView"
  | "notesMasterView"
  | "outlineView"
  | "sldSorterView"
  | "sldThumbnailView";

/** One drawing guide: a horizontal or vertical line at `pos` EMU from the
 * slide's top (horizontal guides) or left edge (vertical guides). */
export interface DrawingGuide {
  readonly orient: "horz" | "vert";
  readonly pos: number;
}

export interface ViewProperties {
  readonly lastView: LastView | null;
  /** `null` when the file records no slide view settings at all. */
  readonly snapToGrid: boolean | null;
  readonly snapToObjects: boolean;
  readonly showGuides: boolean;
  readonly guides: ReadonlyArray<DrawingGuide>;
  /** Grid spacing in EMU, or `null` when the file records none. */
  readonly gridSpacing: { readonly cx: number; readonly cy: number } | null;
}

export interface ViewPropertiesPatch {
  readonly lastView?: LastView | null;
  readonly snapToGrid?: boolean;
  readonly snapToObjects?: boolean;
  readonly showGuides?: boolean;
  readonly guides?: ReadonlyArray<DrawingGuide>;
  readonly gridSpacing?: { readonly cx: number; readonly cy: number } | null;
}

// Guide positions are stored in 1/8 point (1/576 inch) units.
const EMU_PER_GUIDE_UNIT = 914400 / 576;
const VIEW_PROPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml";
const LAST_VIEWS: ReadonlySet<string> = new Set([
  "sldView",
  "sldMasterView",
  "notesView",
  "handoutView",
  "notesMasterView",
  "outlineView",
  "sldSorterView",
  "sldThumbnailView",
]);

const p = (local: string) => qname("p", local, NS.pml);
const a = (local: string) => qname("a", local, NS.dml);
const bare = (local: string) => qname("", local, "");
const isPml = (e: XmlElement, local: string) =>
  e.name.namespaceURI === NS.pml && e.name.localName === local;

// CT_ViewProperties child order.
const VIEW_PR_ORDER = [
  "normalViewPr",
  "slideViewPr",
  "outlineViewPr",
  "notesTextViewPr",
  "sorterViewPr",
  "notesViewPr",
  "gridSpacing",
  "extLst",
];
const rankIn = (order: string[]) => (e: XmlElement) => {
  const i = order.indexOf(e.name.localName);
  return i < 0 ? order.length : i;
};

const bool = (value: string | null, fallback: boolean): boolean =>
  value === "1" || value === "true"
    ? true
    : value === "0" || value === "false"
      ? false
      : fallback;

const findViewPropsName = (pres: PresentationData): string | null => {
  const pkg = pres[INTERNAL_PACKAGE];
  const rel = pkg
    .getRels(PRES_PART_NAME)
    ?.items.find(
      (r) => r.type === REL_TYPES.viewProps && r.targetMode !== "External",
    );
  return rel ? resolveTarget(PRES_PART_NAME, rel.target) : null;
};

const readRoot = (pres: PresentationData): XmlElement | null => {
  const name = findViewPropsName(pres);
  if (!name) return null;
  const part = pres[INTERNAL_PACKAGE].getPart(partName(name));
  if (!part) return null;
  try {
    const root = parseXml(decode(part.data)).root;
    return isPml(root, "viewPr") ? root : null;
  } catch {
    return null;
  }
};

const commonSlideView = (root: XmlElement): XmlElement | null => {
  const slideView = firstChildElement(root, p("slideViewPr"));
  return slideView ? firstChildElement(slideView, p("cSldViewPr")) : null;
};

// The presentation-level slide guide list (an extension of
// CT_Presentation, as editors since 2013 write it). Positions are in the
// same 1/8 point units as the view part's guides.
const SLIDE_GUIDES_EXT = "{EFAFB233-063F-42B5-8137-9DF3F51BA10A}";
const p15 = (local: string) => qname("p15", local, NS.p15);
/** The color guides are drawn in (a neutral gray). */
const GUIDE_COLOR = "A6A6A6";

const readPresentationRoot = (pres: PresentationData): XmlElement | null => {
  const part = pres[INTERNAL_PACKAGE].getPart(PRES_PART_NAME);
  if (!part) return null;
  try {
    return parseXml(decode(part.data)).root;
  } catch {
    return null;
  }
};

const slideGuidesExt = (root: XmlElement): XmlElement | null => {
  const list = firstChildElement(root, p("extLst"));
  return list
    ? (allChildElements(list, p("ext")).find(
        (e) => getAttrValue(e, bare("uri")) === SLIDE_GUIDES_EXT,
      ) ?? null)
    : null;
};

const readPresentationGuides = (pres: PresentationData): DrawingGuide[] => {
  const root = readPresentationRoot(pres);
  const ext = root && slideGuidesExt(root);
  const list = ext && firstChildElement(ext, p15("sldGuideLst"));
  if (!list) return [];
  const out: DrawingGuide[] = [];
  for (const guide of allChildElements(list, p15("guide"))) {
    const pos = Number(getAttrValue(guide, bare("pos")) ?? "0");
    if (!Number.isFinite(pos)) continue;
    out.push({
      orient: getAttrValue(guide, bare("orient")) === "horz" ? "horz" : "vert",
      pos: Math.round(pos * EMU_PER_GUIDE_UNIT),
    });
  }
  return out;
};

/** Writes the slide guides into the presentation part as well, where
 * current desktop editors look for them; drops the list when empty. */
const writePresentationGuides = (
  pres: PresentationData,
  guides: ReadonlyArray<DrawingGuide>,
): void => {
  const part = pres[INTERNAL_PACKAGE].getPart(PRES_PART_NAME);
  if (!part) return;
  const doc = parseXml(decode(part.data));
  const root = doc.root;
  let extLst = firstChildElement(root, p("extLst"));
  const old = slideGuidesExt(root);
  if (extLst && old) extLst.children = extLst.children.filter((c) => c !== old);
  if (guides.length) {
    const ext = elem(p("ext"), {
      attrs: [attr(bare("uri"), SLIDE_GUIDES_EXT)],
      children: [
        elem(p15("sldGuideLst"), {
          children: guides.map((g, i) =>
            elem(p15("guide"), {
              attrs: [
                attr(bare("id"), String(i + 1)),
                ...(g.orient === "horz" ? [attr(bare("orient"), "horz")] : []),
                attr(
                  bare("pos"),
                  String(Math.round(g.pos / EMU_PER_GUIDE_UNIT)),
                ),
              ],
              children: [
                elem(p15("clr"), {
                  children: [
                    elem(a("srgbClr"), {
                      attrs: [attr(bare("val"), GUIDE_COLOR)],
                    }),
                  ],
                }),
              ],
            }),
          ),
        }),
      ],
    });
    if (!extLst) {
      // CT_Presentation ends with its extension list.
      extLst = elem(p("extLst"));
      root.children.push(extLst);
    }
    extLst.children.push(ext);
  } else if (extLst && !extLst.children.some((c) => c.kind === "element")) {
    root.children = root.children.filter((c) => c !== extLst);
  }
  part.data = encode(serializeXml(doc));
};

/** Reads the deck's view properties. A missing or unreadable part reads as
 * the defaults: no last view, no guides, no grid recorded. */
export const getViewProperties = (pres: PresentationData): ViewProperties => {
  const root = readRoot(pres);
  const empty: ViewProperties = {
    lastView: null,
    snapToGrid: null,
    snapToObjects: false,
    showGuides: false,
    guides: [],
    gridSpacing: null,
  };
  if (!root) return { ...empty, guides: readPresentationGuides(pres) };
  const last = getAttrValue(root, bare("lastView"));
  const common = commonSlideView(root);
  const guides: DrawingGuide[] = [];
  const list = common && firstChildElement(common, p("guideLst"));
  if (list)
    for (const guide of allChildElements(list, p("guide"))) {
      const pos = Number(getAttrValue(guide, bare("pos")) ?? "0");
      if (!Number.isFinite(pos)) continue;
      guides.push({
        // ST_Direction defaults to "vert".
        orient:
          getAttrValue(guide, bare("orient")) === "horz" ? "horz" : "vert",
        pos: Math.round(pos * EMU_PER_GUIDE_UNIT),
      });
    }
  // Editors since 2013 keep slide guides with the presentation; read those
  // when the view part lists none.
  if (!list) guides.push(...readPresentationGuides(pres));
  const spacing = firstChildElement(root, p("gridSpacing"));
  const cx = Number(spacing && getAttrValue(spacing, bare("cx")));
  const cy = Number(spacing && getAttrValue(spacing, bare("cy")));
  return {
    lastView: last && LAST_VIEWS.has(last) ? (last as LastView) : null,
    snapToGrid: common
      ? bool(getAttrValue(common, bare("snapToGrid")), true)
      : null,
    snapToObjects: common
      ? bool(getAttrValue(common, bare("snapToObjects")), false)
      : false,
    showGuides: common
      ? bool(getAttrValue(common, bare("showGuides")), false)
      : false,
    guides,
    gridSpacing:
      spacing && cx > 0 && cy > 0
        ? { cx: Math.round(cx), cy: Math.round(cy) }
        : null,
  };
};

const setAttr = (e: XmlElement, local: string, value: string | null) => {
  e.attrs = e.attrs.filter(
    (x) => !(x.name.namespaceURI === "" && x.name.localName === local),
  );
  if (value !== null) e.attrs.push(attr(bare(local), value));
};

// CT_CommonViewProperties requires a scale and an origin.
const commonViewPr = (): XmlElement =>
  elem(p("cViewPr"), {
    attrs: [attr(bare("varScale"), "1")],
    children: [
      elem(p("scale"), {
        children: [
          elem(a("sx"), {
            attrs: [attr(bare("n"), "100"), attr(bare("d"), "100")],
          }),
          elem(a("sy"), {
            attrs: [attr(bare("n"), "100"), attr(bare("d"), "100")],
          }),
        ],
      }),
      elem(p("origin"), {
        attrs: [attr(bare("x"), "0"), attr(bare("y"), "0")],
      }),
    ],
  });

const ensureCommonSlideView = (root: XmlElement): XmlElement => {
  let slideView = firstChildElement(root, p("slideViewPr"));
  if (!slideView) {
    slideView = elem(p("slideViewPr"));
    insertChildByRank(root, slideView, rankIn(VIEW_PR_ORDER));
  }
  let common = firstChildElement(slideView, p("cSldViewPr"));
  if (!common) {
    common = elem(p("cSldViewPr"), { children: [commonViewPr()] });
    slideView.children.unshift(common);
  }
  if (!firstChildElement(common, p("cViewPr")))
    common.children.unshift(commonViewPr());
  return common;
};

const ensureViewPropsPart = (pres: PresentationData): string => {
  const existing = findViewPropsName(pres);
  const pkg = pres[INTERNAL_PACKAGE];
  if (existing && pkg.getPart(partName(existing))) return existing;
  const name = existing ?? "/ppt/viewProps.xml";
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:viewPr xmlns:a="${NS.dml}" xmlns:r="${NS.officeDocRels}" xmlns:p="${NS.pml}"/>`;
  pkg.addPart(partName(name), VIEW_PROPS_CONTENT_TYPE, encode(xml));
  if (!existing) {
    const rels = pkg.getRels(PRES_PART_NAME);
    if (!rels) throw new Error("presentation.xml has no relationships part");
    rels.items.push({
      id: nextRelId(rels.items.map((r) => r.id)),
      type: REL_TYPES.viewProps,
      target: "viewProps.xml",
      targetMode: "Internal",
    });
    pkg.setRels(PRES_PART_NAME, rels);
  }
  return name;
};

/** Writes the given view properties, leaving the rest of the part as it was.
 * Creates the part (and its relationship) when the deck has none. */
export const setViewProperties = (
  pres: PresentationData,
  patch: ViewPropertiesPatch,
): void => {
  const name = ensureViewPropsPart(pres);
  const part = pres[INTERNAL_PACKAGE].getPart(partName(name));
  if (!part) throw new Error("viewProps.xml is missing");
  const doc = parseXml(decode(part.data));
  const root = doc.root;
  if (!isPml(root, "viewPr"))
    throw new Error("viewProps.xml does not hold view properties");
  if (patch.lastView !== undefined) setAttr(root, "lastView", patch.lastView);
  const touchesSlideView =
    patch.snapToGrid !== undefined ||
    patch.snapToObjects !== undefined ||
    patch.showGuides !== undefined ||
    patch.guides !== undefined;
  if (touchesSlideView) {
    const common = ensureCommonSlideView(root);
    if (patch.snapToGrid !== undefined)
      setAttr(common, "snapToGrid", patch.snapToGrid ? null : "0");
    if (patch.snapToObjects !== undefined)
      setAttr(common, "snapToObjects", patch.snapToObjects ? "1" : null);
    if (patch.showGuides !== undefined)
      setAttr(common, "showGuides", patch.showGuides ? "1" : null);
    if (patch.guides !== undefined) {
      const kept = common.children.filter(
        (c) => !(c.kind === "element" && isPml(c, "guideLst")),
      );
      // Guides follow cViewPr and precede nothing else in CT_CommonSlideViewProperties.
      const at = kept.findIndex(
        (c) => c.kind === "element" && isPml(c, "cViewPr"),
      );
      if (patch.guides.length) {
        const list = elem(p("guideLst"), {
          children: patch.guides.map((g) =>
            elem(p("guide"), {
              attrs: [
                attr(bare("orient"), g.orient),
                attr(
                  bare("pos"),
                  String(Math.round(g.pos / EMU_PER_GUIDE_UNIT)),
                ),
              ],
            }),
          ),
        });
        kept.splice(at + 1, 0, list);
      }
      common.children = kept;
      writePresentationGuides(pres, patch.guides);
    }
  }
  if (patch.gridSpacing !== undefined) {
    root.children = root.children.filter(
      (c) => !(c.kind === "element" && isPml(c, "gridSpacing")),
    );
    if (patch.gridSpacing) {
      const cx = Math.max(1, Math.round(patch.gridSpacing.cx));
      const cy = Math.max(1, Math.round(patch.gridSpacing.cy));
      insertChildByRank(
        root,
        elem(p("gridSpacing"), {
          attrs: [attr(bare("cx"), String(cx)), attr(bare("cy"), String(cy))],
        }),
        rankIn(VIEW_PR_ORDER),
      );
    }
  }
  part.data = encode(serializeXml(doc));
};

/** The size of the deck's notes pages (`<p:notesSz>`), in EMU; portrait
 * letter-width 7.5 × 10 inches when the file does not say. */
export const getNotesPageSize = (
  pres: PresentationData,
): { width: number; height: number } => {
  const fallback = { width: 6858000, height: 9144000 };
  const part = pres[INTERNAL_PACKAGE].getPart(PRES_PART_NAME);
  if (!part) return fallback;
  try {
    const root = parseXml(decode(part.data)).root;
    const size = firstChildElement(root, p("notesSz"));
    const cx = Number(size && getAttrValue(size, bare("cx")));
    const cy = Number(size && getAttrValue(size, bare("cy")));
    return cx > 0 && cy > 0 ? { width: cx, height: cy } : fallback;
  } catch {
    return fallback;
  }
};
