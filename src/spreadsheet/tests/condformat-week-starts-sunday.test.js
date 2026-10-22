import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { matchesRule } from '../src/core/condformat.js';
import { conditionalRuleFormula } from '../src/core/condformat-formula.js';
import { ymdToSerial } from '../src/core/format.js';

// "Date is this week" and "last week" counted weeks from Monday, where Excel counts them Sunday to Saturday: on
// Wednesday 2026-10-21 the Sunday before, 2026-10-18, was last week rather than this one. The rule and the formula
// it is saved to Excel as now both run weeks from Sunday.
const today = ymdToSerial(2026, 10, 21);
const day = (d) => ymdToSerial(2026, 10, d);

it.each([
  ['thisWeek', [18, 19, 21, 24], [17, 25]],
  ['lastWeek', [11, 17], [10, 18]],
])('matches %s from Sunday to Saturday', (period, inside, outside) => {
  for (const d of inside) expect(matchesRule({ type: 'date', value: period }, day(d), { today }), `${d}`).toBe(true);
  for (const d of outside) expect(matchesRule({ type: 'date', value: period }, day(d), { today }), `${d}`).toBe(false);
});

it('saves the same weeks in the formula Excel evaluates', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const range = { r1: 0, c1: 0, r2: 0, c2: 0 };
  for (const period of ['thisWeek', 'lastWeek']) {
    const formula = conditionalRuleFormula({ type: 'date', value: period, range }).replaceAll('TODAY()', String(today));
    for (let d = 8; d <= 28; d++) {
      wb.setCells(id, [{ r: 0, c: 0, cell: { v: day(d), f: null } }]);
      const result = wb.evalRuleFormula(id, formula, range, 0, 0);
      expect(result === true, `${period} ${d}`).toBe(matchesRule({ type: 'date', value: period }, day(d), { today }));
    }
  }
});
