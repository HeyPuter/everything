// 2D stabilization: measures the footage motion (translation from the location tracks, rotation
// and scale from the rotation tracks around the location pivot) relative to the anchor frame and
// builds the compensating 2D transform. Pure math on the clip data, in pixel coordinates with the
// origin at the bottom-left corner of the frame.
import { markerExact, type MovieClipData, type MovieTrackingTrack } from './types';

export type P2 = [number, number];
/** 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (canvas setTransform order) */
export type Affine2 = [number, number, number, number, number, number];

export interface Motion {
  /** average displacement of the location tracks from the anchor frame (pixels) */
  translation: P2;
  /** rotation of the rotation tracks around the pivot (radians, counter-clockwise) */
  angle: number;
  scale: number;
  /** pivot at this frame (anchor pivot + translation) */
  pivot: P2;
  /** number of location tracks contributing */
  count: number;
}

function pos(clip: MovieClipData, t: MovieTrackingTrack, frame: number): P2 | null {
  const m = markerExact(t, frame);
  if (!m || m.mute) return null;
  return [m.co[0] * clip.size[0], m.co[1] * clip.size[1]];
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Anchor-equivalent positions of the location tracks (tracks missing at the anchor are chained through a shared frame). */
function anchorPositions(clip: MovieClipData, tracks: MovieTrackingTrack[], anchor: number): Map<MovieTrackingTrack, P2> {
  const out = new Map<MovieTrackingTrack, P2>();
  for (const t of tracks) {
    const p = pos(clip, t, anchor);
    if (p) out.set(t, p);
  }
  for (const t of tracks) {
    if (out.has(t)) continue;
    // nearest frame where this track and at least one anchored track exist
    const frames = t.markers.filter((m) => !m.mute).map((m) => m.frame).sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor));
    for (const f of frames) {
      let sx = 0,
        sy = 0,
        sw = 0;
      for (const [u, a] of out) {
        const q = pos(clip, u, f);
        if (!q) continue;
        sx += u.weight_stab * (q[0] - a[0]);
        sy += u.weight_stab * (q[1] - a[1]);
        sw += u.weight_stab;
      }
      if (sw <= 0) continue;
      const p = pos(clip, t, f)!;
      out.set(t, [p[0] - sx / sw, p[1] - sy / sw]);
      break;
    }
  }
  return out;
}

export function measureMotion(clip: MovieClipData, frame: number): Motion {
  const st = clip.tracking.stabilization;
  const anchor = st.anchor_frame;
  const loc = clip.tracking.tracks.filter((t) => t.use_2d_stabilization && t.weight_stab > 0);
  const anchors = anchorPositions(clip, loc, anchor);
  let ax = 0,
    ay = 0,
    aw = 0;
  for (const [t, a] of anchors) {
    ax += t.weight_stab * a[0];
    ay += t.weight_stab * a[1];
    aw += t.weight_stab;
  }
  const A: P2 = aw > 0 ? [ax / aw, ay / aw] : [clip.size[0] / 2, clip.size[1] / 2];
  let sx = 0,
    sy = 0,
    sw = 0,
    count = 0;
  for (const [t, a] of anchors) {
    const p = pos(clip, t, frame);
    if (!p) continue;
    sx += t.weight_stab * (p[0] - a[0]);
    sy += t.weight_stab * (p[1] - a[1]);
    sw += t.weight_stab;
    count++;
  }
  const translation: P2 = sw > 0 ? [sx / sw, sy / sw] : [0, 0];
  const pivot: P2 = [A[0] + translation[0], A[1] + translation[1]];
  let angle = 0,
    scale = 1;
  if (st.use_stabilize_rotation || st.use_stabilize_scale) {
    let wa = 0,
      sa = 0,
      sl = 0;
    for (const t of clip.tracking.tracks) {
      if (!t.use_2d_stabilization_rotation || t.weight_stab <= 0) continue;
      const p0 = pos(clip, t, anchor),
        p = pos(clip, t, frame);
      if (!p0 || !p) continue;
      const v0: P2 = [p0[0] - A[0], p0[1] - A[1]],
        v: P2 = [p[0] - pivot[0], p[1] - pivot[1]];
      const l0 = Math.hypot(...v0),
        l = Math.hypot(...v);
      if (l0 < 1e-6 || l < 1e-6) continue;
      sa += t.weight_stab * wrap(Math.atan2(v[1], v[0]) - Math.atan2(v0[1], v0[0]));
      sl += t.weight_stab * Math.log(l / l0);
      wa += t.weight_stab;
    }
    if (wa > 0) {
      angle = sa / wa;
      scale = Math.exp(sl / wa);
    }
  }
  return { translation, angle, scale, pivot, count };
}

/** Compensating transform for a frame (without autoscale). Maps footage pixels → stabilized pixels. */
export function stabilizationTransform(clip: MovieClipData, frame: number, extraScale = 1): Affine2 {
  const st = clip.tracking.stabilization;
  const m = measureMotion(clip, frame);
  const phi = st.use_stabilize_rotation ? -(m.angle - st.target_rotation) * st.influence_rotation : 0;
  const sigma = st.use_stabilize_scale ? Math.pow(st.target_scale / Math.max(1e-6, m.scale), st.influence_scale) : 1;
  const shx = -(m.translation[0] - st.target_position[0]) * st.influence_location,
    shy = -(m.translation[1] - st.target_position[1]) * st.influence_location;
  const c = Math.cos(phi) * sigma,
    s = Math.sin(phi) * sigma;
  // p' = R σ (p - pivot) + pivot + shift
  let T: Affine2 = [c, s, -s, c, m.pivot[0] + shx - (c * m.pivot[0] - s * m.pivot[1]), m.pivot[1] + shy - (s * m.pivot[0] + c * m.pivot[1])];
  if (extraScale !== 1) {
    const cx = clip.size[0] / 2,
      cy = clip.size[1] / 2;
    T = multiply([extraScale, 0, 0, extraScale, cx - extraScale * cx, cy - extraScale * cy], T);
  }
  return T;
}

