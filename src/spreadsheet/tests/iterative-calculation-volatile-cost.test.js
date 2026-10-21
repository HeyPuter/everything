import { expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// With iterative calculation on, a book holding a volatile formula anywhere (a TODAY() in a header) worked out
// every formula of the book again on every pass of the iteration, instead of only the circles and what reads them:
// a slowly converging circle beside 6,000 ordinary formulas took 11 s of calculation per edit, against 0.3 s
// without the TODAY(). The volatile formula and its readers are now worked out on each pass, and the rest once.
function book() {
  const cells = { '0,5': { f: 'TODAY()' }, '1,5': { f: 'F1+1' }, '0,8': { f: '1000+0.99*I2' }, '1,8': { f: 'I1*0.999' }, '2,8': { f: 'I1+F2-F1' } };
  for (let r = 0; r < 40; r++) cells[`${r},0`] = { v: r }, cells[`${r},1`] = { f: `SUM($A$1:A${r + 1})` };
  return new Workbook({ iteration: { iterate: true, iterateCount: 100, iterateDelta: 0.001 }, sheets: [{ name: 'Model', cells }] });
}

it('works out only the circles and the volatile formulas again on each pass', () => {
  const wb = book();
  const id = wb.activeSheetId;
  const contexts = vi.spyOn(wb, '_context');
  expect(wb.getValue(id, 0, 8)).toBeCloseTo(60856.85, 1);
  // The running totals in column B are calculated once, not once per pass.
  expect(contexts.mock.calls.filter(([, r, c]) => r === 39 && c === 1)).toHaveLength(1);
  // TODAY(), its reader and the circle's reader are calculated on every pass, as before.
  expect(contexts.mock.calls.filter(([, r, c]) => r === 0 && c === 5).length).toBeGreaterThan(50);
  expect(wb.getValue(id, 2, 8)).toBeCloseTo(wb.getValue(id, 0, 8) + 1, 6);
  expect(wb.getValue(id, 39, 1)).toBe(780);
});

it('still recalculates every formula on each pass when a name is volatile', () => {
  const wb = book();
  const id = wb.activeSheetId;
  wb.defineName('Stamp', '=NOW()');
  wb.setInput(id, 3, 5, '=Stamp');
  const contexts = vi.spyOn(wb, '_context');
  expect(wb.getValue(id, 0, 8)).toBeCloseTo(60856.85, 1);
  expect(contexts.mock.calls.filter(([, r, c]) => r === 39 && c === 1).length).toBeGreaterThan(50);
});
