import { expect, it } from 'vitest';
import { FUNCTIONS } from '../src/core/formula/functions.js';
import { Workbook } from '../src/core/workbook.js';

// COUNTIF(B:B,"<>"&B2), COUNTIF(B:B,"a*") or SUMIF(B:B,">m",A:A) filled down a column compared every cell of the
// range with the criterion for every row: no index answered a criterion other than "=" a label or a number, and
// 3,000 rows took 3-12 s to calculate. The cells a text criterion matches are now found once and kept for the
// formulas asking the same of the same values; the answers are the ones a scan gives.
const ROWS = 1500;
const shared = () => ({
  A: { range: true, values: Array.from({ length: ROWS }, (_, r) => [r % 11 === 3 ? String(r % 7) : r % 17 === 5 ? { error: '#N/A' } : r % 97]) },
  B: { range: true, values: Array.from({ length: ROWS }, (_, r) => [r % 19 === 2 ? null : r % 23 === 4 ? '' : r % 29 === 6 ? true
    : r % 31 === 7 ? '12' : r % 2 ? `k${r % 13}` : `Kx${r % 13}`]) },
  // Read to fewer rows than A and B, as a column of another sheet with less data is.
  S: { range: true, values: Array.from({ length: ROWS - 400 }, (_, r) => [`k${r % 5}`]), ref: { kind: 'cols', r1: 0, r2: 1048575, c1: 0, c2: 0 } },
  T: { range: true, values: Array.from({ length: ROWS }, (_, r) => [r % 3]), ref: { kind: 'cols', r1: 0, r2: 1048575, c1: 1, c2: 1 } },
});

function both(name, args) {
  const s = shared();
  const indexed = [1, 2, 3].map(() => FUNCTIONS[name].fn(args(s)));
  const scanned = FUNCTIONS[name].fn(args(shared()));
  expect(indexed[1], `${name} ${JSON.stringify(args({ A: 'A', B: 'B', S: 'S', T: 'T' }))}`).toEqual(scanned);
  expect(indexed[2]).toEqual(scanned);
  return scanned;
}

it('give the answers a scan gives', () => {
  for (const c of ['<>k5', '<>', 'k1*', '*x1?', '<>k*', '>k3', '<=Kx', '<>12', '<>TRUE', '=TRUE', '>=', '<>#N/A', '#N/A', '?', '*']) {
    both('COUNTIF', (s) => [s.B, c]);
    both('COUNTIF', (s) => [s.A, c]);
    both('SUMIF', (s) => [s.B, c, s.A]);
    both('AVERAGEIF', (s) => [s.B, c, s.A]);
    both('COUNTIFS', (s) => [s.B, c]);
    both('COUNTIFS', (s) => [s.B, c, s.A, '>40']);
    both('COUNTIFS', (s) => [s.A, '<50', s.B, c]);
    both('SUMIFS', (s) => [s.A, s.B, c]);
    both('MAXIFS', (s) => [s.A, s.B, c, s.A, '<>90']);
    both('MINIFS', (s) => [s.A, s.B, c]);
    both('AVERAGEIFS', (s) => [s.A, s.B, c]);
    // Whole columns read to different depths: a criterion matching a blank reaches past the shorter one.
    both('COUNTIFS', (s) => [s.S, c, s.T, '<>1']);
    both('COUNTIFS', (s) => [s.T, '<>1', s.S, c]);
    both('SUMIFS', (s) => [s.T, s.S, c]);
  }
  expect(both('COUNTIF', (s) => [s.B, '<>k5'])).toBe(ROWS - shared().B.values.filter(([v]) => v === 'k5').length);
});

it('tests the cells of a range once for each criterion', () => {
  let reads = 0;
  const counted = (values) => ({ range: true, values: values.map((row) => new Proxy(row, {
    get: (t, k) => { if (typeof k === 'string' && /^\d+$/.test(k)) reads++; return t[k]; },
  })) });
  const labels = counted(Array.from({ length: 2000 }, (_, r) => [`k${r % 13}`]));
  const amounts = { range: true, values: Array.from({ length: 2000 }, (_, r) => [r]) };
  const later = (name, args) => {
    FUNCTIONS[name].fn(args); FUNCTIONS[name].fn(args);
    reads = 0;
    const answer = FUNCTIONS[name].fn(args);
    return [answer, reads];
  };
  expect(later('COUNTIF', [labels, '<>k5'])).toEqual([1846, 0]);
  expect(later('COUNTIF', [labels, 'k1*'])).toEqual([[...Array(2000).keys()].filter((r) => String(r % 13).startsWith('1')).length, 0]);
  expect(later('SUMIF', [labels, '>k3', amounts])[1]).toBe(0);
  expect(later('COUNTIFS', [labels, '*2'])[1]).toBe(0);
});

it('keeps a column of COUNTIF "<>" quick over a long list', { timeout: 60000 }, () => {
  const n = 3000;
  const cells = {};
  for (let r = 0; r < n; r++) {
    cells[`${r},0`] = { v: r % 97 };
    cells[`${r},1`] = { v: `k${r % 13}` };
    cells[`${r},2`] = { f: `COUNTIF(B:B,"<>"&B${r + 1})` };
    cells[`${r},3`] = { f: `SUMIF(B:B,"k1*",A:A)` };
    cells[`${r},4`] = { f: `A${r + 1}*2` };
  }
  const wb = new Workbook({ sheets: [{ name: 'S', rows: n, cols: 5, cells }] });
  const id = wb.activeSheetId;
  const column = (c) => { const t = performance.now(); for (let r = 0; r < n; r++) wb.getValue(id, r, c); return performance.now() - t; };
  column(4);
  wb.recalculate();
  const plain = column(4);
  const counts = column(2);
  const sums = column(3);
  expect(wb.getValue(id, 0, 2)).toBe(1048576 - Math.ceil(n / 13));
  expect(wb.getValue(id, 0, 3)).toBe([...Array(n).keys()].filter((r) => String(r % 13).startsWith('1')).reduce((a, r) => a + r % 97, 0));
  // Each was over a hundred times the arithmetic column.
  expect(counts, `COUNTIF column ${counts.toFixed(0)} ms, arithmetic column ${plain.toFixed(0)} ms`).toBeLessThan(plain * 20 + 300);
  expect(sums, `SUMIF column ${sums.toFixed(0)} ms, arithmetic column ${plain.toFixed(0)} ms`).toBeLessThan(plain * 20 + 300);
});
