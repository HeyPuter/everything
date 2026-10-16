// Multi-view geometry for the camera solver. Cameras use the computer-vision convention inside
// the solver: a world point X maps to camera space as Xc = R·X + t, the camera looks along +Z,
// image u = Xc.x / Xc.z to the right and v = Xc.y / Xc.z downwards. `uv` coordinates are
// undistorted normalized image coordinates in that convention (v = −y of the y-up image plane).
import { cross, det3, dot, expSO3, identity3, mul3, mulVec3, norm, nullVector, orthonormalize, rng, svd, transpose3, type M3 } from './linalg';

export interface Pose {
  R: M3;
  t: Float64Array;
}

export type UV = [number, number];

export function clonePose(p: Pose): Pose {
  return { R: p.R.slice(), t: p.t.slice() };
}

export function identityPose(): Pose {
  return { R: identity3(), t: new Float64Array(3) };
}

/** Camera center of a pose in world space (−Rᵀt). */
export function cameraCenter(p: Pose): Float64Array {
  const c = mulVec3(transpose3(p.R), p.t);
  return Float64Array.of(-c[0], -c[1], -c[2]);
}

export function toCamera(p: Pose, X: ArrayLike<number>): Float64Array {
  const c = mulVec3(p.R, X);
  c[0] += p.t[0];
  c[1] += p.t[1];
  c[2] += p.t[2];
  return c;
}

/** Normalized projection of X, or null behind the camera. */
export function projectUV(p: Pose, X: ArrayLike<number>): UV | null {
  const c = toCamera(p, X);
  if (c[2] <= 1e-9) return null;
  return [c[0] / c[2], c[1] / c[2]];
}

// ---------------------------------------------------------------------------
// essential matrix

function hartley(pts: UV[]): { T: M3; out: UV[] } {
  let mx = 0,
    my = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
  }
  mx /= pts.length;
  my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
  const s = d > 0 ? (Math.SQRT2 * pts.length) / d : 1;
  return {
    T: Float64Array.of(s, 0, -s * mx, 0, s, -s * my, 0, 0, 1),
    out: pts.map((p) => [(p[0] - mx) * s, (p[1] - my) * s] as UV),
  };
}

/** Essential matrix with x2ᵀ·E·x1 = 0 from ≥ 8 correspondences (normalized eight-point algorithm). */
export function essentialEightPoint(a: UV[], b: UV[]): M3 | null {
  if (a.length < 8) return null;
  const h1 = hartley(a),
    h2 = hartley(b);
  const A = new Float64Array(a.length * 9);
  for (let i = 0; i < a.length; i++) {
    const [x1, y1] = h1.out[i],
      [x2, y2] = h2.out[i];
    A.set([x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, 1], i * 9);
  }
  const f = nullVector(A, a.length, 9);
  // denormalize: E = T2ᵀ·E'·T1
  let E = mul3(transpose3(h2.T), mul3(f, h1.T));
  // enforce two equal singular values and one zero
  const { U, S, V } = svd(E, 3, 3);
  const s = (S[0] + S[1]) / 2;
  if (!(s > 0)) return null;
  const D = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 0);
  E = mul3(mul3(U, D), transpose3(V));
  return E;
}

/** Squared Sampson distance of a correspondence to the epipolar constraint. */
export function sampson(E: ArrayLike<number>, a: UV, b: UV): number {
  const x1 = [a[0], a[1], 1],
    x2 = [b[0], b[1], 1];
  const Ex1 = mulVec3(E, x1);
  const Etx2 = mulVec3(transpose3(E), x2);
  const num = dot(x2, Ex1);
  const den = Ex1[0] * Ex1[0] + Ex1[1] * Ex1[1] + Etx2[0] * Etx2[0] + Etx2[1] * Etx2[1];
  return den > 0 ? (num * num) / den : Infinity;
}

