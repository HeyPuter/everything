/**
 * Timeline editing operations. They mutate the project passed in (the store
 * snapshots it for undo before calling) and never touch the DOM, so they are
 * covered directly by unit tests.
 *
 * Track order in project.tracks is visual order, top to bottom:
 *   effect / filter / adjust tracks, text tracks, overlay video tracks,
 *   the main video track, audio tracks.
 */
import { uid } from '../lib/ids.js';
import { US } from '../lib/time.js';
import { TRACK_KIND_FOR, makeTrack } from './project.js';
import { splitKeyframes, shiftKeyframes, scaleKeyframes } from './keyframes.js';
import { beatTimes } from './audio.js';
import { hasCurve, sourceOffset, sourceSpan, sliceCurve, meanSpeed, edgeSpeeds, localAtSource, normalizeCurve, remapKeyframes, curveTable, curveDuration } from './speed-curve.js';
import { findRamp, rampPoints, addRampAccents, stripRampAccents } from './speed-ramps.js';

/** Shortest clip the editor allows, one frame at 60 fps rounded up. */
export const MIN_CLIP = 16_667;

export const clipEnd = (c) => c.start + c.duration;
export const isMedia = (c) => c.type === 'video' || c.type === 'audio' || c.type === 'image';
export const isTimed = (c) => c.type === 'video' || c.type === 'audio';

export function mainTrack(project) {
  return project.tracks.find((t) => t.main);
}

