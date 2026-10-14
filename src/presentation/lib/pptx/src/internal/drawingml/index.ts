// internal/drawingml — a: namespace: shapes, text, geometry, color, effects.
// Allowed imports: internal/xml.

export {
  paragraphText,
  paragraphsOf,
  runsOf,
  textBodyText,
} from "./text-body.ts";
export {
  applyAlignmentToAllParagraphs,
  applyBulletToAllParagraphs,
  applyBulletToParagraph,
  type BulletStyle,
  type ParagraphAlignment,
  replaceTextInTree,
  replaceTokensInTree,
  setTextBody,
} from "./text-body-mutation.ts";
export type {
  TextFormat,
  TextOutline,
  TextGradient,
  TextEffects,
} from "./text-format.ts";
export { applyFormatToAllRuns, applyRunFormat } from "./text-format.ts";
export type { ParsedColor } from "./color.ts";
export { buildColorElement, parseColor, parseSrgbHex } from "./color.ts";
export type {
  GradientFillOptions,
  GradientStop,
  PatternFillOptions,
  PatternPreset,
} from "./fill.ts";
export {
  clearFill,
  setGradientFill,
  setNoFill,
  setPatternFill,
  setSolidFill,
} from "./fill.ts";
export type { GlowOptions, ShadowOptions } from "./effects.ts";
export { clearEffects, setGlow, setShadow } from "./effects.ts";
export type {
  ArrowOptions,
  LineCap,
  LineCompound,
  LineDash,
  LineEndSize,
  LineEndType,
  LineJoin,
  StrokeOptions,
} from "./stroke.ts";
export {
  clearStroke,
  setNoStroke,
  setSolidStroke,
  setStrokeArrow,
  setStrokeCap,
  setStrokeCompound,
  setStrokeDash,
  setStrokeJoin,
} from "./stroke.ts";
export type {
  CustomGeometry,
  GeomCommand,
  GeomPath,
  GeomPoint,
  GeomTextRect,
  PathFillMode,
} from "./custom-geometry.ts";
export { parseCustomGeometry } from "./custom-geometry.ts";
export { parsePresetGeometry } from "./preset-geometry.ts";
export { resolveGeometryArc } from "./geometry-arc.ts";
export type { GeometryArcSegment } from "./geometry-arc.ts";
export { applyHyperlinkToAllRuns } from "./hyperlink.ts";
export { getPictureEmbedRId } from "./picture-mutation.ts";
export type { Position, ShapeKindForGeometry, Size } from "./geometry.ts";
export {
  findTransform,
  readFlip,
  readPosition,
  readRotation,
  readSize,
  readTransformBounds,
} from "./geometry.ts";
export {
  setAdjustValues,
  setFlip,
  setPosition,
  setRotation,
  setSize,
} from "./geometry-mutation.ts";
