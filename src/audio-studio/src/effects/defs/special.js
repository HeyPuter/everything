// Effect definitions: Special (Distortion, Guitar Suite, Vocal Enhancer,
// Mastering, Loudness Meter, Doppler Shifter) plus two Diagnostics processes, Delete Silence
// and Mark Audio. Loudness Maximizer is registered with the dynamics effects.
//
// Mark Audio returns `{ channels, markers }`: the audio is unchanged and each
// marker ({ start, duration, name, type }, frames relative to the processed
// range) must be added to the document by the caller.

import { registerEffect, getEffect, paramArray } from '../registry.js';
import { offloaded } from '../offline-fx.js';
import { num, db, hz, pct, bool, choice, preset, pause, checkAbort, dataId, biquadDb } from './util.js';
import { LOUDNESS_STANDARDS } from './loudness-standards.js';
import { detectionWindow, levelsDb, findSilence, removeSilence, audioMarkers } from './special-silence.js';

const SPECIAL = 'Special';

// Oversampler round trip delays (wasm/dsp/src/fx/special/shaper.rs).
const OS2_LATENCY = 23;
const OS4_LATENCY = 27;

// ------------------------------------------------------------- Distortion

const CURVES = ['Clean', 'Soft Saturate', 'Hard Clip', 'Tube Warmth', 'Diode Knee', 'Wave Fold', 'Cut Off', 'Drawn Curve'];

/** Curve choice whose shape comes from the drawn points (fx/special/distortion.rs DRAWN). */
export const DRAWN = 7;
/** Lowest input level of a drawn distortion curve in dB (points run from here to 0 dBFS). */
export const DRAWN_FLOOR = -120;
const UNITY = [{ x: DRAWN_FLOOR, y: DRAWN_FLOOR }, { x: 0, y: 0 }];
/** Octave table layout of a drawn curve (shaper.rs TABLE_OCTAVES, TABLE_STEPS). */
export const TABLE_OCTAVES = 20;
export const TABLE_STEPS = 128;

/** Input magnitude of octave-table entry j: evenly spaced within each octave below full scale. */
export const tableInput = (j) => 2 ** (Math.floor(j / TABLE_STEPS) - TABLE_OCTAVES) * (1 + (j % TABLE_STEPS) / TABLE_STEPS);

/**
 * Octave table for a drawn curve ([{ x: in dB, y: out dB }]): output
 * magnitudes at tableInput(j), as the shaper reads it (shaper.rs
 * TABLE_POS), so quiet levels are shaped as finely as loud ones. Below the
 * first point the curve keeps that point's gain; between points it is
 * straight in dB.
 */
export function drawnCurveTable(points) {
  const pts = [...(points?.length ? points : UNITY)].sort((a, b) => a.x - b.x);
  const n = TABLE_OCTAVES * TABLE_STEPS + 1;
  const out = new Float32Array(n);
  let k = 0;
  for (let j = 0; j < n; j++) {
    const d = 20 * Math.log10(tableInput(j));
    let y;
    if (d <= pts[0].x) y = d + (pts[0].y - pts[0].x);
    else if (d >= pts[pts.length - 1].x) y = pts[pts.length - 1].y;
    else {
      while (k < pts.length - 2 && d > pts[k + 1].x) k++;
      const a = pts[k];
      const b = pts[k + 1];
      y = a.y + ((b.y - a.y) * (d - a.x)) / (b.x - a.x || 1);
    }
    out[j] = 10 ** (y / 20);
  }
  return out;
}

const drawnParam = (id, label) => ({ id, label, type: 'transfer', default: UNITY, min: DRAWN_FLOOR, max: 0, unit: 'dB', hidden: true, extendEnds: true });