export function findClip(project, id) {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

export function findTrack(project, id) {
  return project.tracks.find((t) => t.id === id) || null;
}

export function allClips(project) {
  const out = [];
  for (const t of project.tracks) for (const c of t.clips) out.push(c);
  return out;
}

/** End of the last clip in a nested sequence. */
export function sequenceLength(seq) {
  let end = 0;
  for (const t of seq?.tracks || []) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  return end;
}

export function projectDuration(project) {
  let end = 0;
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

/** Longest duration the clip can have given its source media and speed. */
export function maxDuration(project, clip) {
  if (clip.type === 'compound') return Math.max(MIN_CLIP, sequenceLength(clip.sequence) - clip.in);
  if (!isTimed(clip) || clip.freeze) return Infinity;
  const asset = project.assets[clip.assetId];
  if (!asset || !asset.duration) return Infinity;
  if (hasCurve(clip)) {
    // Past its end a curved clip continues at its end speed.
    const rest = asset.duration - clip.in - sourceSpan(clip);
    return Math.max(MIN_CLIP, Math.floor(clip.duration + rest / edgeSpeeds(clip)[1]));
  }
  return Math.max(MIN_CLIP, Math.floor((asset.duration - clip.in) / clip.speed));
}

/**
 * Source time (microseconds into the asset) shown at timeline time t. The
 * one mapping every path uses (preview, export, audio, thumbnails): constant
 * speed or a speed curve (model/speed-curve.js).
 */
export function sourceTimeAt(clip, t) {
  if (clip.freeze) return clip.in;
  const local = Math.min(Math.max(0, t - clip.start), clip.duration);
  return clip.in + sourceOffset(clip, local);
}

/**
 * Re-time a timed clip so it shows only what its local span [from, to)
 * showed before (from < 0 or to > duration extend it at the edge speed).
 * Moves the in point and, for a curved clip, slices the curve so the kept
 * part plays exactly the same source times. The caller sets start,
 * duration and keyframes afterwards.
 */
export function windowSource(clip, from, to) {
  if (clip.type === 'compound') {
    // A nested timeline always plays at its own pace.
    clip.in = Math.max(0, Math.round(clip.in + from));
    return;
  }
  if (!isTimed(clip) || clip.freeze) return;
  if (!hasCurve(clip)) {
    clip.in = Math.max(0, Math.round(clip.in + from * (clip.speed || 1)));
    return;
  }
  const D = clip.duration;
  const pts = sliceCurve(clip.speedCurve, from / D, to / D);
  const inPoint = from >= 0 ? clip.in + sourceOffset(clip, from) : clip.in - (to - from) * curveTable(pts).integral(-from / (to - from));
  clip.in = Math.max(0, Math.round(inPoint));
  clip.speedCurve = pts;
  clip.speed = meanSpeed(pts);
}

export function sortTrack(track) {
  track.clips.sort((a, b) => a.start - b.start);
}

export function trackFree(track, start, end, excludeIds = new Set()) {
  for (const c of track.clips) {
    if (excludeIds.has(c.id)) continue;
    if (c.start < end - 1 && clipEnd(c) > start + 1) return false;
  }
  return true;
}

export function trackAccepts(track, clip) {
  return TRACK_KIND_FOR[clip.type] === track.kind;
}

/** Index where a new track of this kind goes (see the order note above). */
function newTrackIndex(project, kind) {
  const tracks = project.tracks;
  if (kind === 'audio') return tracks.length;
  if (kind === 'effect' || kind === 'filter' || kind === 'adjust') return 0;
  const sameKind = tracks.findIndex((t) => t.kind === kind);
  if (sameKind >= 0) return sameKind;
  if (kind === 'text') {
    const firstVideo = tracks.findIndex((t) => t.kind === 'video');
    return firstVideo >= 0 ? firstVideo : 0;
  }
  const main = tracks.findIndex((t) => t.main);
  return main >= 0 ? main : 0;
}

export function addTrack(project, kind, index = newTrackIndex(project, kind)) {
  const track = makeTrack(kind);
  project.tracks.splice(Math.max(0, Math.min(index, project.tracks.length)), 0, track);
  return track;
}

/**
 * First track of the right kind with room for [start, end), searching
 * outward from the base track, or a new track.
 */
export function trackWithRoom(project, kind, start, end, excludeIds) {
  const candidates = project.tracks.filter((t) => t.kind === kind && !t.main && !t.locked);
  // Overlay tracks closest to the base track first, so stacking stays tidy.
  const ordered = kind === 'audio' ? candidates : [...candidates].reverse();
  for (const t of ordered) if (trackFree(t, start, end, excludeIds)) return t;
  return addTrack(project, kind);
}

/** Remove empty tracks except the base track (the editor does this after each edit). */
export function pruneTracks(project) {
  project.tracks = project.tracks.filter((t) => t.main || t.clips.length > 0);
}

/** Lay base-track clips end to end from time 0 (base track ripple). */
export function compactMain(project) {
  const main = mainTrack(project);
  if (!main) return;
  // Array order is the clip order; callers keep it sorted before editing.
  let t = 0;
  for (const c of main.clips) {
    c.start = t;
    t += c.duration;
  }
}

/**
 * Overlay linking: remember which base-track clip each overlay clip sits on so it can
 * follow that clip after a ripple. Returns a function that applies the shift.
 */
export function captureLinks(project) {
  const main = mainTrack(project);
  if (!main) return () => {};
  const before = new Map(main.clips.map((c) => [c.id, c.start]));
  const links = [];
  for (const t of project.tracks) {
    if (t.main || t.locked) continue;
    for (const c of t.clips) {
      const host = main.clips.find((m) => c.start >= m.start && c.start < clipEnd(m));
      // Audio only follows when it sits inside its host clip, so a music bed
      // under several clips stays put while sound effects move with the shot.
      if (host && (t.kind !== 'audio' || clipEnd(c) <= clipEnd(host) + 1000)) links.push({ clip: c, host: host.id, track: t });
    }
  }
  return () => {
    const after = new Map(main.clips.map((c) => [c.id, c.start]));
    for (const { clip, host, track } of links) {
      // A clip the edit moved to another track (e.g. dropped onto the base track) no longer follows.
      if (!after.has(host) || !track.clips.includes(clip)) continue;
      const dt = after.get(host) - before.get(host);
      if (!dt) continue;
      clip.start = Math.max(0, clip.start + dt);
      sortTrack(track);
    }
    resolveOverlaps(project);
  };
}

/** Move clips that ended up overlapping on a non-base track onto other tracks. */
export function resolveOverlaps(project) {
  for (const track of [...project.tracks]) {
    if (track.main) continue;
    sortTrack(track);
    for (let i = 1; i < track.clips.length; i++) {
      const prev = track.clips[i - 1];
      const c = track.clips[i];
      if (c.start < clipEnd(prev) - 1) {
        track.clips.splice(i, 1);
        i--;
        const dest = trackWithRoom(project, track.kind, c.start, clipEnd(c), new Set([c.id]));
        dest.clips.push(c);
        sortTrack(dest);
      }
    }
  }
}

/** Runs fn with base-track ripple and overlay linking handled according to opts. */
function withRipple(project, opts, fn) {
  const relink = opts.ripple && opts.linkOverlays ? captureLinks(project) : null;
  const result = fn();
  if (opts.ripple) compactMain(project);
  relink?.();
  pruneTracks(project);
  return result;
}

/** Base-track index where a clip dropped at time t is inserted (nearest boundary). */
export function mainInsertIndex(project, t, excludeId) {
  const clips = mainTrack(project).clips.filter((c) => c.id !== excludeId);
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (t < c.start + c.duration / 2) return i;
  }
  return clips.length;
}

/**
 * Add a clip to the timeline.
 *  opts.trackId  put it on this track (when it has room and accepts the type)
 *  opts.main     insert into the base track (video/image only)
 *  opts.ripple   base track ripple on
 */
export function addClip(project, clip, opts = {}) {
  return withRipple(project, opts, () => {
    const kind = TRACK_KIND_FOR[clip.type];
    const main = mainTrack(project);
    if (opts.main && kind === 'video' && main && !main.locked) {
      if (opts.ripple) {
        const index = mainInsertIndex(project, clip.start);
        sortTrack(main);
        main.clips.splice(index, 0, clip);
        // compactMain runs in withRipple and assigns the start.
        return { track: main, clip };
      }
      if (trackFree(main, clip.start, clipEnd(clip))) {
        main.clips.push(clip);
        sortTrack(main);
        return { track: main, clip };
      }
    }
    let track = opts.trackId ? findTrack(project, opts.trackId) : null;
    if (track && (!trackAccepts(track, clip) || track.locked || (track.main && opts.ripple) || !trackFree(track, clip.start, clipEnd(clip)))) track = null;
    if (!track) track = trackWithRoom(project, kind, clip.start, clipEnd(clip));
    track.clips.push(clip);
    sortTrack(track);
    return { track, clip };
  });
}

/**
 * Move one clip (and optionally others by the same offset).
 *  target: { start, trackId?, newTrackAt? }  newTrackAt inserts a fresh track at that index.
 */
export function moveClip(project, id, target, opts = {}) {
  const found = findClip(project, id);
  if (!found || found.track.locked) return false;
  const { clip, track: from } = found;
  const dt = target.start - clip.start;
  const others = (opts.with || []).filter((x) => x !== id).map((x) => findClip(project, x)).filter((f) => f && !f.track.locked);
  return withRipple(project, opts, () => {
    from.clips.splice(from.clips.indexOf(clip), 1);
    let dest = target.trackId ? findTrack(project, target.trackId) : from;
    if (target.newTrackAt !== undefined) dest = addTrack(project, TRACK_KIND_FOR[clip.type], target.newTrackAt);
    if (!dest || !trackAccepts(dest, clip) || dest.locked) dest = from;
    clip.start = Math.max(0, Math.round(target.start));
    // Grouped clips move first so they never block the primary clip.
    const moving = new Set([id, ...others.map((o) => o.clip.id)]);
    for (const o of others) {
      o.clip.start = Math.max(0, o.clip.start + dt);
      sortTrack(o.track);
    }
    if (dest.main && opts.ripple) {
      const index = mainInsertIndex(project, clip.start, clip.id);
      sortTrack(dest);
      dest.clips.splice(index, 0, clip);
    } else if (trackFree(dest, clip.start, clipEnd(clip), moving)) {
      dest.clips.push(clip);
      sortTrack(dest);
    } else if (dest.main) {
      // No room on the base track without ripple: put it back.
      clip.start -= dt;
      from.clips.push(clip);
      sortTrack(from);
      for (const o of others) o.clip.start -= dt;
      return false;
    } else {
      const alt = trackWithRoom(project, dest.kind, clip.start, clipEnd(clip), moving);
      alt.clips.push(clip);
      sortTrack(alt);
    }
    resolveOverlaps(project);
    return true;
  });
}

/** Earliest/latest the given edge can go, honoring source length and neighbors. */
export function trimBounds(project, id, edge, { ripple } = {}) {
  const { clip, track } = findClip(project, id);
  sortTrack(track);
  const i = track.clips.indexOf(clip);
  const prev = track.clips[i - 1];
  const next = track.clips[i + 1];
  const rippling = ripple && track.main;
  if (edge === 'start') {
    let lo = rippling ? -Infinity : prev ? clipEnd(prev) : 0;
    if (isTimed(clip) && !clip.freeze) lo = Math.max(lo, clip.start - Math.floor(clip.in / edgeSpeeds(clip)[0]));
    else if (clip.type === 'compound') lo = Math.max(lo, clip.start - clip.in);
    else if (rippling) lo = clip.start - 3600 * US;
    return { lo, hi: clipEnd(clip) - MIN_CLIP };
  }
  let hi = next && !rippling ? next.start : Infinity;
  hi = Math.min(hi, clip.start + maxDuration(project, clip));
  return { lo: clip.start + MIN_CLIP, hi };
}

/** Drag a clip's left or right edge to timeline time t. */
export function trimClip(project, id, edge, t, opts = {}) {
  const found = findClip(project, id);
  if (!found || found.track.locked) return false;
  const { clip } = found;
  const { lo, hi } = trimBounds(project, id, edge, opts);
  const at = Math.round(Math.min(hi, Math.max(lo, t)));
  const ok = withRipple(project, opts, () => {
    if (edge === 'start') {
      const delta = at - clip.start;
      windowSource(clip, delta, clip.duration);
      if (clip.keyframes) clip.keyframes = shiftKeyframes(clip.keyframes, -delta, clip.duration - delta);
      clip.duration -= delta;
      // With ripple the base track closes the gap itself, keeping the clip's slot.
      clip.start = at;
    } else {
      windowSource(clip, 0, at - clip.start);
      clip.duration = at - clip.start;
      if (clip.keyframes) clip.keyframes = shiftKeyframes(clip.keyframes, 0, clip.duration);
    }
    return true;
  });
  // After the ripple, which may close the gap the trim opened.
  clampTransition(project, clip);
  return ok;
}

/** Split one clip at timeline time t. Returns the new right-hand clip or null. */
export function splitClip(project, id, t) {
  const found = findClip(project, id);
  if (!found || found.track.locked) return null;
  const { clip, track } = found;
  const local = Math.round(t - clip.start);
  if (local < MIN_CLIP || clip.duration - local < MIN_CLIP) return null;
  const right = structuredClone(clip);
  right.id = uid('c');
  windowSource(right, local, clip.duration);
  right.start = clip.start + local;
  right.duration = clip.duration - local;
  windowSource(clip, 0, local);
  clip.duration = local;
  if (clip.keyframes) [clip.keyframes, right.keyframes] = splitKeyframes(clip.keyframes, local);
  // Fades and animations stay on the outer ends; transitions on the right piece.
  if ('fadeOut' in clip) {
    right.fadeIn = 0;
    clip.fadeOut = 0;
  }
  if ('animIn' in clip) {
    right.animIn = null;
    clip.animOut = null;
    if (clip.animLoop) right.animLoop = null;
  }
  if ('transition' in clip) clip.transition = null;
  track.clips.splice(track.clips.indexOf(clip) + 1, 0, right);
  return right;
}

/**
 * Split at the playhead. Splits the given clips that cross t; with none
 * given, every unlocked clip under the playhead.
 */
export function splitAt(project, t, ids) {
  const targets = [];
  for (const track of project.tracks) {
    if (track.locked) continue;
    for (const c of track.clips) {
      if (ids && ids.length && !ids.includes(c.id)) continue;
      if (c.start < t && clipEnd(c) > t) targets.push(c.id);
    }
  }
  return targets.map((id) => splitClip(project, id, t)).filter(Boolean);
}

export function deleteClips(project, ids, opts = {}) {
  const set = new Set(ids);
  return withRipple(project, opts, () => {
    let removed = 0;
    for (const t of project.tracks) {
      if (t.locked) continue;
      const before = t.clips.length;
      t.clips = t.clips.filter((c) => !set.has(c.id));
      removed += before - t.clips.length;
    }
    return removed;
  });
}

/**
 * Delete left / right of the playhead (Q / W): trims the given clips (or the
 * base-track clip under the playhead) so the part before or after t goes away.
 */
export function trimToPlayhead(project, t, side, ids, opts = {}) {
  let targets = ids && ids.length ? ids : [];
  if (!targets.length) {
    const main = mainTrack(project);
    const under = main?.clips.find((c) => c.start < t && clipEnd(c) > t);
    if (under) targets = [under.id];
  }
  let changed = 0;
  withRipple(project, opts, () => {
    for (const id of targets) {
      const f = findClip(project, id);
      if (!f || f.track.locked) continue;
      const { clip } = f;
      if (!(clip.start < t && clipEnd(clip) > t)) continue;
      if (side === 'left') {
        const delta = Math.round(t - clip.start);
        if (clip.duration - delta < MIN_CLIP) continue;
        windowSource(clip, delta, clip.duration);
        if (clip.keyframes) clip.keyframes = shiftKeyframes(clip.keyframes, -delta, clip.duration - delta);
        clip.duration -= delta;
        clip.start = t;
      } else {
        const d = Math.round(t - clip.start);
        if (d < MIN_CLIP) continue;
        windowSource(clip, 0, d);
        clip.duration = d;
        if (clip.keyframes) clip.keyframes = shiftKeyframes(clip.keyframes, 0, d);
      }
      changed++;
    }
  });
  return changed;
}

/** Copy of a clip with a fresh id, placed after the original on the same track or a free track. */
export function duplicateClip(project, id, opts = {}) {
  const found = findClip(project, id);
  if (!found) return null;
  const copy = structuredClone(found.clip);
  copy.id = uid('c');
  copy.start = clipEnd(found.clip);
  delete copy.group;
  if (found.track.main) {
    return addClip(project, copy, { ...opts, main: true }).clip;
  }
  return addClip(project, copy, { trackId: found.track.id, ...opts }).clip;
}

/** Paste clipboard clips so the earliest starts at time t, keeping their relative layout. */
export function pasteClips(project, clips, t, opts = {}) {
  if (!clips.length) return [];
  const first = Math.min(...clips.map((c) => c.start));
  const pasted = [];
  const copies = regroup(clips.filter((src) => !src.assetId || project.assets[src.assetId]).map((src) => ({ src, ...structuredClone(src) })));
  for (const copy of copies) {
    const { src, ...c } = copy;
    c.id = uid('c');
    c.start = Math.max(0, t + (src.start - first));
    const isMainVideo = src._main && (c.type === 'video' || c.type === 'image');
    pasted.push(addClip(project, c, { ...opts, main: isMainVideo }).clip);
  }
  return pasted;
}

export function setSpeed(project, id, speed, opts = {}) {
  const found = findClip(project, id);
  if (!found || !isTimed(found.clip) || found.track.locked) return false;
  const { clip, track } = found;
  const s = Math.min(100, Math.max(0.1, speed));
  const curved = hasCurve(clip);
  const span = curved ? sourceSpan(clip) : clip.duration * clip.speed;
  const duration = fitDuration(track, clip, Math.max(MIN_CLIP, Math.round(span / s)), opts);
  const before = { ...clip };
  // Constant speed replaces a velocity ramp, accents included.
  if (clip.speedRamp) stripRampAccents(clip);
  withRipple(project, opts, () => {
    // A curved clip's keys follow the footage; constant speed just scales them.
    if (clip.keyframes) clip.keyframes = curved ? remapKeyframes(clip.keyframes, (t) => sourceOffset(before, t) / s, duration) : scaleKeyframes(clip.keyframes, duration / clip.duration);
    delete clip.speedCurve;
    clip.speed = s;
    clip.duration = duration;
  });
  clampTransition(project, clip);
  return true;
}

/** Without the ripple a faster/slower clip must still fit before its neighbor. */
function fitDuration(track, clip, duration, opts) {
  if (opts.ripple && track.main) return duration;
  sortTrack(track);
  const next = track.clips[track.clips.indexOf(clip) + 1];
  return next ? Math.min(duration, next.start - clip.start) : duration;
}

/**
 * Give a timed clip a speed curve (points, see model/speed-curve.js), or
 * back to constant 1x with null. The clip keeps the footage it plays, so
 * its timeline length changes (limited by the next clip without ripple).
 * opts.span overrides the source length to keep (a drag keeps the one it
 * started with so rounding never accumulates). Keyframes stay on the same
 * moments of the footage. opts.dropRamp takes away a velocity ramp marker
 * and its accents (a different preset replaces the ramp).
 */
export function setSpeedCurve(project, id, points, opts = {}) {
  const found = findClip(project, id);
  if (!found || !isTimed(found.clip) || found.clip.freeze || found.track.locked) return false;
  if (!points) return hasCurve(found.clip) ? setSpeed(project, id, 1, opts) : false;
  const pts = normalizeCurve(points);
  if (!pts) return false;
  const { clip, track } = found;
  // A different curve preset replaces a velocity ramp; edits keep it (shown as edited).
  if (opts.dropRamp && clip.speedRamp) stripRampAccents(clip);
  const span = opts.span ?? sourceSpan(clip);
  const duration = fitDuration(track, clip, Math.max(MIN_CLIP, Math.round(curveDuration(pts, span))), opts);
  const before = { ...clip };
  withRipple(project, opts, () => {
    clip.speedCurve = pts;
    clip.speed = meanSpeed(pts);
    clip.duration = duration;
    if (clip.keyframes) clip.keyframes = remapKeyframes(clip.keyframes, (t) => localAtSource(clip, sourceOffset(before, t)), duration);
  });
  clampTransition(project, clip);
  return true;
}

/**
 * Give a timed clip a velocity ramp (model/speed-ramps.js): its speed curve
 * plus, with opts.accent (default on), the ramp's accents. Replaces an
 * earlier ramp and its accents; null takes the ramp away (constant 1x).
 */
export function applySpeedRamp(project, id, rampId, opts = {}) {
  const found = findClip(project, id);
  if (!found || !isTimed(found.clip) || found.clip.freeze || found.track.locked) return false;
  const { clip } = found;
  if (rampId === null) {
    if (!clip.speedRamp && !hasCurve(clip)) return false;
    stripRampAccents(clip);
    if (hasCurve(clip)) setSpeedCurve(project, id, null, opts);
    return true;
  }
  const ramp = findRamp(rampId);
  if (!ramp) return false;
  stripRampAccents(clip);
  if (!setSpeedCurve(project, id, rampPoints(rampId), opts)) return false;
  const accent = opts.accent !== false;
  clip.speedRamp = { id: rampId, accent };
  if (accent) addRampAccents(clip, ramp);
  return true;
}

/** Turn a ramped clip's accent on or off, keeping its curve (tweaked or not). */
export function setRampAccent(project, id, on) {
  const found = findClip(project, id);
  const ramp = findRamp(found?.clip.speedRamp?.id);
  if (!ramp || found.track.locked) return false;
  const { clip } = found;
  if ((clip.speedRamp.accent !== false) === on) return false;
  stripRampAccents(clip);
  clip.speedRamp = { id: ramp.id, accent: on };
  if (on) addRampAccents(clip, ramp);
  return true;
}

/** Freeze the frame at t: split there and insert a still of that frame. */
export function freezeFrame(project, id, t, length = 3 * US, opts = {}) {
  const found = findClip(project, id);
  if (!found || found.clip.type !== 'video' || found.track.locked) return null;
  const { clip, track } = found;
  if (t <= clip.start || t >= clipEnd(clip)) return null;
  const sourceT = sourceTimeAt(clip, t);
  const right = splitClip(project, id, t);
  // Within a frame of an edge there is nothing to split: the still goes at that edge.
  const at = right ? t : t - clip.start < clip.duration / 2 ? clip.start : clipEnd(clip);
  const still = structuredClone(clip);
  Object.assign(still, { id: uid('c'), start: at, duration: length, in: sourceT, freeze: true, speed: 1, keyframes: {}, fadeIn: 0, fadeOut: 0, animIn: null, animOut: null, animLoop: null, transition: null, muted: true });
  delete still.speedCurve;
  return withRipple(project, opts, () => {
    if (track.main && opts.ripple) {
      const i = track.clips.indexOf(clip);
      track.clips.splice(at === clip.start ? i : i + 1, 0, still);
    } else {
      // Push everything after the cut on this track to make room.
      for (const c of track.clips) if (c.start >= at) c.start += length;
      track.clips.push(still);
      sortTrack(track);
    }
    return still;
  });
}

/**
 * An audio clip playing a video clip's sound over the same span (not yet
 * on a track), or null when the video has no sound to give.
 */
export function soundCopy(project, clip) {
  const asset = project.assets[clip.assetId];
  if (clip.type !== 'video' || !asset?.hasAudio || clip.audioDetached || clip.freeze) return null;
  return {
    id: uid('c'),
    type: 'audio',
    name: clip.name || asset.name,
    start: clip.start,
    duration: clip.duration,
    assetId: clip.assetId,
    in: clip.in,
    speed: clip.speed,
    ...(hasCurve(clip) ? { speedCurve: structuredClone(clip.speedCurve) } : {}),
    volume: clip.volume,
    muted: Boolean(clip.muted),
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
    keyframes: clip.keyframes?.volume ? { volume: structuredClone(clip.keyframes.volume) } : {},
    // Sound settings travel with the sound.
    ...(clip.audioFx ? { audioFx: structuredClone(clip.audioFx) } : {}),
    ...(clip.keepPitch === false ? { keepPitch: false } : {}),
  };
}

/** Put a video clip's sound on its own audio clip and mute the original. */
export function detachAudio(project, id) {
  const found = findClip(project, id);
  if (!found || found.clip.type !== 'video') return null;
  const { clip } = found;
  const audio = soundCopy(project, { ...clip, freeze: false });
  if (!audio) return null;
  audio.muted = false;
  const track = trackWithRoom(project, 'audio', audio.start, clipEnd(audio));
  track.clips.push(audio);
  sortTrack(track);
  clip.audioDetached = true;
  clip.muted = true;
  return audio;
}

/** The clip right after this one on its track when they touch (a transition slot). */
export function nextAdjacent(project, id) {
  const found = findClip(project, id);
  if (!found) return null;
  const { clip, track } = found;
  sortTrack(track);
  const next = track.clips[track.clips.indexOf(clip) + 1];
  if (next && Math.abs(next.start - clipEnd(clip)) <= 2000) return next;
  return null;
}

/** Longest transition allowed between a clip and its neighbor. */
export function maxTransition(project, clip) {
  const next = nextAdjacent(project, clip.id);
  if (!next) return 0;
  return Math.max(0, Math.min(clip.duration, next.duration, 5 * US));
}

function clampTransition(project, clip) {
  if (!clip.transition) return;
  const max = maxTransition(project, clip);
  if (max < 100_000) clip.transition = null;
  else clip.transition.duration = Math.min(clip.transition.duration, max);
}

export function setTransition(project, id, transitionId, duration = 500_000) {
  const found = findClip(project, id);
  if (!found || (found.clip.type !== 'video' && found.clip.type !== 'image')) return false;
  if (!transitionId) {
    found.clip.transition = null;
    return true;
  }
  const max = maxTransition(project, found.clip);
  if (max < 100_000) return false;
  found.clip.transition = { id: transitionId, duration: Math.min(duration, max) };
  return true;
}

/** Drop transitions whose clips no longer touch (after moves or deletes). */
export function cleanupTransitions(project) {
  for (const t of project.tracks) for (const c of t.clips) if (c.transition) clampTransition(project, c);
}

/**
 * Snap candidates: project start, playhead, clip edges (except excluded),
 * detected beats and markers.
 */
export function snapPoints(project, { exclude = new Set(), playhead = null, beats = true } = {}) {
  const pts = new Set([0]);
  if (playhead !== null) pts.add(Math.round(playhead));
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (exclude.has(c.id)) continue;
      pts.add(c.start);
      pts.add(clipEnd(c));
      if (beats && c.beats) for (const b of beatTimes(c)) pts.add(b);
    }
  }
  for (const m of project.markers || []) pts.add(m.time);
  return [...pts].sort((a, b) => a - b);
}

