import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// A descending sort left errors at the bottom above the blanks, as an ascending one does. Excel reverses the
// whole ascending order (numbers, text, logicals, errors) and keeps only the blanks last, so errors lead.
const book = (inputs) => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  inputs.forEach((v, r) => { if (v !== '') wb.setInput(id, r, 0, v); });
  return { wb, id, column: () => inputs.map((_, r) => wb.getValue(id, r, 0)) };
};
const inputs = ['5', 'apple', '=1/0', 'TRUE', '', '2', '=NA()', 'zebra', 'FALSE'];

it('sorts errors first in a descending sort, blanks still last', () => {
  const { wb, id, column } = book(inputs);
  wb.sortRangeBy(id, parseRange('A1:A9'), [{ col: 0, ascending: false }]);
  expect(column()).toEqual([{ error: '#DIV/0!' }, { error: '#N/A' }, true, false, 'zebra', 'apple', 5, 2, null]);
  wb.sortRangeBy(id, parseRange('A1:A9'), [{ col: 0, ascending: true }]);
  expect(column()).toEqual([2, 5, 'apple', 'zebra', false, true, { error: '#DIV/0!' }, { error: '#N/A' }, null]);
});

it('sorts columns left to right the same way', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  inputs.forEach((v, c) => { if (v !== '') wb.setInput(id, 0, c, v); });
  wb.sortColumnsBy(id, parseRange('A1:I1'), [{ row: 0, ascending: false }]);
  expect(inputs.map((_, c) => wb.getValue(id, 0, c))).toEqual([{ error: '#DIV/0!' }, { error: '#N/A' }, true, false, 'zebra', 'apple', 5, 2, null]);
});
