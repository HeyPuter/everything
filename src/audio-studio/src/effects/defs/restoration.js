// Effect definitions: Noise Reduction / Restoration (WASM kinds 130..137 in
// wasm/dsp/src/fx/restore), plus the noise print capture used by Noise
// Reduction (process) and the Capture Noise Print command, and the sound
// model behind Learn Sound Model and Sound Remover (process).

import { registerEffect, getEffect, paramArray } from '../registry.js';
import { offloaded, runTask } from '../offline-fx.js';
import { num, db, hz, ms, pct, bool, choice, preset, pause, checkAbort, dataId, packCurve } from './util.js';

const GROUP = 'Noise Reduction / Restoration';

const fftChoice = (id, label, sizes, def) => choice(id, label, sizes.map((n) => ({ value: n, label: String(n) })), def);

/** Rounds to a power of two in [lo, hi], like the Rust side. */
function pow2(v, lo, hi) {
  const n = 2 ** Math.ceil(Math.log2(Math.max(256, Math.round(v))));
  return Math.min(hi, Math.max(lo, n));
}

const FOCUS = ['All frequencies', 'Low frequencies', 'Mid frequencies', 'High frequencies', 'Low and high frequencies'];

// ------------------------------------------------------------------- DeHummer

/** Magnitude of one finite-depth hum notch (mirrors dehummer.rs hum_notch). */
function notchMag(f, f0, q, depthDb, rate) {
  const w0 = (2 * Math.PI * f0) / rate;
  const rp = Math.exp((-Math.PI * (f0 / Math.max(0.5, q))) / rate);
  const g = 10 ** (Math.min(0, depthDb) / 20);
  const rz = 1 - g * (1 - rp);
  const c = Math.cos(w0);
  const w = (2 * Math.PI * f) / rate;
  const [c1, s1, c2, s2] = [Math.cos(w), -Math.sin(w), Math.cos(2 * w), -Math.sin(2 * w)];
  const nr = 1 - 2 * rz * c * c1 + rz * rz * c2;
  const ni = -2 * rz * c * s1 + rz * rz * s2;
  const dr = 1 - 2 * rp * c * c1 + rp * rp * c2;
  const di = -2 * rp * c * s1 + rp * rp * s2;
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

registerEffect({
  id: 'dehummer',
  name: 'DeHummer',
  group: GROUP,
  kind: 130,
  params: [
    hz('frequency', 'Frequency', 20, 1000, 60, { step: 0.1 }),
    num('q', 'Q', 5, 200, 30, '', { step: 1, scale: 'log' }),
    db('gain', 'Gain', -80, 0, -40),
    num('harmonics', 'Number of Harmonics', 1, 20, 6, '', { step: 1 }),
    pct('slope', 'Harmonic Slope', 75),
    bool('humOnly', 'Output Hum Only', false),
  ],
  presets: [
    preset('Mains 60 Hz', { frequency: 60, q: 30, gain: -40, harmonics: 6, slope: 75, humOnly: false }),
    preset('Mains 50 Hz', { frequency: 50, q: 30, gain: -40, harmonics: 6, slope: 75, humOnly: false }),
    preset('Ground Loop Buzz 60 Hz', { frequency: 60, q: 25, gain: -50, harmonics: 16, slope: 95, humOnly: false }),
    preset('Ground Loop Buzz 50 Hz', { frequency: 50, q: 25, gain: -50, harmonics: 16, slope: 95, humOnly: false }),
    preset('Light Touch 60 Hz', { frequency: 60, q: 60, gain: -24, harmonics: 3, slope: 60, humOnly: false }),
    preset('Light Touch 50 Hz', { frequency: 50, q: 60, gain: -24, harmonics: 3, slope: 60, humOnly: false }),
  ],
  response(values, freqs, rate) {
    const out = new Float32Array(freqs.length);
    const harmonics = Math.max(1, Math.round(values.harmonics));
    for (let i = 0; i < freqs.length; i++) {
      let m = 1;
      for (let h = 0; h < harmonics; h++) {
        const f0 = values.frequency * (h + 1);
        if (f0 >= rate * 0.45) break;
        m *= notchMag(freqs[i], f0, values.q, values.gain * (values.slope / 100) ** h, rate);
      }
      out[i] = 20 * Math.log10(values.humOnly ? Math.max(1e-6, Math.abs(1 - m)) : Math.max(1e-6, m));
    }
    return out;
  },
});

// ------------------------------------------------------------ Hiss Reduction

/** Level range of the hiss noise floor graph (dB of per-bin power). */
export const FLOOR_DB = [-140, 0];

/**
 * Noise floor level at `f` from floor points ([{ f, g }] sorted by f):
 * linear in frequency from a point at or below 1 Hz (the 0 Hz end), linear
 * in log frequency elsewhere, flat beyond the ends (hiss.rs floor_at).
 */
export function floorAt(points, f) {
  if (!points?.length) return FLOOR_DB[0];
  if (f <= points[0].f) return points[0].g;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (f <= b.f) {
      const t = a.f <= 1 ? (f - a.f) / Math.max(1e-6, b.f - a.f) : Math.log(f / a.f) / Math.max(1e-9, Math.log(b.f / a.f));
      return a.g + (b.g - a.g) * Math.min(1, Math.max(0, t));
    }
  }
  return points[points.length - 1].g;
}

