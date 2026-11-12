// Procedural impulse responses for Convolution Reverb, so the app ships no
// audio assets. Each impulse is shaped noise: a few early reflections, a
// diffuse onset, and a late tail split into three bands that decay at their
// own rates (low, mid, high), giving frequency dependent decay like a real
// space. Deterministic per type, so the same settings give the same impulse.

/** Built-in impulse types. seconds: T60 at 100 % size; er: [first, last] reflection times (s). */
export const IMPULSES = [
  { label: 'Small Room', seconds: 0.45, er: [0.003, 0.03], taps: 10, onset: 0.004, low: 1.0, high: 0.55 },
  { label: 'Medium Room', seconds: 0.8, er: [0.005, 0.05], taps: 12, onset: 0.006, low: 1.05, high: 0.5 },
  { label: 'Large Hall', seconds: 2.6, er: [0.012, 0.09], taps: 14, onset: 0.018, low: 1.2, high: 0.45 },
  { label: 'Concert Hall', seconds: 2.1, er: [0.018, 0.075], taps: 16, onset: 0.02, low: 1.15, high: 0.55 },
  { label: 'Cathedral', seconds: 4.6, er: [0.025, 0.14], taps: 12, onset: 0.03, low: 1.3, high: 0.35 },
  { label: 'Plate', seconds: 1.8, er: null, taps: 0, onset: 0.0015, low: 0.85, high: 0.8 },
  { label: 'Chamber', seconds: 1.2, er: [0.006, 0.045], taps: 14, onset: 0.008, low: 1.05, high: 0.6 },
  { label: 'Ambience', seconds: 0.3, er: [0.002, 0.02], taps: 8, onset: 0.002, low: 0.9, high: 0.7 },
];

/** Longest generated impulse (s); the Rust side accepts up to 8 s. */
export const MAX_IMPULSE_SECONDS = 6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function type(values) {
  return IMPULSES[clamp(Math.round(values.impulse ?? 0), 0, IMPULSES.length - 1)];
}

/** Decay time (T60, seconds) for the values. */
export function impulseDecay(values) {
  return type(values).seconds * clamp(values.roomSize ?? 100, 10, 400) / 100;
}

/** Impulse length in frames for the values at `rate`. */
export function impulseLength(values, rate) {
  const secs = Math.min(MAX_IMPULSE_SECONDS, impulseDecay(values) * 1.15 + 0.05);
  return Math.max(1, Math.round(secs * rate));
}

/** Top of the band (Hz) an impulse's level is normalised over: the whole band of a 48 kHz file. */
const LEVEL_BAND = 24000;

/**
 * Energy normalisation target for an impulse at `rate`, and the energy of
 * one channel that it is compared with. Up to 48 kHz that is the channel's
 * whole energy against 1 (the impulse has unit energy). Above, only the
 * energy below 24 kHz counts, against 48000 / rate: the same sound spreads
 * its energy over more samples at a higher rate, and the ultrasonic part of
 * a generated impulse (or the images of a resampled one) is not heard, so
 * normalising all of it made the reverb louder at 96 and 192 kHz. The
 * channel's energy is added to `e` (a running total over the channels).
 */
function levelTarget(rate) {
  return Math.min(1, (2 * LEVEL_BAND) / rate);
}

function bandEnergy(ch, rate, e = 0) {
  if (rate <= 2 * LEVEL_BAND) {
    for (let i = 0; i < ch.length; i++) e += ch[i] * ch[i];
    return e;
  }
  // 8th-order Butterworth low pass at 24 kHz (four biquad sections).
  const w = (2 * Math.PI * LEVEL_BAND) / rate;
  const cos = Math.cos(w);
  const sections = [1, 3, 5, 7].map((k) => {
    const alpha = Math.sin(w) * Math.cos((k * Math.PI) / 16);
    const a0 = 1 + alpha;
    return {
      b0: (1 - cos) / 2 / a0,
      b1: (1 - cos) / a0,
      b2: (1 - cos) / 2 / a0,
      a1: (-2 * cos) / a0,
      a2: (1 - alpha) / a0,
      z1: 0,
      z2: 0,
    };
  });
  for (let i = 0; i < ch.length; i++) {
    let x = ch[i];
    for (const s of sections) {
      const y = s.b0 * x + s.z1;
      s.z1 = s.b1 * x - s.a1 * y + s.z2;
      s.z2 = s.b2 * x - s.a2 * y;
      x = y;
    }
    e += x * x;
  }
  return e;
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296 * 2 - 1;
  };
}

