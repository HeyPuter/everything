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

it('removes failed render requests and their abort listeners when posting to the worker throws', async () => {
  const workers = [];
  vi.stubGlobal('Worker', class {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(message) {
      if (!this.failed) {
        this.failed = true;
        throw new DOMException('The audio buffers could not be cloned', 'DataCloneError');
      }
      this.messages.push(message);
    }
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: { get: () => '' }, arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer })));
  const engine = new Engine(new Store(newProject()));
  const controller = new AbortController();
  await expect(engine.render({ signal: controller.signal })).rejects.toMatchObject({ name: 'DataCloneError' });
  controller.abort();
  expect(workers[0].messages).toEqual([]);
  expect(engine._renderJobs.size).toBe(0);
  const retry = engine.render();
  await vi.waitFor(() => expect(workers[0].messages).toHaveLength(1));
  const message = workers[0].messages[0];
  workers[0].onmessage({ data: { type: 'done', id: message.id, channels: [new Float32Array(1), new Float32Array(1)], rate: message.rate } });
  expect((await retry).rate).toBe(48000);
});

it.each(['done', 'error'])('settles an aborted render before the worker responds and ignores late %s messages', async (lateType) => {
  const workers = [];
  vi.stubGlobal('Worker', class {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: { get: () => '' }, arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer })));
  const engine = new Engine(new Store(newProject()));
  const controller = new AbortController();
  const progress = vi.fn();
  let result;
  const canceled = engine.render({ signal: controller.signal, onProgress: progress }).then(() => { result = 'done'; }, (err) => { result = err.name; });
  const other = engine.render();
  await vi.waitFor(() => expect(workers[0]?.messages).toHaveLength(2));
  const worker = workers[0];
  const [first, second] = worker.messages;
  const complete = (id) => worker.onmessage({ data: { type: 'done', id, channels: [new Float32Array(1), new Float32Array(1)], rate: 48000 } });
  try {
    controller.abort();
    expect(worker.messages.at(-1)).toEqual({ type: 'cancel', id: first.id });
    const registered = engine._renderJobs.size;
    await Promise.resolve();
    await Promise.resolve();
    const early = result ?? 'pending';
    worker.onmessage({ data: { type: 'progress', id: first.id, done: 0.9 } });
    const progressCalls = progress.mock.calls.length;
    if (lateType === 'done') complete(first.id);
    else worker.onmessage({ data: { type: 'error', id: first.id, message: 'cancelled' } });
    complete(second.id);
    expect((await other).rate).toBe(48000);
    await canceled;
    expect({ registered, early, progressCalls, result }).toEqual({ registered: 1, early: 'AbortError', progressCalls: 0, result: 'AbortError' });
    expect(engine._renderJobs.size).toBe(0);
  } finally {
    complete(first.id);
    complete(second.id);
    await Promise.all([canceled, other]);
  }
});

it('settles cancellation even if notifying the worker fails and leaves it usable for another render', async () => {
  const workers = [];
  vi.stubGlobal('Worker', class {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(message) {
      if (message.type === 'cancel') throw new Error('Worker cannot receive cancellation');
      this.messages.push(message);
    }
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: { get: () => '' }, arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer })));
  const engine = new Engine(new Store(newProject()));
  const controller = new AbortController();
  const first = engine.render({ signal: controller.signal }).catch((err) => err.name);
  await vi.waitFor(() => expect(workers[0]?.messages).toHaveLength(1));
  controller.abort();
  expect(await first).toBe('AbortError');
  expect(engine._renderJobs.size).toBe(0);
  const second = engine.render();
  await vi.waitFor(() => expect(workers[0].messages).toHaveLength(2));
  for (const message of workers[0].messages) workers[0].onmessage({ data: { type: 'done', id: message.id, channels: [new Float32Array(1), new Float32Array(1)], rate: 48000 } });
  expect((await second).rate).toBe(48000);
  expect(engine._renderJobs.size).toBe(0);
});
