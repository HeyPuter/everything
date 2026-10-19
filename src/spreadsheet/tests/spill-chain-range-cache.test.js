import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Rows that each spill a short array from the row above's total (A2 = SUM(B1#), B2 = SEQUENCE(1,3,A2/1000)):
// every spill landing looked over every range held for one that overlapped it, and each row's three-cell B#
// was held, so 4,000 such rows took five seconds a recalculation, quadratically more as they grew.
it('a column of spills reading one another recalculates in moments', () => {
  const rows = 4000;
  const wb = new Workbook(), id = wb.activeSheetId;
  const entries = [{ r: 0, c: 0, cell: { v: 1 } }];
  for (let r = 1; r < rows; r++) entries.push({ r, c: 0, cell: { f: `SUM(B${r}#)` } });
  for (let r = 0; r < rows; r++) entries.push({ r, c: 1, cell: { f: `SEQUENCE(1,3,A${r + 1}/1000)` } });
  wb.setCells(id, entries);
  let start = performance.now();
  // B1 spills 0.001, 1.001, 2.001, so A2 is 3.003; each row adds three thousandths of the one above, toward 3 / 0.997.
  expect(wb.getValue(id, 1, 0)).toBeCloseTo(3.003, 12);
  expect(wb.getValue(id, rows - 1, 0)).toBeCloseTo(3.00902708124373, 10);
  expect(wb.getValue(id, rows - 1, 3)).toBeCloseTo(wb.getValue(id, rows - 1, 0) / 1000 + 2, 12);
  expect(performance.now() - start).toBeLessThan(2000);
  start = performance.now();
  wb.setInput(id, 0, 0, '2');
  expect(wb.getValue(id, 1, 0)).toBeCloseTo(3.006, 12);
  expect(wb.getValue(id, rows - 1, 0)).toBeCloseTo(3.00902708124373, 10);
  expect(performance.now() - start).toBeLessThan(2000);
}, 60000);
