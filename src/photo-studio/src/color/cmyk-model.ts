// Photo Studio's own analytic CMYK printing model, used to generate the
// "Generic Coated/Uncoated CMYK (Photo Studio)" output profiles.
//
// IMPORTANT: these profiles are approximations of typical offset printing
// conditions built from rounded, self-chosen ink and paper colors. They are
// not certified characterizations of any press, paper or standard printing
// condition and must not be used where a certified profile is required.
//
// Forward model (CMYK -> media-relative CIELAB):
//  - Solid inks and paper are given as CIELAB (D50, absolute).
//  - Colors are handled as reflectance relative to paper in Bradford's
//    sharpened RGB space, where overprints multiply (a three-band Beer-Lambert
//    approximation). A first-surface reflection floor keeps overprints from
//    becoming unrealistically dark, and a trapping exponent makes each later
//    ink transfer slightly less than the first.
//  - Halftones mix the 16 Neugebauer primaries with Demichel area weights
//    under the Yule-Nielsen n-modification (Yule & Nielsen 1951), after a
//    parabolic mechanical dot gain on each ink.
// Inverse (Lab -> CMYK): per-node damped Gauss-Newton (Levenberg-Marquardt)
// with box and total-ink constraints and a black generation preference,
// sampled into a lut16 B2A table, so the result behaves like an ICC profile.
import {
  BRADFORD,
  D50,
  decodeLab,
  labToXYZ,
  mat3Inv,
  mat3Mul,
  mat3Vec,
  xyzToLab,
  encodeLab,
  type Vec3,
} from './color-math';
import { deltaE76 } from './delta-e';
import type { Clut, Lut16Tag, Profile } from './icc-lut';
import { checkCancelled, type Progress } from '../imaging/types';

export type BlackGeneration = 'none' | 'light' | 'medium' | 'heavy' | 'maximum';
export type CmykModelOptions = {
  name: string;
  // Paper and solid ink colors, CIELAB D50 (absolute, measured on this paper).
  paper: Vec3;
  inks: { c: Vec3; m: Vec3; y: Vec3; k: Vec3 };
  // Mechanical tone value increase at 50% (0.1 = 10%), before optical gain.
  dotGain: number;
  // Yule-Nielsen n (optical dot gain); 1 is Murray-Davies.
  yuleNielsen: number;
  // First-surface reflectance floor relative to paper.
  surface: number;
  // Exponent applied to the transmittance of each ink printed over another.
  trap: number;
  // Percent, for example 300.
  totalInkLimit: number;
  blackInkLimit: number;
  blackGeneration: BlackGeneration;
  // CLUT grid sizes for the generated tables.
  a2bGrid?: number;
  b2aGrid?: number;
};

// Self-chosen, rounded values in the range typical for sheet-fed offset on
// coated and uncoated stock.
export const GENERIC_COATED: CmykModelOptions = {
  name: 'Generic Coated CMYK (Photo Studio)',
  paper: [95, 0, -2],
  inks: { c: [55, -37, -50], m: [48, 74, -3], y: [89, -5, 93], k: [16, 0, 0] },
  dotGain: 0.04,
  yuleNielsen: 1.6,
  surface: 0.01,
  trap: 0.92,
  totalInkLimit: 300,
  blackInkLimit: 100,
  blackGeneration: 'medium',
};
export const GENERIC_UNCOATED: CmykModelOptions = {
  name: 'Generic Uncoated CMYK (Photo Studio)',
  paper: [94, 0, -3],
  inks: { c: [59, -27, -43], m: [54, 59, -2], y: [87, -3, 76], k: [32, 1, 1] },
  dotGain: 0.07,
  yuleNielsen: 2,
  surface: 0.02,
  trap: 0.9,
  totalInkLimit: 260,
  blackInkLimit: 100,
  blackGeneration: 'medium',
};

