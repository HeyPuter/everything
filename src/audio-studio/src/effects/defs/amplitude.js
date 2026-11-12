// Effect definitions: Amplitude and Compression (plus the Loudness Maximizer
// from Special, which shares the limiter core). Realtime processors live in
// wasm/dsp/src/fx/dynamics (kinds 30..38); Normalize, Fade Envelope and Gain
// Envelope are offline processes.
//
// Dynamics processors also expose `transfer(values, inputDb) => outputDb`, the
// static input/output curve, so dialogs can draw a transfer graph.

import { registerEffect } from '../registry.js';
import { offloaded } from '../offline-fx.js';
import { num, db, hz, ms, pct, bool, choice, section, preset, checkAbort, pause, dataId } from './util.js';
import { curveOutput, splineOutput } from './transfer-curve.js';

export { curveOutput, splineOutput };

const AMP = 'Amplitude and Compression';

// ------------------------------------------------------------------ helpers

/** Rust `ms_frames` in f32 arithmetic, so latency matches the WASM report. */
function msFrames(msValue, rate) {
  const f = Math.fround(Math.fround(Math.fround(Math.max(0, msValue)) * Math.fround(0.001)) * Math.fround(rate));
  return Math.round(f);
}

/** Latency of util::Limiter with a 10 ms maximum lookahead. */
function limiterLatency(lookMs, rate) {
  const max = Math.max(1, msFrames(20, rate));
  const look = Math.min(Math.max(msFrames(Math.min(Math.max(lookMs, 0.1), 20), rate), 1), max);
  return look - 1;
}

/** Frames the Hard Limiter's true-peak detector adds (fx/dynamics/limiter.rs TP_DELAY). */
const TRUE_PEAK_DELAY = 8;

/** util::compress_db */
export function compressDb(level, threshold, ratio, knee = 0) {
  const slope = 1 / Math.max(1, ratio) - 1;
  const over = level - threshold;
  if (knee > 0 && 2 * Math.abs(over) <= knee) {
    const t = over + knee / 2;
    return (slope * t * t) / (2 * knee);
  }
  return over > 0 ? slope * over : 0;
}

/** util::expand_db */
export function expandDb(level, threshold, ratio, knee = 0) {
  const slope = Math.max(1, ratio) - 1;
  const under = threshold - level;
  if (knee > 0 && 2 * Math.abs(under) <= knee) {
    const t = under + knee / 2;
    return (-slope * t * t) / (2 * knee);
  }
  return under > 0 ? -slope * under : 0;
}

const attack = (def, o = {}) => ms('attack', 'Attack Time', 0.1, 500, def, { scale: 'log', ...o });
const release = (def, o = {}) => ms('release', 'Release Time', 1, 5000, def, { scale: 'log', ...o });

// ------------------------------------------------------------- Hard Limiter

registerEffect({
  id: 'hardLimiter',
  name: 'Hard Limiter',
  group: AMP,
  kind: 30,
  about: 'Keeps peaks under a ceiling without audible clipping, looking ahead so it can turn the level down just before each peak. True Peak also catches peaks that fall between samples.',
  params: [
    db('ceiling', 'Maximum Amplitude', -100, 0, -0.1),
    db('inputBoost', 'Input Boost', -100, 48, 0),
    ms('lookahead', 'Look-Ahead Time', 0.5, 20, 5),
    release(80, { min: 10, max: 1000 }),
    bool('link', 'Link Channels', true),
    choice('truePeak', 'Detection', ['Peak', 'True Peak'], 0, { order: -1 }),
  ],
  presets: [
    preset('Default', { ceiling: -0.1, inputBoost: 0, lookahead: 5, release: 80, link: true }),
    preset('Transparent Peak Catch', { ceiling: -0.3, inputBoost: 0, lookahead: 7, release: 150, link: true }),
    preset('Broadcast Safe -1 dB', { ceiling: -1, inputBoost: 0, lookahead: 5, release: 100, link: true }),
    preset('Streaming True Peak -1 dB', { ceiling: -1, inputBoost: 0, lookahead: 5, release: 100, link: true, truePeak: 1 }),
    preset('Gentle Lift +3 dB', { ceiling: -0.5, inputBoost: 3, lookahead: 7, release: 200, link: true }),
    preset('Loud and Tight +6 dB', { ceiling: -0.1, inputBoost: 6, lookahead: 4, release: 50, link: true }),
    preset('Dialogue -2 dB Ceiling', { ceiling: -2, inputBoost: 4, lookahead: 5, release: 120, link: true }),
  ],
  latency: (v, rate) => limiterLatency(v.lookahead, rate) + (v.truePeak ? TRUE_PEAK_DELAY : 0),
  transfer: (v, inDb) => Math.min(inDb + v.inputBoost, v.ceiling),
});

// --------------------------------------------------- Single-band Compressor

