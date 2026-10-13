// Main-thread handle to the geometry worker. Builds are coalesced: while one
// runs, only the most recent pending request is kept, so fast edits (dragging
// a value) never queue stale work.

import type { SolidWorksImport } from '../formats/sldprt';
import type { BuildRequest, BuildResult, MassProperties, MeasureResult, MeasureTarget, ProjectionRequest, ProjectionResult, WorkerRequest, WorkerResponse } from './protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class KernelClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private building = false;
  private queued: { req: BuildRequest; waiters: Pending[] } | null = null;
  readonly ready: Promise<void>;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'geometry' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const r = ev.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.result);
      else p.reject(new Error(r.error));
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'The geometry engine stopped unexpectedly');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.ready = this.call({ type: 'init' }).then(() => undefined);
  }

  private call<T>(msg: DistributiveOmit<WorkerRequest, 'id'>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...msg, id } as WorkerRequest);
    });
  }

  /** Requests a rebuild; superseded requests resolve with the newer result. */
  build(req: BuildRequest): Promise<BuildResult> {
    return new Promise<BuildResult>((resolve, reject) => {
      const waiter = { resolve: resolve as (v: unknown) => void, reject };
      if (this.building) {
        if (this.queued) this.queued.waiters.push(waiter);
        else this.queued = { req, waiters: [waiter] };
        this.queued.req = req;
        return;
      }
      this.run(req, [waiter]);
    });
  }

  private run(req: BuildRequest, waiters: Pending[]) {
    this.building = true;
    this.call<BuildResult>({ type: 'build', req })
      .then((res) => { for (const w of waiters) w.resolve(res); })
      .catch((e) => { for (const w of waiters) w.reject(e); })
      .finally(() => {
        this.building = false;
        const q = this.queued;
        this.queued = null;
        if (q) this.run(q.req, q.waiters);
      });
  }

  get busy(): boolean {
    return this.building;
  }

  /** Drops all cached rebuild steps. */
  reset(): Promise<void> {
    return this.call({ type: 'reset' });
  }

  /** Hidden-line projections of the current body for drawing views. */
  project(views: ProjectionRequest[]): Promise<ProjectionResult[]> {
    return this.call({ type: 'project', views });
  }

  massProperties(): Promise<MassProperties | null> {
    return this.call({ type: 'mass' });
  }

  measure(a: MeasureTarget, b: MeasureTarget): Promise<MeasureResult> {
    return this.call({ type: 'measure', a, b });
  }

  exportFile(format: 'step' | 'stl', quality = 1): Promise<Uint8Array> {
    return this.call({ type: 'export', format, quality });
  }

  exportBrep(): Promise<string> {
    return this.call({ type: 'export', format: 'brep', quality: 1 });
  }

  /** Converts a SolidWorks part file to STEP text. Rejects with a readable message. */
  convertSolidWorks(data: Uint8Array, name: string): Promise<SolidWorksImport> {
    return this.call({ type: 'convertSolidWorks', data, name });
  }

  /** Returns null when the STEP text imports cleanly, else an error message. */
  checkImport(text: string): Promise<string | null> {
    return this.call({ type: 'checkImport', format: 'step', text });
  }
}