/**
 * Generates a stereo impulse as the data slot layout Rust expects:
 * Float32Array [2, ...left, ...right], energy normalised so the wet level is
 * close to the dry level.
 * @param {object} values convolutionReverb values (impulse, roomSize, dampLF, dampHF)
 * @param {number} rate
 */
export function generateImpulse(values, rate) {
  const t = type(values);
  const index = IMPULSES.indexOf(t);
  const n = impulseLength(values, rate);
  const size = clamp(values.roomSize ?? 100, 10, 400) / 100;
  const t60 = impulseDecay(values);
  const lfDamp = clamp(values.dampLF ?? 0, 0, 100) / 100;
  const hfDamp = clamp(values.dampHF ?? 0, 0, 100) / 100;
  const tLow = Math.max(0.05, t60 * t.low * (1 - 0.6 * lfDamp));
  const tMid = Math.max(0.05, t60);
  const tHigh = Math.max(0.03, t60 * t.high * (1 - 0.8 * hfDamp));
  // Per-sample decay multipliers for -60 dB at each band's T60.
  const kLow = 10 ** (-3 / (tLow * rate));
  const kMid = 10 ** (-3 / (tMid * rate));
  const kHigh = 10 ** (-3 / (tHigh * rate));
  // One-pole coefficients for the band split (about 250 Hz and 4 kHz).
  const aLow = Math.exp((-2 * Math.PI * 250) / rate);
  const aHigh = Math.exp((-2 * Math.PI * 4000) / rate);
  const erStart = t.er ? t.er[0] * Math.sqrt(size) : 0;
  const onset = Math.max(1, t.onset * size * rate);
  const out = new Float32Array(1 + 2 * n);
  out[0] = 2;
  let energy = 0;
  for (let c = 0; c < 2; c++) {
    const r = rng(0x9e3779b9 ^ ((index + 1) * 7919) ^ ((c + 1) * 104729));
    const ch = out.subarray(1 + c * n, 1 + (c + 1) * n);
    const lateStart = Math.round(erStart * rate);
    let lp1 = 0;
    let lp2 = 0;
    let gLow = 1;
    let gMid = 1;
    let gHigh = 1;
    for (let i = lateStart; i < n; i++) {
      const x = r();
      lp1 = x + (lp1 - x) * aLow;
      lp2 = x + (lp2 - x) * aHigh;
      const low = lp1;
      const high = x - lp2;
      const mid = lp2 - lp1;
      const k = i - lateStart;
      const build = 1 - Math.exp(-k / onset);
      ch[i] = build * (low * gLow + mid * gMid + high * gHigh);
      gLow *= kLow;
      gMid *= kMid;
      gHigh *= kHigh;
    }
    // A short fade at the end so truncation never clicks.
    const fade = Math.min(n, Math.round(0.02 * rate));
    for (let i = 0; i < fade; i++) ch[n - 1 - i] *= i / fade;
    // Early reflections: discrete taps with decreasing level, distinct per side.
    if (t.er) {
      const [a, b] = [t.er[0] * Math.sqrt(size), t.er[1] * size];
      let lateRms = 0;
      const probe = Math.min(n, lateStart + Math.round(0.05 * rate));
      for (let i = lateStart; i < probe; i++) lateRms += ch[i] * ch[i];
      lateRms = Math.sqrt(lateRms / Math.max(1, probe - lateStart));
      for (let k = 0; k < t.taps; k++) {
        const pos = a + (b - a) * ((k + 0.5 + 0.4 * r()) / t.taps) ** 1.4;
        const idx = Math.min(n - 1, Math.round(pos * rate));
        const level = (6 * lateRms + 0.05) * (1 - k / (t.taps + 2)) * (r() > -0.3 ? 1 : -1);
        ch[idx] += level;
      }
    }
    energy = bandEnergy(ch, rate, energy);
  }
  const scale = 1 / Math.sqrt(Math.max(1e-12, energy / 2) / levelTarget(rate));
  for (let i = 1; i < out.length; i++) out[i] *= scale;
  return out;
}

