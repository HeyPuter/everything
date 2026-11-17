/**
 * AudioWorklet processor for live preview: runs a clip's effect chain
 * (media/audio-fx.js ClipChain, the same code the export mix uses) on the
 * sound of one media element. The main thread posts { settings } whenever
 * the clip's effects change (null = pass through) and { reset } after a
 * jump in time.
 */
import { ClipChain } from '../media/audio-fx.js';

class ClipFxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chain = null;
    this.L = new Float32Array(128);
    this.R = new Float32Array(128);
    this.apply(options?.processorOptions?.settings || null);
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if ('settings' in m) this.apply(m.settings);
      if (m.reset) this.chain?.reset();
      // The element this processor served is gone: process() then ends it.
      if (m.dispose) {
        this.done = true;
        this.chain = null;
      }
    };
  }

  apply(settings) {
    if (!settings) this.chain = null;
    else if (this.chain) this.chain.update(settings);
    else this.chain = new ClipChain(settings, sampleRate);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const inp = inputs[0];
    const n = out[0].length;
    if (this.L.length < n) {
      this.L = new Float32Array(n);
      this.R = new Float32Array(n);
    }
    const L = this.L.subarray(0, n);
    const R = this.R.subarray(0, n);
    if (inp && inp.length) {
      L.set(inp[0]);
      R.set(inp[1] || inp[0]);
    } else {
      // No input (element paused): keep tails of echoes and reverbs running.
      L.fill(0);
      R.fill(0);
    }
    this.chain?.process(L, R, n);
    out[0].set(L);
    if (out[1]) out[1].set(R);
    return !this.done;
  }
}

registerProcessor('vs-clip-fx', ClipFxProcessor);
