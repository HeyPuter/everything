// The typefaces a presentation's slides and theme use, and replacing one
// typeface with another everywhere slides name it — runs, paragraph and list
// defaults, bullet fonts — and in the theme's heading and body fonts.

import {
  type XmlElement,
  NS,
  getAttrValue,
  qname,
} from "../../internal/xml/index.ts";
import { type PresentationData, SLIDE_DOCUMENT } from "../_internal-symbols.ts";
import { commitSlideData, refreshSlideData } from "./_helpers.ts";
import { getSlides } from "./slide-query.ts";
import { getPresentationFonts, setPresentationFonts } from "./theme.ts";

const FONT_ELEMENTS = new Set(["latin", "ea", "cs", "sym", "buFont"]);
const TYPEFACE = qname("", "typeface", "");

function* fontElements(root: XmlElement): Generator<XmlElement> {
  const stack: XmlElement[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    if (el.name.namespaceURI === NS.dml && FONT_ELEMENTS.has(el.name.localName))
      yield el;
    for (const c of el.children) if (c.kind === "element") stack.push(c);
  }
}

/** Typefaces named on the slides and in the theme, sorted, without the
 * theme's `+mj-lt` style tokens. */
export const getPresentationTypefaces = (pres: PresentationData): string[] => {
  const names = new Set<string>();
  for (const slide of getSlides(pres))
    for (const el of fontElements(slide[SLIDE_DOCUMENT].root)) {
      const face = getAttrValue(el, TYPEFACE);
      if (face && !face.startsWith("+")) names.add(face);
    }
  const theme = getPresentationFonts(pres);
  for (const face of [theme?.majorLatin, theme?.minorLatin])
    if (face) names.add(face);
  return [...names].sort((a, b) => a.localeCompare(b));
};

/**
 * Replaces `from` with `to` wherever slides or the theme name it. Returns
 * how many places changed.
 */
export const replacePresentationTypeface = (
  pres: PresentationData,
  from: string,
  to: string,
): number => {
  const target = to.trim();
  if (!from || !target || from === target) return 0;
  let count = 0;
  for (const slide of getSlides(pres)) {
    let changed = false;
    for (const el of fontElements(slide[SLIDE_DOCUMENT].root)) {
      if (getAttrValue(el, TYPEFACE) !== from) continue;
      el.attrs = el.attrs.map((a) =>
        a.name.namespaceURI === "" && a.name.localName === "typeface"
          ? { ...a, value: target }
          : a,
      );
      // A face replaced by another keeps none of the old one's metrics.
      el.attrs = el.attrs.filter(
        (a) =>
          !(
            a.name.namespaceURI === "" &&
            (a.name.localName === "panose" ||
              a.name.localName === "pitchFamily" ||
              a.name.localName === "charset")
          ),
      );
      changed = true;
      count++;
    }
    if (changed) {
      commitSlideData(slide);
      refreshSlideData(slide);
    }
  }
  const theme = getPresentationFonts(pres);
  const themeChanges: Record<string, string> = {};
  if (theme?.majorLatin === from) themeChanges.majorLatin = target;
  if (theme?.minorLatin === from) themeChanges.minorLatin = target;
  if (Object.keys(themeChanges).length) {
    setPresentationFonts(pres, themeChanges);
    count += Object.keys(themeChanges).length;
  }
  return count;
};
