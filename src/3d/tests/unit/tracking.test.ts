import { describe, expect, it } from 'vitest';
import { buildPyramid, cropRegion, regionRect, trackMarker, pyramidLevels, ncc, type P2, type TrackParams } from '../../src/tracking/tracker';
import { newMovieClip, newTrack, newMarker, insertMarker, type MotionModel, type MovieClipData } from '../../src/tracking/types';
import { detectFeatures } from '../../src/tracking/detect';
import { measureMotion, stabilizationMatrix, apply as applyAffine, autoscaleFactor, stabilizationTable } from '../../src/tracking/stabilize';
import { followTrackMatrix, type FollowCamera, type FollowRender, type FrameMethod } from '../../src/tracking/follow';
import { Matrix4, Euler, Vector3, Quaternion } from 'three';
import { demux, estimateFps, presentationOrder } from '../../src/tracking/demux';
import { muxWebM } from '../../src/render/final/webm';

// ---------------------------------------------------------------------------
// synthetic textures: a sum of Gaussian blobs evaluated analytically, so warped frames are exact

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function texture(seed: number, W: number, H: number, count = 400) {
  const r = rng(seed);
  const blobs = Array.from({ length: count }, () => ({ x: r() * (W + 80) - 40, y: r() * (H + 80) - 40, s: 1.8 + r() * 4.5, a: (r() - 0.5) * 1.4 }));
  return (x: number, y: number) => {
    let v = 0.5;
    for (const b of blobs) {
      const dx = x - b.x,
        dy = y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 100 * b.s * b.s) v += b.a * Math.exp(-d2 / (2 * b.s * b.s));
    }
    return v;
  };
}

/** Render a frame where frame point p shows texture point inv(p). */
function render(W: number, H: number, f: (x: number, y: number) => number, inv: (x: number, y: number) => P2) {
  const data = new Float32Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const [u, v] = inv(i + 0.5, j + 0.5);
      data[j * W + i] = f(u, v);
    }
  return { w: W, h: H, data };
}

/** Forward similarity/affine about a pivot: p' = c + M (p - c) + t. */
function warp(M: [number, number, number, number], t: P2, c: P2) {
  const det = M[0] * M[3] - M[1] * M[2];
  const inv: [number, number, number, number] = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
  return {
    fwd: (x: number, y: number): P2 => [c[0] + M[0] * (x - c[0]) + M[1] * (y - c[1]) + t[0], c[1] + M[2] * (x - c[0]) + M[3] * (y - c[1]) + t[1]],
    inv: (x: number, y: number): P2 => {
      const dx = x - c[0] - t[0],
        dy = y - c[1] - t[1];
      return [c[0] + inv[0] * dx + inv[1] * dy, c[1] + inv[2] * dx + inv[3] * dy];
    },
  };
}

function square(c: P2, half: number): P2[] {
  return [
    [c[0] - half, c[1] - half],
    [c[0] + half, c[1] - half],
    [c[0] + half, c[1] + half],
    [c[0] - half, c[1] + half],
  ];
}

function runTrack(ref: ReturnType<typeof render>, cur: ReturnType<typeof render>, center: P2, model: MotionModel, opts: Partial<TrackParams> = {}) {
  const half = 10.5,
    sHalf = 35.5;
  const W = ref.w,
    H = ref.h;
  const levels = pyramidLevels(sHalf, half);
  const corners = square(center, half);
  const rr = regionRect(center[0] - half * 1.5, center[1] - half * 1.5, center[0] + half * 1.5, center[1] + half * 1.5, W, H, levels);
  const cr = regionRect(center[0] - sHalf, center[1] - sHalf, center[0] + sHalf, center[1] + sHalf, W, H, levels);
  const refPyr = buildPyramid(cropRegion(ref, ...rr), levels);
  const curPyr = buildPyramid(cropRegion(cur, ...cr), levels);
  return trackMarker(refPyr, curPyr, {
    model,
    refCenter: center,
    refCorners: corners,
    prevCenter: center,
    prevCorners: corners,
    searchMin: [center[0] - sHalf, center[1] - sHalf],
    searchMax: [center[0] + sHalf, center[1] + sHalf],
    frameSize: [W, H],
    useBrute: true,
    useNormalization: false,
    correlationMin: 0.75,
    margin: 0,
    ...opts,
  });
}

