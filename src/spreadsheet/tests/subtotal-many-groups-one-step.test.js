import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addSubtotals, removeSubtotals } from '../src/core/subtotal.js';

// Subtotal outlined each category's rows with a group of its own, one outline step apiece, and each step copied the
// whole outline: the time grew with the square of the categories, so 10,000 of them took over twenty seconds to add
// and fifteen to remove (20,000 took well over a minute). The categories' groups now go in, and come off, at once.
function list(n) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const cells = [{ r: 0, c: 0, cell: { v: 'Cat' } }, { r: 0, c: 1, cell: { v: 'Val' } }];
  for (let i = 1; i <= n; i++) cells.push({ r: i, c: 0, cell: { v: `c${String(i).padStart(5, '0')}` } }, { r: i, c: 1, cell: { v: i } });
  wb.setCells(id, cells);
  wb.clearHistory();
  return { wb, id };
}

it('adds and removes subtotals over 10,000 categories in moments', () => {
  const n = 10000;
  const { wb, id } = list(n);
  let start = performance.now();
  const out = addSubtotals(wb, id, { r1: 0, c1: 0, r2: n, c2: 1 }, { groupCol: 0, code: 9, totalCols: [1] });
  expect(performance.now() - start).toBeLessThan(6000);
  expect(out.r2).toBe(2 * n + 1);
  const rows = wb.sheet(id).groups.rows;
  expect(rows).toHaveLength(n + 1);
  expect(rows[0]).toEqual({ from: 1, to: 2 * n, collapsed: false });
  expect(rows[1]).toEqual({ from: 1, to: 1, collapsed: false });
  expect(rows.at(-1)).toEqual({ from: 2 * n - 1, to: 2 * n - 1, collapsed: false });
  start = performance.now();
  expect(removeSubtotals(wb, id, out)).toBe(n + 1);
  expect(performance.now() - start).toBeLessThan(4000);
  expect(wb.sheet(id).groups.rows).toEqual([]);
});

it('outlines the categories as groupLines would, beside an outline already there, as one undo step with the rest', () => {
  const { wb, id } = list(6);
  // A group around the list (kept) and a collapsed one below it (left alone, its rows still hidden).
  wb.groupLines(id, 'row', 0, 6);
  wb.setCells(id, [{ r: 10, c: 0, cell: { v: 'x' } }, { r: 11, c: 0, cell: { v: 'y' } }]);
  wb.groupLines(id, 'row', 10, 11);
  wb.toggleGroup(id, 'row', 10, 11);
  const before = JSON.stringify(wb.toJSON());
  const top = wb.historyTop;
  const out = addSubtotals(wb, id, { r1: 0, c1: 0, r2: 6, c2: 1 }, { groupCol: 0, code: 9, totalCols: [1] });
  expect(wb.historySince(top)).toHaveLength(1);
  // The group around the list grew with the rows put in it; the grand total's group would cross it, and is left
  // out, as groupLines refuses it. Each category's group sits inside it.
  expect(wb.outlineGroups(id, 'row').map((g) => [g.from, g.to, g.level])).toEqual([
    [0, 11, 1], [1, 1, 2], [3, 3, 2], [5, 5, 2], [7, 7, 2], [9, 9, 2], [11, 11, 2], [17, 18, 1],
  ]);
  expect([...wb.sheet(id).hiddenRows].sort((a, b) => a - b)).toEqual([17, 18]);
  // Removed again: every group inside the list goes with them; the one below stays, still collapsed.
  removeSubtotals(wb, id, out);
  expect(wb.outlineGroups(id, 'row').map((g) => [g.from, g.to, g.collapsed])).toEqual([[10, 11, true]]);
  expect([...wb.sheet(id).hiddenRows].sort((a, b) => a - b)).toEqual([10, 11]);
  wb.undo();
  wb.undo();
  expect(JSON.stringify(wb.toJSON())).toBe(before);
});

it('shows the rows of a collapsed category again when its subtotals are removed', () => {
  const { wb, id } = list(4);
  const out = addSubtotals(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { groupCol: 0, code: 9, totalCols: [1] });
  wb.toggleGroup(id, 'row', 3, 3);
  expect(wb.sheet(id).hiddenRows.has(3)).toBe(true);
  removeSubtotals(wb, id, out);
  expect(wb.sheet(id).hiddenRows.size).toBe(0);
});
