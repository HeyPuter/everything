// Pure arrangement logic for the playlist: clip sources and their natural
// lengths, placing, moving, duplicating, resizing, slicing, making clips
// unique, track insert/delete with clip shifting, markers and the clipboard
// format. No DOM: the panel calls these through store.apply / store.preview.
//
// Clip semantics (shared with the engine):
//   pattern clip  plays the notes whose pos is in [offset, offset + len) of
//                 its pattern, shifted to start at clip.start. A clip longer
//                 than the pattern does not repeat it: the rest is silent.
//   audio clip    plays its channel's sample from `offset` ticks in (at the
//                 project tempo) for `len` ticks.
//   auto clip     plays [offset, offset + len) of its automation's timeline
//                 starting at clip.start (automation/evaluate.js).

import * as E from '../model/edits.js';
import { createTrack, patternById, patternLength, patternColor, channelById, COLORS } from '../model/project.js';
import { secondsToTicks, ticksPerBar } from '../model/time.js';
import { tempoMap } from '../engine/compile.js';
import { automationLength } from '../automation/points.js';
import { resolveTarget } from '../automation/targets.js';
import { uid, clamp } from '../lib/util.js';

export const AUTO_COLOR = COLORS[11];
export const TRACK_HEIGHTS = { small: 32, medium: 56, large: 96 };
export const MIN_TRACK_H = 24;
export const MAX_TRACK_H = 240;

// ------------------------------------------------------------------ sources

/** A source is { kind: 'pattern' | 'audio' | 'auto', id } (pattern id, channel id, automation id). */
export function sourceOf(clip) {
  return { kind: clip.kind, id: clip.ref };
}

export function sourceExists(project, src) {
  if (!src) return false;
  if (src.kind === 'pattern') return Boolean(patternById(project, src.id));
  if (src.kind === 'audio') return project.channels.some((c) => c.id === src.id && c.type === 'audio');
  if (src.kind === 'auto') return Boolean(project.automation[src.id]);
  return false;
}

/** Audio duration in seconds of an audio channel's sample (project metadata, or `durations[sampleId]`). */
export function audioDuration(project, channelId, durations) {
  const ch = channelById(project, channelId);
  if (!ch?.sample) return 0;
  return durations?.[ch.sample] ?? project.samples[ch.sample]?.duration ?? 0;
}

/**
 * Length in ticks of `sec` seconds of audio placed at song tick `start`,
 * following tempo automation (the song's tempo map).
 */
export function audioTicks(project, sec, start = 0) {
  const map = tempoMap(project, 'song');
  if (map.constant) return Math.max(1, Math.round(secondsToTicks(sec, project.bpm)));
  return Math.max(1, Math.round(map.ticks(map.seconds(start) + sec) - start));
}

/**
 * Natural length in ticks of a source placed at `start`: the pattern length,
 * the audio duration (through the tempo map), or the automation's length.
 * One bar when unknown.
 */
export function sourceLength(project, src, durations, start = 0) {
  const bar = ticksPerBar(project.sig);
  if (!src) return bar;
  if (src.kind === 'pattern') {
    const p = patternById(project, src.id);
    return p ? patternLength(p, project.sig) : bar;
  }
  if (src.kind === 'audio') {
    const sec = audioDuration(project, src.id, durations);
    return sec > 0 ? audioTicks(project, sec, start) : bar;
  }
  if (src.kind === 'auto') return automationLength(project.automation[src.id], project.sig);
  return bar;
}

export function sourceName(project, src) {
  if (!src) return '';
  if (src.kind === 'pattern') return patternById(project, src.id)?.name || 'Missing pattern';
  if (src.kind === 'audio') return channelById(project, src.id)?.name || 'Missing audio';
  if (src.kind === 'auto') return project.automation[src.id]?.name || 'Missing automation';
  return '';
}

/** Data color a source is drawn with. */
export function sourceColor(project, src) {
  if (!src) return AUTO_COLOR;
  if (src.kind === 'pattern') {
    const p = patternById(project, src.id);
    return p ? patternColor(project, p) : AUTO_COLOR;
  }
  if (src.kind === 'audio') return channelById(project, src.id)?.color || AUTO_COLOR;
  const a = project.automation[src.id];
  return a?.color || resolveTarget(project, a?.target)?.color || AUTO_COLOR;
}