registerEffect({
  id: 'singleBandCompressor',
  name: 'Single-band Compressor',
  group: AMP,
  kind: 31,
  about: 'Turns down levels above the threshold by the ratio, smoothing the change with the attack and release times. Output gain makes up the lost level.',
  params: [
    db('threshold', 'Threshold', -60, 0, -20),
    num('ratio', 'Ratio', 1, 30, 4, ':1', { step: 0.1 }),
    attack(10),
    release(100),
    db('outputGain', 'Output Gain', -30, 30, 0),
    db('knee', 'Knee Width', 0, 24, 6),
    choice('detection', 'Detection', ['Peak', 'RMS'], 0),
    bool('link', 'Link Channels', true),
  ],
  presets: [
    preset('Default', { threshold: -20, ratio: 4, attack: 10, release: 100, outputGain: 0, knee: 6, detection: 0, link: true }),
    preset('Gentle Glue', { threshold: -18, ratio: 2, attack: 30, release: 300, outputGain: 2, knee: 12, detection: 1, link: true }),
    preset('Steady Voice', { threshold: -24, ratio: 3, attack: 5, release: 150, outputGain: 5, knee: 8, detection: 1, link: true }),
    preset('Punchy Drums', { threshold: -20, ratio: 5, attack: 25, release: 80, outputGain: 4, knee: 3, detection: 0, link: true }),
    preset('Bass Control', { threshold: -22, ratio: 4, attack: 15, release: 200, outputGain: 3, knee: 6, detection: 1, link: true }),
    preset('Heavy Squash', { threshold: -35, ratio: 12, attack: 1, release: 60, outputGain: 12, knee: 2, detection: 0, link: true }),
  ],
  transfer: (v, inDb) => inDb + compressDb(inDb, v.threshold, v.ratio, v.knee) + v.outputGain,
});

// ----------------------------------------------------------------- Dynamics

registerEffect({
  id: 'dynamics',
  name: 'Dynamics',
  group: AMP,
  kind: 32,
  about: 'A channel-strip dynamics section: a gate that closes on quiet passages, a compressor and an expander sharing one detector, and a limiter that holds the result under its threshold.',
  params: [
    bool('gateOn', 'AutoGate', false, { section: 'AutoGate' }),
    db('gateThreshold', 'Gate Threshold', -80, 0, -50, { section: 'AutoGate', short: 'Threshold' }),
    ms('gateAttack', 'Gate Attack', 0.1, 100, 2, { scale: 'log', section: 'AutoGate', short: 'Attack' }),
    ms('gateRelease', 'Gate Release', 1, 2000, 200, { scale: 'log', section: 'AutoGate', short: 'Release' }),
    ms('gateHold', 'Gate Hold', 0, 1000, 50, { section: 'AutoGate', short: 'Hold' }),
    bool('compOn', 'Compressor', true, { section: 'Compressor' }),
    db('threshold', 'Compressor Threshold', -60, 0, -20, { section: 'Compressor', short: 'Threshold' }),
    num('ratio', 'Compressor Ratio', 1, 30, 3, ':1', { step: 0.1, section: 'Compressor', short: 'Ratio' }),
    db('knee', 'Compressor Knee', 0, 24, 6, { section: 'Compressor', short: 'Knee' }),
    bool('expOn', 'Expander', false, { section: 'Expander' }),
    db('expThreshold', 'Expander Threshold', -80, 0, -45, { section: 'Expander', short: 'Threshold' }),
    num('expRatio', 'Expander Ratio', 1, 30, 2, ':1', { step: 0.1, section: 'Expander', short: 'Ratio' }),
    bool('limOn', 'Limiter', false, { section: 'Limiter' }),
    db('limThreshold', 'Limiter Threshold', -30, 0, -1, { section: 'Limiter', short: 'Threshold' }),
    // Attack and release shape the compressor and expander together.
    attack(5, { section: 'Compressor', short: 'Attack' }),
    release(150, { section: 'Compressor', short: 'Release' }),
    choice('detection', 'Detection', ['Peak', 'RMS'], 0, { section: 'Settings' }),
    bool('link', 'Link Channels', true, { section: 'Settings' }),
    db('makeup', 'Make-up Gain', -30, 30, 0, { section: 'Compressor', short: 'Make-up' }),
    ms('limRelease', 'Limiter Release', 1, 1000, 60, { scale: 'log', section: 'Limiter', short: 'Release' }),
  ],
  readout: true,
  display: 'none',
  layout: {
    wide: true,
    columns: [['AutoGate'], ['Compressor'], ['Expander', 'Limiter']],
    knobs: ['AutoGate', 'Compressor', 'Expander', 'Limiter'],
    meters: {
      AutoGate: [{ index: 0, label: 'Open', kind: 'gate' }],
      Compressor: [{ index: 1, label: 'Reduction', kind: 'gr', min: -24 }],
      Expander: [{ index: 2, label: 'Reduction', kind: 'gr', min: -36 }],
      Limiter: [{ index: 3, label: 'Limiting', kind: 'gr', min: -12 }],
    },
  },
  presets: [
    preset('Default', {}),
    preset('Clean Up Room Noise', { gateOn: true, gateThreshold: -48, gateAttack: 1, gateRelease: 250, gateHold: 80, compOn: true, threshold: -22, ratio: 2.5 }),
    preset('Broadcast Voice', { gateOn: true, gateThreshold: -55, compOn: true, threshold: -24, ratio: 4, knee: 8, limOn: true, limThreshold: -1, attack: 3, release: 120, detection: 1, makeup: 6 }),
    preset('Tight Drums', { gateOn: true, gateThreshold: -35, gateAttack: 0.2, gateRelease: 60, gateHold: 20, compOn: true, threshold: -18, ratio: 4, attack: 15, release: 80 }),
    preset('Soft Expansion', { compOn: false, expOn: true, expThreshold: -40, expRatio: 1.8, release: 300 }),
    preset('Leveled and Limited', { compOn: true, threshold: -26, ratio: 3, knee: 10, limOn: true, limThreshold: -3, detection: 1, makeup: 8 }),
  ],
  transfer: (v, inDb) => {
    let g = 0;
    if (v.compOn) g += compressDb(inDb, v.threshold, v.ratio, v.knee);
    if (v.expOn) g += expandDb(inDb, v.expThreshold, v.expRatio, 3);
    let out = inDb + g + v.makeup;
    if (v.limOn) out = Math.min(out, v.limThreshold);
    if (v.gateOn && inDb < v.gateThreshold) out = -Infinity;
    return out;
  },
});

