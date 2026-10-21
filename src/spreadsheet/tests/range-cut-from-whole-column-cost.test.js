import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Once any formula has read a whole column, B:B (a COUNTA(B:B), a MATCH over B:B), a bounded range of it read
// afterwards is cut from that array rather than read afresh, and the cut was not kept: every row of
// =B1/SUM($B$1:$B$20000) copied 20,000 rows and added them up again, 6 seconds of calculation on every edit
// against 0.2 without the COUNTA. The last cut is now kept with the column, and its running total shared.
function book(n, first) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < n; r++) wb.setInput(id, r, 1, String((r * 13) % 97));
  wb.setInput(id, 0, 5, first);
  for (let r = 0; r < n; r++) wb.setInput(id, r, 2, `=B${r + 1}/SUM($B$1:$B$${n})`);
  return { wb, id };
}

it('sums a range cut from a whole column once for a column of formulas', { timeout: 120000 }, () => {
  const n = 20000;
  const { wb, id } = book(n, '=COUNTA(B:B)');
  let total = 0;
  for (let r = 0; r < n; r++) total += (r * 13) % 97;
  const start = process.cpuUsage();
  expect(wb.getValue(id, 0, 5)).toBe(n);
  let sum = 0;
  for (let r = 0; r < n; r++) sum += wb.getValue(id, r, 2);
  const used = process.cpuUsage(start);
  expect(sum).toBeCloseTo(1, 9);
  expect(wb.getValue(id, 1, 2)).toBe(13 / total);
  expect((used.user + used.system) / 1000).toBeLessThan(1500);
});

it('still adds up running totals read from the bottom, and errors among them', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 50; r++) wb.setInput(id, r, 0, String(r + 1));
  wb.setInput(id, 30, 0, '=1/0');
  wb.setInput(id, 0, 5, '=MATCH(7,A:A,0)');
  for (let r = 0; r < 50; r++) wb.setInput(id, r, 1, `=SUM($A$1:A${r + 1})`);
  expect(wb.getValue(id, 0, 5)).toBe(7);
  for (let r = 49; r >= 0; r--) {
    const want = r >= 30 ? { error: '#DIV/0!' } : ((r + 1) * (r + 2)) / 2;
    expect(wb.getValue(id, r, 1)).toEqual(want);
  }
  expect(wb.getValue(id, 29, 1)).toBe(465);
});
