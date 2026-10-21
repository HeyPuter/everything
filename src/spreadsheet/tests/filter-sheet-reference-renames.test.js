import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

const range = { r1: 0, c1: 0, r2: 2, c2: 0 };
function source(formula = 'Data!A2>5') {
  return new Workbook({ sheets: [{ name: 'Data', cells: { '0,0': { v: 'Value' }, '1,0': { v: 3 }, '2,0': { v: 9 } }, filter: { range, criteria: { 0: { formula } } } }] });
}
it('keeps a filter bound to its renamed sheet, including quoted names', () => {
  const wb = source(), id = wb.activeSheetId; wb.renameSheet(id, "Plan's data"); wb.reapplyFilter(id);
  expect(wb.sheet(id).filter.criteria[0].formula).toBe("'Plan''s data'!A2>5");
  expect([...wb.sheet(id).filterHidden]).toEqual([1]);
  wb.undo(); expect(wb.sheet(id).filter.criteria[0].formula).toBe('Data!A2>5');
  wb.redo(); expect([...wb.sheet(id).filterHidden]).toEqual([1]);
});
it('rewrites cross-sheet filter criteria while preserving quoted text', () => {
  const wb = source(), other = wb.addSheet('Report');
  wb.setInput(other.id, 0, 0, 'Value'); wb.setInput(other.id, 1, 0, '3'); wb.setInput(other.id, 2, 0, '9');
  wb.setFilterRange(other.id, range); wb.setFilterCriteria(other.id, 0, { formula: 'AND(Data!A2>5,"Data!A2"="Data!A2")' });
  wb.renameSheet(wb.sheets[0].id, 'Renamed'); wb.reapplyFilter(other.id);
  expect(other.filter.criteria[0].formula).toBe('AND(Renamed!A2>5,"Data!A2"="Data!A2")');
  expect([...other.filterHidden]).toEqual([1]);
});
it('makes a duplicate filter follow copied values as they change', () => {
  const wb = source(), original = wb.sheets[0], copy = wb.duplicateSheet(original.id);
  expect(copy.filter.criteria[0].formula).toBe("'Data (2)'!A2>5");
  wb.setInput(copy.id, 1, 0, '10'); wb.setInput(copy.id, 2, 0, '1'); wb.reapplyFilter(copy.id);
  expect([...copy.filterHidden]).toEqual([2]); expect([...original.filterHidden]).toEqual([1]);
  expect(original.filter.criteria[0].formula).toBe('Data!A2>5');
});
it('binds imported filters to renamed incoming sheets instead of destination sheets', () => {
  const src = source(), before = src.toJSON(), wb = source();
  wb.setInput(wb.activeSheetId, 1, 0, '10'); wb.setInput(wb.activeSheetId, 2, 0, '1'); wb.reapplyFilter(wb.activeSheetId);
  const [copy] = wb.importSheets(src);
  expect(copy.filter.criteria[0].formula).toBe("'Data (2)'!A2>5");
  expect([...copy.filterHidden]).toEqual([1]); expect([...wb.sheets[0].filterHidden]).toEqual([2]);
  expect(src.toJSON()).toEqual(before);
});
it('rebinds replacement criteria before the filter initializes', () => {
  const src = source(), wb = new Workbook(), id = wb.activeSheetId;
  const sheet = wb.replaceSheetWith(id, src, src.activeSheetId);
  expect(sheet.filter.criteria[0].formula).toBe('Sheet1!A2>5'); expect([...sheet.filterHidden]).toEqual([1]);
  wb.undo(); wb.redo(); expect([...wb.sheet(id).filterHidden]).toEqual([1]);
});
it('rewrites qualified named expressions used by filter criteria', () => {
  const wb = source('A2>Data!Floor'); wb.defineName('Floor', '5', 'Data');
  const copy = wb.duplicateSheet(wb.activeSheetId);
  expect(copy.filter.criteria[0].formula).toBe("A2>'Data (2)'!Floor");
  wb.defineName('Floor', '1', copy.name); wb.reapplyFilter(copy.id); expect([...copy.filterHidden]).toEqual([]);
});
it('leaves nonformula criteria and unrelated references unchanged', () => {
  const wb = source('Missing!A2>5'), id = wb.activeSheetId;
  wb.sheet(id).filter.criteria[1] = { text: 'Data!A2' };
  wb.renameSheet(id, 'Renamed');
  expect(wb.sheet(id).filter.criteria).toEqual({ 0: { formula: 'Missing!A2>5' }, 1: { text: 'Data!A2' } });
});
it('preserves rewritten filter behavior through XLSX reopening', async () => {
  let wb = source(); const copy = wb.duplicateSheet(wb.activeSheetId);
  wb.setInput(copy.id, 1, 0, '10'); wb.setInput(copy.id, 2, 0, '1'); wb.reapplyFilter(copy.id);
  wb = await workbookFromFile(await workbookToXlsx(wb), 'filters.xlsx');
  expect([...wb.sheetByName(copy.name).filterHidden]).toEqual([2]);
  expect([...wb.sheetByName('Data').filterHidden]).toEqual([1]);
});
