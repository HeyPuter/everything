/**
 * Pure geometry behind body shape (model/retouch.js, engine/body-render.js):
 * steadying pose landmarks between frames, and the smooth local warps that
 * slim the body and waist, lengthen the legs, resize the head, broaden or
 * narrow the shoulders and slim the arms.
 *
 * Every warp is an offset field: the pixel at p shows the source at p + u(p)
 * (source pixels, y down). The fields are built to keep straight lines
 * straight where they can: slimming moves pixels only across the body (so
 * lines along it and across it stay straight away from where the effect
 * fades), longer legs only stretch rows below the hips (no column bends),
 * and every offset fades out before the frame edge so nothing is pulled in
 * from outside the picture. bodyGrid() samples the field on a grid that
 * LAYER_FS reads back with bilinear filtering (see bodyWarpPx there).
 *
 * Poses are { pts, vis }: pts a Float32Array of x, y pairs in source pixels
 * for the 33 points of the pose landmarker, vis how likely each is visible.
 * "A" and "B" are the two sides of the body (the model's left and right).
 */
import { smoothstep, smoothPoints, matchNearest, handleWeight } from './face-geometry.js';

/** Pose landmark indices used here. */
export const POSE = Object.freeze({
  nose: 0, earA: 7, earB: 8, shoulderA: 11, shoulderB: 12, elbowA: 13, elbowB: 14, wristA: 15, wristB: 16,
  hipA: 23, hipB: 24, kneeA: 25, kneeB: 26, ankleA: 27, ankleB: 28,
});
export const POSE_POINTS = 33;
/** Visibility at which a point is trusted. */
export const SEEN = 0.5;

const P = (pose, i) => [pose.pts[i * 2], pose.pts[i * 2 + 1]];
const seen = (pose, ...ids) => ids.every((i) => (pose.vis?.[i] ?? 1) >= SEEN);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, v, k = 1) => [a[0] + v[0] * k, a[1] + v[1] * k];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** 1 inside lo, falling smoothly to 0 at hi. */
const fade = (lo, hi, x) => 1 - smoothstep(lo, hi, x);

/** Shoulder width of a pose (px), the scale of everything else. */
export const poseSize = (pose) => dist(P(pose, POSE.shoulderA), P(pose, POSE.shoulderB)) || 1;
/** Middle of the shoulders. */
export const poseCenter = (pose) => mid(P(pose, POSE.shoulderA), P(pose, POSE.shoulderB));

/**
 * Axes and measures of a body: uy down the torso (neck to pelvis), ux across
 * it, the shoulder width sw (at least a little of the torso, for people
 * turned sideways), the torso length, the head (center, radius) and where
 * the legs end along uy (null when the ankles are not seen).
 */
export function bodyFrame(pose) {
  const sA = P(pose, POSE.shoulderA);
  const sB = P(pose, POSE.shoulderB);
  const neck = mid(sA, sB);
  const pelvis = mid(P(pose, POSE.hipA), P(pose, POSE.hipB));
  const span = dist(sA, sB);
  let torso = dist(neck, pelvis);
  const uy = torso > 1 ? [(pelvis[0] - neck[0]) / torso, (pelvis[1] - neck[1]) / torso] : [0, 1];
  const ux = [uy[1], -uy[0]];
  const sw = Math.max(span, torso * 0.45, 1);
  torso = Math.max(torso, sw * 0.9);
  const ears = seen(pose, POSE.earA, POSE.earB);
  const head = ears
    ? { c: mid(P(pose, POSE.earA), P(pose, POSE.earB)), r: Math.max(dist(P(pose, POSE.earA), P(pose, POSE.earB)) * 0.8, sw * 0.25) }
    : { c: P(pose, POSE.nose), r: sw * 0.35 };
  const ankles = seen(pose, POSE.ankleA, POSE.ankleB) ? mid(P(pose, POSE.ankleA), P(pose, POSE.ankleB)) : null;
  return { neck, pelvis, ux, uy, sw, torso, head, ankles, legEnd: ankles ? dot(sub(ankles, neck), uy) : Infinity };
}

/* Steadying ------------------------------------------------------------------ */

/** How long (seconds) a person the model briefly lost is kept in place. */
export const POSE_HOLD = 0.3;

/**
 * Poses to draw this frame from those of the last one (tracks: { pose,
 * seen }) and what the model found now, like trackFaces: matched people are
 * steadied, new ones start fresh, and one missing for less than POSE_HOLD
 * stays where it was.
 */