/** RANSAC estimate of the essential matrix. `thr` is the inlier distance in normalized units. */
export function essentialRansac(a: UV[], b: UV[], thr: number, opts: { iterations?: number; seed?: number } = {}): { E: M3; inliers: boolean[] } | null {
  const n = a.length;
  if (n < 8) return null;
  const rand = rng(opts.seed ?? 12345);
  const thr2 = thr * thr;
  let best: { E: M3; inliers: boolean[]; count: number; score: number } | null = null;
  let maxIt = opts.iterations ?? 400;
  for (let it = 0; it < maxIt; it++) {
    const idx = new Set<number>();
    while (idx.size < 8) idx.add(Math.floor(rand() * n));
    const s = [...idx];
    const E = essentialEightPoint(
      s.map((i) => a[i]),
      s.map((i) => b[i]),
    );
    if (!E) continue;
    let count = 0,
      score = 0;
    const inl = new Array<boolean>(n);
    for (let i = 0; i < n; i++) {
      const d = sampson(E, a[i], b[i]);
      inl[i] = d < thr2;
      if (inl[i]) {
        count++;
        score += d;
      } else score += thr2;
    }
    if (!best || score < best.score) {
      best = { E, inliers: inl, count, score };
      // adaptive iteration count for 99.9% confidence
      const w = count / n;
      const k = Math.log(1 - 0.999) / Math.log(Math.max(1e-12, 1 - Math.pow(w, 8)));
      if (Number.isFinite(k)) maxIt = Math.min(maxIt, Math.max(60, Math.ceil(k)));
    }
  }
  if (!best || best.count < 8) return null;
  // least squares refit on the inliers
  const ia = a.filter((_, i) => best!.inliers[i]),
    ib = b.filter((_, i) => best!.inliers[i]);
  const E = essentialEightPoint(ia, ib) ?? best.E;
  const inliers = a.map((_, i) => sampson(E, a[i], b[i]) < thr2 * 1.5);
  return { E, inliers };
}

/** The four (R, t) factorizations of an essential matrix (|t| = 1). */
export function decomposeEssential(E: ArrayLike<number>): Pose[] {
  const { U, V } = svd(E, 3, 3);
  const fix = (M: Float64Array) => {
    if (det3(M) < 0) for (let i = 0; i < 3; i++) M[i * 3 + 2] *= -1;
  };
  fix(U);
  fix(V);
  const W = Float64Array.of(0, -1, 0, 1, 0, 0, 0, 0, 1);
  const Vt = transpose3(V);
  const R1 = mul3(mul3(U, W), Vt),
    R2 = mul3(mul3(U, transpose3(W)), Vt);
  const t = Float64Array.of(U[2], U[5], U[8]);
  const nt = Float64Array.of(-t[0], -t[1], -t[2]);
  return [
    { R: R1, t: t.slice() },
    { R: R1.slice(), t: nt.slice() },
    { R: R2, t: t.slice() },
    { R: R2.slice(), t: nt },
  ];
}

// ---------------------------------------------------------------------------
// homography (planar scenes and degenerate motion)

/** Homography with b ~ H·a from ≥ 4 correspondences (normalized DLT). */
export function homographyDLT(a: UV[], b: UV[]): M3 | null {
  if (a.length < 4) return null;
  const h1 = hartley(a),
    h2 = hartley(b);
  const A = new Float64Array(a.length * 2 * 9);
  for (let i = 0; i < a.length; i++) {
    const [x, y] = h1.out[i],
      [u, v] = h2.out[i];
    A.set([-x, -y, -1, 0, 0, 0, u * x, u * y, u], i * 18);
    A.set([0, 0, 0, -x, -y, -1, v * x, v * y, v], i * 18 + 9);
  }
  const hv = nullVector(A, a.length * 2, 9);
  // H = T2⁻¹·H'·T1
  const T2 = h2.T;
  const T2inv = Float64Array.of(1 / T2[0], 0, -T2[2] / T2[0], 0, 1 / T2[4], -T2[5] / T2[4], 0, 0, 1);
  const H = mul3(mul3(T2inv, hv), h1.T);
  return H.every(Number.isFinite) ? H : null;
}

