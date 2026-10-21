// NLA strip control curves: with Animated Influence on, a strip's influence follows its own
// `influence` F-Curve (turning it on keys the stored influence at the strip start, as observed in
// the reference app). The NLA draws the curve over the strip (View ▸ Show Control F-Curves).
import type { FCurve, NlaStrip } from '../data/types';
import { insertKeyframe, evaluateFCurve, keyframeDefaults } from '../anim/fcurve';

/** The strip's influence curve (made when `create`). */
export function influenceCurve(s: NlaStrip, create = false): FCurve | undefined {
  let fc = s.fcurves?.find((f) => f.data_path === 'influence');
  if (!fc && create) {
    // new curves smooth their handles like keyed ones (Preferences ▸ Animation)
    fc = { data_path: 'influence', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], auto_smoothing: keyframeDefaults.smoothing };
    (s.fcurves ??= []).push(fc);
  }
  return fc;
}

/** Turn Animated Influence on (keying the stored influence at the strip start when unkeyed) or off (keys are kept). */
export function setAnimatedInfluence(s: NlaStrip, on: boolean) {
  if (!on) {
    s.influence = undefined;
    return;
  }
  s.influence ??= 0;
  const fc = influenceCurve(s, true)!;
  if (!fc.keyframe_points.length) insertKeyframe(fc, s.frame_start, s.influence);
}

/** Key the strip's influence at a frame. */
export function keyStripInfluence(s: NlaStrip, frame: number, value: number) {
  if (s.influence === undefined) setAnimatedInfluence(s, true);
  s.influence = value;
  insertKeyframe(influenceCurve(s, true)!, frame, value);
}

/** Whether the influence has a key on this frame. */
export function influenceKeyed(s: NlaStrip, frame: number): boolean {
  return !!influenceCurve(s)?.keyframe_points.some((k) => Math.abs(k.co[0] - frame) < 1e-3);
}

/** Influence samples over the strip, for drawing: [frame, influence] pairs. */
export function influenceSamples(s: NlaStrip, steps = 48): [number, number][] {
  const fc = influenceCurve(s);
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const f = s.frame_start + ((s.frame_end - s.frame_start) * i) / steps;
    const v = fc && fc.keyframe_points.length ? evaluateFCurve(fc, f) : (s.influence ?? 1);
    out.push([f, Math.max(0, Math.min(1, v))]);
  }
  return out;
}
