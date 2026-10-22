import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookTable, initialSteps, evaluateQuery, loadResult } from '../src/core/queries.js';

// A query over a table read a column as dates only when its cells carried one of the named date formats: a
// column of dates in a custom format (dd/mm/yyyy, as files from Excel often have) came in untyped, was detected
// as whole numbers, and loaded back as serials such as 45296 instead of dates.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Day', 'Amount', 'Clock'], [45296, 10, 0.5], [45297, 20, 0.75]].forEach((row, r) => row.forEach((v, c) => wb.setCells(id, [{ r, c, cell: { v } }])));
  wb.applyStyle(id, { r1: 1, c1: 0, r2: 2, c2: 0 }, { fmt: 'custom', code: 'dd/mm/yyyy' });
  wb.applyStyle(id, { r1: 1, c1: 2, r2: 2, c2: 2 }, { fmt: 'custom', code: 'h:mm' });
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 2 }, { name: 'Sales' });
  return { wb, id };
}

it('types a custom-formatted date column as dates', () => {
  const { wb } = book();
  expect(workbookTable(wb, 'Sales').types).toEqual(['date', 'any', 'time']);
});

it('loads the dates back as dates', async () => {
  const { wb } = book();
  const query = { id: 'q1', name: 'Sales copy', source: { kind: 'table', table: 'Sales' }, steps: [], load: { kind: 'connection' } };
  query.steps = initialSteps(workbookTable(wb, 'Sales'), { promote: false });
  const { table, error } = await evaluateQuery(wb, query);
  expect(error).toBe(null);
  expect(table.types).toEqual(['date', 'int', 'time']);
  const out = loadResult(wb, query, table);
  expect(out.error).toBeUndefined();
  expect(wb.getCell(out.sheetId, 1, 0).s?.fmt).toBe('date');
  expect(wb.getDisplay(out.sheetId, 1, 1)).toBe('10');
  expect(wb.getCell(out.sheetId, 1, 2).s?.fmt).toBe('time');
});
