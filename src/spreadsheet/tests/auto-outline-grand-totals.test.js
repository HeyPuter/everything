import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { autoOutline, autoOutlineGroups } from '../src/core/auto-outline.js';

// Auto Outline found the groups under each subtotal, but not the outer group of a grand total that adds the
// subtotals up (=SUM(B5,B9), =B5+B9) or totals the detail around them (=SUM(B2:B4,B6:B8)): the references
// leave a gap at each subtotal row, so the report got no level that shows only the subtotals. Excel outlines
// such a total over everything above it.
function report(grand) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['Item', 'a', 'b', 'c', 'East total', 'd', 'e', 'f', 'West total', 'Grand total'].forEach((v, r) => wb.setInput(id, r, 0, v));
  [1, 2, 3].forEach((v, i) => wb.setInput(id, 1 + i, 1, String(v)));
  wb.setInput(id, 4, 1, '=SUM(B2:B4)');
  [4, 5, 6].forEach((v, i) => wb.setInput(id, 5 + i, 1, String(v)));
  wb.setInput(id, 8, 1, '=SUM(B6:B8)');
  if (grand) wb.setInput(id, 9, 1, grand);
  return { wb, id };
}

it.each(['=SUM(B5,B9)', '=B5+B9', '=SUM(B2:B4,B6:B8)', '=SUBTOTAL(9,B2:B9)'])('outlines the grand total %s over its subtotals', (grand) => {
  const { wb, id } = report(grand);
  expect(autoOutlineGroups(wb, id).rows).toEqual([{ from: 1, to: 8 }, { from: 1, to: 3 }, { from: 5, to: 7 }]);
  expect(autoOutline(wb, id)).toBe(3);
  expect(wb.outlineGroups(id, 'row').map((g) => [g.from, g.to, g.level])).toEqual(expect.arrayContaining([[1, 8, 1], [1, 3, 2], [5, 7, 2]]));
});

it('makes no outer group of a total that leaves out a subtotal, or of a product', () => {
  for (const grand of ['=B5+B7', '=B5*B9']) { const { wb, id } = report(grand); expect(autoOutlineGroups(wb, id).rows).toEqual([{ from: 1, to: 3 }, { from: 5, to: 7 }]); }
});

it('makes no groups of a running balance that adds the cell above', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 1, '10'); wb.setInput(id, 0, 2, '=B1');
  for (let r = 1; r < 6; r++) { wb.setInput(id, r, 1, String(r)); wb.setInput(id, r, 2, `=C${r}+B${r + 1}`); }
  expect(autoOutlineGroups(wb, id)).toEqual({ rows: [], cols: [] });
});

it('outlines a yearly total across quarterly subtotals', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['1', '2', '3', '=SUM(A1:C1)', '4', '5', '6', '=SUM(E1:G1)', '=D1+H1'].forEach((v, c) => wb.setInput(id, 0, c, v));
  expect(autoOutlineGroups(wb, id).cols).toEqual([{ from: 0, to: 7 }, { from: 0, to: 2 }, { from: 4, to: 6 }]);
});