// Black generation curves: K target from the gray component (the smallest of
// C, M, Y in the CMY-only separation): start point and exponent.
const BG: Record<BlackGeneration, [number, number] | null> = {
  none: null,
  light: [0.4, 1.5],
  medium: [0.2, 1.2],
  heavy: [0.05, 1],
  maximum: [0, 0.6],
};

export class CmykModel {
  readonly opts: CmykModelOptions;
  // Paper, absolute D50 XYZ (the profile's media white).
  readonly paperXYZ: Vec3;
  readonly til: number;
  readonly kMax: number;
  private q = new Float64Array(16 * 3);
  private toXYZ: number[];
  private n: number;
  private gain: number;
  private bg: [number, number] | null;
  private lab = new Float64Array(3);
  private xyz = new Float64Array(3);

  constructor(opts: CmykModelOptions) {
    this.opts = opts;
    this.til = opts.totalInkLimit / 100;
    this.kMax = Math.min(1, opts.blackInkLimit / 100);
    this.n = opts.yuleNielsen;
    this.gain = opts.dotGain;
    this.bg = BG[opts.blackGeneration];
    const paper = labToXYZ(opts.paper) as Vec3;
    this.paperXYZ = paper;
    const P = mat3Vec(BRADFORD, paper);
    const s = opts.surface;
    const inks = [opts.inks.c, opts.inks.m, opts.inks.y, opts.inks.k].map((lab) => {
      const S = mat3Vec(BRADFORD, labToXYZ(lab));
      // Body transmittance (squared, two passes) after removing the surface floor.
      return S.map((v, i) => Math.max(1e-4, (v / P[i] - s) / (1 - s)));
    });
    // Printing order K, C, M, Y: later inks transfer less onto earlier ones.
    const order = [3, 0, 1, 2];
    for (let combo = 0; combo < 16; combo++) {
      const t = [1, 1, 1];
      let printed = 0;
      for (const ink of order) {
        if (!(combo & (1 << ink))) continue;
        for (let ch = 0; ch < 3; ch++) t[ch] *= printed ? inks[ink][ch] ** opts.trap : inks[ink][ch];
        printed++;
      }
      for (let ch = 0; ch < 3; ch++) this.q[combo * 3 + ch] = (s + (1 - s) * t[ch]) ** (1 / this.n);
    }
    // Relative reflectance in sharpened space -> media-relative XYZ.
    const scale = [D50[0] / paper[0], D50[1] / paper[1], D50[2] / paper[2]];
    this.toXYZ = mat3Mul(
      [scale[0], 0, 0, 0, scale[1], 0, 0, 0, scale[2]],
      mat3Mul(mat3Inv(BRADFORD), [P[0], 0, 0, 0, P[1], 0, 0, 0, P[2]]),
    );
  }

  private eff(a: number) {
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    return a + 4 * this.gain * a * (1 - a);
  }

  // Media-relative D50 XYZ (paper = PCS white).
  xyzOf(c: number, m: number, y: number, k: number, out: Float64Array | number[] = new Float64Array(3)) {
    c = this.eff(c);
    m = this.eff(m);
    y = this.eff(y);
    k = this.eff(k);
    const q = this.q,
      c0 = 1 - c,
      m0 = 1 - m,
      y0 = 1 - y,
      k0 = 1 - k;
    const w = [c0 * m0 * y0, c * m0 * y0, c0 * m * y0, c * m * y0, c0 * m0 * y, c * m0 * y, c0 * m * y, c * m * y];
    let r0 = 0,
      r1 = 0,
      r2 = 0;
    for (let i = 0; i < 8; i++) {
      const a = w[i] * k0,
        b = w[i] * k,
        p = i * 3,
        pk = (i + 8) * 3;
      r0 += a * q[p] + b * q[pk];
      r1 += a * q[p + 1] + b * q[pk + 1];
      r2 += a * q[p + 2] + b * q[pk + 2];
    }
    const n = this.n;
    r0 = r0 ** n;
    r1 = r1 ** n;
    r2 = r2 ** n;
    const t = this.toXYZ;
    out[0] = t[0] * r0 + t[1] * r1 + t[2] * r2;
    out[1] = t[3] * r0 + t[4] * r1 + t[5] * r2;
    out[2] = t[6] * r0 + t[7] * r1 + t[8] * r2;
    return out;
  }
  // Media-relative CIELAB D50.
  labOf(c: number, m: number, y: number, k: number, out: Float64Array | number[] = new Float64Array(3)) {
    this.xyzOf(c, m, y, k, this.xyz);
    return xyzToLab(this.xyz, D50, out);
  }

