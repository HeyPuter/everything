import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { prepareSolver, solveSolver, emptyModel } from '../src/core/solver.js';

/** A workbook from rows of cell inputs (A1 down), on its first sheet. */
function book(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((text, c) => { if (text !== null && text !== '') wb.setInput(id, r, c, String(text)); }));
  return { wb, id };
}
const model = (patch) => ({ ...emptyModel(), ...patch, options: { ...emptyModel().options, integerOptimality: 0, ...(patch.options || {}) } });
const cols = 'ABCDE';

/** Every permutation of 1..n. */
function permutations(n) {
  if (n === 1) return [[1]];
  return permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n, ...p.slice(i)]));
}

describe('Solver all-different constraint', () => {
  for (const engine of ['simplex', 'grg']) {
    it(`${engine}: maximizing A1+2B1+3C1 puts the largest value on the largest weight`, () => {
      const { wb, id } = book([[0, 0, 0], ['=A1+2*B1+3*C1']]);
      const p = prepareSolver(wb, id, model({ objective: '$A$2', goal: 'max', variables: '$A$1:$C$1', engine, constraints: [{ lhs: '$A$1:$C$1', rel: 'dif' }] }));
      const r = solveSolver(p);
      expect(r.x).toEqual([1, 2, 3]);
      expect(r.objective).toBe(14);
    });
  }

  it('matches a brute-force search over every permutation', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let trial = 0; trial < 12; trial++) {
      const n = 3 + (trial % 3);
      const w = Array.from({ length: n }, () => Math.floor(rand() * 19) - 9);
      const goal = trial % 2 ? 'min' : 'max';
      const formula = '=' + w.map((k, j) => `${k}*${cols[j]}1`).join('+');
      const { wb, id } = book([new Array(n).fill(0), [formula]]);
      const vars = `$A$1:$${cols[n - 1]}$1`;
      const p = prepareSolver(wb, id, model({ objective: '$A$2', goal, variables: vars, engine: 'simplex', constraints: [{ lhs: vars, rel: 'dif' }] }));
      const r = solveSolver(p);
      const scores = permutations(n).map((x) => x.reduce((s, v, j) => s + v * w[j], 0));
      const best = goal === 'max' ? Math.max(...scores) : Math.min(...scores);
      expect(new Set(r.x).size).toBe(n);
      expect(r.objective).toBe(best);
    }
  });
});
