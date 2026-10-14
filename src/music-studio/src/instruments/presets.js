// Built-in instrument presets. Every sound in the app is synthesized from
// these parameter sets at play time: no audio files are bundled.
// Wave indexes: 0 sine, 1 triangle, 2 saw, 3 square, 4 pulse, 5 noise.
// Drum kinds: 0 kick, 1 snare, 2 clap, 3 closed hat, 4 open hat, 5 tom,
// 6 rim, 7 cymbal, 8 cowbell, 9 shaker.

export const SYNTH_PRESETS = [
  { name: 'Init', category: 'Basic', params: {} },
  { name: 'Saw Lead', category: 'Lead', params: { osc1_wave: 2, osc2_wave: 2, osc2_level: 0.6, osc2_fine: 9, cutoff: 5200, reso: 0.25, flt_env: 0.25, a_attack: 4, a_sustain: 0.85, a_release: 180, glide: 40 } },
  { name: 'Square Lead', category: 'Lead', params: { osc1_wave: 3, osc2_wave: 4, osc2_level: 0.4, osc2_oct: 1, cutoff: 3800, reso: 0.2, lfo_pitch: 0.06, lfo_rate: 5.5, a_release: 140 } },
  { name: 'Supersaw', category: 'Lead', params: { osc1_wave: 2, unison: 7, detune: 28, spread: 1, cutoff: 9000, reso: 0.1, a_attack: 8, a_release: 420, gain: 0.55 } },
  { name: 'Pluck', category: 'Pluck', params: { osc1_wave: 2, osc2_wave: 3, osc2_level: 0.35, osc2_oct: 1, cutoff: 900, reso: 0.3, flt_env: 0.7, f_attack: 0, f_decay: 260, f_sustain: 0, f_release: 200, a_attack: 1, a_decay: 420, a_sustain: 0, a_release: 260 } },
  { name: 'Bell', category: 'Pluck', params: { osc1_wave: 0, osc2_wave: 0, osc2_level: 0.5, osc2_oct: 2, osc2_semi: 7, cutoff: 12000, a_attack: 1, a_decay: 1600, a_sustain: 0, a_release: 1400 } },
  { name: 'Soft Keys', category: 'Keys', params: { osc1_wave: 1, osc2_wave: 0, osc2_level: 0.5, osc2_oct: 1, cutoff: 3000, flt_env: 0.3, f_decay: 600, f_sustain: 0.3, a_attack: 3, a_decay: 900, a_sustain: 0.45, a_release: 500 } },
  { name: 'Organ', category: 'Keys', params: { osc1_wave: 0, osc2_wave: 0, osc2_level: 0.6, osc2_oct: 1, sub_level: 0.5, cutoff: 7000, a_attack: 6, a_sustain: 1, a_release: 80, lfo_amp: 0.08, lfo_rate: 6 } },
  { name: 'Warm Pad', category: 'Pad', params: { osc1_wave: 2, osc2_wave: 2, osc2_level: 0.7, osc2_fine: -12, unison: 3, detune: 18, cutoff: 1800, reso: 0.15, flt_env: 0.2, f_attack: 900, f_decay: 1200, a_attack: 700, a_decay: 800, a_sustain: 0.85, a_release: 1800, lfo_cutoff: 0.1, lfo_rate: 0.3, gain: 0.55 } },
  { name: 'Glass Pad', category: 'Pad', params: { osc1_wave: 1, osc2_wave: 4, osc2_level: 0.4, osc2_oct: 1, unison: 4, detune: 10, cutoff: 6000, a_attack: 1200, a_sustain: 0.9, a_release: 2400, lfo_pitch: 0.02, lfo_rate: 0.8, gain: 0.5 } },
  { name: 'Sub Bass', category: 'Bass', params: { osc1_wave: 0, osc1_oct: -1, osc2_level: 0, sub_level: 0.3, cutoff: 1200, a_attack: 2, a_sustain: 1, a_release: 90, mono: 1, glide: 30, gain: 0.85 } },
  { name: 'Acid Bass', category: 'Bass', params: { osc1_wave: 2, osc1_oct: -1, cutoff: 420, reso: 0.75, flt_env: 0.65, f_attack: 0, f_decay: 220, f_sustain: 0.05, a_attack: 1, a_sustain: 0.9, a_release: 60, mono: 1, glide: 60 } },
  { name: 'Reese Bass', category: 'Bass', params: { osc1_wave: 2, osc1_oct: -1, osc2_wave: 2, osc2_oct: -1, osc2_level: 0.8, osc2_fine: 18, unison: 2, detune: 22, cutoff: 900, reso: 0.2, a_sustain: 1, a_release: 120, mono: 1 } },
  { name: 'Brass Stab', category: 'Lead', params: { osc1_wave: 2, osc2_wave: 2, osc2_level: 0.6, osc2_fine: 6, cutoff: 1400, reso: 0.1, flt_env: 0.55, f_attack: 30, f_decay: 300, f_sustain: 0.3, a_attack: 20, a_decay: 300, a_sustain: 0.6, a_release: 160 } },
];

