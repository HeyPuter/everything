// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPrintRoot, printRange, PRINT_DEFAULTS } from '../src/ui/print.js';
import { printPreviewJob } from '../src/ui/print-preview.js';

// Whole columns set as the print area ($A:$C), or a selected column printed as the selection, printed every row the
// sheet's grid had reached: a sheet scrolled down to row 4,100 printed 86 pages for 20 rows of data, 85 of them empty
// gridlines, and the preview counted pages down to row 1,048,576. Excel prints such a block as far as the sheet's
// data reaches; so does the print now, and the preview counts the same pages.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, Array.from({ length: 20 }, (_, r) => ({ r, c: 0, cell: { v: r } })));
  wb.ensureSize(id, 4100, 30); // scrolled far down and across
  return { wb, id };
}
const columns = { r1: 0, c1: 0, r2: 1048575, c2: 2 };
const rows = { r1: 0, c1: 0, r2: 4, c2: 16383 };

it('prints whole columns down to the last row of the sheet\'s data, and whole rows across to its last column', () => {
  const { wb, id } = book();
  expect(wb.sheet(id).rows).toBeGreaterThanOrEqual(4100);
  expect(printRange(wb, id, { range: columns })).toEqual({ r1: 0, c1: 0, r2: 19, c2: 2 });
  expect(printRange(wb, id, { range: rows })).toEqual({ r1: 0, c1: 0, r2: 4, c2: 0 });
  // A block below the data keeps its first line, and an ordinary block is printed as it is given.
  expect(printRange(wb, id, { range: { r1: 30, c1: 0, r2: 1048575, c2: 0 } })).toEqual({ r1: 30, c1: 0, r2: 30, c2: 0 });
  expect(printRange(wb, id, { range: { r1: 0, c1: 0, r2: 99, c2: 2 } })).toEqual({ r1: 0, c1: 0, r2: 99, c2: 2 });
  const table = buildPrintRoot(wb, id, 'Doc', { area: 'selection', range: columns }).querySelector('.print-table');
  expect(table.querySelectorAll('tr')).toHaveLength(20);
});

it('counts one page for whole columns set as the print area, as the selection or as a print area', () => {
  const { wb, id } = book();
  expect(printPreviewJob(wb, id, { ...PRINT_DEFAULTS, area: 'selection' }, columns)).toHaveLength(1);
  wb.setPrintSettings(id, { areas: [columns] });
  expect(printPreviewJob(wb, id, { ...PRINT_DEFAULTS, area: 'printArea' })).toHaveLength(1);
  expect(buildPrintRoot(wb, id, 'Doc', { area: 'printArea' }).querySelector('.print-table').querySelectorAll('tr')).toHaveLength(20);
});