/** Nearest snap point within threshold, as { time, snapped }. */
export function snap(t, points, threshold) {
  let best = null;
  let bestD = threshold;
  // Binary search for the insertion point, then look at neighbors.
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  for (const i of [lo - 1, lo]) {
    const p = points[i];
    if (p === undefined) continue;
    const d = Math.abs(p - t);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best === null ? { time: t, snapped: false } : { time: best, snapped: true };
}

/** Snap a moving range [start, start+duration) by whichever edge is closer to a point. */
export function snapRange(start, duration, points, threshold) {
  const a = snap(start, points, threshold);
  const b = snap(start + duration, points, threshold);
  if (a.snapped && (!b.snapped || Math.abs(a.time - start) <= Math.abs(b.time - start - duration))) return { start: a.time, snapped: true, at: a.time };
  if (b.snapped) return { start: b.time - duration, snapped: true, at: b.time };
  return { start, snapped: false, at: null };
}

/** Clip under time t on a track. */
export function clipAt(track, t) {
  return track.clips.find((c) => c.start <= t && clipEnd(c) > t) || null;
}

/** Previous/next edit point (clip edges on any track) from t, for Up/Down navigation. */
export function editPoint(project, t, dir) {
  const pts = snapPoints(project, { beats: false });
  if (dir > 0) return pts.find((p) => p > t + 1) ?? t;
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i] < t - 1) return pts[i];
  return 0;
}

