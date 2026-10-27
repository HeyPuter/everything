// A long document paints only the pages on screen at once and the rest later; a page paints itself
// when its pixels are read. Tests that record what every page paints read the pages first.
export function paintAllPages(page) {
  return page.evaluate(() => document.querySelectorAll('canvas.canvas-page').forEach(canvas => canvas.getContext('2d')));
}
