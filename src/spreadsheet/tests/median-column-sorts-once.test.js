import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { calc } from './helpers/calc.js';

// MEDIAN sorted its numbers afresh in every cell, so a column measured against its median,
// =A1-MEDIAN($A$1:$A$8000) filled down, sorted 8,000 numbers 8,000 times: seconds of calculation on
// every edit, and most of a minute for 20,000 rows. One range is now sorted once for all of them, as
// LARGE, RANK and PERCENTILE already do.
it('sorts a range once for a column of MEDIANs over it', { timeout: 60000 }, () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const n = 8000;
  for (let r = 0; r < n; r++) wb.setInput(id, r, 0, String((r * 7919) % 10007));
  for (let r = 0; r < n; r++) wb.setInput(id, r, 1, `=A${r + 1}-MEDIAN($A$1:$A$${n})`);
  const sorted = Array.from({ length: n }, (_, r) => (r * 7919) % 10007).sort((a, b) => a - b);
  const median = (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const start = process.cpuUsage();
  for (let r = 0; r < n; r++) expect(wb.getValue(id, r, 1)).toBe(((r * 7919) % 10007) - median);
  const used = process.cpuUsage(start);
  // A sort per cell takes seconds of processor time; one sort and a lookup per cell takes milliseconds.
  expect((used.user + used.system) / 1000).toBeLessThan(1500);
});

it('keeps what MEDIAN reads and answers', () => {
  const cells = { A1: 3, A2: 'x', A3: 1, A4: 'TRUE', A5: 2, A6: '#N/A' };
  expect(calc('MEDIAN(A1:A5)', cells)).toBe(2);
  expect(calc('MEDIAN(A1:A6)', cells)).toEqual({ error: '#N/A' });
  expect(calc('MEDIAN(A1:A5,10)', cells)).toBe(2.5);
  expect(calc('MEDIAN(A2)', cells)).toEqual({ error: '#NUM!' });
  expect(calc('MEDIAN("3",1)')).toBe(2);
  expect(calc('MEDIAN(TRUE)')).toBe(1);
  expect(calc('MEDIAN({1,2,3,4})')).toBe(2.5);
});
