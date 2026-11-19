// Effect definitions: Stereo Imagery (WASM kinds 110..112, wasm/dsp/src/fx/stereo).

import { registerEffect } from '../registry.js';
import { num, db, hz, pct, bool, choice, preset, packCurve, dataId } from './util.js';
import { valueAt } from '../envelope.js';
import { fftSize } from './filter-math.js';

const GROUP = 'Stereo Imagery';
const sizes = (list) => list.map((v) => ({ value: v, label: String(v) }));

registerEffect({
  id: 'stereoExpander',
  name: 'Stereo Expander',
  group: GROUP,
  kind: 110,
  params: [
    num('centerPan', 'Center Channel Pan', -100, 100, 0, '', { step: 1, ends: ['Left', 'Right'] }),
    pct('width', 'Stereo Width', 100, { max: 300, ends: ['Narrow', 'Wide'] }),
    db('gain', 'Output Gain', -24, 12, 0),
  ],
  presets: [
    preset('Neutral', {}),
    preset('Wider Image', { width: 160 }),
    preset('Very Wide', { width: 240, gain: -2 }),
    preset('Narrower Image', { width: 60 }),
    preset('Fold to Mono', { width: 0 }),
    preset('Shift Center Left', { centerPan: -35 }),
    preset('Shift Center Right', { centerPan: 35 }),
  ],
});

registerEffect({
  id: 'centerChannelExtractor',
  name: 'Center Channel Extractor',
  group: GROUP,
  kind: 111,
  params: [
    choice('target', 'Extract Audio From', ['Center', 'Left', 'Right', 'Surround', 'Custom'], 0),
    choice('range', 'Frequency Range', ['Full Spectrum', 'Male Voice', 'Female Voice', 'Bass', 'Custom'], 0),
    hz('lowFreq', 'Custom Low', 20, 20000, 100),
    hz('highFreq', 'Custom High', 20, 20000, 8000),
    db('centerLevel', 'Center Channel Level', -48, 40, 0, { section: 'Levels' }),
    db('sideLevel', 'Side Channel Levels', -48, 40, -30, { section: 'Levels' }),
    pct('bleed', 'Crossover Bleed', 20, { section: 'Discrimination' }),
    num('phaseDisc', 'Phase Discrimination', 0, 180, 10, 'deg', { step: 0.5, section: 'Discrimination' }),
    db('ampDisc', 'Amplitude Discrimination', 0, 20, 3, { section: 'Discrimination' }),
    pct('decay', 'Spectral Decay Rate', 70, { max: 99, section: 'Discrimination' }),
    choice('fftSize', 'FFT Size', sizes([1024, 2048, 4096, 8192, 16384]), 4096, { section: 'Advanced' }),
    num('phaseAngle', 'Phase Angle', -360, 360, 0, 'deg', { step: 1, section: 'Custom Position' }),
    num('pan', 'Pan', -100, 100, 0, '%', { step: 1, section: 'Custom Position' }),
    num('delay', 'Delay', -5, 5, 0, 'ms', { step: 0.01, section: 'Custom Position' }),
  ],
  latency: (v) => fftSize(v.fftSize, 512, 16384),
  presets: [
    preset('Default', {}),
    preset('Remove Lead Vocal', { centerLevel: -48, sideLevel: 0, range: 4, lowFreq: 120, highFreq: 9000 }),
    preset('Isolate Lead Vocal', { sideLevel: -48, range: 4, lowFreq: 100, highFreq: 10000 }),
    preset('Karaoke Male Voice', { centerLevel: -48, sideLevel: 0, range: 1 }),
    preset('Karaoke Female Voice', { centerLevel: -48, sideLevel: 0, range: 2 }),
    preset('Lift the Center', { centerLevel: 4, sideLevel: -2 }),
    preset('Extract Out of Phase', { target: 3, sideLevel: -48, phaseDisc: 20 }),
    preset('Keep Bass Center Only', { range: 3, sideLevel: -48 }),
    preset('Remove a Half-Right Source', { target: 4, pan: 50, centerLevel: -48, sideLevel: 0 }),
  ],
});

