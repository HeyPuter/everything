/**
 * Solver ▸ Simplex LP: a bounded-variable primal simplex over a dense tableau, in two phases, and the
 * sensitivity figures read off its final tableau. Pure numbers: the workbook side (solver.js) turns a
 * sheet's model into the arrays this takes.
 *
 *   minimize c·x  subject to  A_i·x (<=|=|>=) b_i,  lb <= x <= ub   (bounds may be ±Infinity)
 *
 * Each row gets a slack (A_i·x + s_i = b_i) whose bounds carry the relation, so no row is ever rewritten.
 * Nonbasic variables rest at one of their bounds (a free one at zero); a variable whose two bounds are both
 * finite can cross from one to the other without a pivot (a bound flip). Phase one starts from an
 * artificial basis and minimizes the artificials' sum; phase two the real costs.
 *
 * Pricing is Dantzig's (the most negative reduced cost) until a run of degenerate pivots suggests a cycle,
 * then Bland's smallest-index rule, which cannot cycle, until the objective moves again.
 */

const FREE = 0, AT_LOWER = 1, AT_UPPER = 2, BASIC = 3;

/**
 * Solve the LP. lp = { c, A, rel: ['<='|'='|'>='], b, lb, ub }, options { maxIter, tol }.
 * Returns { status: 'optimal' | 'infeasible' | 'unbounded' | 'iterationLimit', x, objective, iterations, tableau }
 * where `tableau` (when optimal) holds what sensitivity() needs.
 */
