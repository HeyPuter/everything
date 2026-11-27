// The interface side of the CAM worker. Requests run one at a time in
// order; cancelling stops the worker (a computation in progress cannot be
// interrupted otherwise) and starts a new one, which is given the mesh again.

import type { CamSetup } from '../model/cam';
import type { GenerateJob, SimulateJob } from './engine';
import type { SimResult } from './simulate';
import type { Toolpath } from './toolpath';
import type { CamWorkerRequest, CamWorkerResponse } from './worker';

type Payload = { type: 'mesh'; key: string; tris: Float32Array } | { type: 'generate'; job: GenerateJob } | { type: 'simulate'; setup: CamSetup; job: SimulateJob };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  progress?: (v: number) => void;
}

export class CamCancelled extends Error {
  constructor() { super('Cancelled'); }
}

export class CamClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private mesh: { key: string; tris: Float32Array } | null = null;
  private sentKey: string | null = null;

  constructor(private readonly create: () => Worker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'cam' })) {}

  /** The part's triangles (model coordinates); sent to the worker before the next request. */
  setMesh(key: string, tris: Float32Array) {
    this.mesh = { key, tris };
  }

  get meshKey(): string | null {
    return this.mesh?.key ?? null;
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = this.create();
    w.onmessage = (ev: MessageEvent<CamWorkerResponse>) => {
      const r = ev.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      if (r.type === 'progress') { p.progress?.(r.value); return; }
      this.pending.delete(r.id);
      if (r.type === 'done') p.resolve(r.result);
      else p.reject(new Error(r.error));
    };
    w.onerror = (ev) => {
      ev.preventDefault?.();
      this.fail(new Error(`The CAM engine stopped${ev.message ? ` (${ev.message})` : ''}`));
    };
    this.worker = w;
    this.sentKey = null;
    return w;
  }

  private send<T>(payload: Payload, progress?: (v: number) => void, transfer: Transferable[] = []): Promise<T> {
    const w = this.ensure();
    if (payload.type !== 'mesh' && this.mesh && this.sentKey !== this.mesh.key) {
      // A copy: the client keeps the mesh for a replacing worker.
      const id = this.nextId++;
      this.pending.set(id, { resolve: () => {}, reject: () => {} });
      w.postMessage({ id, type: 'mesh', key: this.mesh.key, tris: this.mesh.tris.slice() } satisfies CamWorkerRequest);
      this.sentKey = this.mesh.key;
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
      w.postMessage({ id, ...payload } as CamWorkerRequest, transfer);
    });
  }

  generate(job: GenerateJob, progress?: (v: number) => void): Promise<Toolpath> {
    return this.send<Toolpath>({ type: 'generate', job }, progress);
  }

  simulate(setup: CamSetup, job: SimulateJob, progress?: (v: number) => void): Promise<SimResult> {
    return this.send<SimResult>({ type: 'simulate', setup, job }, progress);
  }

  /** Stops whatever is running or queued (their promises reject with CamCancelled). */
  cancel() {
    if (!this.pending.size) return;
    this.fail(new CamCancelled());
  }

  private fail(e: Error) {
    this.worker?.terminate();
    this.worker = null;
    this.sentKey = null;
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(e);
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
