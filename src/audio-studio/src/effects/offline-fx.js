// Offline effect processes run in a dedicated Worker so the main thread stays
// free. A definition provides a pure `run` and uses `process: offloaded(id)`:
//
//   run: async ({ channels, rate, values, extra, dsp, onProgress, signal, mask }) =>
//          Float32Array[] | { channels, markers }
//
// `values` already include defaults; `extra` carries document data captured on
// the main thread by `context` (for example the noise print); `mask` lists the
// channels that are written (null = all). Without Worker
// support (tests) `run` executes in place.
//
// A definition may also offer named helper tasks that are not the effect
// itself but need the same worker (Learn Sound Model):
//
//   tasks: { learn: async ({ channels, rate, values, extra, dsp, onProgress }) => any }
//
// runTask(id, task, { channels, rate, values, extra, signal, onProgress })
// runs one and resolves its result.

import { dsp, dspModule } from '../audio/dsp.js';
import { getEffect, defaults } from './registry.js';

// Installed by src/effects/index.js (main thread only), so the worker bundle,
// which loads the catalog, never references itself.
let workerFactory = null;

/** Sets the function that creates an effect worker (null runs in place). */
export function setWorkerFactory(factory) {
  workerFactory = factory;
}

/** Runs `task` of effect `id` (def.tasks[task]) in a worker, or in place without one. */
export async function runTask(id, task, { channels = [], rate = 48000, values = {}, extra = {}, signal, onProgress } = {}) {
  const def = getEffect(id);
  if (!def?.tasks?.[task]) throw new Error(`No task ${task} for ${id}`);
  const all = { ...defaults(def), ...values };
  if (typeof Worker === 'undefined' || !workerFactory) {
    return def.tasks[task]({ channels, rate, values: all, extra, dsp: await dsp(), onProgress, signal });
  }
  return inWorker({ id, task, channels, rate, values: all, extra }, { signal, onProgress });
}

/** Posts one job to a fresh effect worker and resolves its result. */
async function inWorker(job, { signal, onProgress }) {
  const module = await dspModule();
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  return new Promise((resolve, reject) => {
    const worker = workerFactory();
    const done = () => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      done();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.value);
      else if (m.type === 'done') {
        done();
        resolve(m.result);
      } else if (m.type === 'error') {
        done();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      done();
      reject(new Error(e.message || 'Effect processing failed'));
    };
    // Copies (not transfers) so the caller's buffers stay usable.
    worker.postMessage({ ...job, module });
  });
}

/**
 * @param {string} id effect id
 * @param {{ context?: ({ doc, app, values }) => object }} [o]
 */
export function offloaded(id, { context } = {}) {
  return async function process({ channels, rate, values = {}, signal, onProgress, doc, app, mask = null } = {}) {
    const def = getEffect(id);
    const all = { ...defaults(def), ...values };
    const extra = context ? context({ doc, app, values: all }) : {};
    if (typeof Worker === 'undefined' || !workerFactory) {
      return def.run({ channels, rate, values: all, extra, dsp: await dsp(), onProgress, signal, mask });
    }
    return inWorker({ id, channels, rate, values: all, extra, mask }, { signal, onProgress });
  };
}
