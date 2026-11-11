/**
 * Per-clip audio effects as streaming processors: channel routing, noise
 * reduction, voice enhancement, voice presets and pan. Everything works on
 * stereo blocks of any length, in place, so the SAME code runs in the
 * offline mixdown (engine/audio-mix.js) and in the preview AudioWorklet
 * (engine/fx-worklet.js). Plain JavaScript with no browser APIs.
 *
 * ClipChain(settings, sampleRate) builds the chain from
 * model/audio.js chainSettings(clip).
 */
import { NOISE_BAND_EDGES, NOISE_BANDS, defaultVoiceParams } from '../model/audio.js';

const TAU = Math.PI * 2;
const dbToGain = (db) => 10 ** (db / 20);

/* ---- Building blocks ---------------------------------------------------- */

/** RBJ biquad with independent state for two channels (transposed direct form II). */
export class Biquad {
  constructor(sr, type, freq, q = Math.SQRT1_2, gainDb = 0) {
    this.sr = sr;
    this.z = new Float64Array(4);
    this.set(type, freq, q, gainDb);
  }

  set(type, freq, q = Math.SQRT1_2, gainDb = 0) {
    const f = Math.max(1, Math.min(freq, this.sr * 0.49));
    const w = (TAU * f) / this.sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const A = 10 ** (gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lowpass':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'bandpass':
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'peaking':
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
        a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s;
        break;
      }
      default:
        throw new Error(`Unknown filter ${type}`);
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }

  /** Filter one sample on channel ch (0 or 1). */
  tick(x, ch) {
    const z = this.z;
    const i = ch * 2;
    const y = this.b0 * x + z[i];
    z[i] = this.b1 * x - this.a1 * y + z[i + 1];
    z[i + 1] = this.b2 * x - this.a2 * y;
    return y;
  }

  run(buf, ch, n = buf.length) {
    const { b0, b1, b2, a1, a2, z } = this;
    const i = ch * 2;
    let z1 = z[i];
    let z2 = z[i + 1];
    for (let k = 0; k < n; k++) {
      const x = buf[k];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[k] = y;
    }
    // Flush denormals so silence stays cheap.
    z[i] = Math.abs(z1) < 1e-25 ? 0 : z1;
    z[i + 1] = Math.abs(z2) < 1e-25 ? 0 : z2;
  }

  process(L, R, n) {
    this.run(L, 0, n);
    this.run(R, 1, n);
  }

  reset() {
    this.z.fill(0);
  }
}

/** Several biquads in series. specs: [[type, freq, q?, gainDb?], ...] */
class EQ {
  constructor(sr, specs) {
    this.filters = specs.map(([type, f, q, g]) => new Biquad(sr, type, f, q ?? Math.SQRT1_2, g ?? 0));
  }

  process(L, R, n) {
    for (const f of this.filters) f.process(L, R, n);
  }

  reset() {
    for (const f of this.filters) f.reset();
  }
}

class Gain {
  constructor(g) {
    this.g = g;
  }

  process(L, R, n) {
    const g = this.g;
    for (let i = 0; i < n; i++) {
      L[i] *= g;
      R[i] *= g;
    }
  }
}

/** tanh saturation normalized so full scale stays full scale; mix blends with the dry signal. */
class Drive {
  constructor(drive, mix = 1, out = 1) {
    this.k = Math.max(0.01, drive);
    this.norm = 1 / Math.tanh(this.k);
    this.mix = mix;
    this.out = out;
  }

  process(L, R, n) {
    const { k, norm, mix, out } = this;
    for (let i = 0; i < n; i++) {
      L[i] = (L[i] + (Math.tanh(k * L[i]) * norm - L[i]) * mix) * out;
      R[i] = (R[i] + (Math.tanh(k * R[i]) * norm - R[i]) * mix) * out;
    }
  }
}

/** Ring modulation with a sine carrier. */
class Ring {
  constructor(sr, freq, mix = 1) {
    this.inc = (TAU * freq) / sr;
    this.ph = 0;
    this.mix = mix;
  }

  process(L, R, n) {
    const { inc, mix } = this;
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      const c = 1 - mix + mix * Math.sin(ph);
      L[i] *= c;
      R[i] *= c;
      ph += inc;
      if (ph > TAU) ph -= TAU;
    }
    this.ph = ph;
  }

  reset() {
    this.ph = 0;
  }
}

/** Power-of-two stereo delay line with fractional reads. */
class DelayLine {
  constructor(maxSamples) {
    let size = 1;
    while (size < maxSamples + 4) size <<= 1;
    this.mask = size - 1;
    this.l = new Float32Array(size);
    this.r = new Float32Array(size);
    this.w = 0;
  }