/**
 * Editable floor points from a captured mean power spectrum (`spectrum`,
 * fftSize / 2 + 1 bins): a 0 Hz end, a few points through the low end, then
 * `count` points evenly spaced up to Nyquist (where hiss lives, and so they
 * stay apart on both the linear and the log axis), each the mean power within
 * a sixth of an octave around it, in dB.
 */
export function floorPoints(spectrum, fftSize, rate, count = 20) {
  const bins = spectrum.length;
  const nyq = rate / 2;
  const level = (lo, hi) => {
    const a = Math.max(1, Math.floor((lo * fftSize) / rate));
    const b = Math.min(bins - 1, Math.max(a, Math.ceil((hi * fftSize) / rate)));
    let sum = 0;
    for (let k = a; k <= b; k++) sum += spectrum[k];
    const db = 10 * Math.log10(sum / (b - a + 1) + 1e-30);
    return Math.round(Math.min(FLOOR_DB[1], Math.max(FLOOR_DB[0], db)) * 10) / 10;
  };
  const band = 2 ** (1 / 12);
  const top = nyq / 12;
  const freqs = [200, 500, 1000].filter((f) => f < top * 0.8);
  for (let i = 0; i < count; i++) freqs.push(top + ((nyq - top) * i) / (count - 1));
  return [{ f: 1, g: level(20, freqs[0] / band) }, ...freqs.map((f) => ({ f: Math.round(f * 10) / 10, g: level(f / band, Math.min(nyq, f * band)) }))];
}

registerEffect({
  id: 'hissReduction',
  name: 'Hiss Reduction',
  group: GROUP,
  kind: 131,
  params: [
    db('noiseFloor', 'Noise Floor', -40, 40, 0),
    db('reduceBy', 'Reduce By', 0, 100, 18),
    pct('decay', 'Spectral Decay Rate', 60),
    num('precision', 'Precision Factor', 1, 20, 7, '', { step: 1 }),
    db('transition', 'Transition Width', 0, 40, 6),
    fftChoice('fftSize', 'FFT Size', [512, 1024, 2048, 4096, 8192], 2048),
    bool('hissOnly', 'Output Hiss Only', false),
    // The noise floor graph's frequency axis (a view setting kept with the values).
    choice('floorScale', 'Scale', ['Linear', 'Logarithmic'], 0, { hidden: true }),
    // Captured or drawn noise floors per channel ([{ f, g }], dB of per-bin
    // power); empty = the floor is tracked from the audio as it plays.
    { id: 'floorLeft', label: 'Left Noise Floor', type: 'curve', default: [], min: FLOOR_DB[0], max: FLOOR_DB[1], unit: 'dB', hidden: true },
    { id: 'floorRight', label: 'Right Noise Floor', type: 'curve', default: [], min: FLOOR_DB[0], max: FLOOR_DB[1], unit: 'dB', hidden: true },
  ],
  presets: [
    preset('Light Tape Hiss', { noiseFloor: 0, reduceBy: 12, decay: 60, precision: 7, transition: 6, fftSize: 2048, hissOnly: false }),
    preset('Heavy Tape Hiss', { noiseFloor: 4, reduceBy: 30, decay: 70, precision: 9, transition: 8, fftSize: 4096, hissOnly: false }),
    preset('Old Broadcast', { noiseFloor: 6, reduceBy: 24, decay: 75, precision: 7, transition: 10, fftSize: 4096, hissOnly: false }),
    preset('Fast and Transparent', { noiseFloor: -3, reduceBy: 10, decay: 40, precision: 5, transition: 4, fftSize: 1024, hissOnly: false }),
  ],
  latency: (v) => pow2(v.fftSize, 256, 16384),
  // An empty floor still sends one value (no pairs), so the processor drops an old one.
  data: (v) => ['floorLeft', 'floorRight'].map((id, slot) => ({ slot, id: dataId(v[id] || []), values: v[id]?.length ? packCurve(v[id]) : new Float32Array([-1]) })),
});

