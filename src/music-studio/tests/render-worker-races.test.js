import { it, expect, vi, afterEach } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';

afterEach(() => vi.unstubAllGlobals());

it('shares one worker when initial renders start concurrently', async () => {
  const workers = [];
  vi.stubGlobal('Worker', class {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    headers: { get: () => 'application/octet-stream' },
    arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer,
  })));
  const engine = new Engine(new Store(newProject()));
  const renders = [engine.render(), engine.render()];
  await vi.waitFor(() => expect(workers.flatMap((w) => w.messages)).toHaveLength(2));
  for (const w of workers) for (const m of w.messages) {
    w.onmessage({ data: { type: 'done', id: m.id, channels: [new Float32Array(1), new Float32Array(1)], rate: m.rate } });
  }
  const results = await Promise.all(renders);
  expect(results).toHaveLength(2);
  expect(workers).toHaveLength(1);
});
