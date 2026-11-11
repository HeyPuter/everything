// Effect definitions: Modulation (WASM kinds 70..73, wasm/dsp/src/fx/modulation).

import { registerEffect } from '../registry.js';
import { num, db, ms, pct, bool, choice, preset } from './util.js';
import { feedbackTail } from './delay.js';
import { chorusLoopGain } from '../../engine/fxhost.js';

const GROUP = 'Modulation';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hzRate = (id, label, min, max, def, o = {}) => num(id, label, min, max, def, 'Hz', { step: 0.01, scale: 'log', ...o });
/** Largest interaural delay of the chorus's binaural cues (fx/modulation/chorus.rs ITD_MS). */
const CHORUS_ITD_MS = 0.65;

registerEffect({
  id: 'chorus',
  name: 'Chorus',
  group: GROUP,
  kind: 70,
  params: [
    num('voices', 'Voices', 2, 8, 5, '', { step: 1, control: 'select', section: 'Characteristics' }),
    ms('delay', 'Delay Time', 1, 50, 12, { section: 'Characteristics' }),
    hzRate('delayRate', 'Delay Rate', 0.02, 12, 0.6, { section: 'Characteristics' }),
    pct('feedback', 'Feedback', 0, { max: 90, section: 'Characteristics' }),
    ms('spread', 'Spread', 0, 200, 10, { scale: 'linear', section: 'Characteristics' }),
    db('depth', 'Modulation Depth', 0, 15, 2, { section: 'Characteristics' }),
    hzRate('modRate', 'Modulation Rate', 0.02, 30, 1.2, { section: 'Characteristics' }),
    pct('width', 'Stereo Field', 80, { section: 'Stereo Width', ends: ['Narrow', 'Wide'] }),
    pct('dry', 'Dry', 70, { max: 200, section: 'Output Level' }),
    pct('wet', 'Wet', 50, { max: 200, section: 'Output Level' }),
    bool('quality', 'Highest Quality', true, { section: 'Characteristics' }),
    bool('average', 'Average Left and Right Input', false, { section: 'Stereo Width', order: -1 }),
    bool('binaural', 'Add Binaural Cues', false, { section: 'Stereo Width', order: -1 }),
  ],
  about: 'Thickens a sound into several voices, each a slightly delayed and gently wavering copy spread across the stereo field. Binaural cues make the spread more convincing on headphones.',
  layout: { wide: true, columns: [['Characteristics'], ['Stereo Width', 'Output Level']] },
  presets: [
    preset('Default', { voices: 5, delay: 12, delayRate: 0.6, feedback: 0, spread: 10, depth: 2, modRate: 1.2, width: 80, dry: 70, wet: 50, quality: true }),
    preset('Lush Ensemble', { voices: 8, delay: 18, delayRate: 0.4, feedback: 10, spread: 22, depth: 3, modRate: 0.9, width: 100, dry: 65, wet: 60, quality: true }),
    preset('Subtle Thickener', { voices: 3, delay: 9, delayRate: 0.35, feedback: 0, spread: 6, depth: 1, modRate: 0.5, width: 60, dry: 85, wet: 30, quality: true }),
    preset('Twelve String Shimmer', { voices: 2, delay: 6, delayRate: 1.1, feedback: 0, spread: 3, depth: 0.5, modRate: 2, width: 70, dry: 75, wet: 55, quality: true }),
    preset('Vocal Double', { voices: 2, delay: 24, delayRate: 0.25, feedback: 0, spread: 8, depth: 1.5, modRate: 0.3, width: 90, dry: 80, wet: 45, quality: true }),
    preset('Headphone Ensemble', { voices: 6, delay: 15, delayRate: 0.5, feedback: 5, spread: 18, depth: 2, modRate: 0.8, width: 100, dry: 80, wet: 70, quality: true, binaural: true }),
    preset('Seasick Wobble', { voices: 4, delay: 30, delayRate: 3.5, feedback: 35, spread: 15, depth: 6, modRate: 4, width: 100, dry: 50, wet: 70, quality: true }),
  ],
  tail: (v, rate) => {
    const longest = clamp(v.delay, 1, 50) * 1.3 + clamp(v.spread, 0, 200) + (v.binaural ? CHORUS_ITD_MS : 0);
    // The voices feed back together, so the loop can ring longer than the
    // feedback alone suggests (up to the 0.95 the processor is held to, fxhost.js).
    const fb = clamp(v.feedback / 100, 0, 0.9);
    const loop = Math.min(0.95, fb * chorusLoopGain(v));
    return feedbackTail((longest / 1000) * rate, Math.max(fb, loop), rate);
  },
});

