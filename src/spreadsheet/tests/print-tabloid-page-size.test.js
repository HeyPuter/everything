// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildPrintRoot, PAPER_SIZES, printableWidth } from '../src/ui/print.js';
import { Workbook } from '../src/core/workbook.js';

// Tabloid was written as `@page { size: 11in 17in landscape }`. The grammar of `size` lets an
// orientation follow a page-size keyword, not two lengths, so the declaration was invalid and dropped
// whole: the browser printed on its default paper while the sheet had been zoomed to fit a 17-inch
// page, and a wide sheet that "fit" was cut on the right. CSS names the 11 × 17 inch sheet `ledger`.
const pageRule = (opts) => {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, 'x');
  return buildPrintRoot(wb, id, 'Doc', opts).querySelector('style').textContent.split('\n')[0];
};

describe('Tabloid paper', () => {
  it('names the page size with the ledger keyword, so the orientation applies', () => {
    expect(pageRule({ paper: 'tabloid', orientation: 'landscape' })).toBe('@page { size: ledger landscape; margin: 12mm; }');
    expect(pageRule({ paper: 'tabloid', orientation: 'portrait', margins: 'narrow' })).toBe('@page { size: ledger portrait; margin: 6mm; }');
  });

  it('keeps the width the sheet is fitted to in step with the page printed', () => {
    // 17 inches across less two normal margins, the same page the @page rule now asks for.
    expect(printableWidth({ paper: 'tabloid', orientation: 'landscape' })).toBeCloseTo(17 * 96 - 2 * 12 * (96 / 25.4), 1);
    expect(printableWidth({ paper: 'tabloid', orientation: 'portrait' })).toBeCloseTo(11 * 96 - 2 * 12 * (96 / 25.4), 1);
  });

  it('gives every paper a keyword an orientation can follow, or two lengths with no orientation after them', () => {
    for (const [key, , css] of PAPER_SIZES) {
      if (css) expect(css, css).toMatch(/^[A-Za-z0-9-]+$/);
      else expect(pageRule({ paper: key, orientation: 'landscape' }), key).toMatch(/^@page \{ size: [\d.]+in [\d.]+in; /);
    }
    expect(pageRule({ paper: 'a3', orientation: 'landscape' })).toBe('@page { size: A3 landscape; margin: 12mm; }');
  });
});
