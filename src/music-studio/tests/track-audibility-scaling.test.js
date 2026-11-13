import { expect, it } from 'vitest';
import { createChannel, createClip, createNote, createProject } from '../src/model/project.js';
import { compileSequence } from '../src/engine/compile.js';
import { projectToMidi } from '../src/io/midi-project.js';

function arrangement(count) {
  const p = createProject();
  const channel = createChannel();
  p.channels = [channel];
  p.patterns[0].notes = { [channel.id]: [createNote({ key: 60, pos: 0, len: 96, vel: 1 })] };
  p.tracks = Array.from({ length: count }, (_, i) => ({ ...p.tracks[0], id: `t${i}` }));
  p.clips = p.tracks.map((_, i) => createClip({ kind: 'pattern', ref: p.patterns[0].id, track: i, start: i * 96, len: 96 }));
  return p;
}

const outputs = [
  ['playback', (p) => [...compileSequence(p, { mode: 'song', slotOf: () => 0 }).notes.start]],
  ['MIDI export', (p) => projectToMidi(p).tracks.flatMap((t) => t.notes.map((n) => n.tick))],
];

it.each(outputs)('keeps playlist solo inspection linear during %s', (_name, run) => {
  const count = 100;
  const p = arrangement(count);
  let reads = 0;
  for (const t of p.tracks) Object.defineProperty(t, 'solo', { get() { reads++; return false; } });
  expect(run(p)).toEqual(Array.from({ length: count }, (_, i) => i * 96));
  // Count relevant work rather than asserting machine-dependent wall time.
  expect(reads).toBeLessThanOrEqual(count * 8);
});

it.each(outputs)('preserves current mute and solo behavior during %s', (_name, run) => {
  const p = arrangement(4);
  p.tracks[1].mute = true;
  expect(run(p)).toEqual([0, 192, 288]);
  p.tracks[3].solo = true;
  expect(run(p)).toEqual([288]);
  p.tracks[0].solo = true;
  expect(run(p)).toEqual([0, 288]);
  p.tracks[0].mute = true;
  p.tracks[3].mute = true;
  expect(run(p)).toEqual([]);
  p.tracks[0].solo = false;
  p.tracks[3].solo = false;
  expect(run(p)).toEqual([192]);
});
