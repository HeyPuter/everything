import { expect, it, vi } from 'vitest';
import { Library, fromBase64 } from '../src/storage/library.js';
import { memoryDB } from '../src/storage/idb.js';
import { SampleCache } from '../src/audio/samples.js';
import { newProject } from '../src/model/demo.js';

const bytes = new Uint8Array([1, 2, 3, 4]);
const remote = { id: 'remote', name: 'remote.wav', local: 'remote', path: '/Samples/remote.wav' };
const local = { id: 'local', name: 'local.wav', local: 'local', path: null };
const decode = async (data) => ({ channels: [Float32Array.from(new Uint8Array(data))], rate: 48000 });

async function setup({ signedIn = true, failWrites = false } = {}) {
  const db = memoryDB();
  await db.put('samples', 'local', { data: bytes.buffer, name: local.name });
  const get = db.get;
  db.get = vi.fn((store, key) => {
    if (store === 'samples' && key === 'remote') return Promise.reject(new Error('Local sample storage is unavailable'));
    return get(store, key);
  });
  if (failWrites) db.put = vi.fn(async () => { throw new Error('Local storage is full'); });
  const puter = {
    isSignedIn: () => signedIn,
    readFile: vi.fn(async () => ({ type: 'audio/wav', arrayBuffer: async () => bytes.buffer })),
  };
  return { db, puter, lib: new Library({ db, puter, decode }) };
}

it('loads a cloud sample after a local read failure and continues loading later samples', async () => {
  const { lib, puter } = await setup();
  const cache = new SampleCache();
  expect(await lib.loadSamples({ samples: { remote, local } }, cache)).toEqual({ loaded: 2, missing: [] });
  expect(cache.ids()).toEqual(['remote', 'local']);
  expect([...cache.get('remote').channels[0]]).toEqual([...bytes]);
  expect(puter.readFile).toHaveBeenCalledExactlyOnceWith(remote.path);
});

it('reports an unreadable local sample while signed out and still loads later samples', async () => {
  const { lib, puter } = await setup({ signedIn: false });
  const cache = new SampleCache();
  expect(await lib.loadSamples({ samples: { remote, local } }, cache)).toEqual({ loaded: 1, missing: ['remote.wav'] });
  expect(cache.ids()).toEqual(['local']);
  expect(puter.readFile).not.toHaveBeenCalled();
});

it('tries the sample ID after its local alias cannot be read', async () => {
  const { lib, puter } = await setup();
  const data = await lib.sampleBytes({ ...local, local: 'remote', path: '/Samples/local.wav' });
  expect(new Uint8Array(data)).toEqual(bytes);
  expect(puter.readFile).not.toHaveBeenCalled();
});

it('embeds recovered cloud audio when local cache reads and writes fail', async () => {
  const { lib, puter } = await setup({ failWrites: true });
  const project = { ...newProject(), samples: { remote } };
  const result = await lib.exportFile(project, {});
  expect(result.missing).toEqual([]);
  expect(result.skipped).toBe(false);
  const data = JSON.parse(await result.blob.text());
  expect(new Uint8Array(fromBase64(data.embedded.remote.data))).toEqual(bytes);
  const restored = new Library({ db: memoryDB(), decode, puter: { isSignedIn: () => false } });
  const reopened = await restored.readProjectText(JSON.stringify(data));
  const cache = new SampleCache();
  expect(await restored.loadSamples(reopened, cache)).toEqual({ loaded: 1, missing: [] });
  expect([...cache.get('remote').channels[0]]).toEqual([...bytes]);
  expect(puter.readFile).toHaveBeenCalledExactlyOnceWith(remote.path);
});
