// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { pageLayoutMetrics, pageNumber } from '../src/ui/page-layout.js';
import { pageBreaks, pagesOf } from '../src/ui/pagebreaks.js';
import { printPreviewLayout } from '../src/ui/print-preview.js';
import { savedPrintPrefs, sheetPrintPrefs } from '../src/ui/print.js';

// Rows (and columns) to repeat print again on every page after the first, taking room from the cells there. Page
// Layout view, Page Break Preview and the status bar's "Page: N of M" laid the pages out without them: with rows 1:10
// repeated on 300 rows they said 7 pages where the print (and the Print dialog) made 9, and every break after the
// first fell rows away from where the paper turned.
function sheetOf(rows, cols, settings) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) entries.push({ r, c, cell: { v: r * cols + c } });
  wb.setCells(id, entries);
  wb.setPrintSettings(id, { ...wb.sheet(id).printSettings, ...settings });
  return { wb, id };
}
// The print's pages, as the Print dialog lays them out (each page's own first row and column).
function printed(wb, id) {
  const prefs = { ...savedPrintPrefs(), ...sheetPrintPrefs(wb.sheet(id)) };
  const pages = printPreviewLayout(wb, id, prefs).pages;
  return { count: pages.length, rows: [...new Set(pages.map((p) => p.rows[0]))], cols: [...new Set(pages.map((p) => p.cols[0]))] };
}

it('breaks pages where the print does when rows repeat at the top', () => {
  const { wb, id } = sheetOf(300, 3, { titleRows: [0, 9] });
  const print = printed(wb, id);
  const pages = pagesOf(pageBreaks(wb, id));
  expect(pages).toHaveLength(print.count);
  expect(pages.map((p) => p.r1)).toEqual(print.rows);
  const m = pageLayoutMetrics(wb, id);
  expect(m.rows.slice(0, print.rows.length)).toEqual(print.rows);
  expect(pageNumber(m, 0, 0).pages).toBe(print.count);
});

it('breaks pages where the print does when columns repeat at the left', () => {
  const { wb, id } = sheetOf(20, 40, { titleCols: [0, 1] });
  const print = printed(wb, id);
  const pages = pagesOf(pageBreaks(wb, id));
  expect(pages).toHaveLength(print.count);
  expect([...new Set(pages.map((p) => p.c1))]).toEqual(print.cols);
  expect(pageLayoutMetrics(wb, id).cols.slice(0, print.cols.length)).toEqual(print.cols);
});

it('takes the room of repeated rows above a print area from its first page too, and keeps manual breaks', () => {
  const { wb, id } = sheetOf(300, 3, { titleRows: [0, 1], areas: [{ r1: 50, c1: 0, r2: 250, c2: 2 }], rowBreaks: [120] });
  const print = printed(wb, id);
  const breaks = pageBreaks(wb, id);
  expect(pagesOf(breaks).map((p) => p.r1)).toEqual(print.rows);
  expect(breaks.rowBreaks.find((b) => b.at === 120)?.manual).toBe(true);
});