/** Display name for a clip (used by the timeline and screen reader labels). */
export function clipLabel(project, clip) {
  if (clip.name) return clip.name;
  if (clip.type === 'text') return clip.text.split('\n')[0].slice(0, 60) || 'Text';
  if (clip.assetId) return project.assets[clip.assetId]?.name || 'Media';
  return clip.type[0].toUpperCase() + clip.type.slice(1);
}

// ---- Clip state: enable/disable, groups, labels ---------------------------

/** Turn clips off (they stay on the timeline but are not drawn or heard) or back on. */
export function setDisabled(project, ids, disabled) {
  let n = 0;
  for (const id of ids) {
    const f = findClip(project, id);
    if (!f || f.track.locked) continue;
    if (disabled) f.clip.disabled = true;
    else delete f.clip.disabled;
    n++;
  }
  return n;
}

/** Ids of every clip in the same group as id (just [id] when it has none). */
export function groupMembers(project, id) {
  const f = findClip(project, id);
  if (!f) return [];
  const g = f.clip.group;
  if (!g) return [id];
  return allClips(project).filter((c) => c.group === g).map((c) => c.id);
}

/** Expand a selection so whole groups are included. */
export function expandGroups(project, ids) {
  const out = new Set();
  for (const id of ids) for (const m of groupMembers(project, id)) out.add(m);
  return [...out];
}

