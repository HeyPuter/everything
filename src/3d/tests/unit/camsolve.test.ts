import { describe, expect, it } from 'vitest';
import { solveCamera, cameraWorldMatrix, type SolveTrack, type SolveSettings } from '../../src/tracking/solve/pipeline';
import { distort, undistort, toPixel, fromPixel, type Intrinsics } from '../../src/tracking/solve/intrinsics';
import { essentialRansac, poseFromEssential, triangulate, dltPose, identityPose, type UV } from '../../src/tracking/solve/geometry';
import { expSO3, mul3, mulVec3, rng, svd, transpose3, logSO3 } from '../../src/tracking/solve/linalg';

// ---------------------------------------------------------------------------
// synthetic scenes

interface Scene {
  I: Intrinsics;
  W: number;
  H: number;
  /** world → camera (computer-vision convention) per frame */
  poses: { R: Float64Array; t: Float64Array }[];
  points: Float64Array[];
  tracks: SolveTrack[];
}

function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
}

function intrinsics(over: Partial<Intrinsics> = {}): Intrinsics {
  return { focal: 1100, cx: 640, cy: 360, aspect: 1, model: 'POLYNOMIAL', k: [0, 0, 0, 0], p: [0, 0], ...over };
}

/**
 * A camera dollying sideways and forward while panning, looking at a box of random points.
 * Tracks live for a limited span of frames like real feature tracks.
 */
function makeScene(opts: { frames?: number; points?: number; noise?: number; seed?: number; I?: Intrinsics; tripod?: boolean; planar?: boolean; span?: number; outliers?: number } = {}): Scene {
  const r = rng(opts.seed ?? 7);
  const W = 1280,
    H = 720;
  const I = opts.I ?? intrinsics();
  const nF = opts.frames ?? 60;
  const poses: Scene['poses'] = [];
  for (let f = 0; f < nF; f++) {
    const s = f / (nF - 1);
    // camera center moves along x and z; yaw changes slowly
    const C = opts.tripod ? [0, 0, 0] : [-1.5 + 3 * s, 0.3 * Math.sin(s * 3), 0.8 * s];
    const R = mul3(expSO3(0.05 * Math.sin(s * 2), -0.35 + 0.7 * s, 0.03 * s), expSO3(0, 0, 0));
    const t = mulVec3(R, C);
    poses.push({ R, t: Float64Array.of(-t[0], -t[1], -t[2]) });
  }
  const points: Float64Array[] = [];
  const nP = opts.points ?? 150;
  for (let i = 0; i < nP; i++) {
    if (opts.tripod) {
      // directions spread in front of the camera at various depths
      const yaw = (r() - 0.5) * 1.6,
        pitch = (r() - 0.5) * 0.6;
      const d = 4 + r() * 20;
      points.push(Float64Array.of(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d));
    } else if (opts.planar) points.push(Float64Array.of((r() - 0.5) * 12, 1.5 + (r() - 0.5) * 0.02, 6 + r() * 8));
    else points.push(Float64Array.of((r() - 0.5) * 10, (r() - 0.5) * 5, 5 + r() * 8));
  }
  const noise = opts.noise ?? 0.3;
  const span = opts.span ?? nF;
  const tracks: SolveTrack[] = [];
  points.forEach((X, i) => {
    const start = span >= nF ? 0 : Math.floor(r() * (nF - span / 2));
    const tr: SolveTrack = { name: `T${i}`, weight: 1, frames: [], x: [], y: [] };
    const bad = i < (opts.outliers ?? 0);
    for (let f = start; f < Math.min(nF, start + span); f++) {
      const P = poses[f];
      const c = mulVec3(P.R, X);
      const cx = c[0] + P.t[0],
        cy = c[1] + P.t[1],
        cz = c[2] + P.t[2];
      if (cz <= 0.1) continue;
      let [px, py] = toPixel(I, cx / cz, -cy / cz);
      if (px < 0 || py < 0 || px > W || py > H) continue;
      px += gauss(r) * noise;
      py += gauss(r) * noise;
      if (bad && f % 7 === 3) {
        px += 40;
        py -= 25;
      }
      tr.frames.push(f + 1);
      tr.x.push(px);
      tr.y.push(py);
    }
    if (tr.frames.length >= 2) tracks.push(tr);
  });
  return { I, W, H, poses, points, tracks };
}

