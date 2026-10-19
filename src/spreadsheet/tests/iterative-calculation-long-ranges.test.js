import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A model with iterative calculation on for one small circle (interest on a balance that includes it) and a
// running total down thousands of rows: iteration read every cell of every range afresh and noted each
// read, so 5,000 rows took over ten seconds a recalculation and 20,000 ran the tab out of memory.
function model(rows) {
  const cells = { '0,0': { v: 1 }, '0,5': { f: '1000+F2' }, '1,5': { f: 'F1*0.1' } };
  for (let r = 1; r < rows; r++) {
    cells[`${r},0`] = { f: `A${r}+1` };
    cells[`${r},1`] = { f: `SUM(A$1:A${r + 1})` };
  }
  return new Workbook({ iteration: { iterate: true, iterateCount: 100, iterateDelta: 0.001 }, sheets: [{ name: 'Sheet1', rows: rows + 5, cols: 7, cells }] });
}

it('recalculates a long running total beside an iterated circle in moments', () => {
  const rows = 6000;
  const wb = model(rows), id = wb.activeSheetId;
  let start = performance.now();
  expect(wb.getValue(id, rows - 1, 1)).toBe(rows * (rows + 1) / 2);
  expect(wb.getValue(id, 0, 5)).toBeCloseTo(1111.111, 2);
  expect(performance.now() - start).toBeLessThan(4000);
  start = performance.now();
  wb.setInput(id, 0, 0, '2');
  expect(wb.getValue(id, rows - 1, 1)).toBe(rows * (rows + 1) / 2 + rows);
  expect(wb.getValue(id, 2, 1)).toBe(2 + 3 + 4);
  expect(performance.now() - start).toBeLessThan(4000);
}, 60000);

it('still recalculates the readers of a range holding a circle on every pass', () => {
  // A1 and B1 settle at 20 together; C1 reads them as a range, D1 reads C1 as a range.
  const wb = new Workbook({ iteration: { iterate: true, iterateCount: 100, iterateDelta: 1e-9 }, sheets: [{ name: 'Sheet1', cells: {
    '0,0': { f: 'B1*0.5+10' }, '0,1': { f: 'A1' }, '0,2': { f: 'SUM(A1:B1)' }, '0,3': { f: 'SUM(C1:C1)*2' }, '1,2': { f: 'SUM(A1:B1)+1' },
  } }] });
  const id = wb.activeSheetId;
  expect(wb.getValue(id, 0, 0)).toBeCloseTo(20, 6);
  expect(wb.getValue(id, 0, 2)).toBeCloseTo(40, 6);
  expect(wb.getValue(id, 1, 2)).toBeCloseTo(41, 6);
  expect(wb.getValue(id, 0, 3)).toBeCloseTo(80, 6);
  wb.setInput(id, 0, 0, '=B1*0.5+20');
  expect(wb.getValue(id, 0, 2)).toBeCloseTo(80, 6);
  expect(wb.getValue(id, 0, 3)).toBeCloseTo(160, 6);
});