export function trackPoses(tracks, detected, sec, dt) {
  const prev = tracks || [];
  const match = matchNearest(prev.map((t) => t.pose), detected, poseCenter, (p) => poseSize(p) * 0.6);
  const out = detected.map((pose, i) => {
    const j = match[i];
    if (j < 0) return { pose: { pts: Float32Array.from(pose.pts), vis: Float32Array.from(pose.vis) }, seen: sec };
    const last = prev[j].pose;
    const vis = pose.vis.map((v, k) => (last.vis[k] + v) / 2);
    return { pose: { pts: smoothPoints(last.pts, pose.pts, dt, poseSize(pose)), vis }, seen: sec };
  });
  prev.forEach((t, j) => {
    if (!match.includes(j) && Math.abs(sec - t.seen) < POSE_HOLD) out.push(t);
  });
  return out;
}

/* Warps ---------------------------------------------------------------------- */

/** Strongest change of each slider at +-1: share of width, length or size. */
export const BODY_LIMITS = Object.freeze({ slim: 0.1, waist: 0.12, legs: 0.12, head: 0.15, shoulders: 0.07, arms: 0.18 });

/** Compression toward an axis by k (0.1 = 10% narrower) as an outward sampling gain. */
const squeeze = (k) => k / (1 - k);

/** The people a warp works on: all of them (trusted shoulders) or the largest. */
function chosen(poses, which) {
  const list = (poses || []).filter((p) => seen(p, POSE.shoulderA, POSE.shoulderB));
  if (which === 'largest' && list.length > 1) return [list.reduce((a, b) => (poseSize(b) > poseSize(a) ? b : a))];
  return list;
}

/**
 * Everything the offset field needs for a frame: per person its frame and
 * the parts that move, and the leg stretch (rows below the hips of the
 * largest upright person). amounts: slim, waist, legs, head, shoulders,
 * arms, each -1..1 (legs 0..1). null when nothing moves.
 */
export function bodyPlan(poses, amounts, which, W, H) {
  if (!amounts) return null;
  const { slim = 0, waist = 0, legs = 0, head = 0, shoulders = 0, arms = 0 } = amounts;
  const people = chosen(poses, which).map((pose) => {
    const f = bodyFrame(pose);
    const limbs = [];
    if (arms) {
      for (const [s, e, w] of [[POSE.shoulderA, POSE.elbowA, POSE.wristA], [POSE.shoulderB, POSE.elbowB, POSE.wristB]]) {
        if (!seen(pose, e)) continue;
        const pts = [P(pose, s), P(pose, e)];
        if (seen(pose, w)) pts.push(P(pose, w));
        limbs.push(pts);
      }
    }
    return {
      f,
      slim: squeeze(slim * BODY_LIMITS.slim),
      waist: squeeze(waist * BODY_LIMITS.waist),
      head: (head * BODY_LIMITS.head) / (1 + head * BODY_LIMITS.head),
      shoulders: shoulders * BODY_LIMITS.shoulders * f.sw,
      shoulderPts: [P(pose, POSE.shoulderA), P(pose, POSE.shoulderB)],
      arms: squeeze(arms * BODY_LIMITS.arms),
      limbs,
    };
  });
  const legPlan = legs > 0 ? legStretch(chosen(poses, which), legs * BODY_LIMITS.legs, H) : null;
  if (!legPlan && !people.some((p) => p.slim || p.waist || p.head || p.shoulders || (p.arms && p.limbs.length))) return null;
  return { people, legs: legPlan, W, H, margin: Math.max(W, H) * 0.03 };
}

/**
 * Leg stretch: rows between the hips and the ankles (or the bottom of the
 * frame) grow by k, and the ground below the feet gives that room back
 * where it can, so the feet stay in the picture. Stored as g, the
 * destination row of each of N + 1 evenly spaced source rows.
 */