export function homographyError(H: ArrayLike<number>, a: UV, b: UV): number {
  const w = H[6] * a[0] + H[7] * a[1] + H[8];
  if (Math.abs(w) < 1e-12) return Infinity;
  return Math.hypot((H[0] * a[0] + H[1] * a[1] + H[2]) / w - b[0], (H[3] * a[0] + H[4] * a[1] + H[5]) / w - b[1]);
}

export function homographyRansac(a: UV[], b: UV[], thr: number, opts: { iterations?: number; seed?: number } = {}): { H: M3; inliers: boolean[] } | null {
  const n = a.length;
  if (n < 4) return null;
  const rand = rng(opts.seed ?? 777);
  let best: { H: M3; count: number; score: number } | null = null;
  for (let it = 0; it < (opts.iterations ?? 300); it++) {
    const idx = new Set<number>();
    while (idx.size < 4) idx.add(Math.floor(rand() * n));
    const sIdx = [...idx];
    const H = homographyDLT(
      sIdx.map((i) => a[i]),
      sIdx.map((i) => b[i]),
    );
    if (!H) continue;
    let count = 0,
      score = 0;
    for (let i = 0; i < n; i++) {
      const e = homographyError(H, a[i], b[i]);
      if (e < thr) count++;
      score += Math.min(e * e, thr * thr);
    }
    if (!best || score < best.score) best = { H, count, score };
  }
  if (!best || best.count < 4) return null;
  const inl = a.map((p, i) => homographyError(best!.H, p, b[i]) < thr);
  const H = homographyDLT(
    a.filter((_, i) => inl[i]),
    b.filter((_, i) => inl[i]),
  ) ?? best.H;
  return { H, inliers: a.map((p, i) => homographyError(H, p, b[i]) < thr) };
}

/**
 * Motion hypotheses (R, t with |t| = 1) explaining a calibrated homography of a plane
 * (Faugeras' SVD decomposition, eight candidates; the right one is chosen by triangulation).
 */
export function decomposeHomography(H: ArrayLike<number>): Pose[] {
  const { U, S, V } = svd(H, 3, 3);
  const [d1, d2, d3] = S;
  if (d1 / d2 < 1.00001 || d2 / d3 < 1.00001) return [];
  const s = det3(U) * det3(V);
  const Vt = transpose3(V);
  const out: Pose[] = [];
  const q = d1 * d1 - d3 * d3;
  const aux1 = Math.sqrt((d1 * d1 - d2 * d2) / q),
    aux3 = Math.sqrt((d2 * d2 - d3 * d3) / q);
  const x1 = [aux1, aux1, -aux1, -aux1],
    x3 = [aux3, -aux3, aux3, -aux3];
  const push = (Rp: number[], tp: number[]) => {
    const R = mul3(mul3(U, Rp), Vt).map((v) => v * s) as Float64Array;
    const t = mulVec3(U, tp);
    const l = Math.hypot(t[0], t[1], t[2]) || 1;
    out.push({ R: Float64Array.from(R), t: Float64Array.of(t[0] / l, t[1] / l, t[2] / l) });
  };
  const sTh = Math.sqrt((d1 * d1 - d2 * d2) * (d2 * d2 - d3 * d3)) / ((d1 + d3) * d2);
  const cTh = (d2 * d2 + d1 * d3) / ((d1 + d3) * d2);
  const sth = [sTh, -sTh, -sTh, sTh];
  for (let i = 0; i < 4; i++) push([cTh, 0, -sth[i], 0, 1, 0, sth[i], 0, cTh], [x1[i] * (d1 - d3), 0, -x3[i] * (d1 - d3)]);
  const sPh = Math.sqrt((d1 * d1 - d2 * d2) * (d2 * d2 - d3 * d3)) / ((d1 - d3) * d2);
  const cPh = (d1 * d3 - d2 * d2) / ((d1 - d3) * d2);
  const sph = [sPh, -sPh, -sPh, sPh];
  for (let i = 0; i < 4; i++) push([cPh, 0, sph[i], 0, -1, 0, sph[i], 0, -cPh], [x1[i] * (d1 + d3), 0, x3[i] * (d1 + d3)]);
  return out;
}

