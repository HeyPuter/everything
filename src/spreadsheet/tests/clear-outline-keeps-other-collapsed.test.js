import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { clearOutline } from '../src/core/auto-outline.js';

// Clear Outline over one block took the groups there away, but also brought back the rows of every collapsed group
// elsewhere on the sheet, which went on reading as collapsed: their + button showed rows already on show, and
// pressing it did nothing. Only the lines of the groups that go come back now.
function sheet() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 20; r++) wb.setInput(id, r, 0, String(r));
  wb.groupLines(id, 'row', 1, 3);
  wb.groupLines(id, 'row', 10, 12);
  wb.groupLines(id, 'col', 2, 3);
  wb.toggleGroup(id, 'row', 1, 3);
  wb.toggleGroup(id, 'col', 2, 3);
  return { wb, id };
}

it('leaves the rows of a collapsed group outside the range hidden', () => {
  const { wb, id } = sheet();
  const before = JSON.stringify(wb.toJSON());
  expect(clearOutline(wb, id, { r1: 9, c1: 0, r2: 13, c2: 1 })).toBe(true);
  expect(wb.outlineGroups(id, 'row').map((g) => [g.from, g.to, g.collapsed])).toEqual([[1, 3, true]]);
  expect([...wb.sheet(id).hiddenRows].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  expect([...wb.sheet(id).hiddenCols].sort((a, b) => a - b)).toEqual([2, 3]);
  wb.undo();
  expect(JSON.stringify(wb.toJSON())).toBe(before);
});

it('still shows the lines of the collapsed groups it clears', () => {
  const { wb, id } = sheet();
  expect(clearOutline(wb, id, { r1: 0, c1: 0, r2: 5, c2: 5 })).toBe(true);
  expect(wb.outlineGroups(id, 'row').map((g) => [g.from, g.to])).toEqual([[10, 12]]);
  expect(wb.sheet(id).hiddenRows.size).toBe(0);
  expect(wb.sheet(id).hiddenCols.size).toBe(0);
});
