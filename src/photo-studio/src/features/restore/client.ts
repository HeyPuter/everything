// Main-thread side of the Portrait & Restore worker. The preview worker keeps
// its caches between runs (a newer run supersedes an older one); the final
// render uses a second worker that Stop terminates outright.
import type { RestoreFilterId, RestoreParams } from '../../imaging/restore/defs';
import { CancelledError, type Mask8, type RGBA8 } from '../../imaging/types';
import type { FromRestoreWorker, ToRestoreWorker } from './protocol';

export type RunRequest = { params: RestoreParams; level: number; overlay?: RestoreFilterId; affected?: boolean; source?: boolean };
export type RunResult = Extract<FromRestoreWorker, { type: 'done' }>;
type Pending = { resolve: (r: RunResult) => void; reject: (e: Error) => void; progress?: (f: number) => void };

const copy = (img: RGBA8): RGBA8 => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });

export class RestoreClient {
  private worker?: Worker;
  private jobs = 0;
  private pending = new Map<number, Pending>();
  private source?: { image: RGBA8; selection?: Mask8 };
  private aux = new Map<string, RGBA8>();
  constructor(readonly name: string) {}

  private post(m: ToRestoreWorker) {
    this.ensure().postMessage(m);
  }
  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: `restore-${this.name}` });
    w.onmessage = (ev: MessageEvent<FromRestoreWorker>) => {
      const m = ev.data, p = this.pending.get(m.job);
      if (!p) return;
      if (m.type === 'progress') return p.progress?.(m.value);
      this.pending.delete(m.job);
      if (m.type === 'done') p.resolve(m);
      else p.reject(m.cancelled ? new CancelledError() : new Error(m.message));
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      this.terminate(new Error(ev.message || 'The Portrait & Restore worker failed.'));
    };
    this.worker = w;
    if (this.source) w.postMessage({ type: 'load', image: copy(this.source.image), selection: this.source.selection } satisfies ToRestoreWorker);
    for (const [name, image] of this.aux) w.postMessage({ type: 'aux', name, image: copy(image) } satisfies ToRestoreWorker);
    return w;
  }
  load(image: RGBA8, selection?: Mask8) {
    this.source = { image, selection };
    if (this.worker) this.post({ type: 'load', image: copy(image), selection });
  }
  setAux(name: string, image: RGBA8 | null) {
    if (image) this.aux.set(name, image);
    else this.aux.delete(name);
    if (this.worker) this.post({ type: 'aux', name, image: image && copy(image) });
  }
  run(req: RunRequest, progress?: (f: number) => void): Promise<RunResult> {
    const job = ++this.jobs;
    return new Promise((resolve, reject) => {
      this.pending.set(job, { resolve, reject, progress });
      this.post({ type: 'run', job, ...req });
    });
  }
  /** Stop everything at once (the next run starts a fresh worker). */
  terminate(reason: Error = new CancelledError()) {
    this.worker?.terminate();
    this.worker = undefined;
    const list = [...this.pending.values()];
    this.pending.clear();
    for (const p of list) p.reject(reason);
  }
  dispose() {
    this.terminate();
    this.source = undefined;
    this.aux.clear();
  }
}
export const isCancel = (e: unknown) => e instanceof Error && e.name === 'CancelledError';
