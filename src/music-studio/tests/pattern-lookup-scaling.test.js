import { expect, it } from 'vitest';
import { createChannel, createClip, createNote, createProject } from '../src/model/project.js';
import { compileSequence } from '../src/engine/compile.js';
import { projectToMidi } from '../src/io/midi-project.js';

function arrangement(count) {
  const p = createProject(), ch = createChannel();
  p.channels = [ch];
  p.patterns = Array.from({ length: count }, (_, i) => ({ ...p.patterns[0], id: `p${i}`, notes: { [ch.id]: [createNote({ key: 60 + i % 12, pos: 0, len: 96, vel: 1 })] } }));
  p.clips = p.patterns.map((pat, i) => createClip({ kind: 'pattern', ref: pat.id, track: 0, start: i * 96, len: 96 }));
  return p;
}
const outputs = [
  ['playback', (p) => {
    const { notes } = compileSequence(p, { mode: 'song', slotOf: () => 0 });
    return Array.from({ length: notes.count }, (_, i) => ({ key: notes.key[i], tick: notes.start[i], len: notes.end[i] - notes.start[i] }));
  }],
  ['MIDI export', (p) => projectToMidi(p).tracks.flatMap((t) => t.notes.map(({ key, tick, len }) => ({ key, tick, len })))],
];
function trackReads(p) {
  let reads = 0;
  for (const pat of p.patterns) {
    const id = pat.id;
    Object.defineProperty(pat, 'id', { get() { reads++; return id; } });
  }
  return () => reads;
}

it.each(outputs)('looks up distinct song patterns with linear work during %s', (_name, run) => {
  const count = 100;
  const p = arrangement(count);
  const reads = trackReads(p);
  expect(run(p)).toEqual(Array.from({ length: count }, (_, i) => ({ key: 60 + i % 12, tick: i * 96, len: 96 })));
  expect(reads()).toBeLessThanOrEqual(count * 4);
});

it.each(outputs)('avoids scanning unused trailing patterns during %s', (_name, run) => {
  const p = arrangement(100);
  p.clips = [p.clips[0]];
  const reads = trackReads(p);
  expect(run(p)).toEqual([{ key: 60, tick: 0, len: 96 }]);
  expect(reads()).toBeLessThanOrEqual(4);
});

it.each(outputs)('preserves reused, offset and missing references and picks up edits during %s', (_name, run) => {
  const p = arrangement(3);
  p.clips = [
    { ...p.clips[2], start: 0, offset: 0, len: 48 },
    { ...p.clips[0], start: 96 },
    { ...p.clips[2], start: 192 },
    { ...p.clips[1], ref: 'missing', start: 288 },
  ];
  expect(run(p)).toEqual([{ key: 62, tick: 0, len: 48 }, { key: 60, tick: 96, len: 96 }, { key: 62, tick: 192, len: 96 }]);
  const cid = p.channels[0].id;
  p.patterns = p.patterns.map((pat, i) => i === 2 ? { ...pat, notes: { [cid]: [createNote({ key: 75, pos: 24, len: 96, vel: 1 })] } } : pat);
  p.clips[0] = { ...p.clips[0], offset: 24 };
  expect(run(p)).toEqual([{ key: 75, tick: 0, len: 48 }, { key: 60, tick: 96, len: 96 }, { key: 75, tick: 216, len: 72 }]);
});
