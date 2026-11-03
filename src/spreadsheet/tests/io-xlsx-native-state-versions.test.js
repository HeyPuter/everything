import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { NATIVE_STATE_VERSIONS, nativeSheetState, nativeValidationsSignature } from '../src/core/xlsx-native-state.js';
import { editedXlsx } from './helpers/xlsx-excel-edit.js';

// A save notes what it wrote into each worksheet part, and a part saying otherwise on reopening was edited in
// Excel, its word then winning over the app's record. The validations' note is a hash of what the validations
// reader makes of them, so a later reader taking in one more attribute would have made every file saved before
// read as edited in Excel: long messages cut to Excel's 255 characters, number rules turned to formula rules. A
// note made under another version of a setting's note is now no note at all, and the record keeps that setting.
async function saved() {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  for (let r = 0; r < 6; r++) wb.setInput(id, r, 0, String(r + 1));
  wb.setHidden(id, 'row', [2, 40], true);
  wb.setHidden(id, 'col', [3], true);
  wb.addValidation(id, { type: 'list', range: { r1: 0, c1: 1, r2: 4, c2: 1 }, source: ['Yes', 'No'] });
  wb.addValidation(id, { type: 'number', range: { r1: 0, c1: 2, r2: 4, c2: 2 }, min: 1, max: 5, message: 'Pick a whole score. '.repeat(15).trim() });
  return workbookToXlsx(wb);
}
const edits = { '/xl/worksheets/sheet1.xml': (xml) => xml
  .replace(/(<row r="3"[^>]*?) hidden="1"/, '$1')
  .replace(/(<col min="4"[^>]*?) hidden="1"/, '$1')
  .replace(/<dataValidation [^>]*sqref="B1:B5"[^>]*>[\s\S]*?<\/dataValidation>/, '') };
const state = (wb) => ({
  rows: [...wb.sheets[0].hiddenRows].sort((a, b) => a - b), cols: [...wb.sheets[0].hiddenCols].sort((a, b) => a - b),
  validations: wb.sheets[0].validations.map((v) => v.type), message: wb.sheets[0].validations.at(-1)?.message,
});

it('lets the record keep a setting whose note was made under another version of it', async () => {
  // The note of the hidden rows and of the validations from another version; the columns' from this one.
  const versions = (v) => ({ ...v, hiddenRows: v.hiddenRows + 1, validations: v.validations + 1 });
  const back = await workbookFromFile(await editedXlsx(await saved(), edits, { versions }), 'mine.xlsx');
  expect(state(back)).toEqual({ rows: [2, 40], cols: [], validations: ['list', 'number'], message: 'Pick a whole score. '.repeat(15).trim() });
  // Notes made before they had versions are no notes either.
  const unversioned = await workbookFromFile(await editedXlsx(await saved(), edits, { versions: () => ({}) }), 'mine.xlsx');
  expect(state(unversioned)).toEqual({ rows: [2, 40], cols: [3], validations: ['list', 'number'], message: 'Pick a whole score. '.repeat(15).trim() });
});

it('still takes the settings Excel changed when the notes are of this version', async () => {
  const back = await workbookFromFile(await editedXlsx(await saved(), edits), 'mine.xlsx');
  expect(state(back)).toMatchObject({ rows: [40], cols: [] });
  expect(back.sheets[0].validations).toHaveLength(1);
});

it('notes the same of the same part as it always has, or the version says otherwise', async () => {
  // A failure here means files saved before would read as edited in Excel: bump that setting's version.
  const part = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><tabColor rgb="FF00FF00"/></sheetPr>'
    + '<sheetViews><sheetView showGridLines="0" zoomScale="150" workbookViewId="0"/></sheetViews><cols><col min="2" max="3" width="0" outlineLevel="1" collapsed="1"/></cols>'
    + '<sheetData><row r="2" hidden="1" outlineLevel="2"><c r="A2"><v>1</v></c></row><row r="3" ht="0" collapsed="1"/></sheetData>'
    + '<sheetProtection sheet="1"/><dataValidations count="2"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="A1:A5"><formula1>"Yes,No"</formula1></dataValidation>'
    + '<dataValidation type="whole" operator="between" showInputMessage="1" promptTitle="Score" prompt="1 to 5" sqref="B1:B5"><formula1>1</formula1><formula2>5</formula2></dataValidation></dataValidations></worksheet>';
  expect(nativeSheetState(part)).toEqual({ protected: true, color: '00FF00||||', gridlines: false, zoom: 150,
    hiddenRows: [[1, 2]], hiddenCols: [[1, 2]], rowLevels: [[1, 1, 2]], colLevels: [[1, 2, 1]], collapsedRows: [[2, 2]], collapsedCols: [[1, 2]] });
  expect(await nativeValidationsSignature(part)).toBe('a23c2375b60112e9257980e0d220268250b5e9e008580633cc355851399bc453');
  expect(NATIVE_STATE_VERSIONS).toEqual({ protected: 1, color: 1, gridlines: 1, zoom: 1, zoomToFit: 1, hiddenRows: 1, hiddenCols: 1,
    rowLevels: 1, colLevels: 1, collapsedRows: 1, collapsedCols: 1, validations: 1 });
});
