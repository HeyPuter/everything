import { expect, it } from 'vitest';
import { Workbook, outlineSettingsOf } from '../src/core/workbook.js';
import { workbookToOds, workbookFromFile } from '../src/core/io.js';

// Saved as .ods, a sheet's Outline Settings (summary rows above their detail, columns left of it, automatic
// styles) were lost: the .xlsx writer keeps them in the worksheet's <outlinePr>, the .ods writer had no place for
// them, and the sheet came back with summaries below, so Show Detail and Auto Outline read its totals wrongly.
// They now travel in the app's own settings of the .ods.
it('keeps the outline settings of an .ods', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  wb.setOutlineSettings(id, { summaryBelow: false, summaryRight: false, autoStyles: true });
  const back = await workbookFromFile(await workbookToOds(wb), 'book.ods');
  expect(outlineSettingsOf(back.sheet(back.activeSheetId))).toEqual({ summaryBelow: false, summaryRight: false, autoStyles: true });
});
