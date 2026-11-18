import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ workers: [], failSpawn: false }));
vi.mock('../src/audio/dsp.js', () => ({ dspModule: async () => ({}) }));
vi.mock('../src/analysis/worker.js?worker', () => ({
  default: class {
    constructor() {
      if (mock.failSpawn) throw new Error('Cannot start worker');
      this.sent = [];
      this.reply = true;
      this.terminate = vi.fn();
      mock.workers.push(this);
    }
    postMessage(message) {
      this.sent.push(message);
      if (message.type !== 'init' && this.reply) {
        queueMicrotask(() => this.onmessage({ data: { id: message.id, result: message.op === 'open' ? null : 'result' } }));
      }
    }
  },
}));

import { WorkerPool } from '../src/analysis/pool.js';

beforeEach(() => { mock.workers.length = 0; mock.failSpawn = false; });

describe('analysis worker failure recovery', () => {
  it('rejects outstanding jobs, replaces a failed worker, and rejects its lost streaming session', async () => {
    const pool = new WorkerPool(1);
    const session = await pool.session('stats', { rate: 48000, channels: 1 });
    const failed = mock.workers[0];
    failed.reply = false;
    const jobs = [pool.call({ op: 'average' }), pool.call({ op: 'pitch' })];
    const settled = Promise.allSettled(jobs);
    await vi.waitFor(() => expect(pool.pending).toBe(2));
    failed.onerror({ message: 'Worker crashed' });
    expect((await settled).map((r) => r.reason.message)).toEqual(['Worker crashed', 'Worker crashed']);
    expect(pool.pending).toBe(0);
    const retry = pool.call({ op: 'average' });
    expect(await Promise.race([retry, new Promise((resolve) => setTimeout(() => resolve('timed out'), 100))])).toBe('result');
    expect(failed.terminate).toHaveBeenCalledOnce();
    expect(pool.workers).not.toContain(failed);
    expect(mock.workers).toHaveLength(2);
    await expect(session.push([new Float32Array(8)])).rejects.toThrow('Worker crashed');
    await expect(session.close()).rejects.toThrow('Worker crashed');
    expect(pool.pending).toBe(0);
  });

  it('keeps healthy workers and their streaming sessions when another worker fails', async () => {
    const pool = new WorkerPool(2);
    const session = await pool.session('stats', { rate: 48000, channels: 1 });
    const [healthy, failed] = mock.workers;
    failed.onerror({ message: 'Worker crashed' });
    expect(pool.workers).toContain(healthy);
    expect(pool.workers).not.toContain(failed);
    mock.failSpawn = true; // A healthy session must not depend on replacing another worker.
    expect(await session.push([new Float32Array(8)])).toBe('result');
    expect(await session.close()).toBe('result');
    mock.failSpawn = false;
    expect(await pool.call({ op: 'average' })).toBe('result');
    expect(pool.workers).toHaveLength(2);
    expect(mock.workers).toHaveLength(3);
    expect(healthy.terminate).not.toHaveBeenCalled();
  });
});
