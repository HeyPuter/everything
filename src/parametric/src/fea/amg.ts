// Sparse block matrices and the linear solver: preconditioned conjugate
// gradients with a smoothed aggregation algebraic multigrid preconditioner
// (Vanek, Mandel and Brezina 1996) built for elasticity: nodes are grouped
// into aggregates, each aggregate's six rigid body motions (three
// translations, three rotations) span its coarse degrees of freedom, and the
// tentative prolongator is smoothed with one damped block Jacobi step. A
// V-cycle with block Gauss-Seidel smoothing (forward before, backward after:
// symmetric, so conjugate gradients may use it) and a dense Cholesky solve on
// the coarsest level. Block Jacobi is kept as a fallback preconditioner.
//
// Matrices are stored in block rows: the fine level in 3 x 3 node blocks,
// coarse levels in 6 x 6 aggregate blocks.

export interface BlockMatrix {
  /** Block rows (= block columns). */
  n: number;
  /** Block size. */
  b: number;
  rowPtr: Int32Array;
  col: Int32Array;
  /** b * b values per block, row-major. */
  val: Float64Array;
}

/** Prolongator: n fine block rows of size b, m coarse block columns of size c. */
interface Prolongator {
  n: number;
  m: number;
  b: number;
  c: number;
  rowPtr: Int32Array;
  col: Int32Array;
  val: Float64Array;
}

/** y = A x */
export function matvec(A: BlockMatrix, x: Float64Array, y: Float64Array) {
  const { n, b, rowPtr, col, val } = A;
  if (b === 3) {
    for (let i = 0; i < n; i++) {
      let y0 = 0, y1 = 0, y2 = 0;
      for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) {
        const j = col[q] * 3, v = q * 9;
        const x0 = x[j], x1 = x[j + 1], x2 = x[j + 2];
        y0 += val[v] * x0 + val[v + 1] * x1 + val[v + 2] * x2;
        y1 += val[v + 3] * x0 + val[v + 4] * x1 + val[v + 5] * x2;
        y2 += val[v + 6] * x0 + val[v + 7] * x1 + val[v + 8] * x2;
      }
      y[i * 3] = y0; y[i * 3 + 1] = y1; y[i * 3 + 2] = y2;
    }
    return;
  }
  const bb = b * b;
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < b; r++) y[i * b + r] = 0;
    for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) {
      const j = col[q] * b, v = q * bb;
      for (let r = 0; r < b; r++) {
        let s = 0;
        for (let c = 0; c < b; c++) s += val[v + r * b + c] * x[j + c];
        y[i * b + r] += s;
      }
    }
  }
}

/** Sparsity pattern of the node blocks of a mesh (nodes sharing an element), columns sorted. */
export function meshPattern(nNodes: number, elems: Int32Array, perElem: number): BlockMatrix {
  const ne = elems.length / perElem;
  const start = new Int32Array(nNodes + 1);
  for (let q = 0; q < elems.length; q++) start[elems[q] + 1]++;
  for (let i = 0; i < nNodes; i++) start[i + 1] += start[i];
  const fill = start.slice();
  const items = new Int32Array(elems.length);
  for (let e = 0; e < ne; e++) for (let k = 0; k < perElem; k++) items[fill[elems[e * perElem + k]]++] = e;
  const stamp = new Int32Array(nNodes).fill(-1);
  const rowPtr = new Int32Array(nNodes + 1);
  const cols: number[] = [];
  const row: number[] = [];
  for (let i = 0; i < nNodes; i++) {
    row.length = 0;
    for (let q = start[i]; q < start[i + 1]; q++) {
      const e = items[q];
      for (let k = 0; k < perElem; k++) {
        const j = elems[e * perElem + k];
        if (stamp[j] !== i) { stamp[j] = i; row.push(j); }
      }
    }
    row.sort((a, b) => a - b);
    for (const j of row) cols.push(j);
    rowPtr[i + 1] = cols.length;
  }
  const col = Int32Array.from(cols);
  return { n: nNodes, b: 3, rowPtr, col, val: new Float64Array(col.length * 9) };
}

/** Position of block (i, j) in A, or -1. */
export function blockAt(A: BlockMatrix, i: number, j: number): number {
  let lo = A.rowPtr[i], hi = A.rowPtr[i + 1] - 1;
  const col = A.col;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const c = col[m];
    if (c === j) return m;
    if (c < j) lo = m + 1;
    else hi = m - 1;
  }
  return -1;
}