registerEffect({
  id: 'distortion',
  name: 'Distortion',
  group: SPECIAL,
  kind: 90,
  params: [
    db('drive', 'Drive', 0, 48, 12),
    choice('positive', 'Positive Curve', CURVES, 1, { section: 'Curves' }),
    choice('negative', 'Negative Curve', CURVES, 1, { section: 'Curves' }),
    bool('symmetric', 'Symmetric', true, { section: 'Curves' }),
    pct('curveSmoothing', 'Curve Smoothing', 0, { section: 'Curves' }),
    pct('timeSmoothing', 'Time Smoothing', 0, { section: 'Curves' }),
    bool('filter', 'Post Filter', false, { section: 'Post Filter' }),
    choice('filterType', 'Filter Type', ['Low Pass', 'High Pass', 'Band Pass'], 0, { section: 'Post Filter' }),
    hz('filterFreq', 'Frequency', 20, 20000, 8000, { section: 'Post Filter' }),
    num('filterQ', 'Q', 0.1, 10, 0.707, '', { step: 0.01, scale: 'log', section: 'Post Filter' }),
    pct('mix', 'Mix', 100),
    db('output', 'Output Gain', -24, 12, 0),
    drawnParam('posCurve', 'Positive Drawn Curve'),
    drawnParam('negCurve', 'Negative Drawn Curve'),
    // The curve graphs' span: the lowest level shown and edited, and linear
    // amplitude axes instead of dB. Below the span a curve keeps its gain.
    num('dbRange', 'dB Range', -120, -12, -60, 'dB', { step: 1 }),
    bool('linearScale', 'Linear Scale', false),
  ],
  latency: () => OS4_LATENCY,
  data: (v) => [
    { slot: 0, id: dataId(v.posCurve), values: drawnCurveTable(v.posCurve) },
    { slot: 1, id: dataId(v.negCurve), values: drawnCurveTable(v.negCurve) },
  ],
  presets: [
    preset('Default', {}),
    preset('Gentle Expander Knee', { drive: 0, positive: DRAWN, symmetric: true, posCurve: [{ x: -60, y: -60 }, { x: -24, y: -24 }, { x: -12, y: -9 }, { x: -6, y: -5 }, { x: 0, y: -3 }] }),
    preset('Gated Fuzz', { drive: 6, positive: DRAWN, symmetric: true, posCurve: [{ x: -60, y: -60 }, { x: -36, y: -60 }, { x: -30, y: -12 }, { x: -12, y: -4 }, { x: 0, y: -2 }], output: -2 }),
    preset('Warm Saturation', { drive: 6, positive: 3, negative: 1, symmetric: false, curveSmoothing: 30 }),
    preset('Gritty Edge', { drive: 18, positive: 4, symmetric: true, output: -4 }),
    preset('Square Fuzz', { drive: 36, positive: 2, symmetric: true, filter: true, filterType: 0, filterFreq: 5000, output: -6 }),
    preset('Half Wave Buzz', { drive: 20, positive: 2, negative: 6, symmetric: false, filter: true, filterType: 1, filterFreq: 200, output: -3 }),
    preset('Lo-Fi Radio', { drive: 24, positive: 2, symmetric: true, filter: true, filterType: 2, filterFreq: 1500, filterQ: 1.2, output: -2 }),
    preset('Folded Synth', { drive: 18, positive: 5, symmetric: true, output: -3 }),
    preset('Smooth Leveling', { drive: 10, positive: 1, symmetric: true, timeSmoothing: 60 }),
  ],
});

// ----------------------------------------------------------- Guitar Suite

