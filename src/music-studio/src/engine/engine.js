// Audio engine facade used by the UI. The real-time work happens in an
// AudioWorklet (worklet.js) running the WebAssembly DSP core (core.js,
// engine.wasm built from wasm/engine); this class owns the AudioContext,
// keeps the audio thread in sync with the store and runs offline renders in
// a Worker (offline-worker.js).
//
//   const engine = new Engine(store, prefs)
//   await engine.start()            // after a user gesture; idempotent. Resolves true when
//                                   // audio runs, false when it is unavailable (an 'error'
//                                   // is emitted once and the transport clock still works)
//   engine.play() / stop() / togglePlay() / seek(ticks)
//   engine.mode = 'pattern' | 'song'
//   engine.playing, engine.position (ticks, interpolated for drawing)
//   engine.tempo                    TempoMap (engine/tempo.js) of the current mode: song mode
//                                   follows tempo automation clips, pattern mode plays at project.bpm
//   engine.ticksToSeconds(tick) / secondsToTicks(sec)   song position <-> time through that map
//   engine.bpmAt(tick)              tempo at a position (project.bpm outside tempo clips)
//   engine.countingIn               true during the count-in bar before recording
//   engine.noteOn(channelId, key, vel) / noteOff(channelId, key) / allNotesOff({ hard = true })
//   engine.meters        Float32Array, [peakL, peakR] per mixer track, updated ~30x/s
//   engine.cpu           0..1 share of the audio time budget used
//   engine.loadSample(sampleId, { channels: Float32Array[], rate }) / unloadSample(sampleId)
//   engine.audition({ type, params, sample }, key, vel)   one-off preview voice (browser presets),
//                                                         played through the master; returns a stop()
//                                                         (`sample`: a loaded sample id or { channels, rate })
//   engine.render({ mode, patternId, start, end, rate, tail, isolate, onProgress, signal })
//     -> { channels: [Float32Array, Float32Array], rate }
//     mode 'song' (default; start/end default to the whole song) or 'pattern' (patternId
//     defaults to the selected pattern); tail: seconds rendered after `end` at most (stops
//     early after 0.25 s of silence); isolate: a mixer insert index, only signal that passes
//     through it reaches the master (stems); signal: an AbortSignal (rejects with AbortError).
//   engine.ready, engine.ctx, engine.sampleRate, engine.unavailable (reason string or null)
//   engine.restart()               recreate the context (prefs 'latencyHint', 'sampleRate'
//                                  ('auto' or Hz) and 'outputDevice' are read on start)
//   engine.setOutputDevice(id)     route the output to a device (setSinkId where supported)
//
// Live notes (noteOn, audition) also start the engine: called from a user
// gesture they work before start(); the notes are queued until the audio
// thread is ready. Without audio they are ignored.
//
// Events: 'state' (playing, mode, recording, count-in changed), 'meters', 'stats',
// 'error' (Error), 'loop' (playback wrapped).
//
// The engine follows the store on its own: every project change (including
// gesture previews) is synced to the audio thread, so a knob turn is heard
// while it moves. Parameter, mixer and channel changes are sent as small
// per-channel and per-track messages; note data is recompiled at most every
// 30 ms during drags.

import { Emitter } from '../lib/emitter.js';
import { patternById, patternLength, songLength } from '../model/project.js';
import { ticksPerBar } from '../model/time.js';
import { paramVector } from '../instruments/catalog.js';
import { DIVISION_BEATS } from '../effects/catalog.js';
import { compileChannel, compileMixer, compileSequence, compileTrack, instrumentIndex, mixerGains, tempoMap, trackOrder } from './compile.js';

const SEQ_THROTTLE_MS = 30;
const AUDITION_SLOTS = 2;
const AUDITION_SAMPLE = 65535;
// Messages queued before the audio thread exists that are replayed once it does.
const REPLAY = new Set(['note', 'allOff', 'play', 'stop', 'seek']);

