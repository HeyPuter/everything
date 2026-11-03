import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

// A package that lists a part it does not hold (a file cut down by a tool, or a part lost on the way) was refused
// outright, data and all, when that part was the cell metadata (which marks dynamic-array formulas) or the people
// of threaded comments. Excel opens such a file, repaired; so does this app now, taking the part as none.
const without = (bytes, path) => {
  const zip = X.CFB.read(new Uint8Array(bytes), { type: 'array' });
  X.CFB.utils.cfb_del(zip, path);
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
};

it('opens a workbook whose listed cell metadata part is missing', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  wb.setInput(wb.activeSheetId, 0, 0, '=SEQUENCE(3)');
  wb.setInput(wb.activeSheetId, 0, 1, 'kept');
  const bytes = await (await workbookToXlsx(wb)).arrayBuffer();
  expect(X.CFB.find(X.CFB.read(new Uint8Array(bytes), { type: 'array' }), '/xl/metadata.xml')).toBeTruthy();
  const back = await workbookFromFile(without(bytes, '/xl/metadata.xml'), 'cut.xlsx');
  const id = back.sheets[0].id;
  expect([back.getValue(id, 0, 0), back.getValue(id, 2, 0), back.getValue(id, 0, 1)]).toEqual([1, 3, 'kept']);
});

it('opens a workbook whose listed people part is missing', async () => {
  const bytes = otherProgramsXlsx({ sheetXml: { Data: { rows: '<row r="1"><c r="A1"><v>7</v></c></row>' } }, patch: {
    '/[Content_Types].xml': (xml) => xml.replace('</Types>', '<Override PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"/></Types>'),
  } });
  const back = await workbookFromFile(bytes, 'cut.xlsx');
  expect(back.getValue(back.sheets[0].id, 0, 0)).toBe(7);
});

// Likewise a sheet whose notes part it names is missing: the sheet, and so the whole workbook, was refused.
it('opens a workbook whose sheet names a notes part that is missing, without the notes', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  wb.setInput(wb.activeSheetId, 0, 0, '5');
  wb.setNote(wb.activeSheetId, 0, 0, 'Checked');
  const bytes = await (await workbookToXlsx(wb)).arrayBuffer();
  const zip = X.CFB.read(new Uint8Array(bytes), { type: 'array' });
  const notes = zip.FullPaths.map((p) => p.replace(/^Root Entry/, '')).find((p) => /\/comments\d*\.xml$/.test(p));
  expect(notes).toBeTruthy();
  const back = await workbookFromFile(without(bytes, notes), 'cut.xlsx');
  expect(back.getValue(back.sheets[0].id, 0, 0)).toBe(5);
});
