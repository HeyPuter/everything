import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// PIVOTBY laid out every cell of its pivot before the array budget refused it: a column field of 20,000
// distinct values (an ID or a timestamp picked by mistake) beside 5,000 row groups set aside 100 million
// cells, over a gigabyte and two seconds on every calculation, to answer #NUM! in the end. A browser tab
// runs out of memory long before. The size is now judged from the groups before anything is built.
function book(rows) {
  const wb = new Workbook(), id = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < rows; r++) entries.push({ r, c: 0, cell: { v: `k${r % 5000}` } }, { r, c: 1, cell: { v: r } }, { r, c: 2, cell: { v: `id${r}` } });
  wb.setCells(id, entries);
  return { wb, id };
}

it('refuses a pivot larger than a formula may build at once', () => {
  const { wb, id } = book(20000);
  wb.setInput(id, 0, 5, '=PIVOTBY(A1:A20000,C1:C20000,B1:B20000,SUM)');
  const start = performance.now();
  expect(wb.getValue(id, 0, 5)).toEqual({ error: '#NUM!' });
  expect(performance.now() - start).toBeLessThan(1000);
});

it('still builds a large pivot within the budget', () => {
  const { wb, id } = book(20000);
  wb.setInput(id, 0, 5, '=ROWS(PIVOTBY(A1:A20000,MOD(B1:B20000,300),B1:B20000,SUM))');
  wb.setInput(id, 1, 5, '=COLUMNS(PIVOTBY(A1:A20000,MOD(B1:B20000,300),B1:B20000,SUM,,0,,0))');
  expect(wb.getValue(id, 0, 5)).toBe(5002); // a header, 5,000 groups and the total
  expect(wb.getValue(id, 1, 5)).toBe(301); // the key and 300 columns, without totals
});