// ------------------------------------------------------- loaded impulses

/**
 * Impulse responses loaded from audio files, by name: { rate, channels:
 * Float32Array[] }. storage/impulses.js keeps them on the device and puts
 * them back here after a reload.
 */
const LOADED = new Map();

/** Most loaded impulses kept (each can be megabytes). */
export const MAX_LOADED_IMPULSES = 4;

/** Keeps a loaded impulse, dropping the least recently loaded beyond the limit. */
export function setLoadedImpulse(name, impulse) {
  LOADED.delete(name);
  LOADED.set(name, impulse);
  while (LOADED.size > MAX_LOADED_IMPULSES) LOADED.delete(LOADED.keys().next().value);
}

export const loadedImpulse = (name) => LOADED.get(name) || null;

/** Names of the loaded impulses, most recent first. */
export const loadedImpulseNames = () => [...LOADED.keys()].reverse();

/** Longest loaded impulse kept (s); the Rust side accepts up to 8 s. */
export const MAX_LOADED_SECONDS = 8;

/**
 * Shapes a loaded impulse like the built-in ones: room size stretches or
 * shrinks it in time, LF and HF damping make the lows and highs die away
 * sooner, and the result is energy normalised in the data slot layout
 * [channels, ...planar samples] at `rate`.
 */
export function shapeLoadedImpulse(impulse, values, rate) {
  const size = clamp(values.roomSize ?? 100, 10, 400) / 100;
  const src = impulse.channels.slice(0, 2);
  const step = impulse.rate / rate / size;
  const n = Math.max(1, Math.min(Math.round(MAX_LOADED_SECONDS * rate), Math.floor((src[0].length - 1) / step)));
  const k = src.length;
  const out = new Float32Array(1 + k * n);
  out[0] = k;
  const lfDamp = clamp(values.dampLF ?? 0, 0, 100) / 100;
  const hfDamp = clamp(values.dampHF ?? 0, 0, 100) / 100;
  // Damping: the low and high bands decay to -60 dB over a time that shrinks with the damping.
  const len = n / rate;
  const kLow = lfDamp > 0 ? 10 ** (-3 / (Math.max(0.05, len * (1 - 0.9 * lfDamp)) * rate)) : 1;
  const kHigh = hfDamp > 0 ? 10 ** (-3 / (Math.max(0.03, len * (1 - 0.95 * hfDamp)) * rate)) : 1;
  const aLow = Math.exp((-2 * Math.PI * 250) / rate);
  const aHigh = Math.exp((-2 * Math.PI * 4000) / rate);
  let energy = 0;
  for (let c = 0; c < k; c++) {
    const x = src[c];
    const ch = out.subarray(1 + c * n, 1 + (c + 1) * n);
    let lp1 = 0;
    let lp2 = 0;
    let gLow = 1;
    let gHigh = 1;
    for (let i = 0; i < n; i++) {
      const at = i * step;
      const j = Math.floor(at);
      const f = at - j;
      const v = x[j] + ((x[j + 1] ?? x[j]) - x[j]) * f;
      lp1 = v + (lp1 - v) * aLow;
      lp2 = v + (lp2 - v) * aHigh;
      ch[i] = lp1 * gLow + (lp2 - lp1) + (v - lp2) * gHigh;
      gLow *= kLow;
      gHigh *= kHigh;
    }
    energy = bandEnergy(ch, rate, energy);
  }
  const scale = 1 / Math.sqrt(Math.max(1e-12, energy / k) / levelTarget(rate));
  for (let i = 1; i < out.length; i++) out[i] *= scale;
  return out;
}
