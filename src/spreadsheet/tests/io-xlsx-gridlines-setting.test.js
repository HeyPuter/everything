import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';
import { editedXlsx } from './helpers/xlsx-excel-edit.js';

// Whether a sheet shows gridlines travels in this app's sidecar; another program's
// <sheetView showGridLines="0"> was ignored, so a dashboard laid out without gridlines
// opened with them, and was saved back with them.
const ROWS = '<row r="1"><c r="A1"><v>1</v></c></row>';
const views = (attrs) => `<sheetViews><sheetView ${attrs} workbookViewId="0"/></sheetViews>`;

it('reads the gridline setting another program wrote, and keeps it through a save', async () => {
  const bytes = otherProgramsXlsx({
    sheetNames: ['Off', 'OffWord', 'On', 'Plain', 'Second'],
    sheetXml: {
      Off: { head: views('showGridLines="0" tabSelected="1"'), rows: ROWS },
      OffWord: { head: views('showGridLines="false"'), rows: ROWS },
      On: { head: views('showGridLines="1"'), rows: ROWS },
      Plain: { head: '<dimension ref="A1"/>', rows: ROWS },
      // Only the first view is the sheet's own; a second (a custom view's) does not count.
      Second: { head: `<sheetViews><sheetView workbookViewId="0"/><sheetView showGridLines="0" workbookViewId="1"/></sheetViews>`, rows: ROWS },
    },
  });
  const wb = await workbookFromFile(bytes, 'dashboard.xlsx');
  expect(wb.sheets.map((s) => s.gridlines)).toEqual([false, false, true, true, true]);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'dashboard.xlsx');
  expect(back.sheets.map((s) => s.gridlines)).toEqual([false, false, true, true, true]);
});

// The app's own settings sheet, which Excel keeps when it saves, used to win over the worksheet XML for good:
// gridlines turned off (or on) in Excel came back as this app last saved them. A part that no longer says what
// this app's save wrote was changed in Excel, whose setting now wins.
async function saved(gridlines) {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  wb.setInput(wb.activeSheetId, 0, 0, '1');
  wb.setFrozen(wb.activeSheetId, 1, 0); // anything of the app's own, so the settings say more than the XML
  if (!gridlines) wb.setGridlines(wb.activeSheetId, false);
  return workbookToXlsx(wb);
}
const shown = (value) => ({ '/xl/worksheets/sheet1.xml': (xml) => xml.replace(/ showGridLines="[^"]*"/, value == null ? '' : ` showGridLines="${value}"`) });

it('keeps gridlines turned off or on in Excel', async () => {
  const off = await workbookFromFile(await editedXlsx(await saved(true), shown('0')), 'mine.xlsx');
  expect(off.sheets[0].gridlines).toBe(false);
  // Excel leaves the attribute out when the gridlines are on, its default.
  const on = await workbookFromFile(await editedXlsx(await saved(false), shown(null)), 'mine.xlsx');
  expect(on.sheets[0].gridlines).toBe(true);
  const same = await workbookFromFile(await editedXlsx(await saved(true), shown(null)), 'mine.xlsx');
  expect(same.sheets[0].gridlines).toBe(true);
  expect((await workbookFromFile(await saved(false), 'mine.xlsx')).sheets[0].gridlines).toBe(false);
});

it('lets the settings of a file saved before they noted the XML win over a view written into it', async () => {
  const back = await workbookFromFile(await editedXlsx(await saved(true), shown('0'), { older: true }), 'mine.xlsx');
  expect(back.sheets[0].gridlines).toBe(true);
});