// -------------------------------------------------------------------- DeNoise

registerEffect({
  id: 'denoise',
  name: 'DeNoise',
  group: GROUP,
  kind: 132,
  params: [pct('amount', 'Amount', 40), choice('focus', 'Processing Focus', FOCUS, 0), db('gain', 'Gain', -20, 20, 0), bool('noiseOnly', 'Output Noise Only', false)],
  presets: [
    preset('Gentle Cleanup', { amount: 25, focus: 0, gain: 0 }),
    preset('Voice Over Background Noise', { amount: 60, focus: 2, gain: 1 }),
    preset('Strong Broadband Removal', { amount: 85, focus: 0, gain: 2 }),
    preset('Air Conditioner Rumble', { amount: 60, focus: 1, gain: 0 }),
    preset('High Frequency Fizz', { amount: 50, focus: 3, gain: 0 }),
  ],
  latency: () => 2048,
});

// ------------------------------------------------------------------- DeReverb

registerEffect({
  id: 'dereverb',
  name: 'DeReverb',
  group: GROUP,
  kind: 133,
  params: [
    pct('amount', 'Amount', 50),
    choice('focus', 'Processing Focus', FOCUS, 0),
    db('gain', 'Gain', -20, 20, 0),
    ms('decay', 'Room Decay (RT60)', 100, 5000, 800, { step: 10 }),
    bool('autoGain', 'Auto Gain', false),
  ],
  presets: [
    preset('Small Room', { amount: 50, focus: 0, gain: 0, decay: 400 }),
    preset('Lecture Hall', { amount: 70, focus: 2, gain: 2, decay: 1500 }),
    preset('Echoey Kitchen', { amount: 65, focus: 0, gain: 1, decay: 700 }),
    preset('Light Touch', { amount: 25, focus: 0, gain: 0, decay: 800 }),
  ],
  latency: () => 2048,
});

// --------------------------------------------------- Adaptive Noise Reduction

registerEffect({
  id: 'adaptiveNoiseReduction',
  name: 'Adaptive Noise Reduction',
  group: GROUP,
  kind: 134,
  params: [
    db('reduceBy', 'Reduce Noise By', 0, 60, 12),
    pct('noisiness', 'Noisiness', 20),
    db('noiseFloor', 'Fine Tune Noise Floor', -20, 20, 0),
    db('threshold', 'Signal Threshold', -20, 30, 3),
    num('decay', 'Spectral Decay Rate', 0, 2000, 150, 'ms', { step: 10 }),
    num('broadband', 'Broadband Preservation', 0, 500, 100, 'Hz', { step: 5 }),
    fftChoice('fftSize', 'FFT Size', [256, 512, 1024, 2048, 4096, 8192], 1024),
    bool('highQuality', 'High Quality Mode (slower)', false),
  ],
  about: 'Learns the noise floor as it plays and keeps reducing whatever stays near it, so it needs no noise print. High Quality Mode overlaps more analysis frames and smooths the reduction, leaving less watery residue for about twice the processing.',
  presets: [
    preset('Light Background Noise', { reduceBy: 8, noisiness: 15, noiseFloor: 0, threshold: 3, decay: 150, broadband: 100, fftSize: 1024 }),
    preset('Heavy Background Noise', { reduceBy: 24, noisiness: 40, noiseFloor: 2, threshold: 2, decay: 250, broadband: 150, fftSize: 2048 }),
    preset('Dialogue in a Room', { reduceBy: 14, noisiness: 25, noiseFloor: 0, threshold: 4, decay: 120, broadband: 80, fftSize: 1024 }),
    preset('Low Latency', { reduceBy: 10, noisiness: 20, noiseFloor: 0, threshold: 3, decay: 100, broadband: 100, fftSize: 256 }),
  ],
  latency: (v) => pow2(v.fftSize, 256, 8192),
});