/** The frequency band a Center Channel Extractor range keeps: [low, high] Hz (mirrors fx/stereo/center.rs RANGES). */
export function extractorBand(v, rate = 48000) {
  const RANGES = [[0, rate / 2], [80, 8000], [150, 10000], [20, 250]];
  const r = RANGES[v.range];
  return r ? [Math.max(0, r[0]), Math.min(rate / 2, r[1])] : [Math.min(v.lowFreq, v.highFreq), Math.max(v.lowFreq, v.highFreq)];
}

const curve = (pts) => pts.map(([f, g]) => ({ f, g }));

/** Position of frequency f on the phase graph's axis (0..1, 20 Hz to 20 kHz). */
export const phaseAxis = (f, log) => (log ? Math.log(Math.max(20, f) / 20) / Math.log(1000) : (f - 20) / (20000 - 20));
const axisFreq = (t, log) => (log ? 20 * 1000 ** t : 20 + t * (20000 - 20));

/**
 * The phase curve the processor gets: the drawn points clamped to the range,
 * or with Spline Curves on, the eased curve the graph draws, sampled densely
 * along the graph's axis (cosine easing between points, like envelopes).
 */
export function phaseCurve(v) {
  const lim = v.range === 360 ? 360 : 180;
  const pts = [...(v.curve || [])].sort((a, b) => a.f - b.f).map((p) => ({ f: p.f, g: Math.max(-lim, Math.min(lim, p.g)) }));
  if (!v.spline || pts.length < 3) return pts;
  const log = v.scale !== 1;
  const env = pts.map((p) => ({ t: phaseAxis(p.f, log), v: p.g }));
  const out = [];
  const n = 128;
  for (let i = 0; i <= n; i++) {
    const t = env[0].t + ((env[env.length - 1].t - env[0].t) * i) / n;
    out.push({ f: Math.round(axisFreq(t, log) * 10) / 10, g: Math.round(valueAt(env, t, true) * 100) / 100 });
  }
  return out;
}

registerEffect({
  id: 'graphicPhaseShifter',
  name: 'Graphic Phase Shifter',
  group: GROUP,
  kind: 112,
  params: [
    choice('channel', 'Channel', ['Left', 'Right', 'Both'], 0),
    choice('fftSize', 'FFT Size', sizes([256, 512, 1024, 2048, 4096, 8192, 16384]), 2048),
    choice('scale', 'Scale', ['Logarithmic', 'Linear'], 0),
    { id: 'curve', label: 'Phase Shift', type: 'curve', default: curve([[20, 0], [20000, 0]]), min: -360, max: 360, unit: 'deg' },
    choice('range', 'Range', [{ value: 180, label: '180\u00b0' }, { value: 360, label: '360\u00b0' }], 180),
    bool('spline', 'Spline Curves', false),
  ],
  latency: (v) => fftSize(v.fftSize, 256, 16384),
  data: (v) => {
    const pts = phaseCurve(v);
    return [{ slot: 0, id: dataId(pts), values: packCurve(pts) }];
  },
  presets: [
    preset('No Shift', {}),
    preset('Quarter Turn Left', { curve: curve([[20, 90], [20000, 90]]) }),
    preset('Invert Lows on Right', { channel: 1, curve: curve([[20, 180], [150, 180], [300, 0], [20000, 0]]) }),
    preset('Gentle Phase Tilt', { channel: 2, curve: curve([[20, 0], [20000, 90]]) }),
    preset('Wide Phase Spread', { curve: curve([[20, 0], [500, 60], [2000, -60], [8000, 60], [20000, 0]]) }),
    preset('Smooth Full Turn', { range: 360, spline: true, curve: curve([[20, 0], [1000, 180], [20000, 360]]) }),
  ],
});
