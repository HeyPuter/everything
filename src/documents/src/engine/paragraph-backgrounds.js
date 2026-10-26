import { runBackground } from './backgrounds.js';

/** Final physical bounds, after pagination, cell placement and header repeats. */
export function paragraphBackgroundRect(line, page, cell) {
  if (line.frameId) page = { ...page, top: 0, bottom: 0 };
  const band = line.paragraphBackground;
  if (!band) return null;
  const x = Math.max(0, cell?.x ?? 0, line.cellClip?.left ?? -Infinity, band.x);
  const right = Math.min(page.width, cell ? cell.x + cell.width : page.width, line.cellClip?.right ?? Infinity, band.x + band.width);
  const y = Math.max(page.top, cell?.y ?? page.top, line.cellClip?.top ?? -Infinity, line.y - band.before);
  const bottom = Math.min(page.height - page.bottom, cell ? cell.y + cell.height : page.height, line.cellClip?.bottom ?? Infinity, line.y + line.height + band.after);
  if (line.cellClip && bottom <= y) return null;
  // Native paragraph solid/auto shading is black, including on dark pages
  // and cells. This differs from automatic glyph/run-background contrast.
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y), color: band.value==='foreground'?'#000000':runBackground({ shading: band.value }, cell?.fill || page.background || '#FFFFFF') };
}

/** Union each paragraph fragment so tall glyphs and decorations between its
 * lines see the same background. Repeated headers retain their placed bounds. */
export function paragraphBackgrounds(lines, page, cells) {
  const groups = new Map(), result = new Map(), boxes = new Map();
  // Each line looks up its own cell fragment: a page of a long table paints thousands of lines over
  // thousands of cells, which searching the cells for every line made slow to paint.
  const cellKey = (id, pageIndex, column) => `${id}\u0000${pageIndex}\u0000${column}`;
  for (const c of cells) { const key = cellKey(c.id, c.page, c.column); if (!boxes.has(key)) boxes.set(key, c); }
  for (const line of lines) {
    const cell = line.cellId == null ? undefined : boxes.get(cellKey(line.cellId, line.page, line.column));
    let rect = paragraphBackgroundRect(line, line.storyGeometry ? { ...line.storyGeometry, background: page.background } : page, cell);
    if (rect) {
      const key = `${line.page}:${line.column ?? 0}:${line.paragraphId}`;
      const previous = groups.get(key);
      if (previous) {
        const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
        previous.y = Math.min(previous.y, rect.y); previous.height = bottom - previous.y;
        rect = previous;
      } else groups.set(key, rect);
    }
    result.set(line, { rect, base: cell?.fill || page.background || '#FFFFFF' });
  }
  return result;
}

// Automatic glyph/pattern colors must use the background actually beneath
// them, even for an overhanging glyph or a label outside the paragraph band.
export function paintOnParagraphBackground(ctx, rect, page, background, draw) {
  if (!rect || rect.color.toUpperCase() === background.toUpperCase()) { draw(background); return; }
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, page.width, page.height);
  ctx.rect(rect.x, rect.y, rect.width, rect.height); ctx.clip('evenodd');
  draw(background); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.width, rect.height); ctx.clip();
  draw(rect.color); ctx.restore();
}
