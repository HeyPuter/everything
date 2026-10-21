import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// SUBTOTAL and AGGREGATE leave out cells holding another total, and found them by reading the
// formula of every cell they total. A running count down a filtered list, =SUBTOTAL(3,$A$1:A1)
// filled down, read the formula of every cell of every prefix: seconds of calculation for a few
// thousand rows, most of a minute for twenty thousand. The sheet's nested totals are now found once
// per calculation, and a range with none of them and no hidden rows is totalled as it was read.
it('calculates a running SUBTOTAL down thousands of rows in moments', { timeout: 120000 }, () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const n = 6000;
  for (let r = 0; r < n; r++) {
    wb.setInput(id, r, 0, String(r % 7));
    wb.setInput(id, r, 1, `=SUBTOTAL(3,$A$1:A${r + 1})`);
    wb.setInput(id, r, 2, `=SUBTOTAL(9,$A$1:A${r + 1})`);
  }
  const start = process.cpuUsage();
  let total = 0;
  for (let r = 0; r < n; r++) {
    expect(wb.getValue(id, r, 1)).toBe(r + 1);
    total += r % 7;
    expect(wb.getValue(id, r, 2)).toBe(total);
  }
  const used = process.cpuUsage(start);
  expect((used.user + used.system) / 1000).toBeLessThan(2000);
});

it('still leaves out nested totals, array formulas among them, and hidden rows', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['1', '2', '=SUBTOTAL(9,A1:A2)', '4', '=AGGREGATE(9,4,A1:A2)', '6'].forEach((v, r) => wb.setInput(id, r, 0, v));
  wb.setArrayFormula(id, parseRange('A7:A8'), '=SUBTOTAL(9,A1:A2)*{1;2}');
  wb.setInput(id, 8, 0, '10');
  wb.setInput(id, 0, 2, '=SUBTOTAL(9,A1:A9)');
  wb.setInput(id, 1, 2, '=SUBTOTAL(109,A1:A9)');
  wb.setInput(id, 2, 2, '=AGGREGATE(9,0,A1:A9)');
  wb.setInput(id, 3, 2, '=AGGREGATE(9,4,A1:A9)');
  wb.setInput(id, 4, 2, '=SUBTOTAL(2,A1:A9,A3:A5)');
  // A7:A8 hold 3 and 6 from an array formula that is a SUBTOTAL: left out with A3 and A5.
  expect([0, 1, 2, 3, 4].map((r) => wb.getValue(id, r, 2))).toEqual([23, 23, 23, 38, 6]);
  wb.setHidden(id, 'row', [3], true);
  expect([0, 1, 2].map((r) => wb.getValue(id, r, 2))).toEqual([23, 19, 23]);
  wb.setInput(id, 0, 1, 'keep');
  wb.setInput(id, 8, 1, 'drop');
  for (let r = 1; r < 8; r++) wb.setInput(id, r, 1, 'keep');
  wb.setFilterRange(id, parseRange('B1:B9'));
  wb.setFilterCriteria(id, 1, { values: ['keep'] });
  expect([0, 1, 2].map((r) => wb.getValue(id, r, 2))).toEqual([13, 9, 23]);
});
