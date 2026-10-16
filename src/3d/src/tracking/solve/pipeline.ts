// Camera solver pipeline: reconstructs the camera motion and the 3D positions of the tracks
// ("bundles") from 2D marker positions.
//
//  1. keyframes: the two frames the reconstruction starts from (given, or chosen automatically by
//     scoring candidate pairs on their triangulated points and parallax)
//  2. two-view initialization: essential matrix (normalized eight-point in RANSAC), factorized
//     into the relative pose; common tracks are triangulated
//  3. incremental reconstruction: the frame seeing the most reconstructed tracks is resected
//     next (robust pose from 3D↔2D), then newly visible tracks are triangulated; the whole
//     reconstruction is bundle adjusted regularly
//  4. final bundle adjustment with the requested intrinsics refinement, then reprojection errors
// Tripod shots skip triangulation: frames are related by rotations only (Wahba problem) and the
// tracks become directions.
import { bundleAdjust, reprojection, type BACamera } from './bundle';
import { cameraCenter, clonePose, decomposeHomography, essentialRansac, homographyRansac, identityPose, parallaxAngle, poseFromEssential, projectUV, refinePose, resection, toCamera, triangulate, bearing, type Pose, type UV } from './geometry';
import { cloneIntrinsics, fromPixel, intrinsicParamNames, type Intrinsics, type RefineFlags } from './intrinsics';
import { median, mul3, mulVec3, transpose3, wahba } from './linalg';

export interface SolveTrack {
  name: string;
  /** influence on the solution (0: reconstructed afterwards from the solved cameras only) */
  weight: number;
  frames: number[];
  /** marker positions in pixels, origin bottom-left */
  x: number[];
  y: number[];
}

export interface SolveSettings {
  intrinsics: Intrinsics;
  refine: RefineFlags;
  tripod: boolean;
  use_keyframe_selection: boolean;
  keyframe_a: number;
  keyframe_b: number;
}

export interface SolvedCamera {
  frame: number;
  /** world → camera rotation (row-major) and translation, computer-vision convention */
  R: number[];
  t: number[];
  /** average reprojection error of the markers on this frame (pixels) */
  error: number;
}

export interface SolvedBundle {
  /** index into the input tracks */
  track: number;
  X: [number, number, number];
  error: number;
}

export interface SolveResult {
  ok: boolean;
  message: string;
  cameras: SolvedCamera[];
  bundles: SolvedBundle[];
  /** average reprojection error over all markers of reconstructed tracks on solved frames */
  error: number;
  intrinsics: Intrinsics;
  keyframe_a: number;
  keyframe_b: number;
}

export interface SolveHooks {
  progress?: (fraction: number, message: string) => void;
  shouldStop?: () => boolean;
}

interface Obs {
  track: number;
  frame: number;
  px: number;
  py: number;
  uv: UV;
  w: number;
}

class Cancelled extends Error {}

/** Distance of the tripod bundles from the camera. */
export const TRIPOD_DEPTH = 10;

export function solveCamera(tracks: SolveTrack[], settings: SolveSettings, hooks: SolveHooks = {}): SolveResult {
  const fail = (message: string): SolveResult => ({ ok: false, message, cameras: [], bundles: [], error: 0, intrinsics: settings.intrinsics, keyframe_a: settings.keyframe_a, keyframe_b: settings.keyframe_b });
  try {
    return new Solver(tracks, settings, hooks).run();
  } catch (e) {
    if (e instanceof Cancelled) return fail('Solve cancelled');
    throw e;
  }
}

class Solver {
  I: Intrinsics;
  obs: Obs[] = [];
  byFrame = new Map<number, Obs[]>();
  byTrack: Obs[][];
  frames: number[];
  poses = new Map<number, Pose>();
  points = new Map<number, Float64Array>();
  outlier = new Set<Obs>();
  /** normalized inlier threshold (≈ 2 px) */
  thr: number;
  keyA = 0;
  keyB = 0;