  // --- Inversion ---------------------------------------------------------

  private kTarget(gc: number) {
    if (!this.bg) return 0;
    const [start, e] = this.bg;
    if (gc <= start) return 0;
    return this.kMax * Math.min(1, ((gc - start) / (1 - start)) ** e);
  }

  // Project onto 0 <= x <= upper, sum <= limit (Euclidean, by bisection).
  private project(x: Float64Array, nv: number, fixedK: number, til: number) {
    const limit = nv === 4 ? til : Math.max(0, til - fixedK);
    const upper = (i: number) => (i === 3 ? this.kMax : 1);
    let sum = 0;
    for (let i = 0; i < nv; i++) {
      x[i] = x[i] < 0 ? 0 : x[i] > upper(i) ? upper(i) : x[i];
      sum += x[i];
    }
    if (sum <= limit) return;
    let lo = 0,
      hi = 1;
    for (let it = 0; it < 30; it++) {
      const tau = (lo + hi) / 2;
      let s = 0;
      for (let i = 0; i < nv; i++) s += Math.min(upper(i), Math.max(0, x[i] - tau));
      if (s > limit) lo = tau;
      else hi = tau;
    }
    for (let i = 0; i < nv; i++) x[i] = Math.min(upper(i), Math.max(0, x[i] - hi));
  }

  private trial = new Float64Array(4);
  private tlab = new Float64Array(3);
  private J = new Float64Array(12);
  private A = new Float64Array(16);
  private g = new Float64Array(4);
  private d = new Float64Array(4);
  private M = new Float64Array(36);
  private free = new Int32Array(4);

