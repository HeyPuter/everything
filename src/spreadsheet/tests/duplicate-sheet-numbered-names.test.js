import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { placeSheet } from '../src/core/sheet-placement.js';

// A copied sheet was named "Sheet1 (copy)", then "Sheet1 (copy 2)"; Excel names it "Sheet1 (2)", then (3), and a
// copy of "Sheet1 (2)" is the next free "Sheet1 (n)". Every way of copying a sheet in the book goes through here.
const names = (wb) => wb.sheets.map((s) => s.name);

it('numbers each copy as Excel does', () => {
  const wb = new Workbook();
  const first = wb.sheets[0];
  expect(wb.duplicateSheet(first.id).name).toBe('Sheet1 (2)');
  expect(wb.duplicateSheet(first.id).name).toBe('Sheet1 (3)');
  expect(names(wb)).toEqual(['Sheet1', 'Sheet1 (3)', 'Sheet1 (2)']);
  expect(wb.duplicateSheet(wb.sheetByName('Sheet1 (2)').id).name).toBe('Sheet1 (4)');
});

it('carries on from the number a copied name ends with, and keeps the name within 31 characters', () => {
  const wb = new Workbook();
  wb.renameSheet(wb.sheets[0].id, 'Budget (2024)');
  expect(wb.duplicateSheet(wb.sheets[0].id).name).toBe('Budget (2025)');
  const long = wb.addSheet('A sheet name thirty-one chars!!');
  expect(wb.duplicateSheet(long.id).name).toBe('A sheet name thirty-one cha (2)');
});

it('names a copy made by the Move or Copy dialog the same way, and its formulas follow it', () => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, '4');
  wb.setInput(id, 0, 1, '=Sheet1!A1*2');
  const copy = placeSheet(wb, id, { before: id, copy: true });
  expect(copy.name).toBe('Sheet1 (2)');
  expect(wb.getCell(copy.id, 0, 1).f).toBe("'Sheet1 (2)'!A1*2");
});
