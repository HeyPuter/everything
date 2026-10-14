// Ink timing: when a hand-drawn stroke was drawn, and how long each part of
// it took, kept with the stroke so it can be replayed in drawing order after
// the file is saved and opened again.
//
// The timing is an extension on the shape's `<p:cNvPr>`:
//
//   <a:extLst>
//     <a:ext uri="{9C3B6F1E-5B0D-4E8A-9A41-7F2D6C1B0E57}">
//       <pk:inkTiming xmlns:pk="urn:puter:presentation:ink:2026"
//                     start="1760000000000" t="0 16 40 …"/>
//     </a:ext>
//   </a:extLst>
//
// `start` is the time the stroke began (milliseconds since 1970) and `t` the
// milliseconds since then at which each on-curve point of the stroke's first
// path was reached. Readers that do not know the extension skip it, as the
// format requires; other extensions on the same element are kept.

import {
  NS,
  type XmlElement,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  qname,
} from "../../internal/xml/index.ts";
import { SHAPE_SNAPSHOT, type SlideShapeData } from "../_internal-symbols.ts";
import { commitAndRefresh } from "./_helpers.ts";
import { findCNvPr } from "./shape-click-action.ts";

/** The extension's identifier on `<a:ext uri>`. */
export const INK_TIMING_EXT_URI = "{9C3B6F1E-5B0D-4E8A-9A41-7F2D6C1B0E57}";
const INK_NS = "urn:puter:presentation:ink:2026";

/** When a stroke was drawn: its start, and each point's offset from it. */
export interface InkTiming {
  /** Milliseconds since 1970 at which the stroke began. */
  readonly start: number;
  /** Milliseconds from `start` at which each on-curve point was reached. */
  readonly times: readonly number[];
}

const EXT_LST = qname("a", "extLst", NS.dml);
const EXT = qname("a", "ext", NS.dml);
const TIMING = qname("pk", "inkTiming", INK_NS);
const URI = qname("", "uri", "");

const isElement = (n: unknown): n is XmlElement =>
  !!n && (n as XmlElement).kind === "element";
const isTimingExt = (n: unknown): boolean =>
  isElement(n) &&
  n.name.namespaceURI === NS.dml &&
  n.name.localName === "ext" &&
  getAttrValue(n, URI) === INK_TIMING_EXT_URI;

/** The stroke's drawing times, or null when it has none. */
export const getShapeInkTiming = (shape: SlideShapeData): InkTiming | null => {
  const cNvPr = findCNvPr(shape);
  const extLst = cNvPr && firstChildElement(cNvPr, EXT_LST);
  const ext = extLst?.children.find(isTimingExt) as XmlElement | undefined;
  const timing = ext?.children.find(
    (c): c is XmlElement =>
      isElement(c) &&
      c.name.namespaceURI === INK_NS &&
      c.name.localName === "inkTiming",
  );
  if (!timing) return null;
  const start = Number(getAttrValue(timing, qname("", "start", "")));
  const times = String(getAttrValue(timing, qname("", "t", "")) ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  if (!Number.isFinite(start) || times.some((t) => !Number.isFinite(t)))
    return null;
  return { start, times };
};

/**
 * Records when the stroke was drawn, or removes the record with `null`.
 * Times are rounded to whole milliseconds and kept in order.
 */
export const setShapeInkTiming = (
  shape: SlideShapeData,
  timing: InkTiming | null,
): void => {
  const cNvPr = findCNvPr(shape);
  if (!cNvPr)
    throw new Error(
      `setShapeInkTiming: ${shape[SHAPE_SNAPSHOT].kind} shape has no cNvPr`,
    );
  let extLst = firstChildElement(cNvPr, EXT_LST);
  if (extLst) extLst.children = extLst.children.filter((c) => !isTimingExt(c));
  if (timing) {
    if (!Number.isFinite(timing.start))
      throw new Error("setShapeInkTiming: start must be a number");
    let last = 0;
    const times = timing.times.map((t) => {
      last = Math.max(last, Math.round(Number(t) || 0));
      return last;
    });
    const ext = elem(EXT, {
      attrs: [attr(URI, INK_TIMING_EXT_URI)],
      children: [
        elem(TIMING, {
          attrs: [
            attr(qname("", "start", ""), String(Math.round(timing.start))),
            attr(qname("", "t", ""), times.join(" ")),
          ],
        }),
      ],
    });
    if (!extLst) {
      extLst = elem(EXT_LST);
      // extLst is the last child of cNvPr.
      cNvPr.children.push(extLst);
    }
    extLst.children.push(ext);
  } else if (extLst && !extLst.children.some(isElement)) {
    cNvPr.children = cNvPr.children.filter((c) => c !== extLst);
  }
  commitAndRefresh(shape);
};
