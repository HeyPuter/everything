import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Ungroup took every group inside the selection away, the groups nested in the one asked for included, so ungrouping
// a section of an outline flattened it. Excel's Ungroup takes one outline level off the selected lines: the outermost
// group goes and the groups nested in it stay, a level up, collapsed if they were.
const book = () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 14; r++) wb.setInput(id, r, 0, String(r));
  wb.groupLines(id, 'row', 1, 10);
  wb.groupLines(id, 'row', 2, 4);
  wb.groupLines(id, 'row', 6, 8);
  wb.groupLines(id, 'row', 7, 7);
  wb.toggleGroup(id, 'row', 2, 4);
  return { wb, id, levels: () => wb.outlineGroups(id, 'row').map((g) => [g.from, g.to, g.level]) };
};

it('takes one outline level off the selected lines', () => {
  const { wb, id, levels } = book();
  expect(wb.ungroupLines(id, 'row', 1, 10)).toBe(1);
  expect(levels()).toEqual([[2, 4, 1], [6, 8, 1], [7, 7, 2]]);
  expect([...wb.sheet(id).hiddenRows].sort((a, b) => a - b)).toEqual([2, 3, 4]); // still collapsed
  expect(wb.ungroupLines(id, 'row', 1, 10)).toBe(2);
  expect(levels()).toEqual([[7, 7, 1]]);
  expect(wb.sheet(id).hiddenRows.size).toBe(0);
  wb.undo();
  wb.undo();
  expect(levels()).toEqual([[1, 10, 1], [2, 4, 2], [6, 8, 2], [7, 7, 3]]);
});