  constructor(
    public tracks: SolveTrack[],
    public s: SolveSettings,
    public hooks: SolveHooks,
  ) {
    this.I = cloneIntrinsics(s.intrinsics);
    this.byTrack = tracks.map(() => []);
    tracks.forEach((t, ti) => {
      for (let k = 0; k < t.frames.length; k++) {
        const [x, y] = fromPixel(this.I, t.x[k], t.y[k]);
        const o: Obs = { track: ti, frame: t.frames[k], px: t.x[k], py: t.y[k], uv: [x, -y], w: t.weight };
        this.obs.push(o);
        this.byTrack[ti].push(o);
        let l = this.byFrame.get(o.frame);
        if (!l) this.byFrame.set(o.frame, (l = []));
        l.push(o);
      }
    });
    this.frames = [...this.byFrame.keys()].sort((a, b) => a - b);
    this.thr = 2 / this.I.focal;
  }

  progress(f: number, msg: string) {
    this.hooks.progress?.(Math.max(0, Math.min(1, f)), msg);
    if (this.hooks.shouldStop?.()) throw new Cancelled();
  }

  /** observations of solving tracks (weight > 0) */
  solving(o: Obs) {
    return o.w > 0;
  }

  run(): SolveResult {
    const s = this.s;
    if (this.frames.length < 2) return this.result(false, 'At least two frames with tracked markers are needed');
    if (s.tripod) return this.runTripod();
    this.progress(0, 'Selecting keyframes');
    let init: { a: number; b: number; pose: Pose; pts: Map<number, Float64Array> } | null = null;
    if (!s.use_keyframe_selection) {
      init = this.initialize(s.keyframe_a, s.keyframe_b);
      if (!init) return this.result(false, `Keyframes ${s.keyframe_a} and ${s.keyframe_b} do not share enough tracks with parallax (8 or more are needed); choose other keyframes or enable automatic keyframe selection`);
    } else {
      init = this.selectKeyframes();
      if (!init) return this.result(false, 'Could not find two frames with enough common tracks and parallax to start the reconstruction (needs at least 8 shared tracks); track more features or use Tripod for rotation-only shots');
    }
    this.keyA = init.a;
    this.keyB = init.b;
    this.poses.set(init.a, identityPose());
    this.poses.set(init.b, init.pose);
    for (const [t, X] of init.pts) this.points.set(t, X);
    this.globalAdjust(false, 30);
    this.incremental();
    if (this.poses.size < 2) return this.result(false, 'Reconstruction failed');
    this.progress(0.86, 'Refining');
    // final passes: refine intrinsics, re-triangulate everything with the final cameras
    const refining = intrinsicParamNames(this.I, s.refine).length > 0;
    this.globalAdjust(refining, 60);
    this.markOutliers();
    this.triangulateNew(0.25 * (Math.PI / 180), true);
    this.globalAdjust(refining, 40);
    this.reconstructPassive();
    this.normalizeScale();
    this.progress(1, 'Done');
    return this.result(true, '');
  }

  // ---------------------------------------------------------------------------
  // initialization

  common(a: number, b: number) {
    const ma = new Map<number, Obs>();
    for (const o of this.byFrame.get(a) ?? []) if (this.solving(o)) ma.set(o.track, o);
    const out: [Obs, Obs][] = [];
    for (const o of this.byFrame.get(b) ?? []) {
      const p = ma.get(o.track);
      if (p && this.solving(o)) out.push([p, o]);
    }
    return out;
  }

