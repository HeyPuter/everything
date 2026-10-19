import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import {
  evaluateQuery, loadResult, saveQuery, queryByName, workbookTable, initialSteps, convertValue, displayValue, stepFormula,
} from '../src/core/queries.js';

// A query had no date-time or time type: a column of date-times (2024-01-15 10:30) was detected as Date and every
// time of day was cut off, in the query and in the cells it loaded, and a column of times loaded as bare decimals
// (0.4375). Power Query detects such columns as Date/Time and Time and keeps the times.

it('keeps the time of day of a table column of date-times, and loads it as date-times', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'When');
  wb.setInput(id, 0, 1, 'Amt');
  wb.setInput(id, 1, 0, '2024-01-15 10:30');
  wb.setInput(id, 1, 1, '5');
  wb.setInput(id, 2, 0, '2024-01-16 18:45');
  wb.setInput(id, 2, 1, '6');
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, { name: 'Log' });
  const steps = initialSteps(workbookTable(wb, 'Log'), { promote: false });
  expect(steps.at(-1).columns).toEqual({ When: 'datetime', Amt: 'int' });
  saveQuery(wb, { name: 'LogQ', source: { kind: 'table', table: 'Log' }, steps });
  const q = queryByName(wb, 'LogQ');
  const { table } = await evaluateQuery(wb, q, {});
  expect(table.rows.map((r) => r[0])).toEqual([45306.4375, 45307.78125]);
  expect(displayValue(table.rows[0][0], 'datetime')).toBe('1/15/2024 10:30:00 AM');
  expect(stepFormula(q, steps.length)).toContain('type datetime');
  const out = loadResult(wb, q, table, { at: { sheetId: id, r: 5, c: 0 } });
  expect(wb.getValue(out.sheetId, 6, 0)).toBe(45306.4375);
  expect(wb.getCell(out.sheetId, 6, 0).s).toMatchObject({ fmt: 'datetime' });
});

it('detects date-times and times in text, and leaves a column of plain dates a date', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'C', source: { kind: 'csv', name: 's.csv', text: 'When,At,Day\n2024-01-15 10:30,10:30,2024-01-15\n1/16/2024 6:45 PM,6:45 PM,2024-01-16\n' },
    steps: [{ type: 'promoteHeaders' }] });
  const raw = (await evaluateQuery(wb, queryByName(wb, 'C'), {})).table;
  const steps = initialSteps(raw, { promote: false });
  expect(steps.at(-1).columns).toEqual({ When: 'datetime', At: 'time', Day: 'date' });
  saveQuery(wb, { ...queryByName(wb, 'C'), steps: [{ type: 'promoteHeaders' }, ...steps] });
  const q = queryByName(wb, 'C');
  const { table } = await evaluateQuery(wb, q, {});
  expect(table.rows).toEqual([[45306.4375, 0.4375, 45306], [45307.78125, 0.78125, 45307]]);
  loadResult(wb, q, table, { at: { sheetId: id, r: 0, c: 0 } });
  expect(wb.getCell(id, 1, 1).s).toMatchObject({ fmt: 'time' });
  expect(wb.getCell(id, 1, 2).s).toMatchObject({ fmt: 'date' });
});

it('converts between the date types as Power Query does', () => {
  expect(convertValue(45306.4375, 'datetime', 'date')).toBe(45306);
  expect(convertValue(45306.4375, 'datetime', 'time')).toBe(0.4375);
  expect(convertValue(45306, 'date', 'datetime')).toBe(45306);
  expect(convertValue(45306.4375, 'datetime', 'text')).toBe('1/15/2024 10:30:00 AM');
  expect(convertValue(0.75, 'time', 'text')).toBe('6:00:00 PM');
  expect(convertValue('1/15/2024 10:30 AM', 'text', 'datetime')).toBe(45306.4375);
  expect(convertValue('10:30', 'text', 'time')).toBe(0.4375);
  expect(convertValue('soon', 'text', 'datetime')).toMatchObject({ error: 'DataFormat.Error' });
});
