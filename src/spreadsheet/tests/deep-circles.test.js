import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A formula filled down a column that reads its own whole column (=SUM(B:B) in B2:B1000, a common slip)
// puts every cell on a circle with all the others: one circle deeper than the call stack.
function column(rows, formula) {
  const cells = { '0,0': { v: 1 }, '0,1': { v: 1 } };
  for (let r = 1; r < rows; r++) {
    cells[`${r},0`] = { v: r };
    cells[`${r},1`] = { f: formula(r + 1) };
  }
  const wb = new Workbook({ sheets: [{ name: 'Sheet1', rows: rows + 5, cols: 4, cells }] });
  return { wb, id: wb.activeSheetId };
}

it.each([
  ['SUM(B:B)', () => 'SUM(B:B)'],
  ['COUNTA(B:B)+A2', (r) => `COUNTA(B:B)+A${r}`],
  ['INDEX(B:B,ROW()-1)+A2', (r) => `INDEX(B:B,ROW()-1)+A${r}`],
  ['IFERROR(VLOOKUP(A1,A:B,2,0),0)+1', (r) => `IFERROR(VLOOKUP(A${r - 1},A:B,2,0),0)+1`],
])('a column of %s a thousand rows long settles as a cycle in moments', (_, formula) => {
  const rows = 1000;
  const { wb, id } = column(rows, formula);
  const start = performance.now();
  // Read from the bottom, as a formula below the block or the last row on screen reads it, then every cell.
  expect(wb.getValue(id, rows - 1, 1)).toEqual({ error: '#CYCLE!' });
  for (let r = 1; r < rows; r++) expect(wb.getValue(id, r, 1)).toEqual({ error: '#CYCLE!' });
  // A few hundred rows took seconds to minutes, and a thousand ran the tab out of memory.
  expect(performance.now() - start).toBeLessThan(15000);
  expect(wb.getValue(id, 0, 1)).toBe(1);
  // Nothing is left marked as being calculated: a formula entered next calculates as usual.
  wb.setInput(id, 0, 3, '=A2+A3');
  expect(wb.getValue(id, 0, 3)).toBe(3);
}, 30000);

it('breaking the circle gives every cell its value again', () => {
  const rows = 1000;
  const { wb, id } = column(rows, (r) => `SUM(B$1:B${r - 1})`);
  wb.setInput(id, rows - 1, 1, '=SUM(B:B)');
  expect(wb.getValue(id, rows - 1, 1)).toEqual({ error: '#CYCLE!' });
  wb.setInput(id, rows - 1, 1, `=SUM(B1:B${rows - 1})`);
  expect(wb.getValue(id, rows - 1, 1)).toBe(2 ** (rows - 2));
  expect(wb.getValue(id, 10, 1)).toBe(2 ** 9);
}, 30000);
