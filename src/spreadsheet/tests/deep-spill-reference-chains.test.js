import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Each row totals the spill of the row below (A1 = SUM(B2#)) and spills from its own total (B1 = SEQUENCE(1,3,A1/1000)).
// Read from the top the chain runs deeper than the call stack. The walk that calculates such a chain from the bottom
// asked each formula for the spill it reads, which calculated it again on the stack: past five hundred rows the top
// rows answered #REF! after seconds, and a chain of =A2# references took a minute.
it('a chain of spill references too deep for the stack calculates from the bottom', () => {
  const rows = 1500;
  const wb = new Workbook(), id = wb.activeSheetId;
  const entries = [{ r: rows - 1, c: 0, cell: { v: 1 } }];
  for (let r = 0; r < rows - 1; r++) entries.push({ r, c: 0, cell: { f: `SUM(B${r + 2}#)` } });
  for (let r = 0; r < rows; r++) entries.push({ r, c: 1, cell: { f: `SEQUENCE(1,3,A${r + 1}/1000)` } });
  wb.setCells(id, entries);
  const start = performance.now();
  expect(wb.getValue(id, 0, 0)).toBeCloseTo(3 / 0.997, 10);
  expect(wb.getValue(id, 0, 3)).toBeCloseTo(3 / 0.997 / 1000 + 2, 10);
  expect(wb.getValue(id, 100, 0)).toBeCloseTo(3 / 0.997, 10);
  expect(wb.getValue(id, rows - 2, 0)).toBeCloseTo(3.003, 12);
  expect(performance.now() - start).toBeLessThan(5000);
}, 60000);

it('a chain of =A2# references to a spill at its foot reads its value', () => {
  const rows = 3000;
  const wb = new Workbook(), id = wb.activeSheetId;
  const entries = [{ r: rows - 1, c: 0, cell: { f: 'SEQUENCE(1,2,7)' } }];
  for (let r = 0; r < rows - 1; r++) entries.push({ r, c: 0, cell: { f: `A${r + 2}#` } });
  wb.setCells(id, entries);
  const start = performance.now();
  expect(wb.getValue(id, 0, 0)).toBe(7);
  expect(wb.getValue(id, 0, 1)).toBe(8);
  expect(performance.now() - start).toBeLessThan(5000);
}, 60000);
