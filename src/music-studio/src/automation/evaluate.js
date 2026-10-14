// Automation curve evaluation, shared by the playlist (drawing) and the audio
// engine (playback). Pure: no DOM, no project lookups.
//
// Points are { t, v }: t in ticks of automation-local time, v normalized 0..1
// (map it to a parameter value with lib/params.js fromNorm and the target's
// parameter definition, see automation/targets.js). A playlist clip of kind
// 'auto' plays the window [clip.offset, clip.offset + clip.len) of its
// automation's timeline starting at clip.start, so at song tick s the local
// time is s - clip.start + clip.offset (clipLocalTime below).
//
// Between points the value is linearly interpolated; before the first point
// it holds the first value and after the last point it holds the last value.

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
  return a.v + ((b.v - a.v) * (t - a.t)) / span;
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
