import { describe, it, expect } from 'vitest';
import { solveLP, sensitivity, branchAndBound } from '../src/core/solver-lp.js';
import { solveNLP, solveNLPMultistart, seededRandom } from '../src/core/solver-nlp.js';
import { solveEvolutionary } from '../src/core/solver-evo.js';

const run = (steps) => { let s; while (!(s = steps.next()).done); return s.value; };
const free = (n) => ({ lb: new Array(n).fill(-Infinity), ub: new Array(n).fill(Infinity) });
const nonneg = (n) => ({ lb: new Array(n).fill(0), ub: new Array(n).fill(Infinity) });

describe('simplex', () => {
  it('does not cycle on a degenerate model built to make the textbook rule cycle', () => {
    // min -3/4 x1 + 20 x2 - 1/2 x3 + 6 x4 (the classic cycling example): optimum -5/4 at (1, 0, 1, 0).
    const r = solveLP({ c: [-0.75, 20, -0.5, 6], A: [[0.25, -8, -1, 9], [0.5, -12, -0.5, 3], [0, 0, 1, 0]], rel: ['<=', '<=', '<='], b: [0, 0, 1], ...nonneg(4) });
    expect(r.status).toBe('optimal');
    expect(r.objective).toBeCloseTo(-1.25, 10);
    expect(r.x.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 0, 1, 0]);
  });

  it('handles free variables, equalities and both bound kinds', () => {
    const r = solveLP({ c: [1, 1], A: [[1, 1], [1, -1]], rel: ['>=', '='], b: [4, 1], ...free(2) });
    expect(r.status).toBe('optimal');
    expect(r.x).toEqual([2.5, 1.5]);
    // Bounded variables only (no rows): each goes to the bound its cost prefers.
    const b = solveLP({ c: [1, -2, 0], A: [], rel: [], b: [], lb: [-3, 0, 1], ub: [5, 7, 2] });
    expect(b.x.slice(0, 2)).toEqual([-3, 7]);
  });

  it('reports the dual values and ranges of a production model', () => {
    // max 3x + 5y st x <= 4, 2y <= 12, 3x + 2y <= 18 (solved as min -3x - 5y).
    const r = solveLP({ c: [-3, -5], A: [[1, 0], [0, 2], [3, 2]], rel: ['<=', '<=', '<='], b: [4, 12, 18], ...nonneg(2) });
    const s = sensitivity(r);
    expect(s.rows.map((row) => row.dual)).toEqual([0, -1.5, -1]);
    expect(s.rows[1]).toMatchObject({ increase: 6, decrease: 6 });
    expect(s.rows[0]).toMatchObject({ increase: Infinity, decrease: 2 });
    expect(s.variables[0]).toMatchObject({ reducedCost: 0, increase: 3, decrease: 4.5 });
  });

  it('meets strong duality on a transportation model', () => {
    const supply = [20, 30, 25], demand = [10, 25, 20, 20];
    const cost = [[8, 6, 10, 9], [9, 12, 13, 7], [14, 9, 16, 5]];
    const A = [], rel = [], b = [];
    supply.forEach((s, i) => { A.push(Array.from({ length: 12 }, (_, k) => (Math.floor(k / 4) === i ? 1 : 0))); rel.push('<='); b.push(s); });
    demand.forEach((d, j) => { A.push(Array.from({ length: 12 }, (_, k) => (k % 4 === j ? 1 : 0))); rel.push('>='); b.push(d); });
    const r = solveLP({ c: cost.flat(), A, rel, b, ...nonneg(12) });
    expect(r.status).toBe('optimal');
    const duals = sensitivity(r).rows.map((row) => row.dual);
    expect(duals.reduce((s, y, i) => s + y * b[i], 0)).toBeCloseTo(r.objective, 8);
    expect(r.objective).toBe(615);
  });

  it('branches to the integer optimum, and to all-different values', () => {
    const relax = (lp) => function* (lb, ub) { return solveLP({ ...lp, lb, ub }); };
    const ilp = { c: [-1, -1], A: [[-2, 2], [-8, 10]], rel: ['>=', '<='], b: [1, 13] };
    const r = run(branchAndBound(relax(ilp), [0, 0], [Infinity, Infinity], { integer: [true, true] }));
    expect(r.x).toEqual([1, 2]);
    // Three variables in 1..3, all different, minimizing 3a + 2b + c: the cheapest order is a=1, b=2, c=3.
    const perm = { c: [3, 2, 1], A: [[1, 1, 1]], rel: ['='], b: [6] };
    const p = run(branchAndBound(relax(perm), [1, 1, 1], [3, 3, 3], { integer: [true, true, true], groups: [[0, 1, 2]] }));
    expect(p.x).toEqual([1, 2, 3]);
    expect(run(branchAndBound(relax({ c: [1], A: [[2]], rel: ['='], b: [3] }), [0], [5], { integer: [true] })).status).toBe('infeasible');
  });
});

