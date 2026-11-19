// Analysis worker: spectrogram columns, spectra, pitch tracks, and streaming
// sessions (amplitude statistics, loudness, gain with true-peak limiting).
// The main thread owns the samples and sends only the ranges a job needs.
//
// in:  { type: 'init', module }
//      { id, op: 'columns', fft, window, hop, frames, samples, floor }
//      { id, op: 'average', size, window, hop, frames, samples }
//      { id, op: 'pitch', samples, rate, n, hop, frames, fmin, fmax, threshold }
//      { id, op: 'open', sid, kind: 'stats' | 'loudness' | 'limit', ...params }  (stats: windowMs)
//      { id, op: 'push', sid, channels }     (limit sessions reply with processed channels)
//      { id, op: 'close', sid }              replies with the session result
// out: { id, result } | { id, error }

import { Dsp } from '../audio/dsp.js';
import { loudnessMeter, limiter, pitchTrack, bitDepth, windowRms, averageSpectrum } from './dsp-ext.js';
import { accumulateRmsHistogram, HIST_BINS } from './rms-histogram.js';

let d = null;
const analyzers = new Map();
const sessions = new Map();

function analyzer(fft, window) {
  const key = `${fft}/${window}`;
  let a = analyzers.get(key);
  if (!a) {
    a = d.analyzer(fft, window);
    analyzers.set(key, a);
    // Keep a few sizes around; free the oldest.
    if (analyzers.size > 4) {
      const [k, old] = analyzers.entries().next().value;
      old.free();
      analyzers.delete(k);
    }
  }
  return a;
}

function openSession(m) {
  if (m.kind === 'stats') {
    return {
      kind: 'stats',
      rate: m.rate,
      win: Math.max(1, Math.round(m.rate * ((m.windowMs || 50) / 1000))),
      chans: Array.from({ length: m.channels }, () => ({ min: Infinity, max: -Infinity, sum: 0, sq: 0, clipped: 0, bad: 0, bits: 0, rmsMin: Infinity, rmsMax: 0, rmsSum: 0, rmsCount: 0, frames: 0, hist: new Uint32Array(HIST_BINS) })),
      meter: loudnessMeter(d, m.rate, m.channels),
    };
  }
  if (m.kind === 'loudness') return { kind: 'loudness', meter: loudnessMeter(d, m.rate, m.channels) };
  if (m.kind === 'limit') {
    const lim = m.limit ? limiter(d, m.rate, m.channels, { ceiling: m.ceiling, lookMs: m.lookMs, releaseMs: m.releaseMs, gain: m.gain }) : null;
    return { kind: 'limit', gain: m.gain, lim, channels: m.channels, meter: loudnessMeter(d, m.rate, m.channels) };
  }
  throw new Error(`Unknown session ${m.kind}`);
}

function push(s, channels) {
  if (s.kind === 'stats') {
    channels.forEach((x, c) => {
      const st = s.chans[c];
      const [lo, hi, sum, sq, clipped, bad] = d.stats(x);
      if (x.length) {
        st.min = Math.min(st.min, lo);
        st.max = Math.max(st.max, hi);
      }
      st.sum += sum;
      st.sq += sq;
      st.clipped += clipped;
      st.bad += bad;
      st.frames += x.length;
      const b = bitDepth(d, x);
      st.bits = Math.max(st.bits, b);
      const [rlo, rhi, rsum, rcount] = windowRms(d, x, s.win);
      if (rcount) {
        st.rmsMin = Math.min(st.rmsMin, rlo);
        st.rmsMax = Math.max(st.rmsMax, rhi);
        st.rmsSum += rsum;
        st.rmsCount += rcount;
      }
      accumulateRmsHistogram(st.hist, x, s.win);
    });
    s.meter.push(channels);
    return null;
  }
  if (s.kind === 'loudness') {
    s.meter.push(channels);
    return null;
  }
  // limit: gain (and limiter) in place, measured on the way out.
  if (s.lim) s.lim.process(channels);
  else if (s.gain !== 1) for (const x of channels) for (let i = 0; i < x.length; i++) x[i] *= s.gain;
  s.meter.push(channels);
  return channels;
}

function close(s) {
  const loud = s.meter.result();
  // A scan also returns its momentary and short-term loudness over time.
  if (s.kind === 'loudness') loud.history = s.meter.series();
  s.meter.free();
  s.lim?.free();
  if (s.kind === 'stats') return { channels: s.chans, loudness: loud };
  return { loudness: loud, latency: s.lim?.latency ?? 0 };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    d = new Dsp(new WebAssembly.Instance(m.module, {}));
    return;
  }
  try {
    if (!d) throw new Error('DSP is not ready');
    let result = null;
    let transfer = [];
    switch (m.op) {
      case 'columns': {
        result = analyzer(m.fft, m.window).columns(m.samples, m.hop, m.frames, m.floor);
        transfer = [result.buffer];
        break;
      }
      case 'average': {
        result = averageSpectrum(d, m.samples, m.size, m.window, m.hop, m.frames);
        transfer = [result.buffer];
        break;
      }
      case 'pitch': {
        result = pitchTrack(d, m.samples, m.rate, m);
        transfer = [result.buffer];
        break;
      }
      case 'open':
        sessions.set(m.sid, openSession(m));
        break;
      case 'push': {
        const s = sessions.get(m.sid);
        if (!s) throw new Error('Session closed');
        result = push(s, m.channels);
        if (result) transfer = result.map((x) => x.buffer);
        break;
      }
      case 'close': {
        const s = sessions.get(m.sid);
        sessions.delete(m.sid);
        result = s ? close(s) : null;
        break;
      }
      default:
        throw new Error(`Unknown op ${m.op}`);
    }
    self.postMessage({ id: m.id, result }, transfer);
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message || err) });
  }
};
