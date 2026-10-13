// Decorative objects: an object marked decorative (`adec:decorative` in its
// `cNvPr` extension list) is skipped by screen readers and needs no
// alternative text.

import {
  type XmlElement,
  childElements,
  parseFragment,
} from "../../internal/xml/index.ts";
import {
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  SLIDE_SHAPES,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import {
  appendAndReturnNewShape,
  commitAndRefresh,
  commitSlideData,
  nextShapeId,
  rebuildShapesFromDocument,
} from "./_helpers.ts";
import { findCNvPr } from "./shape-click-action.ts";

const DECORATIVE_URI = "{C183D7F6-B498-43B3-948B-1728B52AA6E4}";
const NS_ADEC = "http://schemas.microsoft.com/office/drawing/2017/decorative";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";

const extList = (cNvPr: XmlElement): XmlElement | null =>
  childElements(cNvPr).find((c) => c.name.localName === "extLst") ?? null;
const decorativeExt = (cNvPr: XmlElement): XmlElement | null => {
  const list = extList(cNvPr);
  return list
    ? (childElements(list).find(
        (e) =>
          e.attrs.find((a) => a.name.localName === "uri")?.value ===
          DECORATIVE_URI,
      ) ?? null)
    : null;
};

/** Whether the object is marked decorative. */
export const isShapeDecorative = (shape: SlideShapeData): boolean => {
  const cNvPr = findCNvPr(shape);
  const ext = cNvPr && decorativeExt(cNvPr);
  if (!ext) return false;
  const flag = childElements(ext).find(
    (e) => e.name.localName === "decorative",
  );
  const val = flag?.attrs.find((a) => a.name.localName === "val")?.value;
  return val === "1" || val === "true";
};

/**
 * Marks the object decorative, or clears the mark. Marking it also clears
 * its alternative text, which a decorative object does not have.
 */
export const setShapeDecorative = (
  shape: SlideShapeData,
  decorative: boolean,
): void => {
  const cNvPr = findCNvPr(shape);
  if (!cNvPr) throw new Error("setShapeDecorative: the object has no cNvPr");
  const list = extList(cNvPr);
  const ext = decorativeExt(cNvPr);
  if (ext && list) list.children = list.children.filter((n) => n !== ext);
  if (list && !childElements(list).length)
    cNvPr.children = cNvPr.children.filter((n) => n !== list);
  if (decorative) {
    cNvPr.attrs = cNvPr.attrs.filter(
      (a) => !(a.name.namespaceURI === "" && a.name.localName === "descr"),
    );
    let target = extList(cNvPr);
    if (!target) {
      target = parseFragment(`<a:extLst xmlns:a="${NS_A}"/>`);
      cNvPr.children.push(target);
    }
    target.children.push(
      parseFragment(
        `<a:ext xmlns:a="${NS_A}" uri="${DECORATIVE_URI}"><adec:decorative xmlns:adec="${NS_ADEC}" val="1"/></a:ext>`,
      ),
    );
  }
  commitAndRefresh(shape);
};

// ---------------------------------------------------------------------------
// Slide titles for screen readers.

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Adds a title placeholder to a slide that has none. A visible title takes
 * the layout's title position (or `box` when given); a hidden one sits just
 * above the slide, where screen readers find it but the slide show does not
 * show it.
 */
export const addSlideTitlePlaceholder = (
  slide: SlideData,
  title: string,
  options: {
    hidden?: boolean;
    box?: { x: number; y: number; w: number; h: number };
    slideHeight?: number;
  } = {},
): SlideShapeData => {
  const id = nextShapeId(slide);
  const box =
    options.box ??
    (options.hidden
      ? {
          x: 0,
          y: -Math.round((options.slideHeight ?? 6858000) * 0.15) - 457200,
          w: 9144000,
          h: Math.round((options.slideHeight ?? 6858000) * 0.15),
        }
      : null);
  const xfrm = box
    ? `<a:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.w)}" cy="${Math.round(box.h)}"/></a:xfrm>`
    : "";
  const sp = parseFragment(
    `<p:sp xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:nvSpPr><p:cNvPr id="${id}" name="Title ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xmlEscape(title)}</a:t></a:r></a:p></p:txBody></p:sp>`,
  );
  sp.prefixDecls = new Map();
  return appendAndReturnNewShape(slide, sp);
};

/**
 * Gives an object a different `cNvPr/@id`, as when a copy takes the place of
 * the object it replaces. Throws if another object on the slide has the id.
 */
export const setShapeIdentifier = (shape: SlideShapeData, id: number): void => {
  const slide = shape[SHAPE_SLIDE];
  if (
    slide[SLIDE_SHAPES].some((s) => s !== shape && s[SHAPE_SNAPSHOT].id === id)
  )
    throw new Error(`setShapeIdentifier: id ${id} is already in use`);
  const cNvPr = findCNvPr(shape);
  if (!cNvPr) throw new Error("setShapeIdentifier: the object has no cNvPr");
  cNvPr.attrs = cNvPr.attrs.map((a) =>
    a.name.namespaceURI === "" && a.name.localName === "id"
      ? { ...a, value: String(id) }
      : a,
  );
  commitSlideData(slide);
  rebuildShapesFromDocument(slide);
};