  /** Two-view reconstruction from frames a and b, or null when degenerate. */
  initialize(a: number, b: number, iterations = 500): { a: number; b: number; pose: Pose; pts: Map<number, Float64Array>; score: number } | null {
    const pairs = this.common(a, b);
    if (pairs.length < 8 || a === b) return null;
    const ua = pairs.map((p) => p[0].uv),
      ub = pairs.map((p) => p[1].uv);
    // motion hypotheses: the essential matrix, and for planar / low-parallax views the homography
    const hyps: { pose: Pose; inliers: boolean[] }[] = [];
    const est = essentialRansac(ua, ub, this.thr * 1.5, { iterations, seed: a * 7919 + b });
    if (est) {
      const ia = ua.filter((_, i) => est.inliers[i]),
        ib = ub.filter((_, i) => est.inliers[i]);
      hyps.push({ pose: poseFromEssential(est.E, ia, ib).pose, inliers: est.inliers });
    }
    const hom = homographyRansac(ua, ub, this.thr * 2, { iterations: Math.min(iterations, 300), seed: a * 31 + b * 17 });
    if (hom && hom.inliers.filter(Boolean).length >= 8) for (const pose of decomposeHomography(hom.H)) hyps.push({ pose, inliers: hom.inliers });
    if (!hyps.length) return null;
    // triangulate under every hypothesis; keep those explaining (nearly) as many correspondences as the best
    const P0 = identityPose();
    const c0 = cameraCenter(P0);
    const build = (pose: Pose) => {
      const pts = new Map<number, Float64Array>();
      const angles: number[] = [];
      let support = 0;
      const c1 = cameraCenter(pose);
      pairs.forEach(([oa, ob]) => {
        const X = triangulate([P0, pose], [oa.uv, ob.uv]);
        if (!X || X[2] <= 0 || toCamera(pose, X)[2] <= 0) return;
        const ea = projectUV(P0, X)!,
          eb = projectUV(pose, X);
        if (!eb) return;
        if (Math.hypot(ea[0] - oa.uv[0], ea[1] - oa.uv[1]) > this.thr * 4 || Math.hypot(eb[0] - ob.uv[0], eb[1] - ob.uv[1]) > this.thr * 4) return;
        support++;
        const ang = parallaxAngle([c0, c1], X);
        angles.push(ang);
        if (ang >= 0.2 * (Math.PI / 180)) pts.set(oa.track, X);
      });
      return { pose, pts, angles, support };
    };
    let built = hyps.map((h) => build(h.pose));
    const maxSupport = Math.max(...built.map((x) => x.support));
    built = built.filter((x) => x.support >= maxSupport * 0.85 && x.pts.size >= 8);
    if (!built.length) return null;
    let chosen = built[0];
    if (built.length > 1) {
      // planar scenes are ambiguous in two views: let other frames decide
      const others = this.frames.filter((f) => f !== a && f !== b);
      const mid = Math.round((a + b) / 2);
      const val = [mid, b + Math.round((b - a) / 2), a - Math.round((b - a) / 2)]
        .map((f) => others.reduce((best, g) => (Math.abs(g - f) < Math.abs(best - f) ? g : best), others[0]))
        .filter((f, i, arr) => f !== undefined && arr.indexOf(f) === i);
      let bestErr = Infinity;
      for (const cand of built) {
        let err = 0;
        for (const v of val) {
          const list = (this.byFrame.get(v) ?? []).filter((o) => this.solving(o) && cand.pts.has(o.track));
          if (list.length < 6) continue;
          const X = list.map((o) => cand.pts.get(o.track)!);
          const uv = list.map((o) => o.uv);
          const r = resection(X, uv, [P0, cand.pose], this.thr * 3, v);
          err += r ? median(r.errors) : this.thr * 100;
        }
        if (err < bestErr) {
          bestErr = err;
          chosen = cand;
        }
      }
    }
    const { pose, pts, angles } = chosen;
    const inliers = { length: pairs.length, n: chosen.support };
    if (pts.size < 8) return null;
    const med = median(angles);
    const good = angles.filter((x) => x > 1 * (Math.PI / 180)).length;
    // reward many well-conditioned points and parallax (saturating at ~6°), penalise outliers
    const inlierRatio = inliers.n / inliers.length;
    const score = good * Math.min(med, 6 * (Math.PI / 180)) * inlierRatio * inlierRatio;
    if (med < 0.5 * (Math.PI / 180) || good < 8) return { a, b, pose, pts, score: score * 1e-3 };
    return { a, b, pose, pts, score };
  }

