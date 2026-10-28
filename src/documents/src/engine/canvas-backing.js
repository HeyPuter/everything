// The backing store of a page canvas. Safari on iOS and iPadOS draws nothing in a canvas of more
// than 4096 × 4096 pixels (16,777,216), and other browsers have larger limits. A page zoomed in on
// a high-density display can exceed it (a Letter page at 200% on a 3x phone is 4896 × 6336), so
// such a page is given fewer device pixels per CSS pixel, the same factor on both sides, rather
// than going blank. Painting scales by the canvas's own width (canvas-editor.js); pointer and
// caret geometry use CSS pixels, so neither depends on this resolution.
export const MAX_CANVAS_PIXELS = 4096 * 4096;

/** Device pixels for a page shown at cssWidth × cssHeight CSS pixels on a display of `ratio`. */
export function pageBackingSize(cssWidth, cssHeight, ratio, maxPixels = MAX_CANVAS_PIXELS) {
  let width = Math.round(cssWidth * ratio), height = Math.round(cssHeight * ratio);
  if (width * height <= maxPixels) return { width, height };
  const scale = Math.sqrt(maxPixels / (cssWidth * cssHeight));
  width = Math.max(1, Math.floor(cssWidth * scale)); height = Math.max(1, Math.floor(cssHeight * scale));
  return { width, height };
}
