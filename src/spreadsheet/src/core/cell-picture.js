/**
 * Pictures placed in cells (Insert ▸ Pictures ▸ Place in Cell): the picture is the cell's value,
 * `{ image, fit, alt }`, so it moves, sorts, filters, copies and undoes with the cell, a formula
 * referring to the cell shows it, and the file keeps it as a rich value (see xlsx-rich-values.js).
 * A floating picture and a cell picture convert into each other (Place in Cell / Place over Cells).
 */
import { normalizeRange } from './cell.js';

export const CELL_PICTURE_ALT_MAX = 2000;
/** A floating picture made from a cell picture is no larger than this at first, as an inserted one is. */
export const PLACED_MAX = { w: 480, h: 320 };

/** Is this value a picture shown in its cell (placed there, or the result of IMAGE)? */
export const isCellPicture = (value) => !!value && typeof value === 'object' && typeof value.image === 'string' && !!value.image;

/** The value a cell holds for a picture placed in it. */
export function cellPicture(src, { alt = '', fit = 'contain' } = {}) {
  const text = typeof alt === 'string' ? alt.trim().slice(0, CELL_PICTURE_ALT_MAX) : '';
  return { image: src, fit: ['contain', 'stretch', 'original'].includes(fit) ? fit : 'contain', ...(text ? { alt: text } : {}) };
}

/** What a screen reader and a tooltip say for a cell picture. */
export function cellPictureLabel(value) {
  if (!isCellPicture(value)) return '';
  return value.alt ? `Picture: ${value.alt}` : 'Picture';
}

/**
 * Where a picture sits in its cell, as SVG's preserveAspectRatio names it: kept whole and in
 * proportion, against the side the cell's alignment names. A cell with no alignment of its own
 * centres its picture across and stands it on the cell's foot, as the sheet draws text.
 */
export function cellPictureAspect(style, fit = 'contain') {
  if (fit === 'stretch') return 'none';
  const x = { left: 'xMin', right: 'xMax' }[style?.align] || 'xMid';
  const y = { top: 'YMin', middle: 'YMid', center: 'YMid' }[style?.valign] || (style?.valign === 'bottom' ? 'YMax' : 'YMid');
  return `${x}${y} meet`;
}

/** The same placement as CSS object-position, for the grid's own <img>. */
export function cellPictureObjectPosition(style) {
  const x = { left: 'left', right: 'right' }[style?.align] || 'center';
  const y = { top: 'top', bottom: 'bottom' }[style?.valign] || 'center';
  return `${x} ${y}`;
}

/**
 * The rectangle (in the cell's own pixels) a picture of `natural` size fills in a cell of `box`
 * size: scaled down or up to fit whole, keeping its proportions, against the aligned sides.
 */
export function fitCellPicture(natural, box, style = null, fit = 'contain') {
  const bw = Math.max(0, box.w), bh = Math.max(0, box.h);
  if (fit === 'stretch' || !(natural?.w > 0) || !(natural?.h > 0)) return { x: 0, y: 0, w: bw, h: bh };
  const scale = fit === 'original' ? 1 : Math.min(bw / natural.w, bh / natural.h);
  const w = natural.w * scale, h = natural.h * scale;
  const x = style?.align === 'left' ? 0 : style?.align === 'right' ? bw - w : (bw - w) / 2;
  const y = style?.valign === 'top' ? 0 : style?.valign === 'bottom' ? bh - h : (bh - h) / 2;
  return { x, y, w, h };
}

/** The first size a floating picture takes: its own, scaled down to PLACED_MAX in proportion. */
export function placedSize(natural) {
  const w = natural?.w > 0 ? natural.w : 240, h = natural?.h > 0 ? natural.h : 160;
  const scale = Math.min(1, PLACED_MAX.w / w, PLACED_MAX.h / h);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** The cell picture a floating picture becomes: its source drawn as shown, and its alt text. */
export function cellPictureFromObject(obj, src = obj?.src) {
  if (!obj || obj.type !== 'image' || typeof src !== 'string') return null;
  const alt = obj.decorative ? '' : obj.description || '';
  return cellPicture(src, { alt });
}

/** The floating picture a cell picture becomes, over the cell it came from. */
export function objectFromCellPicture(value, at, natural) {
  if (!isCellPicture(value) || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(value.image)) return null;
  const size = placedSize(natural);
  return {
    type: 'image', src: value.image, title: value.alt ? value.alt.slice(0, 200) : 'Picture',
    ...(value.alt ? { description: value.alt } : {}),
    anchor: { r: at.r, c: at.c }, dx: 0, dy: 0, w: size.w, h: size.h,
  };
}

/**
 * The cells several pictures go into, one after another from `at` down the column, as Place in Cell
 * puts a set of pictures: each its own cell, the first in the active cell.
 */
export function placementCells(at, count, rows) {
  const out = [];
  for (let i = 0; i < count && at.r + i < rows; i++) out.push({ r: at.r + i, c: at.c });
  return out;
}

/** The cells of `range` holding a picture of their own (not an IMAGE formula's result). */
export function placedPicturesIn(wb, sheetId, range) {
  const sheet = wb.sheet(sheetId), out = [];
  if (!sheet) return out;
  const n = normalizeRange(range);
  for (const [key, cell] of sheet.cells) {
    if (cell?.f != null || !isCellPicture(cell?.v)) continue;
    const [r, c] = key.split(',').map(Number);
    if (r >= n.r1 && r <= n.r2 && c >= n.c1 && c <= n.c2) out.push({ r, c, value: cell.v });
  }
  return out.sort((a, b) => a.r - b.r || a.c - b.c);
}

/** Set (or with '' clear) a cell picture's alt text, as one undoable edit; false when the cell holds no picture of its own. */
export function setCellPictureAlt(wb, sheetId, r, c, alt) {
  const cell = wb.getCell(sheetId, r, c);
  if (!cell || cell.f != null || !isCellPicture(cell.v)) return false;
  const next = cellPicture(cell.v.image, { alt, fit: cell.v.fit });
  if (JSON.stringify(next) === JSON.stringify(cell.v)) return true;
  if (wb.lockedIn(sheetId, { r1: r, c1: c, r2: r, c2: c })) return false;
  wb.setCells(sheetId, [{ r, c, cell: { ...cell, v: next } }], 'Edit alt text');
  return true;
}
