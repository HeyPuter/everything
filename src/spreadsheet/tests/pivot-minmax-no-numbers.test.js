import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { buildPivot } from '../src/core/pivot.js';

// A Max (or Min) pivot showed 0 for a category whose rows hold no number (a blank, "n/a"), and its total, read off
// the category cells, took that 0 for a value: temperatures of -2 and -8 had a maximum of 0, prices of 3 and 8 a
// minimum of 0. Such a category now shows nothing, as an empty intersection does, and the totals are the largest
// or smallest number there is, as Excel reads them off the source.
function pivot(rows, spec) {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Pivot' }] });
  const [data, out] = wb.sheets;
  wb.setCells(data.id, rows.flatMap((row, r) => row.map((v, c) => (v == null ? null : { r, c, cell: { v } }))).filter(Boolean), 'Data');
  const range = parseRange(`A1:${String.fromCharCode(64 + rows[0].length)}${rows.length}`);
  const built = buildPivot(wb, data.id, { range, colField: null, ...spec });
  wb.setCells(out.id, built.cells, 'Insert pivot table');
  return Array.from({ length: built.rows }, (_, r) => Array.from({ length: built.cols }, (_, c) => wb.getValue(out.id, r, c)));
}

it('leaves a category without numbers out of a maximum and a minimum', () => {
  const temps = [['Region', 'Temp'], ['North', -5], ['North', -2], ['South', -8], ['West', null], ['West', 'n/a']];
  expect(pivot(temps, { rowField: 0, valueField: 1, agg: 'max' })).toEqual([['Region', 'Max of Temp'], ['North', -2], ['South', -8], ['West', ''], ['Total', -2]]);
  const prices = [['Region', 'Price'], ['North', 5], ['North', 3], ['South', 8], ['West', 'tbd']];
  expect(pivot(prices, { rowField: 0, valueField: 1, agg: 'min' })).toEqual([['Region', 'Min of Price'], ['North', 3], ['South', 8], ['West', ''], ['Total', 3]]);
});

it('keeps a crossed pivot\'s row and column totals to the numbers', () => {
  const rows = [['Region', 'Q', 'Price'], ['North', 'Q1', 5], ['North', 'Q2', 'tbd']];
  expect(pivot(rows, { rowField: 0, colField: 1, valueField: 2, agg: 'min' })).toEqual([
    ['Region', 'Q1', 'Q2', 'Total'],
    ['North', 5, '', 5],
    ['Total', 5, '', 5],
  ]);
});
