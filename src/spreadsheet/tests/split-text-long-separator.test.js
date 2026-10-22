import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { parseDelimited } from '../src/core/tsv.js';

// Split Text ▸ Custom… takes a separator of any length, but the split compared one character at a
// time against it: " - " never matched, so "a-b - c" did not split and the toast said no text held it.
// A separator of several characters splits where the whole of it appears.
const row = (wb, id, r, n) => Array.from({ length: n }, (_, c) => wb.getValue(id, r, c));

it('splits on a separator longer than one character', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'a-b - c' } }, { r: 1, c: 0, cell: { v: '"x - y" - z - 4' } }]);
  expect(wb.splitTextToColumns(id, parseRange('A1:A2'), ' - ')).toEqual({ rows: 2, cols: 3 });
  expect(row(wb, id, 0, 3)).toEqual(['a-b', 'c', null]);
  // A quoted field keeps the separator inside it, as with a one-character separator.
  expect(row(wb, id, 1, 3)).toEqual(['x - y', 'z', 4]);
});

it('reads a several-character separator in delimited text', () => {
  expect(parseDelimited('a::b:c::\nd::e', '::')).toEqual([['a', 'b:c', ''], ['d', 'e']]);
  expect(parseDelimited('a,b', ',')).toEqual([['a', 'b']]);
});
