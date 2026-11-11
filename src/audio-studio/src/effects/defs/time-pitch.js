// Effect definitions: Time and Pitch.
//
// Realtime (wasm/dsp/src/fx/pitch): Pitch Shifter (120) and Automatic Pitch
// Correction (121), both phase vocoders with phase locking.
// Offline (streamed through the tp_* C ABI in a Worker): Stretch and Pitch,
// Pitch Bender (varispeed, so the duration changes with the pitch, like tape)
// and Manual Pitch Correction (vocoder, duration kept).

import { registerEffect } from '../registry.js';
import { offloaded } from '../offline-fx.js';
import { num, hz, bool, choice, preset, pause, checkAbort } from './util.js';
import { valueAt } from '../envelope.js';

const GROUP = 'Time and Pitch';

/** FFT size for a precision choice, matching fx/pitch/core.rs fft_size. */
export function pitchFftSize(base, precision, rate) {
  const k = Math.round(Math.log2(rate / 48000));
  const n = (base << Math.min(2, Math.max(0, Math.round(precision)))) * 2 ** k;
  return Math.min(32768, Math.max(256, 2 ** Math.ceil(Math.log2(n))));
}

const PRECISION = ['Low', 'Medium', 'High'];
const KEYS = ['C', 'C# / Db', 'D', 'D# / Eb', 'E', 'F', 'F# / Gb', 'G', 'G# / Ab', 'A', 'A# / Bb', 'B'];

/** Semitones plus cents to a frequency ratio. */
export const pitchRatio = (semitones = 0, cents = 0) => 2 ** ((semitones + cents / 100) / 12);

/**
 * Runs an offline time/pitch job (fx/pitch/mod.rs tp_new) over whole
 * channels, streaming input in chunks so memory stays bounded. The processor
 * takes one or two channels: wider files (5.1) run the first two as the
 * stereo pair and every further channel on its own, all fitted to the pair's
 * output length.
 * @returns {Promise<Float32Array[]>}
 */
export async function runTimePitch(dsp, channels, rate, job, { onProgress, signal } = {}) {
  if (channels.length <= 2) return timePitchJob(dsp, channels, rate, job, { onProgress, signal });
  const groups = [channels.slice(0, 2), ...channels.slice(2).map((c) => [c])];
  const out = [];
  for (let k = 0; k < groups.length; k++) {
    const progress = onProgress && ((f) => onProgress((k + f) / groups.length));
    const part = await timePitchJob(dsp, groups[k], rate, job, { onProgress: progress, signal });
    for (const c of part) {
      if (!out.length || c.length === out[0].length) out.push(c);
      else {
        const fit = new Float32Array(out[0].length);
        fit.set(c.subarray(0, fit.length));
        out.push(fit);
      }
    }
  }
  return out;
}

async function timePitchJob(dsp, channels, rate, { mode, precision = 1, stretch = 1, pitch = 1, flags = 0, curve = null }, { onProgress, signal } = {}) {
  const x = dsp.x;
  const ch = Math.min(2, channels.length);
  const len = channels[0].length;
  const h = x.tp_new(mode, ch, rate, precision, stretch, pitch, flags);
  const parts = Array.from({ length: ch }, () => []);
  let outLen = 0;
  const drain = () => {
    const n = x.tp_available(h);
    if (!n) return;
    const buf = dsp.floats(n * ch);
    const got = x.tp_pull(h, buf.ptr, n);
    const v = buf.view();
    for (let c = 0; c < ch; c++) parts[c].push(v.slice(c * n, c * n + got));
    outLen += got;
    buf.free();
  };
  try {
    if (curve?.length) {
      const b = dsp.copyIn(curve);
      x.tp_curve(h, b.ptr, curve.length);
      b.free();
    }
    const CHUNK = 1 << 16;
    const inb = dsp.floats(CHUNK * ch);
    try {
      for (let at = 0; at < len; at += CHUNK) {
        checkAbort(signal);
        const n = Math.min(CHUNK, len - at);
        const v = new Float32Array(dsp.memory, inb.ptr, ch * n);
        for (let c = 0; c < ch; c++) v.set(channels[c].subarray(at, at + n), c * n);
        x.tp_push(h, inb.ptr, n);
        drain();
        onProgress?.(0.98 * ((at + n) / len));
        await pause();
      }
    } finally {
      inb.free();
    }
    checkAbort(signal);
    x.tp_finish(h);
    drain();
    onProgress?.(1);
  } finally {
    x.tp_free(h);
  }
  const out = parts.map((list) => {
    const a = new Float32Array(outLen);
    let at = 0;
    for (const p of list) {
      a.set(p, at);
      at += p.length;
    }
    return a;
  });
  return out;
}

