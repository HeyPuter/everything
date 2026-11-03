import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { colName } from '../src/core/cell.js';

// A running total across a row written with OFFSET or INDIRECT — each column adding to the one
// before it, =OFFSET(B1,0,-1)+1 filled right, as a total across the days of a few years — names no
// cell the deep-chain walk can follow, and the fallback for a chain too deep for the stack settled
// only the cell's own column. Past about 1,000 columns, read from its right end (or, a chain running
// the other way, from its left), the row answered #ERROR!. The cell's own row is now settled too,
// from either end.

const COLS = 3000;

function book(formula, first = 0) {
  const cells = {};
  for (let c = 0; c < COLS; c++) cells[`0,${c}`] = c === first ? { v: 1 } : { f: formula(c) };
  const wb = new Workbook({ sheets: [{ name: 'Sheet1', rows: 10, cols: COLS + 5, cells }] });
  return { wb, id: wb.activeSheetId };
}

describe('a chain along a row through an address it works out', () => {
  it.each([
    ['OFFSET', (c) => `OFFSET(${colName(c)}1,0,-1)+1`],
    ['INDIRECT', () => 'INDIRECT("RC[-1]",FALSE)+1'],
  ])('reads the same from either end when it refers back (%s)', (_, formula) => {
    const right = book(formula);
    expect(right.wb.getValue(right.id, 0, COLS - 1)).toBe(COLS);
    expect(right.wb.getValue(right.id, 0, 0)).toBe(1);

    const middle = book(formula);
    expect(middle.wb.getValue(middle.id, 0, COLS / 2)).toBe(COLS / 2 + 1);
    expect(middle.wb.getValue(middle.id, 0, COLS - 1)).toBe(COLS);
  }, 60000);

  it('reads the same from either end when it refers on', () => {
    const { wb, id } = book(() => 'INDIRECT("RC[1]",FALSE)+1', COLS - 1);
    expect(wb.getValue(id, 0, 0)).toBe(COLS);
    expect(wb.getValue(id, 0, COLS - 2)).toBe(2);
  }, 60000);
});
