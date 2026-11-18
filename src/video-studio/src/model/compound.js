/**
 * Compound clips: a selection nested into one clip that holds its own
 * tracks. It moves, trims, transforms and animates as one clip; "break
 * apart" puts the clips back on the timeline.
 */
import { uid } from '../lib/ids.js';
import { retainMotion } from './inherited-motion.js';
import { makeClip, makeTrack, DEFAULT_TRANSFORM, VISUAL_KINDS } from './project.js';
import { findClip, clipEnd, addClip, mainTrack, sortTrack, sequenceLength, allClips, cleanupTransitions, trackFree, pruneTracks, MIN_CLIP } from './timeline.js';
import { trimTo } from './slice.js';
import { storedTimelineTracks } from './timelines.js';

/** Number for the next "Compound clip N" name. */
function nextNumber(project) {
  let n = 0;
  const walk = (tracks) => {
    for (const t of tracks) for (const c of t.clips) {
      if (c.type !== 'compound') continue;
      const m = /^Compound clip (\d+)$/.exec(c.name || '');
      if (m) n = Math.max(n, Number(m[1]));
      walk(c.sequence.tracks);
    }
  };
  walk(project.tracks);
  return n + 1;
}

/**
 * True when the given base track clips have other base track clips between
 * them: nesting those would pull the clips in between out of place.
 */
export function skipsBaseClips(project, ids) {
  const main = mainTrack(project);
  const chosen = new Set(ids);
  const at = main ? main.clips.flatMap((c, i) => (chosen.has(c.id) ? [i] : [])) : [];
  return at.length > 1 && at.at(-1) - at[0] + 1 > at.length;
}

/**
 * Nest the given clips into a new compound clip placed where they were
 * (on the base track when it can preserve their playback controls). Returns the compound, or
 * null when there is nothing to nest or the base track clips are not next
 * to each other.
 */
export function createCompound(project, ids, opts = {}) {
  const found = ids.map((id) => findClip(project, id)).filter((f) => f && !f.track.locked);
  if (!found.length || skipsBaseClips(project, found.map((f) => f.clip.id))) return null;
  const a = Math.min(...found.map((f) => f.clip.start));
  const b = Math.max(...found.map((f) => clipEnd(f.clip)));
  const chosen = new Set(found.map((f) => f.clip.id));
  const onMain = found.some((f) => f.track.main);
  const nested = [];
  const sources = [];
  for (const track of project.tracks) {
    const picked = track.clips.filter((c) => chosen.has(c.id));
    if (!picked.length) continue;
    sources.push(track);
    nested.push({
      id: uid('t'),
      kind: track.kind,
      main: Boolean(track.main),
      locked: false,
      hidden: Boolean(track.hidden),
      muted: Boolean(track.muted),
      ...(track.solo ? { solo: true } : {}),
      clips: picked.map((c) => {
        const copy = structuredClone(c);
        copy.start = c.start - a;
        delete copy.group;
        return copy;
      }),
    });
    track.clips = track.clips.filter((c) => !chosen.has(c.id));
  }
  // The nested timeline gets a base track of its own.
  if (!nested.some((t) => t.main)) {
    const v = nested.find((t) => t.kind === 'video');
    if (v) v.main = true;
    else nested.push({ id: uid('t'), kind: 'video', main: true, locked: false, hidden: false, muted: false, clips: [] });
  }
  // A transition into a clip left outside has no partner in there.
  cleanupTransitions({ tracks: nested });
  const compound = makeClip('compound', { start: a, duration: b - a, name: `Compound clip ${nextNumber(project)}`, sequence: { tracks: nested } });
  const solo = sources.some(t => t.solo && (t.kind === 'audio' || t.kind === 'video'));
  const bottom = sources.findLast(t => VISUAL_KINDS.has(t.kind));
  const host = onMain ? mainTrack(project) : bottom?.kind === 'video' ? bottom : null;
  const acceptsControls = host && Boolean(host.solo) === solo
    && (!host.hidden || sources.every(t => !VISUAL_KINDS.has(t.kind) || t.hidden))
    && (!host.muted || sources.every(t => (t.kind !== 'audio' && t.kind !== 'video') || t.muted));
  if (acceptsControls && ((host.main && opts.ripple) || trackFree(host, a, b))) {
    addClip(project, compound, { ...opts, main: Boolean(host.main), trackId: host.id });
  } else {
    // A group cannot inherit a destination's mute/hide/solo when its source tracks
    // disagree. Keep the other tracks' controls and the original timing intact.
    const track = makeTrack('video', { ...(solo ? { solo: true } : {}), clips: [compound] });
    const at = project.tracks.indexOf(bottom || mainTrack(project));
    project.tracks.splice(Math.max(0, at), 0, track);
    pruneTracks(project);
  }
  return compound;
}

/** Compose a parent's static transform onto a child's (both in frame fractions). */
export function composeTransform(parent, child, W, H) {
  const r = (parent.rotation * Math.PI) / 180;
  const X = child.x * W * (parent.flipH ? -1 : 1);
  const Y = child.y * H * (parent.flipV ? -1 : 1);
  return {
    ...child,
    x: parent.x + ((X * Math.cos(r) - Y * Math.sin(r)) * parent.scale) / W,
    y: parent.y + ((X * Math.sin(r) + Y * Math.cos(r)) * parent.scale) / H,
    scale: child.scale * parent.scale,
    rotation: child.rotation + parent.rotation,
    flipH: child.flipH !== parent.flipH,
    flipV: child.flipV !== parent.flipV,
  };
}

