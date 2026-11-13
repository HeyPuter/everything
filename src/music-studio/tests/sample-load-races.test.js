import { describe, it, expect, vi } from 'vitest';
import { ProjectFiles } from '../src/storage/files.js';
import { Library } from '../src/storage/library.js';
import { memoryDB } from '../src/storage/idb.js';
import { SampleCache } from '../src/audio/samples.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';

describe('background sample loading', () => {
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
