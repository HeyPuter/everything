import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Dragging rows or columns by their headers (Move rows/columns) through an outline group dropped the whole
// group, so taking one line out of a grouped section, or dropping one into it, lost the outline of every
// other line; and a print area the block partly covered spread over every line between where the block was
// and where it went. Both now lose the lines that leave them and gain those that land inside, as references do.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, Array.from({ length: 20 }, (_, r) => ({ r, c: 0, cell: { v: r + 1 } })));
  wb.setInput(id, 0, 3, '=SUM(A1:A10)');
  wb.groupLines(id, 'row', 4, 6);
  wb.groupLines(id, 'row', 4, 5);
  wb.groupLines(id, 'row', 12, 14);
  wb.setPrintSettings(id, { areas: [{ r1: 0, c1: 0, r2: 9, c2: 1 }] });
  return { wb, id };
}
const groups = (wb, id) => wb.outlineGroups(id, 'row').map(({ from, to }) => [from, to]);

it('takes a row out of a group, leaving the rest of the outline', () => {
  const { wb, id } = book();
  expect(wb.moveRows(id, 5, 1, 18)).toBe(17); // row 6, in both nested groups, below everything
  expect(groups(wb, id)).toEqual([[4, 5], [4, 4], [11, 13]]);
  wb.undo();
  expect(groups(wb, id)).toEqual([[4, 6], [4, 5], [12, 14]]);
});

it('grows a group a row lands inside', () => {
  const { wb, id } = book();
  expect(wb.moveRows(id, 16, 1, 13)).toBe(13); // row 17 dropped inside rows 13-15
  expect(groups(wb, id)).toEqual([[4, 6], [4, 5], [12, 15]]);
  expect(wb.getValue(id, 13, 0)).toBe(17);
});

it('moves a group carried whole, and does the same for columns', () => {
  const { wb, id } = book();
  expect(wb.moveRows(id, 3, 5, 18)).toBe(13);
  expect(groups(wb, id)).toEqual([[7, 9], [14, 16], [14, 15]]);
  wb.groupLines(id, 'col', 2, 4);
  expect(wb.moveCols(id, 3, 1, 8)).toBe(7);
  expect(wb.outlineGroups(id, 'col').map(({ from, to }) => [from, to])).toEqual([[2, 3]]);
});

it('keeps the print area on the lines it covered, as its formulas keep their range', () => {
  const { wb, id } = book();
  wb.moveRows(id, 5, 1, 15); // a row of the area to below it
  expect(wb.sheet(id).printSettings.areas).toEqual([{ r1: 0, c1: 0, r2: 8, c2: 1 }]);
  expect(wb.getCell(id, 0, 3).f).toBe('SUM(A1:A9)');
  wb.undo();
  wb.moveRows(id, 15, 1, 5); // a row from below it into it
  expect(wb.sheet(id).printSettings.areas).toEqual([{ r1: 0, c1: 0, r2: 10, c2: 1 }]);
  expect(wb.getCell(id, 0, 3).f).toBe('SUM(A1:A11)');
  wb.undo();
  expect(wb.sheet(id).printSettings.areas).toEqual([{ r1: 0, c1: 0, r2: 9, c2: 1 }]);
});
