import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { colName } from '../src/core/cell.js';

// A chain too deep for the stack that names no cell the walk can follow (INDIRECT, OFFSET) is settled
// along its column and row while the cells further out on it are still being calculated. Settled from
// the bottom of the column or along the row, a cell beside the chain that reads one of those cells — a
// total under a chain read from its top, a copy of a running total's end beside it — was taken for a
// circle of references: the whole chain answered #CYCLE!, where it had answered #ERROR! before, and a
// SUM under a 3,000-row chain took two and a half minutes to say so. Only the cells holding the chain's
// own formula are settled that way now; the others are calculated once the chain has its answers.

const N = 3000;

function sheetOf(cells, rows, cols) {
  const wb = new Workbook({ sheets: [{ name: 'Sheet1', rows, cols, cells }] });
  return { wb, id: wb.activeSheetId };
}

describe('a deep chain with a cell beside it reading its far end', () => {
  it.each([
    ['a copy', 'A1*2', 2 * N],
    ['a total', `SUM(A1:A${N})`, N * (N + 1) / 2],
  ])('down a column, read from the top, with %s under it', (_, below, expected) => {
    const cells = {};
    for (let r = 0; r < N - 1; r++) cells[`${r},0`] = { f: 'INDIRECT("A"&(ROW()+1))+1' };
    cells[`${N - 1},0`] = { v: 1 };
    cells[`${N},0`] = { f: below };
    const { wb, id } = sheetOf(cells, N + 5, 4);
    const started = performance.now();
    expect(wb.getValue(id, 0, 0)).toBe(N);
    expect(wb.getValue(id, N, 0)).toBe(expected);
    expect(wb.getValue(id, N / 2, 0)).toBe(N / 2);
    expect(performance.now() - started).toBeLessThan(20000);
  }, 60000);

  it('along a row, read from its start, with a copy past its end', () => {
    const cells = {};
    for (let c = 0; c < N - 1; c++) cells[`0,${c}`] = { f: 'INDIRECT("RC[1]",FALSE)+1' };
    cells[`0,${N - 1}`] = { v: 1 };
    cells[`0,${N}`] = { f: 'A1*2' };
    const { wb, id } = sheetOf(cells, 10, N + 5);
    expect(wb.getValue(id, 0, 0)).toBe(N);
    expect(wb.getValue(id, 0, N)).toBe(2 * N);
  }, 60000);

  it('a running total across a row, read from its end, with copies of the end beside it', () => {
    const cells = { '0,1': { v: 1 } };
    for (let c = 2; c <= N; c++) cells[`0,${c}`] = { f: `OFFSET(${colName(c)}1,0,-1)+1` };
    cells['0,0'] = { f: `${colName(N)}1` };
    cells[`5,${N}`] = { f: `${colName(N)}1+1` };
    const { wb, id } = sheetOf(cells, 10, N + 5);
    expect(wb.getValue(id, 0, N)).toBe(N);
    expect(wb.getValue(id, 5, N)).toBe(N + 1);
    expect(wb.getValue(id, 0, 0)).toBe(N);
  }, 60000);
});
