import { expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { previewPivot } from '../src/core/pivot.js';

it('reads each cell of the row and column fields once to find a pivot\'s categories', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const rows = 2000;
  wb.setCells(id, [...['Region', 'Product', 'Amount'].map((v, c) => ({ r: 0, c, cell: { v } })),
    ...Array.from({ length: rows }, (_, i) => [{ r: i + 1, c: 0, cell: { v: `R${i % 7}` } }, { r: i + 1, c: 1, cell: { v: i % 5 ? `P${i % 3}` : { error: '#N/A' } } }, { r: i + 1, c: 2, cell: { v: i } }]).flat()]);
  const read = vi.spyOn(wb, 'getValue');
  const preview = previewPivot(wb, id, { range: { r1: 0, c1: 0, r2: rows, c2: 2 }, rowField: 0, colField: 1, valueField: 2, agg: 'sum', filters: [] });
  // The column field's categories: three products and #N/A; no row is blank.
  expect(preview).toMatchObject({ rowCount: 7, colCount: 4 });
  // Values, error codes and blanks once came from three passes over each field.
  expect(read.mock.calls.length).toBeLessThanOrEqual(2 * rows);
});
