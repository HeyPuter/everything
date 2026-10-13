// The slide outline: each slide's title placeholder and its first body-like
// placeholder (body, content or subtitle), the text an outline shows.

import { readOnlyPartRoot } from "../../internal/parts/read-only-xml.ts";
import { partName } from "../../internal/opc/index.ts";
import { readShapeTreeFromCsldRoot } from "../../internal/presentationml/index.ts";
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
  LAYOUT_PART,
  SHAPE_SNAPSHOT,
  SLIDE_SHAPES,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { appendAndReturnNewShape, nextShapeId } from "./_helpers.ts";
import { getSlideLayout } from "./shape-slide-read.ts";
import { getSlideMasterPartName } from "./shape-read-base.ts";

const TITLE_TYPES = new Set(["title", "ctrTitle"]);
const BODY_TYPES = new Set(["body", "obj", "subTitle"]);

const isBodyLike = (type: string | null, idx: number | null): boolean =>
  type === null ? idx !== null : BODY_TYPES.has(type);

/** The placeholders an outline reads and writes on a slide. */
export const getSlideOutlineShapes = (
  slide: SlideData,
): { title: SlideShapeData | null; body: SlideShapeData | null } => {
  let title: SlideShapeData | null = null;
  let body: SlideShapeData | null = null;
  for (const shape of slide[SLIDE_SHAPES]) {
    const snap = shape[SHAPE_SNAPSHOT];
    if (snap.kind !== "shape") continue;
    if (!title && snap.placeholderType && TITLE_TYPES.has(snap.placeholderType))
      title = shape;
    else if (!body && isBodyLike(snap.placeholderType, snap.placeholderIdx))
      body = shape;
  }
  return { title, body };
};

const p = (local: string) => qname("p", local, NS.pml);
const a = (local: string) => qname("a", local, NS.dml);
const bare = (local: string) => qname("", local, "");

// The position a master gives its placeholder of this type, for a slide
// whose layout has no such placeholder to inherit from.
const masterBounds = (
  slide: SlideData,
  type: "title" | "body",
): { x: number; y: number; w: number; h: number } | null => {
  const name = getSlideMasterPartName(slide);
  const part = name && slide[INTERNAL_PACKAGE].getPart(partName(name));
  if (!part) return null;
  const root = readOnlyPartRoot(part);
  for (const shape of readShapeTreeFromCsldRoot(root, "sldMaster").shapes) {
    const kind =
      shape.placeholderType ?? (shape.placeholderIdx !== null ? "body" : null);
    if (kind !== type) continue;
    const spPr = firstChildElement(shape.element, p("spPr"));
    const xfrm = spPr && firstChildElement(spPr, a("xfrm"));
    const off = xfrm && firstChildElement(xfrm, a("off"));
    const ext = xfrm && firstChildElement(xfrm, a("ext"));
    if (!off || !ext) return null;
    const n = (e: XmlElement, k: string) => Number(getAttrValue(e, bare(k)));
    return { x: n(off, "x"), y: n(off, "y"), w: n(ext, "cx"), h: n(ext, "cy") };
  }
  return null;
};

/**
 * Adds an empty title or body placeholder to a slide that has none, bound to
 * the matching placeholder of the slide's layout when it has one. A layout
 * without one leaves the new placeholder at the master's position, written
 * out so the slide keeps it. Returns the existing placeholder when there is
 * one already.
 */
export const addSlideOutlinePlaceholder = (
  slide: SlideData,
  kind: "title" | "body",
): SlideShapeData => {
  const existing = getSlideOutlineShapes(slide)[kind];
  if (existing) return existing;
  const layout = getSlideLayout(slide);
  const slots = layout ? layout[LAYOUT_PART].shapes : [];
  const slot = slots.find((s) =>
    kind === "title"
      ? !!s.placeholderType && TITLE_TYPES.has(s.placeholderType)
      : isBodyLike(s.placeholderType, s.placeholderIdx),
  );
  const phAttrs = [];
  if (slot) {
    if (slot.placeholderType)
      phAttrs.push(attr(bare("type"), slot.placeholderType));
    if (slot.placeholderIdx !== null)
      phAttrs.push(attr(bare("idx"), String(slot.placeholderIdx)));
  } else if (kind === "title") phAttrs.push(attr(bare("type"), "title"));
  else phAttrs.push(attr(bare("type"), "body"), attr(bare("idx"), "1"));
  const bounds = slot ? null : masterBounds(slide, kind);
  const id = nextShapeId(slide);
  const spPrChildren = bounds
    ? [
        elem(a("xfrm"), {
          children: [
            elem(a("off"), {
              attrs: [
                attr(bare("x"), String(bounds.x)),
                attr(bare("y"), String(bounds.y)),
              ],
            }),
            elem(a("ext"), {
              attrs: [
                attr(bare("cx"), String(bounds.w)),
                attr(bare("cy"), String(bounds.h)),
              ],
            }),
          ],
        }),
      ]
    : [];
  const sp = elem(p("sp"), {
    children: [
      elem(p("nvSpPr"), {
        children: [
          elem(p("cNvPr"), {
            attrs: [
              attr(bare("id"), String(id)),
              attr(
                bare("name"),
                `${kind === "title" ? "Title" : "Text Placeholder"} ${id - 1}`,
              ),
            ],
          }),
          elem(p("cNvSpPr"), {
            children: [
              elem(a("spLocks"), { attrs: [attr(bare("noGrp"), "1")] }),
            ],
          }),
          elem(p("nvPr"), { children: [elem(p("ph"), { attrs: phAttrs })] }),
        ],
      }),
      elem(p("spPr"), { children: spPrChildren }),
      elem(p("txBody"), {
        children: [
          elem(a("bodyPr")),
          elem(a("lstStyle")),
          elem(a("p"), {
            children: [
              elem(a("endParaRPr"), { attrs: [attr(bare("lang"), "en-US")] }),
            ],
          }),
        ],
      }),
    ],
  });
  return appendAndReturnNewShape(slide, sp);
};