// ------------------------------------------------ Noise Reduction (process)

let nextPrintId = 1;
const packed = new WeakMap();

/** Flat threshold adjustment (no change to the noise print). */
export const FLAT_CURVE = [{ f: 20, g: 0 }, { f: 20000, g: 0 }];
const isFlat = (curve) => !curve?.length || curve.every((p) => !p.g);

/** Adjustment in dB at frequency f: straight lines between points on a log-frequency axis. */
export function curveGainAt(curve, f) {
  const pts = [...(curve || [])].sort((a, b) => a.f - b.f);
  if (!pts.length) return 0;
  if (f <= pts[0].f) return pts[0].g;
  for (let i = 1; i < pts.length; i++) {
    if (f <= pts[i].f) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = Math.log(f / a.f) / Math.log(b.f / a.f || 2);
      return a.g + (b.g - a.g) * (Number.isFinite(t) ? t : 0);
    }
  }
  return pts[pts.length - 1].g;
}

/**
 * Packs a noise print for WASM data slot 0 of kind 135:
 * [fftSize, channels, rate, bins, channel 0 bins..., channel 1 bins...].
 * `curve` ([{ f, g }], dB) raises or lowers the print per frequency: the
 * level above which audio counts as signal rather than noise, so a raised
 * region is reduced harder and a lowered one is left more alone.
 */
export function packNoisePrint(print, curve = null) {
  if (!print?.channels?.length) return null;
  const flat = isFlat(curve);
  const key = flat ? '' : JSON.stringify(curve);
  const cached = packed.get(print);
  if (cached?.key === key) return cached.out;
  const bins = print.channels[0].length;
  const out = new Float32Array(4 + print.channels.length * bins);
  out.set([print.fftSize, print.channels.length, print.rate, bins], 0);
  const scale = new Float32Array(bins).fill(1);
  if (!flat) for (let k = 0; k < bins; k++) scale[k] = 10 ** (curveGainAt(curve, Math.max(1, (k * print.rate) / print.fftSize)) / 10);
  print.channels.forEach((c, i) => {
    for (let k = 0; k < bins; k++) out[4 + i * bins + k] = c[k] * scale[k];
  });
  packed.set(print, { key, out });
  return out;
}

/** A noise print as plain JSON (Save Noise Print). */
export function serializeNoisePrint(print) {
  return { type: 'audio-studio-noise-print', version: 1, rate: print.rate, fftSize: print.fftSize, frames: print.frames, seconds: print.seconds, channels: print.channels.map((c) => Array.from(c, (v) => Number(v.toPrecision(6)))) };
}

/** Reads a saved noise print (throws on anything else). */
export function parseNoisePrint(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  const ok = o?.type === 'audio-studio-noise-print' && Number(o.fftSize) >= 256 && Number(o.rate) > 0 && Array.isArray(o.channels) && o.channels.length > 0;
  const bins = ok ? Number(o.fftSize) / 2 + 1 : 0;
  if (!ok || o.channels.some((c) => !Array.isArray(c) || c.length !== bins || c.some((v) => !Number.isFinite(v) || v < 0))) {
    throw new Error('This file is not a noise print saved by Audio Studio.');
  }
  return { id: nextPrintId++, rate: Number(o.rate), fftSize: Number(o.fftSize), frames: Number(o.frames) || 0, seconds: Number(o.seconds) || 0, channels: o.channels.map((c) => Float32Array.from(c)) };
}