describe('GRG nonlinear', () => {
  it('solves a degenerate linear model through its bounds in few iterations', () => {
    const N = 6;
    const C = Array.from({ length: N * N }, (_, k) => ((Math.floor(k / N) * 7 + (k % N) * 13) % 17) + 1);
    const rows = Array.from({ length: 2 * N }, () => ({ rel: '=' }));
    const r = run(solveNLP({ n: N * N, x0: new Array(N * N).fill(0), lb: new Array(N * N).fill(0), ub: new Array(N * N).fill(1), rows, evaluate: (x) => {
      const g = [];
      for (let i = 0; i < N; i++) g.push(x.slice(i * N, i * N + N).reduce((s, v) => s + v, 0) - 1);
      for (let j = 0; j < N; j++) g.push(x.filter((_, k) => k % N === j).reduce((s, v) => s + v, 0) - 1);
      return { f: x.reduce((s, v, k) => s + v * C[k], 0), g };
    } }));
    const lp = solveLP({ c: C, A: Array.from({ length: 2 * N }, (_, i) => Array.from({ length: N * N }, (_, k) => (i < N ? Math.floor(k / N) === i : k % N === i - N) ? 1 : 0)), rel: rows.map(() => '='), b: new Array(2 * N).fill(1), lb: new Array(N * N).fill(0), ub: new Array(N * N).fill(1) });
    expect(r.status).toBe('optimal');
    expect(r.objective).toBeCloseTo(lp.objective, 4);
    expect(r.iterations).toBeLessThan(300);
  });

  it('stops at its iteration limit and when asked', () => {
    const p = { n: 2, x0: [-1.2, 1], ...free(2), rows: [], evaluate: ([x, y]) => ({ f: 100 * (y - x * x) ** 2 + (1 - x) ** 2, g: [] }) };
    expect(run(solveNLP(p, { maxIter: 3 })).status).toBe('iterationLimit');
    let k = 0;
    expect(run(solveNLP(p, { stop: () => (++k > 2 ? 'stopped' : null) })).status).toBe('stopped');
  });

  it('is deterministic for a given multistart seed', () => {
    const p = { n: 1, x0: [4], lb: [-5], ub: [5], rows: [], evaluate: ([x]) => ({ f: Math.sin(3 * x) + 0.1 * x * x, g: [] }) };
    const a = run(solveNLPMultistart(p, { starts: 20, seed: 9 })), b = run(solveNLPMultistart(p, { starts: 20, seed: 9 }));
    expect(a.x).toEqual(b.x);
    expect(a.objective).toBeCloseTo(-0.97318, 4);
  });
});

describe('evolutionary', () => {
  it('repeats exactly with a seed and handles integers', () => {
    const p = { n: 2, x0: [0, 0], lb: [0, 0], ub: [10, 10], integer: [true, true], rows: [{ rel: '>=' }],
      evaluate: ([x, y]) => ({ f: 3 * x + 2 * y + (x > 2 ? 0 : 5), g: [x + y - 5] }) };
    const opts = { seed: 4, maxTimeNoImprove: 5, now: (() => { let t = 0; return () => (t += 1); })() };
    const a = run(solveEvolutionary(p, opts));
    const b = run(solveEvolutionary(p, { ...opts, now: (() => { let t = 0; return () => (t += 1); })() }));
    expect(a.x).toEqual([3, 2]);
    expect(b.x).toEqual(a.x);
    expect(a.feasible).toBe(true);
  });

  it('reports an infeasible model', () => {
    const p = { n: 1, x0: [0], lb: [0], ub: [1], rows: [{ rel: '>=' }], evaluate: ([x]) => ({ f: x, g: [x - 5] }) };
    expect(run(solveEvolutionary(p, { seed: 1, maxIter: 30 })).status).toBe('infeasible');
  });
});

it('draws the same numbers from the same seed', () => {
  const a = seededRandom(42), b = seededRandom(42);
  const xs = Array.from({ length: 5 }, a);
  expect(Array.from({ length: 5 }, b)).toEqual(xs);
  expect(xs.every((v) => v >= 0 && v < 1)).toBe(true);
});
