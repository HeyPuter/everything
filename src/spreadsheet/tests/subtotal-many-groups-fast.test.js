import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addSubtotals } from '../src/core/subtotal.js';

// Every outline step (a group added, collapsed, expanded or removed) copied and re-sorted the sheet's whole outline
// twice for its undo and once more for the change, group by group: Subtotal, which adds a group per category, took
// about four seconds over 5,000 categories. A step now keeps the outline's lists, whose groups are never changed in
// place, and a new group goes straight to its place in the sorted list.
it('adds subtotals over 5,000 categories in moments, its outline undoing and redoing exactly', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const n = 5000;
  const cells = [{ r: 0, c: 0, cell: { v: 'Cat' } }, { r: 0, c: 1, cell: { v: 'Val' } }];
  for (let i = 0; i < n * 2; i++) {
    cells.push({ r: i + 1, c: 0, cell: { v: `c${String(Math.floor(i / 2)).padStart(5, '0')}` } });
    cells.push({ r: i + 1, c: 1, cell: { v: i } });
  }
  wb.setCells(id, cells);
  wb.clearHistory();
  const start = performance.now();
  addSubtotals(wb, id, { r1: 0, c1: 0, r2: n * 2, c2: 1 }, { groupCol: 0, code: 9, totalCols: [1] });
  expect(performance.now() - start).toBeLessThan(2000);
  const groups = () => JSON.stringify(wb.sheet(id).groups.rows);
  expect(wb.sheet(id).groups.rows).toHaveLength(n + 1);
  const done = groups();
  wb.toggleGroup(id, 'row', 1, 2);
  wb.setAllGroups(id, 'row', true);
  wb.undo();
  wb.undo();
  expect(groups()).toBe(done);
  expect(wb.sheet(id).hiddenRows.size).toBe(0);
  wb.redo();
  expect(wb.outlineGroups(id, 'row').find((g) => g.from === 1 && g.to === 2).collapsed).toBe(true);
});
