import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { sheetToHtml } from '../src/core/io.js';

// Center Across Selection, Distributed, Justify and Fill are drawn on the grid, in print and in the PDF against
// the side they set text at, but a sheet saved as a web page wrote no alignment for them, so a title centred across
// its columns showed at the left of its cell.
it.each([['centerContinuous', 'center'], ['distributed', 'center'], ['justify', 'left'], ['fill', 'left']])('writes %s as text-align:%s', (align, css) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Quarterly report');
  wb.setInput(id, 0, 1, '42');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, { align });
  const html = sheetToHtml(wb, id);
  expect(html).toMatch(new RegExp(`<td[^>]*style="[^"]*text-align:${css}[^"]*"[^>]*>Quarterly report</td>`));
  expect(html).toMatch(new RegExp(`<td[^>]*style="[^"]*text-align:${css}[^"]*"[^>]*>42</td>`));
});
