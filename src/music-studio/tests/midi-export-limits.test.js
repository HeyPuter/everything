import { expect, it } from 'vitest';
import { readMidi, writeMidi } from '../src/io/midi.js';
import { importMidi, projectToMidi } from '../src/io/midi-project.js';
import { newProject } from '../src/model/demo.js';

// Empty tracks keep the format-boundary checks under about 1 MiB of encoded data.
const tracksAt = (count) => {
  const tracks = Array(count).fill({ name: '', channel: 0, notes: [] });
  tracks[count - 1] = { name: 'Keep the last track', channel: 0, notes: [{ key: 60, tick: 0, len: 96, vel: 100 }] };
  return tracks;
};

it('reports too many MIDI tracks instead of hiding the final track beyond the header count', () => {
  expect(() => writeMidi({ tracks: tracksAt(65535) })).toThrow(/too many tracks|65534/i);
});

it('preserves the last track at the supported MIDI track-count boundary', () => {
  const bytes = writeMidi({ tracks: tracksAt(65534) });
  expect(bytes.byteLength).toBeLessThan(1100000);
  const midi = readMidi(bytes);
  expect(midi.tracks).toHaveLength(65535); // Includes the tempo track.
  expect(midi.tracks.at(-1).name).toBe('Keep the last track');
  expect(midi.tracks.at(-1).notes).toEqual([{ ch: 0, key: 60, tick: 0, len: 96, vel: 100 }]);
});

it.each([0x10000000, 0x100000000])('preserves a long MIDI gap at tick %i without overflowing or wrapping', (tick) => {
  const bytes = writeMidi({ tracks: [{ channel: 0, notes: [{ key: 60, tick, len: 96, vel: 100 }] }] });
  expect(bytes.byteLength).toBeLessThan(250);
  const midi = readMidi(bytes);
  expect(midi.tracks[1].notes).toEqual([{ ch: 0, key: 60, tick, len: 96, vel: 100 }]);
});

it('exports a valid low-resolution import without losing its long timing gap', () => {
  const source = readMidi(writeMidi({ ppq: 1, tracks: [{ channel: 0, notes: [{ key: 60, tick: 2800000, len: 1, vel: 100 }] }] }));
  const imported = importMidi(newProject(), source);
  const exported = readMidi(writeMidi(projectToMidi(imported.project)));
  expect(exported.tracks[1].notes[0]).toMatchObject({ tick: 268800000, len: 96 });
});

it('reports astronomical MIDI gaps before generating excessive padding', () => {
  expect(() => writeMidi({ tracks: [{ channel: 0, notes: [{ key: 60, tick: Number.MAX_SAFE_INTEGER - 100, len: 96, vel: 100 }] }] })).toThrow(/gap|timing/i);
});

it('preserves a long held note across silent timing events', () => {
  const len = 0x10000000;
  const midi = readMidi(writeMidi({ tracks: [{ channel: 0, notes: [{ key: 60, tick: 0, len, vel: 100 }] }] }));
  expect(midi.tracks[1].notes).toEqual([{ ch: 0, key: 60, tick: 0, len, vel: 100 }]);
});

it('bounds synthetic gap events while preserving the exact supported boundary', () => {
  const tick = 0x0fffffff * 1025;
  const tracks = [{ channel: 0, notes: [{ key: 60, tick, len: 96, vel: 100 }] }];
  const bytes = writeMidi({ tracks });
  expect(bytes.byteLength).toBeLessThan(7500);
  expect(readMidi(bytes).tracks[1].notes[0]).toMatchObject({ tick, len: 96 });
  tracks[0].notes[0].tick++;
  expect(() => writeMidi({ tracks })).toThrow(/timing gap too large/i);
});
