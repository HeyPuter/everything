import { paintParagraphBorder } from './canvas-paragraph-borders.js';
import { tableBorderColor } from './colors.js';

/** Diagonal cell borders (tl2br, tr2bl), drawn corner to corner inside each laid-out cell. */
export function paintCellDiagonals(ctx, cells) {
  for (const cell of cells) for (const side of ['tl2br', 'tr2bl']) {
    const border = cell.borders?.[side];
    if (!border || ['nil', 'none'].includes(border.style) || !border.size) continue;
    const { x, y, width, height } = cell;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
    ctx.strokeStyle = tableBorderColor(border.color); ctx.lineWidth = Math.max(0.5, border.size / 6);
    if (border.style === 'dotted') ctx.setLineDash([ctx.lineWidth, ctx.lineWidth * 2]);
    else if (/dash/i.test(border.style)) ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 2]);
    ctx.beginPath();
    if (side === 'tl2br') { ctx.moveTo(x, y); ctx.lineTo(x + width, y + height); } else { ctx.moveTo(x + width, y); ctx.lineTo(x, y + height); }
    ctx.stroke(); ctx.restore();
  }
}

export function paintTableBorder(ctx, stroke) {
  if (!stroke.guide) {
    paintParagraphBorder(ctx, stroke, stroke.crossingCuts?.map(cut => ({...cut, x: cut.x + stroke.x, y: cut.y + stroke.y})), tableBorderColor(stroke.border.color));
    return;
  }
  const { x, y, width, height, horizontal } = stroke;
  ctx.save(); ctx.strokeStyle = '#d5d8dc'; ctx.lineWidth = .5; ctx.setLineDash([2, 3]);
  if (stroke.cellClip) {
    ctx.beginPath(); ctx.rect(Math.max(x - 1, stroke.cellClip.left ?? -Infinity), stroke.cellClip.top, Math.max(0, Math.min(x + width + 1, stroke.cellClip.right ?? Infinity) - Math.max(x - 1, stroke.cellClip.left ?? -Infinity)), stroke.cellClip.bottom - stroke.cellClip.top); ctx.clip();
  }
  ctx.beginPath();
  ctx.moveTo(x + (horizontal ? 0 : width / 2), y + (horizontal ? height / 2 : 0));
  ctx.lineTo(x + (horizontal ? width : width / 2), y + (horizontal ? height / 2 : height));
  ctx.stroke(); ctx.restore();
}