export function legStretch(poses, k, H, N = 512) {
  const up = poses.filter((p) => seen(p, POSE.hipA, POSE.hipB)).map((p) => ({ p, f: bodyFrame(p) })).filter(({ f }) => f.uy[1] > 0.8 && f.pelvis[1] > 0 && f.pelvis[1] < H * 0.92);
  if (!up.length || !(k > 0)) return null;
  const { f } = up.reduce((a, b) => (b.f.sw > a.f.sw ? b : a));
  const hip = f.pelvis[1];
  const ankle = f.ankles ? clamp(f.ankles[1], hip + 1, H) : H;
  const blend = Math.max(2, Math.min(H * 0.04, (ankle - hip) * 0.2));
  const below = H - ankle;
  // Rows below the ankles shrink to take the extra length back (never below 55%).
  const give = below > blend * 2 ? clamp(1 - (k * (ankle - hip)) / below, 0.55, 1) : 1;
  const slope = (y) => 1 + k * smoothstep(hip - blend, hip + blend, y) * fade(ankle - blend, ankle + blend, y) + (give - 1) * smoothstep(ankle - blend, ankle + blend, y);
  const g = new Float64Array(N + 1);
  const step = H / N;
  let prev = slope(0);
  for (let i = 1; i <= N; i++) {
    const s = slope(i * step);
    g[i] = g[i - 1] + ((prev + s) / 2) * step;
    prev = s;
  }
  return { g, step, hip, ankle };
}

/** Source row shown at destination row y under a leg stretch (the inverse of its g). */
export function legSource(legs, y) {
  const { g, step } = legs;
  if (y <= 0) return y;
  const n = g.length - 1;
  if (y >= g[n]) return n * step + (y - g[n]);
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (g[m] <= y) lo = m;
    else hi = m;
  }
  return (lo + (y - g[lo]) / (g[hi] - g[lo] || 1)) * step;
}

/** Point on the body axis at distance v below the neck: down the torso, then toward the feet. */
function axisAt(f, v) {
  if (v <= f.torso || !f.ankles) return add(f.neck, f.uy, v);
  const leg = sub(f.ankles, f.pelvis);
  const along = dot(leg, f.uy);
  if (along < f.sw * 0.5) return add(f.neck, f.uy, v);
  return add(f.pelvis, leg, (v - f.torso) / along);
}

/** Arm slimming: squeeze toward the bones of one arm, blended over its segments so the elbow has no seam. */
function armOffset(limb, sw, gain, p) {
  // Nothing moves farther than 2.2 radii from the bones.
  const reach = sw * 0.11 * 2.2;
  if (limb.every((q) => q[0] < p[0] - reach) || limb.every((q) => q[0] > p[0] + reach) || limb.every((q) => q[1] < p[1] - reach) || limb.every((q) => q[1] > p[1] + reach)) return [0, 0];
  let sx = 0;
  let sy = 0;
  let wsum = 0;
  for (let i = 0; i + 1 < limb.length; i++) {
    const a = limb[i];
    const b = limb[i + 1];
    const R = sw * (i === 0 ? 0.11 : 0.085);
    const ab = sub(b, a);
    const len2 = dot(ab, ab) || 1;
    const t = dot(sub(p, a), ab) / len2;
    const q = add(a, ab, clamp(t, 0, 1));
    const d = dist(p, q);
    // Upper arm starts below the shoulder (the torso is the body's), the last segment ends at the wrist.
    let ends = i === 0 ? smoothstep(0.15, 0.4, t) : 1;
    if (i + 2 === limb.length) ends *= fade(limb.length === 2 ? 0.95 : 0.9, limb.length === 2 ? 1.2 : 1.15, t);
    const w = fade(R, 2.2 * R, d) * ends;
    const a2 = 1 / ((d * d + 0.09 * R * R) ** 2);
    sx += (p[0] - q[0]) * w * a2;
    sy += (p[1] - q[1]) * w * a2;
    wsum += a2;
  }
  return wsum ? [(sx / wsum) * gain, (sy / wsum) * gain] : [0, 0];
}

