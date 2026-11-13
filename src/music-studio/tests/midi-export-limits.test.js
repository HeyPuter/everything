import { expect, it } from 'vitest';
import { readMidi, writeMidi } from '../src/io/midi.js';

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
