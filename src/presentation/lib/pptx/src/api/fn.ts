// Tree-shakeable free-function entry points — the canonical public API.
//
// Every operation is a standalone export that operates on the opaque
// `PresentationData` / `SlideData` interfaces defined in
// `_internal-symbols.ts`. Consumers can import only what they use and
// modern bundlers drop the rest.
//
// The implementation is split across `./fn/*.ts` by domain. This file
// is the public barrel; do not add logic here.

// Package-level
export * from "./fn/package-io.ts";
export * from "./fn/text-fields.ts";
export * from "./fn/sections.ts";
export * from "./fn/layouts.ts";
export * from "./fn/template-import.ts";
export * from "./fn/embedded-fonts.ts";
export * from "./fn/theme.ts";
export * from "./fn/properties.ts";
export * from "./fn/document-statistics.ts";
export * from "./fn/thumbnail.ts";
export * from "./fn/slide-show.ts";
export * from "./fn/view-properties.ts";
export * from "./fn/outline.ts";

// Slide-level
export * from "./fn/slide-query.ts";
export * from "./fn/slide-deck.ts";

// Shape
export * from "./fn/shape-slide-read.ts";
export * from "./fn/shape-read-base.ts";
export * from "./fn/shape-read-paint.ts";
export {
  getShapeStrokeFormattingEffective,
  getShapeStrokeJoinResolved,
  type ShapeStrokeDash,
  type ShapeStrokeJoin,
  type ShapeStrokeFormatting,
} from "./fn/shape-stroke-formatting.ts";
export * from "./fn/shape-gradient-read.ts";
export * from "./fn/shape-fill-stroke.ts";
export * from "./fn/shape-format-copy.ts";
export * from "./fn/shape-freeform.ts";
export * from "./fn/shape-ink.ts";
export * from "./fn/shape-effects.ts";
export * from "./fn/shape-text.ts";
export * from "./fn/shape-runs.ts";
export * from "./fn/shape-color.ts";
export * from "./fn/shape-paragraph.ts";
export * from "./fn/shape-removal-zorder.ts";
export * from "./fn/shape-authoring.ts";
export * from "./fn/shape-grouping.ts";
export * from "./fn/shape-image.ts";
export * from "./fn/shape-click-action.ts";
export * from "./fn/shape-image-effects.ts";
export * from "./fn/shape-animation.ts";
export * from "./fn/slide-animations.ts";

// Inserted objects: media, vector pictures, actions, embeddings, footers
export * from "./fn/object-data.ts";
export * from "./fn/vector-picture.ts";
export * from "./fn/slide-media.ts";
export * from "./fn/shape-actions.ts";
export * from "./fn/ole-object.ts";
export * from "./fn/header-footer.ts";

// Slide features
export * from "./fn/slide-background.ts";
export * from "./fn/color-map.ts";
export * from "./fn/slide-transition.ts";
export * from "./fn/slide-notes.ts";
export * from "./fn/slide-size.ts";
export * from "./fn/slide-title.ts";

// Tables / charts / comments / validation / package introspection
export * from "./fn/comments.ts";
export * from "./fn/comment-threads.ts";
export * from "./fn/custom-properties.ts";
export * from "./fn/charts.ts";
export * from "./fn/tables.ts";
export { getTableStyleResolver } from "./fn/table-styles.ts";
export type {
  TableResolvedFill,
  TableResolvedBorder,
  TableResolvedCellStyle,
  TableStyleResolver,
} from "./fn/table-styles.ts";
export * from "./fn/validation.ts";
export * from "./fn/package-introspection.ts";
export {
  getShapeGeometryEffective,
  getShapeGeometryResolved,
  type ShapeGeometry,
  type ShapeGeometryResolved,
} from "./fn/shape-geometry.ts";