/** Points of a spline (eased) envelope, sampled densely so straight segments follow the curve the graph draws. */
function eased(points, n = 96) {
  const sorted = [...(points || [])].sort((a, b) => a.t - b.t);
  if (sorted.length < 2) return sorted;
  return Array.from({ length: n + 1 }, (_, i) => ({ t: i / n, v: valueAt(sorted, i / n, true) }));
}

/** Pitch Bender range in semitones: the semitone range, or the shift a tempo change of `bpmRange` makes at `tempo`. */
export function bendRange(v) {
  if (v.rangeMode === 1) return Math.min(48, 12 * Math.log2((Math.max(1, v.tempo) + Math.max(0, v.bpmRange)) / Math.max(1, v.tempo)));
  return v.range;
}

/** Envelope points [{ t, v }] to flat (input frame, value) pairs. */
function envelopeCurve(points, len, map, spline = false) {
  if (spline) points = eased(points);
  const sorted = [...(points || [])].sort((a, b) => a.t - b.t);
  const flat = new Float32Array(sorted.length * 2);
  sorted.forEach((p, i) => {
    flat[2 * i] = Math.max(0, Math.min(1, p.t)) * len;
    flat[2 * i + 1] = map(p.v);
  });
  return flat;
}

/** Latency of the splicing shifter: half a splice plus two frames (shifter.rs, in f32). */
export function spliceLatency(hz, rate) {
  const f = Math.fround;
  const len = Math.max(8, f(f(rate) / f(Math.min(200, Math.max(10, hz)))));
  return Math.round(f(2 + f(0.5 * len)));
}

/** Pitch Bender quality: sinc kernel zero crossings per side, Low to Perfect. */
export const BEND_QUALITY = [2, 4, 8, 12, 16, 32];

registerEffect({
  id: 'pitchShifter',
  name: 'Pitch Shifter',
  group: GROUP,
  kind: 120,
  params: [
    num('semitones', 'Semitones', -24, 24, 0, 'st', { step: 1 }),
    num('cents', 'Cents', -100, 100, 0, 'ct', { step: 1 }),
    choice('precision', 'Precision', PRECISION, 1, { enabledIf: (v) => v.autoSplice }),
    bool('formants', 'Preserve Formants', false, { enabledIf: (v) => v.autoSplice }),
    // On: spectral shifting sized by Precision. Off: time-domain splicing with
    // the splicing frequency (grains per second) and crossfade overlap below.
    bool('autoSplice', 'Use Automatic Settings', true),
    hz('splice', 'Splicing Frequency', 10, 200, 48, { enabledIf: (v) => !v.autoSplice }),
    num('overlap', 'Overlapping', 1, 50, 30, '%', { step: 0.1, enabledIf: (v) => !v.autoSplice }),
  ],
  presets: [
    preset('Unchanged', { semitones: 0, cents: 0, precision: 1, formants: false }),
    preset('Up an Octave', { semitones: 12, cents: 0, precision: 1, formants: false }),
    preset('Down an Octave', { semitones: -12, cents: 0, precision: 2, formants: false }),
    preset('Up a Fifth', { semitones: 7, cents: 0, precision: 1, formants: false }),
    preset('Slight Detune', { semitones: 0, cents: 12, precision: 1, formants: false }),
    preset('Deeper Voice', { semitones: -3, cents: 0, precision: 1, formants: true }),
    preset('Smaller Voice', { semitones: 4, cents: 0, precision: 1, formants: true }),
  ],
  latency: (v, rate) => (v.autoSplice === false ? spliceLatency(v.splice, rate) : pitchFftSize(1024, v.precision, rate)),
  /** Frequency ratio shown next to the semitone and cent controls. */
  ratio: (v) => pitchRatio(v.semitones, v.cents),
});