  /** Read d samples ago (fractional) from channel buffer buf. */
  read(buf, d) {
    const p = this.w - d;
    const i = Math.floor(p);
    const f = p - i;
    const a = buf[i & this.mask];
    const b = buf[(i + 1) & this.mask];
    return a + (b - a) * f;
  }

  reset() {
    this.l.fill(0);
    this.r.fill(0);
    this.w = 0;
  }
}

/** Feedback comb: a short delay with feedback gives a metallic, pitched ring. */
class Comb {
  constructor(sr, ms, feedback, mix) {
    this.d = Math.max(1, Math.round((ms * sr) / 1000));
    this.line = new DelayLine(this.d + 1);
    this.fb = feedback;
    this.mix = mix;
  }

  process(L, R, n) {
    const { line, d, fb, mix } = this;
    const m = line.mask;
    for (let i = 0; i < n; i++) {
      const dl = line.l[(line.w - d) & m];
      const dr = line.r[(line.w - d) & m];
      const yl = L[i] + fb * dl;
      const yr = R[i] + fb * dr;
      line.l[line.w] = yl;
      line.r[line.w] = yr;
      line.w = (line.w + 1) & m;
      L[i] = L[i] * (1 - mix) + yl * mix * (1 - fb);
      R[i] = R[i] * (1 - mix) + yr * mix * (1 - fb);
    }
  }

  reset() {
    this.line.reset();
  }
}

/**
 * Pitch shift without changing tempo: two read taps sweep through a delay
 * line at the pitch ratio and crossfade (sin^2 / cos^2) so each tap is
 * silent when it jumps back.
 */
export class PitchShifter {
  constructor(sr, semitones, windowMs = 50) {
    this.W = Math.max(64, Math.round((windowMs * sr) / 1000));
    // The two taps sweep delays 1..W+1 and cross-fade: on average the sound comes out W/2 later.
    this.latency = Math.round(this.W / 2);
    this.line = new DelayLine(this.W + 8);
    this.phase = 0;
    this.setSemitones(semitones);
  }

  setSemitones(s) {
    this.ratio = 2 ** (s / 12);
  }

  process(L, R, n) {
    const { line, W } = this;
    const m = line.mask;
    const step = (1 - this.ratio) / W;
    let ph = this.phase;
    for (let i = 0; i < n; i++) {
      line.l[line.w] = L[i];
      line.r[line.w] = R[i];
      ph += step;
      ph -= Math.floor(ph);
      let ph2 = ph + 0.5;
      if (ph2 >= 1) ph2 -= 1;
      const g1 = Math.sin(Math.PI * ph) ** 2;
      const g2 = 1 - g1;
      const d1 = ph * W + 1;
      const d2 = ph2 * W + 1;
      L[i] = line.read(line.l, d1) * g1 + line.read(line.l, d2) * g2;
      R[i] = line.read(line.r, d1) * g1 + line.read(line.r, d2) * g2;
      line.w = (line.w + 1) & m;
    }
    this.phase = ph;
  }

  reset() {
    this.line.reset();
    this.phase = 0;
  }
}

/** Modulated delay: periodic pitch wobble (100% wet). */
class Vibrato {
  constructor(sr, rateHz, depthMs) {
    this.sr = sr;
    this.inc = (TAU * rateHz) / sr;
    this.depth = (depthMs * sr) / 1000;
    this.base = this.depth + 2;
    this.line = new DelayLine(Math.ceil(this.base + this.depth + 4));
    this.ph = 0;
  }

  process(L, R, n) {
    const { line, inc, depth, base } = this;
    const m = line.mask;
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      line.l[line.w] = L[i];
      line.r[line.w] = R[i];
      const d = base + depth * Math.sin(ph);
      L[i] = line.read(line.l, d);
      R[i] = line.read(line.r, d);
      line.w = (line.w + 1) & m;
      ph += inc;
      if (ph > TAU) ph -= TAU;
    }
    this.ph = ph;
  }

  reset() {
    this.line.reset();
    this.ph = 0;
  }
}

/** Three modulated voices around 12-24 ms, spread across the stereo field. */
class Chorus {
  constructor(sr, mix) {
    this.mix = mix;
    this.voices = [
      { base: 12, depth: 2.5, rate: 0.55, ph: 0 },
      { base: 18, depth: 3.0, rate: 0.83, ph: 2.1 },
      { base: 24, depth: 2.2, rate: 1.21, ph: 4.2 },
    ].map((v) => ({ base: (v.base * sr) / 1000, depth: (v.depth * sr) / 1000, inc: (TAU * v.rate) / sr, ph: v.ph }));
    this.line = new DelayLine(Math.ceil((30 * sr) / 1000));
  }