/** Put two or more clips in one group. Returns the group id or null. */
export function groupClips(project, ids) {
  const clips = expandGroups(project, ids).map((id) => findClip(project, id)).filter(Boolean);
  if (clips.length < 2) return null;
  const g = uid('g');
  for (const { clip } of clips) clip.group = g;
  return g;
}

/** Remove the selected clips' groups (every member of those groups is released). */
export function ungroupClips(project, ids) {
  const groups = new Set();
  for (const id of ids) {
    const g = findClip(project, id)?.clip.group;
    if (g) groups.add(g);
  }
  if (!groups.size) return 0;
  let n = 0;
  for (const c of allClips(project)) {
    if (c.group && groups.has(c.group)) {
      delete c.group;
      n++;
    }
  }
  return n;
}

/**
 * Give copied clips fresh group ids (so a duplicated group is a new group)
 * and drop groups left with a single member.
 */
export function regroup(clips) {
  const map = new Map();
  const counts = new Map();
  for (const c of clips) {
    if (!c.group) continue;
    if (!map.has(c.group)) map.set(c.group, uid('g'));
    c.group = map.get(c.group);
    counts.set(c.group, (counts.get(c.group) || 0) + 1);
  }
  for (const c of clips) if (c.group && counts.get(c.group) < 2) delete c.group;
  return clips;
}

