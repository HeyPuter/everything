import { expect, it, vi } from 'vitest';
import { Library } from '../src/storage/library.js';
import { memoryDB } from '../src/storage/idb.js';
import { SampleCache } from '../src/audio/samples.js';
import { encodeWav, decodeWavSamples } from '../src/io/wav.js';

const good = encodeWav({ channels: [new Float32Array([0.25, -0.25])], rate: 48000 }, { bits: 16, dither: false });
const bad = new Uint8Array([1, 2, 3, 4]).buffer;
const remote = { id: 'remote', local: 'remote', path: '/Samples/remote.wav', name: 'remote.wav' };
const local = { id: 'local', local: 'local', path: null, name: 'local.wav' };
async function setup(cached = bad) {
  const db = memoryDB();
  const decode = vi.fn(async (bytes) => decodeWavSamples(Uint8Array.from(new Uint8Array(bytes)).buffer));
  const puter = { isSignedIn: () => true, readFile: vi.fn(async () => new Blob([good], { type: 'audio/wav' })) };
  const lib = new Library({ db, decode, puter });
  await lib.putSample(remote.id, { data: cached, name: remote.name });
  await lib.putSample(local.id, { data: good, name: local.name });
  return { lib, puter, decode, cache: new SampleCache() };
}

it('recovers an undecodable local sample from its cloud copy and caches the recovered bytes', async () => {
  const { lib, puter, cache } = await setup();
  expect(await lib.loadSamples({ samples: { remote } }, cache)).toEqual({ loaded: 1, missing: [] });
  expect(cache.get(remote.id).channels[0][0]).toBeCloseTo(0.25, 3);
  expect(puter.readFile).toHaveBeenCalledExactlyOnceWith(remote.path);
  const reloaded = new SampleCache();
  expect(await lib.loadSamples({ samples: { remote } }, reloaded)).toEqual({ loaded: 1, missing: [] });
  expect(puter.readFile).toHaveBeenCalledOnce();
});

it.each(['unavailable', 'undecodable'])('bounds the retry for an %s cloud copy and loads later samples', async (failure) => {
  const { lib, puter, cache, decode } = await setup();
  if (failure === 'unavailable') puter.readFile.mockRejectedValue(new Error('Offline'));
  else puter.readFile.mockResolvedValue(new Blob([bad]));
  expect(await lib.loadSamples({ samples: { remote, local } }, cache)).toEqual({ loaded: 1, missing: [remote.name] });
  expect(puter.readFile).toHaveBeenCalledOnce();
  expect(decode).toHaveBeenCalledTimes(failure === 'unavailable' ? 2 : 3);
  expect(cache.ids()).toEqual([local.id]);
});

it('discards recovery audio after the project is replaced during the download', async () => {
  const { lib, puter, cache } = await setup();
  let resolve;
  let current = true;
  puter.readFile.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const pending = lib.loadSamples({ samples: { remote, local } }, cache, { isCurrent: () => current });
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  current = false;
  resolve(new Blob([good]));
  expect(await pending).toEqual({ loaded: 0, missing: [] });
  expect(cache.ids()).toEqual([]);
});

it('does not download healthy cached audio or prompt for sign-in to recover damaged audio', async () => {
  const { lib, puter, cache } = await setup(good);
  expect(await lib.loadSamples({ samples: { remote } }, cache)).toEqual({ loaded: 1, missing: [] });
  expect(puter.readFile).not.toHaveBeenCalled();
  await lib.putSample(remote.id, { data: bad, name: remote.name });
  puter.isSignedIn = () => false;
  expect(await lib.loadSamples({ samples: { remote } }, new SampleCache())).toEqual({ loaded: 0, missing: [remote.name] });
  expect(puter.readFile).not.toHaveBeenCalled();
});

it('ignores a retry decode failure after the project has been replaced', async () => {
  const { lib, cache, decode } = await setup();
  let reject;
  let current = true;
  decode.mockRejectedValueOnce(new Error('Damaged cache')).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const pending = lib.loadSamples({ samples: { remote, local } }, cache, { isCurrent: () => current });
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  current = false;
  reject(new Error('Decode failed after replacement'));
  expect(await pending).toEqual({ loaded: 0, missing: [] });
  expect(cache.ids()).toEqual([]);
});
