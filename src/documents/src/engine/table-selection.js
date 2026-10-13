// Rectangular table-cell selections. A text range runs through cells in
// reading order; selecting a column, or dragging from one cell to another,
// needs a block of grid rows and columns instead. Blocks are transient
// selection state: they never enter the document or its undo history.
import { rowGrid, verticalMerges } from './tables.js';

/** Every owner cell placement: { cell, rowIndex, endRow, column, end }. */
export function ownerPlacements(table) {
  const owners = verticalMerges(table), placements = [];
  table.rows.forEach((row, rowIndex) => {
    for (const { cell, column, end } of rowGrid(row)) {
      const owner = owners.get(cell.id);
      if (owner.cell === cell) placements.push({ cell, rowIndex, endRow: owner.endRow, column, end });
    }
  });
  return placements;
}

const overlaps = (p, b) => p.rowIndex <= b.bottom && p.endRow >= b.top && p.column < b.right && p.end > b.left;

/** Grow a block until it covers every merged cell it touches. */
export function normalizeCellBlock(table, block) {
  const placements = ownerPlacements(table);
  let next = { ...block, top: Math.max(0, block.top), bottom: Math.min(table.rows.length - 1, block.bottom), left: Math.max(0, block.left), right: Math.min(table.grid.length, block.right) };
  if (next.top > next.bottom || next.left >= next.right) return null;
  for (let changed = true; changed;) {
    changed = false;
    for (const p of placements) if (overlaps(p, next)) {
      const grown = { ...next, top: Math.min(next.top, p.rowIndex), bottom: Math.max(next.bottom, p.endRow), left: Math.min(next.left, p.column), right: Math.max(next.right, p.end) };
      if (grown.top !== next.top || grown.bottom !== next.bottom || grown.left !== next.left || grown.right !== next.right) { next = grown; changed = true; }
    }
  }
  return next;
}

/** The owner cells inside a block, in reading order. */
export function cellBlockPlacements(table, block) {
  return ownerPlacements(table).filter(p => overlaps(p, block));
}

export function placementOf(table, cellId) {
  return ownerPlacements(table).find(p => p.cell.id === cellId) || null;
}

/** The smallest block holding two cells of one table. */
export function blockBetween(table, fromId, toId) {
  const a = placementOf(table, fromId), b = placementOf(table, toId);
  if (!a || !b) return null;
  return normalizeCellBlock(table, { tableId: table.id, top: Math.min(a.rowIndex, b.rowIndex), bottom: Math.max(a.endRow, b.endRow), left: Math.min(a.column, b.column), right: Math.max(a.end, b.end) });
}

/** A block for Select Cell / Row / Column / Table around a cell, or around an existing block. */
export function blockFor(table, around, kind) {
  const all = { tableId: table.id, top: 0, bottom: table.rows.length - 1, left: 0, right: table.grid.length };
  if (kind === 'table') return all;
  if (kind === 'row') return normalizeCellBlock(table, { ...all, top: around.top, bottom: around.bottom });
  if (kind === 'column') return normalizeCellBlock(table, { ...all, left: around.left, right: around.right });
  return normalizeCellBlock(table, { tableId: table.id, top: around.top, bottom: around.bottom, left: around.left, right: around.right });
}

export const blockRows = block => Array.from({ length: block.bottom - block.top + 1 }, (_, i) => block.top + i);
export const wholeRows = (table, block) => block.left === 0 && block.right === table.grid.length;
export const wholeColumns = (table, block) => block.top === 0 && block.bottom === table.rows.length - 1;
export const sameBlock = (a, b) => !!a && !!b && a.tableId === b.tableId && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;

/** Page rectangles of a model's active block, for painting it as a selection. */
export function cellBlockRects(layout, model) {
  const block = model.activeCellBlock;
  if (!block) return [];
  const ids = new Set(cellBlockPlacements(block.table, block).map(p => p.cell.id));
  return (layout.cells || []).filter(cell => ids.has(cell.id)).map(cell => ({ page: cell.page, x: cell.x, y: cell.y, width: cell.width, height: cell.height }));
}