// ---------- small dense helpers ----------

/** Inverse of a symmetric positive b x b block (Gauss-Jordan); a singular one gives the inverse of its diagonal part where possible. */
function invertBlock(src: Float64Array, off: number, b: number, out: Float64Array, oOff: number) {
  const a = new Float64Array(b * b * 2);
  for (let r = 0; r < b; r++) { for (let c = 0; c < b; c++) a[r * 2 * b + c] = src[off + r * b + c]; a[r * 2 * b + b + r] = 1; }
  let scale = 0;
  for (let r = 0; r < b; r++) scale = Math.max(scale, Math.abs(src[off + r * b + r]));
  for (let c = 0; c < b; c++) {
    let p = c, pv = Math.abs(a[c * 2 * b + c]);
    for (let r = c + 1; r < b; r++) { const v = Math.abs(a[r * 2 * b + c]); if (v > pv) { pv = v; p = r; } }
    if (!(pv > 1e-12 * scale) || !(pv > 0)) {
      // A degree of freedom with no stiffness (a dummy coarse one): leave it alone.
      for (let r = 0; r < b; r++) a[r * 2 * b + c] = r === c ? 1 : 0;
      for (let k = 0; k < 2 * b; k++) a[c * 2 * b + k] = k === c || k === b + c ? 1 : 0;
      for (let r = 0; r < b; r++) if (r !== c) a[r * 2 * b + b + c] = 0;
      continue;
    }
    if (p !== c) for (let k = 0; k < 2 * b; k++) { const t = a[c * 2 * b + k]; a[c * 2 * b + k] = a[p * 2 * b + k]; a[p * 2 * b + k] = t; }
    const d = a[c * 2 * b + c];
    for (let k = 0; k < 2 * b; k++) a[c * 2 * b + k] /= d;
    for (let r = 0; r < b; r++) {
      if (r === c) continue;
      const f = a[r * 2 * b + c];
      if (f === 0) continue;
      for (let k = 0; k < 2 * b; k++) a[r * 2 * b + k] -= f * a[c * 2 * b + k];
    }
  }
  for (let r = 0; r < b; r++) for (let c = 0; c < b; c++) out[oOff + r * b + c] = a[r * 2 * b + b + c];
}

function blockDiagInverse(A: BlockMatrix): Float64Array {
  const { n, b } = A;
  const bb = b * b;
  const out = new Float64Array(n * bb);
  for (let i = 0; i < n; i++) {
    const q = blockAt(A, i, i);
    if (q < 0) { for (let r = 0; r < b; r++) out[i * bb + r * b + r] = 1; continue; }
    invertBlock(A.val, q * bb, b, out, i * bb);
  }
  return out;
}

// ---------- multigrid ----------

/** Strength of connection for aggregation (relative block norm). */
const THETA = 0.08;

interface Level {
  A: BlockMatrix;
  Dinv: Float64Array;
  P: Prolongator | null;
  /** Work vectors. */
  x: Float64Array;
  r: Float64Array;
  t: Float64Array;
}

export interface Preconditioner {
  apply(r: Float64Array, z: Float64Array): void;
  levels: number;
  description: string;
}

/** Block Jacobi preconditioner. */
export function blockJacobi(A: BlockMatrix): Preconditioner {
  const D = blockDiagInverse(A);
  const b = A.b, bb = b * b;
  return {
    levels: 1, description: 'block Jacobi',
    apply(r, z) {
      for (let i = 0; i < A.n; i++) for (let p = 0; p < b; p++) {
        let s = 0;
        for (let c = 0; c < b; c++) s += D[i * bb + p * b + c] * r[i * b + c];
        z[i * b + p] = s;
      }
    },
  };
}

/**
 * Smoothed aggregation multigrid for a 3D elasticity matrix in node blocks,
 * with the nodes' coordinates for the rigid body motions.
 */
