import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPivot } from '../src/core/pivot.js';

// A pivot's values take the number format of the field they summarize, but only some of its parts: amounts
// formatted without thousands separators (1234.50) were summed as 1,244.50, the format's grouping dropped.
it('keeps the value field format whole, its grouping included', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Amount'], ['East', 1234.5], ['West', 2000], ['East', 10]].forEach((row, r) => row.forEach((v, c) => wb.setCells(id, [{ r, c, cell: { v } }])));
  wb.applyStyle(id, { r1: 1, c1: 1, r2: 3, c2: 1 }, { fmt: 'number', dec: 2, group: false });
  const built = buildPivot(wb, id, { range: { r1: 0, c1: 0, r2: 3, c2: 1 }, rowField: 0, colField: null, valueField: 1, agg: 'sum' });
  const out = wb.addSheet('Pivot').id;
  wb.setCells(out, built.cells);
  expect([1, 2, 3].map((r) => wb.getDisplay(out, r, 1))).toEqual(['1244.50', '2000.00', '3244.50']);
});
