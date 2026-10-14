// Decoded audio for sampler and audio channels, keyed by sample id (the keys
// of project.samples). The cache hands every sample to the audio engine and
// keeps a min/max peak overview for drawing waveforms.
//
//   app.samples.set(id, { channels: Float32Array[], rate })
//   app.samples.get(id) -> { channels, rate, duration, peaks } | null
//   peaks = { perSecond, min: Float32Array, max: Float32Array } (mono mix)
//
// Emits 'change' (id) when a sample arrives or is removed. Loading files from
// Puter or this device is storage's job; the cache only holds decoded data.

import { Emitter } from '../lib/emitter.js';

export const PEAKS_PER_SECOND = 200;

export class SampleCache extends Emitter {
  constructor(engine) {
    super();
    this.engine = engine;
    this.map = new Map();
  }

  has(id) {
    return this.map.has(id);
  }

  get(id) {
    return this.map.get(id) || null;
  }

  set(id, { channels, rate }) {
    const entry = { channels, rate, duration: channels[0].length / rate, peaks: computePeaks(channels, rate) };
    this.map.set(id, entry);
    this.engine?.loadSample?.(id, { channels, rate });
    this.emit('change', id);
    return entry;
  }

  delete(id) {
    if (!this.map.delete(id)) return;
    this.engine?.unloadSample?.(id);
    this.emit('change', id);
  }

  ids() {
    return [...this.map.keys()];
  }
}

/** Min/max overview of the mono mix at PEAKS_PER_SECOND columns per second. */
export function computePeaks(channels, rate, perSecond = PEAKS_PER_SECOND) {
  const n = channels[0].length;
  const hop = Math.max(1, Math.round(rate / perSecond));
  const cols = Math.ceil(n / hop);
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  const k = 1 / channels.length;
  for (let c = 0; c < cols; c++) {
    let lo = Infinity;
    let hi = -Infinity;
    const end = Math.min(n, (c + 1) * hop);
    for (let i = c * hop; i < end; i++) {
      let s = 0;
      for (const ch of channels) s += ch[i];
      s *= k;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    min[c] = lo === Infinity ? 0 : lo;
    max[c] = hi === -Infinity ? 0 : hi;
  }
  return { perSecond: rate / hop, min, max };
}

/** Decodes an encoded audio file (ArrayBuffer) to { channels, rate } with the browser's decoder. */
export async function decodeAudio(arrayBuffer, rate = 48000) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('This browser cannot decode audio.');
  const ctx = new Ctx(2, 1, rate);
  const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
  const channels = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(new Float32Array(buf.getChannelData(c)));
  return { channels, rate: buf.sampleRate };
}
