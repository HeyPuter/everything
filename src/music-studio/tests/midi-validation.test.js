import { expect, it, vi } from 'vitest';
import { readMidi } from '../src/io/midi.js';
import { ProjectFiles } from '../src/storage/files.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';

const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const be32 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const header = (length = 6, tracks = 1) => [...ascii('MThd'), ...be32(length), 0, 0, 0, tracks, 0, 96];
const chunk = (body, length = body.length, name = 'MTrk') => [...ascii(name), ...be32(length), ...body];
const note = [0, 0x90, 60, 100, 96, 0x80, 60, 64, 0, 0xff, 0x2f, 0];

it.each([
  ['missing track', header()],
  ['partial chunk header', [...header(), ...ascii('MTr')]],
  ['short track payload', [...header(), ...chunk(note.slice(0, 4), note.length)]],
  ['missing header extension', header(20)],
  ['undersized header', [...header(0), ...chunk(note)]],
  ['short text event', [...header(), ...chunk([0, 0xff, 0x03, 5, 65])]],
  ['short skipped metadata', [...header(), ...chunk([0, 0xff, 0x01, 5, 65])]],
  ['short system-exclusive event', [...header(), ...chunk([0, 0xf0, 5, 65])]],
  ['short tempo payload', [...header(), ...chunk([0, 0xff, 0x51, 5, 7, 0xa1, 0x20])]],
  ['short time-signature payload', [...header(), ...chunk([0, 0xff, 0x58, 4, 4, 2])]],
])('rejects a damaged MIDI file with %s', (_name, bytes) => {
  expect(() => readMidi(Uint8Array.from(bytes))).toThrow(/truncated|damaged/i);
});

it('does not import a shortened note from a truncated track', async () => {
  const store = new Store(newProject());
  const app = { store, notify: vi.fn() };
  const files = new ProjectFiles(app, {});
  const before = store.project;
  const bytes = Uint8Array.from([...header(), ...chunk(note.slice(0, 4), note.length)]);
  const result = await files.importMidiBlob(new Blob([bytes]), 'Truncated.mid').catch((error) => error);
  expect(result instanceof Error).toBe(true);
  expect(store.project === before).toBe(true);
  expect(store.undoStack).toHaveLength(0);
  expect(app.notify).not.toHaveBeenCalled();
});

it('preserves supported header extensions, unknown chunks, and complete note durations', () => {
  const file = Uint8Array.from([...header(8), 0, 0, ...chunk([1, 2, 3], 3, 'JUNK'), ...chunk(note)]);
  const midi = readMidi(file);
  expect(midi.tracks).toHaveLength(1);
  expect(midi.tracks[0].notes).toEqual([{ ch: 0, key: 60, tick: 0, len: 96, vel: 100 }]);
});

it.each([
  ['event time', [0x80, 0x80, 0x80, 0x80, 0x90, 60, 100, 0, 0xff, 0x2f, 0]],
  ['metadata length', [0, 0xff, 1, 0x80, 0x80, 0x80, 0x80, 0, 0xff, 0x2f, 0]],
  ['system-exclusive length', [0, 0xf0, 0x80, 0x80, 0x80, 0x80, 0, 0xff, 0x2f, 0]],
])('rejects a MIDI %s without a variable-length terminator', (_name, body) => {
  expect(() => readMidi(Uint8Array.from([...header(), ...chunk(body)]))).toThrow(/damaged/i);
});

it('accepts a correctly terminated four-byte MIDI delta', () => {
  const body = [0xff, 0xff, 0xff, 0x7f, 0x90, 60, 100, 96, 0x80, 60, 64, 0, 0xff, 0x2f, 0];
  const midi = readMidi(Uint8Array.from([...header(), ...chunk(body)]));
  expect(midi.tracks[0].notes).toEqual([{ ch: 0, key: 60, tick: 0x0fffffff, len: 96, vel: 100 }]);
});
