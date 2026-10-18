import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { evaluateQuery, loadResult, saveQuery, queryByName } from '../src/core/queries.js';

async function setup() {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'Q', source: { kind: 'csv', name: 'q.csv', text: 'a,b\n1,2\n3,4\n' }, steps: [{ type: 'promoteHeaders' }] });
  const q = queryByName(wb, 'Q');
  const { table } = await evaluateQuery(wb, q, {});
  return { wb, id, q, table };
}

it('refuses to load a query over cells that hold data, leaving them as they were', async () => {
  const { wb, id, q, table } = await setup();
  wb.setInput(id, 2, 1, 'Budget 2025');
  const res = loadResult(wb, q, table, { at: { sheetId: id, r: 0, c: 0 } });
  expect(res.error).toMatch(/data where the table would go/);
  expect(wb.getValue(id, 2, 1)).toBe('Budget 2025');
  expect(wb.sheet(id).tables).toHaveLength(0);
});

it('refuses a location a spilled result reaches into', async () => {
  const { wb, id, q, table } = await setup();
  wb.setInput(id, 1, 3, '=SEQUENCE(1,3)');
  expect(loadResult(wb, q, table, { at: { sheetId: id, r: 0, c: 4 } }).error).toMatch(/data where the table would go/);
  expect(wb.getValue(id, 1, 4)).toBe(2);
});

it('loads over empty or merely formatted cells', async () => {
  const { wb, id, q, table } = await setup();
  wb.setInput(id, 5, 0, 'just below');
  wb.setCells(id, [{ r: 1, c: 1, cell: { v: null, f: null, s: { bold: true } } }]);
  const res = loadResult(wb, q, table, { at: { sheetId: id, r: 0, c: 0 } });
  expect(res.error).toBeUndefined();
  expect(wb.getValue(id, 1, 1)).toBe('2');
  expect(wb.getValue(id, 5, 0)).toBe('just below');
});
