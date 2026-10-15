// Track clean-up rules (pure, unit tested): short tracked segments and motion spikes.
import type { MovieTrackingTrack } from './types';

/** Runs of consecutive enabled markers: [first frame, last frame]. */
export function trackedSegments(t: MovieTrackingTrack): [number, number][] {
  const out: [number, number][] = [];
  let a = -1,
    b = -1;
  for (const m of [...t.markers].sort((x, y) => x.frame - y.frame)) {
    if (m.mute) {
      if (a >= 0) out.push([a, b]);
      a = -1;
      continue;
    }
    if (a >= 0 && m.frame === b + 1) b = m.frame;
    else {
      if (a >= 0) out.push([a, b]);
      a = b = m.frame;
    }
  }
  if (a >= 0) out.push([a, b]);
  return out;
}

/** Whether a track counts as too short: no tracked run of at least `frames` frames. */
export function isShortTrack(t: MovieTrackingTrack, frames: number): boolean {
  if (frames <= 0) return false;
  return !trackedSegments(t).some(([a, b]) => b - a + 1 >= frames);
}

/** Remove the markers of runs shorter than `frames` (true if anything changed). */
export function dropShortSegments(t: MovieTrackingTrack, frames: number): boolean {
  const short = trackedSegments(t).filter(([a, b]) => b - a + 1 < frames);
  if (!short.length) return false;
  t.markers = t.markers.filter((m) => m.mute || !short.some(([a, b]) => m.frame >= a && m.frame <= b));
  return true;
}

/** Largest change of motion between neighbouring frames (pixels), a measure of spikes. */
export function maxAcceleration(t: MovieTrackingTrack, size: [number, number]): number {
  const ms = [...t.markers].filter((m) => !m.mute).sort((a, b) => a.frame - b.frame);
  let worst = 0;
  for (let i = 2; i < ms.length; i++) {
    const a = ms[i - 2],
      b = ms[i - 1],
      c = ms[i];
    if (b.frame !== a.frame + 1 || c.frame !== b.frame + 1) continue;
    const ax = (c.co[0] - 2 * b.co[0] + a.co[0]) * size[0],
      ay = (c.co[1] - 2 * b.co[1] + a.co[1]) * size[1];
    worst = Math.max(worst, Math.hypot(ax, ay));
  }
  return worst;
}
