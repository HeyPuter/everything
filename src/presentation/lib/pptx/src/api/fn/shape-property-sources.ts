import {
  partName,
  resolveTarget,
  type PartName,
} from "../../internal/opc/index.ts";
import { readOnlyPartRoot } from "../../internal/parts/read-only-xml.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import { type XmlElement } from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  LAYOUT_PART_NAME,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SLIDE_DOCUMENT,
  SLIDE_PART_NAME,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { getPlaceholderInheritance } from "./placeholder-inheritance.ts";
import { getSlideMasterPartName } from "./shape-read-base.ts";
import { getSlideLayout } from "./shape-slide-read.ts";

// Synthetic layout views already own a layout part rather than a slide→layout
// relationship. Resolve their master directly without losing its rId scope.
export const shapeMasterPartName = (shape: SlideShapeData): string | null => {
  const slide = shape[SHAPE_SLIDE];
  const root = slide[SLIDE_DOCUMENT].root.name.localName;
  if (root === "sldMaster" || root === "notesMaster")
    return slide[SLIDE_PART_NAME];
  if (root !== "sldLayout") return getSlideMasterPartName(slide);
  const rel = slide[INTERNAL_PACKAGE].getRels(
    slide[SLIDE_PART_NAME],
  )?.items.find(
    (r) => r.type === REL_TYPES.slideMaster && r.targetMode !== "External",
  );
  return rel ? resolveTarget(slide[SLIDE_PART_NAME], rel.target) : null;
};

export interface ShapePropertySource {
  readonly element: XmlElement;
  readonly root: XmlElement;
  readonly owner: PartName;
}

/** Nearest-first, read-only source shapes. Each part keeps its own rId scope. */
export function* iterateShapePropertySources(
  shape: SlideShapeData,
): Generator<ShapePropertySource> {
  const slide = shape[SHAPE_SLIDE],
    pkg = slide[INTERNAL_PACKAGE];
  yield {
    element: shape[SHAPE_ELEMENT],
    root: slide[SLIDE_DOCUMENT].root,
    owner: slide[SLIDE_PART_NAME],
  };
  const inherited = getPlaceholderInheritance(shape);
  if (!inherited) return;
  const layout = getSlideLayout(slide),
    master = shapeMasterPartName(shape);
  for (const [ancestor, name] of [
    [inherited.layout, layout?.[LAYOUT_PART_NAME]],
    [inherited.master, master],
  ] as const) {
    if (!ancestor || !name) continue;
    const part = pkg.getPart(partName(name));
    if (part)
      yield {
        element: ancestor.element,
        root: readOnlyPartRoot(part),
        owner: partName(name),
      };
  }
}

/** Array view for callers that merge layers from farthest to nearest. */
export const shapePropertySources = (
  shape: SlideShapeData,
): ShapePropertySource[] => [...iterateShapePropertySources(shape)];
