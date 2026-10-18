import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { emptyModel, prepareSolver, solveSolver, variableLimits } from '../src/core/solver.js';

function solved(inputs, model) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (const [a, v] of Object.entries(inputs)) wb.setInput(id, Number(a.slice(1)) - 1, a.charCodeAt(0) - 65, v);
  const p = prepareSolver(wb, id, { ...emptyModel(''), ...model });
  const result = solveSolver(p);
  const limits = variableLimits(p, result);
  p.restore();
  return { result, limits };
}

it('puts a GRG variable\'s Limits Report edge on the binding constraint, not past it, so its objective is no better than the optimum', () => {
  // Max 3x + 5y with x <= 4, 2y <= 12, 3x + 2y <= 18: the optimum is x = 2, y = 6, profit 36.
  const { result, limits } = solved({ B1: '0', B2: '0', B4: '=3*B1+5*B2', B5: '=B1', B6: '=2*B2', B7: '=3*B1+2*B2' }, {
    objective: '$B$4', goal: 'max', variables: '$B$1:$B$2', engine: 'grg',
    constraints: [{ lhs: '$B$5', rel: '<=', rhs: '4' }, { lhs: '$B$6', rel: '<=', rhs: '12' }, { lhs: '$B$7', rel: '<=', rhs: '18' }],
  });
  expect(result.objective).toBeCloseTo(36, 6);
  expect(limits[0].upper).toBeCloseTo(2, 7);
  expect(limits[1].upper).toBeCloseTo(6, 7);
  for (const l of limits) expect(l.upperObjective).toBeLessThanOrEqual(result.objective + 1e-7);
  expect(limits[0]).toMatchObject({ lower: 0 });
  expect(limits[0].lowerObjective).toBeCloseTo(30, 6);
});

it('still reaches a bound that no constraint stops short of', () => {
  const { limits } = solved({ B1: '1', B2: '1', B4: '=(B1-3)^2+(B2-1)^2' }, {
    objective: '$B$4', goal: 'min', variables: '$B$1:$B$2', engine: 'grg', constraints: [{ lhs: '$B$1:$B$2', rel: '<=', rhs: '10' }],
  });
  expect(limits[0]).toMatchObject({ lower: 0, upper: 10 });
  expect(limits[0].upperObjective).toBeCloseTo(49, 6);
});