// ---------------------------------------------------------------------------
// triangulation

/** Linear (DLT) triangulation from two or more views. */
export function triangulate(poses: Pose[], uvs: UV[]): Float64Array | null {
  const n = poses.length;
  if (n < 2) return null;
  const A = new Float64Array(n * 2 * 4);
  for (let i = 0; i < n; i++) {
    const { R, t } = poses[i];
    const [u, v] = uvs[i];
    // rows: u·P3 − P1, v·P3 − P2 (normalized by the row norm for conditioning)
    const P1 = [R[0], R[1], R[2], t[0]],
      P2 = [R[3], R[4], R[5], t[1]],
      P3 = [R[6], R[7], R[8], t[2]];
    for (let r = 0; r < 2; r++) {
      const q = r ? v : u;
      const P = r ? P2 : P1;
      let nn = 0;
      const row = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        row[k] = q * P3[k] - P[k];
        nn += row[k] * row[k];
      }
      nn = Math.sqrt(nn) || 1;
      for (let k = 0; k < 4; k++) A[(i * 2 + r) * 4 + k] = row[k] / nn;
    }
  }
  const X = nullVector(A, n * 2, 4);
  if (Math.abs(X[3]) < 1e-12) return null;
  return Float64Array.of(X[0] / X[3], X[1] / X[3], X[2] / X[3]);
}

/** Largest angle (radians) between the viewing rays of a point from the given camera centers. */
export function parallaxAngle(centers: ArrayLike<number>[], X: ArrayLike<number>): number {
  let best = 0;
  const rays = centers.map((c) => {
    const d = [X[0] - c[0], X[1] - c[1], X[2] - c[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / l, d[1] / l, d[2] / l];
  });
  for (let i = 0; i < rays.length; i++)
    for (let j = i + 1; j < rays.length; j++) {
      const a = Math.acos(Math.max(-1, Math.min(1, dot(rays[i], rays[j]))));
      if (a > best) best = a;
    }
  return best;
}

/** Pick the essential factorization that puts most correspondences in front of both cameras. */
export function poseFromEssential(E: ArrayLike<number>, a: UV[], b: UV[]): { pose: Pose; front: number } {
  const P0 = identityPose();
  let best: { pose: Pose; front: number } = { pose: identityPose(), front: -1 };
  for (const cand of decomposeEssential(E)) {
    let front = 0;
    for (let i = 0; i < a.length; i++) {
      const X = triangulate([P0, cand], [a[i], b[i]]);
      if (!X) continue;
      if (X[2] > 0 && toCamera(cand, X)[2] > 0) front++;
    }
    if (front > best.front) best = { pose: cand, front };
  }
  return best;
}

// ---------------------------------------------------------------------------
// camera resection

/** Pose from ≥ 6 3D↔2D correspondences (linear DLT, then projected onto a rotation). */
export function dltPose(X: ArrayLike<number>[], uv: UV[]): Pose | null {
  const n = X.length;
  if (n < 6) return null;
  // condition the 3D points
  const c = [0, 0, 0];
  for (const p of X) for (let k = 0; k < 3; k++) c[k] += p[k] / n;
  let sd = 0;
  for (const p of X) sd += Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
  const s = sd > 0 ? (Math.sqrt(3) * n) / sd : 1;
  const A = new Float64Array(n * 2 * 12);
  for (let i = 0; i < n; i++) {
    const x = (X[i][0] - c[0]) * s,
      y = (X[i][1] - c[1]) * s,
      z = (X[i][2] - c[2]) * s;
    const [u, v] = uv[i];
    A.set([x, y, z, 1, 0, 0, 0, 0, -u * x, -u * y, -u * z, -u], i * 24);
    A.set([0, 0, 0, 0, x, y, z, 1, -v * x, -v * y, -v * z, -v], i * 24 + 12);
  }
  const p = nullVector(A, n * 2, 12);
  // P' acts on conditioned points: P = P'·[sI, −s c; 0 1]
  const M = Float64Array.of(p[0] * s, p[1] * s, p[2] * s, p[4] * s, p[5] * s, p[6] * s, p[8] * s, p[9] * s, p[10] * s);
  const tt = [p[3] - (p[0] * c[0] + p[1] * c[1] + p[2] * c[2]) * s, p[7] - (p[4] * c[0] + p[5] * c[1] + p[6] * c[2]) * s, p[11] - (p[8] * c[0] + p[9] * c[1] + p[10] * c[2]) * s];
  const d = det3(M);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-300) return null;
  const sc = Math.sign(d) * Math.cbrt(Math.abs(d));
  const R = orthonormalize(M.map((v) => v / sc));
  const pose = { R, t: Float64Array.of(tt[0] / sc, tt[1] / sc, tt[2] / sc) };
  return pose;
}