// ------------------------------------------------------------------ indexing

/** Clips grouped by track, each list sorted by start (for culling and hit tests). */
export function clipsByTrack(clips, trackCount = 0) {
  const out = [];
  for (let i = 0; i < trackCount; i++) out.push([]);
  for (const c of clips) {
    while (out.length <= c.track) out.push([]);
    out[c.track].push(c);
  }
  for (const list of out) list.sort((a, b) => a.start - b.start);
  return out;
}

/** The clip on `track` under `tick` (the last one in draw order wins), or null. */
export function clipAt(byTrack, track, tick) {
  const list = byTrack[track];
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c.start <= tick && tick < c.start + c.len) return c;
  }
  return null;
}

/** Ids of clips overlapping the tick range [t0, t1) on tracks track0..track1 (inclusive). */
export function clipsInRange(clips, t0, t1, track0, track1) {
  const a = Math.min(t0, t1);
  const b = Math.max(t0, t1);
  const lo = Math.min(track0, track1);
  const hi = Math.max(track0, track1);
  return clips.filter((c) => c.track >= lo && c.track <= hi && c.start < b && c.start + c.len > a).map((c) => c.id);
}

/** Clips in time order (then track order): the keyboard navigation order. */
export function timeOrder(clips) {
  return clips.slice().sort((a, b) => a.start - b.start || a.track - b.track);
}

/** First track with no clip overlapping [start, end). */
export function firstFreeTrack(project, start, end) {
  for (let t = 0; ; t++) {
    if (!project.clips.some((c) => c.track === t && c.start < end && c.start + c.len > start)) return t;
  }
}

// ------------------------------------------------------------------ edits

/** Places a clip of `src`; `len` defaults to the source's natural length. Returns { project, id }. */
export function placeClip(project, src, track, start, len, durations) {
  const r = E.addClips(project, [{ kind: src.kind, ref: src.id, track: Math.max(0, track), start: Math.max(0, Math.round(start)), len: Math.max(1, Math.round(len ?? sourceLength(project, src, durations, start))), offset: 0 }]);
  return { project: r.project, id: r.ids[0] };
}

/** Clip starts for the paint tool: copies of `len` from `anchor` toward `tick` (both directions). */
export function paintStarts(anchor, len, tick) {
  if (len <= 0) return [anchor];
  const out = [anchor];
  if (tick >= anchor) for (let s = anchor + len; s <= tick; s += len) out.push(s);
  else for (let s = anchor - len; s + len > tick && s >= 0; s -= len) out.push(s);
  return out;
}

/**
 * Moves clips by `dt` ticks and `dtrack` tracks (clamped so nothing goes
 * before tick 0 or above track 1). With `duplicate`, copies move and the
 * originals stay. Returns { project, ids } (the moved clips or the copies).
 */
export function moveClips(project, ids, dt, dtrack, { duplicate = false } = {}) {
  const set = new Set(ids);
  const sel = project.clips.filter((c) => set.has(c.id));
  if (!sel.length) return { project, ids: [] };
  const minStart = Math.min(...sel.map((c) => c.start));
  const minTrack = Math.min(...sel.map((c) => c.track));
  const d = Math.round(Math.max(dt, -minStart));
  const dk = Math.max(dtrack, -minTrack);
  if (duplicate) {
    const copies = sel.map((c) => ({ ...c, id: uid(), start: c.start + d, track: c.track + dk }));
    const r = E.addClips(project, copies);
    return { project: r.project, ids: r.ids };
  }
  if (!d && !dk) return { project, ids: sel.map((c) => c.id) };
  const changes = {};
  for (const c of sel) changes[c.id] = { start: c.start + d, track: c.track + dk };
  return { project: E.updateClips(project, changes), ids: sel.map((c) => c.id) };
}

/**
 * Resizes clips by `dt` ticks at the 'left' or 'right' edge. The left edge
 * trims the start and moves the offset along so the content stays in place.
 * Each clip keeps at least `minLen` ticks and a non-negative offset.
 */
