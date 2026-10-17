import { describe, it, expect } from 'vitest';
import { summarize } from '../src/ui/statusbar.js';
import { Workbook } from '../src/core/workbook.js';
import { parseRange, parseCellRef } from '../src/core/cell.js';

describe('selection summary', () => {
  it('sums and counts only what is inside the range', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    const set = (a1, v) => { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, v); };
    set('A1', '10'); set('A2', '20'); set('A3', 'text'); set('A4', '=A1/0'); set('B1', '5');
    const s = summarize(wb, id, parseRange('A1:A4'));
    expect(s).toEqual({ sum: 30, count: 4, nums: 2, avg: 15, min: 10, max: 20 });
    expect(summarize(wb, id, parseRange('C1:C5'))).toEqual({ sum: 0, count: 0, nums: 0, avg: null, min: null, max: null });
  });

  it('gives up when the range and the sheet are both enormous', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setCells(id, Array.from({ length: 200001 }, (_, i) => ({ r: i % 10000, c: Math.floor(i / 10000), cell: { v: 1 } })));
    expect(summarize(wb, id, { r1: 0, c1: 0, r2: 9999, c2: 25 })).toBeNull();
  });

  it('summarizes a whole-sheet selection by walking the cells the sheet holds, not its area', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setInput(id, 0, 0, '10');
    wb.setInput(id, 500, 20, '5');
    wb.setInput(id, 2, 1, '=SEQUENCE(3)');
    expect(summarize(wb, id, { r1: 0, c1: 0, r2: 19999, c2: 25 })).toMatchObject({ sum: 21, count: 5, nums: 5, min: 1, max: 10 });
  });
});

describe('status bar totals under a filter', () => {
  it('count only the rows the filter shows, as the sheet does', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Amount');
    for (const [r, v] of [[1, '10'], [2, '20'], [3, '30'], [4, '40']]) wb.setInput(id, r, 0, v);
    wb.setInput(id, 5, 1, '=SEQUENCE(4)');
    wb.setFilterRange(id, { r1: 0, c1: 0, r2: 4, c2: 0 });
    wb.setFilterCriteria(id, 0, { values: ['10', '30'] });
    expect([...wb.sheet(id).filterHidden].sort()).toEqual([2, 4]);
    const s = summarize(wb, id, parseRange('A2:A5'));
    expect(s).toMatchObject({ sum: 40, count: 2, nums: 2, avg: 20, min: 10, max: 30 });
    // Without the filter every row counts again.
    wb.clearFilter(id);
    expect(summarize(wb, id, parseRange('A2:A5'))).toMatchObject({ sum: 100, count: 4 });
  });
});
