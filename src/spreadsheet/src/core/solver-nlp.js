/**
 * Solver ▸ GRG Nonlinear: smooth nonlinear models. An augmented Lagrangian (Powell–Hestenes–Rockafellar)
 * folds the constraints into the objective; each subproblem is minimized over the variables' bounds by a
 * projected quasi-Newton (BFGS) method whose gradients are finite differences of the workbook's own
 * recalculation. Like a reduced-gradient method it moves only the variables free of their bounds and
 * reports the gradient left on the ones held at a bound.
 *
 * problem = { n, x0, lb, ub, rows: [{ rel: '<=' | '=' | '>=', scale }], evaluate(x) → { f, g: [] } }
 *   f is minimized; row i asks g[i] (rel) 0. A value that is not a finite number makes the point unusable.
 * Every evaluation is a yield point (yield { evals }), so a caller can spread the work over many frames.
 */

/** Seeded uniform random numbers in [0, 1). */
export function seededRandom(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clampTo = (x, lb, ub) => x.map((v, i) => Math.min(ub[i], Math.max(lb[i], v)));
const finite = (r) => r && Number.isFinite(r.f) && r.g.every(Number.isFinite);

/** How far a point is from meeting each row, in the row's own units. */
export function violations(rows, g) {
  return rows.map((row, i) => (row.rel === '<=' ? Math.max(0, g[i]) : row.rel === '>=' ? Math.max(0, -g[i]) : Math.abs(g[i])));
}

/** True when every row is met within `precision` (scaled by the row's magnitude). */
export function feasible(rows, g, precision) {
  return violations(rows, g).every((v, i) => v <= precision * Math.max(1, rows[i].scale || 1));
}

/**
 * Minimize. options: { precision, convergence, maxIter, central, autoScale, stop() → reason | null }.
 * Returns { status: 'optimal' | 'converged' | 'infeasible' | 'unbounded' | 'iterationLimit' | 'stopped' | 'timeLimit' | 'error',
 *   x, objective, g, multipliers (per row, ∂objective/∂right side in the minimized sense), reducedGradient, iterations, evals }.
 */
export function* solveNLP(problem, { precision = 1e-6, convergence = 1e-4, maxIter = 1000, central = false, autoScale = true, stop = () => null } = {}) {
  const { n, rows } = problem;
  const m = rows.length;
  const lb = problem.lb.map((v) => (Number.isFinite(v) ? v : -Infinity));
  const ub = problem.ub.map((v) => (Number.isFinite(v) ? v : Infinity));
  let evals = 0, iterations = 0;
  let halted = null;
  const evaluate = function* (x) {
    evals++;
    const r = problem.evaluate(x);
    yield { evals, iterations };
    return finite(r) ? r : null;
  };
  // A row's canonical form: c ≤ 0 for an inequality, h = 0 for an equality.
  const sign = rows.map((row) => (row.rel === '>=' ? -1 : 1));
  const isEq = rows.map((row) => row.rel === '=');

  let x = clampTo(problem.x0.map((v) => (Number.isFinite(v) ? v : 0)), lb, ub);
  let at = yield* evaluate(x);
  if (!at) {
    // Try the middle of the box, then zero: a formula may fail only at its starting point.
    for (const alt of [x.map((v, i) => (Number.isFinite(lb[i]) && Number.isFinite(ub[i]) ? (lb[i] + ub[i]) / 2 : v + 1e-3)), clampTo(x.map(() => 0), lb, ub)]) {
      at = yield* evaluate(alt);
      if (at) { x = alt; break; }
    }
    if (!at) return { status: 'error', x, objective: NaN, iterations, evals };
  }

  /** Jacobian of f and every row at x by finite differences (columns are variables). */
  const jacobian = function* (x, base) {
    const Jf = new Float64Array(n);
    const Jg = Array.from({ length: m }, () => new Float64Array(n));
    for (let j = 0; j < n; j++) {
      const h = (central ? 6e-6 : 1.5e-8) * Math.max(1, Math.abs(x[j]));
      const up = x.slice(), down = x.slice();
      let hu = h, hd = central ? h : 0;
      if (x[j] + h > ub[j]) { hu = 0; hd = h; } // at the upper bound: a backward difference
      if (central && x[j] - h < lb[j]) hd = 0;
      up[j] = x[j] + hu; down[j] = x[j] - hd;
      const a = hu ? yield* evaluate(up) : base;
      const b = hd ? yield* evaluate(down) : base;
      if (!a || !b || hu + hd === 0) continue;
      const span = hu + hd;
      Jf[j] = (a.f - b.f) / span;
      for (let i = 0; i < m; i++) Jg[i][j] = (a.g[i] - b.g[i]) / span;
    }
    return { Jf, Jg };
  };

  // Scaling from the starting gradients, so a model in millions and one in fractions step alike.
  let J = yield* jacobian(x, at);
  const norm = (v) => Math.sqrt(v.reduce((s, a) => s + a * a, 0));
  const fs = autoScale ? 1 / Math.max(1e-8, Math.min(1e8, Math.max(1, norm(J.Jf), Math.abs(at.f) * 1e-3))) : 1;
  const cs = rows.map((_, i) => (autoScale ? 1 / Math.max(1e-6, Math.min(1e6, Math.max(1, norm(J.Jg[i])))) : 1));

  const lam = new Float64Array(m);
  let rho = 100;
  const merit = (r) => {
    let v = r.f * fs;
    for (let i = 0; i < m; i++) {
      const c = sign[i] * r.g[i] * cs[i];
      if (isEq[i]) v += lam[i] * c + (rho / 2) * c * c;
      else { const t = Math.max(0, lam[i] + rho * c); v += (t * t - lam[i] * lam[i]) / (2 * rho); }
    }
    return v;
  };
  const meritGradient = (r, J) => {
    const g = new Float64Array(n);
    for (let j = 0; j < n; j++) g[j] = J.Jf[j] * fs;
    for (let i = 0; i < m; i++) {
      const c = sign[i] * r.g[i] * cs[i];
      const w = (isEq[i] ? lam[i] + rho * c : Math.max(0, lam[i] + rho * c)) * sign[i] * cs[i];
      if (!w) continue;
      const row = J.Jg[i];
      for (let j = 0; j < n; j++) g[j] += w * row[j];
    }
    return g;
  };
  const worst = (r) => Math.max(0, ...violations(rows, r.g).map((v, i) => v / Math.max(1, rows[i].scale || 1)));
  const big = (r, x) => r.f * fs < -1e20 || x.some((v) => Math.abs(v) > 1e20);
  // The best point seen that meets every row, to restart from when the penalty let the search wander off.
  let bestFeasible = null;
  const note = (r, x) => {
    if (worst(r) <= precision && (!bestFeasible || r.f < bestFeasible.at.f)) bestFeasible = { x, at: r };
  };

  /** Minimize the merit function over the box from x; returns the point reached and whether it is stationary. */
  const inner = function* (x, at, J) {
    let H = null; // inverse Hessian estimate, null for the identity
    let phi = merit(at), grad = meritGradient(at, J);
    let flat = 0, stationary = false;
    for (let k = 0; k < 400; k++) {
      halted = stop();
      if (halted) break;
      if (iterations >= maxIter) { halted = 'iterationLimit'; break; }
      iterations++;
      const free = grad.map((gj, j) => !((x[j] <= lb[j] + 1e-12 && gj > 0) || (x[j] >= ub[j] - 1e-12 && gj < 0)));
      // Projected gradient: how far a unit steepest-descent step moves inside the box.
      let pg = 0;
      for (let j = 0; j < n; j++) pg = Math.max(pg, Math.abs(Math.min(ub[j], Math.max(lb[j], x[j] - grad[j])) - x[j]));
      if (pg <= 1e-9) { stationary = true; break; }
      let d = new Float64Array(n);
      const qn = () => {
        for (let i = 0; i < n; i++) {
          if (!free[i]) continue;
          let s = 0;
          for (let j = 0; j < n; j++) if (free[j]) s += (H ? H[i][j] : i === j ? 1 : 0) * grad[j];
          d[i] = -s;
        }
      };
      qn();
      let slope = 0;
      for (let j = 0; j < n; j++) slope += grad[j] * d[j];
      if (!(slope < 0)) { H = null; qn(); slope = 0; for (let j = 0; j < n; j++) slope += grad[j] * d[j]; }
      if (!(slope < 0)) { stationary = true; break; }
      const dmax = Math.max(...d.map(Math.abs));
      const xmax = Math.max(1, ...x.map(Math.abs));
      let alpha = H ? 1 : Math.min(1, (0.1 * xmax) / dmax);
      const tryAt = function* (a) {
        const xt = clampTo(x.map((v, j) => v + a * d[j]), lb, ub);
        const rt = yield* evaluate(xt);
        if (!rt) return null;
        let dec = 0;
        for (let j = 0; j < n; j++) dec += grad[j] * (xt[j] - x[j]);
        return { xt, rt, phit: merit(rt), dec };
      };
      let step = null;
      for (let tries = 0; tries < 40; tries++) {
        const t = yield* tryAt(alpha);
        if (t && t.phit <= phi + 1e-4 * t.dec && t.xt.some((v, j) => v !== x[j])) { step = t; break; }
        alpha *= t && Number.isFinite(t.phit) ? Math.max(0.1, Math.min(0.5, (-0.5 * slope * alpha) / (t.phit - phi - slope * alpha) || 0.5)) : 0.25;
      }
      if (step && alpha >= 1 && step.phit < phi) {
        // The full step worked: reach further while the merit keeps falling (an unbounded or long valley).
        for (let grow = 0; grow < 30; grow++) {
          const t = yield* tryAt(alpha * 4);
          if (!t || !(t.phit <= step.phit + 1e-4 * (t.dec - step.dec)) || !(t.phit < step.phit)) break;
          alpha *= 4; step = t;
          if (big(t.rt, t.xt)) break;
        }
      }
      if (!step) {
        if (H) { H = null; continue; }
        stationary = true;
        break;
      }
      const Jn = yield* jacobian(step.xt, step.rt);
      const gn = meritGradient(step.rt, Jn);
      // BFGS update of the inverse Hessian from the step and the change in gradient.
      const s = step.xt.map((v, j) => v - x[j]);
      const y = Array.from(gn, (v, j) => v - grad[j]);
      let sy = 0;
      for (let j = 0; j < n; j++) sy += s[j] * y[j];
      if (sy > 1e-12 * norm(s) * norm(y)) {
        if (!H) {
          let yy = 0;
          for (let j = 0; j < n; j++) yy += y[j] * y[j];
          const g0 = sy / yy; // the first update starts from a scaled identity
          H = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? g0 : 0)));
        }
        const r = 1 / sy;
        const Hy = H.map((row) => row.reduce((acc, v, j) => acc + v * y[j], 0));
        const yHy = y.reduce((acc, v, j) => acc + v * Hy[j], 0);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
          H[i][j] += -r * (Hy[i] * s[j] + s[i] * Hy[j]) + (r * r * yHy + r) * s[i] * s[j];
        }
      }
      const change = Math.abs(step.phit - phi);
      x = step.xt; at = step.rt; J = Jn; grad = gn;
      note(at, x);
      const before = phi;
      phi = step.phit;
      if (big(at, x)) break;
      flat = change <= convergence * 1e-3 * Math.max(1, Math.abs(before)) ? flat + 1 : 0;
      if (flat >= 5) break;
      if (Math.max(...s.map(Math.abs)) <= 1e-13 * Math.max(1, ...x.map(Math.abs))) { stationary = true; break; }
    }
    return { x, at, J, stationary };
  };

  note(at, x);
  let lastViolation = Infinity;
  let stationary = false;
  let restarts = 0;
  for (let outer = 0; outer < 60; outer++) {
    ({ x, at, J, stationary } = yield* inner(x, at, J));
    if (halted) break;
    if (big(at, x)) return { status: 'unbounded', x, objective: at.f, g: at.g, iterations, evals };
    const v = worst(at);
    const ok = v <= precision;
    if (ok && (stationary || outer > 0) && (m === 0 || maxMultiplierChange(at) <= Math.sqrt(precision))) break;
    if (!ok && stationary && bestFeasible && restarts < 2 && v >= lastViolation * 0.99) {
      // Stuck outside the feasible region (a constraint whose gradient vanishes there): go back to the best
      // feasible point with a much stiffer penalty.
      restarts++;
      rho = Math.min(1e12, rho * 100);
      x = bestFeasible.x; at = bestFeasible.at;
      J = yield* jacobian(x, at);
      lam.fill(0);
      lastViolation = Infinity;
      continue;
    }
    if (!ok && v > 0.25 * lastViolation) rho = Math.min(1e12, rho * 10);
    lastViolation = v;
    for (let i = 0; i < m; i++) {
      const c = sign[i] * at.g[i] * cs[i];
      lam[i] = isEq[i] ? lam[i] + rho * c : Math.max(0, lam[i] + rho * c);
    }
    if (ok && m === 0) break;
  }
  function maxMultiplierChange(r) {
    let worstChange = 0;
    for (let i = 0; i < m; i++) {
      const c = sign[i] * r.g[i] * cs[i];
      const next = isEq[i] ? lam[i] + rho * c : Math.max(0, lam[i] + rho * c);
      worstChange = Math.max(worstChange, Math.abs(next - lam[i]) / Math.max(1, Math.abs(lam[i])));
    }
    return worstChange;
  }
  const feasibleNow = worst(at) <= precision;
  // Multipliers in the problem's units: ∂f/∂(right side) for each row, and the reduced gradient of each variable.
  const multipliers = rows.map((row, i) => {
    const c = sign[i] * at.g[i] * cs[i];
    const l = isEq[i] ? lam[i] + rho * c : Math.max(0, lam[i] + rho * c);
    // g = lhs - rhs, so a rise in the right side moves g down: ∂f/∂rhs = sign·λ·cs / fs with the sign of -∂c/∂rhs.
    return (sign[i] * l * cs[i]) / fs;
  });
  const reducedGradient = Array.from(J.Jf, (v, j) => {
    let gj = v;
    rows.forEach((_, i) => { gj += multipliers[i] * J.Jg[i][j]; });
    const atBound = x[j] <= lb[j] + 1e-9 * Math.max(1, Math.abs(lb[j])) || x[j] >= ub[j] - 1e-9 * Math.max(1, Math.abs(ub[j]));
    return atBound ? gj : 0;
  });
  // First-order optimality: the gradient of the Lagrangian vanishes on the variables free of their bounds.
  let kkt = 0, scaleG = 1;
  for (let j = 0; j < n; j++) {
    scaleG = Math.max(scaleG, Math.abs(J.Jf[j]));
    let gj = J.Jf[j];
    rows.forEach((_, i) => { gj += multipliers[i] * J.Jg[i][j]; });
    const pushOut = (x[j] <= lb[j] + 1e-9 * Math.max(1, Math.abs(lb[j])) && gj > 0) || (x[j] >= ub[j] - 1e-9 * Math.max(1, Math.abs(ub[j])) && gj < 0);
    if (!pushOut) kkt = Math.max(kkt, Math.abs(gj));
  }
  const status = halted || (!feasibleNow ? 'infeasible' : stationary || kkt <= 1e-4 * scaleG ? 'optimal' : 'converged');
  return { status, x, objective: at.f, g: at.g, multipliers: multipliers.map((v) => -v), reducedGradient, iterations, evals, feasible: feasibleNow };
}

