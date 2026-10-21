import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Fill Down (and Right, Up, Left) and Fill Series on grouped sheets wrote the active sheet's results over the same
// cells of the others: Feb's column filled down with Jan's 100 below Feb's own 5, and Feb's series counted on from
// Jan's start. Each sheet now fills from its own first cell, as Excel repeats a command on every grouped sheet.
function book() {
  const wb = new Workbook({ sheets: [{ name: 'Jan' }, { name: 'Feb' }] });
  const [a, b] = wb.sheets.map((s) => s.id);
  wb.setInput(a, 0, 0, '100'); wb.setInput(b, 0, 0, '5');
  wb.setInput(a, 0, 2, '=A1*2'); wb.setInput(b, 0, 2, '=A1+1');
  wb.groupSheets([b]);
  wb.clearHistory();
  const column = (id, c, n) => Array.from({ length: n }, (_, r) => wb.getValue(id, r, c));
  return { wb, a, b, column };
}

it('fills each grouped sheet down from its own first row, formulas and all, as one undo step', () => {
  const { wb, a, b, column } = book();
  wb.fillDirection(a, { r1: 0, c1: 0, r2: 2, c2: 2 }, 'down');
  expect(column(a, 0, 3)).toEqual([100, 100, 100]);
  expect(column(b, 0, 3)).toEqual([5, 5, 5]);
  expect(wb.getCell(b, 2, 2).f).toBe('A3+1');
  expect(column(b, 2, 3)).toEqual([6, 6, 6]);
  expect(wb.undoLabels()).toHaveLength(1);
  wb.undo();
  expect(column(b, 0, 3)).toEqual([5, null, null]);
});

it('starts each grouped sheet’s series from its own first cell', () => {
  const { wb, a, b, column } = book();
  wb.fillSeries(a, { r1: 0, c1: 0, r2: 3, c2: 0 }, { step: 2 });
  expect(column(a, 0, 4)).toEqual([100, 102, 104, 106]);
  expect(column(b, 0, 4)).toEqual([5, 7, 9, 11]);
});

it('fits each grouped sheet’s Series ▸ Trend to its own values', async () => {
  const { fillSeriesLines } = await import('../src/core/autofill-options.js');
  const { wb, a, b, column } = book();
  wb.setInput(a, 1, 0, '110'); wb.setInput(b, 1, 0, '6');
  wb.clearHistory();
  fillSeriesLines(wb, a, { r1: 0, c1: 0, r2: 3, c2: 0 }, { type: 'linear', trend: true, direction: 'down' });
  expect(column(a, 0, 4)).toEqual([100, 110, 120, 130]);
  expect(column(b, 0, 4)).toEqual([5, 6, 7, 8]);
  expect(wb.undoLabels()).toHaveLength(1);
});