// ------------------------------------------------------ Dynamics Processing

/** Transfer curve points from [input dB, output dB] pairs. */
const curvePts = (list) => list.map(([x, y]) => ({ x, y }));

/** The transfer curve as the processor gets it: the points, or the spline sampled every 0.5 dB. */
export function transferPoints(values) {
  const pts = [...(values.curve || COMP_3)].sort((a, b) => a.x - b.x);
  if (!values.spline || pts.length < 3) return pts;
  const out = [];
  for (let x = pts[0].x; x < pts[pts.length - 1].x; x += 0.5) out.push({ x, y: splineOutput(pts, x) });
  out.push(pts[pts.length - 1]);
  return out;
}

const COMP_3 = curvePts([[-100, -100], [-20, -20], [0, -13.3]]);

registerEffect({
  id: 'dynamicsProcessing',
  name: 'Dynamics Processing',
  group: AMP,
  kind: 39,
  readout: true,
  display: 'dynamicsProcessing',
  about: 'Shapes dynamics with a drawn curve from input level to output level: flatten it above a level to compress or limit, steepen it below a level to expand or gate. The dot shows the level passing through while you preview.',
  layout: { tabs: [{ label: 'Dynamics', editor: true, sections: ['Output'] }, { label: 'Settings', sections: ['Detector', 'Detector Band'] }] },
  params: [
    { id: 'curve', label: 'Transfer Curve', type: 'transfer', min: -100, max: 0, unit: 'dB', hidden: true, default: COMP_3 },
    choice('detection', 'Detection', ['Peak', 'RMS'], 0, { section: 'Detector' }),
    attack(2, { section: 'Detector' }),
    release(120, { section: 'Detector' }),
    ms('lookahead', 'Look-Ahead Time', 0, 20, 2, { section: 'Detector' }),
    bool('link', 'Link Channels', true, { section: 'Detector' }),
    bool('bandLimit', 'Band Limit Detector', false, { section: 'Detector Band' }),
    hz('lowCut', 'Low Cut', 20, 20000, 100, { section: 'Detector Band', enabledIf: (v) => v.bandLimit }),
    hz('highCut', 'High Cut', 20, 20000, 10000, { section: 'Detector Band', enabledIf: (v) => v.bandLimit }),
    db('makeup', 'Make-up Gain', -30, 30, 0, { section: 'Output' }),
    bool('spline', 'Spline Curves', false, { hidden: true }),
  ],
  presets: [
    preset('Compressor 3:1', { curve: COMP_3, detection: 0, attack: 2, release: 120, lookahead: 2, bandLimit: false, makeup: 0 }),
    preset('Gentle Compressor 2:1', { curve: curvePts([[-100, -100], [-30, -30], [0, -15]]), detection: 1, attack: 10, release: 250, lookahead: 2, bandLimit: false, makeup: 4 }),
    preset('Limiter -1 dB', { curve: curvePts([[-100, -100], [-1, -1], [0, -1]]), detection: 0, attack: 0.1, release: 80, lookahead: 5, bandLimit: false, makeup: 0 }),
    preset('Expander 1:2', { curve: curvePts([[-100, -100], [-70, -100], [-40, -40], [0, 0]]), detection: 1, attack: 2, release: 200, lookahead: 2, bandLimit: false, makeup: 0 }),
    preset('Noise Gate -50 dB', { curve: curvePts([[-100, -100], [-51, -100], [-50, -50], [0, 0]]), detection: 0, attack: 0.5, release: 150, lookahead: 3, bandLimit: false, makeup: 0 }),
    preset('De-Esser Band', { curve: curvePts([[-100, -100], [-32, -32], [0, -24]]), detection: 0, attack: 0.5, release: 60, lookahead: 2, bandLimit: true, lowCut: 4500, highCut: 10000, makeup: 0 }),
    preset('Lift Quiet Passages', { curve: curvePts([[-100, -100], [-70, -70], [-50, -40], [-20, -20], [0, 0]]), detection: 1, attack: 20, release: 400, lookahead: 2, bandLimit: false, makeup: 0 }),
    preset('Broadcast Squash', { curve: curvePts([[-100, -100], [-60, -60], [-30, -24], [-12, -12], [0, -8]]), detection: 1, attack: 5, release: 150, lookahead: 4, bandLimit: true, lowCut: 80, highCut: 12000, makeup: 4 }),
  ],
  latency: (v, rate) => msFrames(Math.min(20, Math.max(0, v.lookahead)), rate),
  transfer: (v, inDb) => (v.spline ? splineOutput(v.curve, inDb) : curveOutput(v.curve, inDb)) + v.makeup,
  data(values) {
    const pts = transferPoints(values);
    return [{ slot: 0, id: dataId(pts), values: Float32Array.from(pts.flatMap((p) => [p.x, p.y])) }];
  },
});