/**
 * Fold a compound clip's transform, opacity, volume and mute into a clip
 * taken out of it (W x H is the frame size). Animated parents retain their
 * own clock and controls: baking endpoints cannot preserve easing, procedural
 * motion, or the order in which opacity is clamped.
 */
export function inheritFromCompound(copy, c, W, H) {
  const plain = JSON.stringify(c.transform) === JSON.stringify(DEFAULT_TRANSFORM);
  const animated = x => x.inherited?.length || x.animIn || x.animOut || x.animLoop || Object.values(x.keyframes || {}).some(keys => keys.length);
  const affects = !plain || c.opacity !== 1 || c.volume !== 1 || c.fadeIn || c.fadeOut || animated(c);
  const transform = copy.transform && !plain ? composeTransform(c.transform, copy.transform, W, H) : copy.transform;
  const outsideLimits = (transform && (transform.scale < 0.01 || transform.scale > 50)) || copy.volume * c.volume > 10;
  if (affects && ('transform' in copy || 'volume' in copy) && (animated(copy) || animated(c) || c.fadeIn || c.fadeOut || outsideLimits)) {
    retainMotion(copy, c);
  } else {
    if (copy.transform) copy.transform = transform;
    if ('opacity' in copy) copy.opacity *= c.opacity;
    if ('volume' in copy) copy.volume *= c.volume;
  }
  if ('blend' in copy && (!copy.blend || copy.blend === 'normal') && c.blend) copy.blend = c.blend;
  if (c.muted && 'muted' in copy) copy.muted = true;
  if (c.disabled) copy.disabled = true;
  return copy;
}

/**
 * Put a compound clip's contents back on the timeline where they play now,
 * trimmed to the part it showed. Returns the restored clips.
 */
export function breakApart(project, id, opts = {}) {
  const f = findClip(project, id);
  if (!f || f.clip.type !== 'compound' || f.track.locked) return [];
  const c = f.clip;
  f.track.clips.splice(f.track.clips.indexOf(c), 1);
  const restored = [];
  const W = project.settings.width;
  const H = project.settings.height;
  const groups = [];
  for (const t of c.sequence.tracks) {
    const copies = [];
    for (const child of t.clips) {
      const copy = trimTo(structuredClone(child), c.in, c.in + c.duration);
      // A sliver shorter than the shortest clip the editor allows (under a frame at 60 fps)
      // would be a clip too thin to see or select.
      if (!copy || copy.duration < MIN_CLIP) continue;
      copy.id = uid('c');
      copy.start = c.start + copy.start - c.in;
      inheritFromCompound(copy, c, W, H);
      copies.push(copy);
    }
    groups.push({ track: t, clips: copies, main: Boolean(t.main) });
    restored.push(...copies);
  }
  restoreCompoundTracks(project, c, f.track, groups);
  return restored;
}

/** Restore placed clips at a compound's stack position with its track controls. */
export function restoreCompoundTracks(project, compound, outer, groups) {
  const solo = compound.sequence.tracks.some(t => t.solo && (t.kind === 'audio' || t.kind === 'video'));
  let insertAt = project.tracks.indexOf(outer);
  for (const { track: t, clips: copies, main = false } of groups) {
    if (!copies.length) continue;
    const hidden = Boolean(outer.hidden || t.hidden);
    const muted = Boolean(outer.muted || t.muted || (solo && !t.solo));
    const compatible = hidden === Boolean(outer.hidden) && muted === Boolean(outer.muted) && !t.locked;
    const original = main && t.kind === outer.kind && compatible;
    if (original) {
      // Reuse the original slot only when its controls match. A separate track keeps
      // an inner hide/mute editable without altering other clips or their keyframes.
      for (const copy of copies) outer.clips.push(copy);
      insertAt = Math.max(insertAt, project.tracks.indexOf(outer) + 1);
    } else {
      // Restore each inner track at the compound's stack position. Choosing any free
      // track can put a title above unrelated footage or give it different controls.
      const track = makeTrack(t.kind, {
        hidden, muted, solo: Boolean(outer.solo), locked: Boolean(t.locked), clips: copies,
        ...(t.name ? { name: t.name } : {}), ...(t.size ? { size: t.size } : {}),
      });
      project.tracks.splice(insertAt++, 0, track);
    }
  }
  for (const t of project.tracks) sortTrack(t);
}

/** Every clip in the project, including the ones inside compound clips and on the other timelines. */
export function allClipsDeep(project) {
  const out = [];
  const walk = (tracks) => {
    for (const t of tracks) for (const c of t.clips) {
      out.push(c);
      if (c.type === 'compound') walk(c.sequence.tracks);
    }
  };
  walk(project.tracks);
  for (const tracks of storedTimelineTracks(project)) walk(tracks);
  return out;
}

/** Remove every clip (deep, on every timeline) that uses one of the given assets. */
export function removeAssetClips(project, assetIds) {
  const ids = new Set(assetIds);
  const strip = (tracks) => {
    for (const t of tracks) {
      t.clips = t.clips.filter((c) => !ids.has(c.assetId));
      for (const c of t.clips) if (c.type === 'compound') strip(c.sequence.tracks);
    }
  };
  strip(project.tracks);
  for (const tracks of storedTimelineTracks(project)) strip(tracks);
}

/** Every compound clip in the project, including nested ones. */
export function compoundClips(project) {
  const out = [];
  const walk = (tracks) => {
    for (const t of tracks) for (const c of t.clips) if (c.type === 'compound') {
      out.push(c);
      walk(c.sequence.tracks);
    }
  };
  walk(project.tracks);
  return out;
}

export { sequenceLength, mainTrack, allClips };
