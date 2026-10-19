import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// =SUM($A$1:A1) filled down 20,000 rows adds up 200 million numbers. Read from the top each range carried on
// from the one above, but every SUM added its whole range again; read from the bottom up (a chart, the grid
// scrolled to the end) no range was found in the one read before it, and every cell was read again: 17 seconds.
function totals(rows) {
  const wb = new Workbook(), id = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < rows; r++) entries.push({ r, c: 0, cell: { v: (r % 7) / 4 } }, { r, c: 1, cell: { f: `SUM($A$1:A${r + 1})` } });
  wb.setCells(id, entries);
  let expected = 0;
  const sums = [];
  for (let r = 0; r < rows; r++) sums.push(expected += (r % 7) / 4);
  return { wb, id, sums };
}

it.each(['top down', 'bottom up'])('a running total down 20,000 rows read %s calculates in moments', (order) => {
  const rows = 20000;
  const { wb, id, sums } = totals(rows);
  // Timed on its own: checking the answers is not the calculation. Top down took about a second and a half before,
  // bottom up seventeen seconds; both now well under one.
  const read = () => {
    const at = order === 'top down' ? [...Array(rows).keys()] : [...Array(rows).keys()].reverse();
    const got = new Array(rows);
    const start = performance.now();
    for (const r of at) got[r] = wb.getValue(id, r, 1);
    const took = performance.now() - start;
    expect(got).toEqual(sums);
    return took;
  };
  expect(read()).toBeLessThan(8000);
  wb.insertRows(id, 0, 1); // every formula moves down a row: everything is calculated again
  wb.deleteRows(id, 0, 1);
  expect(read()).toBeLessThan(8000);
}, 120000);

it('an error, text or a boolean in the column reads as SUM reads it', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [
    { r: 0, c: 0, cell: { v: 1 } }, { r: 1, c: 0, cell: { v: 'x' } }, { r: 2, c: 0, cell: { v: true } }, { r: 3, c: 0, cell: { v: 2 } },
    { r: 4, c: 0, cell: { f: '1/0' } }, { r: 5, c: 0, cell: { v: 3 } },
  ]);
  for (let r = 0; r < 6; r++) wb.setInput(id, r, 1, `=SUM($A$1:A${r + 1})`);
  const column = () => [5, 4, 3, 2, 1, 0].map((r) => wb.getValue(id, r, 1)).reverse();
  expect(column()).toEqual([1, 1, 1, 3, { error: '#DIV/0!' }, { error: '#DIV/0!' }]);
  wb.setInput(id, 4, 0, '4');
  expect(column()).toEqual([1, 1, 1, 3, 7, 10]);
  expect(wb.getValue(id, 5, 1)).toBe(10);
});