export function smoothedAggregation(A: BlockMatrix, coords: Float64Array, opts: {
  coarsest?: number; progress?: (f: number) => void; debug?: (m: string) => void;
  /** Nodes whose unknowns are in their own frame: 3 x 3 rotation per node (columns: local axes in global coordinates), row-major. */
  frames?: Float64Array;
  /** Number of leading local unknowns of each node that are held (removed from the problem). */
  held?: Int8Array;
} = {}): Preconditioner {
  const coarsest = opts.coarsest ?? 900;
  // Rigid body motions of each node, about the centroid and scaled to the part's size (well conditioned).
  const n0 = A.n;
  const c0 = [0, 0, 0];
  for (let i = 0; i < n0; i++) for (let d = 0; d < 3; d++) c0[d] += coords[i * 3 + d] / n0;
  let L = 0;
  for (let i = 0; i < n0; i++) L = Math.max(L, Math.hypot(coords[i * 3] - c0[0], coords[i * 3 + 1] - c0[1], coords[i * 3 + 2] - c0[2]));
  L = L || 1;
  // B: per node b x 6 (row-major).
  let B: Float64Array = new Float64Array(n0 * 18);
  for (let i = 0; i < n0; i++) {
    const x = (coords[i * 3] - c0[0]) / L, y = (coords[i * 3 + 1] - c0[1]) / L, z = (coords[i * 3 + 2] - c0[2]) / L;
    // u = t + w x r: rows ux, uy, uz; columns tx, ty, tz, wx, wy, wz.
    B.set([1, 0, 0, 0, z, -y, 0, 1, 0, -z, 0, x, 0, 0, 1, y, -x, 0], i * 18);
    // The motions in the node's own frame (R^T B), none in the held directions.
    const R = opts.frames, k = opts.held?.[i] ?? 0;
    if (R && (k || R[i * 9] !== 1 || R[i * 9 + 4] !== 1 || R[i * 9 + 8] !== 1)) {
      const g = B.slice(i * 18, i * 18 + 18);
      for (let r = 0; r < 3; r++) for (let j = 0; j < 6; j++) B[i * 18 + r * 6 + j] = r < k ? 0 : R[i * 9 + r] * g[j] + R[i * 9 + 3 + r] * g[6 + j] + R[i * 9 + 6 + r] * g[12 + j];
    }
  }
  const levels: Level[] = [];
  let cur = A;
  for (let depth = 0; depth < 12; depth++) {
    const Dinv = blockDiagInverse(cur);
    const N = cur.n * cur.b;
    const lvl: Level = { A: cur, Dinv, P: null, x: new Float64Array(N), r: new Float64Array(N), t: new Float64Array(N) };
    levels.push(lvl);
    if (N <= coarsest) break;
    let t = performance.now();
    const lap = (what: string) => { const n = performance.now(); opts.debug?.(`level ${depth} ${what}: ${(n - t).toFixed(0)} ms`); t = n; };
    const agg = aggregate(cur, depth === 0 ? THETA : THETA * 0.5 ** depth);
    lap(`aggregate (${agg.count} of ${cur.n})`);
    if (agg.count * 6 >= N * 0.8 || agg.count < 2) break;
    const { P, Bc } = tentative(cur.b, agg, B);
    lap('tentative');
    const Ps = smoothProlongator(cur, Dinv, P);
    lap(`smooth (${Ps.col.length} blocks)`);
    const Ac = galerkin(cur, Ps);
    lap(`galerkin (${Ac.col.length} blocks)`);
    lvl.P = Ps;
    B = Bc;
    cur = Ac;
    opts.progress?.(Math.min(0.9, (depth + 1) / 4));
  }
  // Coarsest level: dense Cholesky (with a tiny shift if the level has dummy degrees of freedom).
  const last = levels[levels.length - 1];
  const dense = denseCholesky(last.A);
  const vcycle = (k: number, b: Float64Array, x: Float64Array) => {
    const lv = levels[k];
    if (k === levels.length - 1) { dense(b, x); return; }
    x.fill(0);
    gaussSeidel(lv.A, lv.Dinv, b, x, true);
    matvec(lv.A, x, lv.t);
    for (let i = 0; i < b.length; i++) lv.r[i] = b[i] - lv.t[i];
    const nx = levels[k + 1];
    const rc = new Float64Array(nx.A.n * nx.A.b);
    restrict(lv.P!, lv.r, rc);
    const xc = new Float64Array(rc.length);
    vcycle(k + 1, rc, xc);
    prolongAdd(lv.P!, xc, x);
    gaussSeidel(lv.A, lv.Dinv, b, x, false);
  };
  return {
    levels: levels.length,
    description: `smoothed aggregation multigrid, ${levels.length} levels (${levels.map((l) => l.A.n * l.A.b).join(', ')} unknowns)`,
    apply(r, z) { vcycle(0, r, z); },
  };
}