// ----------------------------------------------------- Multiband Compressor

const BAND_NAMES = ['Low', 'Low Mid', 'High Mid', 'High'];
const BAND_TIMES = [
  [10, 250],
  [5, 150],
  [3, 100],
  [1, 80],
];

// Band settings live in the band strips of the dialog's editor (dyn-editors.js).
const bandParams = BAND_NAMES.flatMap((name, b) =>
  section(`${name} Band`, `band${b + 1}`, [
    db('threshold', `${name} Threshold`, -60, 0, -18),
    db('gain', `${name} Gain`, -18, 18, 0),
    num('ratio', `${name} Ratio`, 1, 30, 2, ':1', { step: 0.1 }),
    ms('attack', `${name} Attack`, 0.1, 500, BAND_TIMES[b][0], { scale: 'log' }),
    ms('release', `${name} Release`, 1, 5000, BAND_TIMES[b][1], { scale: 'log' }),
    bool('solo', `Solo ${name}`, false),
    bool('bypass', `Bypass ${name}`, false),
  ]).map((p) => ({ ...p, hidden: true })),
);

/** Multiband preset values from per-band [threshold, gain, ratio] triples. */
function bands(list, extra = {}) {
  const out = {};
  list.forEach(([t, g, r], b) => {
    out[`band${b + 1}Threshold`] = t;
    out[`band${b + 1}Gain`] = g;
    out[`band${b + 1}Ratio`] = r;
  });
  return { ...out, ...extra };
}

registerEffect({
  id: 'multibandCompressor',
  name: 'Multiband Compressor',
  group: AMP,
  kind: 33,
  params: [
    hz('xover1', 'Low Crossover', 20, 20000, 120, { hidden: true }),
    hz('xover2', 'Mid Crossover', 20, 20000, 2000, { hidden: true }),
    hz('xover3', 'High Crossover', 20, 20000, 10000, { hidden: true }),
    ...bandParams,
    db('outputGain', 'Output Gain', -18, 18, 0, { section: 'Output' }),
    bool('limiter', 'Limiter', true, { section: 'Limiter' }),
    db('limThreshold', 'Threshold', -30, 0, 0, { section: 'Limiter' }),
    db('limMargin', 'Margin', -30, 0, -0.1, { section: 'Limiter' }),
    ms('limRelease', 'Release', 10, 1000, 100, { scale: 'log', section: 'Limiter', order: 2 }),
    bool('brickwall', 'Brickwall Limiter', true, { section: 'Options', enabledIf: (v) => v.limiter }),
    bool('link', 'Link Channels', true, { section: 'Options' }),
    // Brickwall: how far the limiter looks ahead; otherwise how fast its gain falls.
    ms('limAttack', 'Attack', 0.1, 50, 5, { scale: 'log', section: 'Limiter', order: 1 }),
    // Dialog settings the processor ignores: moving one band's setting moves the others
    // by the same amount, and the live input spectrum behind the crossover graph.
    bool('linkBands', 'Link Band Controls', false, { section: 'Options' }),
    bool('spectrum', 'Spectrum on Input', false, { section: 'Options' }),
  ],
  readout: true,
  display: 'multiband',
  about: 'Splits the audio into four bands at the crossover frequencies and compresses each on its own, then limits the sum. Drag the crossover lines, solo a band to hear it alone, or bypass it to leave it untouched.',
  layout: { wide: true, columns: [['Output'], ['Limiter'], ['Options']] },
  presets: [
    preset('Default', {}),
    preset('Gentle Master Polish', bands([[-20, 0, 1.5], [-18, 0, 1.5], [-18, 0.5, 1.5], [-20, 1, 1.5]], { limThreshold: -3, limMargin: -0.3 })),
    preset('Tame Low End', bands([[-28, 0, 4], [-18, 0, 1], [-18, 0, 1], [-18, 0, 1]], { xover1: 150 })),
    preset('Clear Speech', bands([[-30, -3, 3], [-22, 1, 2.5], [-20, 2, 2], [-24, 0, 2.5]], { xover1: 100, xover2: 1500, xover3: 7000, limThreshold: -4, limMargin: -1 })),
    preset('Loud Broadcast', bands([[-24, 1, 3], [-24, 0, 3], [-24, 1, 3], [-26, 1, 3]], { limThreshold: -8, limMargin: -1 })),
    preset('Soften Harsh Highs', bands([[-18, 0, 1], [-18, 0, 1], [-26, 0, 3], [-30, -1, 4]], { xover2: 2500, xover3: 7500 })),
  ],
  latency: (v, rate) => (v.limiter && v.brickwall ? Math.min(Math.max(1, msFrames(Math.min(50, Math.max(0.1, v.limAttack ?? 5)), rate)), Math.max(1, msFrames(50, rate))) - 1 : 0),
});

