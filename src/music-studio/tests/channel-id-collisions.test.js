import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { createProject, createChannel, createClip } from '../src/model/project.js';
import { newProject, demoProject } from '../src/model/demo.js';
import { Store } from '../src/model/store.js';
import * as E from '../src/model/edits.js';
import { makeUnique } from '../src/playlist/clips.js';
import { ProjectFiles } from '../src/storage/files.js';
import { importMidi } from '../src/io/midi-project.js';
import { readMidi, writeMidi } from '../src/io/midi.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function fixture(type = 'synth') {
  const ch = { ...createChannel({ name: 'Existing', type }), id: '00000000' };
  const project = createProject({ channels: [ch] });
  project.patterns[0].notes[ch.id] = [{ id: 'old-note', key: 67, pos: 48, len: 96, vel: 0.7, pan: 0 }];
  return { project, ch, pid: project.patterns[0].id };
}
function collide(skip = 0) {
  const random = crypto.getRandomValues.bind(crypto);
  let calls = 0;
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
    if (bytes.length !== 8) return random(bytes);
    const call = calls++;
    return call >= skip && call < skip + 2 ? bytes.fill(0) : random(bytes);
  });
}
function assertIndependent(project, original, added) {
  expect(added).not.toBe(original.channels[0].id);
  expect(new Set(project.channels.map((c) => c.id)).size).toBe(project.channels.length);
  const removed = E.removeChannels(project, [added]);
  expect(removed.channels.find((c) => c.id === original.channels[0].id)).toBe(original.channels[0]);
  expect(removed.patterns[0].notes[original.channels[0].id]).toBe(original.patterns[0].notes[original.channels[0].id]);
}

it.each([undefined, 0])('selects the newly added channel after a collision at index %s', (index) => {
  const { project } = fixture();
  const app = new App(document.createElement('div'), { project, storage: { getItem: () => null, setItem() {} } });
  app.notify = vi.fn();
  collide();
  const id = app.addChannel({ name: 'Added', index });
  assertIndependent(app.store.project, project, id);
  expect(app.store.project.channels[index ?? 1]).toMatchObject({ id, name: 'Added' });
  expect([...app.store.view.selectedChannels]).toEqual([id]);
  app.store.apply('Rename added', (p) => E.updateChannel(p, id, { name: 'Renamed' }));
  expect(app.store.project.channels.find((c) => c.id === '00000000').name).toBe('Existing');
  app.store.undo(); app.store.undo();
  expect(app.store.project).toBe(project);
  app.store.redo(); expect(app.store.project.channels.some((c) => c.id === id)).toBe(true);
});

it('reserves a supplied duplicate channel ID without mutating the caller', () => {
  const { project, ch } = fixture();
  const input = { ...ch, name: 'Imported' }, store = new Store(project);
  collide();
  store.apply('Add', (p) => E.addChannel(p, input));
  const added = store.project.channels.at(-1);
  assertIndependent(store.project, project, added.id);
  expect(added.name).toBe('Imported');
  expect(input.id).toBe(ch.id);
});

it.each([false, true])('clones a channel independently withNotes=%s', (withNotes) => {
  const { project, ch, pid } = fixture();
  collide();
  const result = E.cloneChannel(project, ch.id, { withNotes });
  assertIndependent(result.project, project, result.id);
  expect(result.project.channels[1]).toMatchObject({ id: result.id, name: 'Existing #2' });
  if (withNotes) {
    const notes = E.getNotes(result.project, pid, result.id);
    expect(notes.map(({ id, ...n }) => n)).toEqual(E.getNotes(project, pid, ch.id).map(({ id, ...n }) => n));
    expect(notes[0].id).not.toBe('old-note');
  } else expect(E.getNotes(result.project, pid, result.id)).toEqual([]);
});

it('makes one audio clip unique without linking it to the original channel', () => {
  const { project, ch } = fixture('audio');
  project.clips = ['a', 'b'].map((id) => ({ ...createClip({ kind: 'audio', ref: ch.id }), id }));
  collide();
  const result = makeUnique(project, 'b');
  assertIndependent(result.project, project, result.id);
  expect(result.project.clips.map((c) => c.ref)).toEqual([ch.id, result.id]);
  expect(E.removeChannels(result.project, [result.id]).clips).toEqual([project.clips[0]]);
});

it('returns and selects the new channel after an audio import ID collision', async () => {
  const { project } = fixture();
  const app = { store: new Store(project), samples: { set: vi.fn() }, notify: vi.fn() };
  const files = new ProjectFiles(app, { putSample: vi.fn(async () => {}) });
  vi.stubGlobal('OfflineAudioContext', class { async decodeAudioData() { return { numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(48) }; } });
  collide(1); // The sample is allocated before its new channel.
  const result = await files.importAudio({ size: 4, arrayBuffer: async () => new ArrayBuffer(4) }, { name: 'Tone.wav', as: 'audio' });
  assertIndependent(app.store.project, project, result.channelId);
  expect(app.store.project.channels.at(-1)).toMatchObject({ id: result.channelId, name: 'Tone', sample: result.sampleId, type: 'audio' });
  expect([...app.store.view.selectedChannels]).toEqual([result.channelId]);
  app.store.undo(); expect(app.store.project).toBe(project);
});

it.each([0, 9])('keeps imported MIDI channel %i notes on the new instruments', (channel) => {
  const { project } = fixture();
  const midi = readMidi(writeMidi({ ppq: 96, tracks: [{ channel, notes: [{ key: channel === 9 ? 36 : 60, tick: 0, len: 48, vel: 100 }, { key: channel === 9 ? 38 : 64, tick: 96, len: 24, vel: 80 }] }] }));
  collide();
  const result = importMidi(project, midi);
  for (const id of result.channelIds) assertIndependent(result.project, project, id);
  const imported = result.project.patterns.filter((p) => result.patternIds.includes(p.id));
  expect(imported.flatMap((p) => Object.values(p.notes).flat()).map((n) => n.pos).sort((a, b) => a - b)).toEqual([0, 96]);
  for (const p of imported) for (const id of Object.keys(p.notes)) expect(result.channelIds).toContain(id);
});

it.each([['starter', newProject], ['demo', demoProject]])('preserves the %s instruments and music after colliding initial channel IDs', (_name, create) => {
  const expected = create();
  const music = (p) => p.channels.map((c) => ({ name: c.name, notes: p.patterns.map((pat) => (pat.notes[c.id] || []).map(({ id, ...n }) => n)) }));
  collide();
  const result = create();
  expect(new Set(result.channels.map((c) => c.id)).size).toBe(result.channels.length);
  expect(music(result)).toEqual(music(expected));
  expect(E.removeChannels(result, [result.channels[0].id]).channels).toHaveLength(result.channels.length - 1);
});

it('retains a valid supplied channel object and permits IDs used by other source types', () => {
  const { project } = fixture();
  const ch = { ...createChannel(), id: project.patterns[0].id };
  const store = new Store(project);
  store.apply('Add', (p) => E.addChannel(p, ch));
  expect(store.project.channels.at(-1)).toBe(ch);
  expect(store.project.patterns).toBe(project.patterns);
});
