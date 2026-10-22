import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addSubtotals, hasSubtotals, removeSubtotals } from '../src/core/subtotal.js';

// A total row is labelled by its function, as Excel labels it: a row of averages read "East Total" and
// "Grand Total", passing for sums.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Sales'], ['East', 20], ['East', 5], ['West', 10], ['West', 30]]
    .forEach((row, r) => row.forEach((v, c) => wb.setCells(id, [{ r, c, cell: { v } }])));
  return { wb, id };
}
const labels = (wb, id, r2) => Array.from({ length: r2 + 1 }, (_, r) => wb.getValue(id, r, 0));

it.each([[1, 'Average'], [3, 'Count'], [4, 'Max'], [5, 'Min'], [9, 'Total']])('labels SUBTOTAL(%i) rows with %s', (code, word) => {
  const { wb, id } = book();
  const out = addSubtotals(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { groupCol: 0, code, totalCols: [1] });
  expect(labels(wb, id, out.r2)).toEqual(['Region', 'East', 'East', `East ${word}`, 'West', 'West', `West ${word}`, `Grand ${word}`]);
});

it('recognizes rows labelled by any function when replacing or removing subtotals', () => {
  const { wb, id } = book();
  const range = addSubtotals(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { groupCol: 0, code: 1, totalCols: [1] });
  expect(hasSubtotals(wb, id, range)).toBe(true);
  const again = addSubtotals(wb, id, range, { groupCol: 0, code: 4, totalCols: [1] });
  expect(again.r2).toBe(7);
  expect(labels(wb, id, 7)).toEqual(['Region', 'East', 'East', 'East Max', 'West', 'West', 'West Max', 'Grand Max']);
  expect(wb.getValue(id, 7, 1)).toBe(30);
  expect(removeSubtotals(wb, id, again)).toBe(3);
  expect(labels(wb, id, 4)).toEqual(['Region', 'East', 'East', 'West', 'West']);
});