// ---------------------------------------------------------- Tube Compressor

registerEffect({
  id: 'tubeCompressor',
  name: 'Tube-modeled Compressor',
  group: AMP,
  kind: 34,
  about: 'A compressor with the soft, rounded saturation of a tube stage. Drive adds harmonics; Character makes the saturation asymmetric for a warmer, even-order color.',
  params: [
    db('threshold', 'Threshold', -60, 0, -20),
    num('ratio', 'Ratio', 1, 30, 3, ':1', { step: 0.1 }),
    attack(20),
    release(250),
    db('outputGain', 'Output Gain', -30, 30, 0),
    db('drive', 'Drive', 0, 24, 6),
    pct('character', 'Character', 30),
  ],
  readout: true,
  layout: {
    meters: {
      main: [
        { index: 0, label: 'Input', kind: 'level' },
        { index: 1, label: 'Reduction', kind: 'gr', min: -24 },
        { index: 2, label: 'Output', kind: 'level' },
      ],
    },
  },
  presets: [
    preset('Default', { threshold: -20, ratio: 3, attack: 20, release: 250, outputGain: 0, drive: 6, character: 30 }),
    preset('Warm Vocal', { threshold: -22, ratio: 2.5, attack: 15, release: 200, outputGain: 3, drive: 8, character: 40 }),
    preset('Vintage Bus', { threshold: -16, ratio: 2, attack: 30, release: 400, outputGain: 2, drive: 4, character: 25 }),
    preset('Gritty Bass', { threshold: -24, ratio: 5, attack: 10, release: 150, outputGain: 4, drive: 16, character: 60 }),
    preset('Clean Leveling', { threshold: -20, ratio: 3, attack: 20, release: 250, outputGain: 3, drive: 0, character: 0 }),
  ],
  transfer: (v, inDb) => inDb + compressDb(inDb, v.threshold, v.ratio, 10) + v.outputGain,
});

// ------------------------------------------------------------------ DeEsser

registerEffect({
  id: 'deesser',
  name: 'DeEsser',
  group: AMP,
  kind: 35,
  readout: true,
  display: 'deesser',
  about: 'Turns down harsh "s" and "sh" sounds. The detector listens to the shaded band; in Multiband mode only that band is reduced, in Broadband mode the whole signal is. Output Sibilance Only lets you hear what is being removed.',
  params: [
    choice('mode', 'Mode', ['Broadband', 'Multiband'], 1),
    hz('frequency', 'Center Frequency', 1000, 16000, 6500),
    hz('bandwidth', 'Bandwidth', 100, 10000, 3000),
    db('threshold', 'Threshold', -80, 0, -30),
    db('reduction', 'Maximum Reduction', 0, 40, 12),
    bool('sibilanceOnly', 'Output Sibilance Only', false),
  ],
  presets: [
    preset('Default', { mode: 1, frequency: 6500, bandwidth: 3000, threshold: -30, reduction: 12, sibilanceOnly: false }),
    preset('Low Voice Sibilance', { mode: 1, frequency: 4800, bandwidth: 2500, threshold: -32, reduction: 10 }),
    preset('High Voice Sibilance', { mode: 1, frequency: 7800, bandwidth: 3500, threshold: -30, reduction: 12 }),
    preset('Gentle Broadband', { mode: 0, frequency: 6500, bandwidth: 4000, threshold: -26, reduction: 6 }),
    preset('Strong Ess Control', { mode: 1, frequency: 6000, bandwidth: 5000, threshold: -40, reduction: 20 }),
  ],
});

// ---------------------------------------------------- Speech Volume Leveler

registerEffect({
  id: 'speechVolumeLeveler',
  name: 'Speech Volume Leveler',
  group: AMP,
  kind: 36,
  display: 'none',
  about: 'Rides the level of speech toward a target, slowly enough to sound natural. Passages further below the target than the dynamic range are treated as background and left alone unless Boost Low Signals is on.',
  params: [
    db('target', 'Target Volume Level', -40, 0, -18),
    pct('amount', 'Leveling Amount', 60),
    bool('gate', 'Noise Gate', true, { section: 'Advanced' }),
    db('gateThreshold', 'Noise Gate Threshold', -80, -20, -50, { section: 'Advanced', enabledIf: (v) => v.gate }),
    ms('attack', 'Attack Time', 10, 2000, 300, { scale: 'log', section: 'Advanced' }),
    ms('release', 'Release Time', 100, 10000, 1500, { scale: 'log', section: 'Advanced' }),
    db('maxBoost', 'Maximum Boost', 0, 36, 15, { section: 'Advanced' }),
    db('maxCut', 'Maximum Cut', 0, 36, 15, { section: 'Advanced' }),
    db('dynamicRange', 'Target Dynamic Range', 10, 80, 45, { step: 1, enabledIf: (v) => !v.boostLow }),
    bool('boostLow', 'Boost Low Signals', false),
  ],
  layout: { collapsed: ['Advanced'] },
  presets: [
    preset('Default', {}),
    preset('Podcast Conversation', { target: -16, amount: 75, gate: true, gateThreshold: -48, attack: 250, release: 1200 }),
    preset('Quiet Lecture Room', { target: -18, amount: 90, gate: true, gateThreshold: -55, maxBoost: 24, release: 2000 }),
    preset('Light Touch', { target: -20, amount: 35, gate: true, gateThreshold: -50, attack: 500, release: 2500 }),
    preset('Phone Interview', { target: -16, amount: 80, gate: true, gateThreshold: -42, maxBoost: 20, attack: 200, release: 900 }),
  ],
});

