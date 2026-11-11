/**
 * Review time helpers. Review times are integer microseconds from the start
 * of the review video. A version made from the in/out range starts at the
 * range's in point on the editor timeline, so comments map back through it.
 */
import { US, timecode } from '../lib/time.js';

/** Frames per second as stored with a version (a sane fallback for anything odd). */
export function reviewFps(fps) {
  const n = Number(fps);
  return Number.isFinite(n) && n >= 1 && n <= 240 ? n : 30;
}

/** Index of the frame showing at time t (microseconds). Frame starts are rounded to whole microseconds, hence the half. */
export function frameAt(t, fps) {
  const f = reviewFps(fps);
  return Math.max(0, Math.floor(((Math.max(0, t) + 0.5) * f) / US));
}

/** Start time (microseconds) of frame i. */
export function frameStart(i, fps) {
  return Math.round((Math.max(0, i) * US) / reviewFps(fps));
}

/** Snap a time down to the start of its frame. */
export function snapToFrame(t, fps) {
  return frameStart(frameAt(t, fps), fps);
}

/** Last frame index of a video duration long. */
export function lastFrame(duration, fps) {
  return Math.max(0, Math.ceil((Math.max(0, duration) * reviewFps(fps)) / US - 1e-6) - 1);
}

/** Time of the frame n frames away from the one at t, kept inside the video. */
export function stepFrames(t, n, fps, duration) {
  const i = Math.min(lastFrame(duration, fps), Math.max(0, frameAt(t, fps) + n));
  return frameStart(i, fps);
}

/**
 * Seconds to hand a media element so it shows frame i: the middle of the
 * frame, so rounding in the decoder never lands on the neighbour.
 */
export function seekSeconds(t, fps) {
  const f = reviewFps(fps);
  return (frameAt(t, f) + 0.5) / f;
}

/** Time (microseconds) from a media element's currentTime (seconds). */
export function fromSeconds(seconds) {
  return Math.max(0, Math.round((Number(seconds) || 0) * US));
}

/** HH:MM:SS:FF at the review's frame rate. */
export function reviewTimecode(t, fps) {
  const f = reviewFps(fps);
  const frame = frameAt(t, f);
  return timecode(Math.round((frame * US) / f), f);
}

/** "00:12:04 to 00:12:09" style label for a comment's pin. */
export function pinLabel(comment, fps) {
  if (comment.t === null || comment.t === undefined) return '';
  return comment.end !== null && comment.end !== undefined ? `${reviewTimecode(comment.t, fps)} to ${reviewTimecode(comment.end, fps)}` : reviewTimecode(comment.t, fps);
}

/**
 * Editor timeline time for a review time in a version: offset by the range
 * the version was rendered from and kept inside it.
 */
export function toEditorTime(t, version) {
  const r = version?.range;
  const local = Math.max(0, Math.round(Number(t) || 0));
  if (!r) return Math.min(local, Math.max(0, Math.round(Number(version?.duration) || local)));
  return Math.min(r.out, r.in + local);
}

/** Review time for an editor time, or null when it falls outside the version. */
export function fromEditorTime(t, version) {
  const r = version?.range;
  const start = r ? r.in : 0;
  const end = r ? r.out : Number(version?.duration) || 0;
  if (t < start || t > end) return null;
  return Math.round(t - start);
}

/**
 * Marker layout for the timeline strip: each top-level comment becomes a
 * marker at its fraction of the duration (and a width for ranges). Markers
 * closer than minGap (a fraction) merge into one with a count.
 */
export function stripMarkers(comments, duration, { minGap = 0.012 } = {}) {
  if (!(duration > 0)) return [];
  const list = comments
    .filter((c) => c.t !== null && c.t !== undefined)
    .map((c) => ({ ids: [c.id], at: Math.min(1, c.t / duration), width: c.end ? Math.max(0, Math.min(1, c.end / duration) - Math.min(1, c.t / duration)) : 0, resolved: Boolean(c.resolved), t: c.t }))
    .sort((a, b) => a.at - b.at);
  const out = [];
  for (const m of list) {
    const prev = out[out.length - 1];
    if (prev && m.at - prev.at < minGap) {
      prev.ids.push(...m.ids);
      // Only a range widens the marker: points merged with it are within the gap, and two points stay a point.
      if (m.width) prev.width = Math.max(prev.width, m.at + m.width - prev.at);
      prev.resolved = prev.resolved && m.resolved;
    } else out.push({ ...m });
  }
  return out.map((m) => ({ ...m, count: m.ids.length }));
}

/** Seconds as a short spoken label for screen readers ("1 minute 4 seconds in"). */
export function spokenAt(t) {
  const s = Math.floor(Math.max(0, t) / US);
  const m = Math.floor(s / 60);
  const rest = s % 60;
  const parts = [];
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  parts.push(`${rest} second${rest === 1 ? '' : 's'}`);
  return parts.join(' ');
}
