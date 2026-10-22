import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Doc } from '../src/lib/doc.js';
import { memoryStorage } from './helpers/memory-storage.js';

// CELL("filename") was always empty, as Excel answers only for a book never saved, so the usual way to show a
// sheet's own name, =MID(CELL("filename",A1),FIND("]",CELL("filename",A1))+1,99), was #VALUE! in every saved
// book. It is now the file's path with its name in brackets and the sheet after it, as Excel writes it.
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});
afterEach(() => vi.unstubAllGlobals());

it('names the file and the sheet of the cell', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const data = wb.addSheet('Q1 Data').id;
  const at = (formula) => { wb.setInput(id, 0, 0, `=${formula}`); return wb.getValue(id, 0, 0); };
  expect(at('CELL("filename",B2)')).toBe(''); // never saved
  wb.filePath = '/nj/Documents/Spreadsheets/Budget.xlsx';
  wb.recalculate(); // CELL("filename") follows a new path once calculated again, as in Excel
  expect(at('CELL("filename",B2)')).toBe('/nj/Documents/Spreadsheets/[Budget.xlsx]Sheet1');
  expect(at('CELL("filename")')).toBe('/nj/Documents/Spreadsheets/[Budget.xlsx]Sheet1');
  expect(at("CELL(\"filename\",'Q1 Data'!A1)")).toBe('/nj/Documents/Spreadsheets/[Budget.xlsx]Q1 Data');
  expect(at('MID(CELL("filename",B2),FIND("]",CELL("filename",B2))+1,99)')).toBe('Sheet1');
  wb.setInput(data, 0, 0, '=TEXTAFTER(CELL("filename",A1),"]")');
  expect(wb.getValue(data, 0, 0)).toBe('Q1 Data');
});

it('follows the document to wherever it is saved', () => {
  const doc = new Doc({ name: 'Plan', path: 'Spreadsheets/Plan.xlsx' });
  expect(doc.wb.filePath).toBe('Spreadsheets/Plan.xlsx');
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, '=CELL("filename",A2)');
  expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe('Spreadsheets/[Plan.xlsx]Sheet1');
  doc.path = '/nj/Desktop/Plan 2.xlsx'; // saved as another file: the formula follows once calculated again
  expect(doc.path).toBe('/nj/Desktop/Plan 2.xlsx');
  doc.wb.recalculate();
  expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe('/nj/Desktop/[Plan 2.xlsx]Sheet1');
  expect(new Doc({ name: 'New' }).wb.filePath).toBe(null);
});