describe('KLT / NCC tracker', () => {
  const W = 192,
    H = 160;
  const f = texture(7, W, H);
  const ref = render(W, H, f, (x, y) => [x, y]);
  const c: P2 = [96.3, 80.6];

  it('recovers sub-pixel translation (Loc)', () => {
    for (const t of [
      [3.37, -2.71],
      [-11.2, 6.45],
      [0.25, 0.4],
      [17.8, -14.1],
    ] as P2[]) {
      const w = warp([1, 0, 0, 1], t, c);
      const cur = render(W, H, f, w.inv);
      const r = runTrack(ref, cur, c, 'Loc');
      expect(r.ok).toBe(true);
      const err = Math.hypot(r.center[0] - c[0] - t[0], r.center[1] - c[1] - t[1]);
      expect(err).toBeLessThan(0.05);
      expect(r.correlation).toBeGreaterThan(0.99);
    }
  });

  it('tracks translation without the brute-force prepass (pyramid only)', () => {
    const t: P2 = [6.3, -4.2];
    const cur = render(W, H, f, warp([1, 0, 0, 1], t, c).inv);
    const r = runTrack(ref, cur, c, 'Loc', { useBrute: false });
    expect(r.ok).toBe(true);
    expect(Math.hypot(r.center[0] - c[0] - t[0], r.center[1] - c[1] - t[1])).toBeLessThan(0.05);
  });

  it('recovers rotation + translation (LocRot) and rotates the pattern corners', () => {
    const a = (9 * Math.PI) / 180;
    const M: [number, number, number, number] = [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)];
    const t: P2 = [4.6, 2.2];
    const w = warp(M, t, c);
    const cur = render(W, H, f, w.inv);
    const r = runTrack(ref, cur, c, 'LocRot');
    expect(r.ok).toBe(true);
    expect(Math.hypot(r.center[0] - c[0] - t[0], r.center[1] - c[1] - t[1])).toBeLessThan(0.1);
    const exp = square(c, 10.5).map((p) => w.fwd(p[0], p[1]));
    for (let i = 0; i < 4; i++) expect(Math.hypot(r.corners[i][0] - exp[i][0], r.corners[i][1] - exp[i][1])).toBeLessThan(0.25);
    const ang = Math.atan2(r.corners[1][1] - r.corners[0][1], r.corners[1][0] - r.corners[0][0]);
    expect(Math.abs(ang - a)).toBeLessThan((0.5 * Math.PI) / 180);
  });

  it('recovers scale (LocScale) and similarity (LocRotScale) and affine shear (Affine)', () => {
    const cases: [MotionModel, [number, number, number, number]][] = [
      ['LocScale', [1.12, 0, 0, 1.12]],
      ['LocRotScale', [0.95 * Math.cos(0.12), -0.95 * Math.sin(0.12), 0.95 * Math.sin(0.12), 0.95 * Math.cos(0.12)]],
      ['Affine', [1.05, 0.12, -0.04, 0.93]],
    ];
    for (const [model, M] of cases) {
      const t: P2 = [-2.4, 3.1];
      const w = warp(M, t, c);
      const cur = render(W, H, f, w.inv);
      const r = runTrack(ref, cur, c, model);
      expect(r.ok, model).toBe(true);
      expect(Math.hypot(r.center[0] - c[0] - t[0], r.center[1] - c[1] - t[1]), model).toBeLessThan(0.1);
      const exp = square(c, 10.5).map((p) => w.fwd(p[0], p[1]));
      for (let i = 0; i < 4; i++) expect(Math.hypot(r.corners[i][0] - exp[i][0], r.corners[i][1] - exp[i][1]), model).toBeLessThan(0.3);
    }
  });

  it('a translation-only model still locates the center of a slightly rotated pattern', () => {
    const a = (4 * Math.PI) / 180;
    const w = warp([Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)], [2, 1], c);
    const r = runTrack(ref, render(W, H, f, w.inv), c, 'Loc');
    expect(r.ok).toBe(true);
    expect(Math.hypot(r.center[0] - c[0] - 2, r.center[1] - c[1] - 1)).toBeLessThan(0.6);
  });

  it('normalization handles brightness/contrast changes', () => {
    const t: P2 = [2.2, -1.7];
    const cur0 = render(W, H, f, warp([1, 0, 0, 1], t, c).inv);
    const cur = { ...cur0, data: cur0.data.map((v) => v * 0.6 + 0.25) };
    const r = runTrack(ref, cur, c, 'Loc', { useNormalization: true });
    expect(r.ok).toBe(true);
    expect(Math.hypot(r.center[0] - c[0] - t[0], r.center[1] - c[1] - t[1])).toBeLessThan(0.06);
  });

  it('reports a lost track when the correlation drops below the minimum', () => {
    const other = render(W, H, texture(99, W, H), (x, y) => [x, y]);
    const r = runTrack(ref, other, c, 'Loc');
    expect(r.ok).toBe(false);
    expect(r.correlation).toBeLessThan(0.75);
  });

  it('fails when the pattern would leave the search area or enter the margin', () => {
    const cur = render(W, H, f, warp([1, 0, 0, 1], [40, 0], c).inv);
    expect(runTrack(ref, cur, c, 'Loc').ok).toBe(false);
    const near = render(W, H, f, warp([1, 0, 0, 1], [3, 0], c).inv);
    expect(runTrack(ref, near, c, 'Loc', { margin: 90 }).ok).toBe(false);
  });

  it('ncc is 1 for affine-related signals', () => {
    expect(ncc([1, 2, 3, 4], [3, 5, 7, 9])).toBeCloseTo(1, 10);
    expect(ncc([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
  });
});

// ---------------------------------------------------------------------------
// feature detection

function checkerboard(W: number, H: number, cell: number, x0: number, y0: number, contrast = 0.8) {
  const data = new Float32Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      // 4×4 supersampling for anti-aliased edges
      let s = 0;
      for (let a = 0; a < 4; a++)
        for (let b = 0; b < 4; b++) {
          const x = i + (a + 0.5) / 4 - x0,
            y = j + (b + 0.5) / 4 - y0;
          s += (Math.floor(x / cell) + Math.floor(y / cell)) & 1 ? 1 : 0;
        }
      data[j * W + i] = 0.5 + (s / 16 - 0.5) * contrast;
    }
  return { w: W, h: H, data };
}

