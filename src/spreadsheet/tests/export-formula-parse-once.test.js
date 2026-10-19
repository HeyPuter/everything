import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookToXlsx } from '../src/core/io.js';

// An export (which every autosave is) asked each cell for its link, and a formula cell answered by
// parsing its formula through the text cache, which holds 5000 entries and is cleared whole: a column
// of distinct filled-down formulas was parsed anew on every save. The link now reads the parse kept
// with the cell, as the calculation does, so an export parses nothing the calculation has parsed.
it('exports a column of distinct formulas without parsing any of them again', { timeout: 60000 }, async () => {
  const rows = 6000; // more than the formula text cache holds
  const cells = {};
  for (let r = 0; r < rows; r++) {
    cells[`${r},0`] = { v: r };
    cells[`${r},1`] = { f: `A${r + 1}*2` };
    cells[`${r},2`] = { f: `HYPERLINK("https://example.com/"&A${r + 1},"row "&A${r + 1})` };
  }
  const wb = new Workbook({ sheets: [{ name: 'S', rows: rows + 5, cols: 4, cells }] });
  const id = wb.activeSheetId;
  await workbookToXlsx(wb); // the first export calculates, and so parses, every formula once
  wb.setInput(id, rows + 1, 3, 'edit'); // every cached value goes, as after any edit before an autosave
  let parses = 0;
  const ast = wb._ast.bind(wb);
  wb._ast = (formula) => { parses++; return ast(formula); };
  const blob = await workbookToXlsx(wb);
  expect(blob.size).toBeGreaterThan(1000);
  expect(parses).toBe(0);
  expect(wb.linkAt(id, 7, 2)).toEqual({ url: 'https://example.com/7', label: 'row 7' });
});

it('still translates structured references and follows a formula too deep to parse', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Amount');
  wb.setInput(id, 1, 0, '5');
  wb.setInput(id, 2, 0, '7');
  wb.setInput(id, 0, 1, 'Double');
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, { name: 'Sales' });
  wb.setInput(id, 1, 1, '=[@Amount]*2');
  // An exception in the calculated column, as a paste makes one (a formula typed there would rewrite the column).
  wb.setCells(id, [{ r: 2, c: 1, cell: { v: null, f: 'SUM(Sales[Amount])' } }]);
  wb.setInput(id, 4, 0, `=${'('.repeat(3000)}1${')'.repeat(3000)}`);
  const blob = await workbookToXlsx(wb);
  expect(blob.size).toBeGreaterThan(1000);
  expect(wb.getValue(id, 1, 1)).toBe(10);
  expect(wb.linkAt(id, 4, 0)).toBe(null);
});
