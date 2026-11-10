import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';
import { editedXlsx } from './helpers/xlsx-excel-edit.js';

// Sheet protection travels in this app's sidecar; another program's <sheetProtection sheet="1">
// was ignored, so a protected Excel sheet opened editable and was saved back unprotected.
const ROWS = '<row r="1"><c r="A1"><v>1</v></c></row>';

it('reads sheet protection another program wrote, and keeps it through a save', async () => {
  const bytes = otherProgramsXlsx({
    sheetNames: ['Locked', 'Hashed', 'Objects', 'Plain'],
    sheetXml: {
      Locked: { rows: ROWS, tail: '<sheetProtection sheet="1" objects="1" scenarios="1"/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' },
      Hashed: { rows: ROWS, tail: '<sheetProtection algorithmName="SHA-512" hashValue="abc=" saltValue="def=" spinCount="100000" sheet="true" formatCells="0"/>' },
      // Protection of drawings and scenarios alone leaves the cells editable.
      Objects: { rows: ROWS, tail: '<sheetProtection objects="1" scenarios="1"/>' },
      Plain: { rows: ROWS, tail: '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' },
    },
  });
  const wb = await workbookFromFile(bytes, 'locked.xlsx');
  expect(wb.sheets.map((s) => s.protected)).toEqual([true, true, false, false]);
  // A protected sheet refuses the edit; the plain one takes it.
  wb.setInput(wb.sheets[0].id, 0, 0, '2');
  expect(wb.getValue(wb.sheets[0].id, 0, 0)).toBe(1);
  wb.setInput(wb.sheets[3].id, 0, 0, '2');
  expect(wb.getValue(wb.sheets[3].id, 0, 0)).toBe(2);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'locked.xlsx');
  expect(back.sheets.map((s) => s.protected)).toEqual([true, true, false, false]);
});

// The app's own settings sheet, which Excel keeps when it saves, used to win over the worksheet XML for good: a
// sheet unprotected in Excel came back protected here (and one protected there came back open). It now notes
// what each save wrote, and a part that says otherwise was changed in Excel, whose word then wins.
async function savedProtected(on) {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  wb.setInput(wb.activeSheetId, 0, 0, '1');
  wb.setFrozen(wb.activeSheetId, 1, 0); // anything of the app's own, so the settings say more than the XML
  if (on) wb.setSheetProtected(wb.activeSheetId, true);
  return workbookToXlsx(wb);
}
const unprotect = { '/xl/worksheets/sheet1.xml': (xml) => xml.replace(/<sheetProtection\b[^>]*\/>/, '') };
const protect = { '/xl/worksheets/sheet1.xml': (xml) => xml.replace('</sheetData>', '</sheetData><sheetProtection sheet="1"/>') };

it('keeps a sheet unprotected in Excel unprotected, and one protected there protected', async () => {
  const opened = await workbookFromFile(await editedXlsx(await savedProtected(true), unprotect), 'mine.xlsx');
  expect(opened.sheets[0].protected).toBe(false);
  const locked = await workbookFromFile(await editedXlsx(await savedProtected(false), protect), 'mine.xlsx');
  expect(locked.sheets[0].protected).toBe(true);
  // Untouched, the app's own record still decides.
  expect((await workbookFromFile(await savedProtected(true), 'mine.xlsx')).sheets[0].protected).toBe(true);
});

it('lets the settings of a file saved before they noted the XML win over protection written into it', async () => {
  const back = await workbookFromFile(await editedXlsx(await savedProtected(false), protect, { older: true }), 'mine.xlsx');
  expect(back.sheets[0].protected).toBe(false);
});
