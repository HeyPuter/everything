import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { advancedFilter } from '../src/core/advanced-filter.js';

// An advanced filter copying its records under a one-row destination clears what an earlier run left below
// them, but looked no further than 2,000 rows past the new records: running it again with fewer matches than a
// long earlier result left the rest of that result under the new one, as if those records matched too.
it('clears all of a longer earlier result when the filter is copied again', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const cells = [{ r: 0, c: 0, cell: { v: 'Kind' } }, { r: 0, c: 3, cell: { v: 'Kind' } }, { r: 1, c: 3, cell: { v: 'x' } }];
  for (let r = 1; r <= 3000; r++) cells.push({ r, c: 0, cell: { v: r <= 2900 ? 'x' : 'y' } });
  wb.setCells(id, cells);
  const run = () => advancedFilter(wb, id, { list: parseRange('A1:A3001'), criteria: { range: parseRange('D1:D2') }, copyTo: { range: parseRange('F1:F1') } });
  expect(run()).toEqual({ copied: 2900, columns: 1 });
  wb.setInput(id, 1, 3, 'y');
  expect(run()).toEqual({ copied: 100, columns: 1 });
  expect(wb.getValue(id, 100, 5)).toBe('y');
  expect(wb.getValue(id, 101, 5)).toBeNull();
  expect(wb.getValue(id, 2900, 5)).toBeNull();
  // Data past a blank row under the old result is no part of it, and stays.
  wb.setInput(id, 3500, 5, 'mine');
  expect(run()).toEqual({ copied: 100, columns: 1 });
  expect(wb.getValue(id, 3500, 5)).toBe('mine');
});
