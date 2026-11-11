// Main-thread API for offline rendering (mixdowns, bounces and applying
// effect chains). Rendering runs in a Worker with the same mix core and WASM
// effects as playback, so what you hear is what you get.

import OfflineWorker from './offline-worker.js?worker';
import { CHUNK } from './mixcore.js';
import { dspModule } from '../audio/dsp.js';
import { sourceKey } from './engine.js';

let worker = null;
let nextId = 1;
const jobs = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new OfflineWorker();
  worker.onmessage = (e) => {
    const m = e.data;
    const job = jobs.get(m.id);
    if (!job) return;
    if (m.type === 'need') {
      const channels = job.sources.get(m.key);
      const start = m.index * CHUNK;
      const len = channels ? Math.max(0, Math.min(CHUNK, channels[0].length - start)) : 0;
      const data = channels ? channels.map((c) => c.toArray(start, start + len)) : [new Float32Array(0)];
      worker.postMessage({ type: 'chunk', id: m.id, key: m.key, index: m.index, channels: data }, data.map((d) => d.buffer));
    } else if (m.type === 'data') {
      job.onData(m.at, m.channels);
    } else if (m.type === 'progress') {
      job.onProgress?.(m.done / m.total);
    } else if (m.type === 'done') {
      jobs.delete(m.id);
      job.resolve();
    } else if (m.type === 'error') {
      jobs.delete(m.id);
      job.reject(new Error(m.message === 'cancelled' ? 'Cancelled' : m.message));
    }
  };
  worker.onerror = (e) => {
    for (const job of jobs.values()) job.reject(new Error(e.message || 'Rendering failed'));
    jobs.clear();
    worker = null;
  };
  return worker;
}

/**
 * Renders frames [start, end) of a mix graph (see mixcore.js) to stereo, or to
 * six channels (L, R, C, LFE, Ls, Rs) for a 5.1 graph.
 * @param {object} graph
 * @param {Map<string, Channel[]>} sources
 * @param {{ start?: number, end: number, onProgress?: (fraction) => void, signal?: AbortSignal,
 *           onData?: (at, channels) => void }} o  onData streams blocks instead of collecting them
 * @returns {Promise<Float32Array[] | null>} the channels, or null when streaming through onData
 */
export async function renderGraph(graph, sources, { start = 0, end, onProgress, signal, onData } = {}) {
  const module = await dspModule().catch(() => null);
  const w = getWorker();
  const id = nextId++;
  const total = end - start;
  const out = onData ? null : Array.from({ length: graph.surround ? 6 : 2 }, () => new Float32Array(total));
  await new Promise((resolve, reject) => {
    jobs.set(id, {
      sources,
      resolve,
      reject,
      onProgress,
      onData: (at, ch) => {
        if (onData) onData(at, ch);
        else ch.forEach((c, i) => out[i]?.set(c, at));
      },
    });
    signal?.addEventListener('abort', () => w.postMessage({ type: 'cancel', id }), { once: true });
    w.postMessage({ type: 'render', id, graph: structuredClone(graph), start, end, module });
  });
  return out;
}

/**
 * Applies an effect chain (slot specs, see fxhost.js) to frames [start, end)
 * of channels. Returns new Float32Arrays per channel of length end - start
 * (plus `tail` frames when given, for reverb/delay tails). Mono input is
 * processed as stereo and folded back to one channel. With more than two
 * channels (5.1) the first two are processed as the stereo pair and every
 * further channel on its own, like mono, so each keeps its own audio; a 5.1
 * file through surround-capable slots only (spec `channels: 6`) is rendered
 * as one six-channel track instead. Pass the
 * chain's total `latency` (see effectLatency in src/effects/index.js) to
 * compensate delay.
 */
export async function applyChain(channels, rate, specs, { start = 0, end = channels[0].length, tail = 0, latency = 0, onProgress, signal } = {}) {
  // Surround-capable slots (`channels: 6`, Surround Reverb) take a 5.1 file whole.
  const six = channels.length === 6 && specs.length > 0 && specs.every((s) => s.channels === 6);
  if (channels.length > 2 && !six) {
    const groups = [[0, 1], ...channels.slice(2).map((_, i) => [i + 2])];
    const outs = [];
    for (let k = 0; k < groups.length; k++) {
      const progress = onProgress && ((f) => onProgress((k + f) / groups.length));
      const part = groups[k].map((c) => channels[c]);
      outs.push(...(await applyChain(part, rate, specs, { start, end, tail, latency, onProgress: progress, signal })));
    }
    return outs;
  }
  const sub = channels.map((c) => c.slice(start, end));
  const key = sourceKey(sub);
  const len = end - start;
  const graph = {
    rate,
    tracks: [{ id: 'fx', gain: 1, pan: 0, clips: [{ id: 'c', source: key, channels: sub.length, start: 0, offset: 0, length: len, gain: 1, fadeIn: 0, fadeOut: 0 }], fx: specs }],
    master: { gain: 1 },
  };
  if (six) {
    graph.surround = true;
    graph.tracks[0].six = true;
  }
  // `latency` frames (lookahead limiters, spectral effects) are rendered past
  // the end and dropped from the start so the output lines up with the input.
  const sources = new Map([[key, sub]]);
  const total = len + tail + latency;
  const outs = await renderGraph(graph, sources, { start: 0, end: total, onProgress, signal });
  if (six) return latency > 0 ? outs.map((c) => c.subarray(latency)) : outs;
  let [L, R] = outs;
  if (latency > 0) {
    L = L.subarray(latency);
    R = R.subarray(latency);
  }
  if (channels.length === 1) {
    for (let i = 0; i < L.length; i++) L[i] = (L[i] + R[i]) / 2;
    return [L];
  }
  return [L, R];
}
