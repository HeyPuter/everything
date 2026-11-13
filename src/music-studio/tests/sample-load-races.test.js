import { describe, it, expect, vi } from 'vitest';
import { ProjectFiles } from '../src/storage/files.js';
import { Library } from '../src/storage/library.js';
import { memoryDB } from '../src/storage/idb.js';
import { SampleCache } from '../src/audio/samples.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';
import { App } from '../src/app.js';

describe('background sample loading', () => {
  it('releases decoded samples and render data when New Project replaces their owner', async () => {
    const project = { ...newProject(), samples: { old: { id: 'old', name: 'old.wav' } } };
    const app = new App(document.createElement('div'), { project });
    app.samples.set('old', { channels: [new Float32Array(48)], rate: 48000 });
    expect(app.samples.ids()).toEqual(['old']);
    expect(app.engine.captureRenderSnapshot().samples.has('old')).toBe(true);
    expect(await app.newProject(newProject)).toBe(true);
    expect(app.samples.ids()).toEqual([]);
    expect(app.engine.captureRenderSnapshot().samples.size).toBe(0);
  });

  it('retains samples still referenced by a replacement and samples needed by undo', async () => {
    const project = { ...newProject(), samples: { keep: { id: 'keep', name: 'keep.wav' } } };
    const app = new App(document.createElement('div'), { project });
    const audio = { channels: [new Float32Array(48)], rate: 48000 };
    app.samples.set('keep', audio);
    app.store.apply('Remove sample', (p) => ({ ...p, samples: {} }));
    expect(app.samples.has('keep')).toBe(true);
    app.store.undo();
    expect(app.samples.get('keep').channels).toBe(audio.channels);
    app.store.markSaved();
    await app.newProject(() => ({ ...project, name: 'Replacement with same sample' }));
    expect(app.samples.get('keep').channels).toBe(audio.channels);
    expect(app.engine.captureRenderSnapshot().samples.has('keep')).toBe(true);
  });

  it('does not restore old samples to the engine after opening another project', async () => {
    let release;
    const decoding = new Promise((r) => { release = r; });
    const decode = vi.fn(() => decoding);
    const engine = { stop: vi.fn(), loadSample: vi.fn(), unloadSample: vi.fn() };
    const app = {
      store: new Store(newProject()), engine, samples: new SampleCache(engine),
      emit: vi.fn(), notify: vi.fn(),
    };
    const lib = new Library({ db: memoryDB(), decode });
    await lib.putSample('old', { data: new ArrayBuffer(4), name: 'old.wav' });
    const files = new ProjectFiles(app, lib);
    const old = { ...newProject(), samples: { old: { id: 'old', name: 'old.wav', local: 'old' } } };
    const loading = files.loadProject(old, null);
    await vi.waitFor(() => expect(decode).toHaveBeenCalled());
    await files.loadProject(newProject(), null);
    release({ channels: [new Float32Array(48)], rate: 48000 });
    await loading;
    expect(app.samples.ids()).toEqual([]);
    expect(engine.loadSample).not.toHaveBeenCalled();
    expect(app.notify).not.toHaveBeenCalled();
  });
});
