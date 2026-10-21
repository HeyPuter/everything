import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Rows grouped twice over (two outline levels over the same lines, as Excel writes them) lost a level whenever rows
// were moved anywhere on the sheet: the move folds two nested groups it makes the same into one, and took two groups
// that were already the same for such a pair.
const book = () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 12; r++) wb.setInput(id, r, 0, String(r));
  wb.groupLines(id, 'row', 2, 5);
  wb.groupLines(id, 'row', 2, 5);
  wb.groupLines(id, 'row', 3, 4);
  return { wb, id, levels: () => wb.outlineGroups(id, 'row').map((g) => [g.from, g.to, g.level]) };
};

it('keeps both levels of rows grouped twice when other rows move past them', () => {
  const { wb, id, levels } = book();
  expect(wb.moveRows(id, 10, 1, 0)).toBe(0);
  expect(levels()).toEqual([[3, 6, 1], [3, 6, 2], [4, 5, 3]]);
  wb.undo();
  expect(levels()).toEqual([[2, 5, 1], [2, 5, 2], [3, 4, 3]]);
});

it('still folds two nested groups the move makes the same into one', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 12; r++) wb.setInput(id, r, 0, String(r));
  wb.groupLines(id, 'row', 2, 5);
  wb.groupLines(id, 'row', 3, 5);
  // Row 3 leaves the outer group, which then covers what the inner one does.
  wb.moveRows(id, 2, 1, 11);
  expect(wb.outlineGroups(id, 'row').map((g) => [g.from, g.to, g.level])).toEqual([[2, 4, 1]]);
});