registerEffect({
  id: 'flanger',
  name: 'Flanger',
  group: GROUP,
  kind: 71,
  params: [
    ms('initialDelay', 'Initial Delay Time', 0, 20, 1, { section: 'Characteristics' }),
    ms('finalDelay', 'Final Delay Time', 0, 20, 5, { section: 'Characteristics' }),
    num('phasing', 'Stereo Phasing', 0, 360, 90, '°', { step: 1, section: 'Characteristics' }),
    pct('feedback', 'Feedback', 50, { max: 95, section: 'Characteristics' }),
    hzRate('rate', 'Modulation Rate', 0.01, 60, 0.3, { step: 0.001, section: 'Characteristics' }),
    bool('inverted', 'Inverted', false, { section: 'Mode' }),
    bool('special', 'Special Effects', false, { section: 'Mode' }),
    bool('sinusoidal', 'Sinusoidal', true, { section: 'Mode' }),
    pct('mix', 'Mix', 50, { ends: ['Dry', 'Wet'] }),
    db('gain', 'Output Gain', -20, 12, 0),
  ],
  about: 'Sweeps a very short delay against the original for the classic jet-like whoosh. Inverted flips the delayed copy for a hollower sound; Stereo Phasing offsets the sweep between the channels.',
  presets: [
    preset('Default', { initialDelay: 1, finalDelay: 5, phasing: 90, feedback: 50, rate: 0.3, inverted: false, special: false, sinusoidal: true, mix: 50, gain: 0 }),
    preset('Jet Takeoff', { initialDelay: 0.3, finalDelay: 7, phasing: 0, feedback: 80, rate: 0.12, inverted: false, special: false, sinusoidal: false, mix: 50, gain: -2 }),
    preset('Near Zero Sweep', { initialDelay: 0, finalDelay: 2, phasing: 30, feedback: 40, rate: 0.2, inverted: true, special: false, sinusoidal: true, mix: 50, gain: 0 }),
    preset('Metallic Resonator', { initialDelay: 2, finalDelay: 3, phasing: 90, feedback: 90, rate: 0.08, inverted: false, special: false, sinusoidal: true, mix: 55, gain: -4 }),
    preset('Gentle Swirl', { initialDelay: 1.5, finalDelay: 4, phasing: 120, feedback: 20, rate: 0.5, inverted: false, special: false, sinusoidal: true, mix: 35, gain: 0 }),
    preset('Mirror Warp', { initialDelay: 0.5, finalDelay: 9, phasing: 180, feedback: 60, rate: 0.7, inverted: false, special: true, sinusoidal: true, mix: 60, gain: -2 }),
  ],
  tail: (v, rate) => {
    const longest = Math.max(clamp(v.initialDelay, 0, 20), clamp(v.finalDelay, 0, 20));
    return feedbackTail((longest / 1000) * rate, clamp(v.feedback / 100, 0, 0.95), rate);
  },
});