export function solveLP(lp, { maxIter = 50000, tol = 1e-9 } = {}) {
  const n = lp.c.length, m = lp.b.length;
  const N = n + 2 * m;
  const lo = new Float64Array(N), hi = new Float64Array(N), cost = new Float64Array(N);
  for (let j = 0; j < n; j++) {
    lo[j] = lp.lb?.[j] ?? 0; hi[j] = lp.ub?.[j] ?? Infinity;
    if (lo[j] > hi[j] + tol) return { status: 'infeasible', x: null, objective: NaN, iterations: 0 };
    if (lo[j] > hi[j]) hi[j] = lo[j];
  }
  for (let i = 0; i < m; i++) {
    const rel = lp.rel[i];
    lo[n + i] = rel === '>=' ? -Infinity : 0;
    hi[n + i] = rel === '<=' ? Infinity : 0;
    lo[n + m + i] = 0; hi[n + m + i] = Infinity;
  }
  // Nonbasic starting values: a finite bound, else zero.
  const val = new Float64Array(N);
  const state = new Uint8Array(N);
  for (let j = 0; j < n + m; j++) {
    if (Number.isFinite(lo[j])) { val[j] = lo[j]; state[j] = AT_LOWER; }
    else if (Number.isFinite(hi[j])) { val[j] = hi[j]; state[j] = AT_UPPER; }
    else { val[j] = 0; state[j] = FREE; }
  }
  // Tableau rows: B⁻¹[A I σI]; the basis starts on the artificials, signed so each starts nonnegative.
  const T = [];
  const basis = new Int32Array(m);
  const xB = new Float64Array(m);
  const scale = Math.max(1, ...lp.b.map(Math.abs));
  for (let i = 0; i < m; i++) {
    let r = lp.b[i];
    const row = lp.A[i];
    for (let j = 0; j < n; j++) if (row[j]) r -= row[j] * val[j];
    const sigma = r >= 0 ? 1 : -1;
    const t = new Float64Array(N);
    for (let j = 0; j < n; j++) t[j] = sigma * (row[j] || 0);
    t[n + i] = sigma;
    t[n + m + i] = 1;
    T.push(t);
    basis[i] = n + m + i;
    state[n + m + i] = BASIC;
    xB[i] = Math.abs(r);
  }
  let iterations = 0;
  const d = new Float64Array(N); // reduced costs

  const price = () => {
    for (let j = 0; j < N; j++) d[j] = cost[j];
    for (let i = 0; i < m; i++) {
      const cb = cost[basis[i]];
      if (!cb) continue;
      const t = T[i];
      for (let j = 0; j < N; j++) if (t[j]) d[j] -= cb * t[j];
    }
  };

  const pivot = (r, q) => {
    const pr = T[r];
    const p = pr[q];
    for (let j = 0; j < N; j++) pr[j] /= p;
    pr[q] = 1;
    for (let i = 0; i < m; i++) {
      if (i === r) continue;
      const t = T[i];
      const f = t[q];
      if (!f) continue;
      for (let j = 0; j < N; j++) if (pr[j]) t[j] -= f * pr[j];
      t[q] = 0;
    }
    const f = d[q];
    if (f) { for (let j = 0; j < N; j++) if (pr[j]) d[j] -= f * pr[j]; d[q] = 0; }
  };

  /** Run simplex iterations on the current costs. Returns 'optimal' | 'unbounded' | 'iterationLimit'. */
  const iterate = () => {
    price();
    let degenerate = 0;
    for (;;) {
      if (iterations >= maxIter) return 'iterationLimit';
      const bland = degenerate > 50;
      // Entering: an improving nonbasic column.
      let q = -1, best = 0;
      for (let j = 0; j < N; j++) {
        const s = state[j];
        if (s === BASIC || lo[j] === hi[j]) continue;
        const dj = d[j];
        const gain = s === AT_LOWER ? -dj : s === AT_UPPER ? dj : Math.abs(dj);
        if (gain > tol * (1 + Math.abs(cost[j]))) {
          if (bland) { q = j; break; }
          if (gain > best) { best = gain; q = j; }
        }
      }
      if (q < 0) return 'optimal';
      const dir = state[q] === AT_LOWER ? 1 : state[q] === AT_UPPER ? -1 : d[q] < 0 ? 1 : -1;
      // Ratio test: the first basic variable to reach a bound, or the entering one reaching its other bound.
      let theta = hi[q] - lo[q];
      let leave = -1, leaveTo = 0, leaveAlpha = 0;
      for (let i = 0; i < m; i++) {
        const alpha = T[i][q] * dir;
        if (Math.abs(alpha) <= 1e-11) continue;
        const k = basis[i];
        let lim;
        if (alpha > 0) { if (!Number.isFinite(lo[k])) continue; lim = (xB[i] - lo[k]) / alpha; }
        else { if (!Number.isFinite(hi[k])) continue; lim = (hi[k] - xB[i]) / -alpha; }
        if (lim < 0) lim = 0;
        // A strictly nearer bound wins; on a tie, Bland's rule takes the smallest index, else the largest pivot
        // (the steadier one). A tie with the entering variable's own bound flip keeps the flip: no pivot needed.
        const nearer = lim < theta - 1e-12;
        const tie = !nearer && leave >= 0 && lim <= theta + 1e-12
          && (bland ? k < basis[leave] : Math.abs(alpha) > Math.abs(leaveAlpha));
        if (nearer || tie) { theta = lim; leave = i; leaveTo = alpha > 0 ? AT_LOWER : AT_UPPER; leaveAlpha = alpha; }
      }
      if (!Number.isFinite(theta)) return 'unbounded';
      iterations++;
      degenerate = theta <= 1e-12 ? degenerate + 1 : 0;
      if (theta) {
        for (let i = 0; i < m; i++) if (T[i][q]) xB[i] -= T[i][q] * dir * theta;
      }
      const enteringValue = val[q] + dir * theta;
      if (leave < 0) {
        // Bound flip: no basis change.
        state[q] = state[q] === AT_LOWER ? AT_UPPER : AT_LOWER;
        val[q] = state[q] === AT_LOWER ? lo[q] : hi[q];
        continue;
      }
      const k = basis[leave];
      state[k] = leaveTo;
      val[k] = leaveTo === AT_LOWER ? lo[k] : hi[k];
      pivot(leave, q);
      basis[leave] = q;
      state[q] = BASIC;
      xB[leave] = enteringValue;
    }
  };

  // Phase one: minimize the artificials.
  for (let i = 0; i < m; i++) cost[n + m + i] = 1;
  let status = m ? iterate() : 'optimal';
  if (status === 'iterationLimit') return { status, x: null, objective: NaN, iterations };
  let infeasibility = 0;
  for (let i = 0; i < m; i++) if (basis[i] >= n + m) infeasibility += Math.max(0, xB[i]);
  if (infeasibility > 1e-7 * scale) return { status: 'infeasible', x: null, objective: NaN, iterations };
  // Fix the artificials at zero and pivot those still basic out wherever a real column can take their place.
  for (let i = 0; i < m; i++) { cost[n + m + i] = 0; hi[n + m + i] = 0; }
  for (let j = n + m; j < N; j++) if (state[j] !== BASIC) { state[j] = AT_LOWER; val[j] = 0; }
  price();
  for (let i = 0; i < m; i++) {
    if (basis[i] < n + m) continue;
    let q = -1, big = 1e-9;
    for (let j = 0; j < n + m; j++) if (state[j] !== BASIC && Math.abs(T[i][j]) > big) { big = Math.abs(T[i][j]); q = j; }
    if (q < 0) continue; // a redundant row: its artificial stays basic, fixed at zero
    const k = basis[i];
    state[k] = AT_LOWER; val[k] = 0;
    const enteringValue = val[q];
    // Degenerate pivot: the artificial is zero, so every basic value stays.
    pivot(i, q);
    basis[i] = q; state[q] = BASIC; xB[i] = enteringValue;
  }
  // Phase two.
  for (let j = 0; j < n; j++) cost[j] = lp.c[j];
  status = iterate();
  const x = new Array(n);
  for (let j = 0; j < n; j++) x[j] = val[j];
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = xB[i];
  let objective = 0;
  for (let j = 0; j < n; j++) objective += lp.c[j] * x[j];
  if (status !== 'optimal') return { status, x, objective, iterations };
  price();
  return { status, x, objective, iterations, tableau: { T, basis, xB, d, state, lo, hi, n, m, val } };
}

