import { describe, it, expect } from 'vitest';
import { FUNCTIONS } from '../src/core/formula/functions.js';
import { Workbook } from '../src/core/workbook.js';

// COUNTIF(B:B,B2) filled down a column of numbers, the usual way to find repeated IDs, scanned the whole column
// for every row: twenty thousand rows took seconds and a hundred thousand minutes. From its second use with a
// numeric criterion a range's values are indexed by number, as they already were by text; the answers are the
// ones a scan gives, numeric text and 15-digit equality included.
const ROWS = 3000;
const shared = () => ({
  A: { range: true, values: Array.from({ length: ROWS }, (_, r) => [
    r % 13 === 4 ? String(r % 50) // numeric text counts as its number
      : r % 17 === 6 ? { error: '#N/A' }
        : r % 19 === 7 ? true
          : r % 23 === 8 ? null
            : r % 29 === 9 ? 0.1 + 0.2 // equal to 0.3 at 15 digits
              : r % 50]) },
  B: { range: true, values: Array.from({ length: ROWS }, (_, r) => [r % 97]) },
});

/** The same call on a shared (indexed from the second use) and on fresh (scanned) values arrays. */
function both(name, args) {
  const s = shared();
  const indexed = [1, 2, 3].map(() => FUNCTIONS[name].fn(args(s)));
  const scanned = FUNCTIONS[name].fn(args(shared()));
  expect(indexed[1]).toEqual(scanned);
  expect(indexed[2]).toEqual(scanned);
  return scanned;
}

describe('indexed numeric criteria', () => {
  it('give the answers a scan gives', () => {
    for (const n of [0, 7, 12, 49, 50, 0.3, -1]) {
      both('COUNTIF', (s) => [s.A, n]);
      both('COUNTIF', (s) => [s.A, String(n)]);
      both('COUNTIF', (s) => [s.A, `=${n}`]);
      both('SUMIF', (s) => [s.A, n, s.B]);
      both('AVERAGEIF', (s) => [s.A, `=${n}`, s.B]);
      both('SUMIFS', (s) => [s.B, s.A, n, s.B, '>10']);
      both('COUNTIFS', (s) => [s.B, '>5', s.A, n]);
      both('MAXIFS', (s) => [s.B, s.A, n]);
    }
    expect(both('COUNTIF', (s) => [s.A, 12])).toBeGreaterThan(0);
    expect(both('COUNTIF', (s) => [s.A, 0.3])).toBeGreaterThan(0);
    expect(both('COUNTIF', (s) => [s.A, 1])).toBeGreaterThan(0);
  });

  it('count numeric text, and a number equal at 15 digits, as the scan does', () => {
    const values = { range: true, values: [[5], ['5'], [' 5 '], [5.000000000000001], [0.1 + 0.2], [0.3], [true], ['five'], [null]] };
    for (let i = 0; i < 3; i++) {
      expect(FUNCTIONS.COUNTIF.fn([values, 5])).toBe(4);
      expect(FUNCTIONS.COUNTIF.fn([values, '=5'])).toBe(4);
      expect(FUNCTIONS.COUNTIF.fn([values, 0.3])).toBe(2);
      expect(FUNCTIONS.COUNTIF.fn([values, 1])).toBe(0);
    }
  });

  it('keep a column of COUNTIFs over a large sheet about as quick as plain arithmetic', { timeout: 60000 }, () => {
    const n = 20000;
    const cells = {};
    for (let r = 0; r < n; r++) {
      cells[`${r},0`] = { v: r % 500 };
      cells[`${r},1`] = { f: `COUNTIF($A$1:$A$${n},A${r + 1})` };
      cells[`${r},2`] = { f: `A${r + 1}*2` };
    }
    const wb = new Workbook({ sheets: [{ name: 'S', rows: n, cols: 3, cells }] });
    const id = wb.activeSheetId;
    const column = (c) => { const t = performance.now(); for (let r = 0; r < n; r++) wb.getValue(id, r, c); return performance.now() - t; };
    column(2); // warm the formula path
    wb.recalculate();
    const plain = column(2);
    const counts = column(1);
    expect(wb.getValue(id, 0, 1)).toBe(40);
    expect(wb.getValue(id, n - 1, 1)).toBe(40);
    // Scanning every row for each made the column a hundred times the arithmetic one or more.
    expect(counts, `COUNTIF column ${counts.toFixed(0)} ms, arithmetic column ${plain.toFixed(0)} ms`).toBeLessThan(plain * 30 + 200);
  });
});
