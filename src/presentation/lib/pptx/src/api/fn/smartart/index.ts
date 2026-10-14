// SmartArt authoring: public surface.
export {
  type SmartArtItem,
  type SmartArtModel,
  smartArtTextLines,
  normalizeSmartArtItems,
} from "./model.ts";
export {
  SMARTART_CATEGORIES,
  SMARTART_LAYOUTS,
  DEFAULT_SMARTART_LAYOUT,
  type SmartArtCategory,
  type SmartArtLayoutInfo,
} from "./catalog.ts";
export {
  SMARTART_COLOR_SCHEMES,
  SMARTART_STYLES,
  DEFAULT_SMARTART_COLORS,
  DEFAULT_SMARTART_STYLE,
  type SmartArtPalette,
} from "./paint.ts";
export { smartArtPreviewSvg } from "./preview.ts";
export {
  addSlideSmartArt,
  getShapeSmartArt,
  setShapeSmartArt,
  guessSmartArtLayout,
  relayoutSmartArt,
  convertSmartArtToShapes,
} from "./authoring.ts";