export function multiply(a: Affine2, b: Affine2): Affine2 {
  // a ∘ b
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

export function apply(T: Affine2, p: P2): P2 {
  return [T[0] * p[0] + T[2] * p[1] + T[4], T[1] * p[0] + T[3] * p[1] + T[5]];
}

export function invert(T: Affine2): Affine2 {
  const det = T[0] * T[3] - T[1] * T[2];
  const a = T[3] / det,
    b = -T[1] / det,
    c = -T[2] / det,
    d = T[0] / det;
  return [a, b, c, d, -(a * T[4] + c * T[5]), -(b * T[4] + d * T[5])];
}

/** Zoom (about the frame center) needed so the transformed footage covers the whole frame. */
export function coverScale(clip: MovieClipData, T: Affine2): number {
  const [W, H] = clip.size;
  const C: P2 = [W / 2, H / 2];
  const quad: P2[] = [apply(T, [0, 0]), apply(T, [W, 0]), apply(T, [W, H]), apply(T, [0, H])];
  let z = 1;
  for (const r of [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ] as P2[]) {
    // largest t with C + t (r - C) inside the quad
    const dx = r[0] - C[0],
      dy = r[1] - C[1];
    let tmax = Infinity;
    for (let i = 0; i < 4; i++) {
      const a = quad[i],
        b = quad[(i + 1) % 4];
      const ex = b[0] - a[0],
        ey = b[1] - a[1];
      // inward normal sign from the quad orientation
      const cross = (px: number, py: number) => ex * (py - a[1]) - ey * (px - a[0]);
      const orient = Math.sign(cross(C[0], C[1]));
      if (orient === 0) return Infinity;
      const denom = ex * dy - ey * dx;
      const num = -cross(C[0], C[1]);
      // cross(C + t d) = cross(C) + t * denom ; must keep sign `orient`
      if (Math.abs(denom) < 1e-12) continue;
      const t = num / denom;
      if (t > 0 && Math.sign(denom) === -orient) tmax = Math.min(tmax, t);
    }
    if (tmax <= 0) return Infinity;
    if (Number.isFinite(tmax)) z = Math.max(z, 1 / tmax);
  }
  return z;
}

/** Autoscale over the whole clip, clamped to `scale_max`. */
export function autoscaleFactor(clip: MovieClipData): number {
  const st = clip.tracking.stabilization;
  let z = 1;
  for (let f = 1; f <= Math.max(1, clip.frame_duration); f++) z = Math.max(z, coverScale(clip, stabilizationTransform(clip, f)));
  return Math.min(Math.max(1, z), st.scale_max > 0 ? st.scale_max : Infinity);
}

/** Fingerprint of everything the autoscale depends on (stabilization settings, stabilizing tracks' markers). */
function autoscaleKey(clip: MovieClipData): string {
  const st = clip.tracking.stabilization;
  let h = 2166136261,
    sum = 0;
  const mix = (x: number) => {
    const v = Number.isFinite(x) ? Math.round(x * 1e6) : -1;
    h = Math.imul(h ^ (v | 0), 16777619);
    sum += x;
  };
  for (const x of [clip.size[0], clip.size[1], clip.frame_duration, st.anchor_frame, +st.use_stabilize_rotation, +st.use_stabilize_scale, ...st.target_position, st.target_rotation, st.target_scale, st.scale_max, st.influence_location, st.influence_rotation, st.influence_scale]) mix(x);
  for (const t of clip.tracking.tracks) {
    if (!(t.weight_stab > 0) || !(t.use_2d_stabilization || t.use_2d_stabilization_rotation)) continue;
    mix(+t.use_2d_stabilization + 2 * +t.use_2d_stabilization_rotation);
    mix(t.weight_stab);
    for (const m of t.markers) {
      mix(m.frame);
      mix(m.co[0]);
      mix(m.co[1]);
      mix(+m.mute);
    }
  }
  return `${h >>> 0}:${sum}`;
}

const autoscaleMemo = new WeakMap<MovieClipData, { key: string; value: number }>();

/** Autoscale of the clip, recomputed only when its stabilization data changed. */
export function cachedAutoscale(clip: MovieClipData): number {
  const key = autoscaleKey(clip);
  const hit = autoscaleMemo.get(clip);
  if (hit && hit.key === key) return hit.value;
  const value = autoscaleFactor(clip);
  autoscaleMemo.set(clip, { key, value });
  return value;
}

/** Final transform used for display/export (autoscale included when enabled). */
export function stabilizationMatrix(clip: MovieClipData, frame: number, autoscale?: number): Affine2 {
  const st = clip.tracking.stabilization;
  const z = st.use_autoscale ? (autoscale ?? cachedAutoscale(clip)) : 1;
  return stabilizationTransform(clip, frame, z);
}

/** Per-frame stabilization data (for export). */
export function stabilizationTable(clip: MovieClipData): { frame: number; x: number; y: number; angle: number; scale: number }[] {
  const z = clip.tracking.stabilization.use_autoscale ? autoscaleFactor(clip) : 1;
  const rows = [];
  for (let f = 1; f <= clip.frame_duration; f++) {
    const T = stabilizationTransform(clip, f, z);
    const C: P2 = [clip.size[0] / 2, clip.size[1] / 2];
    const c = apply(T, C);
    rows.push({ frame: f, x: c[0] - C[0], y: c[1] - C[1], angle: Math.atan2(T[1], T[0]), scale: Math.hypot(T[0], T[1]) });
  }
  return rows;
}