/** Offset (dx, dy) of the parts of one person at p, before the edge fade. */
function personOffset(m, p) {
  const { f } = m;
  let dx = 0;
  let dy = 0;
  const rel = sub(p, f.neck);
  const v = dot(rel, f.uy);
  if (m.slim || m.waist) {
    const a = dot(sub(p, axisAt(f, v)), f.ux);
    const abs = Math.abs(a);
    if (m.slim) {
      // The whole body (arms at the sides too) narrows; the head does not.
      const hw = f.sw * 0.8;
      const along = smoothstep(-0.08 * f.torso, 0.2 * f.torso, v) * fade(f.legEnd + 0.1 * f.torso, f.legEnd + 0.4 * f.torso, v);
      const k = a * m.slim * along * fade(hw, 2 * hw, abs);
      dx += f.ux[0] * k;
      dy += f.ux[1] * k;
    }
    if (m.waist) {
      const t = (v - 0.7 * f.torso) / (0.3 * f.torso);
      if (t > -1 && t < 1) {
        const hw = f.sw * 0.5;
        const k = a * m.waist * (1 - t * t) ** 2 * fade(hw, 2.1 * hw, abs);
        dx += f.ux[0] * k;
        dy += f.ux[1] * k;
      }
    }
  }
  if (m.head) {
    const r = dist(p, f.head.c);
    if (r < 2.1 * f.head.r) {
      const k = -m.head * fade(f.head.r, 2.1 * f.head.r, r);
      dx += (p[0] - f.head.c[0]) * k;
      dy += (p[1] - f.head.c[1]) * k;
    }
  }
  if (m.shoulders) {
    for (const s of m.shoulderPts) {
      const side = Math.sign(dot(sub(s, f.neck), f.ux)) || 1;
      const c = add(s, f.uy, f.sw * 0.1);
      const r = sub(p, c);
      const qx = dot(r, f.ux) / (f.sw * 0.5);
      const qy = dot(r, f.uy) / (f.sw * 0.8);
      const w = handleWeight(qx * qx + qy * qy);
      if (!w) continue;
      // Sample from nearer the neck, so the shoulder moves out (or in, when narrowing).
      dx -= f.ux[0] * side * m.shoulders * w;
      dy -= f.ux[1] * side * m.shoulders * w;
    }
  }
  if (m.arms) {
    for (const limb of m.limbs) {
      const [ax, ay] = armOffset(limb, f.sw, m.arms, p);
      dx += ax;
      dy += ay;
    }
  }
  return [dx, dy];
}

/**
 * Offset of the body warp at destination (x, y): the picture there shows
 * the source at (x + dx, y + dy). The leg stretch maps the row first; the
 * other parts work on the result.
 */
export function bodyOffset(plan, x, y) {
  const q = [x, plan.legs ? legSource(plan.legs, y) : y];
  let dx = 0;
  let dy = 0;
  for (const m of plan.people) {
    const [ox, oy] = personOffset(m, q);
    dx += ox;
    dy += oy;
  }
  // Near the frame edges the parts fade out, so nothing is pulled in from outside the picture.
  const { W, H, margin } = plan;
  dx *= smoothstep(0, margin, q[0]) * smoothstep(0, margin, W - q[0]);
  dy *= smoothstep(0, margin, q[1]) * smoothstep(0, margin, H - q[1]);
  return [q[0] + dx - x, q[1] + dy - y];
}

/**
 * The offset field on a grid over the source (cols x rows points from
 * corner to corner, at most `cells` cells along the longer side), as x, y
 * pairs row by row from the top.
 */
export function bodyGrid(plan, cells = 128) {
  const { W, H } = plan;
  const step = Math.max(W, H) / cells;
  const cols = Math.max(2, Math.round(W / step) + 1);
  const rows = Math.max(2, Math.round(H / step) + 1);
  const data = new Float32Array(cols * rows * 2);
  for (let j = 0; j < rows; j++) {
    const y = (j * H) / (rows - 1);
    for (let i = 0; i < cols; i++) {
      const [dx, dy] = bodyOffset(plan, (i * W) / (cols - 1), y);
      data[(j * cols + i) * 2] = dx;
      data[(j * cols + i) * 2 + 1] = dy;
    }
  }
  return { cols, rows, data };
}

/** Bilinear read of a grid at source point (x, y), as LAYER_FS does it. */
export function sampleGrid(grid, W, H, x, y) {
  const { cols, rows, data } = grid;
  const gx = clamp((x / W) * (cols - 1), 0, cols - 1);
  const gy = clamp((y / H) * (rows - 1), 0, rows - 1);
  const i = Math.min(Math.floor(gx), cols - 2);
  const j = Math.min(Math.floor(gy), rows - 2);
  const fx = gx - i;
  const fy = gy - j;
  const at = (c, r, k) => data[(r * cols + c) * 2 + k];
  const lerp2 = (k) => {
    const top = at(i, j, k) * (1 - fx) + at(i + 1, j, k) * fx;
    const bottom = at(i, j + 1, k) * (1 - fx) + at(i + 1, j + 1, k) * fx;
    return top * (1 - fy) + bottom * fy;
  };
  return [lerp2(0), lerp2(1)];
}