function settings(I: Intrinsics, over: Partial<SolveSettings> = {}): SolveSettings {
  return { intrinsics: I, refine: { focal_length: false, principal_point: false, radial_distortion: false, tangential_distortion: false }, tripod: false, use_keyframe_selection: true, keyframe_a: 1, keyframe_b: 30, ...over };
}

/** Similarity alignment (Umeyama) of `a` onto `b`; returns the RMS residual relative to the spread of b. */
function alignedResidual(a: number[][], b: number[][]): number {
  const n = a.length;
  const ma = [0, 0, 0],
    mb = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) ((ma[k] += a[i][k] / n), (mb[k] += b[i][k] / n));
  const C = new Float64Array(9);
  let va = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i].map((v, k) => v - ma[k]),
      db = b[i].map((v, k) => v - mb[k]);
    va += da[0] ** 2 + da[1] ** 2 + da[2] ** 2;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] += (db[r] * da[c]) / n;
  }
  va /= n;
  const { U, S, V } = svd(C, 3, 3);
  const Dm = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
  const det = (M: Float64Array) => M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
  if (det(U) * det(V) < 0) Dm[8] = -1;
  const R = mul3(mul3(U, Dm), transpose3(V));
  const s = (S[0] * Dm[0] + S[1] * Dm[4] + S[2] * Dm[8]) / va;
  let err = 0,
    spread = 0;
  for (let i = 0; i < n; i++) {
    const p = mulVec3(R, a[i].map((v, k) => v - ma[k]));
    for (let k = 0; k < 3; k++) {
      err += (s * p[k] + mb[k] - b[i][k]) ** 2;
      spread += (b[i][k] - mb[k]) ** 2;
    }
  }
  return Math.sqrt(err / Math.max(1e-12, spread));
}

const center = (R: ArrayLike<number>, t: ArrayLike<number>) => {
  const c = mulVec3(transpose3(R), t);
  return [-c[0], -c[1], -c[2]];
};

// ---------------------------------------------------------------------------

