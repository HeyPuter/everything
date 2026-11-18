import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let worker;
beforeEach(async () => {
  vi.resetModules();
  worker = { postMessage() {} };
  vi.stubGlobal('self', worker);
  await import('../src/engine/offline-worker.js');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const silence = { rate: 48000, tracks: [], master: { gain: 1 } };

describe('offline worker cancellation', () => {
  it('services Cancel messages during a render that never requests source chunks', async () => {
    // Control elapsed processing time without a large or slow audio fixture.
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 16));
    let blocks = 0;
    let cancelTimer;
    let finish;
    const completed = new Promise((resolve) => { finish = resolve; });
    worker.postMessage = (m) => {
      if (m.type === 'data' && ++blocks === 1) {
        // Worker messages arrive as tasks, not promise microtasks.
        cancelTimer = setTimeout(() => worker.onmessage({ data: { type: 'cancel', id: 1 } }), 0);
      }
      if (m.type === 'done' || m.type === 'error') finish(m);
    };
    worker.onmessage({ data: { type: 'render', id: 1, graph: silence, start: 0, end: 8192 * 64 } });
    const result = await completed;
    clearTimeout(cancelTimer);
    expect(result).toMatchObject({ type: 'error', message: 'cancelled' });
    expect(blocks).toBeLessThan(64);
  });

  it('finishes cancellation while waiting for source data and can render another job', async () => {
    let finish;
    const completed = new Promise((resolve) => { finish = resolve; });
    const sent = [];
    worker.postMessage = (m) => {
      sent.push(m.type);
      if (m.type === 'need') setTimeout(() => worker.onmessage({ data: { type: 'cancel', id: 2 } }), 0);
      if (m.type === 'done' || m.type === 'error') finish(m);
    };
    const graph = { ...silence, tracks: [{ id: 't', gain: 1, pan: 0, clips: [{ id: 'c', source: 'audio', channels: 1, start: 0, offset: 0, length: 8192, gain: 1 }] }] };
    worker.onmessage({ data: { type: 'render', id: 2, graph, start: 0, end: 8192 } });
    let timer;
    const result = await Promise.race([completed, new Promise((resolve) => { timer = setTimeout(() => resolve('timed out'), 100); })]);
    clearTimeout(timer);
    // A late chunk must not revive a cancelled render. It also lets the
    // unfixed implementation finish, avoiding an orphaned test job.
    worker.onmessage({ data: { type: 'chunk', id: 2, key: 'audio', index: 0, channels: [new Float32Array(8192)] } });
    await completed;
    expect(result).toMatchObject({ type: 'error', message: 'cancelled' });
    expect(sent).not.toContain('data');
    const retry = new Promise((resolve) => { finish = resolve; });
    worker.onmessage({ data: { type: 'render', id: 3, graph: silence, start: 0, end: 128 } });
    expect(await retry).toMatchObject({ type: 'done', id: 3 });
  });
});