// ------------------------------------------------------------ Channel Mixer

registerEffect({
  id: 'channelMixer',
  name: 'Channel Mixer',
  group: AMP,
  kind: 37,
  about: 'Builds each output channel from a mix of the input channels. Negative amounts invert that input; 100 % on its own channel leaves a channel unchanged.',
  params: [
    pct('lToL', 'L', 100, { min: -200, max: 200, section: 'Left Output' }),
    pct('rToL', 'R', 0, { min: -200, max: 200, section: 'Left Output' }),
    bool('invertL', 'Invert Left Output', false, { section: 'Left Output' }),
    pct('lToR', 'L', 0, { min: -200, max: 200, section: 'Right Output' }),
    pct('rToR', 'R', 100, { min: -200, max: 200, section: 'Right Output' }),
    bool('invertR', 'Invert Right Output', false, { section: 'Right Output' }),
  ],
  // One page per output channel, each mixing the input channels into it.
  layout: { tabs: [{ label: 'L', sections: ['Left Output'] }, { label: 'R', sections: ['Right Output'] }] },
  presets: [
    preset('Default', { lToL: 100, rToL: 0, invertL: false, lToR: 0, rToR: 100, invertR: false }),
    preset('Swap Channels', { lToL: 0, rToL: 100, lToR: 100, rToR: 0 }),
    preset('Mono Mix', { lToL: 50, rToL: 50, lToR: 50, rToR: 50 }),
    preset('Left to Both', { lToL: 100, rToL: 0, lToR: 100, rToR: 0 }),
    preset('Right to Both', { lToL: 0, rToL: 100, lToR: 0, rToR: 100 }),
    preset('Mid and Side', { lToL: 50, rToL: 50, lToR: 50, rToR: -50 }),
    preset('Vocal Cancel (Difference)', { lToL: 100, rToL: -100, lToR: -100, rToR: 100 }),
    preset('Fix Right Polarity', { invertR: true }),
  ],
});

// ------------------------------------------------- Loudness Maximizer (Special)

registerEffect({
  id: 'loudnessMaximizer',
  name: 'Loudness Maximizer',
  group: 'Special',
  kind: 38,
  params: [
    db('inputBoost', 'Boost', 0, 24, 6),
    db('ceiling', 'Output Ceiling', -12, 0, -0.3),
    release(100, { min: 10, max: 1000 }),
    ms('lookahead', 'Look-Ahead Time', 0.5, 10, 5),
    pct('lowBoost', 'Lift Quiet Passages', 0),
  ],
  presets: [
    preset('Default', { inputBoost: 6, ceiling: -0.3, release: 100, lookahead: 5, lowBoost: 0 }),
    preset('Subtle Loudness', { inputBoost: 3, ceiling: -1, release: 200, lookahead: 7, lowBoost: 0 }),
    preset('Streaming Master', { inputBoost: 6, ceiling: -1, release: 120, lookahead: 5, lowBoost: 15 }),
    preset('Maximum Impact', { inputBoost: 12, ceiling: -0.1, release: 50, lookahead: 4, lowBoost: 30 }),
    preset('Voice Presence', { inputBoost: 8, ceiling: -1, release: 150, lookahead: 5, lowBoost: 60 }),
  ],
  latency: (v, rate) => limiterLatency(v.lookahead, rate),
});

// ------------------------------------------------ Repair DC Offset (offline)

/**
 * Removes the DC component by subtracting each channel's mean over the
 * processed range. Chosen over a DC-blocking high-pass because it is exact:
 * no phase shift at low frequencies, no settling transient at the start of
 * the range, and the same result however long the file is (the mean is
 * accumulated in double precision). An offset that drifts over time is
 * outside its scope; a high-pass (Filter and EQ) handles that.
 */
export async function runDcOffset({ channels, onProgress, signal }) {
  const out = [];
  for (let c = 0; c < channels.length; c++) {
    checkAbort(signal);
    const src = channels[c];
    // NaN or infinite samples (a damaged float file) are left out of the mean,
    // or one of them would turn the whole channel into NaN.
    let sum = 0;
    let count = 0;
    for (let i = 0; i < src.length; i++) {
      if (Number.isFinite(src[i])) {
        sum += src[i];
        count++;
      }
    }
    const mean = count ? sum / count : 0;
    const dst = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) dst[i] = src[i] - mean;
    out.push(dst);
    onProgress?.((c + 1) / channels.length);
    await pause();
  }
  return out;
}

