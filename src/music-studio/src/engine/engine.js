// Audio engine facade used by the UI. This is the contract; the real-time
// implementation lives behind it (worklet + WebAssembly DSP).
//
//   const engine = new Engine(store, prefs)
//   await engine.start()            // after a user gesture; idempotent
//   engine.play() / stop() / togglePlay() / seek(ticks)
//   engine.mode = 'pattern' | 'song'
//   engine.playing, engine.position (ticks, interpolated for drawing)
//   engine.noteOn(channelId, key, vel) / noteOff(channelId, key) / allNotesOff()
//   engine.meters        Float32Array, [peakL, peakR] per mixer track, updated ~30x/s
//   engine.cpu           0..1 share of the audio time budget used
//   engine.loadSample(sampleId, { channels: Float32Array[], rate }) / unloadSample(sampleId)
//   engine.audition({ type, params, sample }, key, vel)   one-off preview voice (browser presets),
//                                                         played through the master; returns a stop()
//   engine.render({ mode, patternId, start, end, rate, tail, isolate, onProgress }) -> { channels, rate }
//     isolate: a mixer insert index; only signal that passes through it reaches the master (stems)
//
// Events: 'state' (playing, mode, recording changed), 'meters', 'stats',
// 'error' (Error), 'loop' (playback wrapped).
//
// The engine follows the store on its own: every project change (including
// gesture previews) is synced to the audio thread, so a knob turn is heard
// while it moves.

import { Emitter } from '../lib/emitter.js';
import { patternById, patternLength, songLength } from '../model/project.js';
import { ticksToSeconds, ticksPerBar } from '../model/time.js';

export class Engine extends Emitter {
  constructor(store, prefs) {
    super();
    this.store = store;
    this.prefs = prefs;
    this.ctx = null;
    this._mode = 'pattern';
    this.playing = false;
    this.recording = false;
    this.meters = new Float32Array(store.project.mixer.length * 2);
    this.cpu = 0;
    this._startTick = 0;
    this._startTime = 0;
    this._pausedAt = 0;
  }

  get ready() {
    return Boolean(this.ctx);
  }

  async start() {
    return true;
  }

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
    await this.start();
    if (this.playing) return;
    this.playing = true;
    this._startTick = this._pausedAt;
    this._startTime = performance.now() / 1000;
    this.emit('state');
  }

  stop() {
    if (!this.playing) {
      this._pausedAt = 0;
      this.emit('state');
      return;
    }
    this.playing = false;
    this._pausedAt = 0;
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
    }
    this.emit('state');
  }

  /** Current position in ticks (wrapped into the play range). */
  get position() {
    if (!this.playing) return this._pausedAt;
    const bpm = this.store.project.bpm;
    const elapsed = performance.now() / 1000 - this._startTime;
    const t = this._startTick + (elapsed * bpm * 96) / 60;
    const { start, end } = this.range();
    if (t < end) return t;
    const len = Math.max(1, end - start);
    return start + ((t - start) % len);
  }

  setRecording(on) {
    this.recording = Boolean(on);
    this.emit('state');
  }

  noteOn() {}
  noteOff() {}
  allNotesOff() {}
  async loadSample() {}
  unloadSample() {}
  audition() {
    return () => {};
  }

  async render() {
    throw new Error('Rendering is not available yet.');
  }

  /** Seconds of audio for a tick span at the project tempo. */
  seconds(ticks) {
    return ticksToSeconds(ticks, this.store.project.bpm);
  }
}
