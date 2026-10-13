import { describe, it, expect } from 'vitest';
import {
  POSE, POSE_HOLD, BODY_LIMITS, bodyFrame, trackPoses, bodyPlan, legStretch, legSource, bodyOffset, bodyGrid, sampleGrid,
} from '../src/engine/body-geometry.js';

const W = 1000;
const H = 1600;
const NONE = { slim: 0, waist: 0, legs: 0, head: 0, shoulders: 0, arms: 0 };

/** A person standing upright facing the camera, centered at x = cx, s times the base size. */
function syntheticPose(cx = 500, s = 1, dy = 0) {
  const pts = new Float32Array(33 * 2);
  const vis = new Float32Array(33).fill(1);
  const set = (id, x, y) => {
    pts[id * 2] = cx + x * s;
    pts[id * 2 + 1] = (y + dy) * s;
  };
  for (let i = 0; i < 33; i++) set(i, 0, 300);
  set(POSE.nose, 0, 300);
  set(POSE.earA, 50, 300);
  set(POSE.earB, -50, 300);
  set(POSE.shoulderA, 100, 420);
  set(POSE.shoulderB, -100, 420);
  set(POSE.elbowA, 130, 600);
  set(POSE.elbowB, -130, 600);
  set(POSE.wristA, 140, 760);
  set(POSE.wristB, -140, 760);
  set(POSE.hipA, 60, 750);
  set(POSE.hipB, -60, 750);
  set(POSE.kneeA, 50, 1050);
  set(POSE.kneeB, -50, 1050);
  set(POSE.ankleA, 50, 1350);
  set(POSE.ankleB, -50, 1350);
  return { pts, vis };
}

const plan = (amounts, poses = [syntheticPose()], which = 'all') => bodyPlan(poses, { ...NONE, ...amounts }, which, W, H);
const off = (p, x, y) => bodyOffset(p, x, y);

describe('body frame', () => {
  it('measures an upright person', () => {
    const f = bodyFrame(syntheticPose());
    expect(f.uy[0]).toBeCloseTo(0);
    expect(f.uy[1]).toBeCloseTo(1);
    expect(f.ux[0]).toBeCloseTo(1);
    expect(f.sw).toBeCloseTo(200);
    expect(f.torso).toBeCloseTo(330);
    expect(f.head.c).toEqual([500, 300]);
    expect(f.head.r).toBeCloseTo(80);
    expect(f.legEnd).toBeCloseTo(930);
  });

  it('copes with a person turned sideways and unseen feet', () => {
    const p = syntheticPose();
    p.pts[POSE.shoulderA * 2] = 510;
    p.pts[POSE.shoulderB * 2] = 490;
    p.vis[POSE.ankleA] = 0.1;
    const f = bodyFrame(p);
    expect(f.sw).toBeGreaterThan(100);
    expect(f.ankles).toBeNull();
    expect(f.legEnd).toBe(Infinity);
  });
});

describe('steadying poses', () => {
  const jitter = (pose, amount, seed) => {
    let x = seed;
    const rnd = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648 - 0.5;
    };
    return { pts: pose.pts.map((v) => v + rnd() * 2 * amount), vis: pose.vis };
  };

  it('averages away jitter on a still person and follows one that moves', () => {
    const base = syntheticPose();
    let tracks = null;
    const raw = [];
    const steady = [];
    for (let f = 0; f < 30; f++) {
      const d = jitter(base, 3, f + 1);
      raw.push(d.pts[POSE.shoulderA * 2]);
      tracks = trackPoses(tracks, [d], f / 30, f ? 1 / 30 : 0);
      steady.push(tracks[0].pose.pts[POSE.shoulderA * 2]);
    }
    const spread = (xs) => Math.max(...xs.slice(10)) - Math.min(...xs.slice(10));
    expect(spread(steady)).toBeLessThan(spread(raw) * 0.6);
    // A quick move is followed within a few frames.
    let t = tracks;
    for (let f = 0; f < 4; f++) t = trackPoses(t, [syntheticPose(560)], 1 + f / 30, 1 / 30);
    expect(t[0].pose.pts[POSE.shoulderA * 2]).toBeGreaterThan(640);
  });

  it('holds a person the model briefly lost, then lets them go', () => {
    const first = trackPoses(null, [syntheticPose()], 0, 0);
    expect(trackPoses(first, [], POSE_HOLD / 2, POSE_HOLD / 2)).toHaveLength(1);
    expect(trackPoses(first, [], POSE_HOLD * 2, POSE_HOLD * 2)).toHaveLength(0);
    // A second person far away starts fresh and does not steal the first one's points.
    const two = trackPoses(first, [syntheticPose(500), syntheticPose(900, 0.6)], 1 / 30, 1 / 30);
    expect(two).toHaveLength(2);
    expect(two[1].pose.pts[POSE.shoulderA * 2]).toBeCloseTo(900 + 60);
  });
});