export function resizeClips(project, ids, edge, dt, { minLen = 1 } = {}) {
  const set = new Set(ids);
  const changes = {};
  for (const c of project.clips) {
    if (!set.has(c.id)) continue;
    const min = Math.min(minLen, c.len);
    if (edge === 'right') {
      changes[c.id] = { len: Math.max(min, Math.round(c.len + dt)) };
    } else {
      const d = Math.round(clamp(dt, Math.max(-c.offset, -c.start), c.len - min));
      changes[c.id] = { start: c.start + d, len: c.len - d, offset: c.offset + d };
    }
  }
  return E.updateClips(project, changes);
}

/** Splits one clip at `tick`: [left, right] with offsets kept correct, or null when outside. */
export function splitClip(clip, tick) {
  const t = Math.round(tick);
  if (t <= clip.start || t >= clip.start + clip.len) return null;
  const left = { ...clip, len: t - clip.start };
  const right = { ...clip, id: uid(), start: t, len: clip.start + clip.len - t, offset: clip.offset + (t - clip.start) };
  return [left, right];
}

/**
 * Cuts clips at `tick`. `filter(clip)` limits which clips are cut (default:
 * all). Returns { project, ids } with the ids of the new right halves.
 */
export function sliceClips(project, tick, filter = () => true) {
  const ids = [];
  const clips = [];
  for (const c of project.clips) {
    const parts = filter(c) ? splitClip(c, tick) : null;
    if (parts) {
      clips.push(parts[0], parts[1]);
      ids.push(parts[1].id);
    } else clips.push(c);
  }
  return ids.length ? { project: { ...project, clips }, ids } : { project, ids };
}

/** Toggles mute on clips (all muted when any was audible, else all unmuted). */
export function toggleClipMute(project, ids, mute) {
  const set = new Set(ids);
  const sel = project.clips.filter((c) => set.has(c.id));
  if (!sel.length) return project;
  const to = mute ?? sel.some((c) => !c.mute);
  const changes = {};
  for (const c of sel) changes[c.id] = { mute: to };
  return E.updateClips(project, changes);
}

/**
 * Gives a clip its own copy of its source (pattern, automation, or audio
 * channel) so editing it leaves the other clips alone. Returns { project, id }
 * with the new source id (null when nothing changed).
 */
export function makeUnique(project, clipId) {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return { project, id: null };
  let r;
  if (clip.kind === 'pattern') r = E.clonePattern(project, clip.ref);
  else if (clip.kind === 'audio') r = E.cloneChannel(project, clip.ref);
  else if (clip.kind === 'auto') {
    const a = project.automation[clip.ref];
    if (!a) return { project, id: null };
    const { id: _old, ...rest } = structuredClone(a);
    r = E.addAutomation(project, { ...rest, name: `${a.name} #2` });
  }
  if (!r?.id) return { project, id: null };
  return { project: E.updateClips(r.project, { [clipId]: { ref: r.id } }), id: r.id };
}

/** Copies of clips, then `delta` ticks after the end of the selection (Duplicate). Returns { project, ids }. */
export function duplicateClips(project, ids) {
  const set = new Set(ids);
  const sel = project.clips.filter((c) => set.has(c.id));
  if (!sel.length) return { project, ids: [] };
  const a = Math.min(...sel.map((c) => c.start));
  const b = Math.max(...sel.map((c) => c.start + c.len));
  return moveClips(project, ids, b - a, 0, { duplicate: true });
}

// ------------------------------------------------------------------ clipboard

/** Clipboard snapshot: clips relative to the earliest start and the top track. */
export function copyClips(project, ids) {
  const set = new Set(ids);
  const sel = project.clips.filter((c) => set.has(c.id));
  if (!sel.length) return null;
  const t0 = Math.min(...sel.map((c) => c.start));
  const k0 = Math.min(...sel.map((c) => c.track));
  return { clips: sel.map((c) => ({ ...c, start: c.start - t0, track: c.track - k0 })) };
}

/** Pastes a clipboard snapshot at `start` on `track`; clips whose source is gone are skipped. Returns { project, ids }. */
export function pasteClips(project, board, start, track) {
  if (!board?.clips?.length) return { project, ids: [] };
  const list = board.clips
    .filter((c) => sourceExists(project, { kind: c.kind, id: c.ref }))
    .map((c) => ({ ...c, id: uid(), start: Math.max(0, Math.round(start)) + c.start, track: Math.max(0, track) + c.track }));
  if (!list.length) return { project, ids: [] };
  return E.addClips(project, list);
}