describe('feature detection', () => {
  it('finds every interior checkerboard corner and nothing on straight edges', () => {
    const W = 240,
      H = 200,
      cell = 24,
      x0 = 10.5,
      y0 = 7.25;
    const img = checkerboard(W, H, cell, x0, y0);
    const margin = 16;
    const expected: [number, number][] = [];
    for (let gx = -1; gx < 12; gx++)
      for (let gy = -1; gy < 10; gy++) {
        const x = x0 + gx * cell,
          y = y0 + gy * cell;
        if (x >= margin + 2 && x <= W - margin - 2 && y >= margin + 2 && y <= H - margin - 2) expected.push([x, y]);
      }
    const feats = detectFeatures(img, { margin, threshold: 0.5, min_distance: 10 });
    expect(feats.length).toBe(expected.length);
    for (const [x, y] of expected) {
      const d = Math.min(...feats.map((f) => Math.hypot(f.x - x, f.y - y)));
      expect(d).toBeLessThan(1.6);
    }
  });

  it('respects the minimum distance, margin, threshold and blank images', () => {
    const img = checkerboard(240, 200, 24, 10.5, 7.25);
    const all = detectFeatures(img, { margin: 16, threshold: 0.5, min_distance: 10 });
    const sparse = detectFeatures(img, { margin: 16, threshold: 0.5, min_distance: 60 });
    expect(sparse.length).toBeLessThan(all.length);
    expect(sparse.length).toBeGreaterThan(3);
    for (const a of sparse) for (const b of sparse) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(60);
    const wide = detectFeatures(img, { margin: 60, threshold: 0.5, min_distance: 10 });
    expect(wide.length).toBeGreaterThan(0);
    for (const f of wide) {
      expect(f.x).toBeGreaterThanOrEqual(60);
      expect(f.y).toBeGreaterThanOrEqual(60);
      expect(f.x).toBeLessThanOrEqual(240 - 60);
      expect(f.y).toBeLessThanOrEqual(200 - 60);
    }
    // low contrast corners disappear with a high threshold and come back with a low one
    const faint = checkerboard(240, 200, 24, 10.5, 7.25, 0.05);
    expect(detectFeatures(faint, { margin: 16, threshold: 0.5, min_distance: 10 }).length).toBe(0);
    expect(detectFeatures(faint, { margin: 16, threshold: 0.001, min_distance: 10 }).length).toBe(all.length);
    const blank = { w: 64, h: 64, data: new Float32Array(64 * 64).fill(0.5) };
    expect(detectFeatures(blank, { margin: 4, threshold: 0.01, min_distance: 5 }).length).toBe(0);
  });

  it('detected features are trackable (detection → tracking round trip)', () => {
    const W = 192,
      H = 160;
    const f = texture(3, W, H);
    const ref = render(W, H, f, (x, y) => [x, y]);
    const feats = detectFeatures(ref, { margin: 40, threshold: 0.5, min_distance: 30 });
    expect(feats.length).toBeGreaterThan(3);
    const t: P2 = [1.6, -2.3];
    const cur = render(W, H, f, (x, y) => [x - t[0], y - t[1]]);
    let good = 0;
    for (const p of feats) {
      const r = runTrack(ref, cur, [p.x, p.y], 'Loc');
      if (r.ok && Math.hypot(r.center[0] - p.x - t[0], r.center[1] - p.y - t[1]) < 0.1) good++;
    }
    expect(good / feats.length).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// 2D stabilization

function clipWithTracks(W: number, H: number, frames: number, motion: (f: number) => { t: P2; a: number; s: number }, points: P2[], rotIdx: number[]): MovieClipData {
  const clip = newMovieClip('MC', 'test', { size: [W, H], frame_duration: frames });
  const pivot: P2 = [W / 2, H / 2];
  points.forEach((p, i) => {
    const tr = newTrack(clip.tracking, 'Track');
    clip.tracking.tracks.push(tr);
    if (rotIdx.includes(i)) tr.use_2d_stabilization_rotation = true;
    else tr.use_2d_stabilization = true;
    for (let f = 1; f <= frames; f++) {
      const { t, a, s } = motion(f);
      const dx = p[0] - pivot[0],
        dy = p[1] - pivot[1];
      const x = pivot[0] + s * (Math.cos(a) * dx - Math.sin(a) * dy) + t[0];
      const y = pivot[1] + s * (Math.sin(a) * dx + Math.cos(a) * dy) + t[1];
      insertMarker(tr, newMarker(f, [x / W, y / H], [W, H], 21, 71));
    }
  });
  return clip;
}

describe('2D stabilization', () => {
  const W = 200,
    H = 100;
  const motion = (f: number) => ({ t: [Math.sin(f) * 6, (f - 1) * 0.5] as P2, a: 0.02 * (f - 1), s: 1 + 0.01 * (f - 1) });
  // location tracks symmetric around the frame center so their average is the rotation pivot
  const pts: P2[] = [
    [60, 30],
    [140, 70],
    [60, 70],
    [140, 30],
    [170, 50],
  ];

  it('measures translation, rotation and scale relative to the anchor frame', () => {
    const clip = clipWithTracks(W, H, 10, motion, pts, [4]);
    Object.assign(clip.tracking.stabilization, { use_2d_stabilization: true, use_stabilize_rotation: true, use_stabilize_scale: true, anchor_frame: 1 });
    for (const f of [1, 4, 9]) {
      const m = measureMotion(clip, f);
      const e = motion(f),
        e1 = motion(1);
      expect(m.translation[0]).toBeCloseTo(e.t[0] - e1.t[0], 6);
      expect(m.translation[1]).toBeCloseTo(e.t[1] - e1.t[1], 6);
      expect(m.angle).toBeCloseTo(e.a, 6);
      expect(m.scale).toBeCloseTo(e.s, 6);
    }
  });

  it('the compensating transform maps every tracked point back to its anchor position', () => {
    const clip = clipWithTracks(W, H, 10, motion, pts, [4]);
    Object.assign(clip.tracking.stabilization, { use_2d_stabilization: true, use_stabilize_rotation: true, use_stabilize_scale: true, anchor_frame: 3 });
    for (const f of [1, 5, 10]) {
      const T = stabilizationMatrix(clip, f);
      for (const tr of clip.tracking.tracks) {
        const at = (fr: number) => tr.markers.find((m) => m.frame === fr)!.co;
        const p = applyAffine(T, [at(f)[0] * W, at(f)[1] * H]);
        expect(p[0]).toBeCloseTo(at(3)[0] * W, 5);
        expect(p[1]).toBeCloseTo(at(3)[1] * H, 5);
      }
    }
  });

  it('influence and expected position for translation-only stabilization', () => {
    const clip = clipWithTracks(W, H, 6, (f) => ({ t: [f * 2, 0], a: 0, s: 1 }), pts.slice(0, 4), []);
    const st = clip.tracking.stabilization;
    st.use_2d_stabilization = true;
    st.influence_location = 0.5;
    expect(stabilizationMatrix(clip, 6)[4]).toBeCloseTo(-5, 9); // half of the 10 px drift
    st.influence_location = 1;
    st.target_position = [4, 0];
    expect(stabilizationMatrix(clip, 6)[4]).toBeCloseTo(-6, 9);
  });

  it('chains tracks that start after the anchor frame through shared frames', () => {
    const clip = clipWithTracks(W, H, 8, (f) => ({ t: [f * 3, -f], a: 0, s: 1 }), pts.slice(0, 3), []);
    // the third track only exists from frame 4 on
    clip.tracking.tracks[2].markers = clip.tracking.tracks[2].markers.filter((m) => m.frame >= 4);
    clip.tracking.stabilization.use_2d_stabilization = true;
    const m = measureMotion(clip, 8);
    expect(m.translation[0]).toBeCloseTo(21, 6);
    expect(m.translation[1]).toBeCloseTo(-7, 6);
  });

  it('autoscale zooms just enough to hide the borders (clamped by the maximum)', () => {
    const clip = clipWithTracks(W, H, 6, (f) => ({ t: [(f - 1) * 2, 0], a: 0, s: 1 }), pts.slice(0, 4), []);
    const st = clip.tracking.stabilization;
    st.use_2d_stabilization = true;
    st.use_autoscale = true;
    // the largest shift is 10 px on a 200 px wide frame: the 90 px left on one side must cover 100 px
    expect(autoscaleFactor(clip)).toBeCloseTo(100 / 90, 6);
    st.scale_max = 1.05;
    expect(autoscaleFactor(clip)).toBeCloseTo(1.05, 9);
    const rows = stabilizationTable(clip);
    expect(rows.length).toBe(6);
    expect(rows[0].scale).toBeCloseTo(1.05, 9);
  });
});

// ---------------------------------------------------------------------------
// Follow Track constraint (expected numbers)

describe('Follow Track constraint mapping', () => {
  const camWorld = new Matrix4().set(0.6859206557273865, -0.32401347160339355, 0.6515582203865051, 7.358891487121582, 0.7276763319969177, 0.305420845746994, -0.6141703724861145, -6.925790786743164, 0, 0.8953956365585327, 0.44527140259742737, 4.958309173583984, 0, 0, 0, 1);
  const mkClip = () => {
    const clip = newMovieClip('MC', 'clip', { size: [320, 180], frame_duration: 5 });
    const tr = newTrack(clip.tracking, 'T');
    clip.tracking.tracks.push(tr);
    insertMarker(tr, newMarker(1, [0.25, 0.75], [320, 180], 21, 71));
    insertMarker(tr, newMarker(5, [0.6, 0.4], [320, 180], 21, 71));
    return clip;
  };
  const baseCam = (): FollowCamera => ({ type: 'PERSP', lens: 50, sensor_width: 36, ortho_scale: 7.314285755157471, shift_x: 0, shift_y: 0 });
  const baseRender = (): FollowRender => ({ resolution_x: 1920, resolution_y: 1080, pixel_aspect_x: 1, pixel_aspect_y: 1 });
  type Opts = { ob?: [number, number, number]; cam?: Partial<FollowCamera>; render?: Partial<FollowRender>; method?: FrameMethod; frame?: number; undistort?: boolean; clip?: MovieClipData; owner?: Matrix4; depth?: boolean };
  const solve = (o: Opts = {}) => {
    const owner = o.owner ?? new Matrix4().makeTranslation(...(o.ob ?? [1, 2, 0.5]));
    // 20 × 20 plane at z = -1 (depth object)
    const plane = { positions: new Float32Array([-10, -10, 0, 10, -10, 0, 10, 10, 0, -10, 10, 0]), offsets: new Uint32Array([0, 4]), indices: new Uint32Array([0, 1, 2, 3]), world: new Matrix4().makeTranslation(0, 0, -1) };
    return followTrackMatrix(owner, { clip: o.clip ?? mkClip(), trackName: 'T', sceneFrame: o.frame ?? 1, cameraWorld: camWorld, camera: { ...baseCam(), ...o.cam }, render: { ...baseRender(), ...o.render }, method: o.method ?? 'STRETCH', undistort: !!o.undistort, depthMesh: o.depth ? plane : null })!;
  };
  const run = (o: Opts = {}) => {
    const e = solve(o).elements;
    return [e[12], e[13], e[14]];
  };
  const close = (a: number[], b: number[], eps = 2e-4) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(eps));

  it('projects the marker at the owner depth through the scene camera', () => {
    close(run(), [-2.02026, -0.95679, 0.84115]);
    close(run({ ob: [0, 0, 0] }), [-1.73417, -1.13886, 0.96673]);
    close(run({ cam: { lens: 35 } }), [-2.79785, -1.45466, 1.29225]);
    close(run({ cam: { shift_x: 0.1 } }), [-1.44687, -0.34849, 0.84115]);
    close(run({ cam: { shift_y: 0.1 } }), [-2.17262, -0.81318, 1.26218]);
    close(run({ cam: { type: 'ORTHO' } }), [-1.79342, -0.81155, 0.70955]);
    close(run({ render: { pixel_aspect_x: 2 } }), [-1.82982, -1.13631, 0.31486]);
  });

  it('frame methods for differing clip / render aspect ratios', () => {
    close(run({ render: { resolution_x: 1000, resolution_y: 1000 } }), [-2.31651, -0.67754, 1.65982]);
    close(run({ render: { resolution_x: 1000, resolution_y: 2000 } }), [-1.59978, 0.08283, 1.65982]);
    close(run({ method: 'FIT', render: { resolution_x: 1000, resolution_y: 1000 } }), [-2.02026, -0.95679, 0.84115]);
    close(run({ method: 'FIT', render: { resolution_x: 1000, resolution_y: 2000 } }), [-1.11308, -0.37594, 0.31486]);
    close(run({ method: 'CROP', render: { resolution_x: 1000, resolution_y: 1000 } }), [-3.43144, -1.86034, 1.65982]);
    close(run({ method: 'CROP', render: { resolution_x: 1000, resolution_y: 2000 } }), [-3.43144, -1.86034, 1.65982]);
  });

  it('uses the marker in effect at the frame (held between keys) through the clip start frame and track offset', () => {
    close(run({ frame: 5 }), [0.51985, 0.66959, -0.63246]);
    close(run({ frame: 3 }), [-2.02026, -0.95679, 0.84115]);
    close(run({ frame: 7 }), [0.51985, 0.66959, -0.63246]);
    const clip = mkClip();
    clip.frame_start = 3;
    close(run({ clip, frame: 5 }), [-2.02026, -0.95679, 0.84115]);
    close(run({ clip, frame: 7 }), [0.51985, 0.66959, -0.63246]);
    const off = mkClip();
    off.tracking.tracks[0].offset = [0.1, 0];
    close(run({ clip: off }), [-1.44687, -0.34849, 0.84115]);
  });

  it('undistorts the marker with the polynomial lens model', () => {
    const clip = mkClip();
    clip.tracking.camera.k1 = 0.2;
    close(run({ clip }), [-2.02026, -0.95679, 0.84115]);
    close(run({ clip, undistort: true }), [-1.96263, -0.91989, 0.80771]);
    Object.assign(clip.tracking.camera, { k2: -0.05, k3: 0.01 });
    close(run({ clip, undistort: true }), [-1.96472, -0.92123, 0.80893]);
    Object.assign(clip.tracking.camera, { k2: 0, k3: 0, principal_point: [0.1, -0.2] });
    close(run({ clip, undistort: true }), [-1.91356, -0.89418, 0.77137]);
    Object.assign(clip.tracking.camera, { principal_point: [0, 0], pixel_aspect: 1.5 });
    close(run({ clip, undistort: true }), [-1.92991, -0.9165, 0.76451]);
  });

  it('places the owner on a depth object', () => {
    close(run({ depth: true }), [-6.21452, 1.71248, -1.0]);
  });

  it('composes the owner rotation/scale with the camera orientation', () => {
    const owner = new Matrix4().compose(new Vector3(1, 2, 0.5), new Quaternion().setFromEuler(new Euler(0.3, 0, 0)), new Vector3(2, 2, 2));
    const e = solve({ owner }).elements;
    close([e[12], e[13], e[14]], [-2.02026, -0.95679, 0.84115]);
    // measured rows of the 3×3 part: [[1.3718, -0.648, 1.3031], [1.3904, 0.0543, -1.4367], [0.4301, 1.8913, 0.4878]]
    close([e[0], e[1], e[2]], [1.3718, 1.3904, 0.4301], 2e-3);
    close([e[4], e[5], e[6]], [-0.648, 0.0543, 1.8913], 2e-3);
    close([e[8], e[9], e[10]], [1.3031, -1.4367, 0.4878], 2e-3);
  });
});

// ---------------------------------------------------------------------------
// container demuxing (for frame-accurate WebCodecs decoding)

describe('demuxers', () => {
  it('reads WebM written by the app muxer (frames, key flags, timestamps, fps)', () => {
    const frames = Array.from({ length: 30 }, (_, i) => ({ data: new Uint8Array([i, i + 1, i + 2, 7]), time: (i * 1000) / 25, key: i % 10 === 0 }));
    const parts = muxWebM(frames, { width: 320, height: 240, codec: 'V_VP9', duration: 1200 });
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) (bytes.set(p, o), (o += p.length));
    const info = demux(bytes)!;
    expect(info.container).toBe('webm');
    expect(info.codec).toBe('vp09.00.10.08');
    expect([info.width, info.height]).toEqual([320, 240]);
    expect(info.samples.length).toBe(30);
    expect(info.fps).toBe(25);
    info.samples.forEach((s, i) => {
      expect(s.key).toBe(i % 10 === 0);
      expect(s.pts).toBe(Math.round(frames[i].time) * 1000);
      expect(Array.from(bytes.subarray(s.offset, s.offset + s.size))).toEqual([i, i + 1, i + 2, 7]);
    });
  });

  it('reads MP4 sample tables (avcC codec string, chunk offsets, B-frame reordering, sync samples)', () => {
    const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    const be16 = (v: number) => [(v >>> 8) & 255, v & 255];
    const box = (type: string, ...payload: number[][]) => {
      const body = payload.flat();
      return [...be32(body.length + 8), ...[...type].map((c) => c.charCodeAt(0)), ...body];
    };
    const full = (type: string, ...payload: number[][]) => box(type, [0, 0, 0, 0], ...payload);
    // 6 samples in decode order I P B B P B with composition offsets
    const sizes = [5, 3, 2, 2, 3, 2];
    const ctts = [1, 3, 0, 0, 2, 0]; // in frame units (timescale 2400, 100 per frame)
    const avcC = [1, 0x64, 0x00, 0x1f, 0xff, 0xe0, 0x00];
    const sampleData = sizes.map((n, i) => Array.from({ length: n }, () => 10 + i));
    const ftyp = box('ftyp', [...'isom'].map((c) => c.charCodeAt(0)), be32(0));
    const build = (mdatOffset: number) => {
      const stsd = full('stsd', be32(1), box('avc1', new Array(6).fill(0), be16(1), new Array(16).fill(0), be16(1920), be16(1080), new Array(50).fill(0), box('avcC', avcC)));
      const stbl = box(
        'stbl',
        stsd,
        full('stts', be32(1), be32(6), be32(100)),
        full('ctts', be32(6), ...ctts.flatMap((c) => [be32(1), be32(c * 100)])),
        full('stss', be32(2), be32(1), be32(5)),
        full('stsz', be32(0), be32(6), ...sizes.map(be32)),
        full('stsc', be32(2), be32(1), be32(4), be32(1), be32(2), be32(2), be32(1)),
        full('stco', be32(2), be32(mdatOffset + 8), be32(mdatOffset + 8 + 12)),
      );
      const mdhd = full('mdhd', be32(0), be32(0), be32(2400), be32(600), be32(0));
      const hdlr = full('hdlr', be32(0), [...'vide'].map((c) => c.charCodeAt(0)), new Array(12).fill(0), [0]);
      return box('moov', box('trak', box('mdia', mdhd, hdlr, box('minf', stbl))));
    };
    const moov0 = build(0);
    const mdatOffset = ftyp.length + moov0.length;
    const moov = build(mdatOffset);
    const mdat = box('mdat', sampleData.flat());
    const bytes = new Uint8Array([...ftyp, ...moov, ...mdat]);
    const info = demux(bytes)!;
    expect(info.container).toBe('mp4');
    expect(info.codec).toBe('avc1.64001f');
    expect(Array.from(info.description!)).toEqual(avcC);
    expect([info.width, info.height]).toEqual([1920, 1080]);
    expect(info.samples.map((s) => s.key)).toEqual([true, false, false, false, true, false]);
    info.samples.forEach((s, i) => expect(Array.from(bytes.subarray(s.offset, s.offset + s.size))).toEqual(sampleData[i]));
    // presentation order of the decode-order samples
    const order = presentationOrder(info);
    expect(order).toEqual([0, 2, 3, 1, 5, 4]);
    expect(info.fps).toBe(24);
  });

  it('estimates frame rates from rounded millisecond timestamps', () => {
    expect(estimateFps(Array.from({ length: 48 }, (_, i) => Math.round((i * 1000) / 24) * 1000))).toBe(24);
    expect(estimateFps(Array.from({ length: 48 }, (_, i) => Math.round((i * 1001) / 30) * 1000))).toBe(29.97);
    expect(estimateFps(Array.from({ length: 10 }, (_, i) => i * 1e6 / 12.5))).toBe(12.5);
  });
});
