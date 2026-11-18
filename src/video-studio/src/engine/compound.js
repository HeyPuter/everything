/**
 * Rendering compound clips: before the scene is evaluated, every compound
 * clip is replaced by the clips it shows, placed on the outer timeline on
 * extra tracks at its position in the stack. Each of those remembers its
 * compound (`parent`) so the scene can apply the compound's transform,
 * opacity, animation and volume on top of its own.
 *
 * A multi-camera clip (model/multicam.js) shows each angle only where it
 * is the active one: its clips are cut into the pieces that show. The
 * angle the sound comes from stays one whole clip that is heard
 * throughout but drawn only inside its `show` ranges (timeline time), so
 * its sound plays on without a break at the cuts.
 */
import { trimTo } from '../model/slice.js';
import { clipEnd } from '../model/timeline.js';
import { activeRanges } from '../model/multicam.js';

const cache = new WeakMap(); // project -> { key, expanded }

const hasCompound = (tracks) => tracks.some((t) => t.clips.some((c) => c.type === 'compound'));

/** Cheap fingerprint of the parts of a project expansion depends on. */
function keyOf(project) {
  let k = `${project.modified}|${project.tracks.length}`;
  for (const t of project.tracks) for (const c of t.clips) if (c.type === 'compound') k += `|${c.id}:${c.start}:${c.duration}:${c.in}:${c.disabled ? 1 : 0}${c.multicam ? JSON.stringify(c.multicam) : ''}`;
  return k;
}

const copyOf = (c) => ({ ...c, keyframes: c.keyframes ? structuredClone(c.keyframes) : c.keyframes });

/**
 * What one clip of a camera angle contributes: v is the clip already placed
 * on the outer timeline, ranges the inner times where the angle shows.
 */
function anglePieces(v, comp, ranges, withSound) {
  const outer = ranges.map(([a, b]) => [comp.start + a - comp.in, comp.start + b - comp.in]);
  if (withSound) {
    v.show = outer;
    return [v];
  }
  const out = [];
  outer.forEach(([a, b], i) => {
    const piece = trimTo(copyOf(v), a, b);
    if (!piece) return;
    // Named after where the run starts so a piece keeps its id (and its media element) while later cuts change.
    piece.id = `${v.id}@${ranges[i][0]}`;
    if (clipEnd(piece) < clipEnd(v)) piece.transition = null;
    if (withSound === false) piece.muted = true;
    out.push(piece);
  });
  return out;
}

/** Virtual clips (and their tracks) a compound clip shows on the outer timeline. */
function expandOne(comp, outerTrack) {
  const tracks = [];
  const mc = comp.multicam;
  let angle = -1;
  for (const nt of comp.sequence.tracks) {
    const clips = [];
    if (mc && nt.angle) angle++;
    const ranges = mc && nt.angle ? activeRanges(mc, angle, comp.in, comp.in + comp.duration) : null;
    // true: this angle gives the sound; false: silent; null: follows the picture.
    const withSound = mc && nt.angle ? (mc.audio === 'follow' ? null : mc.audio === angle) : null;
    for (const child of nt.clips) {
      const v = trimTo(copyOf(child), comp.in, comp.in + comp.duration);
      if (!v) continue;
      v.start = comp.start + v.start - comp.in;
      v.id = `${comp.id}~${child.id}`;
      v.parent = comp;
      v.sourceId = child.id;
      if (comp.disabled) v.disabled = true;
      if (ranges) clips.push(...anglePieces(v, comp, ranges, withSound));
      else clips.push(v);
    }
    tracks.push({ id: `${outerTrack.id}~${nt.id}`, kind: nt.kind, main: false, locked: true, hidden: outerTrack.hidden || nt.hidden, muted: outerTrack.muted || nt.muted, solo: outerTrack.solo, clips, virtual: true });
  }
  return tracks;
}

function expandTracks(tracks) {
  const out = [];
  for (const t of tracks) {
    const comps = t.clips.filter((c) => c.type === 'compound');
    if (!comps.length) {
      out.push(t);
      continue;
    }
    // Share a virtual track only when its stack position, kind and visibility agree.
    // Neighboring compounds may have completely different inner track layouts.
    const merged = [];
    for (const comp of comps) {
      let inner = expandOne(comp, t);
      if (hasCompound(inner)) inner = expandTracks(inner);
      inner.forEach((vt, i) => {
        const key = `${vt.kind}:${Number(Boolean(vt.hidden))}${Number(Boolean(vt.muted))}${Number(Boolean(vt.solo))}`;
        const slot = (merged[i] ||= new Map());
        if (!slot.has(key)) slot.set(key, { ...vt, id: `${t.id}~${i}~${key}`, clips: [] });
        slot.get(key).clips.push(...vt.clips);
      });
    }
    const virtual = merged.flatMap((slot) => [...slot.values()]);
    for (const m of virtual) m.clips.sort((a, b) => a.start - b.start);
    out.push(...virtual, { ...t, clips: t.clips.filter((c) => c.type !== 'compound') });
  }
  return out;
}

/** The project with compound clips replaced by what they show (cached). */
export function expandProject(project) {
  if (!project?.tracks || !hasCompound(project.tracks)) return project;
  const key = keyOf(project);
  const hit = cache.get(project);
  if (hit && hit.key === key) return hit.expanded;
  const expanded = { ...project, tracks: expandTracks(project.tracks) };
  cache.set(project, { key, expanded });
  return expanded;
}

/** Outermost compound a virtual clip belongs to (or the clip itself). */
export function rootClip(clip) {
  let c = clip;
  while (c?.parent) c = c.parent;
  return c;
}
