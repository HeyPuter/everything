// Signal generators for Effects > Generate: tones (with frequency modulation,
// harmonic components and band-limited waveforms) and coloured noise. Pure
// functions over Float32Arrays so they are testable and can move to a Worker.

export const WAVEFORMS = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'square', label: 'Square' },
  { value: 'sawtooth', label: 'Sawtooth' },
  { value: 'inverseSawtooth', label: 'Inverse Sawtooth' },
];

export const NOISE_COLORS = [
  { value: 'white', label: 'White' },
  { value: 'pink', label: 'Pink' },
  { value: 'brown', label: 'Brown' },
  { value: 'grey', label: 'Grey' },
];

export const NOISE_STYLES = [
  { value: 'independent', label: 'Independent Channels' },
  { value: 'mono', label: 'Mono (Same on All Channels)' },
  { value: 'inverse', label: 'Inverse (Right Is Inverted Left)' },
  { value: 'spatial', label: 'Spatial (Right Is Delayed Left)' },
];

export const dbToGain = (db) => (db <= -200 ? 0 : Math.pow(10, db / 20));

/** PolyBLEP residual that removes the aliasing of a hard step at phase 0. */
function polyBlep(p, dt) {
  if (dt <= 0) return 0;
  if (p < dt) {
    const x = p / dt;
    return x + x - x * x - 1;
  }
  if (p > 1 - dt) {
    const x = (p - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/**
 * One sample of a waveform at phase p in [0, 1), band-limited for frequency
 * step dt (cycles per sample). `symmetry` (0..1, 0.5 = the plain shape)
 * reshapes each cycle: the duty cycle of a square, the peak position of a
 * triangle, and a phase warp of a sine (a lopsided sine). Sawtooths ignore it.
 */
export function waveSample(waveform, p, dt = 0, symmetry = 0.5) {
  const s = Math.min(0.95, Math.max(0.05, symmetry));
  switch (waveform) {
    case 'triangle': {
      if (s === 0.5) return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
      // Rises from -1 to +1 over `s` of the cycle, then falls; phase 0 sits at the zero crossing of the rise.
      const q = (p + s / 2) % 1;
      return q < s ? -1 + (2 * q) / s : 1 - (2 * (q - s)) / (1 - s);
    }
    case 'square': {
      let v = p < s ? 1 : -1;
      v += polyBlep(p, dt);
      v -= polyBlep((p + 1 - s) % 1, dt);
      return v;
    }
    case 'sawtooth':
      return 2 * p - 1 - polyBlep(p, dt);
    case 'inverseSawtooth':
      return -(2 * p - 1 - polyBlep(p, dt));
    default: {
      const q = s === 0.5 ? p : p < s ? (0.5 * p) / s : 0.5 + (0.5 * (p - s)) / (1 - s);
      return Math.sin(2 * Math.PI * q);
    }
  }
}

/** Interpolation between a start and an end value at t in [0, 1]: geometric for 'log', else linear. */
export function sweepValue(a, b, t, curve = 'linear') {
  if (a === b) return a;
  if (curve === 'log' && a > 0 && b > 0) return a * Math.pow(b / a, t);
  return a + (b - a) * t;
}

/**
 * Tone generator.
 *  base         fundamental frequency (Hz)
 *  components   relative amplitudes (0..1) of the partials; the sum is scaled
 *               so the combined peak never exceeds the volume
 *  multipliers  frequency multiple of each partial (default 1, 2, 3...)
 *  modulateBy   FM deviation in Hz (0 = none), modFreq the modulation rate in Hz
 *  sweep        optional { base, modulateBy, modFreq, curve: 'log' | 'linear' }:
 *               end values the start values glide to across the tone
 *  symmetry     waveform shape (see waveSample)
 *  volumeDb     peak level
 *  startPhase   degrees
 */
export function generateTones({ rate, frames, base = 440, components = [1], multipliers = null, waveform = 'sine', symmetry = 0.5, modulateBy = 0, modFreq = 1, sweep = null, volumeDb = -6, startPhase = 0 }) {
  const out = new Float32Array(Math.max(0, frames | 0));
  const amps = components.map((a) => Math.max(0, Number(a) || 0));
  const muls = amps.map((_, k) => Math.max(0, Number(multipliers?.[k] ?? k + 1) || 0));
  const sum = amps.reduce((s, a) => s + a, 0);
  if (!sum || !out.length) return out;
  const gain = dbToGain(volumeDb) / sum;
  const nyquist = rate / 2;
  const phases = amps.map(() => ((startPhase % 360) + 360) % 360 / 360);
  const n = out.length;
  const curve = sweep?.curve === 'log' ? 'log' : 'linear';
  let modPhase = 0;
  for (let i = 0; i < n; i++) {
    const t = sweep && n > 1 ? i / (n - 1) : 0;
    const f0 = sweep ? sweepValue(base, sweep.base ?? base, t, curve) : base;
    const depth = sweep ? sweepValue(modulateBy, sweep.modulateBy ?? modulateBy, t) : modulateBy;
    const mrate = sweep ? sweepValue(modFreq, sweep.modFreq ?? modFreq, t, curve) : modFreq;
    const inst = f0 + (depth ? depth * Math.sin(2 * Math.PI * modPhase) : 0);
    modPhase += mrate / rate;
    modPhase -= Math.floor(modPhase);
    let v = 0;
    for (let k = 0; k < amps.length; k++) {
      const f = inst * muls[k];
      const dt = Math.abs(f) / rate;
      if (amps[k] > 0 && Math.abs(f) < nyquist) v += amps[k] * waveSample(waveform, phases[k], dt, symmetry);
      let p = phases[k] + f / rate;
      p -= Math.floor(p);
      phases[k] = p;
    }
    out[i] = v * gain;
  }
  return out;
}

/**
 * One period of the combined waveform (partials, shape) for drawing: `points`
 * samples spanning `cycles` cycles of the fundamental, peak-normalised to 1.
 */
export function wavePreview({ components = [1], multipliers = null, waveform = 'sine', symmetry = 0.5 }, points = 256, cycles = 2) {
  const out = new Float32Array(points);
  const amps = components.map((a) => Math.max(0, Number(a) || 0));
  let peak = 0;
  for (let i = 0; i < points; i++) {
    const x = (i / points) * cycles;
    let v = 0;
    amps.forEach((a, k) => {
      if (!a) return;
      const m = Number(multipliers?.[k] ?? k + 1) || 0;
      const p = (x * m) % 1;
      v += a * waveSample(waveform, p, 0, symmetry);
    });
    out[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  if (peak > 0) for (let i = 0; i < points; i++) out[i] /= peak;
  return out;
}

/** Small, fast, seedable PRNG (mulberry32) returning [0, 1). */
export function rng(seed = 1) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Coloured noise filter state; next(white) returns the coloured sample (about
 * unit peak). The brown and grey filters' coefficients follow the sample rate
 * so their corners stay at the same frequencies (about 150 Hz and 3.9 kHz) at
 * every rate; at 48 kHz they are the original constants exactly.
 */
function colorFilter(color, rate = 48000) {
  if (color === 'pink') {
    // Paul Kellet's refined pink filter (within 0.05 dB above 9.2 Hz at 44.1 kHz).
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    return (w) => {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      return v * 0.11;
    };
  }
  if (color === 'brown') {
    // Leaky integrator; c = 0.02 at 48 kHz (960 / 48000 rounds to the same value).
    const c = 960 / rate;
    const d = 1 + c;
    let last = 0;
    return (w) => {
      last = (last + c * w) / d;
      return last * 3.5;
    };
  }
  if (color === 'grey') {
    // Approximates equal perceived loudness across the band: more energy in
    // the lows and highs than pink noise, less in the 2 to 5 kHz region.
    const pink = colorFilter('pink');
    const brown = colorFilter('brown', rate);
    // One-pole high pass, pole 0.6 at 48 kHz.
    const a = Math.pow(0.6, 48000 / rate);
    let hp = 0;
    let prev = 0;
    return (w) => {
      hp = a * (hp + w - prev);
      prev = w;
      return 0.55 * brown(w) + 0.25 * pink(w) + 0.35 * hp;
    };
  }
  return (w) => w;
}

/**
 * Noise generator. Returns one Float32Array per channel, peak-normalised to volumeDb.
 *  intensity  0..1 blend from white (0) to the full colour (1)
 *  style      'independent' | 'mono' | 'inverse' | 'spatial'
 *  delayUs    'spatial': the right channel is the left one delayed by this many
 *             microseconds (fractional delays interpolate), which places the
 *             noise off-centre and widens it without decorrelating it
 *  dcOffset   -1..1: a constant offset as a fraction of the volume; the noise
 *             shrinks so noise plus offset still peaks at the volume
 */
export function generateNoise({ frames, channels = 1, rate = 48000, color = 'white', intensity = 1, volumeDb = -6, style = 'independent', delayUs = 0, dcOffset = 0, seed = 12345 }) {
  frames = Math.max(0, frames | 0);
  const random = rng(seed);
  const delay = style === 'spatial' ? Math.max(0, (delayUs * rate) / 1e6) : 0;
  const lead = Math.ceil(delay) + 1;
  const make = (n) => {
    const f = colorFilter(color, rate);
    const out = new Float32Array(n);
    const mix = color === 'white' ? 0 : Math.min(1, Math.max(0, intensity));
    for (let i = 0; i < n; i++) {
      const w = random() * 2 - 1;
      out[i] = mix * f(w) + (1 - mix) * w;
    }
    return out;
  };
  const outs = [];
  let first;
  let source = null;
  if (style === 'spatial' && channels > 1) {
    // One stream with a short lead-in, so the delayed copy has audio from frame 0.
    source = make(frames + lead);
    first = source.slice(lead);
  } else first = make(frames);
  outs.push(first);
  for (let c = 1; c < channels; c++) {
    if (style === 'mono') outs.push(first.slice());
    else if (style === 'inverse') outs.push(first.map((v) => -v));
    else if (source) {
      const d = new Float32Array(frames);
      const whole = Math.floor(delay);
      const frac = delay - whole;
      for (let i = 0; i < frames; i++) {
        const at = lead + i - whole;
        d[i] = source[at] * (1 - frac) + (frac ? source[at - 1] * frac : 0);
      }
      outs.push(d);
    } else outs.push(make(frames));
  }
  let peak = 0;
  for (const o of outs) for (let i = 0; i < o.length; i++) peak = Math.max(peak, Math.abs(o[i]));
  const vol = dbToGain(volumeDb);
  const dc = Math.max(-1, Math.min(1, dcOffset)) * vol;
  const g = peak > 0 ? (vol - Math.abs(dc)) / peak : 0;
  for (const o of outs) for (let i = 0; i < o.length; i++) o[i] = o[i] * g + dc;
  return outs;
}

/**
 * Power spectral density of a noise colour, for drawing: `bins` levels in dB
 * (relative to the loudest) at log-spaced frequencies from 20 Hz to Nyquist.
 * Averages FFT frames of a fixed seed, so the curve is steady between redraws.
 * @param {(re: Float64Array, im: Float64Array) => void} fft in-place complex FFT
 * @returns {{ freqs: Float32Array, db: Float32Array }}
 */
export function noiseSpectrum({ color = 'white', intensity = 1, rate = 48000, bins = 160, size = 2048, frames = 16 }, fft) {
  const opts = { frames: size * frames, rate, color, intensity, volumeDb: 0, seed: 99 };
  const [x] = generateNoise(opts);
  const half = size / 2;
  const power = new Float64Array(half + 1);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < size; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
      re[i] = x[f * size + i] * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= half; k++) power[k] += re[k] * re[k] + im[k] * im[k];
  }
  const freqs = new Float32Array(bins);
  const db = new Float32Array(bins);
  const fMax = rate / 2;
  let top = -Infinity;
  for (let b = 0; b < bins; b++) {
    const lo = 20 * Math.pow(fMax / 20, b / bins);
    const hi = 20 * Math.pow(fMax / 20, (b + 1) / bins);
    const k0 = Math.max(1, Math.floor((lo / fMax) * half));
    const k1 = Math.max(k0, Math.min(half, Math.ceil((hi / fMax) * half)));
    let p = 0;
    for (let k = k0; k <= k1; k++) p += power[k];
    p /= k1 - k0 + 1;
    freqs[b] = Math.sqrt(lo * hi);
    db[b] = 10 * Math.log10(p + 1e-20);
    top = Math.max(top, db[b]);
  }
  for (let b = 0; b < bins; b++) db[b] -= top;
  return { freqs, db };
}
