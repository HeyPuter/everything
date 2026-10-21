import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { calc } from './helpers/calc.js';

// COUNT and COUNTA of one range in every row of a column, =A1/COUNTA($A$1:$A$20000) filled down, went over the
// whole range again in every row, as AVERAGE and STDEV did: 400 million cells for 20,000 rows on every edit. The
// count for a range alone is now kept with the array read for it, which every formula naming it shares.
it('counts a range once for a column of formulas over it', { timeout: 120000 }, () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const n = 20000;
  for (let r = 0; r < n; r++) wb.setInput(id, r, 0, r % 10 ? String(r) : 'x');
  for (let r = 0; r < n; r++) wb.setInput(id, r, 1, `=COUNTA($A$1:$A$${n})-COUNT($A$1:$A$${n})+${r}`);
  const start = process.cpuUsage();
  for (let r = 0; r < n; r++) expect(wb.getValue(id, r, 1)).toBe(n / 10 + r);
  const used = process.cpuUsage(start);
  expect((used.user + used.system) / 1000).toBeLessThan(600);
  wb.setInput(id, 1, 0, 'y');
  expect(wb.getValue(id, 7, 1)).toBe(n / 10 + 1 + 7);
});

it('keeps what COUNT and COUNTA answer', () => {
  const cells = { A1: 1, A2: 'x', A3: '', A4: 'TRUE', A5: '=1/0', A6: '=""' };
  expect(calc('COUNT(A1:A6)', cells)).toBe(1);
  expect(calc('COUNTA(A1:A6)', cells)).toBe(5);
  expect(calc('COUNT(A1:A6,1,"2","x",TRUE)', cells)).toBe(4);
  expect(calc('COUNTA(A1:A6,,1/0)', cells)).toBe(7);
});