/** Groups nodes into aggregates: a node and its strongly connected neighbours, then the rest joined to a neighbour's. */
function aggregate(A: BlockMatrix, theta: number): { of: Int32Array; count: number } {
  const { n, b, rowPtr, col, val } = A;
  const bb = b * b;
  const norm = (q: number) => { let s = 0; for (let k = 0; k < bb; k++) s += val[q * bb + k] ** 2; return Math.sqrt(s); };
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) { const q = blockAt(A, i, i); diag[i] = q >= 0 ? norm(q) : 0; }
  const strong = (i: number, q: number) => { const j = col[q]; return j !== i && norm(q) > theta * Math.sqrt(diag[i] * diag[j]); };
  const of = new Int32Array(n).fill(-1);
  let count = 0;
  // Pass 1: whole neighbourhoods.
  for (let i = 0; i < n; i++) {
    if (of[i] >= 0) continue;
    let free = true, any = false;
    for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) if (strong(i, q)) { any = true; if (of[col[q]] >= 0) { free = false; break; } }
    if (!free || !any) continue;
    of[i] = count;
    for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) if (strong(i, q)) of[col[q]] = count;
    count++;
  }
  // Pass 2: the rest join the neighbouring aggregate they are most strongly connected to.
  const pass1 = of.slice();
  for (let i = 0; i < n; i++) {
    if (of[i] >= 0) continue;
    let best = -1, bv = 0;
    for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) {
      const j = col[q];
      if (j === i || pass1[j] < 0) continue;
      const v = norm(q) / Math.sqrt(diag[i] * diag[j] || 1);
      if (v > bv) { bv = v; best = pass1[j]; }
    }
    if (best >= 0) of[i] = best;
  }
  // Pass 3: whatever is left (isolated groups) makes aggregates of its own.
  for (let i = 0; i < n; i++) {
    if (of[i] >= 0) continue;
    of[i] = count;
    for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) if (of[col[q]] < 0) of[col[q]] = count;
    count++;
  }
  return { of, count };
}

/**
 * Tentative prolongator: per aggregate, the rigid body motions of its nodes
 * orthonormalised (QR); R becomes the coarse level's rigid body motions.
 */
function tentative(b: number, agg: { of: Int32Array; count: number }, B: Float64Array): { P: Prolongator; Bc: Float64Array } {
  const n = agg.of.length;
  const members: number[][] = Array.from({ length: agg.count }, () => []);
  for (let i = 0; i < n; i++) members[agg.of[i]].push(i);
  const c = 6;
  const val = new Float64Array(n * b * c);
  const Bc = new Float64Array(agg.count * c * c);
  for (let a = 0; a < agg.count; a++) {
    const nodes = members[a];
    const rows = nodes.length * b;
    // Q: rows x 6, column-major for Gram-Schmidt.
    const Q = new Float64Array(rows * c);
    nodes.forEach((i, k) => { for (let r = 0; r < b; r++) for (let j = 0; j < c; j++) Q[j * rows + k * b + r] = B[i * b * c + r * c + j]; });
    const R = new Float64Array(c * c);
    let ref = 0;
    for (let j = 0; j < c; j++) { let s = 0; for (let r = 0; r < rows; r++) s += Q[j * rows + r] ** 2; ref = Math.max(ref, Math.sqrt(s)); }
    for (let j = 0; j < c; j++) {
      // Twice, for orthogonality to machine precision.
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < j; k++) {
          let d = 0;
          for (let r = 0; r < rows; r++) d += Q[k * rows + r] * Q[j * rows + r];
          R[k * c + j] += d;
          for (let r = 0; r < rows; r++) Q[j * rows + r] -= d * Q[k * rows + r];
        }
      }
      let s = 0;
      for (let r = 0; r < rows; r++) s += Q[j * rows + r] ** 2;
      s = Math.sqrt(s);
      if (s > 1e-10 * ref) {
        R[j * c + j] = s;
        for (let r = 0; r < rows; r++) Q[j * rows + r] /= s;
      } else {
        // Dependent motion (too few nodes to tell it apart): a dummy coarse unknown.
        for (let r = 0; r < rows; r++) Q[j * rows + r] = 0;
      }
    }
    nodes.forEach((i, k) => { for (let r = 0; r < b; r++) for (let j = 0; j < c; j++) val[i * b * c + r * c + j] = Q[j * rows + k * b + r]; });
    Bc.set(R, a * c * c);
  }
  const rowPtr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowPtr[i + 1] = i + 1;
  return { P: { n, m: agg.count, b, c, rowPtr, col: Int32Array.from(agg.of), val }, Bc };
}

