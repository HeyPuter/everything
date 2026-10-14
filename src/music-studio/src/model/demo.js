// Starting projects. The demo song is written note by note here and played by
// the built-in synthesizers; it contains no recorded audio.

import { createProject, createChannel, createNote, createPattern, COLORS } from './project.js';
import { drumPreset, synthPreset, STARTER_KIT } from '../instruments/presets.js';
import { createSlot } from './project.js';
import { STEP, PPQ } from './time.js';
import { uid } from '../lib/util.js';

const drum = (preset, color, mixer) => createChannel({ type: 'drum', name: preset, color, params: drumPreset(preset).params, mixer });
const synth = (preset, name, color, mixer) => createChannel({ type: 'synth', name, color, params: synthPreset(preset).params, mixer });

/** A new project: the starter drum kit on inserts 1..4 and an empty pattern. */
export function newProject(name = 'Untitled') {
  const channels = STARTER_KIT.map((k, i) => drum(k.preset, k.color, i + 1));
  const p = createProject({ name, channels });
  p.mixer = p.mixer.map((t, i) => (i >= 1 && i <= channels.length ? { ...t, name: channels[i - 1].name, color: channels[i - 1].color } : t));
  return p;
}

const steps = (pattern, key = 60, vel = 0.8) =>
  [...pattern].flatMap((c, i) => (c === 'x' ? [createNote({ key, pos: i * STEP, len: STEP, vel })] : c === 'o' ? [createNote({ key, pos: i * STEP, len: STEP, vel: vel * 0.6 })] : []));

const seq = (list) => list.map(([key, pos, len, vel = 0.8]) => createNote({ key, pos: pos * STEP, len: len * STEP, vel }));

/** The demo song: drums, bass, chords and a lead over an eight-bar arrangement. */
export function demoProject() {
  const kick = drum('Kick', COLORS[0], 1);
  const clap = drum('Clap', COLORS[1], 2);
  const hat = drum('Closed Hat', COLORS[2], 3);
  const ohat = drum('Open Hat', COLORS[3], 3);
  const bass = synth('Acid Bass', 'Bass', COLORS[5], 4);
  const chords = synth('Warm Pad', 'Chords', COLORS[7], 5);
  const lead = synth('Pluck', 'Lead', COLORS[9], 6);
  const channels = [kick, clap, hat, ohat, bass, chords, lead];
  const p = createProject({ name: 'Demo Song', channels });
  p.bpm = 124;

  const beat = { ...createPattern(0, 'Beat'), color: COLORS[0] };
  beat.notes = {
    [kick.id]: steps('x...x...x...x...'),
    [clap.id]: steps('....x.......x...'),
    [hat.id]: steps('x.o.x.o.x.o.x.ox', 60, 0.7),
    [ohat.id]: steps('..x...x...x...x.', 60, 0.6),
  };
  // Am - F - C - G, one bar each.
  const roots = [45, 41, 48, 43];
  const bassLine = { ...createPattern(1, 'Bassline'), color: COLORS[5] };
  bassLine.notes = {
    [bass.id]: roots.flatMap((r, bar) => seq([[r, bar * 16, 2], [r, bar * 16 + 3, 1, 0.6], [r + 12, bar * 16 + 6, 2], [r, bar * 16 + 10, 2], [r + 7, bar * 16 + 14, 2, 0.7]])),
  };
  const chordNotes = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
  const pad = { ...createPattern(2, 'Chords'), color: COLORS[7] };
  pad.notes = { [chords.id]: chordNotes.flatMap((ch, bar) => ch.map((k) => createNote({ key: k, pos: bar * 16 * STEP, len: 16 * STEP, vel: 0.65 }))) };
  const melody = { ...createPattern(3, 'Lead'), color: COLORS[9] };
  melody.notes = {
    [lead.id]: seq([
      [76, 0, 2], [74, 2, 2], [72, 4, 4], [69, 8, 2], [72, 10, 2], [74, 12, 4],
      [72, 16, 2], [69, 18, 2], [65, 20, 4], [69, 24, 4], [72, 28, 4],
      [76, 32, 2], [74, 34, 2], [72, 36, 2], [79, 38, 6], [76, 44, 4],
      [74, 48, 4], [71, 52, 4], [74, 56, 2], [71, 58, 2], [67, 60, 4],
    ]),
  };
  p.patterns = [beat, bassLine, pad, melody];

  const bar = PPQ * 4;
  const clip = (track, ref, start, len) => ({ id: uid(), kind: 'pattern', track, start: start * bar, len: len * bar, offset: 0, ref, mute: false });
  p.clips = [
    clip(0, beat.id, 0, 1), clip(0, beat.id, 1, 1), clip(0, beat.id, 2, 1), clip(0, beat.id, 3, 1), clip(0, beat.id, 4, 1), clip(0, beat.id, 5, 1), clip(0, beat.id, 6, 1), clip(0, beat.id, 7, 1),
    clip(1, bassLine.id, 0, 4), clip(1, bassLine.id, 4, 4),
    clip(2, pad.id, 0, 4), clip(2, pad.id, 4, 4),
    clip(3, melody.id, 4, 4),
  ];
  p.tracks = p.tracks.map((t, i) => (i < 4 ? { ...t, name: ['Drums', 'Bass', 'Chords', 'Lead'][i] } : t));

  const names = ['Kick', 'Clap', 'Hats', 'Bass', 'Chords', 'Lead'];
  p.mixer = p.mixer.map((t, i) => {
    if (i >= 1 && i <= names.length) return { ...t, name: names[i - 1], color: [COLORS[0], COLORS[1], COLORS[2], COLORS[5], COLORS[7], COLORS[9]][i - 1] };
    return t;
  });
  p.mixer[5] = { ...p.mixer[5], fx: [{ ...createSlot('reverb'), params: { ...createSlot('reverb').params, wet: 0.3 } }] };
  p.mixer[6] = { ...p.mixer[6], fx: [createSlot('delay'), createSlot('reverb')] };
  p.mixer[0] = { ...p.mixer[0], fx: [createSlot('limiter')] };
  p.ui = { pattern: beat.id };
  return p;
}