  process(L, R, n) {
    const { line, voices, mix } = this;
    const m = line.mask;
    const dry = 1 - mix * 0.5;
    const wet = mix * 0.6;
    for (let i = 0; i < n; i++) {
      line.l[line.w] = L[i];
      line.r[line.w] = R[i];
      let wl = 0;
      let wr = 0;
      for (let v = 0; v < voices.length; v++) {
        const vo = voices[v];
        // Left and right read the same voice a quarter cycle apart for width.
        wl += line.read(line.l, vo.base + vo.depth * Math.sin(vo.ph));
        wr += line.read(line.r, vo.base + vo.depth * Math.cos(vo.ph));
        vo.ph += vo.inc;
        if (vo.ph > TAU) vo.ph -= TAU;
      }
      L[i] = L[i] * dry + (wl / 3) * wet * 1.5;
      R[i] = R[i] * dry + (wr / 3) * wet * 1.5;
      line.w = (line.w + 1) & m;
    }
  }

  reset() {
    this.line.reset();
  }
}

/** Feedback echo with a darkening loop (each repeat is a little duller). */
class Echo {
  constructor(sr, ms, feedback, mix) {
    this.d = Math.max(1, Math.round((ms * sr) / 1000));
    this.line = new DelayLine(this.d + 2);
    this.fb = Math.min(0.95, feedback);
    this.mix = mix;
    this.damp = Math.exp((-TAU * 3500) / sr);
    this.sl = 0;
    this.sr = 0;
  }

  process(L, R, n) {
    const { line, d, fb, mix, damp } = this;
    const m = line.mask;
    for (let i = 0; i < n; i++) {
      const dl = line.l[(line.w - d) & m];
      const dr = line.r[(line.w - d) & m];
      this.sl = dl + (this.sl - dl) * damp;
      this.sr = dr + (this.sr - dr) * damp;
      line.l[line.w] = L[i] + this.sl * fb;
      line.r[line.w] = R[i] + this.sr * fb;
      line.w = (line.w + 1) & m;
      L[i] += dl * mix;
      R[i] += dr * mix;
    }
  }

  reset() {
    this.line.reset();
    this.sl = 0;
    this.sr = 0;
  }
}

/**
 * Algorithmic reverb: eight damped feedback combs into four allpasses per
 * side (Schroeder/Moorer topology), tunings scaled to the sample rate.
 */
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;

export class Reverb {
  constructor(sr, { size = 0.7, damp = 0.4, mix = 0.3, width = 1, predelayMs = 0 } = {}) {
    const k = sr / 44100;
    const mk = (len) => ({ buf: new Float32Array(Math.max(1, Math.round(len * k))), i: 0, store: 0 });
    this.combL = COMBS.map((c) => mk(c));
    this.combR = COMBS.map((c) => mk(c + SPREAD));
    this.apL = ALLPASSES.map((a) => mk(a));
    this.apR = ALLPASSES.map((a) => mk(a + SPREAD));
    this.feedback = 0.7 + 0.28 * Math.min(1, Math.max(0, size));
    this.damp = 0.4 * damp;
    const wet = mix * 1.2;
    this.wet1 = wet * (width / 2 + 0.5);
    this.wet2 = wet * ((1 - width) / 2);
    this.dry = 1 - mix * 0.5;
    this.pre = predelayMs > 0 ? new DelayLine(Math.round((predelayMs * sr) / 1000) + 2) : null;
    this.preD = this.pre ? Math.round((predelayMs * sr) / 1000) : 0;
  }

  _side(combs, aps, x) {
    let out = 0;
    const fb = this.feedback;
    const d1 = this.damp;
    const d2 = 1 - d1;
    for (let c = 0; c < combs.length; c++) {
      const cb = combs[c];
      const y = cb.buf[cb.i];
      cb.store = y * d2 + cb.store * d1;
      if (Math.abs(cb.store) < 1e-25) cb.store = 0;
      cb.buf[cb.i] = x + cb.store * fb;
      if (++cb.i >= cb.buf.length) cb.i = 0;
      out += y;
    }
    for (let a = 0; a < aps.length; a++) {
      const ap = aps[a];
      const b = ap.buf[ap.i];
      ap.buf[ap.i] = out + b * 0.5;
      if (++ap.i >= ap.buf.length) ap.i = 0;
      out = b - out;
    }
    return out;
  }

  process(L, R, n) {
    const { wet1, wet2, dry, pre, preD } = this;
    for (let i = 0; i < n; i++) {
      let x = (L[i] + R[i]) * 0.015;
      if (pre) {
        pre.l[pre.w] = x;
        x = pre.l[(pre.w - preD) & pre.mask];
        pre.w = (pre.w + 1) & pre.mask;
      }
      const ol = this._side(this.combL, this.apL, x);
      const or = this._side(this.combR, this.apR, x);
      L[i] = L[i] * dry + ol * wet1 + or * wet2;
      R[i] = R[i] * dry + or * wet1 + ol * wet2;
    }
  }

