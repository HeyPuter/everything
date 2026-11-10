import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A chain that runs down the column through an address the formula works out — each row adding to
// the one below it with INDIRECT("A"&ROW()+1) or OFFSET(A1,1,0) — names no cell the deep-chain walk
// can follow, and the fallback settled the column only from the top down, the order a running total
// resolves in. Read from the top, past about 500 rows of INDIRECT or 2,000 of OFFSET, every cell
// answered #ERROR!, after seconds of retrying. The column is now settled from the bottom up when the
// chain does not run upwards.

const ROWS = 3000;

function book(formula) {
  const cells = {};
  for (let r = 0; r < ROWS - 1; r++) cells[`${r},0`] = { f: formula(r + 1) };
  cells[`${ROWS - 1},0`] = { v: 1 };
  const wb = new Workbook({ sheets: [{ name: 'Sheet1', rows: ROWS + 5, cols: 4, cells }] });
  return { wb, id: wb.activeSheetId };
}

describe('a chain that refers down the column through an address it works out', () => {
  it.each([
    ['INDIRECT', () => 'INDIRECT("A"&(ROW()+1))+1'],
    ['OFFSET', (r) => `OFFSET(A${r},1,0)+1`],
  ])('reads the same from the top, the middle and the bottom (%s)', (_, formula) => {
    const top = book(formula);
    expect(top.wb.getValue(top.id, 0, 0)).toBe(ROWS);
    expect(top.wb.getValue(top.id, ROWS / 2, 0)).toBe(ROWS / 2);

    const middle = book(formula);
    expect(middle.wb.getValue(middle.id, ROWS / 2, 0)).toBe(ROWS / 2);
    for (let r = 0; r < ROWS; r++) expect(middle.wb.getValue(middle.id, r, 0)).toBe(ROWS - r);

    const bottom = book(formula);
    expect(bottom.wb.getValue(bottom.id, ROWS - 2, 0)).toBe(2);
    expect(bottom.wb.getValue(bottom.id, 0, 0)).toBe(ROWS);
  }, 60000);

  it('reads right under a formula heading the column', () => {
    const { wb, id } = book(() => 'INDIRECT("A"&(ROW()+1))+1');
    wb.setCells(id, [{ r: 0, c: 0, cell: { v: null, f: 'LEN("head")' } }]);
    expect(wb.getValue(id, 1, 0)).toBe(ROWS - 1);
    expect(wb.getValue(id, 0, 0)).toBe(4);
  }, 60000);

  it('still settles a running total read from the bottom', () => {
    const cells = { '0,0': { v: 1 } };
    for (let r = 1; r < ROWS; r++) cells[`${r},0`] = { f: 'INDIRECT("A"&(ROW()-1))+1' };
    const wb = new Workbook({ sheets: [{ name: 'Sheet1', rows: ROWS + 5, cols: 4, cells }] });
    expect(wb.getValue(wb.activeSheetId, ROWS - 1, 0)).toBe(ROWS);
    expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe(1);
  }, 60000);
});
