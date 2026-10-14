// JavaScript side of the WebAssembly engine (src/engine/engine.wasm, built
// from wasm/engine). Used by the AudioWorklet, the offline render worker and
// the tests; it has no browser dependencies.
//
//   const core = new Core(new WebAssembly.Instance(module, {}), sampleRate)
//   core.setChannel(cfg) / removeChannel(slot)     (cfg from compile.js)
//   core.setMixer({ count, tracks, order }) / setTrack(i, cfg) / setOrder(order)
//   core.loadSample(index, channels, rate) / unloadSample(index)
//   core.noteOn(slot, id, key, vel, pan, offset) / noteOff(slot, id, offset)
//   core.audioOn(slot, id, seconds, gain, offset) / allOff(slot, hard, offset)
//   core.process(frames) -> { l, r } (views into wasm memory, valid until the next call)
//
// The core remembers the configured (project) values so automation can
// override parameters in the engine and restore them afterwards
// (`automate*` / `restore*`). Configuration calls only touch what changed.

export const BLOCK = 128;
export const ALL = 0xffffffff;

export class Core {
  constructor(instance, rate) {
    this.x = instance.exports;
    this.rate = rate;
    this.x.engine_init(rate);
    this.block = this.x.engine_block();
    this.chans = new Map(); // slot -> { type, params: Float64Array, sample, strip: [vol, pan, pitch, mixer, gain] }
    this.tracks = []; // { volume, pan, width, gain, fx: [{ type, on, mix, params }], routes }
    this.trackCount = 17;
    this.bpm = 120;
    this.views = null;
  }

  get memory() {
    return this.x.memory.buffer;
  }