  selectKeyframes() {
    const F = this.frames;
    const n = F.length;
    const cands: [number, number][] = [];
    const seen = new Set<string>();
    const stepA = Math.max(1, Math.round(n / 20));
    for (let i = 0; i < n; i += stepA) {
      for (let gap = 4; i + gap < n + 4; gap = Math.ceil(gap * 1.6)) {
        const j = Math.min(n - 1, i + gap);
        if (j <= i) continue;
        const key = `${F[i]}:${F[j]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.common(F[i], F[j]).length >= 8) cands.push([F[i], F[j]]);
      }
    }
    // the most promising candidates first (more shared tracks), cap the work
    cands.sort((p, q) => this.common(q[0], q[1]).length - this.common(p[0], p[1]).length);
    let best: ReturnType<Solver['initialize']> = null;
    const list = cands.slice(0, 80);
    list.forEach(([a, b], k) => {
      this.progress((k / list.length) * 0.1, 'Selecting keyframes');
      const r = this.initialize(a, b, 150);
      if (r && (!best || r.score > best.score)) best = r;
    });
    if (!best) return null;
    const b0 = best as NonNullable<ReturnType<Solver['initialize']>>;
    // re-run the winner with the full RANSAC budget
    return this.initialize(b0.a, b0.b) ?? b0;
  }

  // ---------------------------------------------------------------------------
  // incremental reconstruction

  incremental() {
    const failed = new Set<number>();
    let sinceBA = 0;
    const total = this.frames.length;
    for (;;) {
      this.progress(0.1 + (this.poses.size / total) * 0.75, `Solving frame ${this.poses.size} of ${total}`);
      // the unsolved frame seeing the most reconstructed tracks (nearest to the solved ones on ties)
      let best = -1,
        bestCount = 0,
        bestDist = Infinity;
      const solvedFrames = [...this.poses.keys()];
      for (const f of this.frames) {
        if (this.poses.has(f) || failed.has(f)) continue;
        let count = 0;
        for (const o of this.byFrame.get(f)!) if (this.points.has(o.track) && this.solving(o)) count++;
        const dist = Math.min(...solvedFrames.map((g) => Math.abs(g - f)));
        if (count > bestCount || (count === bestCount && dist < bestDist)) {
          best = f;
          bestCount = count;
          bestDist = dist;
        }
      }
      if (best < 0 || bestCount < 5) {
        // try to reconstruct more tracks with relaxed parallax before giving up
        if (this.triangulateNew(0.5 * (Math.PI / 180)) > 0) continue;
        break;
      }
      if (!this.resect(best)) {
        failed.add(best);
        continue;
      }
      this.triangulateNew(1.5 * (Math.PI / 180));
      sinceBA++;
      if (sinceBA >= Math.max(4, Math.round(this.poses.size * 0.15))) {
        this.globalAdjust(false, 15);
        this.markOutliers();
        sinceBA = 0;
      }
    }
  }

  resect(f: number): boolean {
    const list = this.byFrame.get(f)!.filter((o) => this.points.has(o.track) && this.solving(o) && !this.outlier.has(o));
    const X = list.map((o) => this.points.get(o.track)!);
    const uv = list.map((o) => o.uv);
    // guesses: the nearest solved frames on both sides
    const solved = [...this.poses.keys()];
    const before = solved.filter((g) => g < f).sort((a, b) => b - a)[0];
    const after = solved.filter((g) => g > f).sort((a, b) => a - b)[0];
    const guesses = [before, after].filter((g) => g !== undefined).map((g) => this.poses.get(g)!);
    const r = resection(X, uv, guesses, this.thr * 3, f);
    if (!r) return false;
    const inl = r.inliers.filter(Boolean).length;
    if (inl < 5 || inl < list.length * 0.4) return false;
    this.poses.set(f, r.pose);
    list.forEach((o, i) => {
      if (!r.inliers[i] && r.errors[i] > this.thr * 6) this.outlier.add(o);
    });
    return true;
  }

  /** Triangulate tracks seen on two or more solved frames. Returns how many were added. */
  triangulateNew(minAngle: number, includeExisting = false, passive = false): number {
    let added = 0;
    this.byTrack.forEach((list, ti) => {
      if (this.points.has(ti) && !includeExisting) return;
      if (!passive && !(this.tracks[ti].weight > 0)) return;
      const vis = list.filter((o) => this.poses.has(o.frame) && !this.outlier.has(o));
      if (vis.length < 2) return;
      const poses = vis.map((o) => this.poses.get(o.frame)!);
      const X = triangulate(poses, vis.map((o) => o.uv));
      if (!X) return;
      let ok = 0;
      for (let k = 0; k < vis.length; k++) {
        const q = projectUV(poses[k], X);
        if (q && Math.hypot(q[0] - vis[k].uv[0], q[1] - vis[k].uv[1]) < this.thr * 4) ok++;
      }
      if (ok < Math.max(2, vis.length * 0.6)) return;
      if (parallaxAngle(poses.map(cameraCenter), X) < minAngle) return;
      if (includeExisting && this.points.has(ti)) {
        // keep the adjusted point unless the new one explains the markers clearly better
        const err = (P: Float64Array) => vis.reduce((sum, o, k) => {
          const q = projectUV(poses[k], P);
          return sum + (q ? Math.min(Math.hypot(q[0] - o.uv[0], q[1] - o.uv[1]), this.thr * 10) : this.thr * 10);
        }, 0);
        if (err(X) >= err(this.points.get(ti)!) * 0.8) return;
      }
      this.points.set(ti, X);
      added++;
    });
    return added;
  }

  /** Bundle adjust every solved frame and reconstructed track. */
  globalAdjust(refineIntrinsics: boolean, iterations: number) {
    const frames = [...this.poses.keys()].sort((a, b) => a - b);
    const camIndex = new Map(frames.map((f, i) => [f, i]));
    const tracks = [...this.points.keys()];
    const ptIndex = new Map(tracks.map((t, i) => [t, i]));
    const sel: Obs[] = [];
    for (const t of tracks) {
      const vis = this.byTrack[t].filter((o) => camIndex.has(o.frame) && !this.outlier.has(o) && this.solving(o));
      if (vis.length >= 2) sel.push(...vis);
    }
    if (!sel.length) return;
    const cams: BACamera[] = frames.map((f) => ({ R: this.poses.get(f)!.R, t: this.poses.get(f)!.t, fixed: f === this.keyA }));
    const pts = new Float64Array(tracks.length * 3);
    tracks.forEach((t, i) => pts.set(this.points.get(t)!, i * 3));
    const n = sel.length;
    const ob = { cam: new Int32Array(n), pt: new Int32Array(n), x: new Float64Array(n), y: new Float64Array(n), w: new Float64Array(n) };
    sel.forEach((o, i) => {
      ob.cam[i] = camIndex.get(o.frame)!;
      ob.pt[i] = ptIndex.get(o.track)!;
      ob.x[i] = o.px;
      ob.y[i] = o.py;
      ob.w[i] = Math.max(1e-3, o.w);
    });
    const refine = refineIntrinsics ? this.s.refine : { focal_length: false, principal_point: false, radial_distortion: false, tangential_distortion: false };
    const res = bundleAdjust(this.I, cams, pts, ob, { refine, huber: 2, maxIterations: iterations, shouldStop: this.hooks.shouldStop });
    if (this.hooks.shouldStop?.()) throw new Cancelled();
    frames.forEach((f, i) => this.poses.set(f, { R: cams[i].R, t: cams[i].t }));
    tracks.forEach((t, i) => this.points.set(t, pts.slice(i * 3, i * 3 + 3)));
    if (refineIntrinsics) {
      this.I = res.intrinsics;
      this.updateNormalized();
    }
  }

  updateNormalized() {
    for (const o of this.obs) {
      const [x, y] = fromPixel(this.I, o.px, o.py);
      o.uv = [x, -y];
    }
    this.thr = 2 / this.I.focal;
  }

  /** Exclude markers far off their reprojection from further adjustments; drop unsupported points. */
  markOutliers() {
    const errs: number[] = [];
    const items: [Obs, number][] = [];
    for (const [t, X] of this.points)
      for (const o of this.byTrack[t]) {
        const P = this.poses.get(o.frame);
        if (!P) continue;
        const r = reprojection(this.I, P.R, P.t, X, o.px, o.py);
        const e = r ? Math.hypot(r[0], r[1]) : Infinity;
        items.push([o, e]);
        if (Number.isFinite(e)) errs.push(e);
      }
    const lim = Math.max(6, median(errs) * 6);
    for (const [o, e] of items) if (e > lim) this.outlier.add(o);
    for (const t of [...this.points.keys()]) {
      const n = this.byTrack[t].filter((o) => this.poses.has(o.frame) && !this.outlier.has(o)).length;
      if (n < 2) this.points.delete(t);
    }
  }

  /** Reconstruct tracks that did not take part in the solve (zero weight) from the solved cameras. */
  reconstructPassive() {
    const before = new Set(this.points.keys());
    this.triangulateNew(0.1 * (Math.PI / 180), false, true);
    for (const t of this.points.keys()) {
      if (before.has(t)) continue;
      // refine the point alone (cameras fixed)
      const vis = this.byTrack[t].filter((o) => this.poses.has(o.frame));
      const X = this.points.get(t)!;
      const cams: BACamera[] = vis.map((o) => ({ ...this.poses.get(o.frame)!, fixed: true }));
      const n = vis.length;
      const ob = { cam: Int32Array.from(vis.map((_, i) => i)), pt: new Int32Array(n), x: Float64Array.from(vis.map((o) => o.px)), y: Float64Array.from(vis.map((o) => o.py)), w: new Float64Array(n).fill(1) };
      bundleAdjust(this.I, cams, X, ob, { huber: 2, maxIterations: 15 });
    }
  }

  /** Scale the reconstruction so the bundles sit at a median depth of a few units from keyframe A. */
  normalizeScale() {
    const PA = this.poses.get(this.keyA);
    if (!PA) return;
    const depths = [...this.points.values()].map((X) => toCamera(PA, X)[2]).filter((d) => d > 0);
    const m = median(depths);
    if (!(m > 0)) return;
    const k = 5 / m;
    for (const X of this.points.values()) for (let i = 0; i < 3; i++) X[i] *= k;
    for (const P of this.poses.values()) for (let i = 0; i < 3; i++) P.t[i] *= k;
  }

  // ---------------------------------------------------------------------------
  // tripod

  runTripod(): SolveResult {
    const s = this.s;
    // reference frame: the given keyframe A, or the frame with the most markers
    let a = s.use_keyframe_selection ? -1 : s.keyframe_a;
    if (!this.byFrame.has(a)) a = this.frames.reduce((b, f) => ((this.byFrame.get(f)!.length > (this.byFrame.get(b)?.length ?? -1)) ? f : b), this.frames[0]);
    this.keyA = a;
    this.keyB = s.keyframe_b;
    const dirs = new Map<number, Float64Array>();
    this.poses.set(a, identityPose());
    for (const o of this.byFrame.get(a)!) if (this.solving(o)) dirs.set(o.track, bearing(o.uv));
    const order = [...this.frames.filter((f) => f > a), ...this.frames.filter((f) => f < a).reverse()];
    let k = 0;
    for (const f of order) {
      this.progress(0.05 + (k++ / order.length) * 0.6, 'Solving rotations');
      // neighbour pose (previous in the sweep) as a fallback
      const list = this.byFrame.get(f)!.filter((o) => this.solving(o) && dirs.has(o.track));
      if (list.length < 3) continue;
      const world = list.map((o) => dirs.get(o.track)!);
      const cam = list.map((o) => bearing(o.uv));
      let R = wahba(world, cam);
      // reject outliers once
      const errs = world.map((d, i) => Math.acos(Math.max(-1, Math.min(1, dotv(mulVec3(R, d), cam[i])))));
      const keep = errs.map((e) => e < Math.max(this.thr * 4, median(errs) * 4));
      if (keep.filter(Boolean).length >= 3 && keep.some((v) => !v))
        R = wahba(
          world.filter((_, i) => keep[i]),
          cam.filter((_, i) => keep[i]),
        );
      this.poses.set(f, { R, t: new Float64Array(3) });
      for (const o of this.byFrame.get(f)!) if (this.solving(o) && !dirs.has(o.track)) dirs.set(o.track, mulVec3(transpose3(R), bearing(o.uv)));
    }
    if (this.poses.size < 2) return this.result(false, 'Not enough tracks shared between frames to solve the rotation');
    for (const [t, d] of dirs) this.points.set(t, Float64Array.of(d[0] * TRIPOD_DEPTH, d[1] * TRIPOD_DEPTH, d[2] * TRIPOD_DEPTH));
    this.progress(0.7, 'Refining');
    this.tripodAdjust(false);
    this.markOutliers();
    this.tripodAdjust(intrinsicParamNames(this.I, s.refine).length > 0);
    // passive tracks: average direction from the solved rotations
    this.byTrack.forEach((list, ti) => {
      if (this.points.has(ti)) return;
      const vis = list.filter((o) => this.poses.has(o.frame));
      if (!vis.length) return;
      const sum = [0, 0, 0];
      for (const o of vis) {
        const d = mulVec3(transpose3(this.poses.get(o.frame)!.R), bearing(o.uv));
        for (let i = 0; i < 3; i++) sum[i] += d[i];
      }
      const l = Math.hypot(sum[0], sum[1], sum[2]) || 1;
      this.points.set(ti, Float64Array.of((sum[0] / l) * TRIPOD_DEPTH, (sum[1] / l) * TRIPOD_DEPTH, (sum[2] / l) * TRIPOD_DEPTH));
    });
    this.progress(1, 'Done');
    return this.result(true, '');
  }

  tripodAdjust(refineIntrinsics: boolean) {
    const frames = [...this.poses.keys()].sort((x, y) => x - y);
    const camIndex = new Map(frames.map((f, i) => [f, i]));
    const tracks = [...this.points.keys()];
    const ptIndex = new Map(tracks.map((t, i) => [t, i]));
    const sel: Obs[] = [];
    for (const t of tracks) sel.push(...this.byTrack[t].filter((o) => camIndex.has(o.frame) && !this.outlier.has(o) && this.solving(o)));
    if (!sel.length) return;
    const cams: BACamera[] = frames.map((f) => ({ R: this.poses.get(f)!.R, t: new Float64Array(3), fixed: f === this.keyA }));
    const pts = new Float64Array(tracks.length * 3);
    tracks.forEach((t, i) => pts.set(this.points.get(t)!, i * 3));
    const n = sel.length;
    const ob = { cam: new Int32Array(n), pt: new Int32Array(n), x: new Float64Array(n), y: new Float64Array(n), w: new Float64Array(n) };
    sel.forEach((o, i) => {
      ob.cam[i] = camIndex.get(o.frame)!;
      ob.pt[i] = ptIndex.get(o.track)!;
      ob.x[i] = o.px;
      ob.y[i] = o.py;
      ob.w[i] = Math.max(1e-3, o.w);
    });
    const refine = refineIntrinsics ? this.s.refine : { focal_length: false, principal_point: false, radial_distortion: false, tangential_distortion: false };
    const res = bundleAdjust(this.I, cams, pts, ob, { refine, tripod: true, huber: 2, maxIterations: 50, shouldStop: this.hooks.shouldStop });
    if (this.hooks.shouldStop?.()) throw new Cancelled();
    frames.forEach((f, i) => this.poses.set(f, { R: cams[i].R, t: new Float64Array(3) }));
    tracks.forEach((t, i) => {
      const X = pts.slice(i * 3, i * 3 + 3);
      const l = Math.hypot(X[0], X[1], X[2]) || 1;
      for (let k = 0; k < 3; k++) X[k] *= TRIPOD_DEPTH / l;
      this.points.set(t, X);
    });
    if (refineIntrinsics) {
      this.I = res.intrinsics;
      this.updateNormalized();
    }
  }

  // ---------------------------------------------------------------------------

  result(ok: boolean, message: string): SolveResult {
    const camErr = new Map<number, { s: number; n: number }>();
    const bundles: SolvedBundle[] = [];
    let total = 0,
      count = 0;
    for (const [t, X] of this.points) {
      let s = 0,
        n = 0;
      for (const o of this.byTrack[t]) {
        const P = this.poses.get(o.frame);
        if (!P) continue;
        const r = reprojection(this.I, P.R, P.t, X, o.px, o.py);
        if (!r) continue;
        const e = Math.hypot(r[0], r[1] / this.I.aspect);
        s += e;
        n++;
        const c = camErr.get(o.frame) ?? { s: 0, n: 0 };
        c.s += e;
        c.n++;
        camErr.set(o.frame, c);
      }
      if (!n) continue;
      bundles.push({ track: t, X: [X[0], X[1], X[2]], error: s / n });
      total += s;
      count += n;
    }
    const cameras: SolvedCamera[] = [...this.poses.keys()]
      .sort((a, b) => a - b)
      .map((f) => {
        const P = this.poses.get(f)!;
        const e = camErr.get(f);
        return { frame: f, R: [...P.R], t: [...P.t], error: e ? e.s / e.n : 0 };
      });
    return { ok: ok && cameras.length >= 2, message: message || (cameras.length < 2 ? 'Reconstruction failed' : ''), cameras: ok ? cameras : [], bundles: ok ? bundles : [], error: count ? total / count : 0, intrinsics: this.I, keyframe_a: this.keyA, keyframe_b: this.keyB };
  }
}

function dotv(a: ArrayLike<number>, b: ArrayLike<number>) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// ---------------------------------------------------------------------------
// conversion to the scene (z-up, cameras looking down −Z)

/**
 * Camera world matrix (column-major 4×4, camera looks along its −Z with Y up) for a solved
 * computer-vision pose. The reconstruction space is keyframe A's camera space: keyframe A sits at
 * the origin looking down −Z.
 */
export function cameraWorldMatrix(R: ArrayLike<number>, t: ArrayLike<number>): number[] {
  // GL world-to-camera = D·[R|t]·D with D = diag(1, −1, −1); world matrix is its inverse
  const D = [1, -1, -1];
  const Rg = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Rg[i * 3 + j] = D[i] * R[i * 3 + j] * D[j];
  const tg = [D[0] * t[0], D[1] * t[1], D[2] * t[2]];
  // inverse: [Rgᵀ | −Rgᵀ tg]
  const Rt = transpose3(Rg);
  const p = mulVec3(Rt, tg);
  return [Rt[0], Rt[3], Rt[6], 0, Rt[1], Rt[4], Rt[7], 0, Rt[2], Rt[5], Rt[8], 0, -p[0], -p[1], -p[2], 1];
}

/** Bundle position in reconstruction space. */
export function bundleWorld(X: ArrayLike<number>): [number, number, number] {
  return [X[0], -X[1], -X[2]];
}

export { mul3, clonePose, refinePose };
