import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { prepareSolver, solveSolver, emptyModel } from '../src/core/solver.js';

// Simplex LP with binary variables measured its Integer Optimality tolerance (1%) against the objective without
// its constant term: a knapsack scored as SUMPRODUCT(...)-601 stopped at 4 where the best is 10, 60% short, and
// reported it within the tolerance. The gap is now relative to the objective the formula gives, constant and all.
const VALUES = [95, 51, 82, 90, 64, 100, 60, 84, 79, 54, 54, 73, 65, 62];
const WEIGHTS = [34, 36, 26, 37, 42, 30, 33, 44, 38, 47, 20, 42, 44, 42];
const CAP = 258;

function best() {
  let top = 0;
  for (let m = 0; m < 1 << VALUES.length; m++) {
    let w = 0, v = 0;
    for (let i = 0; i < VALUES.length; i++) if (m >> i & 1) { w += WEIGHTS[i]; v += VALUES[i]; }
    if (w <= CAP && v > top) top = v;
  }
  return top;
}

it('stops within 1% of the true optimum of an objective with a constant term', () => {
  const optimum = best();
  for (const offset of [0, 601]) {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    [new Array(VALUES.length).fill(0), VALUES, WEIGHTS, [`=SUMPRODUCT(A1:N1,A2:N2)-${offset}`, '=SUMPRODUCT(A1:N1,A3:N3)']]
      .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
    const model = { ...emptyModel(), objective: '$A$4', goal: 'max', variables: '$A$1:$N$1', engine: 'simplex',
      constraints: [{ lhs: '$A$1:$N$1', rel: 'bin' }, { lhs: '$B$4', rel: '<=', rhs: String(CAP) }] };
    const p = prepareSolver(wb, id, model);
    const r = solveSolver(p);
    const target = optimum - offset;
    expect(target - r.objective).toBeLessThanOrEqual(0.01 * Math.abs(target) + 1e-9);
  }
});
