/**
 * Making and flattening multi-camera clips (see multicam.js for the model).
 */
import { uid } from '../lib/ids.js';
import { makeClip } from './project.js';
import { findClip, clipEnd, addClip, clipLabel, soundCopy } from './timeline.js';
import { trimTo } from './slice.js';
import { inheritFromCompound, restoreCompoundTracks } from './compound.js';
import { MIN_ANGLES, MAX_ANGLES, isMulticam, activeRanges } from './multicam.js';

/** Number for the next "Multi-camera clip N" name. */
function nextNumber(project) {
  let n = 0;
  const walk = (tracks) => {
    for (const t of tracks) for (const c of t.clips) {
      if (c.type !== 'compound') continue;
      const m = /^Multi-camera clip (\d+)$/.exec(c.name || '');
      if (m) n = Math.max(n, Number(m[1]));
      walk(c.sequence.tracks);
    }
  };
  walk(project.tracks);
  return n + 1;
}

/** Order for angles: the base track's clip first, then outward from it, then by time. */
function angleOrder(project, found) {
  const mainAt = project.tracks.findIndex((t) => t.main);
  const dist = (f) => Math.abs(project.tracks.indexOf(f.track) - mainAt);
  return [...found].sort((a, b) => dist(a) - dist(b) || a.clip.start - b.clip.start);
}

/**
 * Nest 2 to 9 video clips as the angles of a new multi-camera clip.
 * starts maps clip id -> timeline start that lines it up with the others
 * (from syncing by sound); clips not in it keep their current start. The
 * new clip covers every angle and sits where the earliest one starts.
 * Returns the clip, or null when the selection does not qualify.
 */
export function createMulticam(project, ids, { starts = {}, ...opts } = {}) {
  const found = angleOrder(project, ids.map((id) => findClip(project, id)).filter((f) => f && f.clip.type === 'video' && !f.track.locked));
  if (found.length < MIN_ANGLES || found.length > MAX_ANGLES) return null;
  const pos = found.map((f) => Math.round(starts[f.clip.id] ?? f.clip.start));
  const a = Math.min(...pos);
  const b = Math.max(...found.map((f, i) => pos[i] + f.clip.duration));
  const onMain = found.some((f) => f.track.main);
  const chosen = new Set(found.map((f) => f.clip.id));
  for (const t of project.tracks) t.clips = t.clips.filter((c) => !chosen.has(c.id));
  const tracks = found.map((f, i) => {
    const copy = structuredClone(f.clip);
    copy.start = pos[i] - a;
    delete copy.group;
    return { id: uid('t'), kind: 'video', main: i === 0, locked: false, hidden: false, muted: false, angle: true, name: clipLabel(project, f.clip).slice(0, 60), clips: [copy] };
  });
  const clip = makeClip('compound', {
    start: Math.max(0, a),
    duration: b - a,
    name: `Multi-camera clip ${nextNumber(project)}`,
    sequence: { tracks },
    multicam: { cuts: [{ t: 0, angle: 0 }], audio: 0 },
  });
  addClip(project, clip, { ...opts, main: onMain });
  return clip;
}

/**
 * Turn a multi-camera clip into ordinary clips: the part of each angle
 * that shows, in its place on the clip's track, plus the sound (a muted
 * picture with the chosen angle's sound on an audio clip, or each piece
 * with its own sound when the sound follows the picture). Clips on other
 * tracks inside it (titles, music) come out as they are. Returns the new
 * clips.
 */
export function flattenMulticam(project, id) {
  const f = findClip(project, id);
  if (!f || !isMulticam(f.clip) || f.track.locked) return [];
  const c = f.clip;
  const mc = c.multicam;
  const W = project.settings.width;
  const H = project.settings.height;
  const lo = c.in;
  const hi = c.in + c.duration;
  const place = (copy) => {
    copy.id = uid('c');
    copy.start = c.start + copy.start - c.in;
    delete copy.group;
    inheritFromCompound(copy, c, W, H);
    return copy;
  };
  const pictures = [];
  const extras = [];
  const groups = [];
  const tracks = c.sequence.tracks;
  const firstAngle = tracks.findIndex(t => t.angle);
  const lastAngle = tracks.findLastIndex(t => t.angle);
  // Consecutive camera tracks can share the original slot: only one picture shows
  // at a time. An intervening title or look layer needs their separate stack slots.
  const mergePictures = !tracks.slice(firstAngle, lastAngle + 1).some(t => !t.angle && t.kind !== 'audio' && t.clips.length);
  let angle = -1;
  for (const t of c.sequence.tracks) {
    if (!t.angle) {
      const clips = [];
      for (const child of t.clips) {
        const copy = trimTo(structuredClone(child), lo, hi);
        if (copy) { place(copy); clips.push(copy); extras.push(copy); }
      }
      groups.push({ track: t, clips });
      continue;
    }
    angle++;
    const clips = [];
    const sounds = [];
    for (const child of t.clips) {
      for (const [a, b] of activeRanges(mc, angle, lo, hi)) {
        const copy = trimTo(structuredClone(child), a, b);
        if (!copy) continue;
        if (b < clipEnd(child)) copy.transition = null;
        if (mc.audio !== 'follow') copy.muted = true;
        place(copy); clips.push(copy); pictures.push(copy);
      }
      if (mc.audio === angle) {
        const whole = trimTo(structuredClone(child), lo, hi);
        const sound = whole && soundCopy(project, whole);
        if (sound) { place(sound); sounds.push(sound); extras.push(sound); }
      }
    }
    groups.push({ track: t, clips, main: mergePictures || t === tracks[firstAngle] });
    groups.push({ track: { ...t, kind: 'audio' }, clips: sounds });
  }
  f.track.clips.splice(f.track.clips.indexOf(c), 1);
  restoreCompoundTracks(project, c, f.track, groups);
  return [...pictures, ...extras];
}
