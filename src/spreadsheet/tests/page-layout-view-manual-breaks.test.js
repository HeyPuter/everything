import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { pageLayoutMetrics, pageNumber } from '../src/ui/page-layout.js';
import { pageBreaks, pagesOf } from '../src/ui/pagebreaks.js';

function sheetOf(rows = 40, cols = 4) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) wb.setInput(id, r, c, String(r * cols + c));
  return { wb, id };
}
const band = (list, i) => { let k = 0; while (k + 1 < list.length && list[k + 1] <= i) k++; return k; };

describe('the Page Layout view', () => {
  it('starts a page at a manual page break, as the print does', () => {
    const { wb, id } = sheetOf();
    wb.setPageBreaks(id, { rows: [10], cols: [2] });
    const m = pageLayoutMetrics(wb, id);
    expect(m.rows.slice(0, 2)).toEqual([0, 10]);
    expect(m.cols.slice(0, 2)).toEqual([0, 2]);
    // The status bar's "Page: N of M" counts the pages the print makes.
    const printed = pagesOf(pageBreaks(wb, id));
    expect(printed).toHaveLength(4);
    expect(pageNumber(m, band(m.cols, 3), band(m.rows, 20))).toMatchObject({ number: 4, pages: 4 });
    expect(pageNumber(m, band(m.cols, 0), band(m.rows, 12))).toMatchObject({ number: 2, pages: 4 });
  });

  it('lets fitting to a number of pages override the breaks, as the print does', () => {
    const { wb, id } = sheetOf();
    wb.setPageBreaks(id, { rows: [10], cols: [2] });
    wb.setPrintSettings(id, { ...wb.sheet(id).printSettings, fitToPage: true, fitWidth: 1, fitHeight: 1 });
    const m = pageLayoutMetrics(wb, id);
    expect(m.rows[1] ?? Infinity).toBeGreaterThan(39);
    expect(m.cols[1] ?? Infinity).toBeGreaterThan(3);
    expect(pagesOf(pageBreaks(wb, id))).toHaveLength(1);
  });
});
