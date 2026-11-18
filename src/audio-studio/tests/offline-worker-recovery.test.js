import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ workers: [] }));
vi.mock('../src/audio/dsp.js', () => ({ dspModule: async () => ({}) }));
vi.mock('../src/engine/offline-worker.js?worker', () => ({
  default: class {
    constructor() {
      this.sent = [];
      this.terminate = vi.fn();
      mock.workers.push(this);
    }
    postMessage(m) { this.sent.push(m); }
  },
}));

let renderGraph;
const graph = { rate: 48000, tracks: [], master: { gain: 1 } };
beforeEach(async () => {
  vi.resetModules();
  mock.workers.length = 0;
  ({ renderGraph } = await import('../src/engine/offline.js'));
});

describe('offline worker failure recovery', () => {
  it('terminates a failed worker and isolates replacement jobs from its late errors', async () => {
    const first = renderGraph(graph, new Map(), { end: 4 });
    const firstResult = Promise.allSettled([first]);
    await vi.waitFor(() => expect(mock.workers).toHaveLength(1));
    const failed = mock.workers[0];
    failed.onerror({ message: 'Render worker failed' });
    expect((await firstResult)[0].reason.message).toBe('Render worker failed');
    const retry = renderGraph(graph, new Map(), { end: 4 });
    const retryResult = Promise.allSettled([retry]);
    await vi.waitFor(() => expect(mock.workers).toHaveLength(2));
    const replacement = mock.workers[1];
    const id = replacement.sent.find((m) => m.type === 'render').id;
    // An already-queued error from the old worker must not reject new jobs.
    failed.onerror({ message: 'Another old error' });
    replacement.onmessage({ data: { type: 'done', id } });
    expect((await retryResult)[0].status).toBe('fulfilled');
    expect(failed.terminate).toHaveBeenCalledOnce();
    expect(replacement.terminate).not.toHaveBeenCalled();
  });

  it('keeps another job running when a render reports a job-level error', async () => {
    const results = Promise.allSettled([
      renderGraph(graph, new Map(), { end: 4 }),
      renderGraph(graph, new Map(), { end: 4 }),
    ]);
    await vi.waitFor(() => expect(mock.workers[0]?.sent).toHaveLength(2));
    const worker = mock.workers[0];
    const [a, b] = worker.sent;
    worker.onmessage({ data: { type: 'error', id: a.id, message: 'Bad effect' } });
    worker.onmessage({ data: { type: 'done', id: b.id } });
    const settled = await results;
    expect(settled.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(settled[0].reason.message).toBe('Bad effect');
    expect(mock.workers).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
  });
});
