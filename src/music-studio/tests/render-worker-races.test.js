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

it('terminates a failed worker and prevents its late errors from rejecting replacement renders', async () => {
  const workers = [];
  vi.stubGlobal('Worker', class {
    constructor() { this.messages = []; this.terminate = vi.fn(); workers.push(this); }
    postMessage(message) { this.messages.push(message); }
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: { get: () => '' }, arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer })));
  const engine = new Engine(new Store(newProject()));
  const first = engine.render().catch((e) => e.message);
  await vi.waitFor(() => expect(workers[0]?.messages).toHaveLength(1));
  const lateError = workers[0].onerror;
  lateError({ message: 'Worker crashed' });
  expect(await first).toBe('Worker crashed');
  const second = engine.render().then(() => 'completed', (e) => e.message);
  await vi.waitFor(() => expect(workers[1]?.messages).toHaveLength(1));
  lateError({ message: 'Late error from failed worker' });
  const m = workers[1].messages[0];
  workers[1].onmessage({ data: { type: 'done', id: m.id, channels: [new Float32Array(1), new Float32Array(1)], rate: m.rate } });
  expect({ terminations: workers[0].terminate.mock.calls.length, replacement: await second }).toEqual({ terminations: 1, replacement: 'completed' });
});