describe('camera solver: building blocks', () => {
  it('SVD reconstructs a random matrix', () => {
    const r = rng(3);
    const A = Float64Array.from({ length: 5 * 4 }, () => r() - 0.5);
    const { U, S, V } = svd(A, 5, 4);
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += U[i * 4 + k] * S[k] * V[j * 4 + k];
        expect(s).toBeCloseTo(A[i * 4 + j], 10);
      }
    expect(S[0]).toBeGreaterThanOrEqual(S[1]);
  });

  it('rotation vector round trip', () => {
    const R = expSO3(0.3, -1.1, 0.7);
    const w = logSO3(R);
    expect(w[0]).toBeCloseTo(0.3, 9);
    expect(w[1]).toBeCloseTo(-1.1, 9);
    expect(w[2]).toBeCloseTo(0.7, 9);
  });

  for (const model of ['POLYNOMIAL', 'DIVISION', 'BROWN'] as const)
    it(`${model} distortion inverts`, () => {
      const I = intrinsics({ model, k: [-0.12, 0.03, 0.004, 0.001], p: [0.001, -0.0015] });
      for (const [x, y] of [
        [0.3, -0.2],
        [-0.45, 0.25],
        [0.05, 0.01],
      ]) {
        const [xd, yd] = distort(I, x, y);
        const [ux, uy] = undistort(I, xd, yd);
        expect(ux).toBeCloseTo(x, 9);
        expect(uy).toBeCloseTo(y, 9);
        const [px, py] = toPixel(I, x, y);
        const [bx, by] = fromPixel(I, px, py);
        expect(bx).toBeCloseTo(x, 9);
        expect(by).toBeCloseTo(y, 9);
      }
    });

  it('two-view geometry recovers the relative pose and triangulates', () => {
    const sc = makeScene({ frames: 20, noise: 0 });
    const a = 0,
      b = 19;
    const ua: UV[] = [],
      ub: UV[] = [],
      Xs: Float64Array[] = [];
    for (const X of sc.points) {
      const p = (P: Scene['poses'][0]): UV => {
        const c = mulVec3(P.R, X);
        return [(c[0] + P.t[0]) / (c[2] + P.t[2]), (c[1] + P.t[1]) / (c[2] + P.t[2])];
      };
      ua.push(p(sc.poses[a]));
      ub.push(p(sc.poses[b]));
      Xs.push(X);
    }
    // move to frame a's camera space
    const Pa = sc.poses[a],
      Pb = sc.poses[b];
    const Rrel = mul3(Pb.R, transpose3(Pa.R));
    const est = essentialRansac(ua, ub, 1e-3)!;
    expect(est.inliers.every(Boolean)).toBe(true);
    const { pose } = poseFromEssential(est.E, ua, ub);
    const dR = logSO3(mul3(pose.R, transpose3(Rrel)));
    expect(Math.hypot(...dR)).toBeLessThan(1e-6);
    // translation direction
    const tRel = Float64Array.from(mulVec3(Rrel, Pa.t)).map((v, i) => Pb.t[i] - v);
    const ln = Math.hypot(...tRel);
    for (let k = 0; k < 3; k++) expect(pose.t[k]).toBeCloseTo(tRel[k] / ln, 6);
    // triangulated depth ratios match
    const X0 = triangulate([identityPose(), pose], [ua[0], ub[0]])!;
    const truth = mulVec3(Pa.R, Xs[0]).map((v, i) => v + Pa.t[i]);
    expect(X0[0] / X0[2]).toBeCloseTo(truth[0] / truth[2], 6);
    // DLT resection of frame b from the triangulated points
    const pts = ua.map((u, i) => triangulate([identityPose(), pose], [u, ub[i]])!);
    const P = dltPose(pts, ub)!;
    expect(Math.hypot(...logSO3(mul3(P.R, transpose3(pose.R))))).toBeLessThan(1e-6);
  });
});

