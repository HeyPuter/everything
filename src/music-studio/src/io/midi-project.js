// Conversion between parsed MIDI files (io/midi.js) and projects.
//
// Import: every MIDI track and channel pair with notes becomes a Poly Synth
// channel (its preset picked from the General MIDI program family) with a
// pattern of its own, placed on its own playlist track from bar 1. One
// pattern per part keeps the arrangement editable: parts can be muted,
// moved or reused in the playlist independently, which a single pattern
// holding every part would not allow. Percussion (MIDI channel 10) becomes
// one Drum Synth channel per drum kind used, all in one "Drums" pattern.
//
// Export: one MIDI track per channel with notes, from the current pattern or
// from the song (every pattern clip in the playlist). Drum Synth channels go
// to MIDI channel 10 with the General MIDI note for their drum kind.

import { PPQ } from '../model/time.js';
import { createChannel, createPattern, createClip, colorAt, patternById, patternLength } from '../model/project.js';
import * as E from '../model/edits.js';
import { uid } from '../lib/util.js';
import { synthPreset, drumPreset } from '../instruments/presets.js';

/** General MIDI program (0..127) to a built-in synth preset name. */
export function presetForProgram(program = 0) {
  const family = Math.floor(program / 8);
  return (
    {
      0: 'Soft Keys', 1: 'Bell', 2: 'Organ', 3: 'Pluck', 4: 'Sub Bass', 5: 'Warm Pad', 6: 'Warm Pad', 7: 'Brass Stab',
      8: 'Square Lead', 9: 'Square Lead', 10: 'Saw Lead', 11: 'Glass Pad', 12: 'Glass Pad', 13: 'Pluck', 14: 'Pluck', 15: 'Pluck',
    }[family] || 'Soft Keys'
  );
}

/** General MIDI percussion note to a drum kind (instruments/presets.js numbering). */
export function drumKindForNote(note) {
  if (note === 35 || note === 36) return 0; // kicks
  if (note === 38 || note === 40) return 1; // snares
  if (note === 39) return 2; // clap
  if (note === 42 || note === 44) return 3; // closed and pedal hats
  if (note === 46) return 4; // open hat
  if ([41, 43, 45, 47, 48, 50].includes(note)) return 5; // toms
  if (note === 37 || note === 75 || note === 76 || note === 77) return 6; // rim, claves, blocks
  if ([49, 51, 52, 53, 55, 57, 59].includes(note)) return 7; // cymbals
  if (note === 56) return 8; // cowbell
  if ([54, 69, 70, 82].includes(note)) return 9; // tambourine, cabasa, maracas, shaker
  return 6;
}

/** General MIDI note written for a drum kind on export. */
export const DRUM_NOTES = [36, 38, 39, 42, 46, 45, 37, 49, 56, 70];

const DRUM_PRESET_FOR_KIND = ['Kick', 'Snare', 'Clap', 'Closed Hat', 'Open Hat', 'Tom', 'Rim', 'Crash', 'Cowbell', 'Shaker'];

const toTicks = (t, ppq) => Math.round((t * PPQ) / ppq);

/**
 * Adds a parsed MIDI file to a project. Resolves the new project plus what
 * was added. Tempo and time signature come from the file when `useTempo`.
 */
/** Most instrument parts (track and channel pairs) one import adds. */
export const MAX_PARTS = 256;