registerEffect({
  id: 'automaticPitchCorrection',
  name: 'Automatic Pitch Correction',
  group: GROUP,
  kind: 121,
  params: [
    choice('scale', 'Scale', ['Major', 'Minor', 'Chromatic'], 2),
    choice('key', 'Key', KEYS, 0),
    num('attack', 'Attack', 1, 10, 7, '', { step: 0.1, description: 'How quickly notes are pulled into tune (1 slow, 10 fast)' }),
    num('sensitivity', 'Sensitivity', 1, 200, 50, '', { step: 1, description: 'How noisy a note may be and still be corrected' }),
    choice('reference', 'Reference Channel', ['Left', 'Right'], 0),
    choice('fftSize', 'FFT Size', ['1024', '2048', '4096'], 1),
    hz('calibration', 'A4 Calibration', 410, 470, 440, { scale: 'linear', step: 0.1 }),
  ],
  presets: [
    preset('Chromatic Gentle', { scale: 2, key: 0, attack: 4, sensitivity: 40 }),
    preset('Chromatic Hard Tune', { scale: 2, key: 0, attack: 10, sensitivity: 70 }),
    preset('C Major Natural', { scale: 0, key: 0, attack: 6, sensitivity: 50 }),
    preset('A Minor Natural', { scale: 1, key: 9, attack: 6, sensitivity: 50 }),
    preset('G Major Robotic', { scale: 0, key: 7, attack: 10, sensitivity: 80 }),
  ],
  latency: (v, rate) => pitchFftSize(1024, v.fftSize, rate),
  // Live [correction cents, detected Hz, target MIDI note] while previewing.
  readout: true,
});

registerEffect({
  id: 'stretchPitch',
  name: 'Stretch and Pitch',
  group: GROUP,
  kind: null,
  params: [
    choice('algorithm', 'Algorithm', ['Spectral (music)', 'Waveform (speech)', 'Varispeed (tape)'], 0),
    num('stretch', 'Stretch', 10, 1000, 100, '%', { step: 0.1, scale: 'log', description: 'New duration as a percentage of the original' }),
    num('semitones', 'Pitch Shift', -36, 36, 0, 'st', { step: 1 }),
    num('cents', 'Cents', -100, 100, 0, 'ct', { step: 1 }),
    choice('precision', 'Precision', PRECISION, 1),
    bool('lockChannels', 'Lock Stereo Channels', true),
    bool('formants', 'Preserve Formants', false),
  ],
  presets: [
    preset('No Change', { algorithm: 0, stretch: 100, semitones: 0, cents: 0 }),
    preset('Half Speed', { algorithm: 0, stretch: 200, semitones: 0, cents: 0 }),
    preset('Double Speed', { algorithm: 0, stretch: 50, semitones: 0, cents: 0 }),
    preset('Ten Percent Slower', { algorithm: 0, stretch: 110, semitones: 0, cents: 0 }),
    preset('Ten Percent Faster', { algorithm: 0, stretch: 90, semitones: 0, cents: 0 }),
    preset('Up a Semitone', { algorithm: 0, stretch: 100, semitones: 1, cents: 0 }),
    preset('Down a Semitone', { algorithm: 0, stretch: 100, semitones: -1, cents: 0 }),
    preset('Speech Slower', { algorithm: 1, stretch: 125, semitones: 0, cents: 0 }),
    preset('Speech Faster', { algorithm: 1, stretch: 80, semitones: 0, cents: 0 }),
    preset('Tape Half Speed', { algorithm: 2, stretch: 200, semitones: 0, cents: 0 }),
  ],
  /** Output length in frames for an input of `frames` (for the dialog's duration readout). */
  outputLength: (v, frames) => Math.round((frames * v.stretch) / 100),
  /** Varispeed ties pitch to stretch: the dialog should disable pitch for it. */
  pitchLocked: (v) => v.algorithm === 2,
  run: async ({ channels, rate, values: v, dsp, onProgress, signal }) => {
    const stretch = v.stretch / 100;
    const pitch = pitchRatio(v.semitones, v.cents);
    const flags = (v.lockChannels ? 1 : 0) | (v.formants ? 2 : 0);
    if (v.algorithm === 2) return runTimePitch(dsp, channels, rate, { mode: 2, pitch: 1 / stretch }, { onProgress, signal });
    return runTimePitch(dsp, channels, rate, { mode: v.algorithm === 1 ? 1 : 0, precision: v.precision, stretch, pitch, flags }, { onProgress, signal });
  },
  process: offloaded('stretchPitch'),
});

