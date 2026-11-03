import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';
import { editedXlsx } from './helpers/xlsx-excel-edit.js';

// A sheet's tab colour travels in this app's sidecar; another program's <sheetPr><tabColor>
// was ignored, so an Excel file's coloured tabs opened grey and were saved back that way.
const ROWS = '<row r="1"><c r="A1"><v>1</v></c></row>';

it('reads the tab colour another program wrote, and keeps it through a save', async () => {
  const bytes = otherProgramsXlsx({
    sheetNames: ['Red', 'Themed', 'Plain', 'Odd'],
    sheetXml: {
      Red: { head: '<sheetPr><tabColor rgb="FFFF0000"/><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1"/>', rows: ROWS },
      Themed: { head: '<sheetPr><tabColor theme="5" tint="0.39997558519241921"/></sheetPr>', rows: ROWS },
      Plain: { head: '<sheetPr codeName="Sheet3"/>', rows: ROWS },
      Odd: { head: '<sheetPr><tabColor rgb="00ABCDEFGH"/></sheetPr>', rows: ROWS },
    },
  });
  const wb = await workbookFromFile(bytes, 'tabs.xlsx');
  expect(wb.sheets.map((s) => s.color)).toEqual(['#ff0000', '#d99694', null, null]);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'tabs.xlsx');
  expect(back.sheets.map((s) => s.color)).toEqual(['#ff0000', '#d99694', null, null]);
});

// The app's own settings sheet, which Excel keeps when it saves, used to win over the worksheet XML for good:
// a tab recoloured or uncoloured in Excel came back in the colour it had here. A part that no longer says
// what this app's save wrote was changed in Excel, whose colour now wins.
async function savedGreen() {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  wb.setInput(wb.activeSheetId, 0, 0, '1');
  wb.setSheetColor(wb.activeSheetId, '#00FF00');
  return workbookToXlsx(wb);
}
const recolor = (tag) => ({ '/xl/worksheets/sheet1.xml': (xml) => xml.replace(/<tabColor\b[^>]*\/>/, tag) });

it('keeps a tab colour changed or taken off in Excel', async () => {
  const red = await workbookFromFile(await editedXlsx(await savedGreen(), recolor('<tabColor rgb="FFFF0000"/>')), 'mine.xlsx');
  expect(red.sheets[0].color).toBe('#ff0000');
  const plain = await workbookFromFile(await editedXlsx(await savedGreen(), recolor('')), 'mine.xlsx');
  expect(plain.sheets[0].color).toBe(null);
  // Excel spelling the same colour its own way is no change; the app's record still decides.
  const same = await workbookFromFile(await editedXlsx(await savedGreen(), recolor('<tabColor rgb="ff00ff00"/>')), 'mine.xlsx');
  expect(same.sheets[0].color).toBe('#00FF00');
});

it('lets the settings of a file saved before they noted the XML win over a tab colour written into it', async () => {
  const back = await workbookFromFile(await editedXlsx(await savedGreen(), recolor('<tabColor rgb="FFFF0000"/>'), { older: true }), 'mine.xlsx');
  expect(back.sheets[0].color).toBe('#00FF00');
});
