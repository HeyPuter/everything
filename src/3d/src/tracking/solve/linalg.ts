// Small dense linear algebra for the camera solver: one-sided Jacobi SVD, symmetric
// eigen-decomposition, Cholesky solves and 3×3 rotation helpers. Matrices are row-major
// Float64Arrays (or plain arrays) with their dimensions passed alongside.

export type M3 = Float64Array; // 3×3 row-major
export type V3 = Float64Array | number[];

/**
 * Thin SVD of an m×n matrix (row-major) by one-sided Jacobi rotations. Matrices with m < n are
 * padded with zero rows. Returns U (rows×n), singular values in decreasing order and V (n×n),
 * with A = U·diag(S)·Vᵀ.
 */
export function svd(A: ArrayLike<number>, m: number, n: number): { U: Float64Array; S: Float64Array; V: Float64Array; rows: number } {
  const rows = Math.max(m, n);
  const U = new Float64Array(rows * n);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) U[i * n + j] = A[i * n + j];
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  const eps = 1e-15;
  for (let sweep = 0; sweep < 60; sweep++) {
    let rotated = false;
    for (let p = 0; p < n - 1; p++)
      for (let q = p + 1; q < n; q++) {
        let alpha = 0,
          beta = 0,
          gamma = 0;
        for (let i = 0; i < rows; i++) {
          const up = U[i * n + p],
            uq = U[i * n + q];
          alpha += up * up;
          beta += uq * uq;
          gamma += up * uq;
        }
        if (Math.abs(gamma) <= eps * Math.sqrt(alpha * beta) || gamma === 0) continue;
        rotated = true;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t),
          s = c * t;
        for (let i = 0; i < rows; i++) {
          const up = U[i * n + p],
            uq = U[i * n + q];
          U[i * n + p] = c * up - s * uq;
          U[i * n + q] = s * up + c * uq;
        }
        for (let i = 0; i < n; i++) {
          const vp = V[i * n + p],
            vq = V[i * n + q];
          V[i * n + p] = c * vp - s * vq;
          V[i * n + q] = s * vp + c * vq;
        }
      }
    if (!rotated) break;
  }
  const S = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < rows; i++) s += U[i * n + j] * U[i * n + j];
    s = Math.sqrt(s);
    S[j] = s;
    if (s > 1e-300) for (let i = 0; i < rows; i++) U[i * n + j] /= s;
  }
  // sort by decreasing singular value
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => S[b] - S[a]);
  const U2 = new Float64Array(rows * n),
    V2 = new Float64Array(n * n),
    S2 = new Float64Array(n);
  order.forEach((src, dst) => {
    S2[dst] = S[src];
    for (let i = 0; i < rows; i++) U2[i * n + dst] = U[i * n + src];
    for (let i = 0; i < n; i++) V2[i * n + dst] = V[i * n + src];
  });
  return { U: U2, S: S2, V: V2, rows };
}

/** Right singular vector of the smallest singular value (least-squares null vector of A). */
export function nullVector(A: ArrayLike<number>, m: number, n: number): Float64Array {
  const { V } = svd(A, m, n);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = V[i * n + n - 1];
  return out;
}

/** In-place Cholesky factorization of an SPD n×n matrix (lower triangle). Returns false when not positive definite. */
export function cholesky(A: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= A[j * n + k] * A[j * n + k];
    if (!(d > 0)) return false;
    d = Math.sqrt(d);
    A[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / d;
    }
  }
  return true;
}

/** Solve L·Lᵀ·x = b with a factor from `cholesky` (b is overwritten with x). */
export function choleskySolve(L: Float64Array, n: number, b: Float64Array, off = 0) {
  for (let i = 0; i < n; i++) {
    let s = b[off + i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * b[off + k];
    b[off + i] = s / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[off + i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * b[off + k];
    b[off + i] = s / L[i * n + i];
  }
}

/** Inverse of an SPD matrix through Cholesky, adding a tiny ridge when it is (numerically) singular. */
export function spdInverse(A: Float64Array, n: number): Float64Array {
  let ridge = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const L = A.slice();
    if (ridge) {
      let tr = 0;
      for (let i = 0; i < n; i++) tr += Math.abs(A[i * n + i]);
      for (let i = 0; i < n; i++) L[i * n + i] += ridge * (tr / n + 1e-12);
    }
    if (cholesky(L, n)) {
      const inv = new Float64Array(n * n);
      const e = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        e.fill(0);
        e[j] = 1;
        choleskySolve(L, n, e);
        for (let i = 0; i < n; i++) inv[i * n + j] = e[i];
      }
      return inv;
    }
    ridge = ridge ? ridge * 100 : 1e-12;
  }
  return new Float64Array(n * n);
}

