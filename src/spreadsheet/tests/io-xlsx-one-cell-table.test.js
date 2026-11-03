import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// A one-column table whose data rows were all deleted is its header cell alone, which the file names as a single
// cell (ref="A1", and its filter the same). The reader took only A1:B2-style references, so the table and its
// filter were dropped on reopening, and the next save wrote the file without them.
it('keeps a one-column table of its header alone, and its filter, through a save', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Name');
  wb.setInput(id, 1, 0, 'Ada');
  wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 0 });
  wb.deleteRows(id, 1, 1);
  expect(wb.sheets[0].tables[0].range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
  const back = await workbookFromFile(await workbookToXlsx(wb), 'one.xlsx');
  const sheet = back.sheets[0];
  expect(sheet.tables.map((t) => [t.name, t.range])).toEqual([[wb.sheets[0].tables[0].name, { r1: 0, c1: 0, r2: 0, c2: 0 }]]);
  expect(sheet.filter?.range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
  // A row typed under it grows it again, as before the save.
  back.setInput(sheet.id, 1, 0, 'Grace');
  expect(back.sheets[0].tables[0].range.r2).toBe(1);
});
