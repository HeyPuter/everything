// The main-thread side of the geometry worker protocol, against a fake worker:
// a dead, aborted or hung worker is replaced and nothing waits forever.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KernelClient, KernelRestartError } from '../src/kernel/client';
import type { BuildRequest, WorkerRequest, WorkerResponse } from '../src/kernel/protocol';

class FakeWorker {
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;
  postMessage(msg: WorkerRequest) { this.sent.push(structuredClone(msg)); }
  terminate() { this.terminated = true; }
  reply(r: WorkerResponse) { this.onmessage?.({ data: r } as MessageEvent<WorkerResponse>); }
  /** Answers every request of a type that has not been answered yet. */
  answer(type: WorkerRequest['type'], result: unknown = true) {
    for (const m of this.sent.filter((m) => m.type === type)) this.reply({ id: m.id, ok: true, result });
  }
  crash(message = 'boom') { this.onerror?.({ message, preventDefault() {} } as ErrorEvent); }
}

function setup(opts: { stallMs?: number; hangMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const client = new KernelClient({ ...opts, createWorker: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; } });
  const restarts: [string, boolean][] = [];
  client.onRestart = (reason, building) => restarts.push([reason, building]);
  return { client, workers, restarts, last: () => workers[workers.length - 1] };
}

const req = (upTo: number): BuildRequest => ({ features: [], upTo, blobs: {}, quality: 1 });
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.useRealTimers());

describe('kernel client recovery', () => {
  it('rejects requests in flight and restarts when the worker dies', async () => {
    const { client, workers, restarts, last } = setup();
    last().answer('init');
    await client.ready;
    const measure = client.measure({ kind: 'face', index: 0 }, { kind: 'face', index: 1 });
    const build = client.build(req(1));
    workers[0].crash('Out of memory');
    await expect(measure).rejects.toBeInstanceOf(KernelRestartError);
    await expect(build).rejects.toThrow(/restarted because of an error \(Out of memory\)/);
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].sent[0].type).toBe('init');
    expect(restarts).toEqual([['of an error (Out of memory)', true]]);
    // The new worker serves later requests.
    const mass = client.massProperties();
    workers[1].answer('mass', null);
    await expect(mass).resolves.toBeNull();
  });

  it('restarts after a fatal (aborted kernel) reply', async () => {
    const { client, workers, restarts, last } = setup();
    last().answer('init');
    await client.ready;
    const exp = client.exportFile('step');
    const id = workers[0].sent.find((m) => m.type === 'export')!.id;
    workers[0].reply({ id, ok: false, error: 'The geometry kernel failed', fatal: true });
    await expect(exp).rejects.toThrow('The geometry kernel failed');
    expect(workers).toHaveLength(2);
    expect(restarts).toEqual([['the OpenCascade kernel failed', false]]);
  });

  it('does not restart in a loop when the kernel never started', async () => {
    const { client, workers, restarts } = setup();
    workers[0].crash('wasm failed to load');
    await expect(client.ready).rejects.toThrow(/wasm failed to load/);
    expect(workers).toHaveLength(1);
    expect(restarts).toEqual([]);
  });

  it('runs a queued rebuild on the new worker', async () => {
    const { client, workers, last } = setup();
    last().answer('init');
    await client.ready;
    const a = client.build(req(1));
    const b = client.build(req(2));
    workers[0].crash();
    await expect(a).rejects.toBeInstanceOf(KernelRestartError);
    await flush();
    const sent = workers[1].sent.filter((m) => m.type === 'build');
    expect(sent.map((m) => (m as { req: BuildRequest }).req.upTo)).toEqual([2]);
    workers[1].answer('build', { ok: 'second' });
    await expect(b).resolves.toEqual({ ok: 'second' });
  });

  it('reports a request that stops answering and gives up on it much later', async () => {
    vi.useFakeTimers();
    const { client, workers, restarts, last } = setup({ stallMs: 1000, hangMs: 10_000 });
    const stalls: boolean[] = [];
    client.onStall = (s) => stalls.push(s);
    last().answer('init');
    await client.ready;
    // A slow request that does answer: reported, then cleared.
    const slow = client.massProperties();
    vi.advanceTimersByTime(1500);
    expect(stalls).toEqual([true]);
    workers[0].answer('mass', null);
    await slow;
    expect(stalls).toEqual([true, false]);
    // One that never answers: the worker is replaced after hangMs.
    const hung = client.build(req(1));
    const result = expect(hung).rejects.toBeInstanceOf(KernelRestartError);
    vi.advanceTimersByTime(9000);
    expect(workers).toHaveLength(1);
    vi.advanceTimersByTime(1200);
    await result;
    expect(workers).toHaveLength(2);
    expect(restarts).toEqual([['it stopped responding', true]]);
    expect(stalls).toEqual([true, false, true, false]);
  });

  it('restarts on request and keeps no timer running while idle', async () => {
    vi.useFakeTimers();
    const { client, workers, last } = setup();
    last().answer('init');
    await client.ready;
    const m = client.measure({ kind: 'face', index: 0 }, { kind: 'face', index: 1 });
    client.restart();
    await expect(m).rejects.toThrow('The geometry engine was restarted because it stopped responding. Try again.');
    workers[1].answer('init');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('imported file data', () => {
  const sentBuilds = (w: FakeWorker) => w.sent.filter((m) => m.type === 'build') as Extract<WorkerRequest, { type: 'build' }>[];

  it('is sent to the worker once and only referenced afterwards', async () => {
    const { client, workers, last } = setup();
    last().answer('init');
    await client.ready;
    const big = 'ISO-10303-21;'.repeat(1000);
    const blobs: Record<string, string> = { a: big };
    const build = async (b: Record<string, string>) => {
      const p = client.build({ ...req(1), blobs: { ...b } });
      last().answer('build', {});
      await p;
      await flush();
    };
    await build(blobs);
    await build(blobs);
    // A second import: only the new file goes over.
    await build({ ...blobs, b: 'B' });
    // The first one deleted (still undoable), then brought back by undo.
    await build({ b: 'B' });
    await build({ a: big, b: 'B' });
    // Same id, other content (another part opened).
    await build({ a: 'other', b: 'B' });
    expect(sentBuilds(workers[0]).map((m) => [Object.keys(m.req.blobs), m.blobs])).toEqual([
      [['a'], ['a']],
      [[], ['a']],
      [['b'], ['a', 'b']],
      [[], ['b']],
      [['a'], ['a', 'b']],
      [['a'], ['a', 'b']],
    ]);
    // A restarted worker gets everything again.
    workers[0].crash();
    await build({ a: 'other', b: 'B' });
    expect(sentBuilds(workers[1]).map((m) => m.req.blobs)).toEqual([{ a: 'other', b: 'B' }]);
  });
});
