// Main-thread handle to the geometry worker. Builds are coalesced: while one
// runs, only the most recent pending request is kept, so fast edits (dragging
// a value) never queue stale work.
//
// The worker is restarted when it dies (an uncaught error, a message that
// cannot be read, or an aborted OpenCascade module) or when the user asks for
// it after a request stopped answering; requests in flight then reject with a
// KernelRestartError instead of waiting forever.

import type { SolidWorksImport } from '../formats/sldprt';
import type { Id } from '../model/types';
import type { BuildRequest, BuildResult, MassProperties, MeasureResult, MeasureTarget, ProjectionRequest, ProjectionResult, WorkerRequest, WorkerResponse } from './protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Call = Pending & { at: number; type: WorkerRequest['type'] };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Rejection of a request whose worker stopped and was replaced. */
export class KernelRestartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelRestartError';
  }
}

export interface KernelClientOptions {
  createWorker?: () => Worker;
  /** A request unanswered this long is reported through onStall. */
  stallMs?: number;
  /** A request unanswered this long restarts the worker on its own. */
  hangMs?: number;
}

const defaultWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'geometry' });

export class KernelClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, Call>();
  private building = false;
  private queued: { req: BuildRequest; waiters: Pending[] } | null = null;
  /** Imported file data the current worker already holds, by blob id. */
  private sentBlobs = new Map<Id, string>();
  private started = false;
  private stalled = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly createWorker: () => Worker;
  private readonly stallMs: number;
  private readonly hangMs: number;
  readonly ready: Promise<void>;
  /** Called after the worker was replaced; `building` tells whether a rebuild was cut short. */
  onRestart: (reason: string, building: boolean) => void = () => {};
  /** Called when a request has gone unanswered for a while, and again (false) once it settles. */
  onStall: (stalled: boolean) => void = () => {};

  constructor(opts: KernelClientOptions = {}) {
    this.createWorker = opts.createWorker ?? defaultWorker;
    this.stallMs = opts.stallMs ?? 30_000;
    // Large imports can legitimately take minutes; the user is offered a
    // restart from stallMs on, so only give up on our own much later.
    this.hangMs = opts.hangMs ?? 10 * 60_000;
    this.spawn();
    this.ready = this.call({ type: 'init' }).then(() => { this.started = true; });
  }

  private spawn() {
    const w = this.createWorker();
    this.worker = w;
    this.sentBlobs.clear();
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const r = ev.data;
      const p = this.pending.get(r.id);
      if (p) {
        this.pending.delete(r.id);
        if (r.ok) p.resolve(r.result);
        else p.reject(new Error(r.error));
      }
      if (!r.ok && r.fatal) this.restart('the OpenCascade kernel failed');
      this.checkStall();
    };
    w.onerror = (ev) => {
      ev.preventDefault?.();
      this.died(ev.message ? `of an error (${ev.message})` : 'it stopped unexpectedly');
    };
    w.onmessageerror = () => this.died('one of its replies could not be read');
  }

  private died(reason: string) {
    // Before it ever started (the WebAssembly module failed to load) a new
    // worker would fail the same way: report it rather than loop.
    if (!this.started) {
      const err = new Error(`The geometry engine stopped because ${reason}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.checkStall();
      return;
    }
    this.restart(reason);
  }

  /** Replaces the worker; requests in flight reject with a KernelRestartError. */
  restart(reason = 'it stopped responding') {
    const old = this.worker;
    old.onmessage = old.onerror = old.onmessageerror = null;
    old.terminate();
    const building = this.building;
    const err = new KernelRestartError(`The geometry engine was restarted because ${reason}. Try again.`);
    const calls = [...this.pending.values()];
    this.pending.clear();
    this.spawn();
    this.call({ type: 'init' }).catch(() => undefined);
    for (const p of calls) p.reject(err);
    this.checkStall();
    this.onRestart(reason, building);
  }

  private call<T>(msg: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, at: Date.now(), type: msg.type });
      this.worker.postMessage({ ...msg, id } as WorkerRequest, transfer);
      this.watch();
    });
  }

  private watch() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.checkStall(), Math.min(5000, this.stallMs / 2));
  }

  /** Oldest unanswered request's age; reports stalls and restarts a hung worker. */
  private checkStall() {
    let oldest = Infinity;
    for (const p of this.pending.values()) oldest = Math.min(oldest, p.at);
    if (oldest === Infinity) {
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
    }
    const age = oldest === Infinity ? 0 : Date.now() - oldest;
    if (this.started && age >= this.hangMs) {
      this.restart('it stopped responding');
      return;
    }
    const stalled = this.started && age >= this.stallMs;
    if (stalled !== this.stalled) {
      this.stalled = stalled;
      this.onStall(stalled);
    }
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
    // Imported files can be tens of MB: send each one to the worker once
    // rather than copying all of them with every rebuild.
    const fresh: Record<Id, string> = {};
    const ids = Object.keys(req.blobs);
    for (const k of ids) if (this.sentBlobs.get(k) !== req.blobs[k]) fresh[k] = req.blobs[k];
    this.sentBlobs = new Map(ids.map((k) => [k, req.blobs[k]]));
    this.call<BuildResult>({ type: 'build', req: { ...req, blobs: fresh }, blobs: ids })
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

  /** Development builds: makes the worker fail on purpose (tests of recovery). */
  debugFail(mode: 'hang' | 'abort' | 'crash'): Promise<void> {
    return this.call({ type: 'debugFail', mode });
  }
}