describe('body warps', () => {
  it('does nothing without amounts or people', () => {
    expect(plan({})).toBeNull();
    expect(bodyPlan([], { ...NONE, slim: 1 }, 'all', W, H)).toBeNull();
    const p = syntheticPose();
    p.vis[POSE.shoulderA] = 0.1;
    expect(bodyPlan([p], { ...NONE, slim: 1 }, 'all', W, H)).toBeNull();
  });

  it('slims the body toward its middle, leaving rows straight, the head alone and far pixels put', () => {
    const p = plan({ slim: 1 });
    const k = BODY_LIMITS.slim / (1 - BODY_LIMITS.slim);
    // Inside the body: an even squeeze (samples come from farther out).
    expect(off(p, 600, 900)[0]).toBeCloseTo(100 * k, 5);
    expect(off(p, 400, 900)[0]).toBeCloseTo(-100 * k, 5);
    // Every offset is across the body, so horizontal lines stay straight.
    for (let x = 0; x <= W; x += 50) for (let y = 0; y <= H; y += 50) expect(off(p, x, y)[1]).toBe(0);
    expect(off(p, 560, 300)).toEqual([0, 0]); // head
    expect(off(p, 900, 900)).toEqual([0, 0]); // past two body half-widths
    expect(off(p, 600, H - 1)).toEqual([0, 0]); // below the feet
    // Fuller goes the other way.
    expect(off(plan({ slim: -1 }), 600, 900)[0]).toBeLessThan(0);
  });

  it('only pulls in the waist', () => {
    const p = plan({ waist: 1 });
    const waist = 420 + 0.7 * 330;
    expect(off(p, 580, waist)[0]).toBeGreaterThan(8);
    expect(off(p, 580, 430)).toEqual([0, 0]);
    expect(off(p, 580, 1100)).toEqual([0, 0]);
  });

  it('resizes the head around its center', () => {
    const big = plan({ head: 1 });
    const s = BODY_LIMITS.head / (1 + BODY_LIMITS.head);
    expect(off(big, 540, 300)[0]).toBeCloseTo(-40 * s, 5); // samples nearer the center: larger
    expect(off(big, 500, 260)[1]).toBeCloseTo(40 * s, 5);
    expect(off(big, 500, 600)).toEqual([0, 0]);
    expect(off(plan({ head: -1 }), 540, 300)[0]).toBeGreaterThan(0);
  });

  it('moves the shoulders out (or in) and leaves the middle of the neck alone', () => {
    const p = plan({ shoulders: 1 });
    const d = BODY_LIMITS.shoulders * 200;
    expect(off(p, 600, 440)[0]).toBeCloseTo(-d, 5);
    expect(off(p, 400, 440)[0]).toBeCloseTo(d, 5);
    expect(off(p, 500, 440)[0]).toBeCloseTo(0, 5);
    expect(off(plan({ shoulders: -1 }), 600, 440)[0]).toBeCloseTo(d, 5);
  });

  it('slims each arm toward its bones without a seam at the elbow', () => {
    const p = plan({ arms: 1 });
    const k = BODY_LIMITS.arms / (1 - BODY_LIMITS.arms);
    const a = [600, 420];
    const b = [630, 600];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
    const m = [(a[0] + b[0]) / 2 + n[0] * 15, (a[1] + b[1]) / 2 + n[1] * 15];
    const [dx, dy] = off(p, m[0], m[1]);
    expect(dx * n[0] + dy * n[1]).toBeCloseTo(15 * k, 1);
    // Smooth across the inside of the elbow.
    let last = null;
    for (let x = 590; x <= 640; x += 0.5) {
      const o = off(p, x, 610);
      if (last) expect(Math.hypot(o[0] - last[0], o[1] - last[1])).toBeLessThan(0.6);
      last = o;
    }
    // Hands and the torso next to the shoulder stay put.
    expect(off(p, 640, 800)).toEqual([0, 0]);
    expect(off(p, 620, 1000)).toEqual([0, 0]);
  });

  it('works on everyone or only the largest person', () => {
    const poses = [syntheticPose(300, 0.6), syntheticPose(700)];
    expect(off(bodyPlan(poses, { ...NONE, slim: 1 }, 'all', W, H), 360, 600)[0]).not.toBe(0);
    const largest = bodyPlan(poses, { ...NONE, slim: 1 }, 'largest', W, H);
    expect(largest.people).toHaveLength(1);
    expect(off(largest, 760, 900)[0]).toBeGreaterThan(0);
  });

  it('never folds the picture, even at the strongest settings', () => {
    for (const amounts of [{ slim: 1, waist: 1, head: 1, shoulders: 1, arms: 1, legs: 1 }, { slim: -1, waist: -1, head: -1, shoulders: -1, arms: -1 }]) {
      const p = plan(amounts);
      for (let y = 0; y <= H; y += 25) {
        let last = -Infinity;
        for (let x = 0; x <= W; x += 2) {
          const sx = x + off(p, x, y)[0];
          expect(sx).toBeGreaterThan(last);
          last = sx;
        }
      }
      for (let x = 0; x <= W; x += 25) {
        let last = -Infinity;
        for (let y = 0; y <= H; y += 2) {
          const sy = y + off(p, x, y)[1];
          expect(sy).toBeGreaterThan(last);
          last = sy;
        }
      }
    }
  });

  it('fades out at the frame edges so nothing comes from outside the picture', () => {
    const p = plan({ slim: 1, arms: 1 }, [syntheticPose(130)]);
    for (let y = 0; y <= H; y += 20) {
      expect(off(p, 0, y)[0]).toBe(0);
      expect(off(p, W, y)[0]).toBe(0);
    }
  });
});

