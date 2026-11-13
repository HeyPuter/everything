import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { Store } from '../src/model/store.js';
import { createChannel, createProject } from '../src/model/project.js';
import { updateChannel } from '../src/model/edits.js';

const engines = [];
const workers = [];
beforeEach(() => {
  vi.stubGlobal('Worker', class {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, headers: { get: () => '' },
    arrayBuffer: async () => Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]).buffer,
  })));
});
afterEach(() => {
  for (const engine of engines.splice(0)) clearTimeout(engine._seqTimer);
  workers.length = 0;
  vi.unstubAllGlobals();
});

function setup(count) {
  const p = createProject();
  p.channels = Array.from({ length: count }, () => createChannel());
  const store = new Store(p);
  const engine = new Engine(store);
  engines.push(engine);
  const sent = new Map();
  engine.node = { port: { postMessage(m) { if (m.type === 'channel') sent.set(m.cfg.slot, m.cfg); } } };
  return { p, store, engine, sent };
}

async function renderedChannels(engine) {
  const pending = engine.render();
  await vi.waitFor(() => expect(workers.some((w) => w.messages.length)).toBe(true));
  const worker = workers.find((w) => w.messages.length);
  const message = worker.messages.shift();
  worker.onmessage({ data: { type: 'done', id: message.id, channels: [new Float32Array(1), new Float32Array(1)], rate: message.rate } });
  await pending;
  return message.channels;
}

it.each(['live sync', 'offline render'])('keeps channel solo inspection linear during %s', async (mode) => {
  const count = 100;
  const { p, store, engine, sent } = setup(count);
  let reads = 0;
  for (const ch of p.channels) Object.defineProperty(ch, 'solo', { get() { reads++; return false; } });
  let configs;
  if (mode === 'live sync') { store.load(p); configs = [...sent.values()]; }
  else configs = await renderedChannels(engine);
  expect(configs).toHaveLength(count);
  expect(configs.every((c) => c.gain === 1)).toBe(true);
  expect(reads).toBeLessThanOrEqual(count * 8);
});

it.each(['live sync', 'offline render'])('updates mute and solo gains correctly during %s', async (mode) => {
  const { p, store, engine, sent } = setup(3);
  store.load(p);
  const gains = async () => (mode === 'live sync' ? [...sent.values()] : await renderedChannels(engine)).map((c) => c.gain);
  expect(await gains()).toEqual([1, 1, 1]);
  store.apply('Solo', (next) => updateChannel(next, p.channels[0].id, { solo: true }));
  expect(await gains()).toEqual([1, 0, 0]);
  store.apply('Mute solo', (next) => updateChannel(next, p.channels[0].id, { mute: true }));
  expect(await gains()).toEqual([0, 0, 0]);
  store.undo();
  expect(await gains()).toEqual([1, 0, 0]);
  store.undo();
  expect(await gains()).toEqual([1, 1, 1]);
});
