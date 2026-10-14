// internal/presentationml — p: namespace: presentation/slide/layout/master.
// Allowed imports: internal/drawingml, internal/parts, internal/xml.

export { REL_TYPES, type RelType } from "./relationship-types.ts";
export type {
  NotesMasterId,
  PresentationPart,
  SlideId,
  SlideMasterId,
  SlideSize,
} from "./presentation-part.ts";
export { readPresentationPart } from "./presentation-part.ts";
export type { ShapeKind, SlidePart, SlideShape } from "./slide-part.ts";
export {
  readGroupChildren,
  readShapeTreeFromCsldRoot,
  readSlidePart,
  slideText,
} from "./slide-part.ts";
export type { SlideLayoutPart, SlideLayoutType } from "./slide-layout-part.ts";
export { readSlideLayoutPart } from "./slide-layout-part.ts";
export { buildSlideFromLayout } from "./slide-builder.ts";
export type { TextBoxOptions } from "./text-box-builder.ts";
export { buildTextBox } from "./text-box-builder.ts";
export type { PresetShape, ShapeOptions } from "./shape-builder.ts";
export { buildShape } from "./shape-builder.ts";
export type { ConnectorOptions } from "./connector-builder.ts";
export { buildConnector } from "./connector-builder.ts";
export type { GroupOptions } from "./group-builder.ts";
export { buildGroup } from "./group-builder.ts";
export type { PictureOptions } from "./picture-builder.ts";
export { buildPicture } from "./picture-builder.ts";
export type { TableOptions } from "./table-builder.ts";
export { buildTable, buildTableCell, buildTableRow } from "./table-builder.ts";
export { buildEmptyNotesSlide } from "./notes-slide-builder.ts";
export type {
  TransitionEffect,
  TransitionOptions,
  TransitionSound,
} from "./transition-builder.ts";
export {
  buildTransition,
  BASE_TRANSITION_EFFECTS,
  P14_TRANSITION_EFFECTS,
  P159_TRANSITION_EFFECTS,
  PRESET_TRANSITION_EFFECTS,
} from "./transition-builder.ts";
export type { AnimationEffect, AnimationOptions } from "./animation-builder.ts";
export { buildSingleEffectTiming } from "./animation-builder.ts";
export type {
  CommentAuthor,
  CommentAuthorList,
  CommentList,
  CommentPosition,
  SlideComment,
} from "./comments-part.ts";
export {
  buildCommentAuthorListDoc,
  buildCommentListDoc,
  readCommentAuthorList,
  readCommentList,
} from "./comments-part.ts";
