import { checkedParagraphBorder, BORDER_STYLES } from './paragraph-borders.js';

export const CELL_BORDER_SIDES = Object.freeze(['top', 'left', 'bottom', 'right']);
// Diagonal strokes across a cell (§17.4.66 tl2br/tr2bl): ink only, no space or conflict resolution.
export const CELL_DIAGONALS = Object.freeze(['tl2br', 'tr2bl']);
export const CELL_BORDER_STYLES = Object.freeze({ nil: 'No border', ...Object.fromEntries(Object.entries(BORDER_STYLES).filter(([key]) => key !== 'none')), thick: 'Thick' });

export function checkedCellBorder(value) {
  if (!value || typeof value !== 'object') throw new Error('Choose a cell border.');
  const visible = !['nil', 'none'].includes(value.style);
  const border = checkedParagraphBorder({ ...value, style: value.style === 'thick' ? 'single' : value.style });
  if (visible && border.space) throw new Error('Cell border spacing offsets are not supported yet.');
  return { ...border, style: value.style };
}
export function checkedCellBorders(patch) {
  if (patch === null) return Object.fromEntries(CELL_BORDER_SIDES.map(side => [side, null]));
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(side => !CELL_BORDER_SIDES.includes(side) && !CELL_DIAGONALS.includes(side))) throw new Error('Choose top, left, bottom, right or diagonal cell borders.');
  return Object.fromEntries(Object.entries(patch).map(([side, value]) => [side, value === null ? null : checkedCellBorder(value)]));
}

// The default `none` clears the cell/style side and exposes the table side.
// Nondefault none suppresses ink but can reserve space. Keep it distinct from
// nil; the existing border dialog presents both as "No border".
export function resolveCellBorders(inherited = {}, direct = {}) {
  const result = { ...inherited };
  for (const [side,border] of Object.entries(direct)) {
    if (border.style !== 'none') result[side] = border;
    else if (!border.size && !border.space && (border.color ?? 'auto') === 'auto' && !border.frame && !border.shadow) delete result[side];
    else result[side] = border;
  }
  return result;
}

export function cellWritingTopBorder(cell, painted) {
  const direct = cell.directBorders?.top;
  if (direct) return direct.style === 'none' ? cell.borders?.top ?? painted : direct;
  return Object.hasOwn(cell, 'styleWritingTopBorder') ? cell.styleWritingTopBorder : painted;
}

export function effectiveCellBorders(table, cell, rowIndex, column, span, rowSpan) {
  return Object.fromEntries(CELL_BORDER_SIDES.map(side => {
    const edge = { top: rowIndex === 0 ? 'top' : 'insideH', bottom: rowIndex + rowSpan === table.rows.length ? 'bottom' : 'insideH', left: column === 0 ? 'left' : 'insideV', right: column + span === table.grid.length ? 'right' : 'insideV' }[side];
    return [side, cell.borders?.[side] ?? rowTableBorder(table, side === 'bottom' ? rowIndex + rowSpan - 1 : rowIndex, edge)];
  }));
}

// Table-level row exceptions sit below cell declarations and above the table.
// Unlike a cell's `none`, a table-level `none` removes that inherited stroke.
export function rowTableBorder(table, rowIndex, side) {
  return table.rows[rowIndex]?.borderExceptions?.[side] ?? table.borders[side];
}