  // Lab and its analytic 3x4 Jacobian (row-major) at a CMYK point.
  labJacobian(x: ArrayLike<number>, lab: Float64Array, J: Float64Array) {
    const gn = this.gain,
      q = this.q,
      n = this.n;
    const e = [0, 0, 0, 0],
      de = [0, 0, 0, 0];
    for (let v = 0; v < 4; v++) {
      const a = x[v] < 0 ? 0 : x[v] > 1 ? 1 : x[v];
      e[v] = a + 4 * gn * a * (1 - a);
      de[v] = 1 + 4 * gn * (1 - 2 * a);
    }
    const S = [0, 0, 0],
      dS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 16; i++) {
      const bc = i & 1,
        bm = i & 2,
        by = i & 4,
        bk = i & 8;
      const wc = bc ? e[0] : 1 - e[0],
        wm = bm ? e[1] : 1 - e[1],
        wy = by ? e[2] : 1 - e[2],
        wk = bk ? e[3] : 1 - e[3];
      const w = wc * wm * wy * wk;
      const dc = (bc ? 1 : -1) * wm * wy * wk,
        dm = (bm ? 1 : -1) * wc * wy * wk,
        dy = (by ? 1 : -1) * wc * wm * wk,
        dk = (bk ? 1 : -1) * wc * wm * wy;
      for (let ch = 0; ch < 3; ch++) {
        const qq = q[i * 3 + ch];
        S[ch] += w * qq;
        dS[ch * 4] += dc * qq;
        dS[ch * 4 + 1] += dm * qq;
        dS[ch * 4 + 2] += dy * qq;
        dS[ch * 4 + 3] += dk * qq;
      }
    }
    const R = [S[0] ** n, S[1] ** n, S[2] ** n];
    const dR = [(n * R[0]) / S[0], (n * R[1]) / S[1], (n * R[2]) / S[2]];
    const t = this.toXYZ,
      X = [0, 0, 0];
    for (let r = 0; r < 3; r++) X[r] = t[r * 3] * R[0] + t[r * 3 + 1] * R[1] + t[r * 3 + 2] * R[2];
    xyzToLab(X, D50, lab);
    const df = [0, 0, 0];
    for (let r = 0; r < 3; r++) {
      const tt = X[r] / D50[r];
      df[r] = (tt > 216 / 24389 ? 1 / (3 * Math.cbrt(tt) ** 2) : 24389 / 27 / 116) / D50[r];
    }
    for (let v = 0; v < 4; v++) {
      const g0 = dR[0] * dS[v] * de[v],
        g1 = dR[1] * dS[4 + v] * de[v],
        g2 = dR[2] * dS[8 + v] * de[v];
      const dx = (t[0] * g0 + t[1] * g1 + t[2] * g2) * df[0],
        dy = (t[3] * g0 + t[4] * g1 + t[5] * g2) * df[1],
        dz = (t[6] * g0 + t[7] * g1 + t[8] * g2) * df[2];
      J[v] = 116 * dy;
      J[4 + v] = 500 * (dx - dy);
      J[8 + v] = 200 * (dy - dz);
    }
    return lab;
  }

  // Levenberg-Marquardt on the Lab residual with an active set for the box
  // bounds and projection for the ink limit. With nv = 4 the residual also
  // holds w * (K - kt), which selects K along the one-dimensional family of
  // CMYK mixtures matching a color. With nv = 3, K stays at x[3].
  // Returns the remaining Lab error (ΔE*ab).
  solve(target: ArrayLike<number>, x: Float64Array, nv: 3 | 4, kt = 0, w = 4, til = this.til, iterations = 30): number {
    const lab = this.lab,
      tl = this.tlab,
      tr = this.trial,
      J = this.J,
      A = this.A,
      g = this.g,
      d = this.d,
      free = this.free;
    const fixedK = x[3];
    this.project(x, nv, fixedK, til);
    const reg = nv === 4;
    const costOf = (v: Float64Array, l: Float64Array) => {
      const r0 = l[0] - target[0],
        r1 = l[1] - target[1],
        r2 = l[2] - target[2];
      const rk = reg ? w * (v[3] - kt) : 0;
      return r0 * r0 + r1 * r1 + r2 * r2 + rk * rk;
    };
    this.labJacobian(x, lab, J);
    let cost = costOf(x, lab);
    let lambda = 1e-3;
    for (let it = 0; it < iterations && cost > 1e-8; it++) {
      const r0 = lab[0] - target[0],
        r1 = lab[1] - target[1],
        r2 = lab[2] - target[2];
      for (let a = 0; a < nv; a++) {
        g[a] = J[a] * r0 + J[4 + a] * r1 + J[8 + a] * r2 + (reg && a === 3 ? w * w * (x[3] - kt) : 0);
        for (let b = 0; b < nv; b++)
          A[a * 4 + b] = J[a] * J[b] + J[4 + a] * J[4 + b] + J[8 + a] * J[8 + b] + (reg && a === 3 && b === 3 ? w * w : 0);
      }
      // Variables pinned at a bound with the gradient pushing outward stay put.
      let nf = 0;
      for (let a = 0; a < nv; a++) {
        const ub = a === 3 ? this.kMax : 1;
        if ((x[a] <= 1e-12 && g[a] > 0) || (x[a] >= ub - 1e-12 && g[a] < 0)) continue;
        free[nf++] = a;
      }
      if (!nf) break;
      // On the ink-limit face, steps that would add ink are taken within the
      // face instead (equality-constrained Newton step), not projected back.
      let sum = 0;
      for (let a = 0; a < nv; a++) sum += x[a];
      const limit = reg ? til : til - fixedK;
      const onFace = sum >= limit - 1e-7;
      let improved = false;
      for (let tries = 0; tries < 6 && !improved; tries++) {
        if (!solveDamped(A, g, free, nf, lambda, d, this.M, false)) {
          lambda *= 10;
          continue;
        }
        if (onFace) {
          let added = 0;
          for (let f = 0; f < nf; f++) added -= d[f];
          if (added > 0 && nf > 1 && !solveDamped(A, g, free, nf, lambda, d, this.M, true)) {
            lambda *= 10;
            continue;
          }
        }
        tr.set(x);
        for (let f = 0; f < nf; f++) tr[free[f]] -= d[f];
        this.project(tr, nv, fixedK, til);
        this.labOf(tr[0], tr[1], tr[2], tr[3], tl);
        const next = costOf(tr, tl);
        if (next < cost) {
          const gain = cost - next;
          x.set(tr);
          cost = next;
          lambda = Math.max(lambda / 4, 1e-9);
          improved = true;
          if (gain < 1e-7 * (1 + cost)) it = iterations;
        } else lambda *= 4;
      }
      if (!improved) break;
      this.labJacobian(x, lab, J);
    }
    this.labOf(x[0], x[1], x[2], x[3], lab);
    return deltaE76(lab, target);
  }

  // Full separation with black generation and ink limits. `x` warm-starts
  // and receives the CMYK result; `cmy` is a warm-start for the K = 0 pass.
  separate(target: ArrayLike<number>, x: Float64Array = new Float64Array([0.3, 0.3, 0.3, 0]), cmy?: Float64Array): number {
    const base = cmy ?? new Float64Array([x[0], x[1], x[2], 0]);
    base[3] = 0;
    // CMY-only separation (no ink limit pressure) estimates the gray component.
    this.solve(target, base, 3, 0, 0, 3);
    const gc = Math.min(base[0], base[1], base[2]);
    const kt = this.kTarget(gc);
    if (!this.bg) {
      x[3] = 0;
      return this.solve(target, x, 3);
    }
    if (x[3] === 0 && kt > 0) x[3] = kt;
    const e1 = this.solve(target, x, 4, kt);
    const keep = new Float64Array(x);
    let err = this.solve(target, x, 3);
    if (err > e1 + 1e-3) {
      x.set(keep);
      err = e1;
    }
    // When the preferred black amount cannot reach the color (deep shadows
    // under the ink limit), color accuracy wins over the black preference.
    if (err > 0.5) {
      const free = new Float64Array(x);
      const e3 = this.solve(target, free, 4, 0, 0);
      if (e3 < err - 0.1) {
        x.set(free);
        err = e3;
      }
    }
    return err;
  }
}