registerEffect({
  id: 'dcOffset',
  name: 'Repair DC Offset',
  group: AMP,
  // Listed directly in the Effects menu (next to Invert and Reverse), not in its group submenu.
  topLevel: true,
  kind: null,
  params: [],
  run: runDcOffset,
  process: offloaded('dcOffset'),
});

// ------------------------------------------------------- Normalize (offline)

/**
 * Peak normalization. Statistics come from the WASM stats kernel; the gain
 * multiply is a single pass per channel. Equal normalization takes the loudest
 * of the channels being written (`mask`), so their peak reaches the target.
 */
async function runNormalize({ channels, values, dsp, onProgress, signal, mask = null }) {
  const target = values.unit === 0 ? 10 ** (values.targetDb / 20) : values.targetPercent / 100;
  const info = [];
  for (const ch of channels) {
    checkAbort(signal);
    const [min, max, sum] = dsp.stats(ch);
    const mean = values.removeDc && ch.length ? sum / ch.length : 0;
    info.push({ mean, peak: Math.max(Math.abs(max - mean), Math.abs(min - mean)) });
  }
  const loudest = Math.max(0, ...info.filter((_, c) => !mask || mask[c]).map((i) => i.peak));
  // DC Bias Adjust moves each channel's offset to the bias amount (0 % removes it).
  const bias = values.removeDc ? (values.dcAmount || 0) / 100 : 0;
  const out = [];
  for (let c = 0; c < channels.length; c++) {
    const { mean, peak } = info[c];
    const p = values.equal ? loudest : peak;
    const gain = values.normalizeTo === false ? 1 : p > 0 ? target / p : 1;
    const src = channels[c];
    const dst = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) dst[i] = (src[i] - mean) * gain + bias;
    out.push(dst);
    onProgress?.((c + 1) / channels.length);
    await pause();
  }
  return out;
}

registerEffect({
  id: 'normalize',
  name: 'Normalize',
  group: AMP,
  kind: null,
  about: 'Scales the selection so its loudest peak reaches the target. Equal normalization keeps the balance between channels. DC bias adjust measures each channel\'s offset and moves it to the amount you set (0 % centers the waveform), with or without normalizing.',
  params: [
    choice('unit', 'Normalize To', ['dB', '%'], 1, { enabledIf: (v) => v.normalizeTo }),
    num('targetPercent', 'Target (%)', 1, 200, 100, '%', { step: 0.1, enabledIf: (v) => v.normalizeTo && v.unit === 1 }),
    db('targetDb', 'Target (dB)', -60, 6, 0, { enabledIf: (v) => v.normalizeTo && v.unit === 0 }),
    bool('equal', 'Normalize All Channels Equally', true, { enabledIf: (v) => v.normalizeTo }),
    bool('removeDc', 'DC Bias Adjust', false),
    // Off: no level change, so DC Bias Adjust can run on its own.
    bool('normalizeTo', 'Normalize To', true, { order: -1 }),
    num('dcAmount', 'DC Bias', -50, 50, 0, '%', { step: 0.1, enabledIf: (v) => v.removeDc }),
  ],
  presets: [
    preset('Full Scale', { unit: 1, targetPercent: 100, equal: true, removeDc: false }),
    preset('Peak -1 dB', { unit: 0, targetDb: -1, equal: true, removeDc: false }),
    preset('Peak -3 dB with DC Removal', { unit: 0, targetDb: -3, equal: true, removeDc: true }),
    preset('Half Scale', { unit: 1, targetPercent: 50, equal: true }),
    preset('Balance Channels to -0.5 dB', { unit: 0, targetDb: -0.5, equal: false, removeDc: true }),
  ],
  run: runNormalize,
  process: offloaded('normalize'),
});

// ------------------------------------------- Fade and Gain Envelopes (offline)

/**
 * Renders breakpoint points [{ t: 0..1, v }] to n per-sample values, with
 * straight lines or a monotone cubic spline (no overshoot between points).
 * Exported for envelope editors that draw the same curve.
 */
export function renderEnvelope(points, n, spline = false) {
  const out = new Float32Array(n);
  const pts = [...(points?.length ? points : [{ t: 0, v: 1 }])]
    .map((p) => ({ t: Math.min(1, Math.max(0, p.t)), v: p.v }))
    .sort((a, b) => a.t - b.t);
  if (pts[0].t > 0) pts.unshift({ t: 0, v: pts[0].v });
  if (pts[pts.length - 1].t < 1) pts.push({ t: 1, v: pts[pts.length - 1].v });
  const m = pts.length;
  // Fritsch-Carlson tangents.
  const tan = new Float64Array(m);
  if (spline && m > 2) {
    const d = [];
    for (let k = 0; k < m - 1; k++) d.push((pts[k + 1].v - pts[k].v) / (pts[k + 1].t - pts[k].t || 1e-9));
    tan[0] = d[0];
    tan[m - 1] = d[m - 2];
    for (let k = 1; k < m - 1; k++) tan[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
    for (let k = 0; k < m - 1; k++) {
      if (d[k] === 0) {
        tan[k] = 0;
        tan[k + 1] = 0;
        continue;
      }
      const a = tan[k] / d[k];
      const b = tan[k + 1] / d[k];
      const s = a * a + b * b;
      if (s > 9) {
        const f = 3 / Math.sqrt(s);
        tan[k] = f * a * d[k];
        tan[k + 1] = f * b * d[k];
      }
    }
  }
  const scale = n > 1 ? 1 / (n - 1) : 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i * scale;
    while (k < m - 2 && t > pts[k + 1].t) k++;
    const a = pts[k];
    const b = pts[k + 1];
    const h = b.t - a.t;
    if (h <= 0) {
      out[i] = b.v;
      continue;
    }
    const u = Math.min(1, Math.max(0, (t - a.t) / h));
    if (!spline || m <= 2) {
      out[i] = a.v + (b.v - a.v) * u;
    } else {
      const u2 = u * u;
      const u3 = u2 * u;
      out[i] = (2 * u3 - 3 * u2 + 1) * a.v + (u3 - 2 * u2 + u) * h * tan[k] + (-2 * u3 + 3 * u2) * b.v + (u3 - u2) * h * tan[k + 1];
    }
  }
  return out;
}

