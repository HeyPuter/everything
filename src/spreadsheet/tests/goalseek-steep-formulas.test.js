import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

function seek(formula, goal, start = null) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  if (start != null) wb.setInput(id, 0, 0, String(start));
  wb.setInput(id, 0, 1, formula);
  return wb.goalSeek(id, { r: 0, c: 1 }, goal, { r: 0, c: 0 });
}

// The first secant step from a blank cell shoots far past the answer where these formulas are steep; the
// search then crawled back a unit a step and gave up after 200 trials where Excel's Goal Seek finds the value.
it.each([
  ['=EXP(A1)', 100, null, Math.log(100)],
  ['=EXP(A1)', 1e6, null, Math.log(1e6)],
  ['=A1^10', 1e10, null, 10],
  ['=A1*(1+A1)^12', 50, 0.1, null],
  ['=10^A1', 1e8, null, 8],
])('reaches %s = %s', (formula, goal, start, answer) => {
  const found = seek(formula, goal, start);
  expect(found.ok).toBe(true);
  expect(found.result).toBeCloseTo(goal, 3);
  if (answer != null) expect(found.value).toBeCloseTo(answer, 6);
  expect(found.iterations).toBeLessThan(100);
});

it('still says so when no value reaches the goal', () => {
  expect(seek('=ROUND(A1,0)*3', 10)).toMatchObject({ ok: false, reason: 'Could not find a value that reaches the goal' });
  expect(seek('=A1^2', -1).ok).toBe(false);
});