// Solve (A + λ diag(A) + εI) d = g restricted to the free variables, by
// Gaussian elimination with partial pivoting (n <= 4). With `keepSum` the
// step is constrained to sum(d) = 0 through a Lagrange multiplier row.
function solveDamped(
  A: Float64Array,
  g: Float64Array,
  free: Int32Array,
  n: number,
  lambda: number,
  out: Float64Array,
  M: Float64Array,
  keepSum: boolean,
): boolean {
  const size = keepSum ? n + 1 : n,
    W = 6;
  for (let i = 0; i < size; i++) for (let j = 0; j <= W - 1; j++) M[i * W + j] = 0;
  for (let i = 0; i < n; i++) {
    const fi = free[i];
    for (let j = 0; j < n; j++) M[i * W + j] = A[fi * 4 + free[j]];
    M[i * W + i] += lambda * A[fi * 4 + fi] + 1e-9;
    M[i * W + 5] = g[fi];
    if (keepSum) {
      M[i * W + n] = 1;
      M[n * W + i] = 1;
    }
  }
  for (let c = 0; c < size; c++) {
    let p = c;
    for (let r = c + 1; r < size; r++) if (Math.abs(M[r * W + c]) > Math.abs(M[p * W + c])) p = r;
    if (Math.abs(M[p * W + c]) < 1e-14) return false;
    if (p !== c)
      for (let j = 0; j < W; j++) {
        const t = M[c * W + j];
        M[c * W + j] = M[p * W + j];
        M[p * W + j] = t;
      }
    for (let r = c + 1; r < size; r++) {
      const f = M[r * W + c] / M[c * W + c];
      if (f) for (let j = c; j < W; j++) M[r * W + j] -= f * M[c * W + j];
    }
  }
  const sol = [0, 0, 0, 0, 0];
  for (let r = size - 1; r >= 0; r--) {
    let s = M[r * W + 5];
    for (let j = r + 1; j < size; j++) s -= M[r * W + j] * sol[j];
    sol[r] = s / M[r * W + r];
  }
  for (let i = 0; i < n; i++) out[i] = sol[i];
  return true;
}