  reset() {
    for (const s of [...this.combL, ...this.combR, ...this.apL, ...this.apR]) {
      s.buf.fill(0);
      s.store = 0;
      s.i = 0;
    }
    this.pre?.reset();
  }
}

/** Deterministic white noise (same sound every render). */
class Rng {
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
  }

  next() {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 2147483648 - 1;
  }
}

/** Band-limited hiss and optional crackle added on top of the signal. */
class Static {
  constructor(sr, level, crackle = 0) {
    this.rng = new Rng(12345);
    this.level = level;
    this.crackle = crackle / sr; // clicks per sample
    this.band = new EQ(sr, [['highpass', 1500], ['lowpass', 6000]]);
    this.buf = new Float32Array(0);
    this.click = 0;
  }

  process(L, R, n) {
    if (this.buf.length < n) this.buf = new Float32Array(n);
    const b = this.buf;
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      let v = rng.next() * this.level;
      if (this.crackle && (rng.next() + 1) * 0.5 < this.crackle) this.click = (rng.next() > 0 ? 1 : -1) * this.level * 6;
      v += this.click;
      this.click *= 0.6;
      b[i] = v;
    }
    this.band.filters.forEach((f) => f.run(b, 0, n));
    for (let i = 0; i < n; i++) {
      L[i] += b[i];
      R[i] += b[i];
    }
  }
}

/** Low-pass whose cutoff drifts slowly (muffled, under-water sound). */
class DriftingLowpass {
  constructor(sr, depth) {
    this.sr = sr;
    this.f = new Biquad(sr, 'lowpass', 800, 2);
    this.depth = depth;
    this.inc = (TAU * 0.35 * 32) / sr;
    this.ph = 0;
  }

  process(L, R, n) {
    for (let s = 0; s < n; s += 32) {
      const e = Math.min(n, s + 32);
      const hi = 1400 - 900 * this.depth;
      const lo = 260;
      this.f.set('lowpass', lo + (hi - lo) * (0.5 + 0.5 * Math.sin(this.ph)), 2.5);
      this.ph += this.inc;
      if (this.ph > TAU) this.ph -= TAU;
      this.f.run(L.subarray(s, e), 0, e - s);
      this.f.run(R.subarray(s, e), 1, e - s);
    }
  }

  reset() {
    this.f.reset();
    this.ph = 0;
  }
}

class Series {
  constructor(stages) {
    this.stages = stages.filter(Boolean);
    this.latency = this.stages.reduce((sum, st) => sum + (st.latency || 0), 0);
  }

  process(L, R, n) {
    for (const s of this.stages) s.process(L, R, n);
  }

  reset() {
    for (const s of this.stages) s.reset?.();
  }
}

/* ---- Voice presets --------------------------------------------------------- */

