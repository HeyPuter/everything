import { partName } from "../../internal/opc/index.ts";
import { readOnlyPartRoot } from "../../internal/parts/read-only-xml.ts";
import {
  NS,
  firstChildElement,
  getAttrValue,
  attr,
  elem,
  qname,
  type XmlElement,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  SHAPE_SLIDE,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { PRES_PART_NAME } from "./_helpers.ts";
import { getPlaceholderInheritance } from "./placeholder-inheritance.ts";

import {
  shapeMasterPartName as masterPartName,
  shapePropertySources as textBodySources,
  type ShapePropertySource as TextInheritanceSource,
} from "./shape-property-sources.ts";
export { textBodySources, type TextInheritanceSource };

export const drawingChild = (
  el: XmlElement | null,
  local: string,
): XmlElement | null =>
  el ? firstChildElement(el, qname("a", local, NS.dml)) : null;

export const textBody = (shape: XmlElement): XmlElement | null =>
  firstChildElement(shape, qname("p", "txBody", NS.pml));

export const bodyPropertySources = (
  shape: SlideShapeData,
): TextInheritanceSource[] =>
  textBodySources(shape).flatMap((source) => {
    const element = drawingChild(textBody(source.element), "bodyPr");
    return element ? [{ ...source, element }] : [];
  });

/** The text-body and placeholder list styles, followed by the master style. */
export const textListStyleSources = (
  shape: SlideShapeData,
): TextInheritanceSource[] => {
  const sources = textBodySources(shape).flatMap((source) => {
    const element = drawingChild(textBody(source.element), "lstStyle");
    return element ? [{ ...source, element }] : [];
  });
  const inherited = getPlaceholderInheritance(shape),
    name = inherited?.masterRoot ? masterPartName(shape) : null;
  if (inherited?.masterRoot && name) {
    const styles = firstChildElement(
      inherited.masterRoot,
      qname("p", "txStyles", NS.pml),
    );
    const type = inherited.masterType;
    const notes = inherited.masterRoot.name.localName === "notesMaster";
    const local =
      type === "title" || type === "ctrTitle"
        ? "titleStyle"
        : type === "body" || type === "subTitle"
          ? notes
            ? "notesStyle"
            : "bodyStyle"
          : "otherStyle";
    // A notes master keeps its notes text style beside its shapes.
    const container = local === "notesStyle" ? inherited.masterRoot : styles;
    const element =
      container && firstChildElement(container, qname("p", local, NS.pml));
    if (element)
      sources.push({
        element,
        root: inherited.masterRoot,
        owner: partName(name),
      });
  }
  const presentation =
    shape[SHAPE_SLIDE][INTERNAL_PACKAGE].getPart(PRES_PART_NAME);
  if (presentation) {
    const root = readOnlyPartRoot(presentation),
      element = firstChildElement(root, qname("p", "defaultTextStyle", NS.pml));
    if (element) sources.push({ element, root, owner: PRES_PART_NAME });
  }
  return sources;
};

/** Outline levels use the same slots as the effective text readers. */
export const listStyleLevel = (
  list: XmlElement | null,
  level: number,
): XmlElement | null =>
  drawingChild(list, `lvl${Math.max(0, Math.min(8, level)) + 1}pPr`) ??
  (level === 0 ? drawingChild(list, "defPPr") : null);

/** Shape-style font references are below the authored text-style cascade. */
export const textFontReferenceDefaults = (
  shape: SlideShapeData,
): TextInheritanceSource | null => {
  for (const source of textBodySources(shape)) {
    const style = firstChildElement(
        source.element,
        qname("p", "style", NS.pml),
      ),
      ref = drawingChild(style, "fontRef");
    if (!ref) continue;
    const idx = getAttrValue(ref, qname("", "idx", "")),
      result = elem(qname("a", "defRPr", NS.dml), {
        prefixDecls: new Map(ref.prefixDecls),
      });
    const color = ref.children.find(
      (c): c is XmlElement =>
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        [
          "srgbClr",
          "schemeClr",
          "scrgbClr",
          "hslClr",
          "sysClr",
          "prstClr",
        ].includes(c.name.localName),
    );
    if (color)
      result.children.push(
        elem(qname("a", "solidFill", NS.dml), { children: [color] }),
      );
    if (idx === "major" || idx === "minor")
      for (const [local, slot] of [
        ["latin", "lt"],
        ["ea", "ea"],
        ["cs", "cs"],
      ])
        result.children.push(
          elem(qname("a", local!, NS.dml), {
            attrs: [
              attr(
                qname("", "typeface", ""),
                `+m${idx === "major" ? "j" : "n"}-${slot}`,
              ),
            ],
          }),
        );
    return { ...source, element: result };
  }
  return null;
};
