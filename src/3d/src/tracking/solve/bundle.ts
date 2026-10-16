// Bundle adjustment: Levenberg–Marquardt over camera poses, 3D points and (optionally) shared
// intrinsics, minimising the robust (Huber) pixel reprojection error.
//
// Each step eliminates the points with the Schur complement and solves the reduced camera system
// with preconditioned conjugate gradients. The reduced matrix S = U − W·V⁻¹·Wᵀ is never formed:
// products S·x are evaluated observation by observation (per point: z = V⁻¹ Σ Jpᵀ (Jy x), then
// Σ Jyᵀ (Jy x − Jp z)), so memory and time stay linear in the number of observations however long
// the shot is. Block-Jacobi preconditioning uses the exact diagonal blocks of S.
import { cholesky, choleskySolve, expSO3, inv3sym, mul3, type M3 } from './linalg';
import { distort, distortCoeffJacobian, distortJacobian, getParam, intrinsicParamNames, setParam, cloneIntrinsics, type Intrinsics, type RefineFlags } from './intrinsics';

export interface BACamera {
  R: M3;
  t: Float64Array;
  /** fixed cameras are not adjusted (gauge) */
  fixed?: boolean;
}

export interface BAObservations {
  cam: Int32Array;
  pt: Int32Array;
  /** observed pixel position (origin bottom-left) */
  x: Float64Array;
  y: Float64Array;
  /** observation weight (track weight) */
  w: Float64Array;
}

export interface BAOptions {
  refine?: RefineFlags;
  /** cameras only rotate (tripod): translations stay as given */
  tripod?: boolean;
  /** Huber threshold in pixels */
  huber?: number;
  maxIterations?: number;
  /** points that may not move (e.g. not part of this adjustment) */
  fixedPoints?: Uint8Array;
  shouldStop?: () => boolean;
}

export interface BAResult {
  cost: number;
  initialCost: number;
  iterations: number;
  intrinsics: Intrinsics;
}

const NO_REFINE: RefineFlags = { focal_length: false, principal_point: false, radial_distortion: false, tangential_distortion: false };

function huberCost(e: number, d: number) {
  return e <= d ? (e * e) / 2 : d * (e - d / 2);
}

/** Pixel residual of one observation (projection − observation); null behind the camera. */
export function reprojection(I: Intrinsics, R: ArrayLike<number>, t: ArrayLike<number>, X: ArrayLike<number>, ox: number, oy: number): [number, number] | null {
  const cx = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
  const cy = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
  const cz = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
  if (cz <= 1e-9) return null;
  const [xd, yd] = distort(I, cx / cz, -cy / cz);
  return [I.cx + I.focal * xd - ox, I.cy + I.focal * I.aspect * yd - oy];
}

/**
 * Adjust `cams` (R, t), `points` (xyz per point) and the refined intrinsics in place.
 * Observations of points behind a camera are penalised with a constant and ignored for the step.
 */
