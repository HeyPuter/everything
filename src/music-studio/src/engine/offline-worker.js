// Offline renderer (dedicated Worker): runs the same WASM core and sequencer
// as playback, faster than real time, in slices so progress is reported and
// a cancel message is seen between slices.
//
// In:  { type: 'render', id, module, rate, channels, mixer, seq, samples: [{ index, channels, rate }],
//        tail (max seconds), silence (seconds of silence that end the tail, default 0.25), pitch (cents) }
//      { type: 'cancel', id }
// Out: { type: 'progress', id, done (0..1) }
//      { type: 'done', id, channels: [Float32Array, Float32Array], rate } (transferred)
//      { type: 'error', id, message }

import { Core, BLOCK } from './core.js';
import { Sequencer } from './sequencer.js';

const cancelled = new Set();
const SLICE_MS = 30;
const SILENCE = 1e-4; // -80 dBFS
const SILENT_FOR = 0.25; // seconds of silence that end the tail (longer with long echoes)

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'cancel') cancelled.add(m.id);
  else if (m.type === 'render') run(m).catch((err) => self.postMessage({ type: 'error', id: m.id, message: String(err?.message || err) }));
};

const yieldToEvents = () => new Promise((r) => setTimeout(r, 0));

async function run(m) {
  const { id, rate } = m;
  const core = new Core(new WebAssembly.Instance(m.module, {}), rate);
  core.setMixer(m.mixer);
  for (const s of m.samples) core.loadSample(s.index, s.channels, s.rate);
  for (const c of m.channels) core.setChannel(c);
  core.setMasterPitch(m.pitch || 0);
  const seq = new Sequencer(core, rate, { loop: false });
  seq.setSequence(m.seq);
  seq.play(m.seq.start);
  // The range's length follows the tempo map (tempo automation).
  const body = Math.max(1, Math.ceil(seq.framesBetween(m.seq.start, m.seq.end) - 1e-6));
  const tailMax = Math.max(0, Math.round((m.tail ?? 2) * rate));
  const total = body + tailMax;
  const L = new Float32Array(total + BLOCK);
  const R = new Float32Array(total + BLOCK);
  let f = 0;
  let quiet = 0;
  let end = total;
  let lastProgress = -1;
  while (f < total) {
    const t0 = performance.now();
    while (f < total && performance.now() - t0 < SLICE_MS) {
      const out = seq.block(BLOCK);
      L.set(out.l, f);
      R.set(out.r, f);
      if (f >= body) {
        let pk = 0;
        for (let i = 0; i < BLOCK; i++) pk = Math.max(pk, Math.abs(out.l[i]), Math.abs(out.r[i]));
        quiet = pk < SILENCE ? quiet + BLOCK : 0;
        if (quiet >= Math.max(SILENT_FOR, m.silence || 0) * rate) {
          end = Math.max(body, f + BLOCK - quiet);
          f = total;
          break;
        }
      }
      f += BLOCK;
    }
    const done = Math.min(1, f / total);
    if (done - lastProgress >= 0.01 || done === 1) {
      lastProgress = done;
      self.postMessage({ type: 'progress', id, done });
    }
    await yieldToEvents();
    if (cancelled.has(id)) {
      cancelled.delete(id);
      self.postMessage({ type: 'error', id, message: 'cancelled' });
      return;
    }
  }
  const len = Math.min(end, total);
  const l = L.slice(0, len);
  const r = R.slice(0, len);
  self.postMessage({ type: 'done', id, channels: [l, r], rate }, [l.buffer, r.buffer]);
}