/**
 * Captures a noise print: the mean noise power per frequency bin of each
 * channel (computed in WASM, in chunks so long selections stay responsive).
 * @param {import('../../audio/dsp.js').Dsp} dsp
 * @param {Float32Array[]} channels the noise-only audio
 * @param {number} rate
 * @param {{ fftSize?: number, signal?: AbortSignal, onProgress?: (f:number)=>void }} [o]
 * @returns {Promise<{ id, rate, fftSize, channels: Float32Array[], frames: number, seconds: number }>}
 */
export async function captureNoisePrint(dsp, channels, rate, { fftSize = 4096, signal, onProgress } = {}) {
  const len = channels[0]?.length || 0;
  let n = fftSize;
  while (n > 256 && n > len) n /= 2;
  if (len < n) throw new Error('Select at least a few milliseconds of noise to capture a noise print.');
  const bins = n / 2 + 1;
  const hop = n / 4;
  const framesPerChunk = 64;
  const step = framesPerChunk * hop;
  const acc = dsp.floats(bins);
  const result = [];
  let frames = 0;
  try {
    for (let c = 0; c < channels.length; c++) {
      acc.view().fill(0);
      frames = 0;
      for (let at = 0; at + n <= len; at += step) {
        const end = Math.min(len, at + step + n - hop);
        const buf = dsp.copyIn(channels[c].subarray(at, end));
        frames += dsp.x.rs_noise_profile(buf.ptr, end - at, n, acc.ptr);
        buf.free();
        onProgress?.((c + at / len) / channels.length);
        checkAbort(signal);
        if (len > step * 4) await pause();
      }
      const mean = acc.view().slice();
      for (let k = 0; k < bins; k++) mean[k] /= Math.max(1, frames);
      result.push(mean);
    }
  } finally {
    acc.free();
  }
  onProgress?.(1);
  return { id: nextPrintId++, rate, fftSize: n, channels: result, frames, seconds: len / rate };
}

registerEffect({
  id: 'noiseReduction',
  name: 'Noise Reduction (process)',
  group: GROUP,
  kind: 135,
  needsNoisePrint: true,
  params: [
    pct('reduction', 'Noise Reduction', 60),
    db('reduceBy', 'Reduce By', 0, 100, 20),
    pct('decay', 'Spectral Decay Rate', 65),
    num('smoothing', 'Smoothing', 0, 10, 1, '', { step: 1 }),
    num('precision', 'Precision Factor', 1, 20, 7, '', { step: 1 }),
    db('transition', 'Transition Width', 0, 40, 8),
    fftChoice('fftSize', 'FFT Size', [512, 1024, 2048, 4096, 8192, 16384], 4096),
    bool('noiseOnly', 'Output Noise Only', false),
    { id: 'curve', label: 'Threshold Adjustment', type: 'curve', default: FLAT_CURVE, min: -30, max: 30, unit: 'dB', hidden: true },
  ],
  presets: [
    preset('Gentle Cleanup', { reduction: 50, reduceBy: 12, decay: 70, smoothing: 2, precision: 7, transition: 10, fftSize: 4096, noiseOnly: false }),
    preset('Steady Hum and Hiss', { reduction: 80, reduceBy: 30, decay: 65, smoothing: 1, precision: 9, transition: 8, fftSize: 8192, noiseOnly: false }),
    preset('Maximum Removal', { reduction: 100, reduceBy: 48, decay: 60, smoothing: 2, precision: 11, transition: 6, fftSize: 8192, noiseOnly: false }),
    preset('Speech Friendly', { reduction: 65, reduceBy: 18, decay: 75, smoothing: 3, precision: 7, transition: 12, fftSize: 2048, noiseOnly: false }),
    preset('Hear What Gets Removed', { reduction: 80, reduceBy: 30, decay: 65, smoothing: 1, precision: 7, transition: 8, fftSize: 4096, noiseOnly: true }),
  ],
  latency: (v) => pow2(v.fftSize, 256, 16384),
  data(values, { doc } = {}) {
    const print = packNoisePrint(doc?.noisePrint, values.curve);
    return print ? [{ slot: 0, id: `np${doc.noisePrint.id ?? 0}${isFlat(values.curve) ? '' : `:${dataId(values.curve)}`}`, values: print }] : [];
  },
  run: async ({ channels, rate, values, extra, dsp, onProgress, signal }) => {
    const print = packNoisePrint(extra?.noisePrint, values.curve);
    if (!print) throw new Error('Capture a noise print first: select noise only and choose Capture Noise Print (Shift+P).');
    const def = getEffect('noiseReduction');
    checkAbort(signal);
    const params = paramArray(def, values);
    if (channels.length <= 2) return dsp.runEffect(135, rate, channels, params, { data: [{ slot: 0, values: print }], onProgress });
    // The processor takes one or two channels: a 5.1 file runs its first two as
    // the stereo pair and each further channel on its own, with that channel's
    // noise print when the print has one.
    const all = extra.noisePrint;
    const groups = [[0, 1], ...channels.slice(2).map((_, i) => [i + 2])];
    const out = [];
    for (let k = 0; k < groups.length; k++) {
      checkAbort(signal);
      const g = groups[k];
      const own = g.every((c) => c < all.channels.length) ? packNoisePrint({ ...all, channels: g.map((c) => all.channels[c]) }, values.curve) : print;
      const progress = onProgress && ((f) => onProgress((k + f) / groups.length));
      out.push(...dsp.runEffect(135, rate, g.map((c) => channels[c]), params, { data: [{ slot: 0, values: own }], onProgress: progress }));
      await pause();
    }
    return out;
  },
  process: offloaded('noiseReduction', { context: ({ doc }) => ({ noisePrint: doc?.noisePrint || null }) }),
});