// ------------------------------------------------------------------ tracks

const DEFAULT_NAME = /^Track \d+$/;

// Default names follow the track number after inserts and deletes.
function renumber(tracks) {
  return tracks.map((t, i) => (DEFAULT_NAME.test(t.name) && t.name !== `Track ${i + 1}` ? { ...t, name: `Track ${i + 1}` } : t));
}

/** Inserts an empty track at `index`; clips on it and below move down one track. */
export function insertTrack(project, index) {
  const at = clamp(index, 0, project.tracks.length);
  const tracks = project.tracks.slice();
  tracks.splice(at, 0, createTrack(at));
  return {
    ...project,
    tracks: renumber(tracks),
    clips: project.clips.map((c) => (c.track >= at ? { ...c, track: c.track + 1 } : c)),
  };
}

/** Deletes track `index` with its clips; clips on later tracks move up one track. */
export function deleteTrack(project, index) {
  if (index < 0 || index >= project.tracks.length) return project;
  const tracks = project.tracks.filter((_, i) => i !== index);
  if (!tracks.length) tracks.push(createTrack(0));
  return {
    ...project,
    tracks: renumber(tracks),
    clips: project.clips.filter((c) => c.track !== index).map((c) => (c.track > index ? { ...c, track: c.track - 1 } : c)),
  };
}

/** Solo like the rack: solo this track alone, or clear solo when it already is. */
export function soloTrack(project, index) {
  const t = project.tracks[index];
  if (!t) return project;
  const alone = t.solo && project.tracks.every((x, i) => i === index || !x.solo);
  return { ...project, tracks: project.tracks.map((x, i) => {
    const solo = alone ? false : i === index;
    const mute = !alone && i === index ? false : x.mute;
    return x.solo === solo && x.mute === mute ? x : { ...x, solo, mute };
  }) };
}

/** Mutes every other track (or unmutes all when the others are already muted). */
export function muteOtherTracks(project, index) {
  if (!project.tracks[index]) return project;
  const othersMuted = project.tracks.every((x, i) => i === index || x.mute);
  return { ...project, tracks: project.tracks.map((x, i) => {
    const mute = othersMuted ? false : i !== index;
    return x.mute === mute ? x : { ...x, mute };
  }) };
}

/** Whether a track plays given the playlist's mute and solo states. */
export function trackAudible(project, index) {
  const t = project.tracks[index];
  if (!t) return true;
  if (t.mute) return false;
  return !project.tracks.some((x) => x.solo) || t.solo;
}

// ------------------------------------------------------------------ markers

/** Adds a marker; markers stay sorted by position. Returns { project, id }. */
export function addMarker(project, { pos, name }) {
  const m = { id: uid(), pos: Math.max(0, Math.round(pos)), name: name || 'Marker' };
  const markers = [...project.markers, m].sort((a, b) => a.pos - b.pos);
  return { project: { ...project, markers }, id: m.id };
}

export function updateMarker(project, id, changes) {
  const i = project.markers.findIndex((m) => m.id === id);
  if (i < 0) return project;
  const markers = project.markers.slice();
  markers[i] = { ...markers[i], ...changes };
  markers.sort((a, b) => a.pos - b.pos);
  return { ...project, markers };
}

export function removeMarker(project, id) {
  const markers = project.markers.filter((m) => m.id !== id);
  return markers.length === project.markers.length ? project : { ...project, markers };
}

/** Default name for a new marker: the lowest "Marker N" not in use. */
export function nextMarkerName(project) {
  const used = new Set(project.markers.map((m) => m.name));
  let i = 1;
  while (used.has(`Marker ${i}`)) i++;
  return `Marker ${i}`;
}

/**
 * The marker after (`dir` 1) or before (-1) song tick `pos`, or null. Before
 * looks past markers within `slack` ticks of `pos`, so pressing "previous"
 * while playing just after a marker goes to the one before it.
 */
export function adjacentMarker(markers, pos, dir, slack = 0) {
  if (dir > 0) return markers.find((m) => m.pos > pos) || null;
  for (let i = markers.length - 1; i >= 0; i--) if (markers[i].pos < pos - slack) return markers[i];
  return null;
}