/**
 * Multistart: the local method from several starting points spread over the bounds (seeded), keeping the
 * best feasible result. options as solveNLP plus { starts, seed }.
 */
export function* solveNLPMultistart(problem, options = {}) {
  const { starts = 20, seed = 0 } = options;
  const rand = seededRandom(seed || Date.now());
  const lo = problem.lb.map((v, i) => (Number.isFinite(v) ? v : (problem.x0[i] || 0) - 10 * Math.max(1, Math.abs(problem.x0[i] || 0))));
  const hi = problem.ub.map((v, i) => (Number.isFinite(v) ? v : (problem.x0[i] || 0) + 10 * Math.max(1, Math.abs(problem.x0[i] || 0))));
  let best = yield* solveNLP(problem, options);
  let iterations = best.iterations, evals = best.evals;
  const better = (a, b) => (a.feasible && !b.feasible) || (a.feasible === b.feasible && a.objective < b.objective);
  for (let k = 1; k < starts; k++) {
    if (best.status === 'stopped' || best.status === 'timeLimit' || best.status === 'unbounded' || options.stop?.()) break;
    const x0 = lo.map((l, i) => l + rand() * (hi[i] - l));
    const r = yield* solveNLP({ ...problem, x0 }, options);
    iterations += r.iterations; evals += r.evals;
    if (r.status === 'unbounded') { best = r; break; }
    if (r.x && (better(r, best) || !best.x)) best = r;
    if (r.status === 'stopped' || r.status === 'timeLimit') { best = { ...best, status: r.status }; break; }
  }
  return { ...best, iterations, evals };
}
