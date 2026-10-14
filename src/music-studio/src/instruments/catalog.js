// Instrument types and their parameters. This is the contract between the UI
// and the audio engine: the engine addresses a parameter by its index in the
// type's `params` list, so new parameters are appended, never inserted.
// Projects store parameters by id, so saved files survive reordering of the
// UI but the engine order must match wasm/engine/src/params.rs.
//
// Param fields: id, label, min, max, def, unit ('Hz', 'ms', 's', 'dB', '%',
// 'st', 'ct', ''), curve ('lin' | 'log' | 'pow2'), step (0 = continuous),
// options (labels for integer choices), group (editor section).

const WAVES = ['Sine', 'Triangle', 'Saw', 'Square', 'Pulse', 'Noise'];
const FILTERS = ['Low pass', 'High pass', 'Band pass', 'Notch'];
const LFO_WAVES = ['Sine', 'Triangle', 'Saw', 'Square', 'Random'];
const OFF_ON = ['Off', 'On'];

const env = (prefix, group, a, d, s, r) => [
  { id: `${prefix}_attack`, label: 'Attack', min: 0, max: 10000, def: a, unit: 'ms', curve: 'pow2', group },
  { id: `${prefix}_decay`, label: 'Decay', min: 1, max: 10000, def: d, unit: 'ms', curve: 'pow2', group },
  { id: `${prefix}_sustain`, label: 'Sustain', min: 0, max: 1, def: s, unit: '%', group },
  { id: `${prefix}_release`, label: 'Release', min: 1, max: 10000, def: r, unit: 'ms', curve: 'pow2', group },
];

const osc = (n, wave, level, oct = 0) => [
  { id: `osc${n}_wave`, label: 'Shape', min: 0, max: WAVES.length - 1, def: wave, step: 1, options: WAVES, group: `Oscillator ${n}` },
  { id: `osc${n}_oct`, label: 'Octave', min: -3, max: 3, def: oct, step: 1, group: `Oscillator ${n}` },
  { id: `osc${n}_semi`, label: 'Semitones', min: -12, max: 12, def: 0, step: 1, unit: 'st', group: `Oscillator ${n}` },
  { id: `osc${n}_fine`, label: 'Fine', min: -100, max: 100, def: 0, step: 1, unit: 'ct', group: `Oscillator ${n}` },
  { id: `osc${n}_level`, label: 'Level', min: 0, max: 1, def: level, unit: '%', group: `Oscillator ${n}` },
];