export function importMidi(project, midi, { name = 'MIDI', useTempo = true } = {}) {
  const ppq = midi.ppq || 96;
  const parts = new Map(); // `${track}:${ch}` -> { name, ch, program, notes }
  midi.tracks.forEach((t, ti) => {
    for (const n of t.notes) {
      const k = `${ti}:${n.ch}`;
      if (!parts.has(k)) parts.set(k, { name: t.name, ch: n.ch, program: t.programs[n.ch] ?? midi.tracks.find((x) => x.programs[n.ch] !== undefined)?.programs[n.ch] ?? 0, notes: [] });
      parts.get(k).notes.push(n);
    }
  });
  if (!parts.size) throw new Error('The MIDI file has no notes.');
  if (parts.size > MAX_PARTS) throw new Error(`The MIDI file has ${parts.size} parts; at most ${MAX_PARTS} can be imported.`);

  let p = project;
  // The tempo and meter in effect at the start (the file defaults are 120 bpm, 4/4).
  const tempo = midi.tempos.length ? (midi.tempos[0].tick === 0 ? midi.tempos[0].bpm : 120) : null;
  const sig = midi.sigs.length ? (midi.sigs[0].tick === 0 ? midi.sigs[0] : { num: 4, den: 4 }) : null;
  if (useTempo && tempo) p = E.setProjectProps(p, { bpm: Math.round(tempo * 100) / 100 });
  if (useTempo && sig && [1, 2, 4, 8, 16].includes(sig.den)) p = { ...p, sig: [Math.min(16, Math.max(1, sig.num)), sig.den] };

  const usedInserts = new Set(p.channels.map((c) => c.mixer));
  const nextInsert = () => {
    for (let i = 1; i < p.mixer.length; i++) {
      if (!usedInserts.has(i)) {
        usedInserts.add(i);
        return i;
      }
    }
    return 0;
  };
  const firstTrack = p.clips.length ? Math.max(...p.clips.map((c) => c.track)) + 1 : 0;
  const channelIds = [];
  const patternIds = [];
  const clips = [];
  let colorIndex = p.channels.length;
  const addChannel = (ch) => {
    const insert = nextInsert();
    ch.mixer = insert;
    p = E.addChannel(p, ch);
    if (insert > 0) p = E.updateMixerTrack(p, insert, { name: ch.name, color: ch.color });
    channelIds.push(ch.id);
  };
  const addPattern = (pname, color, notesByChannel) => {
    const pat = { ...createPattern(p.patterns.length, pname.slice(0, 60)), color, notes: notesByChannel };
    p = { ...p, patterns: [...p.patterns, pat] };
    patternIds.push(pat.id);
    const len = patternLength(pat, p.sig);
    clips.push(createClip({ kind: 'pattern', track: firstTrack + clips.length, start: 0, len, ref: pat.id }));
    return pat;
  };
  const note = (n, key = n.key) => ({ id: uid(6), key, pos: toTicks(n.tick, ppq), len: Math.max(1, toTicks(n.len, ppq)), vel: Math.min(1, n.vel / 127), pan: 0 });

  // Melodic parts first, in file order.
  let partNo = 0;
  for (const part of parts.values()) {
    if (part.ch === 9) continue;
    partNo++;
    const preset = presetForProgram(part.program);
    const color = colorAt(colorIndex++);
    const label = part.name || `${name} ${partNo}`;
    const ch = createChannel({ type: 'synth', name: label.slice(0, 60), color, params: synthPreset(preset).params });
    addChannel(ch);
    addPattern(label, color, { [ch.id]: part.notes.map((n) => note(n)).sort((a, b) => a.pos - b.pos || a.key - b.key) });
  }

  // Percussion: one drum channel per kind, one pattern for the kit.
  const drumNotes = [...parts.values()].filter((x) => x.ch === 9).flatMap((x) => x.notes);
  if (drumNotes.length) {
    const byKind = new Map();
    for (const n of drumNotes) {
      const kind = drumKindForNote(n.key);
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(n);
    }
    const notes = {};
    for (const kind of [...byKind.keys()].sort((a, b) => a - b)) {
      const preset = drumPreset(DRUM_PRESET_FOR_KIND[kind]);
      const ch = createChannel({ type: 'drum', name: preset.name, color: colorAt(colorIndex++), params: preset.params });
      addChannel(ch);
      // Toms follow the key (key_track), so keep their pitch; other drums sit on the channel's root.
      notes[ch.id] = byKind.get(kind).map((n) => note(n, kind === 5 ? Math.min(127, n.key + 15) : ch.root)).sort((a, b) => a.pos - b.pos || a.key - b.key);
    }
    addPattern('Drums', colorAt(0), notes);
  }

  p = E.addClips(p, clips).project;
  // Name the playlist tracks after their parts (only tracks still named by default).
  p = {
    ...p,
    tracks: p.tracks.map((t, i) => {
      const clip = clips[i - firstTrack];
      if (!clip || t.name !== `Track ${i + 1}`) return t;
      return { ...t, name: patternById(p, clip.ref).name };
    }),
  };
  return { project: p, channelIds, patternIds, bpm: p.bpm };
}

/** The writer's input (see writeMidi) for a pattern or the whole song. */
export function projectToMidi(project, { mode = 'song', patternId = null } = {}) {
  const byChannel = new Map(); // channel id -> notes in ticks
  const push = (cid, n, shift) => {
    if (!byChannel.has(cid)) byChannel.set(cid, []);
    byChannel.get(cid).push({ key: n.key, tick: n.pos + shift, len: n.len, vel: n.vel * 127 });
  };
  if (mode === 'pattern') {
    const pat = patternById(project, patternId) || project.patterns[0];
    for (const [cid, list] of Object.entries(pat.notes)) for (const n of list) push(cid, n, 0);
  } else {
    const trackMuted = (i) => project.tracks[i]?.mute;
    for (const c of project.clips) {
      if (c.kind !== 'pattern' || c.mute || trackMuted(c.track)) continue;
      const pat = patternById(project, c.ref);
      if (!pat) continue;
      for (const [cid, list] of Object.entries(pat.notes)) {
        for (const n of list) {
          if (n.pos < c.offset || n.pos >= c.offset + c.len) continue;
          // Notes are cut at the clip end, as the playlist plays them.
          const len = Math.min(n.len, c.offset + c.len - n.pos);
          push(cid, { ...n, len }, c.start - c.offset);
        }
      }
    }
  }
  const tracks = [];
  let melodic = 0;
  for (const ch of project.channels) {
    const notes = byChannel.get(ch.id);
    if (!notes?.length) continue;
    if (ch.type === 'drum') {
      const kind = Math.round(ch.params.kind ?? 0);
      const gm = DRUM_NOTES[kind] ?? 37;
      tracks.push({ name: ch.name, channel: 9, notes: notes.map((n) => ({ ...n, key: kind === 5 ? Math.max(0, n.key - 15) : gm })) });
    } else {
      const midiCh = melodic % 15 >= 9 ? (melodic % 15) + 1 : melodic % 15;
      melodic++;
      tracks.push({ name: ch.name, channel: midiCh, program: programForChannel(ch), notes });
    }
  }
  return { ppq: PPQ, bpm: project.bpm, sig: project.sig, name: project.name, tracks };
}

/** A General MIDI program that roughly matches a channel (for other apps' playback). */
function programForChannel(ch) {
  if (ch.type === 'sampler' || ch.type === 'audio') return 0;
  const p = ch.params;
  if ((p.osc1_oct ?? 0) < 0 && p.mono) return 38; // synth bass
  if ((p.a_attack ?? 0) > 300) return 89; // warm pad
  if ((p.a_sustain ?? 1) === 0) return 45; // pizzicato-like pluck
  return 81; // saw lead
}

