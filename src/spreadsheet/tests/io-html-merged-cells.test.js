// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { sheetToHtml } from '../src/core/io.js';

// Saving a sheet as a web page wrote a merged block as its first cell beside empty ones, so a title
// merged across the columns wrapped inside the first column. Blocks now span their rows and columns,
// as copying them does, also when the block's first row holds nothing else.
const page = (wb) => new DOMParser().parseFromString(sheetToHtml(wb, wb.activeSheetId), 'text/html');

it('writes merged blocks with their column and row spans', () => {
  const wb = new Workbook({ sheets: [{ name: 'Report', cells: {
    '0,0': { v: 'Quarterly report' }, '1,0': { v: 1 }, '1,1': { v: 2 }, '1,2': { v: 3 }, '3,1': { v: 'b4' }, '3,2': { v: 'c4' },
  }, merges: [{ r1: 0, c1: 0, r2: 0, c2: 2 }, { r1: 2, c1: 0, r2: 3, c2: 0 }] }] });
  const rows = [...page(wb).querySelectorAll('tr')].map((tr) => [...tr.cells]);
  expect(rows[0]).toHaveLength(1);
  expect(rows[0][0]).toMatchObject({ colSpan: 3, textContent: 'Quarterly report' });
  expect(rows[1].map((td) => td.textContent)).toEqual(['1', '2', '3']);
  // The second block starts in a row with nothing else in it; the row below keeps its cells in their columns.
  expect(rows[2][0].rowSpan).toBe(2);
  expect(rows[3].map((td) => td.textContent)).toEqual(['b4', 'c4']);
  // No border is invented on the spanning cell's far sides: the page's gridlines show there as elsewhere.
  expect(rows[0][0].getAttribute('style') || '').not.toMatch(/border/);
});

it('spans only the shown lines of a block a hidden row or column cuts through', () => {
  const wb = new Workbook({ sheets: [{ name: 'Report', cells: { '0,0': { v: 'Wide' }, '2,0': { v: 'x' } },
    merges: [{ r1: 0, c1: 0, r2: 1, c2: 3 }], hiddenRows: [1], hiddenCols: [2] }] });
  const [first] = page(wb).querySelectorAll('tr');
  expect(first.cells[0]).toMatchObject({ colSpan: 3, rowSpan: 1, textContent: 'Wide' });
});