/**
 * Gauss–Newton refinement of a pose against normalized observations with a Huber loss
 * (`huber` in normalized units). Returns the refined pose and the per-correspondence errors.
 */
export function refinePose(init: Pose, X: ArrayLike<number>[], uv: UV[], huber: number, opts: { iterations?: number; rotationOnly?: boolean } = {}): { pose: Pose; errors: number[] } {
  let pose = clonePose(init);
  const n = X.length;
  const dim = opts.rotationOnly ? 3 : 6;
  const cost = (p: Pose) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const c = toCamera(p, X[i]);
      if (c[2] <= 1e-9) {
        s += huber * huber * 50;
        continue;
      }
      const e = Math.hypot(c[0] / c[2] - uv[i][0], c[1] / c[2] - uv[i][1]);
      s += e <= huber ? (e * e) / 2 : huber * (e - huber / 2);
    }
    return s;
  };
  let cur = cost(pose);
  let lambda = 1e-4;
  for (let it = 0; it < (opts.iterations ?? 30); it++) {
    const H = new Float64Array(dim * dim),
      g = new Float64Array(dim);
    for (let i = 0; i < n; i++) {
      const RX = mulVec3(pose.R, X[i]);
      const c = [RX[0] + pose.t[0], RX[1] + pose.t[1], RX[2] + pose.t[2]];
      if (c[2] <= 1e-9) continue;
      const iz = 1 / c[2];
      const ru = c[0] * iz - uv[i][0],
        rv = c[1] * iz - uv[i][1];
      const e = Math.hypot(ru, rv);
      const w = e <= huber ? 1 : huber / e;
      const du = [iz, 0, -c[0] * iz * iz],
        dv = [0, iz, -c[1] * iz * iz];
      // ∂Xc/∂ω = −[RX]×
      const Jr = (d: number[]) => [d[1] * -RX[2] + d[2] * RX[1], d[0] * RX[2] + d[2] * -RX[0], d[0] * -RX[1] + d[1] * RX[0]];
      const ju = opts.rotationOnly ? Jr(du) : [...Jr(du), ...du];
      const jv = opts.rotationOnly ? Jr(dv) : [...Jr(dv), ...dv];
      for (let a = 0; a < dim; a++) {
        g[a] += w * (ju[a] * ru + jv[a] * rv);
        for (let b = 0; b < dim; b++) H[a * dim + b] += w * (ju[a] * ju[b] + jv[a] * jv[b]);
      }
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const A = H.slice();
      for (let a = 0; a < dim; a++) A[a * dim + a] += lambda * (H[a * dim + a] + 1e-12);
      const d = solveSmall(A, dim, g.map((v) => -v));
      if (!d) {
        lambda *= 10;
        continue;
      }
      const R2 = mul3(expSO3(d[0], d[1], d[2]), pose.R);
      const t2 = opts.rotationOnly ? pose.t.slice() : Float64Array.of(pose.t[0] + d[3], pose.t[1] + d[4], pose.t[2] + d[5]);
      const cand = { R: R2, t: t2 };
      const cc = cost(cand);
      if (cc < cur) {
        const rel = (cur - cc) / Math.max(cur, 1e-30);
        pose = cand;
        cur = cc;
        lambda = Math.max(1e-10, lambda / 4);
        improved = rel > 1e-10;
        break;
      }
      lambda *= 8;
    }
    if (!improved) break;
  }
  const errors = X.map((p, i) => {
    const q = projectUV(pose, p);
    return q ? Math.hypot(q[0] - uv[i][0], q[1] - uv[i][1]) : Infinity;
  });
  return { pose, errors };
}