export const DRUM_PRESETS = [
  { name: 'Kick', category: 'Kick', params: { kind: 0, tune: 0, decay: 1, tone: 0.4, punch: 0.6, noise: 0.1, gain: 0.9 } },
  { name: 'Deep Kick', category: 'Kick', params: { kind: 0, tune: -4, decay: 2, tone: 0.2, punch: 0.4, noise: 0, drive: 0.15, gain: 0.95 } },
  { name: 'Punch Kick', category: 'Kick', params: { kind: 0, tune: 3, decay: 0.7, tone: 0.7, punch: 0.9, noise: 0.25, drive: 0.3, gain: 0.85 } },
  { name: 'Snare', category: 'Snare', params: { kind: 1, tune: 0, decay: 1, tone: 0.55, punch: 0.5, noise: 0.6, gain: 0.75 } },
  { name: 'Tight Snare', category: 'Snare', params: { kind: 1, tune: 5, decay: 0.6, tone: 0.8, punch: 0.8, noise: 0.7, gain: 0.7 } },
  { name: 'Clap', category: 'Clap', params: { kind: 2, decay: 1, tone: 0.5, noise: 1, gain: 0.7 } },
  { name: 'Closed Hat', category: 'Hat', params: { kind: 3, decay: 1, tone: 0.7, gain: 0.5 } },
  { name: 'Open Hat', category: 'Hat', params: { kind: 4, decay: 1, tone: 0.65, gain: 0.45 } },
  { name: 'Tom', category: 'Tom', params: { kind: 5, tune: 0, decay: 1, tone: 0.4, punch: 0.5, gain: 0.7, key_track: 1 } },
  { name: 'Rim', category: 'Percussion', params: { kind: 6, decay: 1, tone: 0.6, gain: 0.55 } },
  { name: 'Crash', category: 'Cymbal', params: { kind: 7, decay: 1.5, tone: 0.6, gain: 0.4 } },
  { name: 'Cowbell', category: 'Percussion', params: { kind: 8, decay: 1, tone: 0.5, gain: 0.45 } },
  { name: 'Shaker', category: 'Percussion', params: { kind: 9, decay: 0.8, tone: 0.8, gain: 0.4 } },
];

/** The default kit added to a new project's rack (names and colors). */
export const STARTER_KIT = [
  { preset: 'Kick', color: '#e0675a' },
  { preset: 'Clap', color: '#e8925a' },
  { preset: 'Closed Hat', color: '#e3b84f' },
  { preset: 'Snare', color: '#a7c957' },
];

export function drumPreset(name) {
  return DRUM_PRESETS.find((p) => p.name === name) || DRUM_PRESETS[0];
}

export function synthPreset(name) {
  return SYNTH_PRESETS.find((p) => p.name === name) || SYNTH_PRESETS[0];
}
