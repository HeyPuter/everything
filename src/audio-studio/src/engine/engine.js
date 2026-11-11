// Main-thread side of playback and recording. The engine owns one AudioContext
// running the mixer worklet. Sample data stays on the main thread in immutable
// Channels; while playing, a feeder streams the CHUNK-sized pieces that clips
// need around the playhead (and the loop start) and drops the rest, so the
// worklet holds a few seconds of audio regardless of project size.

import mixerUrl from './mixer-worklet.js?worker&url';
import captureUrl from './capture-worklet.js?worker&url';
import { Emitter } from '../lib/emitter.js';
import { CHUNK } from './mixcore.js';
import { dspModule } from '../audio/dsp.js';

const LOOKAHEAD_S = 4;
const KEEP_BEHIND_S = 1;

const channelIds = new WeakMap();
let nextChannelId = 1;

/** Stable key for a list of Channels (changes whenever any channel changes). */
export function sourceKey(channels) {
  return channels
    .map((c) => {
      let id = channelIds.get(c);
      if (!id) channelIds.set(c, (id = nextChannelId++));
      return id;
    })
    .join(':');
}

/** A two-entry channel map of device channel indices (-1 = none). */
export function cleanMap(map) {
  const v = Array.isArray(map) ? map : [];
  return [0, 1].map((i) => {
    const n = Math.round(Number(v[i]));
    return Number.isFinite(n) && n >= -1 && n < 32 ? n : i;
  });
}

const wholeFrame = (f) => Math.max(0, Math.round(Number(f) || 0));
const wholeLoop = (loop) => (loop ? { ...loop, start: wholeFrame(loop.start), end: wholeFrame(loop.end) } : null);