/** Solve a small dense system by Gaussian elimination with partial pivoting. */
export function solveSmall(A: Float64Array, n: number, b: ArrayLike<number>): Float64Array | null {
  const M = A.slice(),
    x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (Math.abs(M[p * n + c]) < 1e-300) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]];
      [x[c], x[p]] = [x[p], x[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x.every(Number.isFinite) ? x : null;
}

/** Robust pose of a camera from 3D↔2D correspondences: tries the given guesses and a RANSAC DLT. */
export function resection(X: ArrayLike<number>[], uv: UV[], guesses: Pose[], thr: number, seed = 1): { pose: Pose; inliers: boolean[]; errors: number[] } | null {
  const n = X.length;
  if (n < 4) return null;
  const candidates: Pose[] = guesses.map(clonePose);
  if (n >= 6) {
    const rand = rng(seed);
    const whole = dltPose(X, uv);
    if (whole) candidates.push(whole);
    for (let it = 0; it < Math.min(60, n * 4); it++) {
      const idx = new Set<number>();
      while (idx.size < 6) idx.add(Math.floor(rand() * n));
      const s = [...idx];
      const p = dltPose(
        s.map((i) => X[i]),
        s.map((i) => uv[i]),
      );
      if (p) candidates.push(p);
    }
  }
  let best: { pose: Pose; inliers: boolean[]; errors: number[]; score: number } | null = null;
  const score = (errs: number[]) => errs.reduce((s, e) => s + Math.min(e * e, thr * thr), 0);
  // cheap pre-score of all candidates, refine only the best few
  const pre = candidates
    .map((p) => {
      const errs = X.map((x, i) => {
        const q = projectUV(p, x);
        return q ? Math.hypot(q[0] - uv[i][0], q[1] - uv[i][1]) : Infinity;
      });
      return { p, s: score(errs) };
    })
    .sort((a, b) => a.s - b.s)
    .slice(0, 4);
  for (const { p } of pre) {
    let r = refinePose(p, X, uv, thr * 0.5);
    // drop gross outliers and refine again
    const inl = r.errors.map((e) => e < thr * 3);
    if (inl.filter(Boolean).length >= 4 && inl.some((v) => !v)) {
      const r2 = refinePose(
        r.pose,
        X.filter((_, i) => inl[i]),
        uv.filter((_, i) => inl[i]),
        thr * 0.5,
      );
      const errs = X.map((x, i) => {
        const q = projectUV(r2.pose, x);
        return q ? Math.hypot(q[0] - uv[i][0], q[1] - uv[i][1]) : Infinity;
      });
      r = { pose: r2.pose, errors: errs };
    }
    const s = score(r.errors);
    if (!best || s < best.score) best = { pose: r.pose, errors: r.errors, inliers: r.errors.map((e) => e < thr), score: s };
  }
  if (!best || best.inliers.filter(Boolean).length < 4) return null;
  return best;
}

/** Bearing (unit direction in camera space) of a normalized image point. */
export function bearing(uv: UV): Float64Array {
  const l = Math.hypot(uv[0], uv[1], 1);
  return Float64Array.of(uv[0] / l, uv[1] / l, 1 / l);
}

export { cross, norm };