describe('leg stretch', () => {
  it('stretches only the rows below the hips, keeping columns straight and the feet in the picture', () => {
    const p = plan({ legs: 1 });
    const k = BODY_LIMITS.legs;
    for (let x = 0; x <= W; x += 100) {
      expect(off(p, x, 600)).toEqual([0, 0]);
      expect(off(p, x, 1200)[0]).toBe(0);
    }
    // Between the hips and the ankles each source row takes 1 + k rows.
    const a = legSource(p.legs, 950);
    const b = legSource(p.legs, 1050);
    expect((1050 - 950) / (b - a)).toBeCloseTo(1 + k, 2);
    // The ankles land about k leg-lengths lower; the ground below gives the room back.
    const ankleRow = [...Array(H).keys()].find((y) => legSource(p.legs, y) >= 1350);
    expect(Math.abs(ankleRow - (1350 + k * 600))).toBeLessThan(6);
    expect(legSource(p.legs, H)).toBeCloseTo(H, -1);
  });

  it('pushes the bottom out when there is no room below the feet, and skips people lying down', () => {
    const pose = syntheticPose();
    pose.vis[POSE.ankleA] = 0;
    const legs = legStretch([pose], 0.1, H);
    expect(legSource(legs, H)).toBeLessThan(H - 50);
    const lying = syntheticPose();
    for (const [id, x, y] of [[POSE.shoulderA, 300, 800], [POSE.shoulderB, 300, 900], [POSE.hipA, 700, 800], [POSE.hipB, 700, 900]]) {
      lying.pts[id * 2] = x;
      lying.pts[id * 2 + 1] = y;
    }
    expect(legStretch([lying], 0.1, H)).toBeNull();
  });
});

describe('offset grid', () => {
  it('reads back like the field it was sampled from', () => {
    const p = plan({ slim: 0.6, waist: 0.5, head: 0.4, shoulders: 0.5, arms: 0.7, legs: 0.5 });
    const grid = bodyGrid(p);
    expect(grid.cols).toBeGreaterThan(50);
    expect(grid.rows).toBe(Math.round((grid.cols - 1) * (H / W)) + 1);
    expect(grid.data).toHaveLength(grid.cols * grid.rows * 2);
    let worst = 0;
    for (let y = 250; y < 1500; y += 37) {
      for (let x = 300; x < 700; x += 23) {
        const exact = off(p, x, y);
        const read = sampleGrid(grid, W, H, x, y);
        worst = Math.max(worst, Math.hypot(exact[0] - read[0], exact[1] - read[1]));
      }
    }
    expect(worst).toBeLessThan(1);
    // Corners and the top edge do not move.
    expect(sampleGrid(grid, W, H, 0, 0)).toEqual([0, 0]);
    expect(sampleGrid(grid, W, H, W, 0)).toEqual([0, 0]);
  });
});