registerEffect({
  id: 'phaser',
  name: 'Phaser',
  group: GROUP,
  kind: 72,
  params: [
    num('stages', 'Stages', 2, 12, 8, '', { step: 1, control: 'select' }),
    pct('intensity', 'Intensity', 100),
    pct('depth', 'Depth', 70),
    hzRate('rate', 'Modulation Rate', 0.01, 10, 0.4),
    num('phaseDiff', 'Phase Difference', -180, 180, 0, '°', { step: 1 }),
    num('upperFreq', 'Upper Frequency', 20, 20000, 3000, 'Hz', { step: 1, scale: 'log' }),
    pct('feedback', 'Feedback', 30, { min: -90, max: 90 }),
    pct('mix', 'Mix', 50, { ends: ['Dry', 'Wet'] }),
    db('gain', 'Output Gain', -20, 12, 0),
  ],
  about: 'Sweeps a chain of all-pass stages to carve moving notches into the sound. More stages give more notches; negative feedback deepens the notches instead of the peaks.',
  presets: [
    preset('Default', { stages: 8, intensity: 100, depth: 70, rate: 0.4, phaseDiff: 0, upperFreq: 3000, feedback: 30, mix: 50, gain: 0 }),
    preset('Classic Four Stage', { stages: 4, intensity: 100, depth: 80, rate: 0.5, phaseDiff: 0, upperFreq: 2500, feedback: 0, mix: 50, gain: 0 }),
    preset('Deep Twelve Stage', { stages: 12, intensity: 100, depth: 90, rate: 0.15, phaseDiff: 0, upperFreq: 6000, feedback: 50, mix: 50, gain: -2 }),
    preset('Stereo Spin', { stages: 6, intensity: 90, depth: 75, rate: 0.6, phaseDiff: 180, upperFreq: 4000, feedback: 25, mix: 50, gain: 0 }),
    preset('Resonant Squelch', { stages: 8, intensity: 100, depth: 60, rate: 1.8, phaseDiff: 45, upperFreq: 2200, feedback: 85, mix: 55, gain: -4 }),
    preset('Slow Shimmer', { stages: 10, intensity: 60, depth: 50, rate: 0.07, phaseDiff: 90, upperFreq: 9000, feedback: 15, mix: 40, gain: 0 }),
  ],
  tail: (v, rate) => phaserTail(v, rate),
});

/**
 * Frames until the Phaser's feedback loop rings down by 60 dB, at least the
 * 50 ms its stages ring on their own. Each pass round the loop loses the
 * feedback amount and takes the stages' group delay, longest at the lowest
 * break frequency the sweep reaches: 1 / tan(pi f / rate) frames per stage
 * (fx/modulation/phaser.rs: upper frequency, 6 octaves below it at full depth).
 */
export function phaserTail(v, rate) {
  const stages = clamp(Math.round(v.stages), 1, 12);
  const upper = clamp(v.upperFreq, 20, 20000);
  const lower = Math.max(20, upper * 2 ** (-6 * clamp(v.depth / 100, 0, 1)));
  const pass = stages / Math.tan((Math.PI * clamp(lower, 10, rate * 0.45)) / rate);
  const fb = clamp(Math.abs(v.feedback) / 100, 0, 0.95);
  return Math.max(Math.round(rate * 0.05), feedbackTail(pass, fb, rate));
}

const CF = { chorus: { ms: 18 + 8, fbScale: 0.5 }, flanger: { ms: 3 + 2.8, fbScale: 1 } };

registerEffect({
  id: 'chorusFlanger',
  name: 'Chorus/Flanger',
  group: GROUP,
  kind: 73,
  params: [
    choice('mode', 'Mode', ['Chorus', 'Flanger'], 0),
    num('speed', 'Speed', 0.05, 10, 0.8, 'Hz', { step: 0.01, scale: 'log' }),
    pct('width', 'Width', 50),
    pct('intensity', 'Intensity', 30),
    pct('transience', 'Transience', 0),
    pct('mix', 'Mix', 50, { ends: ['Dry', 'Wet'] }),
  ],
  about: 'A simple chorus or flanger with few controls: Speed sets the sweep, Width its depth, Intensity the feedback, and Transience brings out attacks.',
  presets: [
    preset('Default', { mode: 0, speed: 0.8, width: 50, intensity: 30, transience: 0, mix: 50 }),
    preset('Soft Chorus', { mode: 0, speed: 0.5, width: 40, intensity: 10, transience: 0, mix: 40 }),
    preset('Wide Flange', { mode: 1, speed: 0.25, width: 90, intensity: 60, transience: 0, mix: 50 }),
    preset('Quick Vibrato Sheen', { mode: 0, speed: 5, width: 25, intensity: 0, transience: 0, mix: 60 }),
    preset('Punchy Attack Chorus', { mode: 0, speed: 1.2, width: 60, intensity: 20, transience: 80, mix: 50 }),
  ],
  tail: (v, rate) => {
    const m = v.mode === 1 ? CF.flanger : CF.chorus;
    const fb = clamp((v.intensity / 100) * 0.9, 0, 0.9) * m.fbScale;
    return feedbackTail((m.ms / 1000) * rate, fb, rate);
  },
});
