import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProjectFiles } from '../src/storage/files.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { writeMidi } from '../src/io/midi.js';

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