/** Build the processor for a voice preset (ids from model/audio.js VOICE_PRESETS). */
export function createVoice(id, params, sr) {
  const p = { ...defaultVoiceParams(id), ...(params || {}) };
  const pct = (k) => Math.min(1, Math.max(0, (p[k] ?? 0) / 100));
  switch (id) {
    case 'low':
    case 'high':
      return new Series([new PitchShifter(sr, p.pitch)]);
    case 'squeaky':
      return new Series([new PitchShifter(sr, p.pitch, 35), new EQ(sr, [['highpass', 180], ['highshelf', 6000, 0.7, 3]])]);
    case 'giant':
      return new Series([
        new PitchShifter(sr, p.pitch, 70),
        new EQ(sr, [['lowshelf', 160, 0.7, 4], ['lowpass', 7000]]),
        new Drive(1 + pct('grit') * 6, pct('grit') * 0.8),
        new Reverb(sr, { size: 0.45, damp: 0.6, mix: 0.12 }),
      ]);
    case 'android':
      return new Series([
        new EQ(sr, [['highpass', 140]]),
        new Ring(sr, p.tone, pct('mix') * 0.85),
        new Comb(sr, 1000 / (p.tone * 1.5), 0.55, pct('mix') * 0.7),
        new Gain(1.2),
      ]);
    case 'phone':
      return new Series([
        new EQ(sr, [['highpass', 320], ['highpass', 320], ['lowpass', 3400], ['lowpass', 3400], ['peaking', 1600, 1, 4]]),
        new Drive(1 + pct('grit') * 5, 0.3 + pct('grit') * 0.7),
        new Gain(1.6),
      ]);
    case 'twoway':
      return new Series([
        new EQ(sr, [['highpass', 520], ['highpass', 520], ['lowpass', 2600], ['lowpass', 2600], ['peaking', 1300, 1.2, 6]]),
        new Drive(2 + pct('grit') * 10, 1, 0.8),
        new Static(sr, 0.002 + pct('hiss') * 0.05),
        new Gain(1.3),
      ]);
    case 'bullhorn':
      return new Series([
        new EQ(sr, [['highpass', 450], ['highpass', 450], ['peaking', 1800, 1.3, 9], ['lowpass', 5000]]),
        new Drive(2 + pct('grit') * 12, 1, 0.85),
        new Comb(sr, 0.9, 0.35, 0.4),
      ]);
    case 'submerged':
      return new Series([
        new DriftingLowpass(sr, pct('depth')),
        new Vibrato(sr, 0.7, 1.2 + pct('depth') * 2.5),
        new Reverb(sr, { size: 0.6, damp: 0.85, mix: 0.25 }),
        new Gain(1.3),
      ]);
    case 'hall':
      return new Reverb(sr, { size: 0.7 + 0.28 * pct('size'), damp: 0.25, mix: pct('mix'), predelayMs: 25 });
    case 'closet':
      return new Series([new Reverb(sr, { size: 0.25, damp: 0.65, mix: pct('mix') * 1.2, width: 0.6 })]);
    case 'canyon':
      return new Series([new Echo(sr, p.time, pct('feedback'), 0.55), new Reverb(sr, { size: 0.5, damp: 0.5, mix: 0.08 })]);
    case 'ensemble':
      return new Chorus(sr, pct('mix'));
    case 'amradio':
      return new Series([
        new EQ(sr, [['highpass', 400], ['highpass', 400], ['lowpass', 3000], ['lowpass', 3000], ['peaking', 900, 1, 3]]),
        new Drive(3, 0.8),
        new Static(sr, 0.004 + pct('hiss') * 0.03, 2 + pct('hiss') * 8),
        new Gain(1.5),
      ]);
    case 'wobble':
      return new Vibrato(sr, p.rate, 0.5 + pct('depth') * 4);
    case 'lowend':
      return new Series([
        new Gain(dbToGain(-p.boost / 3)),
        new EQ(sr, [['lowshelf', 120, 0.8, p.boost], ['peaking', 60, 1, p.boost * 0.3]]),
        new Drive(1.3, 1),
      ]);
    case 'spirit':
      return new Series([
        new EQ(sr, [['highpass', 220]]),
        new PitchShifter(sr, 3, 40),
        new Chorus(sr, 0.8),
        new Reverb(sr, { size: 0.9, damp: 0.2, mix: 0.25 + pct('mix') * 0.55, predelayMs: 40 }),
      ]);
    default:
      return null;
  }
}

/* ---- Channel and pan ------------------------------------------------------------ */

/** Route channels: left/right only (copied to both sides), swap or mono. */
export class ChannelMode {
  constructor(mode) {
    this.mode = mode;
  }

  process(L, R, n) {
    switch (this.mode) {
      case 'left':
        R.set(L.subarray(0, n));
        break;
      case 'right':
        L.set(R.subarray(0, n));
        break;
      case 'swap':
        for (let i = 0; i < n; i++) {
          const t = L[i];
          L[i] = R[i];
          R[i] = t;
        }
        break;
      case 'mono':
        for (let i = 0; i < n; i++) {
          const m = (L[i] + R[i]) * 0.5;
          L[i] = m;
          R[i] = m;
        }
        break;
      default:
    }
  }
}

/** Gains for pan -100..100: the far side fades out on a quarter-cosine, the near side stays at unity. */
export function panGains(value) {
  const p = Math.max(-1, Math.min(1, value / 100));
  return [p > 0 ? Math.cos((p * Math.PI) / 2) : 1, p < 0 ? Math.cos((-p * Math.PI) / 2) : 1];
}

export class Pan {
  constructor(value) {
    this.set(value);
  }

  set(value) {
    [this.gl, this.gr] = panGains(value);
  }

  process(L, R, n) {
    const { gl, gr } = this;
    for (let i = 0; i < n; i++) {
      L[i] *= gl;
      R[i] *= gr;
    }
  }
}

/* ---- Noise reduction ----------------------------------------------------------- */

/** In-place iterative radix-2 complex FFT. */
export class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((TAU * i) / n);
      this.sin[i] = Math.sin((TAU * i) / n);
    }
  }

  transform(re, im, inverse = false) {
    const { n, rev } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k];
          const wi = sgn * this.sin[k];
          const a = i + j;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }
}

/** Periodic sqrt-Hann window (analysis and synthesis; their product overlaps to 2 at hop N/4). */
export function sqrtHann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = Math.sqrt(0.5 - 0.5 * Math.cos((TAU * i) / n));
  return w;
}

/** STFT size used for noise work at a sample rate. */
export const denoiseSize = (sr) => (sr > 50000 ? 2048 : 1024);