export const INSTRUMENTS = {
  synth: {
    label: 'Poly Synth',
    description: 'Two oscillators, sub and noise, a resonant filter with its own envelope, an LFO and unison.',
    icon: 'synth',
    params: [
      ...osc(1, 2, 0.8),
      ...osc(2, 3, 0, 0),
      { id: 'sub_level', label: 'Sub', min: 0, max: 1, def: 0, unit: '%', group: 'Mix' },
      { id: 'noise_level', label: 'Noise', min: 0, max: 1, def: 0, unit: '%', group: 'Mix' },
      { id: 'unison', label: 'Voices', min: 1, max: 7, def: 1, step: 1, group: 'Unison' },
      { id: 'detune', label: 'Detune', min: 0, max: 100, def: 12, unit: 'ct', group: 'Unison' },
      { id: 'spread', label: 'Spread', min: 0, max: 1, def: 0.6, unit: '%', group: 'Unison' },
      { id: 'flt_type', label: 'Type', min: 0, max: FILTERS.length - 1, def: 0, step: 1, options: FILTERS, group: 'Filter' },
      { id: 'cutoff', label: 'Cutoff', min: 20, max: 20000, def: 8000, unit: 'Hz', curve: 'log', group: 'Filter' },
      { id: 'reso', label: 'Resonance', min: 0, max: 1, def: 0.15, unit: '%', group: 'Filter' },
      { id: 'flt_env', label: 'Env amount', min: -1, max: 1, def: 0, unit: '%', group: 'Filter' },
      { id: 'flt_key', label: 'Key track', min: 0, max: 1, def: 0.3, unit: '%', group: 'Filter' },
      ...env('f', 'Filter envelope', 5, 300, 0.4, 300),
      ...env('a', 'Amp envelope', 3, 200, 0.8, 250),
      { id: 'lfo_wave', label: 'Shape', min: 0, max: LFO_WAVES.length - 1, def: 0, step: 1, options: LFO_WAVES, group: 'LFO' },
      { id: 'lfo_rate', label: 'Rate', min: 0.05, max: 20, def: 4, unit: 'Hz', curve: 'log', group: 'LFO' },
      { id: 'lfo_pitch', label: 'To pitch', min: 0, max: 1, def: 0, unit: '%', group: 'LFO' },
      { id: 'lfo_cutoff', label: 'To cutoff', min: 0, max: 1, def: 0, unit: '%', group: 'LFO' },
      { id: 'lfo_amp', label: 'To volume', min: 0, max: 1, def: 0, unit: '%', group: 'LFO' },
      { id: 'glide', label: 'Glide', min: 0, max: 2000, def: 0, unit: 'ms', curve: 'pow2', group: 'Voice' },
      { id: 'mono', label: 'Mono', min: 0, max: 1, def: 0, step: 1, options: OFF_ON, group: 'Voice' },
      { id: 'vel_amp', label: 'Velocity', min: 0, max: 1, def: 0.7, unit: '%', group: 'Voice' },
      { id: 'vel_cutoff', label: 'Vel to cutoff', min: 0, max: 1, def: 0.2, unit: '%', group: 'Voice' },
      { id: 'gain', label: 'Level', min: 0, max: 1, def: 0.7, unit: '%', group: 'Voice' },
    ],
  },
  drum: {
    label: 'Drum Synth',
    description: 'One synthesized drum voice: kick, snare, clap, hats, toms and more, shaped from oscillators and noise.',
    icon: 'drum',
    params: [
      { id: 'kind', label: 'Drum', min: 0, max: 9, def: 0, step: 1, options: ['Kick', 'Snare', 'Clap', 'Closed hat', 'Open hat', 'Tom', 'Rim', 'Cymbal', 'Cowbell', 'Shaker'], group: 'Voice' },
      { id: 'tune', label: 'Tune', min: -24, max: 24, def: 0, unit: 'st', group: 'Voice' },
      { id: 'decay', label: 'Decay', min: 0.1, max: 4, def: 1, unit: '', curve: 'log', group: 'Voice' },
      { id: 'tone', label: 'Tone', min: 0, max: 1, def: 0.5, unit: '%', group: 'Voice' },
      { id: 'punch', label: 'Punch', min: 0, max: 1, def: 0.5, unit: '%', group: 'Voice' },
      { id: 'noise', label: 'Noise', min: 0, max: 1, def: 0.5, unit: '%', group: 'Voice' },
      { id: 'drive', label: 'Drive', min: 0, max: 1, def: 0, unit: '%', group: 'Voice' },
      { id: 'gain', label: 'Level', min: 0, max: 1, def: 0.8, unit: '%', group: 'Voice' },
      { id: 'vel_amp', label: 'Velocity', min: 0, max: 1, def: 0.8, unit: '%', group: 'Voice' },
      { id: 'key_track', label: 'Key track', min: 0, max: 1, def: 0, step: 1, options: OFF_ON, group: 'Voice' },
    ],
  },
  sampler: {
    label: 'Sampler',
    description: 'Plays an audio file across the keyboard, with start and end points, looping and an envelope.',
    icon: 'sampler',
    params: [
      { id: 'root', label: 'Root key', min: 0, max: 127, def: 60, step: 1, unit: 'key', group: 'Sample' },
      { id: 'tune', label: 'Tune', min: -24, max: 24, def: 0, step: 1, unit: 'st', group: 'Sample' },
      { id: 'fine', label: 'Fine', min: -100, max: 100, def: 0, step: 1, unit: 'ct', group: 'Sample' },
      { id: 'start', label: 'Start', min: 0, max: 1, def: 0, unit: '%', group: 'Sample' },
      { id: 'end', label: 'End', min: 0, max: 1, def: 1, unit: '%', group: 'Sample' },
      { id: 'loop', label: 'Loop', min: 0, max: 1, def: 0, step: 1, options: OFF_ON, group: 'Sample' },
      { id: 'reverse', label: 'Reverse', min: 0, max: 1, def: 0, step: 1, options: OFF_ON, group: 'Sample' },
      { id: 'track', label: 'Key track', min: 0, max: 1, def: 1, step: 1, options: OFF_ON, group: 'Sample' },
      { id: 'oneshot', label: 'One shot', min: 0, max: 1, def: 1, step: 1, options: OFF_ON, group: 'Sample' },
      ...env('a', 'Envelope', 0, 1000, 1, 60),
      { id: 'cutoff', label: 'Cutoff', min: 20, max: 20000, def: 20000, unit: 'Hz', curve: 'log', group: 'Filter' },
      { id: 'reso', label: 'Resonance', min: 0, max: 1, def: 0, unit: '%', group: 'Filter' },
      { id: 'vel_amp', label: 'Velocity', min: 0, max: 1, def: 0.6, unit: '%', group: 'Voice' },
      { id: 'gain', label: 'Level', min: 0, max: 1, def: 0.8, unit: '%', group: 'Voice' },
    ],
  },
  audio: {
    label: 'Audio clip',
    description: 'Holds an audio file for audio clips in the playlist.',
    icon: 'audio',
    params: [
      { id: 'gain', label: 'Level', min: 0, max: 1, def: 0.8, unit: '%', group: 'Clip' },
      { id: 'tune', label: 'Pitch', min: -24, max: 24, def: 0, step: 1, unit: 'st', group: 'Clip' },
      { id: 'reverse', label: 'Reverse', min: 0, max: 1, def: 0, step: 1, options: OFF_ON, group: 'Clip' },
    ],
  },
};

export const INSTRUMENT_TYPES = Object.keys(INSTRUMENTS);

/** Default parameter values for an instrument type. */
export function defaultParams(type) {
  const out = {};
  for (const p of INSTRUMENTS[type]?.params || []) out[p.id] = p.def;
  return out;
}

export function paramDef(type, id) {
  return INSTRUMENTS[type]?.params.find((p) => p.id === id) || null;
}

/** Index of a parameter in its type's list (the engine's address), or -1. */
export function paramIndex(type, id) {
  return INSTRUMENTS[type]?.params.findIndex((p) => p.id === id) ?? -1;
}

/** Values in engine order, missing ones filled with defaults. */
export function paramVector(type, params = {}) {
  return (INSTRUMENTS[type]?.params || []).map((p) => (Number.isFinite(params[p.id]) ? params[p.id] : p.def));
}
