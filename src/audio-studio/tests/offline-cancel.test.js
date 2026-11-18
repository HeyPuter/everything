import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ workers: [], module: vi.fn() }));
vi.mock('../src/audio/dsp.js', () => ({ dspModule: mock.module }));
vi.mock('../src/engine/offline-worker.js?worker', () => ({
  default: class {
    constructor() { this.sent = []; mock.workers.push(this); }
    postMessage(message) {
      this.sent.push(message);
      if (message.type === 'render') queueMicrotask(() => {
        this.onmessage({ data: { type: 'data', id: message.id, at: 0, channels: [new Float32Array(4), new Float32Array(4)] } });
        this.onmessage({ data: { type: 'done', id: message.id } });
      });
    }
  },
}));

let renderGraph;
const graph = { rate: 48000, tracks: [], master: { gain: 1 } };
beforeEach(async () => {
  vi.resetModules();
  mock.workers.length = 0;
  mock.module.mockReset().mockResolvedValue({});
  ({ renderGraph } = await import('../src/engine/offline.js'));
});

describe('offline render cancellation', () => {
  it('does not start work for an already-cancelled render', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(renderGraph(graph, new Map(), { end: 4, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.module).not.toHaveBeenCalled();
    expect(mock.workers).toHaveLength(0);
  });

  it('honors cancellation while the DSP module is loading', async () => {
    let ready;
    mock.module.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
    const controller = new AbortController();
    const pending = renderGraph(graph, new Map(), { end: 4, signal: controller.signal });
    controller.abort();
    ready({});
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.workers).toHaveLength(0);
  });

  it('does not return a result if Cancel races with the worker completion', async () => {
    const controller = new AbortController();
    await expect(renderGraph(graph, new Map(), {
      end: 4, signal: controller.signal, onData: () => controller.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.workers[0].sent.map((m) => m.type)).toEqual(['render', 'cancel']);
  });

  it('removes the abort listener after a successful render', async () => {
    const controller = new AbortController();
    const out = await renderGraph(graph, new Map(), { end: 4, signal: controller.signal });
    expect(out.map((c) => c.length)).toEqual([4, 4]);
    controller.abort();
    expect(mock.workers[0].sent.map((m) => m.type)).toEqual(['render']);
  });
});
