import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { sheetsToPdf } from '../src/core/sheet-pdf.js';
import { paperInches } from '../src/ui/page-layout.js';

// The PDF a copy is sent as knew six paper codes, so a sheet set up for A5, B4, B5, Executive, Statement or Folio
// (as workbooks from Excel are) was laid out on Letter pages. Its pages are now the paper the Page Layout view
// draws and the print uses, turned for landscape.
const mediaBox = (paperSize, orientation = 'portrait') => {
  const wb = new Workbook({ sheets: [{ name: 'Report', cells: { '0,0': { v: 'x' } }, printSettings: { paperSize, orientation } }] });
  const s = String.fromCharCode(...sheetsToPdf(wb, [{ sheetId: wb.activeSheetId }]));
  return /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(s).slice(1).map(Number);
};

it.each([1, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14])('lays a sheet set up for paper %i on that paper', (code) => {
  for (const orientation of ['portrait', 'landscape']) {
    const [w, h] = paperInches({ paperSize: code, orientation });
    const [bw, bh] = mediaBox(code, orientation);
    expect(Math.abs(bw - w * 72)).toBeLessThan(1);
    expect(Math.abs(bh - h * 72)).toBeLessThan(1);
  }
});
