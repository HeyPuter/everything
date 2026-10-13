/**
 * Compound clips: a selection nested into one clip that holds its own
 * tracks. It moves, trims, transforms and animates as one clip; "break
 * apart" puts the clips back on the timeline.
 */
import { uid } from '../lib/ids.js';
import { makeClip, DEFAULT_TRANSFORM } from './project.js';
import { findClip, clipEnd, addClip, mainTrack, sortTrack, sequenceLength, allClips } from './timeline.js';
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
 * Nest the given clips into a new compound clip placed where they were
 * (on the base track when any of them was there). Returns the compound.
 */
export function createCompound(project, ids, opts = {}) {
  const found = ids.map((id) => findClip(project, id)).filter((f) => f && !f.track.locked);
  if (!found.length) return null;
  const a = Math.min(...found.map((f) => f.clip.start));
  const b = Math.max(...found.map((f) => clipEnd(f.clip)));
  const chosen = new Set(found.map((f) => f.clip.id));
  const onMain = found.some((f) => f.track.main);
  const nested = [];
  for (const track of project.tracks) {
    const picked = track.clips.filter((c) => chosen.has(c.id));
    if (!picked.length) continue;
    nested.push({
      id: uid('t'),
      kind: track.kind,
      main: Boolean(track.main),
      locked: false,
      hidden: false,
      muted: false,
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
  const compound = makeClip('compound', { start: a, duration: b - a, name: `Compound clip ${nextNumber(project)}`, sequence: { tracks: nested } });
  addClip(project, compound, { ...opts, main: onMain });
  return compound;
}

/** Compose a parent's static transform onto a child's (both in frame fractions). */
export function composeTransform(parent, child, W, H) {
  const r = (parent.rotation * Math.PI) / 180;
  const X = child.x * W;
  const Y = child.y * H;
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
 * taken out of it (W x H is the frame size).
 */
export function inheritFromCompound(copy, c, W, H) {
  const plain = JSON.stringify(c.transform) === JSON.stringify(DEFAULT_TRANSFORM);
  if (copy.transform && !plain) copy.transform = composeTransform(c.transform, copy.transform, W, H);
  if ('opacity' in copy) copy.opacity *= c.opacity;
  if ('volume' in copy) copy.volume *= c.volume;
  if (c.muted && 'muted' in copy) copy.muted = true;
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
  const onMain = Boolean(f.track.main);
  f.track.clips.splice(f.track.clips.indexOf(c), 1);
  const restored = [];
  const W = project.settings.width;
  const H = project.settings.height;
  for (const t of [...c.sequence.tracks].reverse()) {
    for (const child of t.clips) {
      const copy = trimTo(structuredClone(child), c.in, c.in + c.duration);
      if (!copy) continue;
      copy.id = uid('c');
      copy.start = c.start + copy.start - c.in;
      inheritFromCompound(copy, c, W, H);
      const toMain = onMain && t.main && (copy.type === 'video' || copy.type === 'image');
      addClip(project, copy, { ...opts, main: toMain });
      restored.push(copy);
    }
  }
  for (const t of project.tracks) sortTrack(t);
  return restored;
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