registerEffect({
  id: 'guitarSuite',
  name: 'Guitar Suite',
  group: SPECIAL,
  kind: 91,
  params: [
    pct('compressor', 'Compressor', 20, { section: 'Compressor' }),
    choice('distType', 'Distortion Type', ['Clean Boost', 'Overdrive', 'Crunch', 'Fuzz', 'High Gain', 'Folded'], 1, { section: 'Distortion' }),
    pct('distAmount', 'Distortion', 40, { section: 'Distortion' }),
    choice('amp', 'Amplifier', ['None', 'Clean Combo 1x12', 'Vintage Stack 4x12', 'Modern Stack 4x12', 'Bass Cabinet 1x15', 'Practice Amp 1x8', 'Telephone Box'], 1, { section: 'Amplifier' }),
    pct('ampAmount', 'Amplifier Amount', 100, { section: 'Amplifier' }),
    choice('filterType', 'Filter', ['Off', 'Low Pass', 'High Pass', 'Band Pass'], 0, { section: 'Filter' }),
    hz('filterFreq', 'Frequency', 20, 20000, 1500, { section: 'Filter' }),
    pct('resonance', 'Resonance', 20, { section: 'Filter' }),
    pct('mix', 'Mix', 100),
    db('output', 'Output Gain', -24, 12, 0),
    bool('compBypass', 'Bypass Compressor', false, { section: 'Compressor' }),
    bool('distBypass', 'Bypass Distortion', false, { section: 'Distortion' }),
    bool('ampBypass', 'Bypass Amplifier', false, { section: 'Amplifier' }),
    bool('filterBypass', 'Bypass Filter', false, { section: 'Filter' }),
  ],
  latency: () => OS4_LATENCY,
  presets: [
    preset('Default', {}),
    preset('Sparkling Clean', { compressor: 40, distType: 0, distAmount: 20, amp: 1, filterType: 0 }),
    preset('Blues Drive', { compressor: 25, distType: 1, distAmount: 55, amp: 2, output: -2 }),
    preset('Classic Crunch', { compressor: 20, distType: 2, distAmount: 60, amp: 2, output: -4 }),
    preset('Fuzz Box', { compressor: 10, distType: 3, distAmount: 75, amp: 1, filterType: 1, filterFreq: 4000, output: -6 }),
    preset('Modern Metal', { compressor: 30, distType: 4, distAmount: 85, amp: 3, output: -6 }),
    preset('Bass Grit', { compressor: 50, distType: 2, distAmount: 30, amp: 4, mix: 70 }),
    preset('Megaphone Voice', { compressor: 60, distType: 2, distAmount: 35, amp: 6, filterType: 3, filterFreq: 1400, resonance: 30 }),
  ],
});

// --------------------------------------------------------- Vocal Enhancer

registerEffect({
  id: 'vocalEnhancer',
  name: 'Vocal Enhancer',
  group: SPECIAL,
  kind: 92,
  params: [choice('mode', 'Mode', ['Male Voice', 'Female Voice', 'Music'], 0), pct('amount', 'Amount', 100)],
  presets: [
    preset('Low Voice', { mode: 0, amount: 100 }),
    preset('High Voice', { mode: 1, amount: 100 }),
    preset('Music Under Voice', { mode: 2, amount: 100 }),
    preset('Subtle Low Voice', { mode: 0, amount: 50 }),
    preset('Subtle High Voice', { mode: 1, amount: 50 }),
  ],
});

// -------------------------------------------------------------- Mastering

