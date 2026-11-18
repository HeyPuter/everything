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
 * its sound plays on without a break at the cuts. Scheduled pieces retain
 * `renderSource` when clipped so animation and gain use the original clock.
 * Virtual track transitions retain both partners and an explicit visible window.
 */
import { trimTo } from '../model/slice.js';
import { clipEnd } from '../model/timeline.js';
import { activeRanges } from '../model/multicam.js';
import { projectRevision } from '../model/revision.js';

const cache = new WeakMap(); // project -> { key, expanded }

const hasCompound = (tracks) => tracks.some((t) => t.clips.some((c) => c.type === 'compound'));

/** Cheap fingerprint of the parts of a project expansion depends on. */
function keyOf(project) {
  let k = `${projectRevision(project)}|${project.modified}|${project.tracks.length}`;
  for (const t of project.tracks) for (const c of t.clips) if (c.type === 'compound') k += `|${c.id}:${c.start}:${c.duration}:${c.in}:${c.disabled ? 1 : 0}${c.multicam ? JSON.stringify(c.multicam) : ''}`;
  return k;
}

const copyOf = c => ({ ...c, keyframes: c.keyframes ? structuredClone(c.keyframes) : c.keyframes });

/** The visible/scheduled piece keeps its original content clock for rendering and gain. */
function windowPiece(source, start, end, id = source.id) {
  if (source.start >= end || clipEnd(source) <= start) return null;
  if (source.start >= start && clipEnd(source) <= end) return { ...source, id };
  const piece = trimTo(copyOf(source), start, end);
  if (!piece) return null;
  piece.id = id;
  piece.renderSource = source.id === id ? source : { ...source, id };
  return piece;
}

/** Virtual clips (and their tracks) a compound clip shows on the outer timeline. */
function expandOne(window, outerTrack) {
  const comp = window.renderSource || window;
  const lo = comp.in + window.start - comp.start;
  const hi = lo + window.duration;
  const offset = comp.start - comp.in;
  const tracks = [];
  const mc = comp.multicam;
  const solo = comp.sequence.tracks.some(t => t.solo && (t.kind === 'audio' || t.kind === 'video'));
  let angle = -1;
  for (const nt of comp.sequence.tracks) {
    const clips = [], transitions = [];
    if (mc && nt.angle) angle++;
    const ranges = mc && nt.angle ? activeRanges(mc, angle, lo, hi) : [[lo, hi]];
    const withSound = mc && nt.angle ? (mc.audio === 'follow' ? null : mc.audio === angle) : null;
    const source = child => ({ ...child, start: child.start + offset, id: `${comp.id}~${child.id}`, parent: comp, sourceId: child.id, disabled: child.disabled || comp.disabled });
    const originals = nt.clips.map(source);
    const pictureId = (v, a) => mc && nt.angle && !withSound ? `${v.id}@${a}` : v.id;
    for (const v of originals) {
      if (withSound) {
        const piece = windowPiece(v, lo + offset, hi + offset);
        if (piece) { piece.show = ranges.map(([a, b]) => [a + offset, b + offset]); clips.push(piece); }
      } else for (const [a, b] of ranges) {
        const piece = windowPiece(v, a + offset, b + offset, pictureId(v, a));
        if (piece) {
          if (withSound === false) piece.muted = true;
          clips.push(piece);
        }
      }
    }
    // Transition partners keep their full source clocks even if the visible window
    // contains only one side of the cut. Each window explicitly bounds the picture.
    for (let i = 0; i < originals.length - 1; i++) {
      const a = originals[i], b = originals[i + 1];
      if (!a.transition || Math.abs(b.start - clipEnd(a)) > 2000) continue;
      const cut = clipEnd(a), half = a.transition.duration / 2;
      for (const [from, to] of ranges) {
        const start = Math.max(from + offset, cut - half);
        const end = Math.min(to + offset, cut + half);
        if (start >= end) continue;
        const fromClip = { ...a, id: pictureId(a, from) };
        const toClip = { ...b, id: pictureId(b, from) };
        if (withSound === false) { fromClip.muted = true; toClip.muted = true; }
        transitions.push({ from: fromClip, to: toClip, cut, start, end });
      }
    }
    tracks.push({ id: `${outerTrack.id}~${nt.id}`, kind: nt.kind, main: false, locked: true, hidden: outerTrack.hidden || nt.hidden, muted: outerTrack.muted || nt.muted || (solo && !nt.solo), solo: outerTrack.solo, clips, transitions, virtual: true });
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
        if (!slot.has(key)) slot.set(key, { ...vt, id: `${t.id}~${i}~${key}`, clips: [], transitions: [] });
        slot.get(key).clips.push(...vt.clips);
        slot.get(key).transitions.push(...(vt.transitions || []));
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
