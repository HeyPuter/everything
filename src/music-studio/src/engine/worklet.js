// The real-time audio processor (AudioWorkletGlobalScope). It owns one WASM
// engine instance (core.js) and the sequencer, applies configuration
// messages from the main thread between blocks and reports the playhead,
// meters and load about 30 times a second.
//
// Main thread -> processor messages:
//   { type: 'init', module }                      compiled WebAssembly.Module
//   { type: 'channel', cfg } / { type: 'remove', slot }
//   { type: 'mixer', mixer } / { type: 'track', index, cfg } / { type: 'order', order }
//   { type: 'seq', seq } / { type: 'pitch', cents }
//   { type: 'play', tick, countIn } / { type: 'stop' } / { type: 'seek', tick }
//   { type: 'note', slot, key, vel, on } / { type: 'allOff', hard }
//   { type: 'sample', index, channels, rate } / { type: 'unsample', index }
//   { type: 'opts', metronome } / { type: 'reset' }
// Processor -> main thread:
//   { type: 'ready' }
//   { type: 'pos', tick, playing, counting, wraps, time, meters, cpu, voices }
//   { type: 'error', message }

import { Core } from './core.js';
import { Sequencer } from './sequencer.js';

const LIVE = 0x80000000;
const now = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();

class EngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = null;
    this.seq = null;
    this.pending = [];
    this.every = Math.round(sampleRate / 30);
    this.count = 0;
    this.busy = 0;
    this.span = 0;
    this.cpu = 0;
    this.failed = false;
    this.port.onmessage = (e) => this.#message(e.data);
  }

  #message(m) {
    if (m.type === 'init') {
      try {
        this.core = new Core(new WebAssembly.Instance(m.module, {}), sampleRate);
        this.seq = new Sequencer(this.core, sampleRate);
        const queued = this.pending;
        this.pending = [];
        for (const q of queued) this.#apply(q);
        this.port.postMessage({ type: 'ready' });
      } catch (err) {
        this.port.postMessage({ type: 'error', message: `The audio engine could not start: ${err?.message || err}` });
      }
      return;
    }
    if (!this.core) {
      this.pending.push(m);
      return;
    }
    try {
      this.#apply(m);
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err?.message || err) });
    }
  }

  #apply(m) {
    const core = this.core;
    const seq = this.seq;
    switch (m.type) {
      case 'channel':
        core.setChannel(m.cfg);
        break;
      case 'remove':
        core.removeChannel(m.slot);
        break;
      case 'mixer':
        core.setMixer(m.mixer);
        break;
      case 'track':
        core.setTrack(m.index, m.cfg);
        break;
      case 'order':
        core.setOrder(m.order);
        break;
      case 'seq':
        seq.setSequence(m.seq);
        break;
      case 'pitch':
        core.setMasterPitch(m.cents);
        break;
      case 'play':
        seq.play(m.tick, { countIn: m.countIn });
        this.#report();
        break;
      case 'stop':
        seq.stop();
        this.#report();
        break;
      case 'seek':
        seq.seek(m.tick);
        this.#report();
        break;
      case 'note':
        if (m.on) core.noteOn(m.slot, (LIVE | m.key) >>> 0, m.key, m.vel, 0, 0);
        else core.noteOff(m.slot, (LIVE | m.key) >>> 0, 0);
        break;
      case 'allOff':
        core.allOff(undefined, Boolean(m.hard));
        break;
      case 'sample':
        core.loadSample(m.index, m.channels, m.rate);
        break;
      case 'unsample':
        core.unloadSample(m.index);
        break;
      case 'opts':
        seq.metronome = Boolean(m.metronome);
        break;
      case 'reset':
        seq.stop();
        core.reset();
        break;
    }
  }

  #report() {
    const meters = this.core ? Float32Array.from(this.core.meters()) : new Float32Array(0);
    const s = this.seq;
    this.port.postMessage({
      type: 'pos',
      tick: s ? s.pos : 0,
      playing: s ? s.playing : false,
      counting: s ? s.counting : false,
      wraps: s ? s.wraps : 0,
      time: currentTime,
      meters,
      cpu: this.cpu,
      voices: this.core ? this.core.activeChannels() : 0,
    });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    if (!this.core || this.failed) {
      L.fill(0);
      if (R !== L) R.fill(0);
      return true;
    }
    const t0 = now();
    try {
      const n = L.length;
      const res = this.seq.block(n);
      L.set(res.l.subarray(0, n));
      if (R !== L) R.set(res.r.subarray(0, n));
    } catch (err) {
      this.failed = true;
      L.fill(0);
      if (R !== L) R.fill(0);
      this.port.postMessage({ type: 'error', message: `The audio engine stopped: ${err?.message || err}` });
      return true;
    }
    // Load: time spent against the real-time budget (unbiased even with a coarse clock).
    this.busy += now() - t0;
    this.span += (L.length / sampleRate) * 1000;
    this.count += L.length;
    if (this.count >= this.every) {
      this.count = 0;
      if (this.span >= 300) {
        this.cpu = this.busy / this.span;
        this.busy = 0;
        this.span = 0;
      }
      this.#report();
    }
    return true;
  }
}

registerProcessor('music-studio-engine', EngineProcessor);