export function bundleAdjust(I0: Intrinsics, cams: BACamera[], points: Float64Array, obs: BAObservations, opts: BAOptions = {}): BAResult {
  const I = cloneIntrinsics(I0);
  const refine = opts.refine ?? NO_REFINE;
  const names = intrinsicParamNames(I, refine);
  const ni = names.length;
  const dc = opts.tripod ? 3 : 6;
  const delta = opts.huber ?? 2;
  const nObs = obs.cam.length;
  const np = points.length / 3;
  const nc = cams.length;
  // parameter layout of the reduced system: free cameras then intrinsics
  const camOff = new Int32Array(nc).fill(-1);
  let ny = 0;
  for (let c = 0; c < nc; c++) if (!cams[c].fixed) ((camOff[c] = ny), (ny += dc));
  const intrOff = ny;
  ny += ni;
  // observations grouped by point (CSR)
  const ptStart = new Int32Array(np + 1);
  for (let o = 0; o < nObs; o++) ptStart[obs.pt[o] + 1]++;
  for (let p = 0; p < np; p++) ptStart[p + 1] += ptStart[p];
  const ptObs = new Int32Array(nObs);
  {
    const fill = ptStart.slice(0, np);
    for (let o = 0; o < nObs; o++) ptObs[fill[obs.pt[o]]++] = o;
  }
  const fixedPt = opts.fixedPoints;

  // per-observation Jacobians and residuals
  const Jc = new Float64Array(nObs * 2 * dc);
  const Jp = new Float64Array(nObs * 6);
  const Ji = new Float64Array(nObs * 2 * Math.max(1, ni));
  const res = new Float64Array(nObs * 2);
  const W = new Float64Array(nObs);

  const totalCost = (Ic: Intrinsics, cs: BACamera[], pts: Float64Array) => {
    let s = 0;
    for (let o = 0; o < nObs; o++) {
      const cam = cs[obs.cam[o]];
      const p = obs.pt[o];
      const r = reprojection(Ic, cam.R, cam.t, pts.subarray(p * 3, p * 3 + 3), obs.x[o], obs.y[o]);
      s += obs.w[o] * (r ? huberCost(Math.hypot(r[0], r[1]), delta) : huberCost(delta * 50, delta));
    }
    return s;
  };

  const linearize = () => {
    const f = I.focal,
      A = I.aspect;
    for (let o = 0; o < nObs; o++) {
      const cam = cams[obs.cam[o]];
      const p = obs.pt[o];
      const R = cam.R,
        t = cam.t;
      const X0 = points[p * 3],
        X1 = points[p * 3 + 1],
        X2 = points[p * 3 + 2];
      const rx = R[0] * X0 + R[1] * X1 + R[2] * X2,
        ry = R[3] * X0 + R[4] * X1 + R[5] * X2,
        rz = R[6] * X0 + R[7] * X1 + R[8] * X2;
      const cx = rx + t[0],
        cy = ry + t[1],
        cz = rz + t[2];
      const jc = o * 2 * dc,
        jp = o * 6,
        ji = o * 2 * Math.max(1, ni);
      if (cz <= 1e-9) {
        W[o] = 0;
        res[o * 2] = res[o * 2 + 1] = 0;
        Jc.fill(0, jc, jc + 2 * dc);
        Jp.fill(0, jp, jp + 6);
        Ji.fill(0, ji, ji + 2 * Math.max(1, ni));
        continue;
      }
      const iz = 1 / cz;
      const x = cx * iz,
        y = -cy * iz;
      const [xd, yd] = distort(I, x, y);
      const r0 = I.cx + f * xd - obs.x[o],
        r1 = I.cy + f * A * yd - obs.y[o];
      res[o * 2] = r0;
      res[o * 2 + 1] = r1;
      const e = Math.hypot(r0, r1);
      W[o] = obs.w[o] * (e <= delta ? 1 : delta / e);
      const D = distortJacobian(I, x, y);
      // ∂pixel/∂(x, y)
      const a = f * D[0],
        b = f * D[1],
        c = f * A * D[2],
        d = f * A * D[3];
      // ∂(x, y)/∂Xc = [[iz, 0, −x·iz], [0, −iz, −y·iz]]  (y = −cy/cz)
      const J00 = a * iz,
        J01 = -b * iz,
        J02 = -(a * x + b * y) * iz;
      const J10 = c * iz,
        J11 = -d * iz,
        J12 = -(c * x + d * y) * iz;
      // point: Jx·R
      Jp[jp] = J00 * R[0] + J01 * R[3] + J02 * R[6];
      Jp[jp + 1] = J00 * R[1] + J01 * R[4] + J02 * R[7];
      Jp[jp + 2] = J00 * R[2] + J01 * R[5] + J02 * R[8];
      Jp[jp + 3] = J10 * R[0] + J11 * R[3] + J12 * R[6];
      Jp[jp + 4] = J10 * R[1] + J11 * R[4] + J12 * R[7];
      Jp[jp + 5] = J10 * R[2] + J11 * R[5] + J12 * R[8];
      if (camOff[obs.cam[o]] >= 0) {
        // rotation: Jx·(−[RX]×), −[v]× = [[0, v2, −v1], [−v2, 0, v0], [v1, −v0, 0]]
        Jc[jc] = -J01 * rz + J02 * ry;
        Jc[jc + 1] = J00 * rz - J02 * rx;
        Jc[jc + 2] = -J00 * ry + J01 * rx;
        const k = jc + dc;
        Jc[k] = -J11 * rz + J12 * ry;
        Jc[k + 1] = J10 * rz - J12 * rx;
        Jc[k + 2] = -J10 * ry + J11 * rx;
        if (dc === 6) {
          Jc[jc + 3] = J00;
          Jc[jc + 4] = J01;
          Jc[jc + 5] = J02;
          Jc[k + 3] = J10;
          Jc[k + 4] = J11;
          Jc[k + 5] = J12;
        }
      }
      if (ni) {
        let q = 0;
        const coeff = distortCoeffJacobian(I, x, y, refine.radial_distortion, refine.tangential_distortion);
        let ci = 0;
        for (const name of names) {
          let gx = 0,
            gy = 0;
          if (name === 'focal') {
            gx = xd;
            gy = A * yd;
          } else if (name === 'cx') gx = 1;
          else if (name === 'cy') gy = 1;
          else {
            const g = coeff[ci++];
            gx = f * g[0];
            gy = f * A * g[1];
          }
          Ji[ji + q] = gx;
          Ji[ji + ni + q] = gy;
          q++;
        }
      }
    }
  };

  // y-space helpers: Jy·x for observation o (2-vector)
  const jyDot = (o: number, x: Float64Array, out: Float64Array) => {
    let v0 = 0,
      v1 = 0;
    const off = camOff[obs.cam[o]];
    if (off >= 0) {
      const jc = o * 2 * dc;
      for (let k = 0; k < dc; k++) {
        v0 += Jc[jc + k] * x[off + k];
        v1 += Jc[jc + dc + k] * x[off + k];
      }
    }
    if (ni) {
      const ji = o * 2 * ni;
      for (let k = 0; k < ni; k++) {
        v0 += Ji[ji + k] * x[intrOff + k];
        v1 += Ji[ji + ni + k] * x[intrOff + k];
      }
    }
    out[0] = v0;
    out[1] = v1;
  };
  // out_y += Jyᵀ·w·q
  const jyTAdd = (o: number, q0: number, q1: number, out: Float64Array) => {
    const off = camOff[obs.cam[o]];
    if (off >= 0) {
      const jc = o * 2 * dc;
      for (let k = 0; k < dc; k++) out[off + k] += Jc[jc + k] * q0 + Jc[jc + dc + k] * q1;
    }
    if (ni) {
      const ji = o * 2 * ni;
      for (let k = 0; k < ni; k++) out[intrOff + k] += Ji[ji + k] * q0 + Ji[ji + ni + k] * q1;
    }
  };

  const Vinv = new Float64Array(np * 9);
  const diagY = new Float64Array(ny);
  let lambda = 1e-3;
  let cost = totalCost(I, cams, points);
  const initialCost = cost;
  let iterations = 0;
  const maxIt = opts.maxIterations ?? 50;
  const v2 = new Float64Array(2);
  let stall = 0;

  for (let iter = 0; iter < maxIt && ny + np > 0; iter++) {
    if (opts.shouldStop?.()) break;
    iterations++;
    linearize();
    // diagonal of U for damping
    diagY.fill(0);
    for (let o = 0; o < nObs; o++) {
      const w = W[o];
      if (!w) continue;
      const off = camOff[obs.cam[o]];
      if (off >= 0) {
        const jc = o * 2 * dc;
        for (let k = 0; k < dc; k++) diagY[off + k] += w * (Jc[jc + k] ** 2 + Jc[jc + dc + k] ** 2);
      }
      if (ni) {
        const ji = o * 2 * ni;
        for (let k = 0; k < ni; k++) diagY[intrOff + k] += w * (Ji[ji + k] ** 2 + Ji[ji + ni + k] ** 2);
      }
    }
    // point blocks V_p (undamped) and gradients g_p
    const Vp = new Float64Array(np * 9);
    const gp = new Float64Array(np * 3);
    for (let o = 0; o < nObs; o++) {
      const w = W[o];
      if (!w) continue;
      const p = obs.pt[o];
      const jp = o * 6;
      for (let a = 0; a < 3; a++) {
        gp[p * 3 + a] += w * (Jp[jp + a] * res[o * 2] + Jp[jp + 3 + a] * res[o * 2 + 1]);
        for (let b = 0; b < 3; b++) Vp[p * 9 + a * 3 + b] += w * (Jp[jp + a] * Jp[jp + b] + Jp[jp + 3 + a] * Jp[jp + 3 + b]);
      }
    }

    let accepted = false;
    for (let attempt = 0; attempt < 10 && !accepted; attempt++) {
      // damped inverse point blocks
      const tmp = new Float64Array(9);
      for (let p = 0; p < np; p++) {
        if (fixedPt?.[p]) {
          Vinv.fill(0, p * 9, p * 9 + 9);
          continue;
        }
        for (let k = 0; k < 9; k++) tmp[k] = Vp[p * 9 + k];
        for (let k = 0; k < 3; k++) tmp[k * 4] += lambda * Math.max(tmp[k * 4], 1e-9) + 1e-12;
        inv3sym(tmp, Vinv.subarray(p * 9, p * 9 + 9));
      }
      const damp = new Float64Array(ny);
      for (let k = 0; k < ny; k++) damp[k] = lambda * Math.max(diagY[k], 1e-9) + 1e-12;

      const z = new Float64Array(3);
      const vz = (p: number, u: ArrayLike<number>) => {
        const V = Vinv.subarray(p * 9, p * 9 + 9);
        z[0] = V[0] * u[0] + V[1] * u[1] + V[2] * u[2];
        z[1] = V[3] * u[0] + V[4] * u[1] + V[5] * u[2];
        z[2] = V[6] * u[0] + V[7] * u[1] + V[8] * u[2];
      };
      // reduced right-hand side: b = −Σ Jyᵀ w (r − Jp V⁻¹ g_p)
      const rhs = new Float64Array(ny);
      for (let p = 0; p < np; p++) {
        vz(p, gp.subarray(p * 3, p * 3 + 3));
        for (let s = ptStart[p]; s < ptStart[p + 1]; s++) {
          const o = ptObs[s];
          const w = W[o];
          if (!w) continue;
          const jp = o * 6;
          const q0 = res[o * 2] - (Jp[jp] * z[0] + Jp[jp + 1] * z[1] + Jp[jp + 2] * z[2]);
          const q1 = res[o * 2 + 1] - (Jp[jp + 3] * z[0] + Jp[jp + 4] * z[1] + Jp[jp + 5] * z[2]);
          jyTAdd(o, -w * q0, -w * q1, rhs);
        }
      }
      // S·x
      const u = new Float64Array(3);
      const vbuf = new Float64Array(nObs * 2);
      const Smul = (x: Float64Array, out: Float64Array) => {
        out.fill(0);
        for (let p = 0; p < np; p++) {
          u[0] = u[1] = u[2] = 0;
          for (let s = ptStart[p]; s < ptStart[p + 1]; s++) {
            const o = ptObs[s];
            const w = W[o];
            if (!w) continue;
            jyDot(o, x, v2);
            vbuf[o * 2] = v2[0];
            vbuf[o * 2 + 1] = v2[1];
            const jp = o * 6;
            for (let a = 0; a < 3; a++) u[a] += w * (Jp[jp + a] * v2[0] + Jp[jp + 3 + a] * v2[1]);
          }
          vz(p, u);
          for (let s = ptStart[p]; s < ptStart[p + 1]; s++) {
            const o = ptObs[s];
            const w = W[o];
            if (!w) continue;
            const jp = o * 6;
            const q0 = vbuf[o * 2] - (Jp[jp] * z[0] + Jp[jp + 1] * z[1] + Jp[jp + 2] * z[2]);
            const q1 = vbuf[o * 2 + 1] - (Jp[jp + 3] * z[0] + Jp[jp + 4] * z[1] + Jp[jp + 5] * z[2]);
            jyTAdd(o, w * q0, w * q1, out);
          }
        }
        for (let k = 0; k < ny; k++) out[k] += damp[k] * x[k];
      };
      // block-Jacobi preconditioner: exact diagonal blocks of S
      const camBlocks = new Float64Array(nc * dc * dc);
      const intrBlock = new Float64Array(ni * ni);
      const Wip = new Float64Array(ni * 3);
      for (let p = 0; p < np; p++) {
        const V = Vinv.subarray(p * 9, p * 9 + 9);
        Wip.fill(0);
        for (let s = ptStart[p]; s < ptStart[p + 1]; s++) {
          const o = ptObs[s];
          const w = W[o];
          if (!w) continue;
          const c = obs.cam[o];
          const jp = o * 6;
          if (camOff[c] >= 0) {
            const jc = o * 2 * dc;
            // block += Jcᵀ w Jc − (Jcᵀ w Jp) V⁻¹ (Jpᵀ w Jc)
            const Wcp = new Float64Array(dc * 3);
            for (let a = 0; a < dc; a++) for (let b = 0; b < 3; b++) Wcp[a * 3 + b] = w * (Jc[jc + a] * Jp[jp + b] + Jc[jc + dc + a] * Jp[jp + 3 + b]);
            const blk = camBlocks.subarray(c * dc * dc, (c + 1) * dc * dc);
            for (let a = 0; a < dc; a++)
              for (let b = 0; b < dc; b++) {
                let sAB = w * (Jc[jc + a] * Jc[jc + b] + Jc[jc + dc + a] * Jc[jc + dc + b]);
                for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) sAB -= Wcp[a * 3 + i] * V[i * 3 + j] * Wcp[b * 3 + j];
                blk[a * dc + b] += sAB;
              }
          }
          if (ni) {
            const ji = o * 2 * ni;
            for (let a = 0; a < ni; a++) {
              for (let b = 0; b < 3; b++) Wip[a * 3 + b] += w * (Ji[ji + a] * Jp[jp + b] + Ji[ji + ni + a] * Jp[jp + 3 + b]);
              for (let b = 0; b < ni; b++) intrBlock[a * ni + b] += w * (Ji[ji + a] * Ji[ji + b] + Ji[ji + ni + a] * Ji[ji + ni + b]);
            }
          }
        }
        if (ni)
          for (let a = 0; a < ni; a++)
            for (let b = 0; b < ni; b++) {
              let s = 0;
              for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += Wip[a * 3 + i] * V[i * 3 + j] * Wip[b * 3 + j];
              intrBlock[a * ni + b] -= s;
            }
      }
      const camL: (Float64Array | null)[] = [];
      for (let c = 0; c < nc; c++) {
        if (camOff[c] < 0) {
          camL.push(null);
          continue;
        }
        const blk = camBlocks.slice(c * dc * dc, (c + 1) * dc * dc);
        for (let k = 0; k < dc; k++) blk[k * dc + k] += damp[camOff[c] + k];
        camL.push(factorPD(blk, dc));
      }
      let intrL: Float64Array | null = null;
      if (ni) {
        const blk = intrBlock.slice();
        for (let k = 0; k < ni; k++) blk[k * ni + k] += damp[intrOff + k];
        intrL = factorPD(blk, ni);
      }
      const precond = (r: Float64Array, out: Float64Array) => {
        out.set(r);
        for (let c = 0; c < nc; c++) if (camOff[c] >= 0 && camL[c]) choleskySolve(camL[c]!, dc, out, camOff[c]);
        if (intrL) choleskySolve(intrL, ni, out, intrOff);
      };
      const dy = pcg(Smul, precond, rhs, ny, Math.min(300, Math.max(30, ny)));

      // back-substitution for points: dp = V⁻¹ (−g_p − Σ Jpᵀ w Jy dy)
      const dp = new Float64Array(np * 3);
      for (let p = 0; p < np; p++) {
        if (fixedPt?.[p]) continue;
        u[0] = -gp[p * 3];
        u[1] = -gp[p * 3 + 1];
        u[2] = -gp[p * 3 + 2];
        for (let s = ptStart[p]; s < ptStart[p + 1]; s++) {
          const o = ptObs[s];
          const w = W[o];
          if (!w) continue;
          jyDot(o, dy, v2);
          const jp = o * 6;
          for (let a = 0; a < 3; a++) u[a] -= w * (Jp[jp + a] * v2[0] + Jp[jp + 3 + a] * v2[1]);
        }
        vz(p, u);
        dp[p * 3] = z[0];
        dp[p * 3 + 1] = z[1];
        dp[p * 3 + 2] = z[2];
      }
      // candidate parameters
      const cand: BACamera[] = cams.map((c, i) => {
        const off = camOff[i];
        if (off < 0) return c;
        const R = mul3(expSO3(dy[off], dy[off + 1], dy[off + 2]), c.R);
        const t = dc === 6 ? Float64Array.of(c.t[0] + dy[off + 3], c.t[1] + dy[off + 4], c.t[2] + dy[off + 5]) : c.t;
        return { R, t, fixed: c.fixed };
      });
      const candPts = points.slice();
      for (let k = 0; k < candPts.length; k++) candPts[k] += dp[k];
      const candI = cloneIntrinsics(I);
      names.forEach((n, k) => setParam(candI, n, getParam(I, n) + dy[intrOff + k]));
      if (candI.focal <= 1) candI.focal = I.focal;
      const cc = totalCost(candI, cand, candPts);
      if (Number.isFinite(cc) && cc < cost) {
        const rel = (cost - cc) / Math.max(cost, 1e-30);
        for (let i = 0; i < nc; i++) cams[i].R = cand[i].R, cams[i].t = cand[i].t;
        points.set(candPts);
        Object.assign(I, candI);
        cost = cc;
        lambda = Math.max(1e-12, lambda / 3);
        accepted = true;
        stall = rel < 1e-9 ? stall + 1 : 0;
      } else lambda = Math.min(1e16, lambda * 6);
    }
    if (!accepted || stall >= 2) break;
  }
  return { cost, initialCost, iterations, intrinsics: I };
}

