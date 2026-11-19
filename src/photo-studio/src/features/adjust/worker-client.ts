// Main-thread side of the adjustment worker. Falls back to running on the
// main thread when module workers are unavailable (e.g. some test setups).
import { adjustmentOperations, applyAdjustment, histograms, type Adjustment, type Histograms, type SpatialContext } from '../../imaging/adjust';
import type { Mask8, OperationContext, ParamValues, RGBA8 } from '../../imaging/types';
import type { AdjustJob, AdjustReply } from './worker';


type Job = { type: 'adjust'; adjustment: Adjustment; ctx?: SpatialContext } | { type: 'operation'; operation: string; values: ParamValues; context: OperationContext };
let worker: Worker | undefined;
let failed = false;
let next = 1;
const waiting = new Map<number, { resolve: (img: RGBA8) => void; reject: (e: Error) => void; hist?: (h: Histograms) => void }>();
export let lastWorkerMs = 0;

function getWorker() {
  if (worker || failed) return worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<AdjustReply>) => {
      const w = waiting.get(ev.data.id);
      if (!w) return;
      waiting.delete(ev.data.id);
      if (ev.data.ms !== undefined) lastWorkerMs = ev.data.ms;
      if (ev.data.hist && w.hist) w.hist(ev.data.hist);
      else if (ev.data.image) w.resolve(ev.data.image);
      else w.reject(new Error(ev.data.error ?? 'Adjustment failed.'));
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      failed = true;
      worker?.terminate();
      worker = undefined;
      for (const [, w] of waiting) w.reject(new Error('The adjustment worker stopped.'));
      waiting.clear();
    };
  } catch {
    failed = true;
  }
  return worker;
}

function run(job: Job, image: RGBA8): Promise<RGBA8> {
  const w = getWorker();
  if (!w) {
    if (job.type === 'adjust') return Promise.resolve(applyAdjustment(image, job.adjustment, undefined, undefined, job.ctx));
    const op = adjustmentOperations.find((o) => o.id === job.operation)!;
    return Promise.resolve(op.apply(image, job.values, job.context));
  }
  const id = next++;
  // Copy so the caller keeps its buffer; the copy is transferred.
  const copy: RGBA8 = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ ...job, id, image: copy } as AdjustJob, [copy.data.buffer]);
  });
}

/** Histograms of an image (counting `selection` like `histograms`) in the
 * worker: on a large image they take long enough to stall the dialog that
 * shows them. The image is copied; the caller keeps it. */
export function histogramsInWorker(image: RGBA8, selection?: Mask8): Promise<Histograms> {
  const w = getWorker();
  if (!w) return Promise.resolve(histograms(image, selection));
  const id = next++;
  const copy: RGBA8 = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve: () => reject(new Error('Expected histograms.')), reject, hist: resolve });
    w.postMessage({ type: 'histograms', id, image: copy, selection } as AdjustJob, [copy.data.buffer]);
  });
}

// `ctx` places the image in the document (spatial kinds: grain position, effect radius).
export const adjustInWorker = (image: RGBA8, adjustment: Adjustment, ctx?: SpatialContext) => run({ type: 'adjust', adjustment, ctx }, image);
export const operationInWorker = (image: RGBA8, operation: string, values: ParamValues, context: OperationContext) =>
  run({ type: 'operation', operation, values, context }, image);