/** Largest eigenvalue of D^-1 A, by power iteration. */
function spectralRadius(A: BlockMatrix, Dinv: Float64Array): number {
  const N = A.n * A.b, b = A.b, bb = b * b;
  let x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = Math.sin(i * 12.9898 + 1) + 1.1;
  const y = new Float64Array(N);
  let lam = 1;
  for (let it = 0; it < 15; it++) {
    let nx = 0;
    for (let i = 0; i < N; i++) nx += x[i] * x[i];
    nx = Math.sqrt(nx);
    for (let i = 0; i < N; i++) x[i] /= nx;
    matvec(A, x, y);
    const z = new Float64Array(N);
    for (let i = 0; i < A.n; i++) for (let p = 0; p < b; p++) { let s = 0; for (let c = 0; c < b; c++) s += Dinv[i * bb + p * b + c] * y[i * b + c]; z[i * b + p] = s; }
    let nz = 0;
    for (let i = 0; i < N; i++) nz += z[i] * z[i];
    lam = Math.sqrt(nz);
    x = z;
  }
  return lam;
}

/** P = (I - w D^-1 A) P0, with w = 4 / (3 rho(D^-1 A)). */
function smoothProlongator(A: BlockMatrix, Dinv: Float64Array, P0: Prolongator): Prolongator {
  const w = 4 / 3 / spectralRadius(A, Dinv);
  const { n, b, rowPtr, col, val } = A;
  const c = P0.c, bb = b * b, bc = b * c;
  const rows: number[] = [];
  const outPtr = new Int32Array(n + 1);
  const outCol: number[] = [];
  const outVal: number[] = [];
  const acc = new Map<number, Float64Array>();
  const tmp = new Float64Array(bc);
  for (let i = 0; i < n; i++) {
    acc.clear();
    // (A P0) row block i: sum over j of A_ij P0_j (P0 has one block per row).
    for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) {
      const j = col[q];
      const J = P0.col[j];
      let blk = acc.get(J);
      if (!blk) { blk = new Float64Array(bc); acc.set(J, blk); }
      for (let r = 0; r < b; r++) for (let k = 0; k < c; k++) {
        let s = 0;
        for (let m = 0; m < b; m++) s += val[q * bb + r * b + m] * P0.val[j * bc + m * c + k];
        blk[r * c + k] += s;
      }
    }
    const own = P0.col[i];
    rows.length = 0;
    for (const J of acc.keys()) rows.push(J);
    if (!acc.has(own)) rows.push(own);
    rows.sort((x, y) => x - y);
    for (const J of rows) {
      const blk = acc.get(J);
      // -w D^-1 (A P0)
      tmp.fill(0);
      if (blk) for (let r = 0; r < b; r++) for (let k = 0; k < c; k++) { let s = 0; for (let m = 0; m < b; m++) s += Dinv[i * bb + r * b + m] * blk[m * c + k]; tmp[r * c + k] = -w * s; }
      if (J === own) for (let r = 0; r < bc; r++) tmp[r] += P0.val[i * bc + r];
      outCol.push(J);
      for (let r = 0; r < bc; r++) outVal.push(tmp[r]);
    }
    outPtr[i + 1] = outCol.length;
  }
  return { n, m: P0.m, b, c, rowPtr: outPtr, col: Int32Array.from(outCol), val: Float64Array.from(outVal) };
}

