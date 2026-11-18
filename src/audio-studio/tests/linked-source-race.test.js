import { afterEach, expect, it, vi } from 'vitest';
import { AudioFile } from '../src/model/audio-file.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { linkSource, syncLinkedSources } from '../src/multitrack/insert.js';
import { Dsp } from '../src/audio/dsp.js';
import { wasmBytes } from './fx-wasm.js';

const mock = vi.hoisted(() => ({ dsp: vi.fn() }));
vi.mock('../src/audio/dsp.js', async (original) => ({ ...(await original()), dsp: mock.dsp }));
const processor = new Dsp(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}));
afterEach(() => { vi.useRealTimers(); mock.dsp.mockReset(); });

function setup() {
  const doc = new AudioFile({ name: 'Source.wav', sampleRate: 48000, channels: [Channel.fromSamples(Float32Array.of(0.25, 0.5))] });
  const session = new Session({ name: 'Session', sampleRate: 48000, tracks: 1 });
  const edit = (value) => doc.apply('Edit', { ...doc.state, channels: [Channel.fromSamples(Float32Array.of(value, value))] });
  return { doc, session, edit };
}

it('links the latest audio when its document changes during source preparation', async () => {
  const { doc, session, edit } = setup();
  const linking = linkSource(session, doc);
  edit(0.75);
  const id = await linking;
  await linkSource(session, doc);
  expect([...session.pool.get(id).channels[0].toArray()]).toEqual([0.75, 0.75]);
  expect(session.pool.get(id).stateRef).toBe(doc.state);
  expect(session.pool.size).toBe(1);
});

it('does not let delayed resampling overwrite a newer same-rate source edit', async () => {
  vi.useFakeTimers();
  const { doc, session, edit } = setup();
  const id = await linkSource(session, doc);
  const app = { documents: [doc, session], syncGraph: vi.fn() };
  let ready;
  mock.dsp.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
  edit(0.5);
  doc.apply('Interpret Sample Rate', { ...doc.state, sampleRate: 24000 });
  syncLinkedSources(app, doc);
  await vi.advanceTimersByTimeAsync(300);
  edit(0.75);
  doc.apply('Interpret Sample Rate', { ...doc.state, sampleRate: 48000 });
  syncLinkedSources(app, doc);
  await Promise.resolve();
  ready(processor);
  await vi.advanceTimersByTimeAsync(0);
  expect([...session.pool.get(id).channels[0].toArray()]).toEqual([0.75, 0.75]);
  expect(session.pool.get(id).stateRef).toBe(doc.state);
});

it.each([24000, 48000])('reuses an unchanged source after preparing it at %i Hz', async (rate) => {
  mock.dsp.mockResolvedValue(processor);
  const { doc } = setup();
  const session = new Session({ name: 'Session', sampleRate: rate, tracks: 1 });
  const id = await linkSource(session, doc);
  const source = session.pool.get(id);
  const version = session.poolVersion;
  const calls = mock.dsp.mock.calls.length;
  expect(source.channels[0].length).toBe(Math.round(doc.length * rate / doc.sampleRate));
  expect(await linkSource(session, doc)).toBe(id);
  expect(session.pool.get(id)).toBe(source);
  expect(session.poolVersion).toBe(version);
  expect(mock.dsp).toHaveBeenCalledTimes(calls);
});