describe('camera solver: synthetic shots', () => {
  it('recovers a moving camera up to scale with sub-pixel error', () => {
    const sc = makeScene({ frames: 50, points: 120, noise: 0.3, span: 30 });
    const res = solveCamera(sc.tracks, settings(sc.I));
    expect(res.message).toBe('');
    expect(res.ok).toBe(true);
    expect(res.cameras.length).toBe(50);
    expect(res.error).toBeLessThan(0.6);
    expect(res.bundles.length).toBeGreaterThan(100);
    const est = res.cameras.map((c) => center(c.R, c.t));
    const truth = res.cameras.map((c) => center(sc.poses[c.frame - 1].R, sc.poses[c.frame - 1].t));
    expect(alignedResidual(est, truth)).toBeLessThan(0.01);
    for (const b of res.bundles) expect(b.error).toBeLessThan(1.5);
  }, 30000);

  it('uses manual keyframes', () => {
    const sc = makeScene({ frames: 40, points: 80, seed: 11 });
    const res = solveCamera(sc.tracks, settings(sc.I, { use_keyframe_selection: false, keyframe_a: 5, keyframe_b: 25 }));
    expect(res.ok).toBe(true);
    expect(res.keyframe_a).toBe(5);
    expect(res.keyframe_b).toBe(25);
    expect(res.error).toBeLessThan(0.6);
    // keyframe A is the reconstruction origin
    const ca = res.cameras.find((c) => c.frame === 5)!;
    const M = cameraWorldMatrix(ca.R, ca.t);
    for (let i = 0; i < 16; i++) expect(M[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 9);
  }, 30000);

  it('refines the focal length and radial distortion', () => {
    const truthI = intrinsics({ focal: 1100, k: [-0.08, 0.02, 0, 0] });
    const sc = makeScene({ frames: 40, points: 140, noise: 0.2, I: truthI, seed: 5 });
    const guess = intrinsics({ focal: 1000, k: [0, 0, 0, 0] });
    const res = solveCamera(sc.tracks, settings(guess, { refine: { focal_length: true, principal_point: false, radial_distortion: true, tangential_distortion: false } }));
    expect(res.ok).toBe(true);
    expect(res.error).toBeLessThan(0.5);
    expect(Math.abs(res.intrinsics.focal - 1100)).toBeLessThan(20);
    expect(res.intrinsics.k[0]).toBeCloseTo(-0.08, 1);
  }, 30000);

  it('survives gross outliers on some tracks', () => {
    const sc = makeScene({ frames: 40, points: 120, outliers: 10, seed: 9 });
    const res = solveCamera(sc.tracks, settings(sc.I));
    expect(res.ok).toBe(true);
    const est = res.cameras.map((c) => center(c.R, c.t));
    const truth = res.cameras.map((c) => center(sc.poses[c.frame - 1].R, sc.poses[c.frame - 1].t));
    expect(alignedResidual(est, truth)).toBeLessThan(0.02);
    // the corrupted tracks stand out by their error
    const bad = res.bundles.filter((b) => b.track < 10).map((b) => b.error);
    const good = res.bundles.filter((b) => b.track >= 10).map((b) => b.error);
    expect(Math.min(...bad)).toBeGreaterThan(Math.max(...good));
  }, 30000);

  it('solves a tripod (rotation only) shot', () => {
    const sc = makeScene({ frames: 40, points: 100, tripod: true, seed: 2 });
    const res = solveCamera(sc.tracks, settings(sc.I, { tripod: true }));
    expect(res.ok).toBe(true);
    expect(res.error).toBeLessThan(0.6);
    expect(res.cameras.length).toBe(40);
    // relative rotations match the truth
    const a = res.cameras[0],
      b = res.cameras[res.cameras.length - 1];
    const est = mul3(Float64Array.from(b.R), transpose3(Float64Array.from(a.R)));
    const tru = mul3(sc.poses[b.frame - 1].R, transpose3(sc.poses[a.frame - 1].R));
    expect(Math.hypot(...logSO3(mul3(est, transpose3(tru))))).toBeLessThan(2e-3);
    for (const c of res.cameras) expect(Math.hypot(...c.t)).toBe(0);
  }, 30000);

  it('solves a nearly planar scene', () => {
    const sc = makeScene({ frames: 40, points: 100, planar: true, seed: 4 });
    const res = solveCamera(sc.tracks, settings(sc.I));
    expect(res.ok).toBe(true);
    expect(res.error).toBeLessThan(0.6);
    const est = res.cameras.map((c) => center(c.R, c.t));
    const truth = res.cameras.map((c) => center(sc.poses[c.frame - 1].R, sc.poses[c.frame - 1].t));
    expect(alignedResidual(est, truth)).toBeLessThan(0.02);
  }, 30000);

  it('handles a long shot with short tracks in reasonable time', () => {
    const sc = makeScene({ frames: 240, points: 480, span: 40, seed: 21 });
    const t0 = performance.now();
    const res = solveCamera(sc.tracks, settings(sc.I));
    const ms = performance.now() - t0;
    expect(res.ok).toBe(true);
    expect(res.cameras.length).toBeGreaterThan(235);
    expect(res.error).toBeLessThan(0.6);
    const est = res.cameras.map((c) => center(c.R, c.t));
    const truth = res.cameras.map((c) => center(sc.poses[c.frame - 1].R, sc.poses[c.frame - 1].t));
    expect(alignedResidual(est, truth)).toBeLessThan(0.03);
    expect(ms).toBeLessThan(60000);
  }, 120000);

  it('reports a clear failure without enough tracks', () => {
    const sc = makeScene({ frames: 10, points: 5 });
    const res = solveCamera(sc.tracks, settings(sc.I));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/8/);
  }, 30000);

  it('can be cancelled', () => {
    const sc = makeScene({ frames: 30, points: 60 });
    let calls = 0;
    const res = solveCamera(sc.tracks, settings(sc.I), { shouldStop: () => ++calls > 3 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/cancel/i);
  }, 30000);
});