registerEffect({
  id: 'mastering',
  name: 'Mastering',
  group: SPECIAL,
  kind: 93,
  params: [
    bool('lowShelfOn', 'Low Shelf', true, { section: 'Equalizer' }),
    hz('lowShelfFreq', 'Low Shelf Frequency', 20, 2000, 100, { section: 'Equalizer' }),
    db('lowShelfGain', 'Low Shelf Gain', -15, 15, 0, { section: 'Equalizer' }),
    bool('peakOn', 'Peak', true, { section: 'Equalizer' }),
    hz('peakFreq', 'Peak Frequency', 20, 20000, 1000, { section: 'Equalizer' }),
    db('peakGain', 'Peak Gain', -15, 15, 0, { section: 'Equalizer' }),
    num('peakQ', 'Peak Q', 0.1, 10, 1, '', { step: 0.01, scale: 'log', section: 'Equalizer' }),
    bool('highShelfOn', 'High Shelf', true, { section: 'Equalizer' }),
    hz('highShelfFreq', 'High Shelf Frequency', 1000, 20000, 8000, { section: 'Equalizer' }),
    db('highShelfGain', 'High Shelf Gain', -15, 15, 0, { section: 'Equalizer' }),
    pct('reverb', 'Reverb', 0, { section: 'Reverb' }),
    choice('exciterMode', 'Exciter Mode', ['Retro', 'Tape', 'Tube'], 0, { section: 'Exciter' }),
    pct('exciter', 'Exciter', 0, { section: 'Exciter' }),
    num('width', 'Widener', -100, 100, 0, '%', { step: 1, section: 'Widener' }),
    pct('loudness', 'Loudness Maximizer', 0, { section: 'Loudness Maximizer' }),
    db('output', 'Output Gain', -30, 18, 0),
    num('lowShelfQ', 'Low Shelf Q', 0.1, 10, 0.71, '', { step: 0.01, scale: 'log', section: 'Equalizer' }),
    num('highShelfQ', 'High Shelf Q', 0.1, 10, 0.71, '', { step: 0.01, scale: 'log', section: 'Equalizer' }),
  ],
  latency: (v, rate) => OS2_LATENCY + Math.max(1, Math.round(rate / 200)) - 1,
  tail: (v, rate) => (v.reverb > 0 ? Math.round(rate * 2) : 0),
  response(v, freqs, rate) {
    const out = new Float32Array(freqs.length);
    freqs.forEach((f, i) => {
      let d = 0;
      if (v.lowShelfOn) d += biquadDb('low', v.lowShelfFreq, v.lowShelfGain, v.lowShelfQ ?? Math.SQRT1_2, f, rate);
      if (v.peakOn) d += biquadDb('peak', v.peakFreq, v.peakGain, v.peakQ, f, rate);
      if (v.highShelfOn) d += biquadDb('high', v.highShelfFreq, v.highShelfGain, v.highShelfQ ?? Math.SQRT1_2, f, rate);
      out[i] = d;
    });
    return out;
  },
  presets: [
    preset('Flat', {}),
    preset('Gentle Polish', { lowShelfGain: 1.5, peakFreq: 3000, peakGain: 1, highShelfFreq: 10000, highShelfGain: 2, exciter: 15, width: 10, loudness: 30 }),
    preset('Radio Ready', { lowShelfFreq: 80, lowShelfGain: -2, peakFreq: 2500, peakGain: 2, peakQ: 0.8, highShelfGain: 2, exciterMode: 1, exciter: 25, loudness: 70 }),
    preset('Warm Vintage', { lowShelfFreq: 150, lowShelfGain: 2, peakFreq: 4000, peakGain: -1.5, highShelfFreq: 9000, highShelfGain: -2, exciterMode: 2, exciter: 30, loudness: 25 }),
    preset('Wide and Airy', { highShelfFreq: 12000, highShelfGain: 3, reverb: 15, exciterMode: 1, exciter: 20, width: 40, loudness: 20 }),
    preset('Podcast Finish', { lowShelfFreq: 90, lowShelfGain: -4, peakFreq: 300, peakGain: -2, peakQ: 1.2, highShelfFreq: 6000, highShelfGain: 2, width: -100, loudness: 50 }),
    preset('Loud and Bright', { lowShelfGain: 2, peakFreq: 3500, peakGain: 1.5, highShelfGain: 3, exciter: 35, width: 15, loudness: 100 }),
  ],
});

// -------------------------------------------------------- Doppler Shifter

// --------------------------------------------------------- Loudness Meter

