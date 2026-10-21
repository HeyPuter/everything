// Group / ungroup shapes (`<p:grpSp>`).
//
// Grouping wraps a selection's shapes in a `<p:grpSp>`
// whose transform maps a child coordinate space onto the slide. At
// creation time the child space is set 1:1 with the group's own slide-space
// bounds (`chOff == off`, `chExt == ext`) — see `group-builder.ts`. That
// convention is what makes `ungroupShapes` a pure structural move in the
// common case (no move/resize since grouping): children already carry
// slide-space coordinates, so no rescale is needed. If the group *was*
// subsequently moved or resized (its `off`/`ext` diverged from its
// `chOff`/`chExt`), ungrouping rescales each child's own transform so it
// keeps its on-slide position and size.

import {
  readPosition,
  readRotation,
  readSize,
  setPosition as writePosition,
  setSize as writeSize,
} from "../../internal/drawingml/index.ts";
import {
  buildGroup,
  readGroupChildren,
} from "../../internal/presentationml/index.ts";
import { type XmlElement } from "../../internal/xml/index.ts";
import {
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  SLIDE_SHAPES,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import {
  commitSlideData,
  nextShapeId,
  rebuildShapesFromDocument,
  requireSpTree,
} from "./_helpers.ts";
import { getGroupTransform } from "./shape-read-base.ts";

/**
 * Groups two or more top-level shapes into a single `<p:grpSp>`,
 * returning the new group as a `SlideShapeData`. The group's
 * slide-space bounds are the union of its members' bounds, a turned
 * member's as the slide shows it; the members
 * keep their own relative position/size (nothing is rescaled). The
 * target slide is taken from the first shape — every shape must belong
 * to the same slide.
 *
 * Every shape must:
 *   - belong to the same slide as the others,
 *   - be a direct child of the slide's shape tree (not already nested
 *     inside another group — ungroup first, then re-group),
 *   - have an explicit `<a:xfrm>` (placeholders that inherit position
 *     from the layout have none and can't be grouped),
 *   - appear at most once in `shapes` (grouping the same shape twice
 *     would duplicate its id).
 *
 * The group replaces its members at the position of the earliest one in
 * z-order, so grouping doesn't change how the selection stacks against
 * shapes that weren't part of it.
 */
export const groupShapes = (
  shapes: ReadonlyArray<SlideShapeData>,
  opts: { name?: string } = {},
): SlideShapeData => {
  if (shapes.length < 2) {
    throw new Error("groupShapes: at least 2 shapes are required");
  }
  const slide = shapes[0]![SHAPE_SLIDE];
  const spTree = requireSpTree(slide);

  const elements: XmlElement[] = [];
  const seen = new Set<XmlElement>();
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const shape of shapes) {
    if (shape[SHAPE_SLIDE] !== slide) {
      throw new Error("groupShapes: all shapes must belong to the same slide");
    }
    const el = shape[SHAPE_ELEMENT];
    if (seen.has(el)) {
      throw new Error(
        `groupShapes: shape "${shape[SHAPE_SNAPSHOT].name}" was passed twice`,
      );
    }
    seen.add(el);
    if (!spTree.children.includes(el)) {
      throw new Error(
        `groupShapes: shape "${shape[SHAPE_SNAPSHOT].name}" is not a direct child of the ` +
          "slide (it may already be inside a group)",
      );
    }
    const kind = shape[SHAPE_SNAPSHOT].kind;
    const pos = readPosition(el, kind);
    const size = readSize(el, kind);
    if (pos === null || size === null) {
      throw new Error(
        `groupShapes: shape "${shape[SHAPE_SNAPSHOT].name}" has no explicit position/size ` +
          "(placeholders that inherit geometry from the layout can't be grouped)",
      );
    }
    elements.push(el);
    // A turned member takes the room the slide shows it in, as it does in
    // PowerPoint; its own box turns about its center.
    const rad = (readRotation(el, kind) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad)),
      sin = Math.abs(Math.sin(rad));
    const w = size.w * cos + size.h * sin,
      h = size.w * sin + size.h * cos;
    const x = pos.x + (size.w - w) / 2,
      y = pos.y + (size.h - h) / 2;
    minX = Math.min(minX, Math.round(x));
    minY = Math.min(minY, Math.round(y));
    maxX = Math.max(maxX, Math.round(x + w));
    maxY = Math.max(maxY, Math.round(y + h));
  }

  // Build the group element before touching `spTree.children` — it
  // validates the computed bounds as EMU coordinates and can throw. Doing
  // that after removing the members from the tree would leave the slide
  // missing shapes with no group to replace them.
  const grp = buildGroup({
    id: nextShapeId(slide),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    children: elements,
  });

  const insertAt = Math.min(
    ...elements.map((el) => spTree.children.indexOf(el)),
  );
  spTree.children = spTree.children.filter(
    (c) => c.kind !== "element" || !seen.has(c),
  );
  spTree.children.splice(insertAt, 0, grp);

  commitSlideData(slide);
  rebuildShapesFromDocument(slide);
  const created = slide[SLIDE_SHAPES].find((s) => s[SHAPE_ELEMENT] === grp);
  if (!created) throw new Error("groupShapes: post-condition failed");
  return created;
};

