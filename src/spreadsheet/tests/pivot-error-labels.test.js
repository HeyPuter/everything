import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef, parseRange } from '../src/core/cell.js';
import { buildPivot, previewPivot, pivotFieldValues } from '../src/core/pivot.js';

// A pivot gave no category to the rows whose row or column field held an error, while the grand
// total summed every row, so the categories no longer added up to it. Each error code is now a
// category of its own, labelled with the code itself, after the values and before (blank).
function source(rows) {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => { if (v != null) wb.setInput(id, r, c, v); }));
  return { wb, id };
}

function place(wb, built) {
  const sheet = wb.addSheet('Pivot');
  wb.setCells(sheet.id, built.cells, 'pivot');
  return (a1) => { const { r, c } = parseCellRef(a1); return wb.getValue(sheet.id, r, c); };
}

it('gives rows whose label is an error their own row, so the rows add up to the total', () => {
  const { wb, id } = source([['Region', 'Amt'], ['W', '1'], ['E', '2'], ['=1/0', '4'], ['W', '8'], ['=NA()', '16']]);
  const spec = { range: parseRange('A1:B6'), rowField: 0, colField: null, valueField: 1, agg: 'sum' };
  const built = buildPivot(wb, id, spec);
  expect(built.rowCount).toBe(4);
  expect(previewPivot(wb, id, spec)).toMatchObject({ rowCount: 4, rows: 6 });
  const at = place(wb, built);
  expect(['A2', 'A3', 'A4', 'A5', 'A6'].map(at)).toEqual(['E', 'W', '#DIV/0!', '#N/A', 'Total']);
  expect(['B2', 'B3', 'B4', 'B5', 'B6'].map(at)).toEqual([2, 9, 4, 16, 31]);
  const count = place(wb, buildPivot(wb, id, { ...spec, agg: 'count' }));
  expect(['B2', 'B3', 'B4', 'B5', 'B6'].map(count)).toEqual([1, 2, 1, 1, 5]);
  // The filter dropdown keeps listing real values only.
  expect(pivotFieldValues(wb, id, parseRange('A1:B6'), 0)).toEqual(['E', 'W']);
});

it('adds an error column as well, orders errors before (blank), and keeps text spelled like a code apart', () => {
  const { wb, id } = source([['Region', 'Quarter', 'Amt'], ['E', 'Q1', '1'], ['=1/0', '=1/0', '2'], ['W', 'Q1', '4'], ['', '', '8'], ["'#DIV/0!", 'Q1', '16']]);
  const at = place(wb, buildPivot(wb, id, { range: parseRange('A1:C6'), rowField: 0, colField: 1, valueField: 2, agg: 'sum' }));
  expect(['B1', 'C1', 'D1', 'E1'].map(at)).toEqual(['Q1', '#DIV/0!', '(blank)', 'Total']);
  // The text "#DIV/0!" sorts among the values; the error row follows them.
  expect(['A2', 'A3', 'A4', 'A5', 'A6', 'A7'].map(at)).toEqual(['#DIV/0!', 'E', 'W', '#DIV/0!', '(blank)', 'Total']);
  expect(['B2', 'C2', 'D2', 'E2'].map(at)).toEqual([16, '', '', 16]);
  expect(['B5', 'C5', 'D5', 'E5'].map(at)).toEqual(['', 2, '', 2]);
  expect(['B7', 'C7', 'D7', 'E7'].map(at)).toEqual([21, 2, 8, 31]);
});

it('follows the source as a live formula', () => {
  const { wb, id } = source([['Region', 'Amt'], ['W', '1'], ['=1/0', '4']]);
  const at = place(wb, buildPivot(wb, id, { range: parseRange('A1:B3'), rowField: 0, colField: null, valueField: 1, agg: 'sum' }));
  expect([at('A3'), at('B3'), at('B4')]).toEqual(['#DIV/0!', 4, 5]);
  wb.setInput(id, 2, 1, '10');
  expect([at('B3'), at('B4')]).toEqual([10, 11]);
});