/** Set or clear (label = null) the color label of clips. */
export function setClipLabel(project, ids, label) {
  let n = 0;
  for (const id of ids) {
    const f = findClip(project, id);
    if (!f) continue;
    if (label) f.clip.label = label;
    else delete f.clip.label;
    n++;
  }
  return n;
}

// ---- Selection helpers ------------------------------------------------------

/**
 * Clips on unlocked tracks entirely or partly on one side of time t:
 * side 'right' = clips that end after t, 'left' = clips that start before t.
 * Restricted to one track when trackId is given.
 */
export function clipsOnSide(project, t, side, { trackId = null } = {}) {
  const out = [];
  for (const track of project.tracks) {
    if (track.locked || (trackId && track.id !== trackId)) continue;
    for (const c of track.clips) {
      if (side === 'right' ? clipEnd(c) > t : c.start < t) out.push(c.id);
    }
  }
  return out;
}

/** Clips that start at or after the given clip on its own track (or every track). */
export function clipsFrom(project, id, { allTracks = false, backward = false } = {}) {
  const f = findClip(project, id);
  if (!f) return [];
  const t = f.clip.start;
  const out = [];
  for (const track of project.tracks) {
    if (track.locked || (!allTracks && track !== f.track)) continue;
    for (const c of track.clips) {
      if (backward ? clipEnd(c) <= clipEnd(f.clip) : c.start >= t) out.push(c.id);
    }
  }
  return out;
}