/** Coarse matrix P^T A P. */
function galerkin(A: BlockMatrix, P: Prolongator): BlockMatrix {
  const { n, b, rowPtr, col, val } = A;
  const c = P.c, bb = b * b, bc = b * c, cc = c * c;
  const rowsC: Map<number, Float64Array>[] = Array.from({ length: P.m }, () => new Map());
  const ap = new Map<number, Float64Array>();
  for (let i = 0; i < n; i++) {
    ap.clear();
    for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) {
      const j = col[q];
      for (let p = P.rowPtr[j]; p < P.rowPtr[j + 1]; p++) {
        const J = P.col[p];
        let blk = ap.get(J);
        if (!blk) { blk = new Float64Array(bc); ap.set(J, blk); }
        for (let r = 0; r < b; r++) {
          const a0 = q * bb + r * b;
          for (let k = 0; k < c; k++) {
            let s = 0;
            for (let m = 0; m < b; m++) s += val[a0 + m] * P.val[p * bc + m * c + k];
            blk[r * c + k] += s;
          }
        }
      }
    }
    for (let p = P.rowPtr[i]; p < P.rowPtr[i + 1]; p++) {
      const I = P.col[p];
      const row = rowsC[I];
      for (const [J, blk] of ap) {
        let dst = row.get(J);
        if (!dst) { dst = new Float64Array(cc); row.set(J, dst); }
        // P_iI^T (b x c)^T * blk (b x c)
        for (let r = 0; r < c; r++) for (let k = 0; k < c; k++) {
          let s = 0;
          for (let m = 0; m < b; m++) s += P.val[p * bc + m * c + r] * blk[m * c + k];
          dst[r * c + k] += s;
        }
      }
    }
  }
  const rp = new Int32Array(P.m + 1);
  let nnz = 0;
  for (let I = 0; I < P.m; I++) { nnz += rowsC[I].size; rp[I + 1] = nnz; }
  const cl = new Int32Array(nnz);
  const vl = new Float64Array(nnz * cc);
  for (let I = 0; I < P.m; I++) {
    const keys = [...rowsC[I].keys()].sort((x, y) => x - y);
    keys.forEach((J, k) => { cl[rp[I] + k] = J; vl.set(rowsC[I].get(J)!, (rp[I] + k) * cc); });
    // A dummy coarse unknown (no stiffness) gets a unit diagonal so the level stays solvable.
    const q = keys.indexOf(I);
    if (q >= 0) {
      const d = (rp[I] + q) * cc;
      let scale = 0;
      for (let r = 0; r < c; r++) scale = Math.max(scale, vl[d + r * c + r]);
      for (let r = 0; r < c; r++) if (!(vl[d + r * c + r] > 1e-12 * scale)) {
        let off = 0;
        for (let k = 0; k < c; k++) off += Math.abs(vl[d + r * c + k]);
        if (off <= 1e-12 * scale) vl[d + r * c + r] = scale || 1;
      }
    }
  }
  return { n: P.m, b: c, rowPtr: rp, col: cl, val: vl };
}

function restrict(P: Prolongator, r: Float64Array, out: Float64Array) {
  out.fill(0);
  const { n, b, c, rowPtr, col, val } = P;
  const bc = b * c;
  for (let i = 0; i < n; i++) {
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
      const J = col[p] * c;
      for (let k = 0; k < c; k++) {
        let s = 0;
        for (let m = 0; m < b; m++) s += val[p * bc + m * c + k] * r[i * b + m];
        out[J + k] += s;
      }
    }
  }
}

function prolongAdd(P: Prolongator, xc: Float64Array, x: Float64Array) {
  const { n, b, c, rowPtr, col, val } = P;
  const bc = b * c;
  for (let i = 0; i < n; i++) {
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
      const J = col[p] * c;
      for (let m = 0; m < b; m++) {
        let s = 0;
        for (let k = 0; k < c; k++) s += val[p * bc + m * c + k] * xc[J + k];
        x[i * b + m] += s;
      }
    }
  }
}

/** One block Gauss-Seidel sweep, forward or backward. */
function gaussSeidel(A: BlockMatrix, Dinv: Float64Array, rhs: Float64Array, x: Float64Array, forward: boolean) {
  const { n, b, rowPtr, col, val } = A;
  const bb = b * b;
  const s = new Float64Array(b);
  for (let k = 0; k < n; k++) {
    const i = forward ? k : n - 1 - k;
    for (let r = 0; r < b; r++) s[r] = rhs[i * b + r];
    for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) {
      const j = col[q];
      if (j === i) continue;
      for (let r = 0; r < b; r++) {
        let t = 0;
        for (let m = 0; m < b; m++) t += val[q * bb + r * b + m] * x[j * b + m];
        s[r] -= t;
      }
    }
    for (let r = 0; r < b; r++) {
      let t = 0;
      for (let m = 0; m < b; m++) t += Dinv[i * bb + r * b + m] * s[m];
      x[i * b + r] = t;
    }
  }
}