// Passes audio through unchanged and measures it while it plays (kind 94,
// wasm/dsp/src/fx/special/meter.rs); its dialog shows the readout live. The
// parameters steer only the display (target marker, scale, peak warning).
registerEffect({
  id: 'loudnessMeter',
  name: 'Loudness Meter',
  group: SPECIAL,
  kind: 94,
  readout: true,
  measureOnly: true,
  display: 'loudness',
  params: [
    num('target', 'Target Loudness', -40, -5, -23, 'LUFS', { step: 0.5 }),
    num('peakCeiling', 'True Peak Ceiling', -12, 0, -1, 'dBTP', { step: 0.1 }),
    choice('scale', 'Meter Scale', ['+9 LU (EBU)', '+18 LU (EBU)'], 0),
    choice('standard', 'Loudness Standard', LOUDNESS_STANDARDS.map((x) => x.label), 0),
    choice('units', 'Loudness Units', ['LUFS (absolute)', 'LU (relative to the target)'], 0),
  ],
  presets: [
    preset('Broadcast (EBU R128)', { target: -23, peakCeiling: -1, scale: 0, standard: 0 }),
    preset('Broadcast (ATSC A/85)', { target: -24, peakCeiling: -2, scale: 0, standard: 1 }),
    preset('Podcast', { target: -16, peakCeiling: -1, scale: 0, standard: 3 }),
    preset('Music Streaming', { target: -14, peakCeiling: -1, scale: 1, standard: 2 }),
    preset('Film Dialogue', { target: -27, peakCeiling: -2, scale: 1, standard: 4 }),
  ],
});

/** Listening position of channel c for the Doppler Shifter: -1 left, 0 centre, 1 right (5.1: L R C LFE Ls Rs). */
function dopplerEar(c, count) {
  if (count === 1) return 0;
  if (count === 6) return [-1, 1, 0, 0, -1, 1][c];
  return c === 0 ? -1 : c === 1 ? 1 : 0;
}

registerEffect({
  id: 'dopplerShifter',
  name: 'Doppler Shifter',
  group: SPECIAL,
  kind: null,
  params: [
    choice('path', 'Path Type', ['Straight Line', 'Circular'], 0),
    num('startDistance', 'Starting Distance Away', 1, 200, 30, 'm', { step: 0.1, section: 'Straight Line' }),
    num('velocity', 'Velocity', 1, 100, 20, 'm/s', { step: 0.1 }),
    num('comingFrom', 'Coming From', -180, 180, -90, 'deg', { step: 1, section: 'Straight Line' }),
    num('passFront', 'Passes in Front By', -50, 50, 5, 'm', { step: 0.1, section: 'Straight Line' }),
    num('passRight', 'Passes on Right By', -50, 50, 0, 'm', { step: 0.1, section: 'Straight Line' }),
    num('radius', 'Radius', 1, 100, 10, 'm', { step: 0.1, section: 'Circular' }),
    num('startAngle', 'Starting Angle', -180, 180, 0, 'deg', { step: 1, section: 'Circular' }),
    num('centerFront', 'Center in Front By', -50, 50, 0, 'm', { step: 0.1, section: 'Circular' }),
    num('centerRight', 'Center on Right By', -50, 50, 0, 'm', { step: 0.1, section: 'Circular' }),
    bool('distanceVolume', 'Adjust Volume Based on Distance', true),
    bool('directionVolume', 'Adjust Volume Based on Direction', true),
    choice('quality', 'Quality', ['Low', 'Normal', 'High', 'Highest'], 2),
  ],
  presets: [
    preset('Passing Car', { path: 0, startDistance: 40, velocity: 25, comingFrom: -90, passFront: 6 }),
    preset('Fast Flyby', { path: 0, startDistance: 80, velocity: 90, comingFrom: -60, passFront: 15, passRight: 0 }),
    preset('Slow Walk Past', { path: 0, startDistance: 8, velocity: 1.5, comingFrom: 90, passFront: 1.5 }),
    preset('Distant Train', { path: 0, startDistance: 150, velocity: 30, comingFrom: -90, passFront: 40, quality: 3 }),
    preset('Orbit Around the Head', { path: 1, radius: 3, velocity: 6, startAngle: 0, distanceVolume: false }),
    preset('Wide Carousel', { path: 1, radius: 15, velocity: 12, startAngle: -90, centerFront: 10 }),
  ],
  async run({ channels, rate, values, dsp, onProgress, signal }) {
    const params = Float32Array.from(paramArray(getEffect('dopplerShifter'), values));
    const p = dsp.copyIn(params);
    const len = channels[0].length;
    const out = [];
    try {
      for (let c = 0; c < channels.length; c++) {
        checkAbort(signal);
        const ear = dopplerEar(c, channels.length);
        const src = dsp.copyIn(channels[c]);
        const dst = dsp.floats(len);
        dsp.x.special_doppler(src.ptr, len, rate, ear, p.ptr, params.length, dst.ptr);
        out.push(dst.view().slice());
        src.free();
        dst.free();
        onProgress?.((c + 1) / channels.length);
        await pause();
      }
    } finally {
      p.free();
    }
    return out;
  },
  process: offloaded('dopplerShifter'),
});

