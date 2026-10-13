/**
 * Solver ▸ Evolutionary: models that are not smooth (lookups, IF, rounding, step functions). A population
 * evolves by differential evolution — each trial point mixes three others — with a random reset of single
 * variables at the mutation rate. Constraints are judged by feasibility first: a point meeting every row
 * beats one that does not, two infeasible points compare by their total violation, two feasible ones by
 * the objective. Integer variables are rounded, and an all-different group is turned into a permutation of
 * 1..n by the order of its members' values.
 *
 * problem as in solver-nlp.js, plus { integer: bool[], groups: [[j...]] }. Every evaluation is a yield point.
 */
import { seededRandom, violations } from './solver-nlp.js';

/**
 * options: { precision, convergence, population, mutationRate, seed, maxIter (generations), maxTimeNoImprove
 * (seconds), requireBounds, stop() → reason | null, now() }.
 * Returns { status: 'converged' | 'noImprovement' | 'iterationLimit' | 'infeasible' | 'needsBounds' | 'stopped' | 'timeLimit' | 'error',
 *   x, objective, feasible, iterations (generations), evals }.
 */
export function* solveEvolutionary(problem, {
  precision = 1e-6, convergence = 1e-4, population = 100, mutationRate = 0.075, seed = 0, maxIter = Infinity,
  maxTimeNoImprove = 30, requireBounds = true, stop = () => null, now = () => Date.now(),
} = {}) {
  const { n, rows } = problem;
  const integer = problem.integer || new Array(n).fill(false);
  const groups = problem.groups || [];
  const bounded = problem.lb.every(Number.isFinite) && problem.ub.every(Number.isFinite);
  if (requireBounds && !bounded) return { status: 'needsBounds', x: null, objective: NaN, iterations: 0, evals: 0 };
  const rand = seededRandom(seed || (now() ^ 0x5bd1e995));
  const x0 = problem.x0.map((v) => (Number.isFinite(v) ? v : 0));
  // Where to sample a variable that has no bound on one side: around its starting value.
  const lo = problem.lb.map((v, i) => (Number.isFinite(v) ? v : Math.min(x0[i], Number.isFinite(problem.ub[i]) ? problem.ub[i] : x0[i]) - 10 * Math.max(1, Math.abs(x0[i]))));
  const hi = problem.ub.map((v, i) => (Number.isFinite(v) ? v : Math.max(x0[i], lo[i]) + 10 * Math.max(1, Math.abs(x0[i]))));
  const lb = problem.lb, ub = problem.ub;
  const size = Math.max(10, Math.min(2000, Math.round(population)));
  let evals = 0, generations = 0;

  const repair = (x) => {
    for (let j = 0; j < n; j++) {
      let v = Math.min(ub[j], Math.max(lb[j], x[j]));
      if (!Number.isFinite(v)) v = x0[j];
      if (integer[j]) {
        v = Math.round(v);
        if (v > ub[j]) v = Math.floor(ub[j]);
        if (v < lb[j]) v = Math.ceil(lb[j]);
      }
      x[j] = v;
    }
    for (const g of groups) {
      // The members' order, by value (ties by position), becomes the permutation 1..k.
      const order = g.map((j, k) => [x[j], k]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      order.forEach(([, k], rank) => { x[g[k]] = rank + 1; });
    }
    return x;
  };
  const evaluate = function* (x) {
    evals++;
    const r = problem.evaluate(x);
    yield { evals, iterations: generations };
    const ok = r && Number.isFinite(r.f) && r.g.every(Number.isFinite);
    if (!ok) return { x, f: Infinity, v: Infinity };
    const v = violations(rows, r.g).reduce((s, a, i) => s + Math.max(0, a - precision * Math.max(1, rows[i].scale || 1)) / Math.max(1, rows[i].scale || 1), 0);
    return { x, f: r.f, v };
  };
  const beats = (a, b) => (a.v === 0 && b.v === 0 ? a.f < b.f : a.v < b.v || (a.v === b.v && a.f < b.f));
  const atLeast = (a, b) => !beats(b, a);

  const pop = [];
  let best = null;
  pop.push(yield* evaluate(repair(x0.slice())));
  for (let k = 1; k < size; k++) {
    const reason = stop();
    if (reason) { best = pop.reduce((p, q) => (beats(q, p) ? q : p)); return finish(reason); }
    pop.push(yield* evaluate(repair(lo.map((l, j) => l + rand() * (hi[j] - l)))));
  }
  best = pop.reduce((a, b) => (beats(b, a) ? b : a));
  let improvedAt = now();
  let halted = null;
  while (!halted) {
    if (generations >= maxIter) { halted = 'iterationLimit'; break; }
    generations++;
    for (let i = 0; i < size && !halted; i++) {
      halted = stop();
      if (halted) break;
      let a, b, c;
      do a = Math.floor(rand() * size); while (a === i);
      do b = Math.floor(rand() * size); while (b === i || b === a);
      do c = Math.floor(rand() * size); while (c === i || c === a || c === b);
      // Best-biased differential mutation half the time: faster on smooth stretches, the random base keeps variety.
      const base = rand() < 0.5 ? best.x : pop[a].x;
      const F = 0.4 + 0.5 * rand();
      const jr = Math.floor(rand() * n);
      const trial = pop[i].x.slice();
      for (let j = 0; j < n; j++) {
        if (rand() < 0.9 || j === jr) trial[j] = base[j] + F * (pop[b].x[j] - pop[c].x[j]);
        if (rand() < mutationRate) trial[j] = lo[j] + rand() * (hi[j] - lo[j]);
        if (integer[j] && trial[j] === pop[i].x[j] && rand() < 0.2) trial[j] += rand() < 0.5 ? -1 : 1;
      }
      const t = yield* evaluate(repair(trial));
      if (atLeast(t, pop[i])) pop[i] = t;
      if (beats(t, best)) {
        const gain = best.v > 0 || Math.abs(best.f - t.f) > convergence * 1e-3 * Math.max(1, Math.abs(best.f));
        best = t;
        if (gain) improvedAt = now();
      }
    }
    if (halted) break;
    if ((now() - improvedAt) / 1000 >= maxTimeNoImprove) { halted = 'noImprovement'; break; }
    // Converged: almost all of the population sits within the convergence tolerance of the best.
    if (best.v === 0) {
      const fs = pop.filter((p) => p.v === 0).map((p) => p.f).sort((p, q) => p - q);
      if (fs.length >= 0.99 * size) {
        const near = fs[Math.floor(0.99 * (fs.length - 1))];
        if (Math.abs(near - best.f) <= convergence * Math.max(1, Math.abs(best.f))) { halted = 'converged'; break; }
      }
    }
  }
  return finish(halted);

  function finish(reason) {
    if (!best || !Number.isFinite(best.f)) return { status: best ? 'error' : reason, x: best?.x || null, objective: NaN, feasible: false, iterations: generations, evals };
    const status = best.v > 0 ? (reason === 'stopped' || reason === 'timeLimit' ? reason : 'infeasible') : reason;
    return { status, x: best.x, objective: best.f, feasible: best.v === 0, iterations: generations, evals };
  }
}
