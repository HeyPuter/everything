import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// VSTACK and HSTACK refused anything past 100,000 cells with #NUM!, the cap SEQUENCE has for the
// cells it makes up, so appending two 60,000-row lists (or a 40,000-row, three-column table to
// itself) failed although SORT, FILTER and TOCOL take the same cells. Stacking only rearranges
// cells that exist; it is now held to a formula's array budget, checked before anything is built.
it('stacks lists of more than 100,000 cells', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const other = wb.addSheet('More').id;
  const rows = [];
  for (let r = 0; r < 60000; r++) rows.push({ r, c: 0, cell: { v: r } }, { r, c: 1, cell: { v: `k${r}` } });
  wb.setCells(id, rows);
  wb.setCells(other, rows);
  wb.setInput(id, 0, 4, '=VSTACK(A1:B60000,More!A1:B60000)');
  expect(wb.getValue(id, 0, 4)).toBe(0);
  expect(wb.getValue(id, 119999, 5)).toBe('k59999');
  wb.setInput(id, 0, 7, '=ROWS(HSTACK(A1:A60000,B1:B60000,A1:A60000))');
  expect(wb.getValue(id, 0, 7)).toBe(60000);
});

it('still refuses a stack padded out past the budget', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  wb.setInput(id, 0, 2, '=ROWS(VSTACK(A1:XFD1,A1:A300))'); // 16,384 columns × 301 rows
  expect(wb.getValue(id, 0, 2)).toEqual({ error: '#NUM!' });
});