/** Map a stored band profile (dB per band) to per-bin noise power for an FFT of size n. */
export function profileToBins(profile, n, sr) {
  const bins = new Float64Array(n / 2 + 1);
  let b = 0;
  for (let k = 0; k <= n / 2; k++) {
    const f = (k * sr) / n;
    while (b < NOISE_BANDS - 1 && f >= NOISE_BAND_EDGES[b + 1]) b++;
    bins[k] = 10 ** (profile[b] / 10);
  }
  return bins;
}

/**
 * Short-time Fourier processing shared by the spectral stages: 75% overlap
 * with a square-root Hann window, both channels in one complex FFT (left as
 * real, right as imaginary), one real gain per bin applied to both channels
 * so the stereo image holds. A subclass fills this.mask (0..1 per bin up to
 * N/2) in _mask(); the gain opens fast and closes slowly over time.
 * Latency: one FFT frame (this.latency samples).
 */
class SpectralStage {
  constructor(N) {
    this.N = N;
    this.hop = N / 4;
    this.latency = N;
    this.fft = new FFT(N);
    this.win = sqrtHann(N);
    let wp = 0;
    for (let i = 0; i < N; i++) wp += this.win[i] ** 2;
    this.winPow = wp;
    this.half = N / 2;
    this.inL = new Float64Array(N);
    this.inR = new Float64Array(N);
    this.olaL = new Float64Array(N);
    this.olaR = new Float64Array(N);
    this.outL = new Float64Array(this.hop);
    this.outR = new Float64Array(this.hop);
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.gain = new Float64Array(this.half + 1).fill(1);
    this.mask = new Float64Array(this.half + 1);
    this.p = 0;
  }

  process(L, R, n) {
    const { hop, N } = this;
    const at = N - hop;
    for (let i = 0; i < n; i++) {
      const p = this.p;
      const yl = this.outL[p];
      const yr = this.outR[p];
      this.inL[at + p] = L[i];
      this.inR[at + p] = R[i];
      L[i] = yl;
      R[i] = yr;
      if (++this.p === hop) {
        this.p = 0;
        this._frame();
      }
    }
  }

  /** Fill this.mask from the spectrum in this.re / this.im. */
  _mask() {}

  _frame() {
    const { N, hop, half, win, re, im, gain, mask } = this;
    for (let i = 0; i < N; i++) {
      re[i] = this.inL[i] * win[i];
      im[i] = this.inR[i] * win[i];
    }
    this.fft.transform(re, im);
    this._mask();
    // Smooth across frequency, then open fast / close slowly over time (less "musical noise").
    for (let k = 0; k <= half; k++) {
      const a = mask[Math.max(0, k - 1)];
      const c = mask[Math.min(half, k + 1)];
      const s = 0.25 * a + 0.5 * mask[k] + 0.25 * c;
      gain[k] = s > gain[k] ? s : gain[k] * 0.6 + s * 0.4;
    }
    for (let k = 0; k <= half; k++) {
      const g = gain[k];
      re[k] *= g;
      im[k] *= g;
      if (k > 0 && k < half) {
        re[N - k] *= g;
        im[N - k] *= g;
      }
    }
    this.fft.transform(re, im, true);
    const ola = this.olaL;
    const olr = this.olaR;
    for (let i = 0; i < N; i++) {
      ola[i] += re[i] * win[i];
      olr[i] += im[i] * win[i];
    }
    // sqrt-Hann squared at 75% overlap sums to 2.
    for (let i = 0; i < hop; i++) {
      this.outL[i] = ola[i] * 0.5;
      this.outR[i] = olr[i] * 0.5;
    }
    ola.copyWithin(0, hop);
    olr.copyWithin(0, hop);
    ola.fill(0, N - hop);
    olr.fill(0, N - hop);
    this.inL.copyWithin(0, hop);
    this.inR.copyWithin(0, hop);
  }

  reset() {
    for (const a of [this.inL, this.inR, this.olaL, this.olaR, this.outL, this.outR]) a.fill(0);
    this.gain.fill(1);
    this.p = 0;
  }
}

/**
 * Spectral gate. With a noise profile (per-sample noise power per band,
 * measured from the clip's quietest stretches) each bin is attenuated by a
 * smoothed spectral-subtraction gain; without one the noise floor is
 * tracked from running minima.
 */
export class Denoiser extends SpectralStage {
  constructor(sr, { amount = 60, profile = null } = {}) {
    super(denoiseSize(sr));
    const N = this.N;
    this.noise = profile ? profileToBins(profile, N, sr).map((v) => v * this.winPow) : null;
    this.track = profile ? null : { smooth: new Float64Array(this.half + 1), min: new Float64Array(this.half + 1).fill(Infinity), est: new Float64Array(this.half + 1), frames: 0 };
    this.hp = new Biquad(sr, 'highpass', 70);
    this.set(amount);
  }

  set(amount) {
    const a = Math.min(1, Math.max(0, amount / 100));
    this.over = 1 + 2.5 * a;
    this.floor = dbToGain(-(8 + 24 * a));
  }