// --- Gamut boundary and perceptual mapping --------------------------------

// Maximum chroma per (L*, hue) cell, from samples of the forward model.
class GamutBoundary {
  static L = 101;
  static H = 72;
  cmax = new Float32Array(GamutBoundary.L * GamutBoundary.H);
  add(lab: ArrayLike<number>) {
    const L = Math.round(Math.max(0, Math.min(100, lab[0])));
    const c = Math.hypot(lab[1], lab[2]);
    let h = Math.atan2(lab[2], lab[1]) / (2 * Math.PI);
    if (h < 0) h += 1;
    const hi = Math.round(h * GamutBoundary.H) % GamutBoundary.H;
    const i = L * GamutBoundary.H + hi;
    if (c > this.cmax[i]) this.cmax[i] = c;
  }
  // Fill holes along hue, then take a running maximum-preserving smooth.
  finish() {
    const { L: NL, H: NH } = GamutBoundary;
    for (let l = 0; l < NL; l++) {
      const row = this.cmax.subarray(l * NH, l * NH + NH);
      if (!row.some((v) => v > 0)) continue;
      const copy = Float32Array.from(row);
      for (let h = 0; h < NH; h++) {
        if (copy[h] > 0) continue;
        let a = 1,
          b = 1;
        while (copy[(h - a + NH) % NH] === 0 && a < NH) a++;
        while (copy[(h + b) % NH] === 0 && b < NH) b++;
        const va = copy[(h - a + NH) % NH],
          vb = copy[(h + b) % NH];
        row[h] = (va * b + vb * a) / (a + b);
      }
      // A cell max of discrete samples underestimates; smooth with neighbors.
      const s = Float32Array.from(row);
      for (let h = 0; h < NH; h++) row[h] = Math.max(s[h], (s[(h + NH - 1) % NH] + s[(h + 1) % NH]) / 2);
    }
  }
  chroma(L: number, hueDeg: number) {
    const { L: NL, H: NH } = GamutBoundary;
    const l = Math.max(0, Math.min(NL - 1.0001, L)),
      li = Math.floor(l),
      lf = l - li;
    let h = ((hueDeg % 360) + 360) % 360;
    h = (h / 360) * NH;
    const hi = Math.floor(h) % NH,
      hf = h - Math.floor(h),
      hj = (hi + 1) % NH;
    const at = (a: number, b: number) => this.cmax[a * NH + b];
    const lo = at(li, hi) * (1 - hf) + at(li, hj) * hf,
      up = at(li + 1, hi) * (1 - hf) + at(li + 1, hj) * hf;
    return lo * (1 - lf) + up * lf;
  }
}

// --- Profile generation ---------------------------------------------------

const q16 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 65535) / 65535;
const identityTable = (n: number) => Float32Array.from({ length: n }, (_, i) => i / (n - 1));
const identityTables = (n: number) => Array.from({ length: n }, () => Float32Array.from([0, 1]));
// B2A input shaper for legacy 16-bit Lab: stretches L so 0xFF00 (L* = 100,
// the paper) lands exactly on the last grid node instead of between nodes.
const legacyLShaper = () => Float32Array.from({ length: 4096 }, (_, j) => q16(Math.min(1, ((j / 4095) * 65535) / 65280)));

