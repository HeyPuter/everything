// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { sheetToHtml } from '../src/core/io.js';

const width = (tr) => [...tr.cells].reduce((n, td) => n + td.colSpan, 0);

// Saving as a web page wrote every row with content as wide as the sheet's farthest column, reading
// and styling each empty cell: one stray cell in column DXX of a 10,000-row list made 270 MB of markup
// and took a tab nearly 20 seconds and 2 GB. Rows are now read only as far as anything can show in
// them; the empty rest is written bare, a long run of it as one spanning cell, so the table keeps its shape.
it('writes a long sheet with one far-off cell without a cell per empty coordinate', () => {
  const entries = Array.from({ length: 4000 }, (_, r) => ({ r, c: 0, cell: { v: r } }));
  entries.push({ r: 0, c: 3000, cell: { v: 'far' } });
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, entries);
  const html = sheetToHtml(wb, wb.activeSheetId);
  expect(html.length).toBeLessThan(1_000_000);
  const rows = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('tr')];
  expect(rows).toHaveLength(4000);
  expect(rows[0].cells[rows[0].cells.length - 1].textContent).toBe('far');
  expect(width(rows[0])).toBe(3001);
  expect([...rows[1].cells].map((td) => [td.textContent, td.colSpan])).toEqual([['1', 1], ['', 1000], ['', 1000], ['', 1000]]);
  expect(width(rows[3999])).toBe(3001);
});

it('still writes the cells a column style, a rule or a merged block shows in', () => {
  const wb = new Workbook({ sheets: [{ name: 'S', cells: { '0,0': { v: 'a' }, '1,0': { v: 'b' }, '2,0': { v: 'c' }, '0,9': { v: 'far' } },
    merges: [{ r1: 2, c1: 1, r2: 2, c2: 4 }] }] });
  const id = wb.activeSheetId;
  wb.sheet(id).colStyles.set(2, { bg: '#ffeeaa' });
  wb.addRule(id, { range: { r1: 1, c1: 0, r2: 1, c2: 6 }, type: 'notEmpty', style: { bg: '#ccddff' } });
  const rows = [...new DOMParser().parseFromString(sheetToHtml(wb, id), 'text/html').querySelectorAll('tr')];
  // A short empty run keeps a cell per column (and its gridlines), as before.
  rows.forEach((tr) => expect(width(tr)).toBe(10));
  expect(rows[1].cells).toHaveLength(10);
  expect(rows[2].cells[1].colSpan).toBe(4);
  expect(rows[1].cells[0].getAttribute('style') || '').toMatch(/background/);
  expect(rows[1].cells[2].getAttribute('style') || '').toMatch(/background/);
});
