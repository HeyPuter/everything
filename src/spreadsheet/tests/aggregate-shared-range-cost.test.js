import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { calc } from './helpers/calc.js';

// A column measured against one range — a z-score, =(A1-AVERAGE($A$1:$A$12000))/STDEV($A$1:$A$12000), filled
// down — went over the whole range again in every row: 144 million numbers read for 12,000 rows, seconds of
// calculation on every edit, and quadratically more as the list grew. The answer for a range alone is now kept
// with the array read for it, which every formula naming the range shares within a calculation.
it('works out an aggregate of one range once for a column of formulas over it', { timeout: 120000 }, () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const n = 12000;
  const xs = Array.from({ length: n }, (_, r) => (r * 7919) % 1009);
  xs.forEach((x, r) => wb.setInput(id, r, 0, String(x)));
  for (let r = 0; r < n; r++) wb.setInput(id, r, 1, `=(A${r + 1}-AVERAGE($A$1:$A$${n}))/STDEV($A$1:$A$${n})+MAX($A$1:$A$${n})*0`);
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const start = process.cpuUsage();
  for (let r = 0; r < n; r++) expect(wb.getValue(id, r, 1)).toBeCloseTo((xs[r] - mean) / sd, 9);
  const used = process.cpuUsage(start);
  expect((used.user + used.system) / 1000).toBeLessThan(1000);
  // An edit is seen: the answers are kept only with the array read before it.
  xs[0] = 100000;
  wb.setInput(id, 0, 0, '100000');
  const mean2 = xs.reduce((a, b) => a + b, 0) / n;
  const sd2 = Math.sqrt(xs.reduce((a, b) => a + (b - mean2) ** 2, 0) / (n - 1));
  expect(wb.getValue(id, 5, 1)).toBeCloseTo((xs[5] - mean2) / sd2, 9);
});

it('keeps what each aggregate answers', () => {
  const cells = { A1: 1, A2: 'x', A3: 3, A4: 'TRUE', A5: 6 };
  expect(calc('AVERAGE(A1:A5)', cells)).toBeCloseTo(10 / 3, 12);
  expect(calc('MAX(A1:A5)+MIN(A1:A5)', cells)).toBe(7);
  expect(calc('AVERAGE(A2)', cells)).toEqual({ error: '#DIV/0!' });
  expect(calc('AVERAGE(A1:A6,1/0)', cells)).toEqual({ error: '#DIV/0!' });
  expect(calc('STDEV(A1:A5)-STDEV(A1:A5)', cells)).toBe(0);
});
