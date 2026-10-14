// Automation curve evaluation, shared by the playlist (drawing), the tempo
// map (engine/tempo.js) and the audio engine (playback). Pure: no DOM, no
// project lookups.
//
// Points are { t, v, c? }: t in ticks of automation-local time, v normalized
// 0..1 (map it to a parameter value with lib/params.js fromNorm and the
// target's parameter definition, see automation/targets.js), c the optional
// curve tension (-1..1, default 0) of the segment from this point to the next.
// A playlist clip of kind 'auto' plays the window [clip.offset, clip.offset +
// clip.len) of its automation's timeline starting at clip.start, so at song
// tick s the local time is s - clip.start + clip.offset (clipLocalTime below).
//
// Between points the value moves along the segment's curve; before the first
// point it holds the first value and after the last point it holds the last
// value. Two points at the same time make a step (the later one wins).
//
// Curve tension: with x the segment progress (0..1) and k = CURVE_K * c,
//   shape(x) = (e^(k x) - 1) / (e^k - 1)        (x itself when c is 0)
//   value    = v0 + (v1 - v0) * shape(x)
// The exponential mapping is monotonic for every c (the value never
// overshoots its two points), exactly linear at 0, and symmetric:
// shape(x, -c) = 1 - shape(1 - x, c). c > 0 starts slowly and speeds up
// towards the next point ("ease in"); c < 0 moves quickly first and settles
// ("ease out"). At |c| = 1 the midpoint sits 4.7% from the end values.

/** Steepness of a curve at |c| = 1. */
export const CURVE_K = 6;

/** Progress 0..1 along a segment with tension c (-1..1) at linear progress x (0..1). */
export function curveShape(x, c) {
  if (!c) return x;
  const k = CURVE_K * (c > 1 ? 1 : c < -1 ? -1 : c);
  if (k > -1e-6 && k < 1e-6) return x;
  return Math.expm1(k * x) / Math.expm1(k);
}

/**
 * Value of a sorted point list at local tick `t` (null when there are no points).
 * Binary search, so long curves stay cheap to evaluate every audio block.
 */
export function evaluateAutomation(points, t) {
  const n = points?.length || 0;
  if (!n) return null;
  if (t <= points[0].t) return points[0].v;
  const last = points[n - 1];
  if (t >= last.t) return last.v;
  // Last point with p.t <= t.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  return a.v + (b.v - a.v) * curveShape((t - a.t) / span, a.c);
}

/** Automation-local time of song tick `songTick` inside an 'auto' clip. */
export function clipLocalTime(clip, songTick) {
  return songTick - clip.start + (clip.offset || 0);
}

/**
 * Value of an automation clip at a song tick, or null when the tick is
 * outside the clip, the clip is muted or the automation has no points.
 */
export function clipValueAt(clip, automation, songTick) {
  if (!clip || !automation || clip.mute) return null;
  if (songTick < clip.start || songTick >= clip.start + clip.len) return null;
  return evaluateAutomation(automation.points, clipLocalTime(clip, songTick));
}
