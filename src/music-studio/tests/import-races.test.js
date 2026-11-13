import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProjectFiles } from '../src/storage/files.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { writeMidi } from '../src/io/midi.js';
import { Engine } from '../src/engine/engine.js';
import { SampleCache } from '../src/audio/samples.js';
import { RackView } from '../src/rack/rack-view.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function setup() {
  const app = {
    store: new Store(newProject()),
    samples: { set: vi.fn() },
    notify: vi.fn(),
  };
  const lib = { putSample: vi.fn(async () => {}) };
  const decoded = { numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(48) };
  const decode = vi.fn(async () => decoded);
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData(data) { return decode(data); } });
  return { app, lib, files: new ProjectFiles(app, lib), decode, decoded };
}

afterEach(() => vi.unstubAllGlobals());

describe('imports while switching projects', () => {
  it('cancels a MIDI picker download when the open project changes', async () => {
    const { app, lib, files } = setup();
    const gate = deferred();
    const read = vi.fn(() => gate.promise);
    lib.cloudProjectsDir = async () => '/Projects';
    vi.stubGlobal('puter', { auth: { isSignedIn: () => true }, ui: { showOpenFilePicker: async () => [{ name: 'song.mid', read }] } });
    const pending = files.openFromPuter().then(() => null, (err) => err);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const next = newProject();
    app.store.load(next);
    const bytes = writeMidi({ ppq: 96, bpm: 120, tracks: [{ notes: [{ key: 60, tick: 0, len: 96, vel: 100 }] }] });
    gate.resolve({ arrayBuffer: async () => bytes.buffer });
    expect(await pending).toMatchObject({ message: 'Import cancelled because another project was opened.' });
    expect(app.store.project === next).toBe(true);
  });

  it('stops a rack drop batch when the project changes during its first file', async () => {
    const { app, files } = setup();
    app.files = files;
    const view = {
      app, store: app.store, dropLine: {}, dropIndex: () => 0,
      importFile: vi.fn(async () => { app.store.load(newProject()); return false; }),
    };
    await RackView.prototype.onDrop.call(view, {
      preventDefault() {}, clientY: 0,
      dataTransfer: { types: ['Files'], getData: () => '', files: [{ name: 'a.wav', type: 'audio/wav' }, { name: 'b.wav', type: 'audio/wav' }] },
    });
    expect(view.importFile).toHaveBeenCalledTimes(1);
  });

  it('cancels a rack cloud drop when a new project opens during download', async () => {
    const { app, files } = setup();
    app.files = files;
    app.importAudio = (blob, opts) => files.importAudio(blob, opts);
    app.reportError = vi.fn();
    const gate = deferred();
    const read = vi.fn(() => gate.promise);
    vi.stubGlobal('puter', { auth: { isSignedIn: () => true }, fs: { read } });
    const view = { app, store: app.store, actions: { moveTo: vi.fn() } };
    const pending = RackView.prototype.importFile.call(view, null, { path: '/tone.wav', name: 'tone.wav' }, 0);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const next = newProject();
    app.store.load(next);
    gate.resolve({ size: 4, arrayBuffer: async () => new ArrayBuffer(4) });
    expect(await pending).toBe(false);
    expect(app.store.project === next).toBe(true);
    expect(app.samples.set).not.toHaveBeenCalled();
  });

  it.each(['read', 'decode', 'persist'])('cancels audio import if the project changes during %s', async (stage) => {
    const { app, lib, files, decode, decoded } = setup();
    const gate = deferred();
    const blob = { size: 4, arrayBuffer: () => stage === 'read' ? gate.promise : Promise.resolve(new ArrayBuffer(4)) };
    if (stage === 'decode') decode.mockReturnValue(gate.promise);
    if (stage === 'persist') lib.putSample.mockReturnValue(gate.promise);
    const importing = files.importAudio(blob, { name: 'tone.wav' });
    const result = importing.then(() => null, (err) => err);
    if (stage === 'decode') await vi.waitFor(() => expect(decode).toHaveBeenCalled());
    if (stage === 'persist') await vi.waitFor(() => expect(lib.putSample).toHaveBeenCalled());
    const next = newProject();
    app.store.load(next);
    gate.resolve(stage === 'decode' ? decoded : new ArrayBuffer(4));
    expect(await result).toMatchObject({ message: 'Import cancelled because another project was opened.' });
    expect(app.store.project === next).toBe(true);
    expect(app.store.canUndo).toBe(false);
    expect(app.samples.set).not.toHaveBeenCalled();
  });

  it.each(['read', 'decode', 'persist'])('does not retain decoded audio when its channel is deleted during %s', async (stage) => {
    const { app, lib, files, decode, decoded } = setup();
    const engine = new Engine(app.store);
    app.samples = new SampleCache(engine);
    const target = app.store.project.channels[0];
    const original = app.store.project;
    const gate = deferred();
    const blob = { size: 4, arrayBuffer: () => stage === 'read' ? gate.promise : Promise.resolve(new ArrayBuffer(4)) };
    if (stage === 'decode') decode.mockReturnValue(gate.promise);
    if (stage === 'persist') lib.putSample.mockReturnValue(gate.promise);
    const result = files.importAudio(blob, { name: 'tone.wav', channel: target.id }).catch((err) => err);
    if (stage === 'decode') await vi.waitFor(() => expect(decode).toHaveBeenCalled());
    if (stage === 'persist') await vi.waitFor(() => expect(lib.putSample).toHaveBeenCalled());
    app.store.apply('Delete channel', (p) => E.removeChannels(p, [target.id]));
    const deleted = app.store.project;
    gate.resolve(stage === 'decode' ? decoded : new ArrayBuffer(4));
    expect(await result).toMatchObject({ message: 'That channel no longer exists.' });
    expect({ cached: app.samples.ids().length, engine: engine.captureRenderSnapshot().samples.size }).toEqual({ cached: 0, engine: 0 });
    expect(app.store.project).toBe(deleted);
    app.store.undo();
    expect(app.store.project).toBe(original);
  });

  it('loads audio into a surviving channel using its current settings and preserves undo', async () => {
    const { app, files, decode, decoded } = setup();
    const engine = new Engine(app.store);
    app.samples = new SampleCache(engine);
    const target = app.store.project.channels[0];
    const gate = deferred();
    decode.mockReturnValue(gate.promise);
    const importing = files.importAudio({ size: 4, arrayBuffer: async () => new ArrayBuffer(4) }, { name: 'tone.wav', channel: target.id });
    await vi.waitFor(() => expect(decode).toHaveBeenCalled());
    app.store.apply('Rename channel', (p) => E.updateChannel(p, target.id, { name: 'Renamed', volume: 0.4 }));
    const before = app.store.project;
    gate.resolve(decoded);
    const result = await importing;
    expect(app.store.project.channels[0]).toMatchObject({ id: target.id, name: 'Renamed', volume: 0.4, sample: result.sampleId, type: 'sampler' });
    expect(app.samples.has(result.sampleId)).toBe(true);
    expect(engine.captureRenderSnapshot().samples.has(result.sampleId)).toBe(true);
    app.store.undo();
    expect(app.store.project).toBe(before);
    app.store.redo();
    expect(app.store.project.channels[0].sample).toBe(result.sampleId);
    expect(app.samples.has(result.sampleId)).toBe(true);
  });

  it('keeps ordinary edits made while audio is decoding', async () => {
    const { app, files, decode, decoded } = setup();
    const gate = deferred();
    decode.mockReturnValue(gate.promise);
    const importing = files.importAudio({ size: 4, arrayBuffer: async () => new ArrayBuffer(4) }, { name: 'tone.wav' });
    await vi.waitFor(() => expect(decode).toHaveBeenCalled());
    app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 99 }));
    gate.resolve(decoded);
    const result = await importing;
    expect(app.store.project.bpm).toBe(99);
    expect(app.store.project.channels.some((c) => c.id === result.channelId)).toBe(true);
    app.store.undo();
    expect(app.store.project.bpm).toBe(99);
  });

  it('cancels MIDI import if another project opens while reading', async () => {
    const { app, files } = setup();
    const gate = deferred();
    const importing = files.importMidiBlob({ arrayBuffer: () => gate.promise }, 'song.mid');
    const result = importing.then(() => null, (err) => err);
    const next = newProject();
    app.store.load(next);
    gate.resolve(writeMidi({ ppq: 96, bpm: 120, tracks: [{ notes: [{ key: 60, tick: 0, len: 96, vel: 100 }] }] }).buffer);
    expect(await result).toMatchObject({ message: 'Import cancelled because another project was opened.' });
    expect(app.store.project === next).toBe(true);
    expect(app.store.canUndo).toBe(false);
  });

  it('cancels cloud audio import if the project changes during download', async () => {
    const { app, files } = setup();
    const gate = deferred();
    const read = vi.fn(() => gate.promise);
    vi.stubGlobal('puter', { auth: { isSignedIn: () => true }, fs: { stat: async () => ({ size: 4 }), read } });
    const importing = files.importAudioFromPath('/tone.wav');
    const result = importing.then(() => null, (err) => err);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const next = newProject();
    app.store.load(next);
    gate.resolve({ size: 4, arrayBuffer: async () => new ArrayBuffer(4) });
    expect(await result).toMatchObject({ message: 'Import cancelled because another project was opened.' });
    expect(app.store.project === next).toBe(true);
    expect(app.samples.set).not.toHaveBeenCalled();
  });
});
