/**
 * Scientific Studio numerics (original). MATLAB-inspired — not MathWorks MATLAB.
 * Local matrices / solvers / plots only; no LIVE MATLAB Runtime (DOCUMENTED).
 */

/** @typedef {number[][]} Matrix */

/** @param {number} n @param {(i:number,j:number)=>number} fn @returns {Matrix} */
export function matrix(n, fn) {
  /** @type {Matrix} */
  const out = [];
  for (let i = 0; i < n; i += 1) {
    /** @type {number[]} */
    const row = [];
    for (let j = 0; j < n; j += 1) row.push(fn(i, j));
    out.push(row);
  }
  return out;
}

/** @param {number} n */
export function eye(n) {
  return matrix(n, (i, j) => (i === j ? 1 : 0));
}

/** @param {number} n @param {number} v */
export function zeros(n, v = 0) {
  return matrix(n, () => v);
}

/** @param {Matrix} a @param {Matrix} b */
export function add(a, b) {
  assertSame(a, b);
  return matrix(a.length, (i, j) => a[i][j] + b[i][j]);
}

/** @param {Matrix} a @param {Matrix} b */
export function mul(a, b) {
  if (a[0].length !== b.length) throw new Error('Incompatible shapes');
  const n = a.length;
  const m = b[0].length;
  const p = b.length;
  /** @type {Matrix} */
  const out = [];
  for (let i = 0; i < n; i += 1) {
    /** @type {number[]} */
    const row = [];
    for (let j = 0; j < m; j += 1) {
      let s = 0;
      for (let k = 0; k < p; k += 1) s += a[i][k] * b[k][j];
      row.push(s);
    }
    out.push(row);
  }
  return out;
}

/** @param {Matrix} a @param {number} s */
export function scale(a, s) {
  return matrix(a.length, (i, j) => a[i][j] * s);
}

/** Gaussian elimination for square Ax=b. @param {Matrix} A @param {number[]} b */
export function solve(A, b) {
  const n = A.length;
  if (b.length !== n) throw new Error('b length mismatch');
  /** @type {number[][]} */
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) throw new Error('Singular matrix');
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const div = M[col][col];
    for (let j = col; j <= n; j += 1) M[col][j] /= div;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j <= n; j += 1) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}

/** Sample y = f(x) for plotting. */
export function sample(fn, x0, x1, steps = 64) {
  /** @type {{x:number,y:number}[]} */
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const x = x0 + ((x1 - x0) * i) / steps;
    pts.push({ x, y: fn(x) });
  }
  return pts;
}

/**
 * Tiny command console parser.
 * Supports: eye N | zeros N | add | mul | solve | plot sin|cos
 * @param {string} line
 * @param {{ last?: Matrix, b?: number[] }} ctx
 */
export function evalCommand(line, ctx = {}) {
  const parts = line.trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  if (cmd === 'eye') {
    const n = Number(parts[1] || 3);
    const m = eye(n);
    return { ok: true, matrix: m, message: `eye(${n})` };
  }
  if (cmd === 'zeros') {
    const n = Number(parts[1] || 3);
    const m = zeros(n);
    return { ok: true, matrix: m, message: `zeros(${n})` };
  }
  if (cmd === 'add' && ctx.last) {
    const m = add(ctx.last, eye(ctx.last.length));
    return { ok: true, matrix: m, message: 'last + I' };
  }
  if (cmd === 'mul' && ctx.last) {
    const m = mul(ctx.last, ctx.last);
    return { ok: true, matrix: m, message: 'last * last' };
  }
  if (cmd === 'solve' && ctx.last) {
    const b = ctx.b || ctx.last.map((_, i) => (i === 0 ? 1 : 0));
    const x = solve(ctx.last, b);
    return { ok: true, vector: x, message: 'solve(last, b)' };
  }
  if (cmd === 'plot') {
    const kind = (parts[1] || 'sin').toLowerCase();
    const fn = kind === 'cos' ? Math.cos : Math.sin;
    return { ok: true, plot: sample(fn, 0, Math.PI * 2, 48), message: `plot ${kind}` };
  }
  return { ok: false, message: 'Commands: eye N | zeros N | add | mul | solve | plot sin|cos' };
}

/** @param {Matrix} a @param {Matrix} b */
function assertSame(a, b) {
  if (a.length !== b.length || a[0].length !== b[0].length) throw new Error('Shape mismatch');
}