// ------------------------------------------------- Automatic Click Remover

registerEffect({
  id: 'autoClickRemover',
  name: 'Automatic Click Remover',
  group: GROUP,
  kind: 136,
  params: [num('threshold', 'Threshold', 1, 100, 30, '', { step: 1 }), num('complexity', 'Complexity', 1, 100, 30, '', { step: 1 })],
  presets: [
    preset('Light Crackle', { threshold: 45, complexity: 20 }),
    preset('Vinyl Clicks', { threshold: 30, complexity: 35 }),
    preset('Heavy Pops', { threshold: 20, complexity: 80 }),
    preset('Digital Glitches', { threshold: 25, complexity: 15 }),
  ],
  latency: () => 336,
});

// --------------------------------------------- Automatic Phase Correction

registerEffect({
  id: 'autoPhaseCorrection',
  name: 'Automatic Phase Correction',
  group: GROUP,
  kind: 137,
  params: [
    bool('globalShift', 'Global Time Shift', true),
    bool('alignBands', 'Auto Align Frequency Bands', false),
    choice('channel', 'Adjust', ['Left Channel', 'Right Channel', 'Both (Center)'], 2),
    ms('resolution', 'Time Resolution', 10, 2000, 300, { step: 10 }),
    fftChoice('analysisSize', 'Analysis Size', [512, 1024, 2048, 4096, 8192], 2048),
    num('leftShift', 'Left Channel Shift', -1000, 1000, 0, '\u00b5s', { step: 1 }),
    num('rightShift', 'Right Channel Shift', -1000, 1000, 0, '\u00b5s', { step: 1 }),
    bool('centerPan', 'Auto Center Panning', false),
  ],
  presets: [
    preset('Align Two Microphones', { globalShift: true, alignBands: false, channel: 2, resolution: 500, analysisSize: 4096 }),
    preset('Tape Azimuth Fix', { globalShift: true, alignBands: true, channel: 1, resolution: 300, analysisSize: 2048 }),
    preset('Fast Tracking', { globalShift: true, alignBands: false, channel: 2, resolution: 80, analysisSize: 1024 }),
    preset('Even Out a Lopsided Recording', { globalShift: true, alignBands: false, channel: 2, resolution: 500, analysisSize: 2048, centerPan: true }),
  ],
  latency: (v) => pow2(v.analysisSize, 512, 8192),
});

// ------------------------------------------------------ Sound Remover (process)

/** Longest example a sound model keeps; a model needs seconds, not minutes. */
export const MAX_SOUND_SECONDS = 15;
const REMOVE_CHUNK = 1 << 19;
const REMOVE_FADE = 8192;
let nextModelId = 1;

