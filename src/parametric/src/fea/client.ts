// The interface side of the stress analysis worker. Requests run one at a
// time; cancelling stops the worker (a computation in progress cannot be
// interrupted otherwise) and the next request starts a new one, which meshes
// again.

import type { StaticInput } from './static';
import type { FeaSurfaceData } from './surface';
import type { FeaMeshInfo, FeaSolution } from './results';
import type { FeaWorkerRequest, FeaWorkerResponse } from './worker';

type Payload = { type: 'mesh'; surface: FeaSurfaceData; size: number } | { type: 'solve'; input: StaticInput };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  progress?: (stage: string, v: number) => void;
}

export class FeaCancelled extends Error {
  constructor() { super('Cancelled'); }
}

/** An error from the worker; `user`: its message is written for the user (else an internal failure). */
export class FeaEngineError extends Error {
  constructor(message: string, readonly user: boolean) {
    super(user ? message : `The analysis ran into a problem (${message})`);
  }
}

export class FeaClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Whether the worker holds a mesh (a new worker has none). */
  meshed = false;

  constructor(private readonly create: () => Worker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'analysis' })) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = this.create();
    w.onmessage = (ev: MessageEvent<FeaWorkerResponse>) => {
      const r = ev.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      if (r.type === 'progress') { p.progress?.(r.stage, r.value); return; }
      this.pending.delete(r.id);
      if (r.type === 'done') p.resolve(r.result);
      else p.reject(new FeaEngineError(r.error, r.user));
    };
    w.onerror = (ev) => {
      ev.preventDefault?.();
      this.fail(new Error(`The analysis stopped${ev.message ? ` (${ev.message})` : ''}. The part may be too large for this mesh size: try a coarser mesh.`));
    };
    this.worker = w;
    this.meshed = false;
    return w;
  }

  private send<T>(payload: Payload, progress?: (stage: string, v: number) => void, transfer: Transferable[] = []): Promise<T> {
    const w = this.ensure();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
      w.postMessage({ id, ...payload } as FeaWorkerRequest, transfer);
    });
  }

  /** Meshes the surface in the worker; its arrays are moved there (they are empty here afterwards). */
  async mesh(surface: FeaSurfaceData, size: number, progress?: (stage: string, v: number) => void): Promise<FeaMeshInfo> {
    this.meshed = false;
    const info = await this.send<FeaMeshInfo>({ type: 'mesh', surface, size }, progress, [surface.positions.buffer, surface.indices.buffer, surface.triFace.buffer] as ArrayBuffer[]);
    this.meshed = true;
    return info;
  }

  solve(input: StaticInput, progress?: (stage: string, v: number) => void): Promise<FeaSolution> {
    return this.send<FeaSolution>({ type: 'solve', input }, progress);
  }

  /** Stops whatever is running (its promise rejects with FeaCancelled); the mesh goes with the worker. */
  cancel() {
    if (!this.pending.size) return;
    this.fail(new FeaCancelled());
  }

  private fail(e: Error) {
    this.worker?.terminate();
    this.worker = null;
    this.meshed = false;
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(e);
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  dispose() {
    this.fail(new FeaCancelled());
  }
}
