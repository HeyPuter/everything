import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

// Three rows inserted above row 1,048,576 would be rows 1,048,576 to 1,048,578, two of them past the sheet's last
// row. The workbook made the insertion and said it had, and the assistant reported "rows 1048576–1048578". An
// insertion whose new lines do not all fit on the sheet is now refused, as one pushing content off it is.
it('refuses to insert rows or columns that would be numbered past the end of the sheet', () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, 'top');
  expect(wb.insertRows(id, 1048575, 3)).toBe(false);
  expect(wb.insertRows(id, 1048574, 3)).toBe(false);
  expect(wb.insertCols(id, 16383, 2)).toBe(false);
  expect(wb.sheet(id).rows).toBe(100);
  expect(wb.undoLabel()).not.toMatch(/Insert/);
  // What fits still goes in: one row above the last, three above the third from last, a column before XFD.
  expect(wb.insertRows(id, 1048575, 1)).toBe(true);
  expect(wb.insertRows(id, 1048573, 3)).toBe(true);
  expect(wb.insertCols(id, 16383, 1)).toBe(true);
  // One row above each of two rows: the second lands one further down, past the end when it is the last row.
  expect(wb.insertRowsAt(id, [1048573, 1048574])).toBe(true);
  expect(wb.insertRowsAt(id, [1048574, 1048575])).toBe(false);
  expect(wb.getValue(id, 0, 0)).toBe('top');
});

it('the assistant is told the rows do not fit rather than that they went in', () => {
  const wb = new Workbook();
  const env = { sheetId: () => wb.sheets[0].id };
  const result = runTool(wb, 'insert_rows', { before_row: 1048576, count: 3 }, env);
  expect(result.ok).toBe(false);
  expect(result.content).toMatch(/Could not insert rows 1048576–1048578/);
  expect(result.changed).toBe(false);
});
