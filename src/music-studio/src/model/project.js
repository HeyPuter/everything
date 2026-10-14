// Project model. A project is a plain JSON-able object treated as immutable:
// edits (model/edits.js) return a new project that shares every unchanged
// part with the old one, so undo keeps references, never copies, and views
// can skip work by comparing references.
//
// project = {
//   version, name, bpm, sig: [num, den], swing (0..1), masterPitch (cents),
//   channels: Channel[],            // the channel rack, in display order
//   patterns: Pattern[],            // in pattern-number order
//   tracks: Track[],                // playlist tracks (index = track number - 1)
//   clips: Clip[],                  // playlist clips
//   automation: { [id]: Automation },
//   mixer: MixerTrack[],            // index 0 is the master, then inserts 1..n
//   samples: { [id]: SampleRef },   // audio used by sampler and audio channels
//   loop: null | { start, end },    // playlist loop region in ticks
//   markers: Marker[],              // playlist time markers
// }
//
// Channel = { id, name, color, type ('synth'|'drum'|'sampler'|'audio'),
//   params: {id: value}, sample: sampleId|null, volume (0..1.25 linear),
//   pan (-1..1), pitch (cents), mixer (insert index), mute, solo, root (key
//   the step sequencer writes) }
// Pattern = { id, name, color|null, notes: { [channelId]: Note[] }, length: ticks|null }
// Note = { id, key (MIDI 0..127), pos (ticks), len (ticks), vel (0..1), pan (-1..1) }
// Track = { id, name, color|null, mute, solo, height (px, view only) }
// Clip = { id, kind ('pattern'|'audio'|'auto'), track (index), start, len,
//   offset (ticks into the source), ref (pattern id, channel id or automation id), mute }
//   A clip plays the window [offset, offset + len) of its source starting at
//   `start`. Pattern clips play the notes whose pos is in that window and do
//   not repeat the pattern when the clip is longer (see playlist/clips.js).
// Automation = { id, name, target, points: [{ t, v (0..1) }], color?, tension? }
//   t is in ticks of the automation's own timeline; a clip at song tick s
//   reads it at s - clip.start + clip.offset (automation/evaluate.js).
//   target = { kind: 'channel', id, param } | { kind: 'mixer', track, param: 'volume'|'pan' }
//          | { kind: 'fx', track, slot, param } | { kind: 'tempo' }
// MixerTrack = { id, name, color|null, volume (0..1.25), pan, width (0..2),
//   mute, solo, fx: Slot[], routes: { [trackIndex]: gain } (inserts default to {0: 1}) }
// Slot = { id, type (effects/catalog.js), on, mix (0..1), params }
// SampleRef = { id, name, path|null (Puter file), local: key|null (IndexedDB), duration, rate, channels }

import { uid } from '../lib/util.js';
import { defaultParams } from '../instruments/catalog.js';
import { defaultEffectParams } from '../effects/catalog.js';
import { PPQ } from './time.js';

export const PROJECT_VERSION = 1;
export const FILE_EXT = '.msproj';
export const MAX_FX_SLOTS = 10;
export const DEFAULT_INSERTS = 16;
export const DEFAULT_TRACKS = 16;
export const DEFAULT_KEY = 60;

/** Original palette for channels, patterns, tracks and mixer inserts. */
export const COLORS = [
  '#e0675a', '#e8925a', '#e3b84f', '#a7c957', '#5cbf8a', '#4fb8b1',
  '#53a4dc', '#6f86e0', '#9474dc', '#c26fd0', '#d96b9e', '#8d9aa6',
];

export function colorAt(i) {
  return COLORS[((i % COLORS.length) + COLORS.length) % COLORS.length];
}

export function createChannel({ type = 'synth', name, color, params, sample = null, mixer = 0, root = DEFAULT_KEY } = {}) {
  return {
    id: uid(),
    name: name || (type === 'drum' ? 'Drum' : type === 'sampler' ? 'Sampler' : type === 'audio' ? 'Audio' : 'Synth'),
    color: color || COLORS[6],
    type,
    params: { ...defaultParams(type), ...(params || {}) },
    sample,
    volume: 0.78,
    pan: 0,
    pitch: 0,
    mixer,
    mute: false,
    solo: false,
    root,
  };
}