  process(L, R, n) {
    this.hp.process(L, R, n);
    super.process(L, R, n);
  }

  _mask() {
    const { re, im, N, half, mask } = this;
    let noise = this.noise;
    if (!noise) noise = this._trackNoise();
    // Mean channel power per bin: (|Z(k)|^2 + |Z(N-k)|^2) / 4.
    for (let k = 0; k <= half; k++) {
      const j = (N - k) % N;
      const pw = (re[k] * re[k] + im[k] * im[k] + re[j] * re[j] + im[j] * im[j]) / 4;
      const g = pw > 0 ? Math.sqrt(Math.max(0, 1 - (this.over * noise[k]) / pw)) : 0;
      mask[k] = Math.max(this.floor, g);
    }
  }

  /** Running-minimum noise estimate (used when no profile was measured). */
  _trackNoise() {
    const { re, im, N, half } = this;
    const t = this.track;
    t.frames++;
    for (let k = 0; k <= half; k++) {
      const j = (N - k) % N;
      const pw = (re[k] * re[k] + im[k] * im[k] + re[j] * re[j] + im[j] * im[j]) / 4;
      t.smooth[k] = t.frames === 1 ? pw : t.smooth[k] * 0.8 + pw * 0.2;
      // The minimum creeps up slowly (about 3 dB per second) so it follows a rising floor.
      t.min[k] = Math.min(t.smooth[k], t.min[k] * 1.004);
      // A running minimum sits below the mean noise power; compensate.
      t.est[k] = t.min[k] * 2;
    }
    return t.est;
  }

  reset() {
    super.reset();
    this.hp.reset();
  }
}

/* ---- Voice and music separation -------------------------------------------------- */

/**
 * How much of a bin belongs to a centered voice: the two channels agree
 * (high coherence, equal level) and the frequency is in the voice range.
 * lr, li / rr, ri: the bin's left and right spectra (complex).
 */
export function centerWeight(lr, li, rr, ri, hz) {
  const pl = lr * lr + li * li;
  const pr = rr * rr + ri * ri;
  const sum = pl + pr;
  if (sum <= 1e-20) return 0;
  // In-phase part of L conj(R) relative to the mean power: 1 when the
  // channels are the same, 0 or less when unrelated or in opposite phase.
  const coherence = Math.max(0, (2 * (lr * rr + li * ri)) / sum);
  const balance = 1 - Math.abs(pl - pr) / sum;
  // Voices live roughly between 120 Hz and 9 kHz; bass and cymbals do not.
  const band = smooth01((hz - 90) / 80) * (1 - smooth01((hz - 8000) / 4000));
  return coherence ** 4 * balance ** 2 * band;
}

const smooth01 = (x) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * Keep the voice (mode 'voice') or the music (mode 'music') of a stereo
 * mix by masking each bin with its center weight. Mono sources have no
 * stereo cue, so there only the voice band is used.
 */
export class Separator extends SpectralStage {
  constructor(sr, { mode = 'voice', amount = 80 } = {}) {
    super(denoiseSize(sr));
    this.sr = sr;
    this.mode = mode === 'music' ? 'music' : 'voice';
    this.set(amount);
  }

  set(amount) {
    this.amount = Math.min(1, Math.max(0, amount / 100));
  }

  _mask() {
    const { re, im, N, half, mask, amount } = this;
    const hzPerBin = this.sr / N;
    for (let k = 0; k <= half; k++) {
      const j = (N - k) % N;
      // Unpack left and right from the shared complex FFT.
      const lr = (re[k] + re[j]) / 2;
      const li = (im[k] - im[j]) / 2;
      const rr = (im[k] + im[j]) / 2;
      const ri = (re[j] - re[k]) / 2;
      const w = centerWeight(lr, li, rr, ri, k * hzPerBin);
      const keep = this.mode === 'voice' ? w : 1 - w;
      mask[k] = 1 - amount + amount * keep;
    }
  }
}

/* ---- Voice enhancement ----------------------------------------------------------- */

/**
 * Clearer speech: rumble cut, less mud, presence and air boosts, gentle
 * compression and a de-esser, all scaled by amount.
 */
export class Enhancer {
  constructor(sr, { amount = 50 } = {}) {
    this.sr = sr;
    this.eq = new EQ(sr, [['highpass', 80], ['peaking', 300, 1, 0], ['peaking', 3200, 0.9, 0], ['highshelf', 9000, 0.7, 0]]);
    this.split = new Biquad(sr, 'highpass', 5500, 0.7);
    this.atk = Math.exp(-1 / (0.005 * sr));
    this.rel = Math.exp(-1 / (0.15 * sr));
    this.deAtk = Math.exp(-1 / (0.001 * sr));
    this.deRel = Math.exp(-1 / (0.05 * sr));
    this.env = 0;
    this.deEnv = 0;
    this.set(amount);
  }