/**
 * Sensitivity of an optimal solution (for the minimization solved): per variable its reduced cost and
 * how far its cost can rise or fall before the basis changes; per row its dual value (the objective's
 * change per unit of right-hand side) and how far the right-hand side can rise or fall before it does.
 */
export function sensitivity(result) {
  const t = result.tableau;
  if (!t) return null;
  const { T, basis, xB, d, state, lo, hi, n, m } = t;
  const N = n + 2 * m;
  const eps = 1e-9;
  const rowOf = new Int32Array(N).fill(-1);
  for (let i = 0; i < m; i++) rowOf[basis[i]] = i;
  const variables = [];
  for (let j = 0; j < n; j++) {
    const r = rowOf[j];
    if (r < 0) {
      // Nonbasic: its reduced cost may shrink to zero, the other way is free.
      const dj = d[j];
      if (lo[j] === hi[j]) variables.push({ reducedCost: dj, increase: Infinity, decrease: Infinity });
      else if (state[j] === AT_UPPER) variables.push({ reducedCost: dj, increase: Math.max(0, -dj), decrease: Infinity });
      else if (state[j] === FREE) variables.push({ reducedCost: dj, increase: 0, decrease: 0 });
      else variables.push({ reducedCost: dj, increase: Infinity, decrease: Math.max(0, dj) });
      continue;
    }
    // Basic: a change Δ in its cost moves every nonbasic reduced cost by -Δ·T[r][k].
    let up = Infinity, down = Infinity;
    for (let k = 0; k < N; k++) {
      if (rowOf[k] >= 0 || lo[k] === hi[k]) continue;
      const a = T[r][k];
      if (Math.abs(a) <= eps) continue;
      const dk = d[k];
      if (state[k] === FREE) { up = 0; down = 0; continue; }
      // At its lower bound d_k - Δa must stay ≥ 0; at the upper ≤ 0.
      const sign = state[k] === AT_LOWER ? 1 : -1;
      const room = Math.max(0, sign * dk);
      const rate = sign * a; // Δ·rate may not exceed room
      if (rate > 0) up = Math.min(up, room / rate);
      else down = Math.min(down, room / -rate);
    }
    variables.push({ reducedCost: 0, increase: up, decrease: down });
  }
  const rows = [];
  for (let i = 0; i < m; i++) {
    const s = n + i;
    const dual = -d[s] || 0;
    // Raising b_i by Δ moves the basic values by Δ·B⁻¹e_i, the slack's column.
    let up = Infinity, down = Infinity;
    for (let k = 0; k < m; k++) {
      const rate = T[k][s];
      if (Math.abs(rate) <= eps) continue;
      const b = basis[k], v = xB[k];
      const toLow = Number.isFinite(lo[b]) ? v - lo[b] : Infinity, toHigh = Number.isFinite(hi[b]) ? hi[b] - v : Infinity;
      if (rate > 0) { up = Math.min(up, toHigh / rate); down = Math.min(down, toLow / rate); }
      else { up = Math.min(up, toLow / -rate); down = Math.min(down, toHigh / -rate); }
    }
    rows.push({ dual, increase: Math.max(0, up), decrease: Math.max(0, down) });
  }
  return { variables, rows };
}

