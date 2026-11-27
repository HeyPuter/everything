// The CAM worker client with a stand-in worker: errors and shutting down.
import { describe, expect, it } from 'vitest';
import { CamCancelled, CamClient, CamEngineError } from '../src/cam/client';
import type { CamWorkerRequest, CamWorkerResponse } from '../src/cam/worker';
import type { GenerateJob } from '../src/cam/engine';

/** A worker that answers each request with `reply` (or never, when it returns null). */
function fakeWorker(reply: (msg: CamWorkerRequest) => CamWorkerResponse | null) {
  const w = {
    onmessage: null as ((ev: { data: CamWorkerResponse }) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
    terminated: false,
    postMessage(msg: CamWorkerRequest) {
      const r = reply(msg);
      if (r) queueMicrotask(() => { if (!w.terminated) w.onmessage?.({ data: r }); });
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

const job = {} as GenerateJob;

describe('CAM client', () => {
  it('passes on messages written for the user and marks internal errors', async () => {
    const answer = { error: '', user: true };
    const client = new CamClient(() => fakeWorker((m) => ({ id: m.id, type: 'error', ...answer })) as unknown as Worker);
    answer.error = 'Pick the floor faces of the pockets.';
    await expect(client.generate(job)).rejects.toThrow(/^Pick the floor faces of the pockets\.$/);
    Object.assign(answer, { error: "Cannot read properties of undefined (reading 'x')", user: false });
    const e = (await client.generate(job).catch((x: Error) => x)) as Error;
    expect(e.message).toMatch(/^The CAM engine ran into a problem/);
    expect(e.message).toContain("reading 'x'");
    expect(e).toBeInstanceOf(CamEngineError);
    expect((e as CamEngineError).user).toBe(false);
  });

  it('rejects requests still waiting when it is disposed', async () => {
    const worker = fakeWorker(() => null);
    const client = new CamClient(() => worker as unknown as Worker);
    const p = client.generate(job);
    client.dispose();
    await expect(p).rejects.toBeInstanceOf(CamCancelled);
    expect(worker.terminated).toBe(true);
    expect(client.busy).toBe(false);
  });
});
