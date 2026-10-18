import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef } from '../src/core/cell.js';

const SALES = {
  A1: 'Region', B1: 'Product', C1: 'Amount',
  A2: 'East', B2: 'Pen', C2: '10',
  A3: 'West', B3: 'Ink', C3: '5',
  A4: 'East', B4: 'Ink', C4: '20',
  A5: 'West', B5: 'Pen', C5: '7',
};

function arr(formula, cells = SALES) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
  wb.setInput(id, 0, 9, `=${formula}`);
  const range = wb.spillRangeAt(id, 0, 9) || { r1: 0, c1: 9, r2: 0, c2: 9 };
  return wb.rangeValues(id, range);
}

// field_headers left out is automatic: values whose first entry is text above a number have a header
// row, which is not grouped as data; the headers are shown when there is more than one row field.
it('takes a text-over-number first value as a header row', () => {
  expect(arr('GROUPBY(A1:A5,C1:C5,SUM)')).toEqual([['East', 30], ['West', 12], ['Total', 42]]);
  expect(arr('GROUPBY(A1:A5,C1:C5,SUM,,0)')).toEqual([['East', 30], ['West', 12]]);
  expect(arr('PIVOTBY(A1:A5,B1:B5,C1:C5,SUM)')).toEqual([
    ['', 'Ink', 'Pen', 'Total'],
    ['East', 20, 10, 30],
    ['West', 5, 7, 12],
    ['Total', 25, 17, 42],
  ]);
});

it('shows the detected headers for more than one row field', () => {
  expect(arr('GROUPBY(A1:B5,C1:C5,SUM,,0)')).toEqual([
    ['Region', 'Product', 'Amount'],
    ['East', 'Ink', 20], ['East', 'Pen', 10], ['West', 'Ink', 5], ['West', 'Pen', 7],
  ]);
});

it('reads data without a header row, and an explicit field_headers, as before', () => {
  expect(arr('GROUPBY(A2:A5,C2:C5,SUM)')).toEqual([['East', 30], ['West', 12], ['Total', 42]]);
  expect(arr('GROUPBY(A1:A5,C1:C5,COUNTA,0,0)')).toEqual([['East', 2], ['Region', 1], ['West', 2]]);
  expect(arr('GROUPBY(A1:A5,C1:C5,SUM,3,0)')).toEqual([['Region', 'Amount'], ['East', 30], ['West', 12]]);
});
