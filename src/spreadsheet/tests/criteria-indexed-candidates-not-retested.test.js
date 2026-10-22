import { expect, it } from 'vitest';
import { FUNCTIONS } from '../src/core/formula/functions.js';
import { Workbook } from '../src/core/workbook.js';

// COUNTIFS(B:B,B2), SUMIF(B:B,B2,A:A) or COUNTIFS(A:A,">"&A2) filled down a long list with a few labels: the index of
// the criteria range named the cells a criterion matches, and each was then compared with the criterion again, a
// text comparison per candidate (30 million for 20,000 rows of 13 labels, 12-28 s). The index's cells are now
// taken as matching it, and only the other criteria are tested; the answers are the ones a scan gives.
const ROWS = 2000;
const shared = () => ({
  A: { range: true, values: Array.from({ length: ROWS }, (_, r) => [r % 11 === 3 ? String(r % 7) : r % 17 === 5 ? { error: '#N/A' } : r % 97]) },
  B: { range: true, values: Array.from({ length: ROWS }, (_, r) => [r % 19 === 2 ? null : r % 2 ? `k${r % 13}` : `K${r % 13}`]) },
});

function both(name, args) {
  const s = shared();
  const indexed = [1, 2, 3].map(() => FUNCTIONS[name].fn(args(s)));
  const scanned = FUNCTIONS[name].fn(args(shared()));
  expect(indexed[1], `${name} ${JSON.stringify(args({ A: 'A', B: 'B' }))}`).toEqual(scanned);
  expect(indexed[2]).toEqual(scanned);
  return scanned;
}

it('give the answers a scan gives', () => {
  for (const key of ['k5', 'K12', 'k0', 'nothing', 5, '5', 96]) {
    both('COUNTIFS', (s) => [s.B, key]);
    both('COUNTIFS', (s) => [s.B, key, s.A, '>40']);
    both('COUNTIFS', (s) => [s.A, key, s.B, 'k3']);
    both('SUMIF', (s) => [s.B, key, s.A]);
    both('SUMIFS', (s) => [s.A, s.B, key, s.A, '<50']);
    both('AVERAGEIF', (s) => [s.B, key, s.A]);
    both('AVERAGEIFS', (s) => [s.A, s.B, key]);
    both('MAXIFS', (s) => [s.A, s.B, key, s.A, '<>90']);
    both('MINIFS', (s) => [s.A, s.A, key, s.B, '<>k1']);
  }
  for (const op of ['<', '<=', '>', '>=']) {
    both('COUNTIFS', (s) => [s.A, `${op}40`]);
    both('COUNTIFS', (s) => [s.A, `${op}40`, s.A, '<70']);
    both('COUNTIFS', (s) => [s.A, `${op}40`, s.B, 'k2']);
    both('SUMIF', (s) => [s.A, `${op}40`, s.A]);
  }
  expect(both('COUNTIFS', (s) => [s.B, 'k5'])).toBeGreaterThan(both('COUNTIFS', (s) => [s.B, 'k5', s.A, '>40']));
});

it('reads none of the cells an index found for a criterion again', () => {
  let reads = 0;
  // A criteria range whose cells count each time one is read.
  const counted = (values) => ({ range: true, values: values.map((row) => new Proxy(row, {
    get: (t, k) => { if (typeof k === 'string' && /^\d+$/.test(k)) reads++; return t[k]; },
  })) });
  const labels = counted(Array.from({ length: 2000 }, (_, r) => [`k${r % 13}`]));
  const numbers = counted(Array.from({ length: 2000 }, (_, r) => [r % 97]));
  const amounts = { range: true, values: Array.from({ length: 2000 }, (_, r) => [r]) };
  // Two uses of the values with another criterion index the range; the answer asked for is then not one already kept.
  const third = (name, args, swap, others = ['k0', 'k1']) => {
    for (const other of others) FUNCTIONS[name].fn(args.map((a, k) => (k === swap ? other : a)));
    reads = 0;
    const answer = FUNCTIONS[name].fn(args);
    return [answer, reads];
  };
  expect(third('COUNTIFS', [labels, 'k5'], 1)).toEqual([154, 0]);
  expect(third('SUMIF', [labels, 'k5', amounts], 1)[1]).toBe(0);
  expect(third('SUMIFS', [amounts, labels, 'k6'], 2)[1]).toBe(0);
  expect(third('AVERAGEIF', [labels, 'k7', amounts], 1)[1]).toBe(0);
  expect(third('MAXIFS', [amounts, labels, 'k8'], 2)[1]).toBe(0);
  expect(third('COUNTIFS', [numbers, '>40'], 1, ['>10', '>20'])[1]).toBe(0);
  // The other criteria are still tested, on the index's cells alone.
  const [count, read] = third('COUNTIFS', [labels, 'k5', numbers, '>40'], 1);
  expect(count).toBe([...Array(2000).keys()].filter((r) => r % 13 === 5 && r % 97 > 40).length);
  expect(read).toBe(154);
});
