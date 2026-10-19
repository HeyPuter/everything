import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';

// Formulas ▸ Calculation Options ▸ Automatic Except for Data Tables only set Automatic, under a hint that there
// were no data tables to leave out; a file saved by Excel in that mode lost it on opening and on saving, and every
// edit anywhere ran every What-If data table again (over a second per edit for a 100 × 100 table). In that mode
// data tables now keep their results until F9, as in Excel, and the mode is kept in files.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 6, '5');
  wb.setInput(id, 0, 7, '2');
  wb.setInput(id, 1, 1, '=G1*H1');
  [1, 2, 3].forEach((v, i) => wb.setInput(id, 2 + i, 0, String(v)));
  wb.createDataTable(id, { r1: 1, c1: 0, r2: 4, c2: 1 }, null, { r: 0, c: 6 });
  const results = () => [2, 3, 4].map((r) => wb.getValue(id, r, 1));
  return { wb, id, results };
}

it('keeps data tables at their results until F9, and works everything else out as usual', () => {
  const { wb, id, results } = book();
  wb.setCalcMode('autoNoTable');
  expect(results()).toEqual([2, 4, 6]);
  wb.setInput(id, 0, 7, '10');
  expect(wb.getValue(id, 1, 1)).toBe(50);
  expect(results()).toEqual([2, 4, 6]);
  wb.recalculate();
  expect(results()).toEqual([10, 20, 30]);
  wb.setCalcMode('automatic');
  wb.setInput(id, 0, 7, '1');
  expect(results()).toEqual([1, 2, 3]);
});

it('keeps the mode in the workbook and in .xlsx files', async () => {
  const { wb } = book();
  wb.setCalcMode('autoNoTable');
  expect(new Workbook(wb.toJSON()).calcMode).toBe('autoNoTable');
  const back = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'tables.xlsx');
  expect(back.calcMode).toBe('autoNoTable');
});