  set(amount) {
    const a = Math.min(1, Math.max(0, amount / 100));
    const f = this.eq.filters;
    f[1].set('peaking', 300, 1, -3 * a);
    f[2].set('peaking', 3200, 0.9, 5 * a);
    f[3].set('highshelf', 9000, 0.7, 3 * a);
    this.thr = -22;
    this.ratio = 1 + 3 * a;
    this.makeup = (1 - 1 / this.ratio) * 22 * 0.45;
    this.deThr = -32;
    this.deMax = 9 * a;
  }

  process(L, R, n) {
    this.eq.process(L, R, n);
    const { atk, rel, deAtk, deRel, thr, ratio, makeup, deThr, deMax, split } = this;
    const slope = 1 - 1 / ratio;
    let env = this.env;
    let de = this.deEnv;
    for (let i = 0; i < n; i++) {
      let l = L[i];
      let r = R[i];
      // Compressor (stereo linked, peak envelope in the log domain).
      const x = Math.max(Math.abs(l), Math.abs(r));
      env = x > env ? atk * env + (1 - atk) * x : rel * env + (1 - rel) * x;
      const lev = 20 * Math.log10(env + 1e-9);
      const gr = lev > thr ? (lev - thr) * slope : 0;
      const g = dbToGain(makeup - gr);
      l *= g;
      r *= g;
      // De-esser: duck only the band above ~5.5 kHz when it gets loud.
      const hl = split.tick(l, 0);
      const hr = split.tick(r, 1);
      const s = Math.max(Math.abs(hl), Math.abs(hr));
      de = s > de ? deAtk * de + (1 - deAtk) * s : deRel * de + (1 - deRel) * s;
      if (deMax > 0) {
        const sl = 20 * Math.log10(de + 1e-9);
        if (sl > deThr) {
          const k = 1 - dbToGain(-Math.min(deMax, (sl - deThr) * 0.6));
          l -= hl * k;
          r -= hr * k;
        }
      }
      L[i] = l;
      R[i] = r;
    }
    this.env = env < 1e-12 ? 0 : env;
    this.deEnv = de < 1e-12 ? 0 : de;
  }

  reset() {
    this.eq.reset();
    this.split.reset();
    this.env = 0;
    this.deEnv = 0;
  }
}

/* ---- The chain ---------------------------------------------------------------------- */

const ORDER = ['channel', 'separate', 'denoise', 'enhance', 'voice', 'pan'];

function makeStage(name, s, sr) {
  if (s === null || s === undefined) return null;
  switch (name) {
    case 'channel':
      return new ChannelMode(s);
    case 'separate':
      return new Separator(sr, s);
    case 'denoise':
      return new Denoiser(sr, s);
    case 'enhance':
      return new Enhancer(sr, s);
    case 'voice':
      return createVoice(s.id, s.params, sr);
    case 'pan':
      return new Pan(s);
    default:
      return null;
  }
}

/**
 * The effect chain of one clip: channel -> noise reduction -> enhance ->
 * voice -> pan, on stereo blocks in place. update() keeps the state of
 * stages whose settings did not change (and retunes amount-only changes),
 * so dragging a slider during playback does not cut reverb tails.
 */
export class ClipChain {
  constructor(settings, sampleRate) {
    this.sr = sampleRate;
    this.keys = {};
    this.stages = {};
    this.latency = 0;
    this.update(settings);
  }

  update(settings) {
    const s = settings || {};
    for (const name of ORDER) {
      const v = s[name] ?? null;
      const key = JSON.stringify(v);
      if (key === this.keys[name]) continue;
      const prev = this.keys[name] ? JSON.parse(this.keys[name]) : null;
      this.keys[name] = key;
      const st = this.stages[name];
      // Same stage, new amount: retune in place.
      if (st && v && prev && name === 'denoise' && JSON.stringify(prev.profile) === JSON.stringify(v.profile)) st.set(v.amount);
      else if (st && v && name === 'enhance') st.set(v.amount);
      else if (st && v && prev && name === 'separate' && prev.mode === v.mode) st.set(v.amount);
      else if (st && v !== null && name === 'pan') st.set(v);
      else this.stages[name] = makeStage(name, v, this.sr);
    }
    this.latency = (this.stages.separate?.latency || 0) + (this.stages.denoise?.latency || 0) + (this.stages.voice?.latency || 0);
    return this;
  }

  get empty() {
    return ORDER.every((n) => !this.stages[n]);
  }

  process(L, R, n = L.length) {
    for (const name of ORDER) this.stages[name]?.process(L, R, n);
  }

  reset() {
    for (const name of ORDER) this.stages[name]?.reset?.();
  }
}
