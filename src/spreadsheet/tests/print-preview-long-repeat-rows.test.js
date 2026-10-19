// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { printPreviewLayout } from '../src/ui/print-preview.js';
import { PRINT_DEFAULTS } from '../src/ui/print.js';

// The print dialog lays the preview out again on every key typed in it. With rows to repeat at the top, each page's
// rows were found by reading every row of the sheet, page after page: a list of 150,000 rows took five seconds a keystroke.
it('lays out a long sheet with rows to repeat in the time a keystroke allows, page for page as before', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const rows = 150000;
  wb.setCells(id, Array.from({ length: rows }, (_, r) => ({ r, c: 0, cell: { v: r ? r : 'Head' } })));
  wb.setRowHeight?.(id, 5, 60);
  const prefs = { ...PRINT_DEFAULTS, fit: 'actual', title: false, titleRows: [0, 1] };
  const t0 = performance.now();
  const { pages } = printPreviewLayout(wb, id, prefs);
  expect(performance.now() - t0).toBeLessThan(1000);
  // Every row is printed once, in order, and every page after the first repeats rows 1 and 2.
  expect(pages[0].rows[0]).toBe(0);
  expect(pages.at(-1).rows[1]).toBe(rows - 1);
  for (let i = 1; i < pages.length; i++) {
    expect(pages[i].rows[0]).toBe(pages[i - 1].rows[1] + 1);
    expect(pages[i].repeatRows).toEqual([0, 1]);
  }
});
