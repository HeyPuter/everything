import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Ctrl+Enter over a selection spanning a filtered list wrote the entry into the rows the filter hid as well;
// it now fills the rows on show only, as Fill Down and a pasted value do. Rows hidden by hand still take it.
it('fills a Ctrl+Enter entry into the shown rows of a filtered list only', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Key'); wb.setInput(id, 0, 1, 'Val');
  for (let r = 1; r <= 6; r++) { wb.setInput(id, r, 0, r % 2 ? 'a' : 'b'); wb.setInput(id, r, 1, String(r)); }
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 6, c2: 1 });
  wb.setFilterCriteria(id, 0, { values: ['a'] });
  wb.fillInput(id, { r1: 1, c1: 1, r2: 6, c2: 1 }, '=A2&"!"', { r: 1, c: 1 });
  expect([1, 2, 3, 4, 5, 6].map(r => wb.getValue(id, r, 1))).toEqual(['a!', 2, 'a!', 4, 'a!', 6]);
  expect(wb.getCell(id, 5, 1).f).toBe('A6&"!"');
  wb.undo();
  wb.clearFilter(id);
  wb.setHidden(id, 'row', [2], true);
  wb.fillInput(id, { r1: 1, c1: 1, r2: 3, c2: 1 }, 'x', { r: 1, c: 1 });
  expect([1, 2, 3].map(r => wb.getValue(id, r, 1))).toEqual(['x', 'x', 'x']);
});
