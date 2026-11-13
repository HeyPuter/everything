import { expect, it } from 'vitest';
import { createChannel, createClip, createNote, createPattern, createProject } from '../src/model/project.js';
import { projectToMidi } from '../src/io/midi-project.js';
import { readMidi, writeMidi } from '../src/io/midi.js';

function arrangement(count) {
  const p = createProject();
  p.channels = Array.from({ length: count }, (_, i) => createChannel({ name: `Part ${i}`, type: 'synth', params: { a_attack: i === 15 ? 500 : 0, a_sustain: 1 } }));
  const pattern = createPattern(0);
  pattern.notes = Object.fromEntries(p.channels.map((ch) => [ch.id, [createNote({ key: 60, pos: 96, len: 96, vel: 1 })]]));
  p.patterns = [pattern];
  p.clips = [createClip({ kind: 'pattern', ref: pattern.id, start: 0, len: 384 })];
  return p;
}

it.each([15, 16, 31])('gives %i melodic parts independent MIDI destinations', (count) => {
  const p = arrangement(count);
  for (const mode of ['song', 'pattern']) {
    const midi = projectToMidi(p, { mode, patternId: p.patterns[0].id });
    expect(new Set(midi.tracks.map((t) => `${t.port ?? 0}:${t.channel}`)).size).toBe(count);
    expect(midi.tracks.every((t) => t.channel !== 9)).toBe(true);
    expect(midi.tracks[0].program).toBe(81);
    if (count > 15) expect(midi.tracks[15]).toMatchObject({ port: 1, channel: 0, program: 89 });
    const imported = readMidi(writeMidi(midi));
    expect(imported.tracks.slice(1).map((t) => t.notes.length)).toEqual(Array(count).fill(1));
  }
});

it('reserves percussion channel 10 and does not allocate destinations to muted parts', () => {
  const p = arrangement(16);
  p.channels[0].mute = true;
  const drum = createChannel({ type: 'drum', name: 'Kick', params: { kind: 0 } });
  p.channels.unshift(drum);
  p.patterns[0].notes[drum.id] = [createNote({ pos: 0, len: 48 })];
  const midi = projectToMidi(p);
  expect(midi.tracks[0]).toMatchObject({ name: 'Kick', channel: 9 });
  expect(midi.tracks.every((t) => (t.port ?? 0) === 0)).toBe(true);
  expect(new Set(midi.tracks.map((t) => `${t.port ?? 0}:${t.channel}`)).size).toBe(16);
});

it('uses the final supported port without wrapping larger arrangements', () => {
  const p = arrangement(3841);
  p.channels.at(-1).mute = true;
  expect(projectToMidi(p).tracks.at(-1)).toMatchObject({ port: 255, channel: 15 });
  p.channels.at(-1).mute = false;
  expect(() => projectToMidi(p)).toThrow(/3840|MIDI ports/i);
});

// This byte check is independent of readMidi, which does not interpret port metadata.
it.each([0, 1, 255])('writes port %i before the track program and notes', (port) => {
  const bytes = writeMidi({ tracks: [{ port, channel: 0, program: 89, notes: [{ key: 60, tick: 0, len: 96, vel: 100 }] }] });
  const view = new DataView(bytes.buffer);
  const musicStart = 14 + 8 + view.getUint32(18) + 8;
  expect([...bytes.slice(musicStart, musicStart + 15)]).toEqual([
    0, 0xff, 3, 0, // Empty track name.
    0, 0xff, 0x21, 1, port,
    0, 0xc0, 89,
    0, 0x90, 60,
  ]);
});

it.each([-1, 256, 0.5])('rejects unsupported port %s instead of wrapping it', (port) => {
  expect(() => writeMidi({ tracks: [{ port, notes: [] }] })).toThrow(/port/i);
});
