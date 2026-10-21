/**
 * Cut a project down to a time range (and optionally a set of clips) so it
 * can be exported on its own: clips outside the range go and everything
 * moves so the range starts at 0. trimTo cuts single clips (compound and
 * multi-camera clips, highlights).
 */
import { clipEnd, MIN_CLIP, windowSource } from './timeline.js';
import { shiftKeyframes } from './keyframes.js';

/** Trim a clip copy to [start, end) of the timeline. Returns null if nothing is left. */
export function trimTo(clip, start, end) {
  const s = Math.max(clip.start, start);
  const e = Math.min(clipEnd(clip), end);
  if (e - s < MIN_CLIP / 2) return null;
  const head = s - clip.start;
  // Speed curves are sliced to the kept part (no-op for constant speed at the tail).
  if (head > 0 || e < clipEnd(clip)) windowSource(clip, head, e - clip.start);
  if (head > 0) {
    if (clip.keyframes) clip.keyframes = shiftKeyframes(clip.keyframes, -head, clip.duration - head);
    if (clip.fadeIn) clip.fadeIn = Math.max(0, clip.fadeIn - head);
    if (clip.animIn) clip.animIn = null;
  }
  // Cut at the end too: keep only the keys that still fall inside.
  if (clipEnd(clip) > e && clip.keyframes) clip.keyframes = shiftKeyframes(clip.keyframes, 0, e - s);
  clip.duration = e - s;
  clip.start = s;
  return clip;
}

/**
 * A copy of the project holding [start, end) shifted to 0. keep (a Set of
 * clip ids) limits it to those clips; effect, filter and color layer clips
 * are kept when they overlap a kept clip so the look matches.
 *
 * Clips that cross the range edges are kept whole (starting before 0 or
 * ending after the range), and project.end marks where the slice stops
 * (see projectDuration), so fades, animations and transitions cut by the
 * range look and sound exactly as on the timeline. The partner of a
 * transition that runs into the range is kept for the same reason.
 */
export function sliceProject(project, start, end, { keep = null } = {}) {
  const p = structuredClone(project);
  const lo = Math.max(0, Math.round(start));
  const hi = Math.max(lo + MIN_CLIP, Math.round(end));
  const kept = keep ? project.tracks.flatMap((t) => t.clips.filter((c) => keep.has(c.id))) : null;
  const overlapsKept = (c) => kept.some((k) => k.start < clipEnd(c) && clipEnd(k) > c.start);
  const inRange = (a, b) => a < hi && b > lo;
  for (const track of p.tracks) {
    const clips = track.clips;
    const wanted = clips.map((c) => inRange(c.start, clipEnd(c)));
    clips.forEach((a, i) => {
      const b = clips[i + 1];
      if (!a.transition || !b || Math.abs(b.start - clipEnd(a)) > 2000) return;
      const cut = clipEnd(a);
      const half = a.transition.duration / 2;
      if (inRange(cut - half, cut + half)) wanted[i] = wanted[i + 1] = true;
    });
    const out = [];
    clips.forEach((c, i) => {
      if (!wanted[i]) return;
      if (keep && !keep.has(c.id)) {
        const look = track.kind === 'effect' || track.kind === 'filter' || track.kind === 'adjust';
        if (!look || !overlapsKept(c)) return;
      }
      c.start -= lo;
      out.push(c);
    });
    // Transitions need their partner clip right after.
    out.forEach((c, i) => {
      if (!c.transition) return;
      const next = out[i + 1];
      if (!next || Math.abs(next.start - clipEnd(c)) > 2000) c.transition = null;
    });
    track.clips = out;
  }
  p.end = hi - lo;
  p.markers = (p.markers || []).filter((m) => m.time >= lo && m.time < hi).map((m) => ({ ...m, time: m.time - lo }));
  delete p.range;
  if (p.cover) p.cover = null;
  return p;
}

/**
 * Time span to export for a scope: 'all', 'range' (the in/out points) or
 * 'selection' (from the first to the last selected clip).
 */
export function exportSpan(project, scope, selectedIds = []) {
  const all = project.tracks.flatMap((t) => t.clips);
  const total = all.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  if (scope === 'range' && project.range) return { start: project.range.in, end: Math.min(project.range.out, total) };
  if (scope === 'selection') {
    const sel = all.filter((c) => selectedIds.includes(c.id));
    if (sel.length) return { start: Math.min(...sel.map((c) => c.start)), end: Math.max(...sel.map(clipEnd)) };
  }
  return { start: 0, end: total };
}