export type CmykBuild = { profile: Profile; model: CmykModel; blackL: number };

const builds = new Map<string, CmykBuild>();
// Takes about a second; run it in a worker and cache serializeIcc(profile).
export function buildCmyk(opts: CmykModelOptions, key = `cmyk:${JSON.stringify(opts)}`, progress?: Progress): CmykBuild {
  const hit = builds.get(key);
  if (hit) return hit;
  const model = new CmykModel(opts);
  const ga = opts.a2bGrid ?? 17,
    gb = opts.b2aGrid ?? 33;
  const lab = new Float64Array(3),
    enc = new Float64Array(3);
  const gbd = new GamutBoundary();
  // Darkest reproducible color within the ink limits (L* only).
  const dark = new Float64Array([0.8, 0.7, 0.7, model.kMax]);
  const blackL = Math.max(0, (model.solve([0, 0, 0], dark, 4, model.kMax, 0.5), model.labOf(dark[0], dark[1], dark[2], dark[3])[0]));
  const toPerceptual = (L: number) => Math.max(0, ((L - blackL) * 100) / (100 - blackL));

  // A2B: CMYK grid -> legacy 16-bit Lab. A2B1 is plain media-relative; A2B0
  // (shared by A2B2) stretches the printable L* range to 0-100, the usual v2
  // perceptual convention that a B2A0 compression mirrors.
  const nodes = ga ** 4;
  // Lightness of the darkest printable color of any hue.
  let darkL = 100;
  const rel = new Float32Array(nodes * 3),
    per = new Float32Array(nodes * 3);
  for (let i = 0; i < nodes; i++) {
    const c = Math.floor(i / (ga * ga * ga)) / (ga - 1),
      m = (Math.floor(i / (ga * ga)) % ga) / (ga - 1),
      y = (Math.floor(i / ga) % ga) / (ga - 1),
      k = (i % ga) / (ga - 1);
    model.labOf(c, m, y, k, lab);
    if (c + m + y + k <= model.til + 1e-9 && k <= model.kMax + 1e-9) {
      gbd.add(lab);
      if (lab[0] < darkL) darkL = lab[0];
    }
    encodeLab(lab, 'legacy', enc);
    for (let ch = 0; ch < 3; ch++) rel[i * 3 + ch] = q16(enc[ch]);
    lab[0] = toPerceptual(lab[0]);
    encodeLab(lab, 'legacy', enc);
    for (let ch = 0; ch < 3; ch++) per[i * 3 + ch] = q16(enc[ch]);
  }
  gbd.finish();
  const clut = (data: Float32Array, inputs: number, outputs: number, g: number): Clut => ({
    grid: new Array(inputs).fill(g),
    inputs,
    outputs,
    data,
    precision: 2,
  });
  const lut16 = (data: Float32Array, inputs: number, outputs: number, g: number): Lut16Tag => ({
    type: 'lut16',
    inputs,
    outputs,
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    // lut16 input tables share one length.
    inCurves: inputs === 3 ? [legacyLShaper(), identityTable(4096), identityTable(4096)] : identityTables(inputs),
    clut: clut(data, inputs, outputs, g),
    outCurves: identityTables(outputs),
  });

  // B2A: legacy Lab grid -> CMYK, warm-starting each node from its neighbor.
  const bNodes = gb ** 3;
  const b2aRel = new Float32Array(bNodes * 4),
    b2aPer = new Float32Array(bNodes * 4),
    gamut = new Float32Array(bNodes);
  const target = new Float64Array(3);
  let done = 0;
  const separateGrid = (out: Float32Array, perceptual: boolean, residual?: Float32Array) => {
    const x = new Float64Array([0, 0, 0, 0]),
      cmy = new Float64Array(4);
    const rowStart = new Float64Array(gb * 4),
      rowCmy = new Float64Array(gb * 4);
    for (let i = 0; i < gb; i++)
      for (let j = 0; j < gb; j++) {
        if (j === 0) {
          checkCancelled(progress);
          progress?.report?.(done++ / (2 * gb));
        }
        // Warm start from the first node of the previous a-row at this L.
        if (i > 0 || j > 0) {
          x.set(rowStart.subarray(j * 4, j * 4 + 4));
          cmy.set(rowCmy.subarray(j * 4, j * 4 + 4));
        }
        for (let k = 0; k < gb; k++) {
          decodeLab([i / (gb - 1), j / (gb - 1), k / (gb - 1)], 'legacy', target);
          target[0] = (100 * i) / (gb - 1);
          const L0 = target[0];
          if (perceptual) mapPerceptual(target, blackL, gbd);
          // Colorimetric: lightness below the darkest printable color clips
          // to it with hue and chroma kept, so neutral shadows stay neutral
          // instead of the nearest (darker but colored) overprint winning.
          else if (L0 < darkL) target[0] = darkL;
          let err = model.separate(target, x, cmy);
          if (target[0] !== L0 && !perceptual) {
            // The gamut table measures the distance to the requested color.
            model.labOf(x[0], x[1], x[2], x[3], lab);
            target[0] = L0;
            err = deltaE76(lab, target);
          }
          const node = (i * gb + j) * gb + k;
          for (let ch = 0; ch < 4; ch++) out[node * 4 + ch] = q16(x[ch]);
          if (residual) residual[node] = q16(Math.min(1, err / 10));
          if (k === 0) {
            rowStart.set(x, j * 4);
            rowCmy.set(cmy, j * 4);
          }
        }
      }
  };
  separateGrid(b2aRel, false, gamut);
  separateGrid(b2aPer, true);

  const a2bRel = lut16(rel, 4, 3, ga),
    a2bPer = lut16(per, 4, 3, ga);
  const b2aRelTag = lut16(b2aRel, 3, 4, gb),
    b2aPerTag = lut16(b2aPer, 3, 4, gb);
  const profile: Profile = {
    name: opts.name,
    copyright: 'Generated by Photo Studio from an analytic printing model; approximate, not a certified characterization. No copyright.',
    version: 2.1,
    deviceClass: 'prtr',
    colorSpace: 'CMYK',
    channels: 4,
    pcs: 'Lab',
    renderingIntent: 0,
    mediaWhite: [...model.paperXYZ] as Vec3,
    a2b: [a2bPer, a2bRel, a2bPer],
    b2a: [b2aPerTag, b2aRelTag, b2aPerTag],
    gamut: lut16(gamut, 3, 1, gb),
    key,
  };
  const build = { profile, model, blackL };
  builds.set(key, build);
  return build;
}

export function buildCmykProfile(opts: CmykModelOptions, key?: string, progress?: Progress): Profile {
  return buildCmyk(opts, key, progress).profile;
}

// Perceptual gamut mapping for B2A0: L* compressed linearly from 0-100 onto
// the printable range, then chroma rolled off softly above 80% of the
// printable maximum at that lightness and hue (hue preserved in CIELAB).
function mapPerceptual(lab: Float64Array, blackL: number, gbd: GamutBoundary) {
  const L = blackL + ((100 - blackL) * Math.max(0, lab[0])) / 100;
  const c = Math.hypot(lab[1], lab[2]);
  lab[0] = L;
  if (c < 1e-9) return;
  const h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  const cmax = gbd.chroma(L, h);
  const knee = 0.8 * cmax;
  let c2 = c;
  if (c > knee) c2 = cmax > knee ? knee + (cmax - knee) * Math.tanh((c - knee) / (cmax - knee)) : knee;
  const s = c2 / c;
  lab[1] *= s;
  lab[2] *= s;
}

