// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { printPreviewLayout } from '../src/ui/print-preview.js';
import { PRINT_DEFAULTS } from '../src/ui/print.js';

// The whole sheet prints from its first used or painted cell to its last, widened over its charts and pictures, as the
// print bounds it. The preview took only the cells holding values: a chart beside a short table (the Expense
// tracker's Summary sheet) printed on a second page the preview never showed, its "Page 1 of 1" one page short.
const actual = { ...PRINT_DEFAULTS, fit: 'actual', title: false };

function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, Array.from({ length: 14 }, (_, r) => [0, 1, 2].map((c) => ({ r, c, cell: { v: r ? r * 10 + c : `Head ${c}` } }))).flat());
  return { wb, id };
}

it('takes in a chart beside the data, as the print does, and counts the page it falls on', () => {
  const { wb, id } = book();
  expect(printPreviewLayout(wb, id, actual).pages).toHaveLength(1);
  wb.addChart(id, { type: 'column', range: parseRange('A1:C14'), anchor: { r: 0, c: 4 }, dx: 0, dy: 0, w: 480, h: 400 }); // from E1
  let last = 4;
  for (let x = wb.colWidth(id, 4); x < 480; x += wb.colWidth(id, ++last));
  const { area, pages } = printPreviewLayout(wb, id, actual);
  expect(area).toMatchObject({ r1: 0, c1: 0, c2: last });
  expect(area.r2).toBeGreaterThan(13);
  // Letter, portrait, normal margins: the chart's columns run onto a second page across.
  expect(pages).toHaveLength(2);
  expect(pages[0].cols[0]).toBe(0);
  expect(pages[1].cols).toEqual([pages[0].cols[1] + 1, last]);
});

it('takes in filled and bordered cells past the values, and a merge reaching past them', () => {
  const { wb, id } = book();
  wb.setCells(id, [{ r: 30, c: 1, cell: { s: { bg: '#ffeeaa' } } }]);
  wb.mergeCells(id, { r1: 0, c1: 2, r2: 0, c2: 5 });
  const { area } = printPreviewLayout(wb, id, actual);
  expect(area.r2).toBe(30);
  expect(wb.mergeAt(id, 0, 5)).toBeTruthy();
  expect(area.c2).toBe(5);
});