/**
 * NMF settings from Sound Remover values: FFT size, sound bases (model
 * complexity), free bases for everything else (content complexity) and the
 * iteration counts the sound and content refinement passes buy for learning
 * and removal.
 */
export function soundSettings(v) {
  return {
    fft: pow2(v.fftSize, 512, 8192),
    k: Math.max(1, Math.round(v.complexity)),
    kFree: Math.max(1, Math.round(v.contentComplexity)),
    learnIters: 20 + 2 * Math.max(1, Math.round(v.passes)),
    removeIters: Math.max(1, Math.round(v.contentPasses ?? 40)),
  };
}

/** Learns k basis spectra (k x (fft/2 + 1), k-major) from mono samples in WASM. */
export function learnBases(dsp, samples, { fft, k, learnIters }) {
  const bins = fft / 2 + 1;
  const src = dsp.copyIn(samples);
  const out = dsp.floats(k * bins);
  try {
    dsp.x.rs_sound_learn(src.ptr, samples.length, fft, k, learnIters, out.ptr);
    return out.view().slice();
  } finally {
    src.free();
    out.free();
  }
}

/** Mixes channels to mono (the model describes the sound, not its placement). */
export function mixToMono(channels) {
  const n = channels[0]?.length || 0;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

/**
 * Builds a sound model from an example of the sound: the example itself
 * (mono, at most MAX_SOUND_SECONDS, so other settings can relearn it) and
 * its NMF bases for `values` (Sound Remover settings).
 * @returns {{ id, rate, seconds, samples: Float32Array, bases: { fft, k, learnIters, w: Float32Array } }}
 */
export function buildSoundModel(dsp, channels, rate, values) {
  const mono = mixToMono(channels).subarray(0, Math.round(MAX_SOUND_SECONDS * rate)).slice();
  const s = soundSettings(values);
  if (mono.length < s.fft) throw new Error('Select at least a fraction of a second of the sound to learn it.');
  const w = learnBases(dsp, mono, s);
  return { id: nextModelId++, rate, seconds: mono.length / rate, samples: mono, bases: { fft: s.fft, k: s.k, learnIters: s.learnIters, w } };
}

/** Bases of `model` for settings `s`, relearning from its example when they differ. */
export function modelBases(dsp, model, s, rate) {
  const b = model.bases;
  if (b && b.fft === s.fft && b.k === s.k && b.learnIters === s.learnIters && model.rate === rate) return b.w;
  const samples = model.rate === rate ? model.samples : dsp.resample(model.samples, model.rate, rate);
  return learnBases(dsp, samples, s);
}

/**
 * Removes the modelled sound from `channels` in overlapping chunks (memory
 * stays bounded on long files); neighbouring chunks crossfade over
 * REMOVE_FADE frames so their independently fitted masks join smoothly.
 */
export async function removeSound(dsp, channels, rate, w, values, { onProgress, signal } = {}) {
  const s = soundSettings(values);
  const nch = channels.length;
  const len = channels[0]?.length || 0;
  const out = channels.map(() => new Float32Array(len));
  const alpha = 2 ** ((values.sensitivity - 5) / 2);
  const model = dsp.copyIn(w);
  try {
    for (let a = 0; a < len; a += REMOVE_CHUNK) {
      checkAbort(signal);
      const b = Math.min(len, a + REMOVE_CHUNK + REMOVE_FADE);
      const n = b - a;
      const buf = dsp.floats(nch * n);
      const v = buf.view();
      for (let c = 0; c < nch; c++) v.set(channels[c].subarray(a, b), c * n);
      dsp.x.rs_sound_remove(buf.ptr, nch, n, s.fft, model.ptr, s.k, s.kFree, s.removeIters, values.strength / 100, -values.reduceBy, alpha, values.speech ? 1 : 0, rate, values.enhanced ? values.suppression / 100 : 0);
      const r = buf.view();
      for (let c = 0; c < nch; c++) {
        const dst = out[c];
        for (let i = 0; i < n; i++) {
          const at = a + i;
          // The previous chunk wrote [a, a + REMOVE_FADE): fade from it into this one.
          if (a > 0 && i < REMOVE_FADE) {
            const t = (i + 0.5) / REMOVE_FADE;
            dst[at] = dst[at] * (1 - t) + r[c * n + i] * t;
          } else dst[at] = r[c * n + i];
        }
      }
      buf.free();
      onProgress?.(Math.min(1, b / Math.max(1, len)));
      if (b >= len) break;
      await pause();
    }
  } finally {
    model.free();
  }
  return out;
}

registerEffect({
  id: 'soundRemover',
  name: 'Sound Remover (process)',
  group: GROUP,
  kind: null,
  needsSoundModel: true,
  params: [
    num('complexity', 'Sound Model Complexity', 1, 100, 8, '', { step: 1 }),
    num('passes', 'Sound Refinement Passes', 1, 150, 40, '', { step: 1 }),
    num('contentComplexity', 'Content Complexity', 1, 100, 16, '', { step: 1 }),
    pct('strength', 'Reduction Strength', 100),
    db('reduceBy', 'Maximum Reduction', 0, 80, 40),
    num('sensitivity', 'Sensitivity', 1, 10, 5, '', { step: 0.5 }),
    fftChoice('fftSize', 'FFT Size', [512, 1024, 2048, 4096, 8192], 2048),
    bool('speech', 'Enhance for Speech', false),
    // Iterations fitting the content around the sound during removal.
    num('contentPasses', 'Content Refinement Passes', 1, 150, 40, '', { step: 1 }),
    // A harder mask that clears cells the sound dominates more completely.
    bool('enhanced', 'Enhanced Suppression', false),
    pct('suppression', 'Suppression Strength', 50, { enabledIf: (v) => v.enhanced }),
  ],
  presets: [
    preset('Default', {}),
    preset('Remove Beeps and Tones', { complexity: 4, passes: 40, contentPasses: 40, contentComplexity: 24, strength: 100, reduceBy: 60, sensitivity: 6, fftSize: 4096, speech: false }),
    preset('Remove Background Hum or Whine', { complexity: 6, passes: 50, contentPasses: 50, contentComplexity: 20, strength: 100, reduceBy: 40, sensitivity: 5, fftSize: 8192, speech: false }),
    preset('Remove Sound Under Dialogue', { complexity: 10, passes: 50, contentPasses: 50, contentComplexity: 16, strength: 90, reduceBy: 30, sensitivity: 5, fftSize: 2048, speech: true }),
    preset('Gentle Reduction', { complexity: 8, passes: 30, contentPasses: 30, contentComplexity: 24, strength: 60, reduceBy: 15, sensitivity: 4, fftSize: 2048, speech: false }),
    preset('Aggressive Removal', { complexity: 16, passes: 70, contentPasses: 70, contentComplexity: 12, strength: 100, reduceBy: 70, sensitivity: 8, fftSize: 2048, speech: false, enhanced: true, suppression: 60 }),
  ],
  run: async ({ channels, rate, values, extra, dsp, onProgress, signal }) => {
    const model = extra?.soundModel;
    if (!model) throw new Error('Learn a sound model first: select an example of the sound only and choose Learn Sound Model.');
    checkAbort(signal);
    const w = modelBases(dsp, model, soundSettings(values), rate);
    onProgress?.(0.02);
    return removeSound(dsp, channels, rate, w, values, { signal, onProgress: (f) => onProgress?.(0.02 + 0.98 * f) });
  },
  process: offloaded('soundRemover', { context: ({ doc }) => ({ soundModel: doc?.soundModel || null }) }),
  tasks: {
    /** Learn Sound Model: the model of `channels` for the given Sound Remover settings. */
    learn: async ({ channels, rate, values, dsp }) => buildSoundModel(dsp, channels, rate, values),
  },
});

/**
 * Learns a sound model from an example of the sound (in the effect worker).
 * `values` are the Sound Remover settings it is learned for.
 */
export async function learnSoundModel(channels, rate, values, { signal } = {}) {
  const model = await runTask('soundRemover', 'learn', { channels, rate, values, signal });
  // Ids are unique per page; models learned in a worker take a main-thread id.
  return { ...model, id: nextModelId++ };
}
