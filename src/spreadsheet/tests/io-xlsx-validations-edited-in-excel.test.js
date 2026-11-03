import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { editedXlsx } from './helpers/xlsx-excel-edit.js';

// The app's own settings sheet, which Excel keeps when it saves, held the sheet's validations, and on reopening
// they were taken whole from it: a dropdown deleted or edited in Excel came back as this app had saved it. A part
// whose validations are no longer what this app's save wrote was changed in Excel, and its rules now win.
const RANGE = (c) => ({ r1: 0, c1: c, r2: 4, c2: c });
async function saved() {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Lists' }] });
  const id = wb.sheets[0].id;
  wb.setInput(wb.sheets[1].id, 0, 0, 'North'); wb.setInput(wb.sheets[1].id, 1, 0, 'South');
  // A list whose options hold commas, kept on the settings sheet; a list on another sheet; a short list.
  wb.addValidation(id, { type: 'list', range: RANGE(0), source: ['Smith, Jane', 'Doe, John'] });
  wb.addValidation(id, { type: 'list', range: RANGE(1), source: '=Lists!$A$1:$A$2' });
  wb.addValidation(id, { type: 'list', range: RANGE(2), source: ['Yes', 'No'] });
  // A message longer than Excel keeps, which only the app's own record has whole.
  wb.addValidation(id, { type: 'number', range: RANGE(3), min: 1, max: 5, message: 'Pick a whole score. '.repeat(15).trim() });
  return workbookToXlsx(wb);
}
const sheet1 = (edit) => ({ '/xl/worksheets/sheet1.xml': edit });
const rule = (wb, c) => wb.sheets[0].validations.find((v) => v.range.c1 === c);

it('keeps a dropdown deleted or edited in Excel as Excel left it', async () => {
  const deleted = await workbookFromFile(await editedXlsx(await saved(), sheet1((xml) => xml.replace(/<dataValidation [^>]*sqref="C1:C5"[^>]*>[\s\S]*?<\/dataValidation>/, ''))), 'mine.xlsx');
  expect(rule(deleted, 2)).toBeUndefined();
  // The others come from the file now, the lists the app named for Excel taking their options again.
  expect(rule(deleted, 0).source).toEqual(['Smith, Jane', 'Doe, John']);
  expect(rule(deleted, 1).source).toBe('=Lists!$A$1:$A$2');
  expect(deleted.validateInput(deleted.sheets[0].id, 0, 1, 'South')).toMatchObject({ ok: true });
  expect(deleted.validateInput(deleted.sheets[0].id, 0, 1, 'West')).toMatchObject({ ok: false });
  expect(deleted.validateInput(deleted.sheets[0].id, 0, 0, 'Doe, John')).toMatchObject({ ok: true });
  const edited = await workbookFromFile(await editedXlsx(await saved(), sheet1((xml) => xml.replace('&quot;Yes,No&quot;', '&quot;Yes,No,Maybe&quot;'))), 'mine.xlsx');
  expect(rule(edited, 2).source).toEqual(['Yes', 'No', 'Maybe']);
});

it('keeps the validations this app saved while Excel left them alone', async () => {
  // Excel leaves out attributes at their defaults, and orders them its own way.
  const respelled = sheet1((xml) => xml.replace(/<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="stop" sqref="C1:C5">/, '<dataValidation sqref="C1:C5" showErrorMessage="1" allowBlank="1" type="list">'));
  const back = await workbookFromFile(await editedXlsx(await saved(), respelled), 'mine.xlsx');
  expect(back.sheets[0].validations.map((v) => v.type)).toEqual(['list', 'list', 'list', 'number']);
  expect(rule(back, 3).message).toBe('Pick a whole score. '.repeat(15).trim());
});

it('lets the settings of a file saved before they noted the XML keep its validations', async () => {
  const edit = sheet1((xml) => xml.replace(/<dataValidation [^>]*sqref="C1:C5"[^>]*>[\s\S]*?<\/dataValidation>/, ''));
  const back = await workbookFromFile(await editedXlsx(await saved(), edit, { older: true }), 'mine.xlsx');
  expect(back.sheets[0].validations).toHaveLength(4);
});