// ---- In / out range -------------------------------------------------------

/** Set the in point (keeps the out point when it is still after it). */
export function setRangeIn(project, t) {
  const out = project.range?.out ?? null;
  project.range = out !== null && out > t ? { in: Math.max(0, Math.round(t)), out } : { in: Math.max(0, Math.round(t)), out: Math.max(Math.round(t) + MIN_CLIP, projectDuration(project)) };
  return project.range;
}

export function setRangeOut(project, t) {
  const i = project.range?.in ?? 0;
  const out = Math.round(t);
  if (out <= i) project.range = { in: 0, out: Math.max(MIN_CLIP, out) };
  else project.range = { in: i, out };
  return project.range;
}

export function clearRange(project) {
  const had = Boolean(project.range);
  delete project.range;
  return had;
}

/** Make the range span the given clips. */
export function rangeFromClips(project, ids) {
  const clips = ids.map((id) => findClip(project, id)?.clip).filter(Boolean);
  if (!clips.length) return null;
  project.range = { in: Math.min(...clips.map((c) => c.start)), out: Math.max(...clips.map(clipEnd)) };
  return project.range;
}

// ---- Markers ----------------------------------------------------------------

export function findMarker(project, id) {
  return project.markers.find((m) => m.id === id) || null;
}

export function updateMarker(project, id, patch) {
  const m = findMarker(project, id);
  if (!m) return false;
  if (patch.time !== undefined) m.time = Math.max(0, Math.round(patch.time));
  if (patch.color !== undefined) m.color = patch.color;
  if (patch.label !== undefined) m.label = String(patch.label).slice(0, 200);
  if (patch.note !== undefined) {
    if (patch.note) m.note = String(patch.note).slice(0, 2000);
    else delete m.note;
  }
  project.markers.sort((a, b) => a.time - b.time);
  return true;
}

/** Next (dir 1) or previous (dir -1) marker time from t, or null. */
export function adjacentMarker(project, t, dir) {
  const list = project.markers || [];
  if (dir > 0) return list.find((m) => m.time > t + 1) || null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].time < t - 1) return list[i];
  return null;
}

// ---- Tracks -----------------------------------------------------------------

export function renameTrack(project, id, name) {
  const t = findTrack(project, id);
  if (!t) return false;
  const n = String(name || '').trim().slice(0, 60);
  if (n) t.name = n;
  else delete t.name;
  return true;
}

/** Delete a track and its clips (the base track is only emptied). */
export function deleteTrack(project, id) {
  const t = findTrack(project, id);
  if (!t) return false;
  if (t.main) {
    if (!t.clips.length) return false;
    t.clips = [];
    return true;
  }
  project.tracks.splice(project.tracks.indexOf(t), 1);
  return true;
}

/**
 * Move a track one step up (dir -1) or down (dir 1) past a neighbor of the
 * same kind. Overlay video tracks stay above the base track.
 */
