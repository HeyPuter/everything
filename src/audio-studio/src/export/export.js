// Main-thread export API. Encoding runs in a dedicated worker per export
// (src/export/export-worker.js); cancelling terminates it immediately.

import ExportWorker from './export-worker.js?worker';
import { dspModule, resampleSettings } from '../audio/dsp.js';
import { conformOptions, emptyExportError, exportMarkers, outputFrames } from './formats.js';
import { UserError } from '../lib/errors.js';

/**
 * Encodes frames [start, end) of `channels` (Channel objects or Float32Arrays).
 * @param {{ channels, sampleRate, start?, end?, markers?, meta?, chunks? }} source
 * @param {object} options export options (formats.js), conformed here
 * @param {{ onProgress?: (fraction) => void, signal?: AbortSignal }} [o]
 * @returns {Promise<Blob>}
 */
export async function exportAudio(source, options, { onProgress, signal } = {}) {
  const { channels, sampleRate } = source;
  const start = source.start ?? 0;
  const end = source.end ?? channels[0]?.length ?? 0;
  const opts = conformOptions(options.format, options).options;
  const outFrames = outputFrames(Math.max(0, end - start), sampleRate, opts.sampleRate);
  const empty = emptyExportError(opts.format, outFrames);
  if (empty) throw new UserError(empty);
  const markers = exportMarkers(source.markers || [], start, end, sampleRate, opts.sampleRate);
  const module = await dspModule().catch(() => null);
  if (signal?.aborted) throw cancelledError();
  const worker = new ExportWorker();
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, cancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'need') {
        const data = channels.map((c) => {
          const out = new Float32Array(m.n);
          if (c.read) c.read(start + m.at, out);
          else out.set(c.subarray(start + m.at, start + m.at + m.n));
          return out;
        });
        worker.postMessage({ type: 'chunk', at: m.at, channels: data }, data.map((d) => d.buffer));
      } else if (m.type === 'progress') onProgress?.(m.fraction);
      else if (m.type === 'done') finish(resolve, m.blob);
      else if (m.type === 'error') finish(reject, new Error(m.message));
    };
    worker.onerror = (e) => finish(reject, new Error(e.message || 'Export failed.'));
    worker.postMessage({
      type: 'start',
      module,
      job: { options: opts, sourceRate: sampleRate, frames: Math.max(0, end - start), markers, meta: source.meta || {}, chunks: source.chunks || null, resampler: options.resampler || resampleSettings() },
    });
  });
}

export function cancelledError() {
  const err = new Error('Cancelled');
  err.name = 'AbortError';
  return err;
}

export function isCancelled(err) {
  return err?.name === 'AbortError' || err?.message === 'Cancelled';
}
