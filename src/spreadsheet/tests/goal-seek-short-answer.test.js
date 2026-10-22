import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Goal Seek wrote its answer to twelve significant digits whenever that still reached the goal, so a goal met
// exactly by a round number came out a hair short of it: =1/A1 set to 0.25 left 3.99999999999 in A1, =SQRT(A1)
// set to 3 left 8.99999999998. The answer is now the shortest rounding that still reaches the goal.
function seek(formula, goal, start = 1) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: start } }, { r: 1, c: 0, cell: { v: null, f: formula } }]);
  const res = wb.goalSeek(id, { r: 1, c: 0 }, goal, { r: 0, c: 0 });
  return { res, value: wb.getValue(id, 0, 0), result: wb.getValue(id, 1, 0) };
}

it.each([['1/A1', 0.25, 4], ['SQRT(A1)', 3, 9], ['1000000*A1', 3, 0.000003], ['A1^2', 4, 2]])('sets =%s to %s with %s', (formula, goal, want) => {
  const { res, value, result } = seek(formula, goal);
  expect(res.ok).toBe(true);
  expect(value).toBe(want);
  expect(result).toBe(goal);
});

it('keeps the digits a sensitive formula needs', () => {
  const { res, value, result } = seek('A1-1E+12', 5, 0);
  expect(res.ok).toBe(true);
  expect(value).toBe(1e12 + 5);
  expect(result).toBe(5);
});