function envelopeRunner(maxValue) {
  return async ({ channels, values, onProgress, signal }) => {
    const n = channels[0]?.length || 0;
    const env = renderEnvelope(values.envelope, n, values.curve === 1);
    for (let i = 0; i < n; i++) env[i] = Math.min(maxValue, Math.max(0, env[i]));
    const out = [];
    for (let c = 0; c < channels.length; c++) {
      checkAbort(signal);
      const src = channels[c];
      const dst = new Float32Array(n);
      for (let i = 0; i < n; i++) dst[i] = src[i] * env[i];
      out.push(dst);
      onProgress?.((c + 1) / channels.length);
      await pause();
    }
    return out;
  };
}

const curveParam = choice('curve', 'Curve', ['Linear', 'Spline'], 0);
/** The editor draws the curve the process applies (straight or the monotone spline). */
const drawEnvelope = (points, n, v) => renderEnvelope(points, n, v.curve === 1);

registerEffect({
  id: 'fadeEnvelope',
  name: 'Fade Envelope',
  group: AMP,
  kind: null,
  about: 'Fades the selection along a drawn curve from silence to full level. Click to add points, drag them, double-click to remove one; Spline smooths the curve.',
  params: [
    {
      id: 'envelope',
      label: 'Envelope',
      type: 'envelope',
      min: 0,
      max: 1,
      unit: '%',
      default: [{ t: 0, v: 0 }, { t: 1, v: 1 }],
      render: drawEnvelope,
    },
    curveParam,
  ],
  presets: [
    preset('Fade In', { envelope: [{ t: 0, v: 0 }, { t: 1, v: 1 }], curve: 0 }),
    preset('Fade Out', { envelope: [{ t: 0, v: 1 }, { t: 1, v: 0 }], curve: 0 }),
    preset('Smooth Fade In', { envelope: [{ t: 0, v: 0 }, { t: 0.5, v: 0.25 }, { t: 1, v: 1 }], curve: 1 }),
    preset('Smooth Fade Out', { envelope: [{ t: 0, v: 1 }, { t: 0.5, v: 0.25 }, { t: 1, v: 0 }], curve: 1 }),
    preset('Quick Fade In', { envelope: [{ t: 0, v: 0 }, { t: 0.1, v: 1 }, { t: 1, v: 1 }], curve: 0 }),
    preset('Dip and Return', { envelope: [{ t: 0, v: 1 }, { t: 0.5, v: 0 }, { t: 1, v: 1 }], curve: 1 }),
  ],
  run: envelopeRunner(1),
  process: offloaded('fadeEnvelope'),
});

registerEffect({
  id: 'gainEnvelope',
  name: 'Gain Envelope',
  group: AMP,
  kind: null,
  about: 'Raises or lowers the level across the selection along a drawn curve, up to four times louder. Click to add points, drag them, double-click to remove one.',
  params: [
    {
      id: 'envelope',
      label: 'Envelope',
      type: 'envelope',
      min: 0,
      max: 4,
      unit: '%',
      default: [{ t: 0, v: 1 }, { t: 1, v: 1 }],
      render: drawEnvelope,
    },
    curveParam,
  ],
  presets: [
    preset('Unity', { envelope: [{ t: 0, v: 1 }, { t: 1, v: 1 }], curve: 0 }),
    preset('Swell', { envelope: [{ t: 0, v: 0.5 }, { t: 0.7, v: 1.4 }, { t: 1, v: 1 }], curve: 1 }),
    preset('Duck the Middle', { envelope: [{ t: 0, v: 1 }, { t: 0.3, v: 1 }, { t: 0.4, v: 0.35 }, { t: 0.6, v: 0.35 }, { t: 0.7, v: 1 }, { t: 1, v: 1 }], curve: 0 }),
    preset('Build Up', { envelope: [{ t: 0, v: 0.5 }, { t: 1, v: 2 }], curve: 1 }),
    preset('Taper Off', { envelope: [{ t: 0, v: 1 }, { t: 1, v: 0.5 }], curve: 1 }),
  ],
  run: envelopeRunner(4),
  process: offloaded('gainEnvelope'),
});
