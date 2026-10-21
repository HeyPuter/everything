/**
 * Background decoding for the timeline: filmstrip thumbnails and audio
 * waveform peaks. Runs Mediabunny (WebCodecs) off the main thread and
 * computes peaks with the WASM kernels.
 *
 * Messages in:  { id, op: 'thumbs', blob, times: [sec], height }
 *               { id, op: 'peaks', blob, rate }        rate = buckets per second
 *               { id, op: 'cancel', target }
 * Messages out: { id, ok, result } | { id, ok: false, error }
 *               { id, partial: { index, bitmap } } for thumbs as they arrive
 */
import { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioSampleSink } from 'mediabunny';
import { loadDsp, peaks } from '../media/dsp.js';

const cancelled = new Set();
const inputs = new Map(); // blob -> Input (reused while the same file is busy)

function inputFor(blob) {
  let entry = inputs.get(blob);
  if (!entry) {
    entry = { input: new Input({ source: new BlobSource(blob), formats: ALL_FORMATS }), users: 0 };
    inputs.set(blob, entry);
  }
  entry.users++;
  return entry;
}

function release(blob) {
  const entry = inputs.get(blob);
  if (!entry) return;
  entry.users--;
  if (entry.users <= 0) {
    entry.input.dispose();
    inputs.delete(blob);
  }
}

async function thumbs(id, { blob, times, height }) {
  const entry = inputFor(blob);
  try {
    const track = await entry.input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('Cannot decode video');
    const sink = new CanvasSink(track, { height, fit: 'contain', poolSize: 0 });
    let index = 0;
    const sorted = times.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
    for await (const wrapped of sink.canvasesAtTimestamps(sorted.map((x) => x.t))) {
      if (cancelled.has(id)) break;
      const slot = sorted[index++];
      if (!wrapped) continue;
      const bitmap = await createImageBitmap(wrapped.canvas);
      self.postMessage({ id, partial: { index: slot.i, bitmap } }, [bitmap]);
    }
    return { done: true };
  } finally {
    release(blob);
  }
}

async function wavePeaks(id, { blob, rate }) {
  await loadDsp();
  const entry = inputFor(blob);
  try {
    const track = await entry.input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return { rate, data: new Float32Array(0), duration: 0 };
    // AudioSampleSink, not AudioBufferSink: AudioBuffer does not exist in workers.
    const sink = new AudioSampleSink(track);
    const chunks = [];
    let total = 0;
    let duration = 0;
    let plane = new Float32Array(0);
    for await (const sample of sink.samples()) {
      if (cancelled.has(id)) {
        sample.close();
        break;
      }
      // Mono mixdown, then reduce to buckets right away to keep memory flat.
      const n = sample.numberOfFrames;
      const chs = sample.numberOfChannels;
      const mono = new Float32Array(n);
      if (plane.length < n) plane = new Float32Array(n);
      for (let c = 0; c < chs; c++) {
        sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mono[i] += plane[i] / chs;
      }
      const buckets = Math.max(1, Math.round((n / sample.sampleRate) * rate));
      let p = peaks(mono, buckets);
      let at = Math.round(sample.timestamp * rate);
      // AAC priming packets are stamped before zero: keep only what lies after it.
      if (at < 0) {
        p = p.subarray(Math.min(buckets, -at) * 2);
        at = 0;
      }
      chunks.push({ at, p });
      total = Math.max(total, at + p.length / 2);
      duration = Math.max(duration, sample.timestamp + sample.duration);
      sample.close();
    }
    const data = new Float32Array(total * 2);
    for (const { at, p } of chunks) data.set(p.subarray(0, Math.min(p.length, data.length - at * 2)), at * 2);
    return { rate, data, duration };
  } finally {
    release(blob);
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.op === 'cancel') {
    cancelled.add(msg.target);
    return;
  }
  try {
    const result = msg.op === 'thumbs' ? await thumbs(msg.id, msg) : await wavePeaks(msg.id, msg);
    const transfer = result?.data?.buffer ? [result.data.buffer] : [];
    self.postMessage({ id: msg.id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) });
  } finally {
    cancelled.delete(msg.id);
  }
};