/**
 * Reverses `groupShapes`: removes the `<p:grpSp>` and re-inserts its
 * immediate children as top-level shapes at the group's former position,
 * rescaling each child's own transform so it keeps its on-slide position
 * and size (matters when the group was moved/resized after creation, so
 * its `off`/`ext` diverged from its `chOff`/`chExt`). Returns the
 * children as fresh `SlideShapeData` handles, in their original order.
 *
 * Throws if `group` isn't a group shape, or its `<p:grpSpPr>` carries no
 * `<a:xfrm>` (malformed — every authored group has one).
 */
export const ungroupShapes = (
  group: SlideShapeData,
): ReadonlyArray<SlideShapeData> => {
  if (group[SHAPE_SNAPSHOT].kind !== "group") {
    throw new Error("ungroupShapes: shape is not a group");
  }
  const transform = getGroupTransform(group);
  if (!transform) {
    throw new Error("ungroupShapes: group has no <a:xfrm> on <p:grpSpPr>");
  }
  const { outer, inner } = transform;
  const scaleX = inner.w === 0 ? 1 : outer.w / inner.w;
  const scaleY = inner.h === 0 ? 1 : outer.h / inner.h;

  const slide = group[SHAPE_SLIDE];
  const spTree = requireSpTree(slide);
  const groupEl = group[SHAPE_ELEMENT];
  const idx = spTree.children.indexOf(groupEl);
  if (idx < 0)
    throw new Error("ungroupShapes: group is not attached to the slide");

  const children = readGroupChildren(groupEl);
  const childElements = children.map((child) => {
    const pos = readPosition(child.element, child.kind);
    const size = readSize(child.element, child.kind);
    if (pos !== null && size !== null) {
      const newX = Math.round(outer.x + (pos.x - inner.x) * scaleX);
      const newY = Math.round(outer.y + (pos.y - inner.y) * scaleY);
      writePosition(child.element, child.kind, newX, newY);
      writeSize(
        child.element,
        child.kind,
        Math.round(size.w * scaleX),
        Math.round(size.h * scaleY),
      );
    }
    return child.element;
  });

  spTree.children.splice(idx, 1, ...childElements);

  commitSlideData(slide);
  rebuildShapesFromDocument(slide);
  const byElement = new Map(
    slide[SLIDE_SHAPES].map((s) => [s[SHAPE_ELEMENT], s] as const),
  );
  return childElements.map((el) => {
    const found = byElement.get(el);
    if (!found) throw new Error("ungroupShapes: post-condition failed");
    return found;
  });
};
