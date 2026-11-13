// Realtime mixer running in the AudioWorkletGlobalScope. The main thread owns
// all sample data and streams the chunks around the playhead (see engine.js);
// this processor only mixes what it has and reports position and meters.

import { ChunkStore, renderBlock, createScratch, QUANTUM } from './mixcore.js';
import { FxHost, graphFxKeys } from './fxhost.js';
import { downmixStereo } from './surround.js';

const TAP_SIZE = 8192;

class MixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.store = new ChunkStore();
    this.graph = { tracks: [], master: { gain: 1 } };
    this.scratch = createScratch(QUANTUM);
    this.master = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    this.playing = false;
    this.pos = 0;
    this.end = Infinity;
    this.loop = null;
    this.host = null;
    this.meterEvery = Math.round(sampleRate / 30);
    this.meterCount = 0;
    this.peaks = new Map();
    this.masterPeak = [0, 0];
    this.blockMeters = new Map();
    this.underrunReported = new Set();
    this.seq = 0; // echoed in position reports (see Engine.seq)
    // Analysis tap: the latest master output, posted about 20 times a second
    // while an analysis panel asks for it (see Engine.tap).
    this.tapOn = false;
    this.tapL = new Float32Array(TAP_SIZE);
    this.tapR = new Float32Array(TAP_SIZE);
    this.tapPos = 0;
    this.tapCount = 0;
    this.tapEvery = Math.round(sampleRate / 20);
    // Effect readouts (meters inside effects), posted about 15 times a second.
    this.readoutEvery = Math.round(sampleRate / 15);
    this.readoutCount = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'init': {
        // The DSP arrives as bytes (or a compiled module) and compiles here; a
        // graph that came first gets its effects once the host is ready.
        const src = m.module || m.bytes;
        if (!src) break;
        WebAssembly.instantiate(src, {})
          .then((r) => {
            this.host = new FxHost(r.instance || r, sampleRate);
            this.resolveFx();
          })
          .catch((err) => this.port.postMessage({ type: 'error', message: `Effects are unavailable: ${err}` }));
        break;
      }
      case 'graph':
        this.graph = m.graph;
        // A 5.1 session renders six channels, monitored through a stereo downmix.
        this.six = this.graph.surround ? this.six || Array.from({ length: 6 }, () => new Float32Array(QUANTUM)) : null;
        this.resolveFx();
        break;
      case 'chunk':
        this.store.put(m.key, m.index, m.channels);
        break;
      case 'drop':
        this.store.drop(m.key, m.index);
        break;
      case 'play':
        this.seq = m.seq ?? this.seq;
        this.pos = m.from;
        this.end = m.to ?? Infinity;
        this.loop = m.loop || null;
        this.playing = true;
        this.underrunReported.clear();
        if (this.host) this.host.reset();
        this.clearDelays();
        this.report();
        break;
      case 'stop':
        this.playing = false;
        this.report();
        break;
      case 'seek':
        this.seq = m.seq ?? this.seq;
        this.pos = m.frame;
        if (this.host) this.host.reset();
        this.clearDelays();
        this.report();
        break;
      case 'loop':
        this.seq = m.seq ?? this.seq;
        this.loop = m.loop || null;
        break;
      case 'range':
        this.end = m.to ?? Infinity;
        break;
      case 'tap':
        this.tapOn = Boolean(m.on);
        break;
    }
  }

  /**
   * Empties the delay lines (rack dry/wet and latency compensation) on a jump,
   * like the effects, so audio from before it is not heard after it.
   */
  clearDelays() {
    this.scratch.dryDelay?.clear();
    this.scratch.delays?.clear();
  }

  /** Turns the graph's effect slot specs into live instances (once the host is ready; until then no effects run). */
  resolveFx() {
    const g = this.graph;
    if (!this.host || g.fxResolved) return;
    for (const t of g.tracks) {
      t.fx = this.host.sync(t.fx);
      for (const c of t.clips) if (c.fx) c.fx = this.host.sync(c.fx);
    }
    if (g.master) g.master.fx = this.host.sync(g.master.fx);
    this.host.prune(new Set([...graphFxKeys(g)].filter(Boolean)));
    g.fxResolved = true;
  }

  /** Posts the playhead: frame `pos` renders at context time `time`. */
  report(time = currentTime) {
    this.port.postMessage({ type: 'pos', frame: this.pos, time, playing: this.playing, seq: this.seq });
  }

  process(inputs, outputs) {
    try {
      return this.#process(outputs);
    } catch (err) {
      // Report once and keep running silent rather than killing the node.
      if (!this.failed) this.port.postMessage({ type: 'error', message: String(err && err.stack || err) });
      this.failed = true;
      for (const ch of outputs[0]) ch.fill(0);
      return true;
    }
  }

  #process(outputs) {
    const out = outputs[0];
    if (!this.playing) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    const n = out[0].length;
    const meters = this.blockMeters;
    const opts = {
      meters,
      runFx: this.host ? (chain, buf, f) => this.host.run(chain, buf, f) : null,
      missing: (key, frame) => {
        if (this.underrunReported.has(key)) return;
        this.underrunReported.add(key);
        this.port.postMessage({ type: 'underrun', key, frame });
      },
    };
    const L = this.master[0];
    const R = this.master[1];
    const oL = out[0];
    const oR = out[1] || out[0];
    // A quantum can cross the loop end: render it in segments.
    let done = 0;
    let ended = false;
    while (done < n) {
      let frames = n - done;
      if (this.loop && this.loop.end > this.loop.start) {
        if (this.pos >= this.loop.end) {
          this.pos = this.loop.start;
          this.report(currentTime + done / sampleRate);
        }
        frames = Math.min(frames, this.loop.end - this.pos);
      } else if (this.pos + frames > this.end) {
        frames = Math.max(0, this.end - this.pos);
      }
      if (frames <= 0) {
        ended = !this.loop;
        break;
      }
      if (this.six) {
        renderBlock(this.graph, this.store, this.pos, frames, this.six, this.scratch, opts);
        downmixStereo(this.six, this.master, frames);
      } else renderBlock(this.graph, this.store, this.pos, frames, this.master, this.scratch, opts);
      oL.set(L.subarray(0, frames), done);
      if (oR !== oL) oR.set(R.subarray(0, frames), done);
      this.pos += frames;
      done += frames;
    }
    if (done < n) {
      oL.fill(0, done);
      if (oR !== oL) oR.fill(0, done);
    }
    if (ended || (!this.loop && this.pos >= this.end)) {
      this.playing = false;
      this.port.postMessage({ type: 'ended', frame: this.pos, seq: this.seq });
    }
    let pl = this.masterPeak[0];
    let pr = this.masterPeak[1];
    for (let i = 0; i < n; i++) {
      const a = oL[i] < 0 ? -oL[i] : oL[i];
      const b = oR[i] < 0 ? -oR[i] : oR[i];
      if (a > pl) pl = a;
      if (b > pr) pr = b;
    }
    this.masterPeak[0] = pl;
    this.masterPeak[1] = pr;
    for (const [id, [l, r]] of meters) {
      const p = this.peaks.get(id);
      if (!p) this.peaks.set(id, [l, r]);
      else {
        if (l > p[0]) p[0] = l;
        if (r > p[1]) p[1] = r;
      }
    }
    if (this.tapOn) this.#tap(oL, oR, n);
    if (this.host) {
      this.readoutCount += n;
      if (this.readoutCount >= this.readoutEvery) {
        this.readoutCount = 0;
        const list = this.host.readouts();
        if (list.length) this.port.postMessage({ type: 'readouts', list, frame: this.pos });
      }
    }
    this.meterCount += n;
    if (this.meterCount >= this.meterEvery) {
      this.meterCount = 0;
      const tracks = [];
      for (const [id, [l, r]] of this.peaks) tracks.push([id, l, r]);
      // `pos` is the frame after this block, which starts at currentTime.
      this.port.postMessage({ type: 'meters', master: this.masterPeak.slice(), tracks, frame: this.pos, time: currentTime + n / sampleRate, seq: this.seq });
      this.masterPeak[0] = 0;
      this.masterPeak[1] = 0;
      this.peaks.clear();
    }
    return true;
  }

  #tap(L, R, n) {
    for (let i = 0; i < n; i++) {
      this.tapL[this.tapPos] = L[i];
      this.tapR[this.tapPos] = R[i];
      this.tapPos = (this.tapPos + 1) % TAP_SIZE;
    }
    this.tapCount += n;
    if (this.tapCount < this.tapEvery) return;
    this.tapCount = 0;
    const l = new Float32Array(TAP_SIZE);
    const r = new Float32Array(TAP_SIZE);
    const head = TAP_SIZE - this.tapPos;
    l.set(this.tapL.subarray(this.tapPos), 0);
    l.set(this.tapL.subarray(0, this.tapPos), head);
    r.set(this.tapR.subarray(this.tapPos), 0);
    r.set(this.tapR.subarray(0, this.tapPos), head);
    this.port.postMessage({ type: 'tap', frame: this.pos, rate: sampleRate, L: l, R: r }, [l.buffer, r.buffer]);
  }
}

registerProcessor('audio-studio-mixer', MixerProcessor);