let modulePromise = null;

/** The compiled WebAssembly module (fetched once, shared by playback and renders). */
export function engineModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const { default: url } = await import('./engine.wasm?url');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not load the audio engine (${res.status}).`);
      if (WebAssembly.compileStreaming && res.headers.get('content-type')?.includes('wasm')) {
        try {
          return await WebAssembly.compileStreaming(res.clone());
        } catch {
          // Fall through to the buffered path (wrong MIME type on some hosts).
        }
      }
      return WebAssembly.compile(await res.arrayBuffer());
    })();
    modulePromise.catch(() => {
      modulePromise = null;
    });
  }
  return modulePromise;
}

export class Engine extends Emitter {
  constructor(store, prefs) {
    super();
    this.store = store;
    this.prefs = prefs;
    this.ctx = null;
    this.node = null;
    this.unavailable = null;
    this._mode = 'pattern';
    this.playing = false;
    this.recording = false;
    this.countingIn = false;
    this.meters = new Float32Array(store.project.mixer.length * 2);
    this.cpu = 0;
    this._startTick = 0;
    this._startTime = 0;
    this._pausedAt = 0;
    this._anchor = null;
    this._wraps = 0;
    this._queue = [];
    this._starting = null;
    // Channel slots in the audio engine.
    this._slots = new Map(); // channel id -> slot
    this._free = [];
    this._nextSlot = 0;
    this._audition = [];
    this._auditionNext = 0;
    // Samples: id -> index, and the decoded data (resent when the context restarts).
    this._sampleIndex = new Map();
    this._sampleData = new Map();
    this._nextSample = 0;
    // What the audio thread has.
    this._sentChannels = new Map(); // channel id -> { ref, gain, sample }
    this._sentTracks = [];
    this._sentGains = [];
    this._sentOrder = '';
    this._sentCount = 0;
    this._seqKey = '';
    this._seqAt = 0;
    this._seqTimer = null;
    this._seqPattern = null;
    this._renderWorker = null;
    this._renderJobs = new Map();
    this._renderId = 1;

    // Slots for the initial project, so live notes work (and start audio) right away.
    this.#syncChannels(store.project);
    store.on('change', (p, prev, info) => this.#onChange(p, prev, info));
    store.on('view', () => this.#onView());
    prefs?.on?.('change', (key) => {
      if (key === 'metronome') this.#post({ type: 'opts', metronome: Boolean(prefs.get('metronome')) });
    });
  }

  get ready() {
    return Boolean(this.node);
  }

  get sampleRate() {
    return this.ctx?.sampleRate || 48000;
  }

  /** Seconds between the audio thread rendering a sample and it being heard. */
  get latency() {
    const c = this.ctx;
    return c ? (c.outputLatency || 0) + (c.baseLatency || 0) : 0;
  }

  // ---------------------------------------------------------------- startup

  start() {
    if (this.node) {
      if (this.ctx.state === 'suspended') return this.ctx.resume().then(() => true, () => true);
      return Promise.resolve(true);
    }
    if (this.unavailable) return Promise.resolve(false);
    if (!this._starting) {
      this._starting = this.#create().finally(() => {
        this._starting = null;
      });
    }
    return this._starting;
  }

  #fail(message) {
    this.unavailable = message;
    this._queue = [];
    try {
      this.ctx?.close();
    } catch {
      // Already closed.
    }
    this.ctx = null;
    this.emit('error', new Error(message));
    return false;
  }

  async #create() {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return this.#fail('Sound is unavailable: this browser does not support Web Audio.');
    let ctx;
    const latencyHint = this.prefs?.get?.('latencyHint') || 'interactive';
    const rate = Number(this.prefs?.get?.('sampleRate'));
    try {
      try {
        ctx = new Ctx(rate >= 8000 ? { latencyHint, sampleRate: rate } : { latencyHint });
      } catch (err) {
        // Some devices refuse a requested rate: fall back to the device rate.
        if (!(rate >= 8000)) throw err;
        ctx = new Ctx({ latencyHint });
      }
    } catch (err) {
      return this.#fail(`Sound is unavailable: the browser blocked the audio device (${err?.message || err}).`);
    }
    this.ctx = ctx;
    const sink = this.prefs?.get?.('outputDevice');
    if (sink && sink !== 'default' && ctx.setSinkId) ctx.setSinkId(sink).catch(() => {});
    // Resume inside the user gesture (before any await) so autoplay rules allow it.
    const resumed = ctx.state === 'suspended' ? ctx.resume().catch(() => {}) : null;
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return this.#fail('Sound is unavailable: this browser does not support AudioWorklet.');
    if (typeof WebAssembly === 'undefined') return this.#fail('Sound is unavailable: this browser does not support WebAssembly.');
    try {
      const [module, { default: url }] = await Promise.all([engineModule(), import('./worklet.js?worker&url')]);
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'music-studio-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.port.onmessage = (e) => this.#onMessage(e.data);
      node.onprocessorerror = () => this.emit('error', new Error('The audio engine stopped unexpectedly. Reload the page to restore sound.'));
      node.connect(ctx.destination);
      node.port.postMessage({ type: 'init', module });
      this.node = node;
    } catch (err) {
      return this.#fail(`Sound is unavailable: the audio engine could not load (${err?.message || err}).`);
    }
    // The full current state goes first; of what was queued while starting,
    // only live input and transport survive (queued configuration is older
    // than what #sendAll just sent and would overwrite it).
    const queued = this._queue;
    this._queue = [];
    this.#sendAll();
    for (const m of queued) if (this.#replayable(m)) this.node.port.postMessage(m);
    // resume() stays pending while the browser withholds audio; never wait on it.
    resumed?.then(() => {
      if (ctx.state !== 'running') this.#resumeOnGesture();
    });
    if (ctx.state !== 'running') this.#resumeOnGesture();
    ctx.onstatechange = () => {
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') this.#resumeOnGesture();
    };
    return true;
  }

  #replayable(m) {
    if (m.type === 'channel') return this._audition.includes(m.cfg.slot);
    if (m.type === 'sample') return m.index === AUDITION_SAMPLE;
    return REPLAY.has(m.type);
  }

  /**
   * Recreates the audio context (after latency or sample rate preferences
   * change). Playback stops; the project, samples and settings are resent.
   * Does nothing until audio has been started once.
   */
  async restart() {
    if (this._starting) await this._starting;
    if (!this.ctx && !this.unavailable) return false;
    if (this.playing) this.stop();
    const old = this.ctx;
    const node = this.node;
    this.node = null;
    this.ctx = null;
    this.unavailable = null;
    this._wraps = 0;
    this._wrapsAtPlay = 0;
    try {
      node?.disconnect();
      node?.port.close();
      await old?.close();
    } catch {
      // Already closed.
    }
    return this.start();
  }

  /** Routes the output to an audio device (a deviceId from enumerateDevices; '' or 'default' for the system default). */
  async setOutputDevice(id) {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (!ctx.setSinkId) throw new Error('This browser cannot choose the audio output.');
    await ctx.setSinkId(!id || id === 'default' ? '' : id);
    return true;
  }

  /** Browsers may keep the context suspended until the next click or key press. */
  #resumeOnGesture() {
    if (this._resumeHook || typeof document === 'undefined') return;
    const resume = () => {
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      this._resumeHook = null;
      this.ctx?.resume().catch(() => {});
    };
    this._resumeHook = resume;
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
  }

  #post(m, transfer) {
    if (this.node) this.node.port.postMessage(m, transfer || []);
    else if (this._starting) this._queue.push(m);
  }

  #onMessage(m) {
    switch (m.type) {
      case 'pos': {
        const now = performance.now();
        if (m.wraps > this._wraps) {
          const passes = m.wraps - this._wraps;
          this._wraps = m.wraps;
          if (this.playing) for (let i = 0; i < passes; i++) this.emit('loop');
        }
        if (this.playing && m.playing) this._anchor = { tick: m.tick, perf: now, counting: m.counting };
        if (this.countingIn !== Boolean(m.counting && this.playing)) {
          this.countingIn = Boolean(m.counting && this.playing);
          this.emit('state');
        }
        if (m.meters.length !== this.meters.length) this.meters = new Float32Array(m.meters.length);
        this.meters.set(m.meters);
        this.emit('meters');
        if (Math.abs(m.cpu - this.cpu) > 0.002 || now - (this._statsAt || 0) > 1000) {
          this._statsAt = now;
          this.cpu = m.cpu;
          this.voices = m.voices;
          this.emit('stats');
        }
        break;
      }
      case 'error':
        this.emit('error', new Error(m.message));
        break;
      case 'ready':
        break;
    }
  }

  // ---------------------------------------------------------------- transport

  get mode() {
    return this._mode;
  }

  set mode(m) {
    if (m !== 'pattern' && m !== 'song') return;
    if (m === this._mode) return;
    const wasPlaying = this.playing;
    if (wasPlaying) this.stop();
    this._mode = m;
    this._pausedAt = 0;
    this.#sendSeq();
    this.emit('state');
    if (wasPlaying) this.play();
  }

  /** Playback range in ticks for the current mode: [start, end). */
  range() {
    const p = this.store.project;
    if (this._mode === 'pattern') {
      const pat = patternById(p, this.store.view.pattern) || p.patterns[0];
      return { start: 0, end: patternLength(pat, p.sig) };
    }
    if (p.loop) return { start: p.loop.start, end: p.loop.end };
    const bar = ticksPerBar(p.sig);
    return { start: 0, end: Math.max(bar, Math.ceil(songLength(p) / bar) * bar) };
  }

  async play() {
    const started = this.start();
    if (this.playing) return;
    const { start, end } = this.range();
    if (this._pausedAt >= end) this._pausedAt = start;
    this.playing = true;
    this._startTick = this._pausedAt;
    this._startTime = performance.now() / 1000;
    this._anchor = null;
    this._wrapsAtPlay = this._wraps;
    this.#flushSeq();
    const countIn = Boolean(this.recording && this.prefs?.get?.('countIn'));
    this.countingIn = countIn && !this.unavailable;
    this.#post({ type: 'play', tick: this._pausedAt, countIn });
    this.emit('state');
    await started;
  }

  stop() {
    if (!this.playing) {
      this._pausedAt = 0;
      this.emit('state');
      return;
    }
    this.playing = false;
    this.countingIn = false;
    this._pausedAt = 0;
    this._anchor = null;
    this.#post({ type: 'stop' });
    this.emit('state');
  }

  togglePlay() {
    if (this.playing) this.stop();
    else this.play();
  }

  seek(ticks) {
    this._pausedAt = Math.max(0, ticks);
    if (this.playing) {
      this._startTick = this._pausedAt;
      this._startTime = performance.now() / 1000;
      this._wrapsAtPlay = this._wraps;
      // Show the new position right away; worklet reports take over.
      const map = this.tempo;
      this._anchor = { tick: map.ticks(map.seconds(this._pausedAt) + this.latency), perf: performance.now(), counting: false };
      this.#post({ type: 'seek', tick: this._pausedAt });
    }
    this.emit('state');
  }

  /** Tempo map of the current mode (cached per project state). */
  get tempo() {
    return tempoMap(this.store.project, this._mode);
  }

  /** Seconds from the start of the song (or pattern) to `tick`, following tempo automation. */
  ticksToSeconds(tick) {
    return this.tempo.seconds(tick);
  }

  /** Song position in ticks reached after `sec` seconds. */
  secondsToTicks(sec) {
    return this.tempo.ticks(sec);
  }

  /** Tempo in BPM at a position. */
  bpmAt(tick) {
    return this.tempo.bpmAt(tick);
  }

  /** Current position in ticks (wrapped into the play range). */
  get position() {
    if (!this.playing) return this._pausedAt;
    const { start, end } = this.range();
    const len = Math.max(1, end - start);
    let t;
    if (this.node) {
      const a = this._anchor;
      if (!a) return this._startTick;
      if (a.counting) return a.tick;
      const map = this.tempo;
      t = map.ticks(map.seconds(a.tick) + (performance.now() - a.perf) / 1000 - this.latency);
      if (t < start) t = this._wraps > this._wrapsAtPlay ? t + len : Math.max(t, Math.min(this._startTick, start));
      if (t < this._startTick && this._wraps === this._wrapsAtPlay) t = this._startTick;
    } else {
      const elapsed = performance.now() / 1000 - this._startTime;
      const map = this.tempo;
      t = map.ticks(map.seconds(this._startTick) + elapsed);
    }
    if (t < end) return t;
    return start + ((t - start) % len);
  }

  setRecording(on) {
    this.recording = Boolean(on);
    this.emit('state');
  }

  // ---------------------------------------------------------------- live notes

  noteOn(channelId, key, vel = 0.8) {
    const slot = this._slots.get(channelId);
    if (slot === undefined) return;
    this.start();
    this.#post({ type: 'note', slot, key, vel, on: true });
  }

  noteOff(channelId, key) {
    const slot = this._slots.get(channelId);
    if (slot === undefined) return;
    this.#post({ type: 'note', slot, key, vel: 0, on: false });
  }

  allNotesOff({ hard = true } = {}) {
    this.#post({ type: 'allOff', hard });
  }

  audition({ type = 'synth', params = {}, sample = null } = {}, key = 60, vel = 0.8) {
    if (instrumentIndex(type) < 0) return () => {};
    this.start();
    if (this.unavailable) return () => {};
    if (this._audition.length < AUDITION_SLOTS) this._audition.push(this.#allocSlot());
    const slot = this._audition[this._auditionNext];
    this._auditionNext = (this._auditionNext + 1) % this._audition.length;
    let sampleIndex = -1;
    if (typeof sample === 'string') sampleIndex = this._sampleIndex.get(sample) ?? -1;
    else if (sample?.channels?.length) {
      sampleIndex = AUDITION_SAMPLE;
      this.#post({ type: 'sample', index: sampleIndex, channels: sample.channels, rate: sample.rate || 48000 });
    }
    const cfg = { slot, type: instrumentIndex(type), params: paramVector(type, params), volume: 0.8, pan: 0, pitch: 0, mixer: 0, gain: 1, sample: sampleIndex };
    this.#post({ type: 'channel', cfg });
    this.#post({ type: 'note', slot, key, vel, on: true });
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.#post({ type: 'note', slot, key, vel: 0, on: false });
    };
  }

  // ---------------------------------------------------------------- samples

  #sampleIdx(id) {
    let i = this._sampleIndex.get(id);
    if (i === undefined) {
      i = this._nextSample++;
      this._sampleIndex.set(id, i);
    }
    return i;
  }

  async loadSample(id, { channels, rate }) {
    if (!channels?.length) return;
    const index = this.#sampleIdx(id);
    this._sampleData.set(id, { channels, rate });
    if (this.node) this.node.port.postMessage({ type: 'sample', index, channels, rate });
  }

  unloadSample(id) {
    const index = this._sampleIndex.get(id);
    if (index === undefined) return;
    this._sampleData.delete(id);
    if (this.node) this.node.port.postMessage({ type: 'unsample', index });
  }

  // ---------------------------------------------------------------- sync

  #allocSlot() {
    return this._free.length ? this._free.pop() : this._nextSlot++;
  }

  #slotOf = (id) => this._slots.get(id) ?? -1;

  #onChange(p, prev, info) {
    if (info?.source === 'load') {
      if (this.playing) this.stop();
      this._pausedAt = 0;
      this.#post({ type: 'reset' });
      this._sentChannels.clear();
      this._sentTracks = [];
      this._sentGains = [];
      this._sentCount = 0;
      this._sentOrder = '';
      this.#syncChannels(p);
      this.#syncMixer(p);
      this.#post({ type: 'pitch', cents: p.masterPitch || 0 });
      this.#sendSeq();
      return;
    }
    if (this.playing && (p.bpm !== prev.bpm || p.clips !== prev.clips || p.automation !== prev.automation || p.tracks !== prev.tracks)) this.#keepPosition(prev);
    const channelsChanged = p.channels !== prev.channels;
    if (channelsChanged) this.#syncChannels(p);
    if (p.mixer !== prev.mixer) this.#syncMixer(p);
    if (p.masterPitch !== prev.masterPitch) this.#post({ type: 'pitch', cents: p.masterPitch || 0 });
    if (
      p.patterns !== prev.patterns ||
      p.clips !== prev.clips ||
      p.automation !== prev.automation ||
      p.tracks !== prev.tracks ||
      p.bpm !== prev.bpm ||
      p.swing !== prev.swing ||
      p.sig !== prev.sig ||
      p.loop !== prev.loop ||
      ((channelsChanged || p.mixer !== prev.mixer) && this.#structureKey(p) !== this._structure)
    ) {
      this.#scheduleSeq();
    }
  }

  /**
   * A tempo change while playing keeps the musical position: the clock is
   * re-anchored at the position the previous tempo map had reached.
   */
  #keepPosition(prev) {
    const old = tempoMap(prev, this._mode);
    const now = performance.now();
    if (this._anchor && !this._anchor.counting) {
      const a = this._anchor;
      this._anchor = { tick: old.ticks(old.seconds(a.tick) + (now - a.perf) / 1000), perf: now, counting: false };
    } else if (!this.node) {
      this._startTick = old.ticks(old.seconds(this._startTick) + now / 1000 - this._startTime);
      this._startTime = now / 1000;
    }
  }

  #onView() {
    if (this._mode === 'pattern' && this.store.view.pattern !== this._seqPattern) this.#sendSeq();
  }

  /** Channel ids and effect slot ids: what automation targets resolve against. */
  #structureKey(p) {
    let k = '';
    for (const c of p.channels) k += `${c.id}:${c.type},`;
    k += '|';
    for (const t of p.mixer) {
      for (const s of t.fx) k += `${s.id}:${s.type},`;
      k += ';';
    }
    return k;
  }

  #syncChannels(p) {
    const anySolo = p.channels.some((c) => c.solo);
    const seen = new Set();
    for (const ch of p.channels) {
      seen.add(ch.id);
      let slot = this._slots.get(ch.id);
      if (slot === undefined) {
        slot = this.#allocSlot();
        this._slots.set(ch.id, slot);
      }
      const gain = ch.mute || (anySolo && !ch.solo) ? 0 : 1;
      const sample = ch.sample ? this.#sampleIdx(ch.sample) : -1;
      const sent = this._sentChannels.get(ch.id);
      if (sent && sent.ref === ch && sent.gain === gain && sent.sample === sample && sent.count === p.mixer.length) continue;
      this._sentChannels.set(ch.id, { ref: ch, gain, sample, count: p.mixer.length });
      if (this.node || this._starting) this.#post({ type: 'channel', cfg: compileChannel(p, ch, slot, (id) => this.#sampleIdx(id)) });
    }
    for (const [id, slot] of this._slots) {
      if (seen.has(id)) continue;
      this._slots.delete(id);
      this._sentChannels.delete(id);
      this._free.push(slot);
      this.#post({ type: 'remove', slot });
    }
  }

  #syncMixer(p) {
    const gains = mixerGains(p);
    if (p.mixer.length !== this._sentCount) {
      this._sentCount = p.mixer.length;
      const mixer = compileMixer(p);
      delete mixer.feeds;
      this.#post({ type: 'mixer', mixer });
      this._sentTracks = [...p.mixer];
      this._sentGains = gains;
      this._sentOrder = mixer.order.join(',');
      if (this.meters.length !== p.mixer.length * 2) this.meters = new Float32Array(p.mixer.length * 2);
      // Channel destinations are clamped to the mixer size.
      this.#syncChannels(p);
      return;
    }
    for (let i = 0; i < p.mixer.length; i++) {
      if (p.mixer[i] === this._sentTracks[i] && gains[i] === this._sentGains[i]) continue;
      this._sentTracks[i] = p.mixer[i];
      this._sentGains[i] = gains[i];
      this.#post({ type: 'track', index: i, cfg: compileTrack(p, i, gains[i]) });
    }
    const order = trackOrder(p);
    const key = order.join(',');
    if (key !== this._sentOrder) {
      this._sentOrder = key;
      this.#post({ type: 'order', order });
    }
  }

  #scheduleSeq() {
    if (this._seqTimer) return;
    const wait = SEQ_THROTTLE_MS - (performance.now() - this._seqAt);
    if (wait <= 0) this.#sendSeq();
    else
      this._seqTimer = setTimeout(() => {
        this._seqTimer = null;
        this.#sendSeq();
      }, wait);
  }

  /** Sends a pending sequence update now (before play). */
  #flushSeq() {
    if (this._seqTimer) {
      clearTimeout(this._seqTimer);
      this._seqTimer = null;
    }
    this.#sendSeq();
  }

  #sendSeq() {
    if (this._seqTimer) {
      clearTimeout(this._seqTimer);
      this._seqTimer = null;
    }
    this._seqAt = performance.now();
    const p = this.store.project;
    this._structure = this.#structureKey(p);
    this._seqPattern = this.store.view.pattern;
    if (!this.node && !this._starting) return;
    const seq = compileSequence(p, { mode: this._mode, patternId: this.store.view.pattern, slotOf: this.#slotOf });
    const n = seq.notes;
    const transfer = [n.start.buffer, n.end.buffer, n.slot.buffer, n.key.buffer, n.vel.buffer, n.pan.buffer, n.kind.buffer, n.offset.buffer, seq.audio.buffer];
    for (const lane of seq.auto) for (const s of lane.segs) {
      transfer.push(s.pts.buffer);
      if (s.cs) transfer.push(s.cs.buffer);
    }
    transfer.push(seq.tempo.tick.buffer, seq.tempo.b0.buffer, seq.tempo.b1.buffer);
    this.#post({ type: 'seq', seq }, transfer);
  }

  /** Everything the audio thread needs, after (re)creating it. */
  #sendAll() {
    const p = this.store.project;
    this._sentChannels.clear();
    this._sentTracks = [];
    this._sentGains = [];
    this._sentCount = 0;
    this._sentOrder = '';
    for (const [id, data] of this._sampleData) this.#post({ type: 'sample', index: this.#sampleIdx(id), channels: data.channels, rate: data.rate });
    this.#syncMixer(p);
    this.#syncChannels(p);
    this.#post({ type: 'pitch', cents: p.masterPitch || 0 });
    this.#post({ type: 'opts', metronome: Boolean(this.prefs?.get?.('metronome')) });
    this.#sendSeq();
  }

  // ---------------------------------------------------------------- offline render

  async render({ mode = 'song', patternId = null, start, end, rate = 48000, tail = 2, isolate = null, onProgress, signal } = {}) {
    if (signal?.aborted) throw abortError();
    const p = this.store.project;
    const pid = patternId || this.store.view.pattern;
    const bar = ticksPerBar(p.sig);
    let s = Number.isFinite(start) ? Math.max(0, start) : 0;
    let e = end;
    if (!Number.isFinite(e)) {
      if (mode === 'pattern') {
        const pat = patternById(p, pid) || p.patterns[0];
        e = patternLength(pat, p.sig);
      } else e = Math.max(bar, songLength(p));
    }
    if (e <= s) e = s + bar;
    const slots = new Map(p.channels.map((c, i) => [c.id, i]));
    const mixer = compileMixer(p, { isolate: Number.isInteger(isolate) ? isolate : null });
    const sampleIdx = new Map();
    const samples = [];
    const idxOf = (id) => {
      if (sampleIdx.has(id)) return sampleIdx.get(id);
      const data = this._sampleData.get(id);
      if (!data) return -1;
      const i = samples.length;
      sampleIdx.set(id, i);
      samples.push({ index: i, channels: data.channels, rate: data.rate });
      return i;
    };
    const channels = p.channels.map((c, i) => compileChannel(p, c, i, idxOf, { isolate: Number.isInteger(isolate) ? isolate : null, feeds: mixer.feeds }));
    delete mixer.feeds;
    const seq = compileSequence(p, { mode, patternId: pid, slotOf: (id) => slots.get(id) ?? -1, range: { start: s, end: e } });
    const module = await engineModule();
    const worker = await this.#getRenderWorker();
    if (signal?.aborted) throw abortError();
    const id = this._renderId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => worker.postMessage({ type: 'cancel', id });
      signal?.addEventListener('abort', onAbort, { once: true });
      this._renderJobs.set(id, {
        onProgress,
        resolve: (v) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      });
      worker.postMessage({ type: 'render', id, module, rate, channels, mixer, seq, samples, tail: Math.max(0, Number(tail) || 0), silence: echoGap(p) + 0.1, pitch: p.masterPitch || 0 });
    });
  }

  async #getRenderWorker() {
    if (this._renderWorker) return this._renderWorker;
    const { default: RenderWorker } = await import('./offline-worker.js?worker');
    const w = new RenderWorker();
    w.onmessage = (ev) => {
      const m = ev.data;
      const job = this._renderJobs.get(m.id);
      if (!job) return;
      if (m.type === 'progress') job.onProgress?.(m.done);
      else if (m.type === 'done') {
        this._renderJobs.delete(m.id);
        job.resolve({ channels: m.channels, rate: m.rate });
      } else if (m.type === 'error') {
        this._renderJobs.delete(m.id);
        job.reject(m.message === 'cancelled' ? abortError() : new Error(m.message));
      }
    };
    w.onerror = (ev) => {
      for (const job of this._renderJobs.values()) job.reject(new Error(ev.message || 'Rendering failed.'));
      this._renderJobs.clear();
      this._renderWorker = null;
    };
    this._renderWorker = w;
    return w;
  }

  /** Seconds of audio for a tick span starting at `from` (tick 0 by default), following the tempo map. */
  seconds(ticks, from = 0) {
    return this.tempo.duration(from, from + ticks);
  }
}

/**
 * Longest silence between delay echoes in seconds: a render tail may only
 * end after a quiet stretch longer than that, or echoes would be cut off.
 */
export function echoGap(project) {
  let gap = 0;
  // Synced delays are longest at the slowest tempo the song reaches.
  const map = tempoMap(project);
  let bpm = project.bpm || 120;
  for (let i = 0; i < map.n; i++) bpm = Math.min(bpm, map.B0[i], map.B1[i]);
  for (const t of project.mixer) {
    for (const s of t.fx || []) {
      if (s.type !== 'delay' || s.on === false) continue;
      const q = s.params || {};
      const sec = q.sync ? ((DIVISION_BEATS[Math.round(q.division ?? 7)] || 0) * 60) / bpm : (q.time ?? 350) / 1000;
      if (sec > gap) gap = sec;
    }
  }
  return gap;
}

function abortError() {
  try {
    return new DOMException('Rendering was cancelled.', 'AbortError');
  } catch {
    const e = new Error('Rendering was cancelled.');
    e.name = 'AbortError';
    return e;
  }
}
