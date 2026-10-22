import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Remove Duplicates kept every fully blank row of the range, where Excel takes blank rows for
// duplicates of one another like any other rows that read the same: the first stays, the rest go.
// Blank rows that go below every kept row, holding nothing, change nothing and are not counted.
it('keeps one blank row and removes the others', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  // x, blank, x, x, blank, y, a row of formulas showing nothing, y
  wb.setCells(id, [[0, 'x'], [2, 'x'], [3, 'x'], [5, 'y'], [7, 'y']].map(([r, v]) => ({ r, c: 0, cell: { v } })));
  wb.setInput(id, 6, 0, '=""');
  wb.setInput(id, 6, 1, '=""');
  wb.setInput(id, 0, 1, '1'); wb.setInput(id, 2, 1, '1'); wb.setInput(id, 3, 1, '1'); wb.setInput(id, 5, 1, '2'); wb.setInput(id, 7, 1, '2');
  expect(wb.removeDuplicates(id, { r1: 0, c1: 0, r2: 7, c2: 1 })).toBe(5);
  expect(Array.from({ length: 8 }, (_, r) => wb.getDisplay(id, r, 0))).toEqual(['x', '', 'y', '', '', '', '', '']);
  expect(wb.getCell(id, 1, 0)).toBeUndefined();
  expect(wb.getValue(id, 2, 1)).toBe(2);
  // Run again, the rows freed at the bottom hold nothing and nothing moves: no duplicates are reported.
  const steps = wb.undoLabels().length;
  expect(wb.removeDuplicates(id, { r1: 0, c1: 0, r2: 7, c2: 1 })).toBe(0);
  expect(wb.undoLabels().length).toBe(steps);
});