export function createPattern(index = 0, name) {
  return { id: uid(), name: name || `Pattern ${index + 1}`, color: null, notes: {}, length: null };
}

export function createNote({ key = DEFAULT_KEY, pos = 0, len = PPQ / 4, vel = 0.78, pan = 0 } = {}) {
  return { id: uid(6), key, pos, len, vel, pan };
}

export function createTrack(index) {
  return { id: uid(), name: `Track ${index + 1}`, color: null, mute: false, solo: false, height: 56 };
}

export function createMixerTrack(index) {
  return {
    id: uid(),
    name: index === 0 ? 'Master' : `Insert ${index}`,
    color: null,
    volume: index === 0 ? 0.8 : 0.8,
    pan: 0,
    width: 1,
    mute: false,
    solo: false,
    fx: [],
    routes: index === 0 ? {} : { 0: 1 },
  };
}

export function createSlot(type) {
  return { id: uid(), type, on: true, mix: 1, params: defaultEffectParams(type) };
}

export function createClip({ kind = 'pattern', track = 0, start = 0, len = PPQ * 4, offset = 0, ref }) {
  return { id: uid(), kind, track, start, len, offset, ref, mute: false };
}

/** An empty project: one pattern, an empty rack, the default playlist and mixer. */
export function createProject({ name = 'Untitled', channels = [] } = {}) {
  return {
    version: PROJECT_VERSION,
    name,
    bpm: 130,
    sig: [4, 4],
    swing: 0,
    masterPitch: 0,
    channels,
    patterns: [createPattern(0)],
    tracks: Array.from({ length: DEFAULT_TRACKS }, (_, i) => createTrack(i)),
    clips: [],
    automation: {},
    mixer: Array.from({ length: DEFAULT_INSERTS + 1 }, (_, i) => createMixerTrack(i)),
    samples: {},
    loop: null,
    markers: [],
  };
}

// ------------------------------------------------------------------ lookups

export function channelById(project, id) {
  return project.channels.find((c) => c.id === id) || null;
}

export function patternById(project, id) {
  return project.patterns.find((p) => p.id === id) || null;
}

export function patternIndex(project, id) {
  return project.patterns.findIndex((p) => p.id === id);
}

/** Color a pattern is drawn with: its own, else the palette by pattern number. */
export function patternColor(project, pattern) {
  return pattern.color || colorAt(patternIndex(project, pattern.id) + 6);
}

/** End tick of the last note in a pattern (0 when empty). */
export function patternContentEnd(pattern) {
  let end = 0;
  for (const list of Object.values(pattern.notes)) for (const n of list) if (n.pos + n.len > end) end = n.pos + n.len;
  return end;
}

/**
 * Pattern length in ticks: an explicit length, else the content rounded up to
 * whole bars (one bar minimum). Steps-only patterns are one bar per 16 steps.
 */
export function patternLength(pattern, sig = [4, 4]) {
  if (pattern.length) return pattern.length;
  const bar = (PPQ * 4 * sig[0]) / sig[1];
  return Math.max(bar, Math.ceil(patternContentEnd(pattern) / bar) * bar);
}

/** Playlist song length: the end of the last clip (0 when empty). */
export function songLength(project) {
  let end = 0;
  for (const c of project.clips) if (c.start + c.len > end) end = c.start + c.len;
  return end;
}

/** Whether a channel is audible given the rack's mute and solo states. */
export function channelAudible(project, ch) {
  if (ch.mute) return false;
  const anySolo = project.channels.some((c) => c.solo);
  return !anySolo || ch.solo;
}

/** Default name for a new pattern: the lowest "Pattern N" not in use. */
export function nextPatternName(project) {
  const used = new Set(project.patterns.map((p) => p.name));
  let i = 1;
  while (used.has(`Pattern ${i}`)) i++;
  return `Pattern ${i}`;
}