function factorPD(A: Float64Array, n: number): Float64Array | null {
  for (let attempt = 0; attempt < 6; attempt++) {
    const L = A.slice();
    if (attempt) {
      let tr = 0;
      for (let i = 0; i < n; i++) tr += Math.abs(A[i * n + i]);
      for (let i = 0; i < n; i++) L[i * n + i] += Math.pow(10, attempt * 2 - 14) * (tr / n + 1e-12);
    }
    if (cholesky(L, n)) return L;
  }
  return null;
}

/** Preconditioned conjugate gradients for an SPD operator. */
function pcg(A: (x: Float64Array, out: Float64Array) => void, M: (r: Float64Array, out: Float64Array) => void, b: Float64Array, n: number, maxIt: number): Float64Array {
  const x = new Float64Array(n);
  if (!n) return x;
  const r = b.slice();
  const z = new Float64Array(n);
  M(r, z);
  const p = z.slice();
  const Ap = new Float64Array(n);
  let rz = dotN(r, z);
  const b2 = dotN(b, b);
  if (!(b2 > 0)) return x;
  for (let it = 0; it < maxIt; it++) {
    A(p, Ap);
    const pAp = dotN(p, Ap);
    if (!(pAp > 0)) break;
    const alpha = rz / pAp;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
    }
    if (dotN(r, r) < 1e-20 * b2) break;
    M(r, z);
    const rz2 = dotN(r, z);
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return x;
}

function dotN(a: Float64Array, b: Float64Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