  #scratch(values) {
    const ptr = this.x.scratch_ptr();
    const v = new Float32Array(this.memory, ptr, 4096);
    const n = Math.min(values.length, 4096);
    for (let i = 0; i < n; i++) v[i] = values[i];
    return n;
  }

  // -------------------------------------------------------------- channels

  setChannel(cfg) {
    const x = this.x;
    let c = this.chans.get(cfg.slot);
    const fresh = !c || c.type !== cfg.type;
    if (fresh) {
      x.ch_set_type(cfg.slot, cfg.type);
      c = { type: cfg.type, params: new Float64Array(cfg.params.length).fill(NaN), sample: -2, strip: [NaN, NaN, NaN, -1, NaN] };
      this.chans.set(cfg.slot, c);
    }
    const p = cfg.params;
    if (c.params.length !== p.length) c.params = new Float64Array(p.length).fill(NaN);
    for (let i = 0; i < p.length; i++) {
      if (c.params[i] !== p[i]) {
        c.params[i] = p[i];
        x.ch_set_param(cfg.slot, i, p[i]);
      }
    }
    if (fresh) x.ch_settle(cfg.slot);
    if (c.sample !== cfg.sample) {
      c.sample = cfg.sample;
      x.ch_set_sample(cfg.slot, cfg.sample);
    }
    const s = c.strip;
    if (s[0] !== cfg.volume || s[1] !== cfg.pan || s[2] !== cfg.pitch || s[3] !== cfg.mixer || s[4] !== cfg.gain) {
      s[0] = cfg.volume;
      s[1] = cfg.pan;
      s[2] = cfg.pitch;
      s[3] = cfg.mixer;
      s[4] = cfg.gain;
      x.ch_set_strip(cfg.slot, s[0], s[1], s[2], s[3], s[4]);
    }
  }

  removeChannel(slot) {
    if (!this.chans.has(slot)) return;
    this.chans.delete(slot);
    this.x.ch_set_type(slot, -1);
  }

  /** Slots currently configured. */
  slots() {
    return [...this.chans.keys()];
  }

  // -------------------------------------------------------------- mixer

  setMixer({ count, tracks, order }) {
    if (count !== this.trackCount) {
      this.x.mix_set_count(count);
      this.trackCount = count;
      this.tracks.length = Math.min(this.tracks.length, count);
    }
    tracks.forEach((t, i) => this.setTrack(i, t));
    this.setOrder(order);
  }

  setTrack(i, cfg) {
    const x = this.x;
    let t = this.tracks[i];
    if (!t) t = this.tracks[i] = { volume: NaN, pan: NaN, width: NaN, gain: NaN, fx: [], routes: null };
    if (t.volume !== cfg.volume || t.pan !== cfg.pan || t.width !== cfg.width || t.gain !== cfg.gain) {
      t.volume = cfg.volume;
      t.pan = cfg.pan;
      t.width = cfg.width;
      t.gain = cfg.gain;
      x.mix_set_track(i, t.volume, t.pan, t.width, t.gain);
    }
    for (let s = 0; s < 10; s++) {
      const want = cfg.fx[s];
      let have = t.fx[s];
      if (!want) {
        if (have) {
          x.mix_set_fx(i, s, -1, 0, 1);
          t.fx[s] = null;
        }
        continue;
      }
      if (!have || have.type !== want.type) {
        x.mix_set_fx(i, s, want.type, want.on ? 1 : 0, want.mix);
        have = t.fx[s] = { type: want.type, on: want.on, mix: want.mix, params: new Float64Array(want.params.length).fill(NaN) };
      } else if (have.on !== want.on || have.mix !== want.mix) {
        have.on = want.on;
        have.mix = want.mix;
        x.mix_set_fx(i, s, want.type, want.on ? 1 : 0, want.mix);
      }
      for (let k = 0; k < want.params.length; k++) {
        if (have.params[k] !== want.params[k]) {
          have.params[k] = want.params[k];
          x.mix_set_fx_param(i, s, k, want.params[k]);
        }
      }
    }
    const key = cfg.routes.map(([d, g]) => `${d}:${g}`).join(',');
    if (t.routes !== key) {
      t.routes = key;
      const flat = [];
      for (const [d, g] of cfg.routes) flat.push(d, g);
      this.#scratch(flat);
      x.mix_set_routes(i, cfg.routes.length);
    }
  }

  setOrder(order) {
    const key = order.join(',');
    if (key === this.orderKey) return;
    this.orderKey = key;
    this.x.mix_set_order(this.#scratch(order));
  }

  /** Clears effect state and silences every voice (new project, offline render start). */
  reset() {
    this.x.mix_reset();
  }

  // -------------------------------------------------------------- automation

  automateParam(slot, index, v) {
    if (this.chans.has(slot)) this.x.ch_set_param(slot, index, v);
  }

  restoreParam(slot, index) {
    const c = this.chans.get(slot);
    if (c && Number.isFinite(c.params[index])) this.x.ch_set_param(slot, index, c.params[index]);
  }

  /** Overrides one strip field ('volume' | 'pan' | 'pitch'); null restores the configured strip. */
  automateStrip(slot, field, v) {
    const c = this.chans.get(slot);
    if (!c) return;
    const s = c.strip;
    const vol = field === 'volume' && v !== null ? v : s[0];
    const pan = field === 'pan' && v !== null ? v : s[1];
    const pitch = field === 'pitch' && v !== null ? v : s[2];
    this.x.ch_set_strip(slot, vol, pan, pitch, s[3], s[4]);
  }

  automateTrack(i, field, v) {
    const t = this.tracks[i];
    if (!t) return;
    this.x.mix_set_track(i, field === 'volume' && v !== null ? v : t.volume, field === 'pan' && v !== null ? v : t.pan, field === 'width' && v !== null ? v : t.width, t.gain);
  }

  automateFx(i, s, index, v) {
    const f = this.tracks[i]?.fx[s];
    if (!f) return;
    this.x.mix_set_fx_param(i, s, index, v === null ? f.params[index] : v);
  }

  automateMix(i, s, v) {
    const f = this.tracks[i]?.fx[s];
    if (!f) return;
    this.x.mix_set_fx(i, s, f.type, f.on ? 1 : 0, v === null ? f.mix : v);
  }

  // -------------------------------------------------------------- samples

  loadSample(index, channels, rate) {
    const frames = channels[0]?.length || 0;
    const n = Math.min(2, channels.length);
    const ptr = this.x.sample_alloc(index, frames, n, rate);
    if (!ptr && frames) throw new Error('Out of memory for audio samples.');
    const mem = new Float32Array(this.memory);
    for (let c = 0; c < n; c++) mem.set(channels[c], (ptr >> 2) + c * frames);
    this.views = null;
  }

  unloadSample(index) {
    this.x.sample_free(index);
  }

  // -------------------------------------------------------------- events

  setTempo(bpm) {
    if (bpm !== this.bpm) {
      this.bpm = bpm;
      this.x.set_tempo(bpm);
    }
  }

  setMasterPitch(cents) {
    this.x.set_master_pitch(cents);
  }

  noteOn(slot, id, key, vel, pan = 0, offset = 0) {
    this.x.ch_note_on(slot, id >>> 0, key, vel, pan, offset);
  }

  noteOff(slot, id, offset = 0) {
    this.x.ch_note_off(slot, id >>> 0, offset);
  }

  audioOn(slot, id, seconds, gain = 1, offset = 0) {
    this.x.ch_audio_on(slot, id >>> 0, seconds, gain, offset);
  }

  allOff(slot = ALL, hard = false, offset = 0) {
    this.x.ch_all_off(slot >>> 0, hard ? 1 : 0, offset);
  }

  click(accent, offset = 0) {
    this.x.click(accent ? 1 : 0, offset);
  }

  // -------------------------------------------------------------- render

  process(frames = BLOCK) {
    const ptr = this.x.process(frames);
    if (!this.views || this.views.buffer !== this.memory || this.views.ptr !== ptr) {
      const buf = this.memory;
      this.views = { buffer: buf, ptr, l: new Float32Array(buf, ptr, BLOCK), r: new Float32Array(buf, ptr + BLOCK * 4, BLOCK) };
    }
    return this.views;
  }

  /** Per-track peaks since the last call: Float32Array view [L, R] per track (copy it before the next call). */
  meters() {
    const ptr = this.x.meters_take();
    return new Float32Array(this.memory, ptr, this.x.track_count() * 2);
  }

  activeChannels() {
    return this.x.active_channels();
  }
}