export class Engine extends Emitter {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.rate = 48000;
    this.state = 'stopped'; // 'stopped' | 'playing'
    this.graph = { rate: 48000, tracks: [], master: { gain: 1 } };
    this.sources = new Map(); // key -> Channel[]
    this.sent = new Map(); // key -> Set(chunk index)
    this.lastPos = { frame: 0, time: 0 };
    this.range = { from: 0, to: null, loop: null };
    this.timer = 0;
    this.meters = { master: [0, 0], tracks: new Map() };
    this.input = null;
    this.contextPromise = null;
    // Preferences > Audio Hardware and Audio Channel Mapping.
    this.latencyHint = 'interactive';
    this.sinkId = '';
    this.outputMap = [0, 1]; // device output for file channel 1 and 2 (-1 = none)
    this.inputMap = [0, 1]; // device input feeding file channel 1 and 2 (-1 = none)
    this.outputRoute = null;
  }

  get available() {
    return typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined';
  }

  /** Creates (or re-creates at a new rate) the AudioContext. Must follow a user gesture. */
  async ensure(rate = this.rate) {
    if (this.ctx && this.requestedRate === rate && this.node) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }
    if (this.contextPromise) {
      await this.contextPromise;
      if (this.requestedRate === rate) return this.ctx;
    }
    this.contextPromise = this.#create(rate);
    try {
      return await this.contextPromise;
    } finally {
      this.contextPromise = null;
    }
  }

  async #create(rate) {
    this.stop();
    if (this.ctx) {
      this.closeInput();
      try {
        await this.ctx.close();
      } catch {
        // Already closed.
      }
    }
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: rate, latencyHint: this.latencyHint });
    } catch {
      // Some browsers limit the rates a context can run at; play at the device
      // rate instead (the graph is still mixed at its own rate).
      ctx = new AudioContext({ latencyHint: this.latencyHint });
    }
    this.ctx = ctx;
    this.requestedRate = rate;
    this.rate = ctx.sampleRate;
    await ctx.audioWorklet.addModule(mixerUrl);
    const node = new AudioWorkletNode(ctx, 'audio-studio-mixer', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e) => this.#onMessage(e.data);
    node.onprocessorerror = (e) => console.warn('[engine] processor error', e);
    this.node = node;
    this.outputRoute = null;
    this.#routeOutput();
    if (this.sinkId) await this.#applySink();
    let module = null;
    try {
      module = await dspModule();
    } catch {
      // Effects are unavailable without DSP; plain playback still works.
    }
    node.port.postMessage({ type: 'init', module });
    this.sent.clear();
    node.port.postMessage({ type: 'graph', graph: this.graph });
    if (this.tapUsers) node.port.postMessage({ type: 'tap', on: true });
    if (ctx.state === 'suspended') await ctx.resume();
    this.emit('context', ctx);
    return ctx;
  }

  /** Chooses the device that plays output ('' = system default). Needs AudioContext.setSinkId. */
  async setSink(id = '') {
    this.sinkId = id || '';
    if (this.ctx) await this.#applySink();
  }

  async #applySink() {
    if (typeof this.ctx?.setSinkId !== 'function') return;
    try {
      await this.ctx.setSinkId(this.sinkId);
    } catch (err) {
      console.warn('[engine] output device', err);
      this.emit('engine-error', 'The chosen output device is not available; playing through the system default.');
    }
  }

  /** Latency mode for the next audio context: 'interactive' | 'balanced' | 'playback'. */
  setLatencyHint(hint) {
    if (hint === this.latencyHint) return;
    this.latencyHint = hint;
    // Recreated on the next ensure() (while stopped, so playback is not cut).
    if (this.ctx && this.state !== 'playing') this.requestedRate = null;
  }

  /** Maps the two mix channels onto device outputs, e.g. [1, 0] swaps left and right. */
  setOutputMap(map) {
    this.outputMap = cleanMap(map);
    if (this.node) this.#routeOutput();
  }

  /** Maps device input channels onto the two recorded channels (applies when an input next opens). */
  setInputMap(map) {
    this.inputMap = cleanMap(map);
  }

  #routeOutput() {
    const { ctx, node } = this;
    node.disconnect();
    for (const n of this.outputRoute || []) n.disconnect();
    this.outputRoute = null;
    const map = this.outputMap;
    if (map[0] === 0 && map[1] === 1) {
      ctx.destination.channelCount = 2;
      node.connect(ctx.destination);
      return;
    }
    const max = Math.max(2, ctx.destination.maxChannelCount || 2);
    const outs = Math.min(max, Math.max(2, ...map.map((c) => c + 1)));
    try {
      ctx.destination.channelCount = outs;
      ctx.destination.channelCountMode = 'explicit';
      ctx.destination.channelInterpretation = 'discrete';
    } catch {
      // Fixed channel count: map within it.
    }
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(outs);
    node.connect(split);
    map.forEach((dev, ch) => {
      if (dev >= 0 && dev < outs) split.connect(merge, ch, dev);
    });
    merge.connect(ctx.destination);
    this.outputRoute = [split, merge];
  }

  #onMessage(m) {
    if (m.type === 'pos' || m.type === 'meters') {
      this.lastPos = { frame: m.frame, time: m.time };
    }
    if (m.type === 'meters') {
      this.meters.master = m.master;
      for (const [id, l, r] of m.tracks) this.meters.tracks.set(id, [l, r]);
      this.emit('meters', this.meters);
    } else if (m.type === 'ended') {
      this.lastPos = { frame: m.frame, time: this.ctx.currentTime };
      this.#setState('stopped');
      this.emit('ended', m.frame);
    } else if (m.type === 'tap') {
      this.emit('tap', m);
    } else if (m.type === 'readouts') {
      // Live readings of effects that measure (slot key -> Float32Array).
      this.emit('fx-readout', new Map(m.list), m.frame);
    } else if (m.type === 'underrun') {
      // Audio the mixer needed had not arrived yet: a dropout (Events panel, status bar).
      this.#feed();
      this.emit('underrun', { key: m.key, frame: m.frame });
    } else if (m.type === 'error') {
      console.warn('[engine]', m.message);
      this.emit('engine-error', m.message);
    }
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (state === 'playing') {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.#feed(), 100);
    } else {
      clearInterval(this.timer);
      this.timer = 0;
    }
    this.emit('state', state);
  }

  get playing() {
    return this.state === 'playing';
  }

  /** Current playhead in graph frames, interpolated between worklet reports. */
  get position() {
    if (!this.ctx || this.state !== 'playing') return this.lastPos.frame;
    const latency = (this.ctx.outputLatency || this.ctx.baseLatency || 0) * this.rate;
    let f = this.lastPos.frame + (this.ctx.currentTime - this.lastPos.time) * this.rate - latency;
    const loop = this.range.loop;
    if (loop && loop.end > loop.start && f >= loop.end) f = loop.start + ((f - loop.start) % (loop.end - loop.start));
    if (!loop && this.range.to != null) f = Math.min(f, this.range.to);
    return Math.max(0, f);
  }

  /**
   * Replaces the mix graph. `sources` maps each clip.source key to its
   * Channel[]; chunks already sent for unchanged keys are reused.
   */
  setGraph(graph, sources) {
    this.graph = graph;
    this.sources = sources;
    for (const key of [...this.sent.keys()]) {
      if (!sources.has(key)) {
        this.sent.delete(key);
        this.node?.port.postMessage({ type: 'drop', key });
      }
    }
    this.node?.port.postMessage({ type: 'graph', graph });
    if (this.playing) this.#feed();
  }

  /**
   * Starts playback at `from`. `to` stops there (null plays to the end of the
   * graph); `loop` = { start, end } repeats that range.
   */
  async play({ from = 0, to = null, loop = null } = {}) {
    from = wholeFrame(from);
    if (to != null) to = wholeFrame(to);
    loop = wholeLoop(loop);
    await this.ensure(this.graph.rate || this.rate);
    this.range = { from, to, loop };
    this.lastPos = { frame: from, time: this.ctx.currentTime };
    this.#feed(from);
    this.node.port.postMessage({ type: 'play', from, to, loop });
    this.#setState('playing');
  }

  /**
   * Asks the mixer to post its latest output ('tap' events: { L, R, frame,
   * rate }, about 20 per second while playing). Reference counted: call
   * tap(true) when an analysis view needs it and tap(false) when it stops.
   */
  tap(on) {
    this.tapUsers = Math.max(0, (this.tapUsers || 0) + (on ? 1 : -1));
    this.node?.port.postMessage({ type: 'tap', on: this.tapUsers > 0 });
  }

  setLoop(loop) {
    loop = wholeLoop(loop);
    // Past the new loop's end the mixer jumps to its start on the next block:
    // the interpolated playhead follows rather than wrapping from the old position.
    if (this.playing && loop && loop.end > loop.start && this.lastPos.frame >= loop.end) this.lastPos = { frame: loop.start, time: this.ctx?.currentTime ?? 0 };
    this.range.loop = loop;
    this.node?.port.postMessage({ type: 'loop', loop });
    if (this.playing) this.#feed();
  }

  stop() {
    if (!this.node) return this.lastPos.frame;
    const at = this.position;
    this.node.port.postMessage({ type: 'stop' });
    this.lastPos = { frame: at, time: this.ctx?.currentTime ?? 0 };
    this.#setState('stopped');
    return at;
  }

  /** Moves the playhead while playing (seamless jump). */
  seek(frame) {
    // The mixer reads chunks by whole frame index: a fractional playhead (for
    // example the interpolated `position`) would read undefined samples as NaN.
    frame = wholeFrame(frame);
    this.lastPos = { frame, time: this.ctx?.currentTime ?? 0 };
    if (!this.node) return;
    this.#feed(frame);
    this.node.port.postMessage({ type: 'seek', frame });
  }

  #feed(at = this.position) {
    if (!this.node) return;
    const rate = this.graph.rate || this.rate;
    const windows = [[at - KEEP_BEHIND_S * rate, at + LOOKAHEAD_S * rate]];
    const loop = this.range.loop;
    if (loop && loop.end > loop.start) windows.push([loop.start, loop.start + LOOKAHEAD_S * rate]);
    const need = new Map();
    for (const track of this.graph.tracks) {
      for (const clip of track.clips) {
        if (clip.mute) continue;
        for (const [ws, we] of windows) {
          const a = Math.max(ws, clip.start);
          const b = Math.min(we, clip.start + clip.length);
          if (b <= a) continue;
          const s0 = clip.offset + (a - clip.start);
          const s1 = clip.offset + (b - clip.start);
          let set = need.get(clip.source);
          if (!set) need.set(clip.source, (set = new Set()));
          for (let i = Math.floor(s0 / CHUNK); i <= Math.floor((s1 - 1) / CHUNK); i++) set.add(i);
        }
      }
    }
    const port = this.node.port;
    for (const [key, indices] of need) {
      const channels = this.sources.get(key);
      if (!channels) continue;
      let sent = this.sent.get(key);
      if (!sent) this.sent.set(key, (sent = new Set()));
      for (const index of indices) {
        if (sent.has(index)) continue;
        const start = index * CHUNK;
        const len = Math.max(0, Math.min(CHUNK, channels[0].length - start));
        if (!len) continue;
        const data = channels.map((c) => c.toArray(start, start + len));
        port.postMessage({ type: 'chunk', key, index, channels: data }, data.map((d) => d.buffer));
        sent.add(index);
      }
    }
    for (const [key, sent] of this.sent) {
      const keep = need.get(key);
      for (const index of [...sent]) {
        if (keep && keep.has(index)) continue;
        port.postMessage({ type: 'drop', key, index });
        sent.delete(index);
      }
    }
  }

  // ---------------------------------------------------------------- recording

  /** Opens an input device for metering and recording. */
  async openInput({ deviceId } = {}) {
    await this.ensure(this.graph.rate || this.rate);
    this.closeInput();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });
    await this.ctx.audioWorklet.addModule(captureUrl);
    const src = this.ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(this.ctx, 'audio-studio-capture', { numberOfOutputs: 0 });
    const deviceChannels = stream.getAudioTracks()[0]?.getSettings().channelCount || 1;
    const map = this.inputMap;
    let mapped = false;
    if (!(map[0] === 0 && map[1] === 1)) {
      // Pick device channels for the recorded left and right channels.
      const n = Math.max(deviceChannels, ...map.map((c) => c + 1));
      const split = this.ctx.createChannelSplitter(n);
      const merge = this.ctx.createChannelMerger(2);
      src.connect(split);
      map.forEach((dev, ch) => {
        if (dev >= 0 && dev < n) split.connect(merge, dev, ch);
      });
      merge.connect(node);
      mapped = true;
    } else src.connect(node);
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'data') this.emit('record-data', m.channels);
      else if (m.type === 'meter') this.emit('input-meter', m.peak);
    };
    this.input = { stream, src, node, channels: mapped ? 2 : deviceChannels };
    return this.input;
  }

  setRecording(on) {
    this.input?.node.port.postMessage({ type: 'record', on });
  }

  closeInput() {
    if (!this.input) return;
    this.input.node.port.postMessage({ type: 'record', on: false });
    this.input.src.disconnect();
    for (const t of this.input.stream.getTracks()) t.stop();
    this.input = null;
  }

  /** Context time to wall-clock conversion for latency-compensated recording. */
  get outputLatencyFrames() {
    if (!this.ctx) return 0;
    return Math.round(((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * this.rate);
  }
}

export const engine = new Engine();