export function moveTrack(project, id, dir) {
  const tracks = project.tracks;
  const i = tracks.findIndex((t) => t.id === id);
  if (i < 0 || tracks[i].main) return false;
  const j = i + dir;
  const other = tracks[j];
  if (!other || other.main || other.kind !== tracks[i].kind) return false;
  [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  return true;
}

/** Toggle solo; when any track is soloed only soloed tracks are heard. */
export function toggleSolo(project, id) {
  const t = findTrack(project, id);
  if (!t || (t.kind !== 'audio' && t.kind !== 'video')) return false;
  if (t.solo) delete t.solo;
  else t.solo = true;
  return true;
}

export function setTrackSize(project, id, size) {
  const t = findTrack(project, id);
  if (!t) return false;
  if (!size || size === 'medium') delete t.size;
  else t.size = size;
  return true;
}

/** Add an empty track of a kind next to another (above it by default). */
export function insertTrackNear(project, id, kind, below = false) {
  const i = project.tracks.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const ref = project.tracks[i];
  // A video track can't go below the base track.
  let at = below ? i + 1 : i;
  if (kind === 'video' && ref.main) at = i;
  return addTrack(project, kind, at);
}

// ---- Keyframes on clips ---------------------------------------------------

/** Move every key at local time `from` (within tol) to `to`, across props. */
export function moveKeyTime(clip, from, to, tol = 0) {
  const t = Math.min(clip.duration, Math.max(0, Math.round(to)));
  let moved = 0;
  for (const keys of Object.values(clip.keyframes || {})) {
    const k = keys.find((x) => Math.abs(x.t - from) <= tol);
    if (!k) continue;
    // A key already at the destination is replaced.
    const clash = keys.findIndex((x) => x !== k && Math.abs(x.t - t) <= tol);
    if (clash >= 0) keys.splice(clash, 1);
    k.t = t;
    keys.sort((a, b) => a.t - b.t);
    moved++;
  }
  return moved;
}

/** Set the easing of every key at local time t (within tol). */
export function setKeyEaseAt(clip, t, easeName, tol = 0) {
  let n = 0;
  for (const keys of Object.values(clip.keyframes || {})) {
    for (const k of keys) {
      if (Math.abs(k.t - t) <= tol) {
        k.ease = easeName;
        n++;
      }
    }
  }
  return n;
}

/** Remove every key at local time t (within tol). */
export function removeKeysAt(clip, t, tol = 0) {
  let n = 0;
  for (const [prop, keys] of Object.entries(clip.keyframes || {})) {
    const left = keys.filter((k) => Math.abs(k.t - t) > tol);
    n += keys.length - left.length;
    if (left.length) clip.keyframes[prop] = left;
    else delete clip.keyframes[prop];
  }
  return n;
}

/** Easing name shared by the keys at t, 'mixed', or null when there are none. */
export function keyEaseAt(clip, t, tol = 0) {
  let found = null;
  for (const keys of Object.values(clip.keyframes || {})) {
    for (const k of keys) {
      if (Math.abs(k.t - t) > tol) continue;
      if (found && found !== k.ease) return 'mixed';
      found = k.ease || 'linear';
    }
  }
  return found;
}

// ---- Removing a span of time ----------------------------------------------

/**
 * Remove [a, b) from every unlocked track: clips crossing an edge are split,
 * the pieces inside go, and (with close = true) everything after b moves left
 * by b - a so the gap closes. Markers, the in/out range and the transcript
 * follow. Returns the number of clips removed or shortened.
 */
export function removeRange(project, a, b, { close = true } = {}) {
  const lo = Math.max(0, Math.round(Math.min(a, b)));
  const hi = Math.round(Math.max(a, b));
  const span = hi - lo;
  if (span < 1000) return 0;
  let changed = 0;
  for (const track of project.tracks) {
    if (track.locked) continue;
    sortTrack(track);
    for (const c of [...track.clips]) {
      if (c.start < lo && clipEnd(c) > lo && clipEnd(c) - lo >= MIN_CLIP && lo - c.start >= MIN_CLIP) splitClip(project, c.id, lo);
    }
    for (const c of [...track.clips]) {
      if (c.start < hi && clipEnd(c) > hi && clipEnd(c) - hi >= MIN_CLIP && hi - c.start >= MIN_CLIP) splitClip(project, c.id, hi);
    }
    const before = track.clips.length;
    track.clips = track.clips.filter((c) => !(c.start >= lo - 1 && clipEnd(c) <= hi + 1));
    changed += before - track.clips.length;
    if (close) {
      for (const c of track.clips) if (c.start >= hi - 1) c.start = Math.max(0, c.start - span);
    }
    sortTrack(track);
  }
  if (close) {
    project.markers = (project.markers || []).filter((m) => m.time < lo || m.time >= hi).map((m) => (m.time >= hi ? { ...m, time: m.time - span } : m));
    if (project.range) {
      const shift = (t) => (t >= hi ? t - span : t > lo ? lo : t);
      const r = { in: shift(project.range.in), out: shift(project.range.out) };
      if (r.out - r.in >= MIN_CLIP) project.range = r;
      else delete project.range;
    }
    if (project.transcript?.words) {
      project.transcript.words = project.transcript.words
        .filter((w) => w.end <= lo || w.start >= hi)
        .map((w) => (w.start >= hi ? { ...w, start: w.start - span, end: w.end - span } : w));
    }
  }
  return changed;
}