registerEffect({
  id: 'pitchBender',
  name: 'Pitch Bender',
  group: GROUP,
  kind: null,
  params: [
    { id: 'envelope', label: 'Pitch', type: 'envelope', default: [{ t: 0, v: 0 }, { t: 1, v: 0 }], min: -48, max: 48, unit: 'st' },
    num('range', 'Range', 1, 48, 2, 'st', { step: 1, description: 'Vertical range of the pitch graph' }),
    choice('rangeMode', 'Range In', ['Semitones', 'Tempo'], 0),
    num('bpmRange', 'Tempo Range', 1, 200, 40, 'BPM', { step: 1 }),
    num('tempo', 'At a Tempo Of', 20, 300, 90, 'BPM', { step: 1 }),
    bool('spline', 'Spline Curves', false),
    choice('quality', 'Quality', ['Low', 'Medium', 'High', 'Very High', 'Near Perfect', 'Perfect'], 4, { control: 'select' }),
  ],
  presets: [
    preset('Flat', { envelope: [{ t: 0, v: 0 }, { t: 1, v: 0 }], range: 2 }),
    preset('Rise a Whole Tone', { envelope: [{ t: 0, v: 0 }, { t: 1, v: 2 }], range: 2 }),
    preset('Rise an Octave', { envelope: [{ t: 0, v: 0 }, { t: 1, v: 12 }], range: 12 }),
    preset('Fall an Octave', { envelope: [{ t: 0, v: 0 }, { t: 1, v: -12 }], range: 12 }),
    preset('Tape Stop', { envelope: [{ t: 0, v: 0 }, { t: 0.6, v: -1 }, { t: 1, v: -24 }], range: 24 }),
    preset('Tape Start', { envelope: [{ t: 0, v: -24 }, { t: 0.4, v: -1 }, { t: 1, v: 0 }], range: 24 }),
    preset('Warble', { envelope: [{ t: 0, v: 0 }, { t: 0.25, v: 0.5 }, { t: 0.5, v: -0.5 }, { t: 0.75, v: 0.5 }, { t: 1, v: 0 }], range: 2 }),
  ],
  run: async ({ channels, rate, values: v, dsp, onProgress, signal }) => {
    const range = bendRange(v);
    const curve = envelopeCurve(v.envelope, channels[0].length, (semis) => 2 ** (Math.max(-range, Math.min(range, semis)) / 12), v.spline);
    return runTimePitch(dsp, channels, rate, { mode: 2, precision: BEND_QUALITY[v.quality] ?? 16, pitch: 1, curve }, { onProgress, signal });
  },
  process: offloaded('pitchBender'),
});

registerEffect({
  id: 'manualPitchCorrection',
  name: 'Manual Pitch Correction',
  group: GROUP,
  kind: null,
  params: [
    { id: 'envelope', label: 'Pitch', type: 'envelope', default: [{ t: 0, v: 0 }, { t: 1, v: 0 }], min: -1200, max: 1200, unit: 'ct' },
    choice('precision', 'Precision', PRECISION, 1),
    bool('formants', 'Preserve Formants', true),
    bool('lockChannels', 'Lock Stereo Channels', true),
    bool('spline', 'Spline Curves', false),
  ],
  presets: [
    preset('No Change', { envelope: [{ t: 0, v: 0 }, { t: 1, v: 0 }] }),
    preset('Glide Up a Semitone', { envelope: [{ t: 0, v: 0 }, { t: 1, v: 100 }] }),
    preset('Glide Down a Semitone', { envelope: [{ t: 0, v: 0 }, { t: 1, v: -100 }] }),
    preset('Raise a Quarter Tone', { envelope: [{ t: 0, v: 50 }, { t: 1, v: 50 }] }),
    preset('Lower a Quarter Tone', { envelope: [{ t: 0, v: -50 }, { t: 1, v: -50 }] }),
  ],
  run: async ({ channels, rate, values: v, dsp, onProgress, signal }) => {
    const curve = envelopeCurve(v.envelope, channels[0].length, (cents) => 2 ** (Math.max(-2400, Math.min(2400, cents)) / 1200), v.spline);
    const flags = (v.lockChannels ? 1 : 0) | (v.formants ? 2 : 0);
    return runTimePitch(dsp, channels, rate, { mode: 0, precision: v.precision, stretch: 1, pitch: 1, flags, curve }, { onProgress, signal });
  },
  process: offloaded('manualPitchCorrection'),
});