/** Dense Cholesky solve of a (small) block matrix; a zero pivot (a free motion) is skipped. */
function denseCholesky(A: BlockMatrix): (b: Float64Array, x: Float64Array) => void {
  const N = A.n * A.b, bs = A.b, bb = bs * bs;
  const M = new Float64Array(N * N);
  for (let i = 0; i < A.n; i++) for (let q = A.rowPtr[i]; q < A.rowPtr[i + 1]; q++) {
    const j = A.col[q];
    for (let r = 0; r < bs; r++) for (let c = 0; c < bs; c++) M[(i * bs + r) * N + j * bs + c] = A.val[q * bb + r * bs + c];
  }
  let scale = 0;
  for (let i = 0; i < N; i++) scale = Math.max(scale, M[i * N + i]);
  const skip = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    let d = M[k * N + k];
    for (let p = 0; p < k; p++) d -= M[k * N + p] ** 2;
    if (!(d > 1e-13 * scale)) { skip[k] = 1; M[k * N + k] = 1; for (let i = k + 1; i < N; i++) M[i * N + k] = 0; continue; }
    const l = Math.sqrt(d);
    M[k * N + k] = l;
    for (let i = k + 1; i < N; i++) {
      let s = M[i * N + k];
      for (let p = 0; p < k; p++) s -= M[i * N + p] * M[k * N + p];
      M[i * N + k] = s / l;
    }
  }
  return (b, x) => {
    for (let i = 0; i < N; i++) {
      if (skip[i]) { x[i] = 0; continue; }
      let s = b[i];
      for (let p = 0; p < i; p++) s -= M[i * N + p] * x[p];
      x[i] = s / M[i * N + i];
    }
    for (let i = N - 1; i >= 0; i--) {
      if (skip[i]) { x[i] = 0; continue; }
      let s = x[i];
      for (let p = i + 1; p < N; p++) s -= M[p * N + i] * x[p];
      x[i] = s / M[i * N + i];
    }
  };
}

export interface CgResult {
  iterations: number;
  residual: number;
  converged: boolean;
}

/** Preconditioned conjugate gradients from x = 0; tol is relative to |b|. */
export function pcg(A: BlockMatrix, b: Float64Array, x: Float64Array, M: Preconditioner, opts: { tol?: number; maxIter?: number; progress?: (it: number, rel: number) => void } = {}): CgResult {
  const N = b.length;
  const tol = opts.tol ?? 1e-8;
  const maxIter = opts.maxIter ?? 2000;
  const r = new Float64Array(N), z = new Float64Array(N), p = new Float64Array(N), q = new Float64Array(N);
  x.fill(0);
  r.set(b);
  let bn = 0;
  for (let i = 0; i < N; i++) bn += b[i] * b[i];
  bn = Math.sqrt(bn);
  if (!(bn > 0)) return { iterations: 0, residual: 0, converged: true };
  M.apply(r, z);
  p.set(z);
  let rz = 0;
  for (let i = 0; i < N; i++) rz += r[i] * z[i];
  let rel = 1;
  for (let it = 1; it <= maxIter; it++) {
    matvec(A, p, q);
    let pq = 0;
    for (let i = 0; i < N; i++) pq += p[i] * q[i];
    if (!(pq > 0)) return { iterations: it, residual: rel, converged: false };
    const alpha = rz / pq;
    let rn = 0;
    for (let i = 0; i < N; i++) { x[i] += alpha * p[i]; r[i] -= alpha * q[i]; rn += r[i] * r[i]; }
    rel = Math.sqrt(rn) / bn;
    opts.progress?.(it, rel);
    if (rel <= tol) return { iterations: it, residual: rel, converged: true };
    M.apply(r, z);
    let rz2 = 0;
    for (let i = 0; i < N; i++) rz2 += r[i] * z[i];
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < N; i++) p[i] = z[i] + beta * p[i];
  }
  return { iterations: maxIter, residual: rel, converged: false };
}