/** Inverse of a symmetric 3×3 matrix (adjugate); zero matrix when singular. */
export function inv3sym(a: ArrayLike<number>, out: Float64Array = new Float64Array(9)): Float64Array {
  const [a00, a01, a02, , a11, a12, , , a22] = [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]];
  const c00 = a11 * a22 - a12 * a12,
    c01 = a02 * a12 - a01 * a22,
    c02 = a01 * a12 - a02 * a11;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  if (!(Math.abs(det) > 1e-300)) {
    out.fill(0);
    return out;
  }
  const id = 1 / det;
  out[0] = c00 * id;
  out[1] = out[3] = c01 * id;
  out[2] = out[6] = c02 * id;
  out[4] = (a00 * a22 - a02 * a02) * id;
  out[5] = out[7] = (a01 * a02 - a00 * a12) * id;
  out[8] = (a00 * a11 - a01 * a01) * id;
  return out;
}

// ---------------------------------------------------------------------------
// 3×3 / rotation helpers

export function mat3(...v: number[]): M3 {
  return Float64Array.from(v);
}

export function identity3(): M3 {
  return mat3(1, 0, 0, 0, 1, 0, 0, 0, 1);
}

export function mul3(a: ArrayLike<number>, b: ArrayLike<number>, out: M3 = new Float64Array(9)): M3 {
  const r = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  out.set(r);
  return out;
}

export function transpose3(a: ArrayLike<number>): M3 {
  return mat3(a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]);
}

export function det3(a: ArrayLike<number>): number {
  return a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
}

export function mulVec3(a: ArrayLike<number>, v: ArrayLike<number>, out: Float64Array = new Float64Array(3)): Float64Array {
  const x = v[0],
    y = v[1],
    z = v[2];
  out[0] = a[0] * x + a[1] * y + a[2] * z;
  out[1] = a[3] * x + a[4] * y + a[5] * z;
  out[2] = a[6] * x + a[7] * y + a[8] * z;
  return out;
}

/** Rotation matrix of the rotation vector w (Rodrigues). */
export function expSO3(wx: number, wy: number, wz: number): M3 {
  const th = Math.hypot(wx, wy, wz);
  if (th < 1e-12) return mat3(1, -wz, wy, wz, 1, -wx, -wy, wx, 1);
  const kx = wx / th,
    ky = wy / th,
    kz = wz / th;
  const c = Math.cos(th),
    s = Math.sin(th),
    v = 1 - c;
  return mat3(c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s, ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s, kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v);
}

/** Rotation vector of a rotation matrix (inverse of expSO3). */
export function logSO3(R: ArrayLike<number>): [number, number, number] {
  const cos = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2));
  const th = Math.acos(cos);
  if (th < 1e-9) return [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
  if (Math.PI - th < 1e-6) {
    // near 180°: axis from the diagonal
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2)),
      y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)) * (R[1] >= 0 ? 1 : -1),
      z = Math.sqrt(Math.max(0, (R[8] + 1) / 2)) * (R[2] >= 0 ? 1 : -1);
    const n = Math.hypot(x, y, z) || 1;
    return [(x / n) * th, (y / n) * th, (z / n) * th];
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/** Nearest rotation (Frobenius) to a 3×3 matrix. */
export function orthonormalize(M: ArrayLike<number>): M3 {
  const { U, V } = svd(M, 3, 3);
  let R = mul3(U, transpose3(V));
  if (det3(R) < 0) {
    const U2 = U.slice();
    for (let i = 0; i < 3; i++) U2[i * 3 + 2] *= -1;
    R = mul3(U2, transpose3(V));
  }
  return R;
}

/** Rotation R minimising Σ w |R a_i − b_i|² (Wahba / Kabsch with unit weights by default). */
export function wahba(a: ArrayLike<number>[], b: ArrayLike<number>[], w?: ArrayLike<number>): M3 {
  const B = new Float64Array(9);
  for (let i = 0; i < a.length; i++) {
    const wi = w ? w[i] : 1;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) B[r * 3 + c] += wi * b[i][r] * a[i][c];
  }
  return orthonormalize(B);
}

export function cross(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  return Float64Array.of(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function norm(a: ArrayLike<number>): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Deterministic pseudo random numbers (RANSAC sampling must be reproducible for redo). */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
