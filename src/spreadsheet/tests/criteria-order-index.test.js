import { describe, it, expect } from 'vitest';
import { FUNCTIONS } from '../src/core/formula/functions.js';
import { Workbook } from '../src/core/workbook.js';

// COUNTIF(A:A,">"&A2), or SUMIFS(B:B,A:A,">="&A2,A:A,"<"&A2+7) for a week's total, filled down a column tested every
// cell of the range for every row: ten thousand rows took seconds to calculate whenever a total read them. From
// its second use a criterion comparing with a number finds the matching numbers as one run of the range in
// ascending order; the answers are the ones a scan gives, 15-digit equality, text and errors included.
const ROWS = 3000;
const shared = () => ({
  A: { range: true, values: Array.from({ length: ROWS }, (_, r) => [
    r % 13 === 4 ? String(r % 50) // numeric text is no number to compare with
      : r % 17 === 6 ? { error: '#N/A' }
        : r % 19 === 7 ? true
          : r % 23 === 8 ? null
            : r % 29 === 9 ? 0.1 + 0.2 // equal to 0.3 at 15 digits
              : r % 31 === 10 ? -(r % 7)
                : r % 37 === 11 ? 1e-300
                  : (r * 7919) % 500 / 10]) },
  B: { range: true, values: Array.from({ length: ROWS }, (_, r) => [r % 41 === 3 ? 'x' : (r % 97) / 10]) },
});

/** The same call on shared values arrays (indexed from the second use) and on fresh ones (scanned). */
function both(name, args) {
  const s = shared();
  const indexed = [1, 2, 3].map(() => FUNCTIONS[name].fn(args(s)));
  const scanned = FUNCTIONS[name].fn(args(shared()));
  expect(indexed[1], `${name} ${JSON.stringify(args({ A: 'A', B: 'B' }))}`).toEqual(scanned);
  expect(indexed[2]).toEqual(scanned);
  return scanned;
}

describe('criteria comparing with a number', () => {
  it('give the answers a scan gives', () => {
    for (const n of [0, 0.3, 1e-300, -3, 12.5, 49.9, 50, 1000, -1000]) {
      for (const op of ['<', '<=', '>', '>=']) {
        const c = `${op}${n}`;
        both('COUNTIF', (s) => [s.A, c]);
        both('SUMIF', (s) => [s.A, c, s.B]);
        both('AVERAGEIF', (s) => [s.A, c, s.B]);
        both('COUNTIFS', (s) => [s.A, c, s.A, '<30']);
        both('COUNTIFS', (s) => [s.A, c, s.B, '>2']);
        both('SUMIFS', (s) => [s.B, s.A, c, s.A, `<${n + 5}`]);
        both('AVERAGEIFS', (s) => [s.B, s.A, c, s.A, `<=${n + 1}`]);
        both('MAXIFS', (s) => [s.B, s.A, c, s.A, `<${n + 2}`]);
        both('MINIFS', (s) => [s.A, s.A, c]);
      }
    }
    expect(both('COUNTIF', (s) => [s.A, '>=0.3'])).toBeGreaterThan(both('COUNTIF', (s) => [s.A, '>0.3']));
  });

  it('count a number equal at 15 digits as neither above nor below, and never text or a logical value', () => {
    const values = { range: true, values: [[5], ['6'], [5.000000000000001], [0.1 + 0.2], [0.3], [true], [4.999], [null], [{ error: '#N/A' }]] };
    for (let i = 0; i < 3; i++) {
      expect(FUNCTIONS.COUNTIF.fn([values, '>5'])).toBe(0);
      expect(FUNCTIONS.COUNTIF.fn([values, '>=5'])).toBe(2);
      expect(FUNCTIONS.COUNTIF.fn([values, '<5'])).toBe(3);
      expect(FUNCTIONS.COUNTIF.fn([values, '<=0.3'])).toBe(2);
      expect(FUNCTIONS.COUNTIF.fn([values, '<0.3'])).toBe(0);
    }
  });

  it('keep a column of rolling totals over a large sheet quick', { timeout: 60000 }, () => {
    const n = 10000;
    const cells = {};
    for (let r = 0; r < n; r++) {
      cells[`${r},0`] = { v: 45000 + (r % 365) };
      cells[`${r},1`] = { v: r % 10 };
      cells[`${r},2`] = { f: `SUMIFS(B:B,A:A,">="&A${r + 1},A:A,"<"&A${r + 1}+7)` };
      cells[`${r},3`] = { f: `COUNTIF(A:A,">"&A${r + 1})` };
      cells[`${r},4`] = { f: `A${r + 1}*2` };
    }
    const wb = new Workbook({ sheets: [{ name: 'S', rows: n, cols: 5, cells }] });
    const id = wb.activeSheetId;
    const column = (c) => { const t = performance.now(); for (let r = 0; r < n; r++) wb.getValue(id, r, c); return performance.now() - t; };
    column(4); // warm the formula path
    wb.recalculate();
    const plain = column(4);
    const sums = column(2);
    const counts = column(3);
    expect(wb.getValue(id, 0, 2)).toBe(Array.from({ length: n }, (_, r) => r).filter((r) => r % 365 < 7).reduce((t, r) => t + r % 10, 0));
    expect(wb.getValue(id, 364, 3)).toBe(0);
    // Testing every row for each made these columns hundreds of times the arithmetic one.
    expect(sums, `SUMIFS column ${sums.toFixed(0)} ms, arithmetic column ${plain.toFixed(0)} ms`).toBeLessThan(plain * 30 + 300);
    expect(counts, `COUNTIF column ${counts.toFixed(0)} ms, arithmetic column ${plain.toFixed(0)} ms`).toBeLessThan(plain * 30 + 300);
  });
});
