import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { evaluateQuery, loadResult, refreshQuery, saveQuery, queryByName } from '../src/core/queries.js';

it('keeps the formatting given to a loaded table\'s cells through a refresh, and gives it to the rows it gains', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  saveQuery(wb, { name: 'Sales', source: { kind: 'csv', name: 's.csv', text: 'When,Amount\n2024-01-05,2\n2024-02-01,4\n' },
    steps: [{ type: 'promoteHeaders' }, { type: 'changeType', columns: { When: 'date', Amount: 'decimal' } }] });
  const q = queryByName(wb, 'Sales');
  loadResult(wb, q, (await evaluateQuery(wb, q, {})).table, { at: { sheetId: id, r: 0, c: 0 } });
  wb.applyStyle(id, { r1: 1, c1: 1, r2: 2, c2: 1 }, { fmt: 'currency', dec: 2 });
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, { italic: true });
  wb.applyStyle(id, { r1: 1, c1: 0, r2: 2, c2: 0 }, { bold: true });
  expect(wb.getDisplay(id, 1, 1)).toBe('$2.00');

  const live = queryByName(wb, 'Sales');
  saveQuery(wb, { ...live, source: { ...live.source, text: 'When,Amount\n2024-01-05,2\n2024-02-01,4\n2024-03-09,6.5\n' } });
  expect((await refreshQuery(wb, queryByName(wb, 'Sales'), {})).error).toBeUndefined();
  expect([1, 2, 3].map((r) => wb.getDisplay(id, r, 1))).toEqual(['$2.00', '$4.00', '$6.50']);
  expect(wb.getCell(id, 0, 1).s).toMatchObject({ italic: true });
  // A date column keeps its date format along with the bold given to it.
  expect(wb.getCell(id, 3, 0).s).toMatchObject({ fmt: 'date', bold: true });
  expect(wb.getDisplay(id, 3, 0)).not.toBe(String(wb.getValue(id, 3, 0)));
  expect(wb.getCell(id, 1, 0).s).toMatchObject({ fmt: 'date', bold: true });
});
