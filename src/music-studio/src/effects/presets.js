// Built-in effect presets: partial parameter sets merged over the effect's
// defaults (so an entry only lists what it changes). The first entry of each
// list is "Default" (the catalog defaults), so a fresh slot shows a name
// instead of "Custom". Names are original; values stay inside each
// parameter's range (tests check this).
//
// Option parameters use their index: delay divisions follow DIVISIONS in
// catalog.js (6 = 1/8, 7 = 1/8 dotted, 9 = 1/4, 10 = 1/4 dotted, 3 = 1/16).

import { EFFECTS, defaultEffectParams } from './catalog.js';

const DEFAULT = { name: 'Default', params: {} };

export const EFFECT_PRESETS = {
  eq: [
    DEFAULT,
    { name: 'Low cut 80', params: { hp_freq: 80 } },
    { name: 'Vocal presence', params: { hp_freq: 90, m1_freq: 300, m1_gain: -2.5, m1_q: 1.2, m2_freq: 3200, m2_gain: 3, m2_q: 0.9, high_freq: 10000, high_gain: 2 } },
    { name: 'Kick tighten', params: { hp_freq: 30, low_freq: 60, low_gain: 3, m1_freq: 350, m1_gain: -5, m1_q: 1.6, m2_freq: 4000, m2_gain: 2.5, m2_q: 1.4, lp_freq: 14000 } },
    { name: 'Air lift', params: { m2_freq: 6000, m2_gain: 1, m2_q: 0.7, high_freq: 12000, high_gain: 4 } },
    { name: 'Mud cut', params: { hp_freq: 40, m1_freq: 250, m1_gain: -4, m1_q: 1.4 } },
    { name: 'Bass warmth', params: { low_freq: 100, low_gain: 3, m1_freq: 600, m1_gain: -1.5, lp_freq: 16000 } },
    { name: 'Telephone', params: { hp_freq: 400, m1_freq: 1200, m1_gain: 5, lp_freq: 3500, output: -3 } },
  ],
  compressor: [
    DEFAULT,
    { name: 'Gentle 2:1', params: { threshold: -16, ratio: 2, attack: 20, release: 200, knee: 10, makeup: 2 } },
    { name: 'Vocal leveler', params: { threshold: -22, ratio: 3.5, attack: 6, release: 140, knee: 8, makeup: 5 } },
    { name: 'Drum bus glue', params: { threshold: -14, ratio: 2.5, attack: 30, release: 100, knee: 6, makeup: 2 } },
    { name: 'Punchy kick', params: { threshold: -18, ratio: 5, attack: 25, release: 80, knee: 4, makeup: 3 } },
    { name: 'Bass control', params: { threshold: -20, ratio: 4, attack: 8, release: 180, knee: 6, makeup: 4 } },
    { name: 'Parallel smash', params: { threshold: -40, ratio: 12, attack: 1, release: 60, knee: 2, makeup: 14 } },
  ],
  limiter: [
    DEFAULT,
    { name: 'Safety ceiling', params: { input: 0, ceiling: -1, release: 100 } },
    { name: 'Transparent', params: { input: 2, ceiling: -0.5, release: 200 } },
    { name: 'Loud master', params: { input: 6, ceiling: -0.3, release: 40 } },
    { name: 'Brickwall push', params: { input: 10, ceiling: -0.1, release: 20 } },
  ],
  delay: [
    DEFAULT,
    { name: 'Eighth ping-pong', params: { sync: 1, division: 6, feedback: 0.45, pingpong: 1, tone: 5000, wet: 0.3 } },
    { name: 'Dotted quarter', params: { sync: 1, division: 10, feedback: 0.35, pingpong: 0, tone: 4500, wet: 0.25 } },
    { name: 'Sixteenth trail', params: { sync: 1, division: 3, feedback: 0.3, pingpong: 1, tone: 3500, wet: 0.2 } },
    { name: 'Slapback', params: { sync: 0, time: 110, feedback: 0.1, pingpong: 0, tone: 7000, wet: 0.3 } },
    { name: 'Wide doubler', params: { sync: 0, time: 25, feedback: 0, pingpong: 1, tone: 12000, wet: 0.4 } },
    { name: 'Dub echo', params: { sync: 1, division: 9, feedback: 0.75, pingpong: 0, tone: 1800, wet: 0.35 } },
  ],
  reverb: [
    DEFAULT,
    { name: 'Small room', params: { size: 0.25, decay: 0.7, damping: 0.6, predelay: 5, width: 0.8, lowcut: 150, wet: 0.2 } },
    { name: 'Vocal ambience', params: { size: 0.4, decay: 1.2, damping: 0.55, predelay: 40, width: 0.9, lowcut: 250, wet: 0.18 } },
    { name: 'Plate', params: { size: 0.55, decay: 1.8, damping: 0.3, predelay: 20, width: 1, lowcut: 200, wet: 0.25 } },
    { name: 'Dark chamber', params: { size: 0.5, decay: 2.2, damping: 0.85, predelay: 12, lowcut: 100, wet: 0.25 } },
    { name: 'Hall', params: { size: 0.8, decay: 3.5, damping: 0.45, predelay: 30, width: 1, lowcut: 120, wet: 0.3 } },
    { name: 'Huge space', params: { size: 1, decay: 9, damping: 0.35, predelay: 60, width: 1, lowcut: 180, wet: 0.4 } },
  ],
  chorus: [
    DEFAULT,
    { name: 'Subtle widen', params: { rate: 0.3, depth: 0.25, delay: 12, feedback: 0, spread: 1, wet: 0.35 } },
    { name: 'Classic chorus', params: { rate: 0.8, depth: 0.55, delay: 8, spread: 0.8, wet: 0.5 } },
    { name: 'Jet flanger', params: { rate: 0.15, depth: 0.8, delay: 1.5, feedback: 0.7, spread: 0.6, wet: 0.5 } },
    { name: 'Negative flange', params: { rate: 0.25, depth: 0.7, delay: 2, feedback: -0.6, spread: 0.7, wet: 0.5 } },
    { name: 'Vibrato wobble', params: { rate: 5, depth: 0.4, delay: 4, feedback: 0, spread: 0, wet: 1 } },
  ],
  phaser: [
    DEFAULT,
    { name: 'Gentle shimmer', params: { rate: 0.5, depth: 0.4, stages: 0, feedback: 0.2, center: 2000, wet: 0.35 } },
    { name: 'Slow sweep', params: { rate: 0.1, depth: 0.8, stages: 2, feedback: 0.5, center: 800, wet: 0.5 } },
    { name: 'Fast swirl', params: { rate: 3, depth: 0.6, stages: 1, feedback: 0.3, center: 1200, wet: 0.5 } },
    { name: 'Deep twelve', params: { rate: 0.3, depth: 0.9, stages: 4, feedback: 0.7, center: 600, wet: 0.6 } },
  ],
  distortion: [
    DEFAULT,
    { name: 'Warm tape', params: { type: 0, drive: 6, tone: 9000, output: -3, wet: 1 } },
    { name: 'Tube glow', params: { type: 2, drive: 10, tone: 10000, output: -4, wet: 0.8 } },
    { name: 'Crunch', params: { type: 1, drive: 18, tone: 6000, output: -9, wet: 1 } },
    { name: 'Fuzz', params: { type: 1, drive: 36, tone: 3500, output: -15, wet: 1 } },
    { name: 'Wavefold growl', params: { type: 3, drive: 20, tone: 5000, output: -10, wet: 1 } },
    { name: 'Parallel grit', params: { type: 2, drive: 24, tone: 4000, output: -12, wet: 0.35 } },
  ],
  bitcrusher: [
    DEFAULT,
    { name: 'Lo-fi 12 bit', params: { bits: 12, downsample: 2, wet: 1 } },
    { name: 'Retro console', params: { bits: 6, downsample: 4, wet: 1 } },
    { name: 'Crushed', params: { bits: 4, downsample: 10, wet: 1 } },
    { name: 'Grit blend', params: { bits: 8, downsample: 6, wet: 0.4 } },
  ],
  filter: [
    DEFAULT,
    { name: 'Muffled', params: { type: 0, cutoff: 600, reso: 0.2 } },
    { name: 'Thin out', params: { type: 1, cutoff: 800, reso: 0.15 } },
    { name: 'Telephone band', params: { type: 2, cutoff: 1500, reso: 0.4 } },
    { name: 'Slow sweep', params: { type: 0, cutoff: 1200, reso: 0.55, lfo_rate: 0.125, lfo_depth: 0.7 } },
    { name: 'Wobble', params: { type: 0, cutoff: 700, reso: 0.6, lfo_rate: 4, lfo_depth: 0.8 } },
    { name: 'Notch drift', params: { type: 3, cutoff: 1000, reso: 0.5, lfo_rate: 0.3, lfo_depth: 0.5 } },
  ],
  stereo: [
    DEFAULT,
    { name: 'Mono', params: { width: 0 } },
    { name: 'Mono bass', params: { mono_bass: 120 } },
    { name: 'Tight low end', params: { width: 1.2, mono_bass: 200 } },
    { name: 'Wider', params: { width: 1.5 } },
    { name: 'Extra wide', params: { width: 1.9, mono_bass: 150 } },
  ],
};

/** Built-in presets for an effect type (always at least "Default"). */
export function effectPresetsFor(type) {
  return EFFECT_PRESETS[type] || (EFFECTS[type] ? [DEFAULT] : []);
}

/** The full parameter set a preset applies: the effect defaults with the preset's values on top. */
export function effectPresetParams(type, preset) {
  return { ...defaultEffectParams(type), ...(preset?.params || {}) };
}