// ------------------------------------------------------------ Diagnostics

const DIAG = 'Diagnostics';

const detectionParams = (o) => [
  db('silenceThreshold', 'Silence Below', -100, 0, o.silenceThreshold, { section: 'Silence' }),
  num('silenceMin', 'Silence For At Least', 10, 10000, o.silenceMin, 'ms', { step: 1, scale: 'log', section: 'Silence' }),
  db('audioThreshold', 'Audio Above', -100, 0, o.audioThreshold, { section: 'Audio' }),
  num('audioMin', 'Audio For At Least', 1, 2000, o.audioMin, 'ms', { step: 1, scale: 'log', section: 'Audio' }),
];

function detect(dsp, channels, rate, values) {
  const win = detectionWindow(rate);
  const levels = levelsDb(dsp, channels, win);
  return findSilence(levels, win, rate, channels[0].length, values);
}

registerEffect({
  id: 'deleteSilence',
  name: 'Delete Silence',
  group: DIAG,
  kind: null,
  params: [...detectionParams({ silenceThreshold: -40, silenceMin: 500, audioThreshold: -36, audioMin: 20 }), num('keep', 'Shorten Silence To', 0, 5000, 200, 'ms', { step: 1 })],
  presets: [
    preset('Default', {}),
    preset('Trim Long Pauses', { silenceThreshold: -45, silenceMin: 1000, keep: 300 }),
    preset('Tight Dialogue', { silenceThreshold: -40, silenceMin: 300, keep: 150 }),
    preset('Remove All Gaps', { silenceMin: 100, keep: 0 }),
    preset('Noisy Room', { silenceThreshold: -30, silenceMin: 600, audioThreshold: -26, keep: 250 }),
  ],
  async run({ channels, rate, values, dsp, onProgress }) {
    const silences = detect(dsp, channels, rate, values);
    onProgress?.(0.5);
    const out = removeSilence(channels, silences, Math.round((values.keep * rate) / 1000));
    onProgress?.(1);
    return out;
  },
  process: offloaded('deleteSilence'),
});

registerEffect({
  id: 'markAudio',
  name: 'Mark Audio',
  group: DIAG,
  kind: null,
  params: [...detectionParams({ silenceThreshold: -40, silenceMin: 300, audioThreshold: -36, audioMin: 50 }), num('padding', 'Marker Padding', 0, 2000, 50, 'ms', { step: 1 })],
  presets: [
    preset('Default', {}),
    preset('Speech Phrases', { silenceThreshold: -42, silenceMin: 250, audioMin: 80, padding: 80 }),
    preset('Separate Songs', { silenceThreshold: -50, silenceMin: 2000, audioThreshold: -45, audioMin: 1000, padding: 0 }),
    preset('Sound Effect Hits', { silenceThreshold: -45, silenceMin: 100, audioThreshold: -35, audioMin: 10, padding: 20 }),
  ],
  async run({ channels, rate, values, dsp, onProgress }) {
    const silences = detect(dsp, channels, rate, values);
    const markers = audioMarkers(silences, channels[0].length, Math.round((values.padding * rate) / 1000));
    onProgress?.(1);
    return { channels, markers };
  },
  process: offloaded('markAudio'),
});
