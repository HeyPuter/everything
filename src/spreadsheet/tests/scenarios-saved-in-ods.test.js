import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookToOds, workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import { saveScenario, showScenario } from '../src/core/scenarios.js';

// Saved as .ods, a sheet lost its What-If scenarios: the .xlsx writer keeps them in the worksheet's <scenarios>,
// the .ods writer had no place for them, and the Scenario Manager came back empty. They now travel in the app's
// own settings of the .ods, as its other sheet settings do.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  wb.setInput(id, 0, 1, '=A1*2');
  saveScenario(wb, id, { name: 'Best case', cells: [{ r: 0, c: 0 }], values: [5], comment: 'note', hidden: true });
  return wb;
}

it('keeps the scenarios of an .ods', async () => {
  const back = await workbookFromFile(await workbookToOds(book()), 'book.ods');
  const id = back.activeSheetId;
  expect(back.sheet(id).scenarios.list).toEqual([expect.objectContaining({ name: 'Best case', cells: [{ r: 0, c: 0 }], values: [5], comment: 'note', hidden: true })]);
  showScenario(back, id, 'Best case');
  expect(back.getValue(id, 0, 1)).toBe(10);
});

it('still reads the scenarios of an .xlsx from the worksheet', async () => {
  const back = await workbookFromFile(await workbookToXlsx(book()), 'book.xlsx');
  expect(back.sheet(back.activeSheetId).scenarios.list.map((s) => s.name)).toEqual(['Best case']);
});