/**
 * Branch and bound over a relaxation for integer variables and all-different groups. `relax(lb, ub)` is a
 * generator returning { status, x, objective } for the minimization within those bounds. Yields
 * { subproblems, incumbent } between subproblems. Returns { status, x, objective, subproblems, feasibleFound }.
 * options: { integer: bool[], groups: [[j...]], intTol, gap (relative), maxNodes, maxFeasible, stop() }
 */
export function* branchAndBound(relax, lb0, ub0, { integer, groups = [], intTol = 1e-6, gap = 0, maxNodes = Infinity, maxFeasible = Infinity, stop = () => null } = {}) {
  const n = lb0.length;
  const isInt = integer || new Array(n).fill(false);
  const stack = [{ lb: lb0.slice(), ub: ub0.slice() }];
  let best = null, bestObj = Infinity;
  let nodes = 0, found = 0, limit = null, sawUnbounded = false;
  for (let j = 0; j < n; j++) if (isInt[j]) { stack[0].lb[j] = Math.ceil(stack[0].lb[j] - intTol); stack[0].ub[j] = Math.floor(stack[0].ub[j] + intTol); }
  while (stack.length) {
    const reason = stop();
    if (reason) { limit = reason; break; }
    if (nodes >= maxNodes) { limit = 'nodeLimit'; break; }
    if (found >= maxFeasible) { limit = 'feasibleLimit'; break; }
    const node = stack.pop();
    if (node.lb.some((l, j) => l > node.ub[j])) continue;
    nodes++;
    const res = yield* relax(node.lb, node.ub);
    yield { subproblems: nodes, incumbent: best ? bestObj : null };
    if (res.status === 'unbounded') { sawUnbounded = true; if (!best) { limit = null; return { status: 'unbounded', x: res.x, objective: -Infinity, subproblems: nodes, feasibleFound: found }; } continue; }
    if (res.status !== 'optimal' && res.status !== 'converged') {
      if (res.status === 'stopped' || res.status === 'timeLimit') { limit = res.status; break; }
      continue;
    }
    if (best && res.objective >= bestObj - Math.max(1e-9, gap * Math.abs(bestObj))) continue;
    // Branch on the most fractional integer variable.
    let j = -1, frac = intTol;
    for (let k = 0; k < n; k++) {
      if (!isInt[k]) continue;
      const f = Math.abs(res.x[k] - Math.round(res.x[k]));
      if (f > frac) { frac = f; j = k; }
    }
    if (j >= 0) {
      const v = res.x[j];
      const down = { lb: node.lb.slice(), ub: node.ub.slice() }, up = { lb: node.lb.slice(), ub: node.ub.slice() };
      down.ub[j] = Math.floor(v); up.lb[j] = Math.ceil(v);
      // Depth first, the nearer side on top.
      if (v - Math.floor(v) < 0.5) stack.push(up, down); else stack.push(down, up);
      continue;
    }
    const x = res.x.map((v, k) => (isInt[k] ? Math.round(v) : v));
    // All-different groups: two members on one value split into "below it" and "above it" for one of them.
    let clash = null;
    for (const g of groups) {
      const seen = new Map();
      for (const k of g) {
        const v = x[k];
        if (seen.has(v)) { clash = { k, v, other: seen.get(v) }; break; }
        seen.set(v, k);
      }
      if (clash) break;
    }
    if (clash) {
      const { k, v } = clash;
      const below = { lb: node.lb.slice(), ub: node.ub.slice() }, above = { lb: node.lb.slice(), ub: node.ub.slice() };
      below.ub[k] = v - 1; above.lb[k] = v + 1;
      stack.push(above, below);
      continue;
    }
    found++;
    best = x; bestObj = res.objective;
  }
  if (sawUnbounded && !best) return { status: 'unbounded', x: null, objective: -Infinity, subproblems: nodes, feasibleFound: found };
  if (!best) return { status: limit || 'infeasible', x: null, objective: NaN, subproblems: nodes, feasibleFound: found };
  return { status: limit ? limit : 'optimal', x: best, objective: bestObj, subproblems: nodes, feasibleFound: found, limited: !!limit };
}
