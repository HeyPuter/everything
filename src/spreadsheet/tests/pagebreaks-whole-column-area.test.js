// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { pageBreaks, pagesOf } from '../src/ui/pagebreaks.js';
import { pageLayoutMetrics } from '../src/ui/page-layout.js';

// A print area of whole columns ($A:$C) prints as far down as the sheet's data reaches. Page Break Preview and the Page
// Layout view took it to row 1,048,576: Page Break Preview laid out some twenty thousand pages on every edit (half a
// second a keystroke, and a page label for each), and Fit to one page shrank the sheet to the 10% floor for the
// million rows it counted.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, Array.from({ length: 20 }, (_, r) => ({ r, c: 0, cell: { v: r } })));
  return { wb, id };
}

it('lays the pages of a whole-column print area out as far as the data reaches', () => {
  const { wb, id } = book();
  wb.setPrintSettings(id, { areas: [{ r1: 0, c1: 0, r2: 1048575, c2: 2 }] });
  const breaks = pageBreaks(wb, id);
  expect(breaks.area).toEqual({ r1: 0, c1: 0, r2: 19, c2: 2 });
  expect(pagesOf(breaks)).toHaveLength(1);
  // An ordinary print area is laid out as it is given.
  wb.setPrintSettings(id, { areas: [{ r1: 0, c1: 0, r2: 99, c2: 2 }] });
  expect(pageBreaks(wb, id).area).toEqual({ r1: 0, c1: 0, r2: 99, c2: 2 });
});

it('fits a whole-column print area to one page at its own size', () => {
  const { wb, id } = book();
  wb.setPrintSettings(id, { areas: [{ r1: 0, c1: 0, r2: 1048575, c2: 2 }], fitToPage: true, fitWidth: 1, fitHeight: 1 });
  const metrics = pageLayoutMetrics(wb, id);
  expect(metrics.scale).toBe(1);
  expect(metrics.printed).toEqual({ a0: 0, a1: 0, d0: 0, d1: 0 });
});
